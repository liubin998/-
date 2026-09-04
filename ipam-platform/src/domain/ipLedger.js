import { db, now } from '../db.js';
import { toBuffer, normalizeIp, isValidIp, incrementIp, ipInRange } from './ip.js';
import { findSubnetsContaining } from './subnet.js';

export const BUSINESS_STATUS = ['free', 'occupied', 'reserved', 'released', 'conflict', 'unavailable', 'pending'];

export class LedgerError extends Error {
  constructor(message, status = 400, code = 'LEDGER_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function resolveSubnet(address) {
  const buf = toBuffer(address);
  const family = buf.length === 4 ? 4 : 6;
  const subs = findSubnetsContaining(buf, family);
  if (!subs.length) return null;
  return subs.reduce((a, b) => (b.prefix > a.prefix ? b : a), subs[0]);
}

export function upsertIp({
  address, business_status = 'pending', mac = null, branch_id = null,
  description = null, source = 'manual', import_batch_id = null, import_row = null,
}) {
  const normalized = normalizeIp(address);
  const buf = toBuffer(normalized);
  const family = buf.length === 4 ? 4 : 6;
  const subnet = resolveSubnet(normalized);
  const t = now();
  const existing = db.prepare('SELECT id FROM ip_ledger WHERE address = ?').get(normalized);
  if (existing) {
    db.prepare(`
      UPDATE ip_ledger SET family = ?, value = ?, subnet_id = ?, business_status = ?, mac = ?,
        branch_id = ?, description = ?, source = ?, import_batch_id = ?, import_row = ?, updated_at = ?
      WHERE id = ?
    `).run(family, buf, subnet?.id ?? null, business_status, mac, branch_id, description, source, import_batch_id, import_row, t, existing.id);
    return { ...getIp(existing.id), existed: true };
  }
  const info = db.prepare(`
    INSERT INTO ip_ledger (address, family, value, subnet_id, business_status, mac, branch_id, description, source, import_batch_id, import_row, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(normalized, family, buf, subnet?.id ?? null, business_status, mac, branch_id, description, source, import_batch_id, import_row, t, t);
  return { ...getIp(info.lastInsertRowid), existed: false };
}

export function getIp(idOrAddress) {
  let row;
  if (typeof idOrAddress === 'number') {
    row = db.prepare(`
      SELECT i.*, s.cidr AS subnet_cidr, b.name AS branch_name
      FROM ip_ledger i
      LEFT JOIN subnets s ON s.id = i.subnet_id
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.id = ?
    `).get(idOrAddress);
  } else if (isValidIp(String(idOrAddress))) {
    const normalized = normalizeIp(String(idOrAddress));
    row = db.prepare(`
      SELECT i.*, s.cidr AS subnet_cidr, b.name AS branch_name
      FROM ip_ledger i
      LEFT JOIN subnets s ON s.id = i.subnet_id
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.address = ?
    `).get(normalized);
  }
  return row || null;
}

export function currentAssignment(ipId) {
  return db.prepare(`
    SELECT a.*, o.name AS object_name, o.id AS object_id_ref, ot.name AS object_type
    FROM ip_assignments a
    JOIN objects o ON o.id = a.object_id
    JOIN object_types ot ON ot.id = o.type_id
    WHERE a.ip_id = ? AND a.released_at IS NULL
    ORDER BY a.assigned_at DESC LIMIT 1
  `).get(ipId);
}

export function assignIp(ipId, objectId, reason = null) {
  const ip = getIp(ipId);
  if (!ip) throw new LedgerError('IP 不存在', 404, 'IP_NOT_FOUND');
  const obj = db.prepare('SELECT id FROM objects WHERE id = ?').get(objectId);
  if (!obj) throw new LedgerError('分配对象不存在', 404, 'OBJECT_NOT_FOUND');
  const active = currentAssignment(ipId);
  if (active) throw new LedgerError('该 IP 已有生效分配，请先释放', 409, 'ALREADY_ASSIGNED');
  const t = now();
  db.prepare('INSERT INTO ip_assignments (ip_id, object_id, assigned_at, reason) VALUES (?, ?, ?, ?)')
    .run(ipId, objectId, t, reason);
  db.prepare(`UPDATE ip_ledger SET business_status = 'occupied', updated_at = ? WHERE id = ?`).run(t, ipId);
  return currentAssignment(ipId);
}

export function releaseIp(ipId, reason = null) {
  const active = currentAssignment(ipId);
  if (!active) throw new LedgerError('该 IP 没有生效分配', 409, 'NOT_ASSIGNED');
  const t = now();
  db.prepare('UPDATE ip_assignments SET released_at = ?, reason = ? WHERE id = ?').run(t, reason, active.id);
  db.prepare(`UPDATE ip_ledger SET business_status = 'released', updated_at = ? WHERE id = ?`).run(t, ipId);
  return { released: active.id };
}

export function updateIpStatus(ipId, business_status, mac = undefined) {
  const ip = getIp(ipId);
  if (!ip) throw new LedgerError('IP 不存在', 404, 'IP_NOT_FOUND');
  if (!BUSINESS_STATUS.includes(business_status)) throw new LedgerError(`状态非法: ${business_status}`);
  const t = now();
  if (mac !== undefined) {
    db.prepare('UPDATE ip_ledger SET business_status = ?, mac = ?, updated_at = ? WHERE id = ?')
      .run(business_status, mac, t, ipId);
  } else {
    db.prepare('UPDATE ip_ledger SET business_status = ?, updated_at = ? WHERE id = ?')
      .run(business_status, t, ipId);
  }
  return getIp(ipId);
}

export function findFreeInSubnet(subnet, { count = 10 } = {}) {
  const occupied = new Set(
    db.prepare('SELECT address FROM ip_ledger WHERE subnet_id = ?').all(subnet.id).map((r) => r.address),
  );
  const results = [];
  let cursor = subnet.first_usable ?? null;
  if (!cursor) return results;
  const range = subnet.cidr;
  let guard = 0;
  while (results.length < count && guard < 200000) {
    guard++;
    if (!cursor || !ipInRange(cursor, range)) break;
    if (!occupied.has(cursor)) results.push(cursor);
    cursor = incrementIp(cursor, 1n);
  }
  return results;
}

export function detectDuplicates() {
  return db.prepare(`
    SELECT address, COUNT(*) AS c FROM ip_ledger GROUP BY address HAVING c > 1
  `).all();
}

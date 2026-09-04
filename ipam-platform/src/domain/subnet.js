import { db, now } from '../db.js';
import {
  cidrRange, toBuffer, relation, capacity, ipv4ReservedCount, IpError,
} from './ip.js';

export const SUBNET_STATUS = ['active', 'planned', 'retired'];
export const SUBNET_KINDS = ['lan', 'wan', 'mgmt', 'wifi', 'cloud', 'p2p', 'reserved', 'other'];

export class SubnetError extends Error {
  constructor(message, status = 400, code = 'SUBNET_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createSubnet({ cidr, branch_id = null, purpose = null, kind = null, vlan = null, gateway = null, description = null, status = 'active' }) {
  const r = cidrRange(cidr);
  const canonical = r.cidr;
  const existing = db.prepare('SELECT id FROM subnets WHERE cidr = ?').get(canonical);
  if (existing) throw new SubnetError(`网段已存在: ${canonical}`, 409, 'SUBNET_EXISTS');
  const t = now();
  const info = db.prepare(`
    INSERT INTO subnets (cidr, family, prefix, network_start, network_end, purpose, kind, branch_id, vlan, gateway, description, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(canonical, r.family, r.prefix, r.startBuf, r.endBuf, purpose, kind, branch_id, vlan, gateway, description, status, t, t);
  refreshLedgerSubnetBinding(canonical);
  return getSubnet(info.lastInsertRowid);
}

export function getSubnet(id) {
  const row = db.prepare(`
    SELECT s.*, b.name AS branch_name
    FROM subnets s LEFT JOIN branches b ON b.id = s.branch_id
    WHERE s.id = ?
  `).get(id);
  if (!row) return null;
  return row;
}

export function findSubnetsContaining(ipBuf, family) {
  return db.prepare(`
    SELECT s.* FROM subnets s
    WHERE s.family = ? AND s.network_start <= ? AND s.network_end >= ?
    ORDER BY s.prefix DESC
  `).all(family, ipBuf, ipBuf);
}

export function longestPrefixMatch(ipText) {
  const buf = toBuffer(ipText);
  const family = buf.length === 4 ? 4 : 6;
  const matches = findSubnetsContaining(buf, family);
  if (!matches.length) return { best: null, all: [] };
  const best = matches.reduce((a, b) => (b.prefix > a.prefix ? b : a), matches[0]);
  return { best, all: matches };
}

export function updateSubnet(id, patch) {
  const cur = getSubnet(id);
  if (!cur) throw new SubnetError('网段不存在', 404, 'SUBNET_NOT_FOUND');
  const fields = ['purpose', 'kind', 'branch_id', 'vlan', 'gateway', 'description', 'status'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (f in patch) {
      sets.push(`${f} = ?`);
      vals.push(patch[f]);
    }
  }
  if (!sets.length) return cur;
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE subnets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getSubnet(id);
}

export function deleteSubnet(id) {
  const cur = getSubnet(id);
  if (!cur) throw new SubnetError('网段不存在', 404, 'SUBNET_NOT_FOUND');
  const ipCount = db.prepare('SELECT COUNT(*) AS c FROM ip_ledger WHERE subnet_id = ?').get(id).c;
  db.prepare('UPDATE ip_ledger SET subnet_id = NULL WHERE subnet_id = ?').run(id);
  db.prepare('UPDATE tickets SET subnet_id = NULL WHERE subnet_id = ?').run(id);
  db.prepare('DELETE FROM subnets WHERE id = ?').run(id);
  return { ...cur, released_ip_count: ipCount };
}

export function overlapReport(cidrText) {
  const rows = db.prepare('SELECT cidr, id, prefix, family FROM subnets').all();
  const report = [];
  if (cidrText !== undefined) {
    for (const row of rows) {
      if (row.cidr === cidrRange(cidrText).cidr) continue;
      try {
        const rel = relation(cidrText, row.cidr);
        if (rel !== 'none') report.push({ subnet_id: row.id, cidr: row.cidr, relation: rel });
      } catch {
        // skip
      }
    }
    return report;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].family !== rows[j].family) continue;
      try {
        const rel = relation(rows[i].cidr, rows[j].cidr);
        if (rel !== 'none') {
          report.push({
            a_id: rows[i].id, a_cidr: rows[i].cidr,
            b_id: rows[j].id, b_cidr: rows[j].cidr,
            relation: rel,
          });
        }
      } catch {
        // skip
      }
    }
  }
  return report;
}

export function subnetStats(subnet) {
  const r = cidrRange(subnet.cidr);
  const total = capacity(subnet.prefix, subnet.family);
  const reserved = subnet.family === 4 ? ipv4ReservedCount(subnet.prefix, {}) : 0n;
  const counts = db.prepare(`
    SELECT business_status, COUNT(*) AS c FROM ip_ledger WHERE subnet_id = ? GROUP BY business_status
  `).all(subnet.id);
  const byStatus = {};
  let occupied = 0;
  for (const c of counts) {
    byStatus[c.business_status] = c.c;
    if (c.business_status === 'occupied' || c.business_status === 'conflict') occupied += c.c;
  }
  const recorded = counts.reduce((s, c) => s + c.c, 0);
  const availableTheoretical = total > reserved ? total - reserved : 0n;
  const freeApprox = availableTheoretical - BigInt(recorded) > 0n ? availableTheoretical - BigInt(recorded) : 0n;
  const usagePct = total > 0n ? Number((BigInt(occupied) * 10000n) / total) / 100 : 0;
  return {
    cidr: subnet.cidr,
    family: subnet.family,
    prefix: subnet.prefix,
    network: r.network,
    broadcast: r.broadcast,
    first_usable: r.firstUsable,
    last_usable: r.lastUsable,
    total: total.toString(),
    reserved: reserved.toString(),
    recorded,
    occupied,
    free_approx: freeApprox.toString(),
    usage_pct: usagePct,
    by_status: byStatus,
  };
}

export function refreshLedgerSubnetBinding(cidrText) {
  const sub = db.prepare('SELECT * FROM subnets WHERE cidr = ?').get(cidrText);
  if (!sub) return 0;
  const res = db.prepare(`
    UPDATE ip_ledger SET subnet_id = ?
    WHERE family = ? AND value >= ? AND value <= ? AND (subnet_id IS NULL OR subnet_id = ?)
  `).run(sub.id, sub.family, sub.network_start, sub.network_end, sub.id);
  return res.changes;
}

export function rebindAllLedger() {
  db.prepare('UPDATE ip_ledger SET subnet_id = NULL').run();
  const subs = db.prepare('SELECT cidr FROM subnets ORDER BY prefix DESC').all();
  let n = 0;
  for (const s of subs) n += refreshLedgerSubnetBinding(s.cidr);
  return n;
}

export { IpError };

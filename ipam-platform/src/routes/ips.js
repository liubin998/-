import { Router } from 'express';
import { db, now } from '../db.js';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap, assertBranch } from '../domain/authHelpers.js';
import {
  upsertIp, getIp, assignIp, releaseIp, updateIpStatus, BUSINESS_STATUS, currentAssignment,
} from '../domain/ipLedger.js';
import { diagnoseIp } from '../domain/diagnosis.js';
import { isValidIp } from '../domain/ip.js';
import { parsePagination, paged } from '../domain/util.js';
import { recordAudit } from '../domain/audit.js';
import { manualProbe } from '../collector/runner.js';
import { config } from '../config.js';
import { longestPrefixMatch } from '../domain/subnet.js';

export const ipRouter = Router();
ipRouter.use(authMiddleware);

const probeCounter = { minute: 0, count: 0 };

ipRouter.get('/', requireCap('view'), wrap(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { subnet_id, branch_id, status, q } = req.query;
  const where = [];
  const vals = [];
  if (!req.userCtx.is_hq_admin && req.userCtx.branch_ids.length) {
    where.push(`(i.branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR i.branch_id IS NULL)`);
    vals.push(...req.userCtx.branch_ids);
  } else if (!req.userCtx.is_hq_admin) {
    return res.json(paged([], 0, { page, limit }));
  }
  if (subnet_id) { where.push('i.subnet_id = ?'); vals.push(Number(subnet_id)); }
  if (branch_id) { where.push('i.branch_id = ?'); vals.push(Number(branch_id)); }
  if (status) { where.push('i.business_status = ?'); vals.push(status); }
  if (q) {
    where.push('(i.address LIKE ? OR i.mac LIKE ? OR i.description LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ip_ledger i ${whereSql}`).get(...vals).c;
  const rows = db.prepare(`
    SELECT i.*, s.cidr AS subnet_cidr, b.name AS branch_name
    FROM ip_ledger i
    LEFT JOIN subnets s ON s.id = i.subnet_id
    LEFT JOIN branches b ON b.id = i.branch_id
    ${whereSql} ORDER BY i.family, i.value LIMIT ? OFFSET ?
  `).all(...vals, limit, (page - 1) * limit);
  res.json(paged(rows, total, { page, limit }));
}));

ipRouter.post('/', requireCap('create'), wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.address || !isValidIp(body.address)) throw httpError(400, 'IP 地址非法');
  if (body.branch_id) assertBranch(req.userCtx, body.branch_id, 'create');
  if (body.business_status && !BUSINESS_STATUS.includes(body.business_status)) throw httpError(400, '状态非法');
  const before = getIp(body.address);
  const ip = upsertIp({ ...body, source: body.source || 'manual' });
  recordAudit({
    userId: req.user.id, username: req.user.username, action: before ? 'ip.update' : 'ip.create',
    entityType: 'ip', entityId: ip.address, branchId: ip.branch_id, before, after: ip, source: 'web',
  });
  res.status(before ? 200 : 201).json({ ip });
}));

ipRouter.post('/probe', requireCap('probe'), wrap(async (req, res) => {
  const { ip, probe_type = 'icmp' } = req.body || {};
  if (!ip || !isValidIp(ip)) throw httpError(400, 'IP 地址非法');
  const minute = Math.floor(Date.now() / 60000);
  if (probeCounter.minute !== minute) { probeCounter.minute = minute; probeCounter.count = 0; }
  if (probeCounter.count >= config.probeRateLimitPerMin) throw httpError(429, '探测频率超限，请稍后再试', 'RATE_LIMIT');
  probeCounter.count++;
  const subnet = longestPrefixMatch(ip).best;
  if (subnet?.branch_id) assertBranch(req.userCtx, subnet.branch_id, 'probe');
  const result = manualProbe({ userId: req.user.id, username: req.user.username, ip, probeType: probe_type, subnet });
  res.json(result);
}));

ipRouter.get('/statuses', requireCap('view'), wrap(async (req, res) => {
  res.json({ statuses: BUSINESS_STATUS });
}));

ipRouter.get('/:address', requireCap('view'), wrap(async (req, res) => {
  const ip = getIp(String(req.params.address));
  if (!ip) throw httpError(404, 'IP 不存在');
  if (ip.branch_id) assertBranch(req.userCtx, ip.branch_id, 'view');
  res.json({ ip, assignment: currentAssignment(ip.id) || null });
}));

ipRouter.patch('/:address', requireCap('edit'), wrap(async (req, res) => {
  const ip = getIp(String(req.params.address));
  if (!ip) throw httpError(404, 'IP 不存在');
  if (ip.branch_id) assertBranch(req.userCtx, ip.branch_id, 'edit');
  const { business_status, mac, description, branch_id } = req.body || {};
  const sets = [];
  const vals = [];
  if (business_status !== undefined) {
    if (!BUSINESS_STATUS.includes(business_status)) throw httpError(400, '状态非法');
    sets.push('business_status = ?'); vals.push(business_status);
  }
  if (mac !== undefined) { sets.push('mac = ?'); vals.push(mac); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (branch_id !== undefined) { sets.push('branch_id = ?'); vals.push(branch_id); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(now()); vals.push(ip.id);
    db.prepare(`UPDATE ip_ledger SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const after = getIp(ip.id);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ip.update',
    entityType: 'ip', entityId: ip.address, branchId: ip.branch_id, before: ip, after, source: 'web',
  });
  res.json({ ip: after });
}));

ipRouter.post('/:address/assign', requireCap('allocate'), wrap(async (req, res) => {
  const ip = getIp(String(req.params.address));
  if (!ip) throw httpError(404, 'IP 不存在');
  if (ip.branch_id) assertBranch(req.userCtx, ip.branch_id, 'allocate');
  const { object_type = '主机', object_name, reason = null } = req.body || {};
  if (!object_name) throw httpError(400, '分配对象名称不能为空');
  const objectId = ensureObject(object_type, object_name, ip.branch_id);
  const assignment = assignIp(ip.id, objectId, reason);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ip.assign',
    entityType: 'ip', entityId: ip.address, branchId: ip.branch_id,
    after: { object_type, object_name, reason }, source: 'web',
  });
  res.json({ assignment });
}));

ipRouter.post('/:address/release', requireCap('allocate'), wrap(async (req, res) => {
  const ip = getIp(String(req.params.address));
  if (!ip) throw httpError(404, 'IP 不存在');
  if (ip.branch_id) assertBranch(req.userCtx, ip.branch_id, 'allocate');
  const { reason = null } = req.body || {};
  const result = releaseIp(ip.id, reason);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ip.release',
    entityType: 'ip', entityId: ip.address, branchId: ip.branch_id, after: { reason }, source: 'web',
  });
  res.json(result);
}));

ipRouter.get('/:address/diagnosis', requireCap('view'), wrap(async (req, res) => {
  const addr = String(req.params.address);
  if (!isValidIp(addr)) throw httpError(400, 'IP 地址非法');
  const ledger = getIp(addr);
  if (ledger?.branch_id) assertBranch(req.userCtx, ledger.branch_id, 'view');
  res.json(diagnoseIp(addr, { includeEvidence: true }));
}));

function ensureObject(typeName, name, branchId) {
  let type = db.prepare('SELECT id FROM object_types WHERE name = ?').get(typeName);
  if (!type) {
    const ti = db.prepare(`
      INSERT INTO object_types (name, version, enabled, fields_json, created_at, updated_at)
      VALUES (?, 1, 1, '[]', ?, ?)
    `).run(typeName, now(), now());
    type = { id: ti.lastInsertRowid };
  }
  const obj = db.prepare('SELECT id FROM objects WHERE type_id = ? AND name = ?').get(type.id, name);
  if (obj) return obj.id;
  const oi = db.prepare(`
    INSERT INTO objects (type_id, name, branch_id, fields_json, schema_version, created_at, updated_at)
    VALUES (?, ?, ?, '{}', 1, ?, ?)
  `).run(type.id, name, branchId, now(), now());
  return oi.lastInsertRowid;
}

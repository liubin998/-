import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap, assertBranch } from '../domain/authHelpers.js';
import {
  createSubnet, getSubnet, updateSubnet, deleteSubnet, overlapReport, subnetStats,
} from '../domain/subnet.js';
import { diagnoseSubnet } from '../domain/diagnosis.js';
import { findFreeInSubnet } from '../domain/ipLedger.js';
import { parsePagination, paged } from '../domain/util.js';
import { recordAudit } from '../domain/audit.js';
import { cidrRange } from '../domain/ip.js';

export const subnetRouter = Router();
subnetRouter.use(authMiddleware);

subnetRouter.get('/', requireCap('view'), wrap(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { branch_id, status, kind, q } = req.query;
  const where = [];
  const vals = [];
  if (!req.userCtx.is_hq_admin && req.userCtx.branch_ids.length) {
    where.push(`(s.branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR s.branch_id IS NULL)`);
    vals.push(...req.userCtx.branch_ids);
  } else if (!req.userCtx.is_hq_admin) {
    return res.json(paged([], 0, { page, limit }));
  }
  if (branch_id) { where.push('s.branch_id = ?'); vals.push(Number(branch_id)); }
  if (status) { where.push('s.status = ?'); vals.push(status); }
  if (kind) { where.push('s.kind = ?'); vals.push(kind); }
  if (q) { where.push('(s.cidr LIKE ? OR s.purpose LIKE ? OR s.description LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM subnets s ${whereSql}`).get(...vals).c;
  const rows = db.prepare(`
    SELECT s.*, b.name AS branch_name FROM subnets s LEFT JOIN branches b ON b.id = s.branch_id
    ${whereSql} ORDER BY s.family, s.network_start LIMIT ? OFFSET ?
  `).all(...vals, limit, (page - 1) * limit);
  res.json(paged(rows, total, { page, limit }));
}));

subnetRouter.post('/', requireCap('create'), wrap(async (req, res) => {
  const body = req.body || {};
  if (body.branch_id) assertBranch(req.userCtx, body.branch_id, 'create');
  let subnet;
  try {
    subnet = createSubnet(body);
  } catch (e) {
    if (e.code === 'SUBNET_EXISTS') throw httpError(409, e.message, 'SUBNET_EXISTS');
    throw e;
  }
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'subnet.create',
    entityType: 'subnet', entityId: subnet.cidr, branchId: subnet.branch_id, after: subnet, source: 'web',
  });
  res.status(201).json({ subnet });
}));

subnetRouter.get('/overlaps', requireCap('view'), wrap(async (req, res) => {
  res.json({ overlaps: overlapReport() });
}));

subnetRouter.get('/:id', requireCap('view'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  if (subnet.branch_id) assertBranch(req.userCtx, subnet.branch_id, 'view');
  res.json({ subnet, stats: subnetStats(subnet) });
}));

subnetRouter.get('/:id/stats', requireCap('view'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  res.json({ stats: subnetStats(subnet) });
}));

subnetRouter.get('/:id/free', requireCap('view'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  const count = Math.min(Number(req.query.count || 10), 100);
  const range = cidrRange(subnet.cidr);
  res.json({ free: findFreeInSubnet({ ...subnet, first_usable: range.firstUsable }, { count }) });
}));

subnetRouter.patch('/:id', requireCap('edit'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  if (subnet.branch_id) assertBranch(req.userCtx, subnet.branch_id, 'edit');
  const updated = updateSubnet(subnet.id, req.body || {});
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'subnet.update',
    entityType: 'subnet', entityId: subnet.cidr, branchId: subnet.branch_id,
    before: subnet, after: updated, source: 'web',
  });
  res.json({ subnet: updated });
}));

subnetRouter.delete('/:id', requireCap('edit'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  if (!req.userCtx.is_hq_admin) throw httpError(403, '删除网段为高危操作，仅总部管理员可执行', 'HIGH_RISK');
  const ipCount = db.prepare('SELECT COUNT(*) AS c FROM ip_ledger WHERE subnet_id = ?').get(subnet.id).c;
  deleteSubnet(subnet.id);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'subnet.delete',
    entityType: 'subnet', entityId: subnet.cidr, branchId: subnet.branch_id,
    before: subnet, after: { affected_ips: ipCount }, source: 'web',
  });
  res.json({ ok: true, affected_ips: ipCount });
}));

subnetRouter.get('/:id/ips', requireCap('view'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  const { page, limit } = parsePagination(req.query);
  const total = db.prepare('SELECT COUNT(*) AS c FROM ip_ledger WHERE subnet_id = ?').get(subnet.id).c;
  const rows = db.prepare(`
    SELECT i.*, b.name AS branch_name FROM ip_ledger i LEFT JOIN branches b ON b.id = i.branch_id
    WHERE i.subnet_id = ? ORDER BY i.family, i.value LIMIT ? OFFSET ?
  `).all(subnet.id, limit, (page - 1) * limit);
  res.json(paged(rows, total, { page, limit }));
}));

subnetRouter.get('/:id/diagnosis', requireCap('view'), wrap(async (req, res) => {
  const subnet = getSubnet(Number(req.params.id));
  if (!subnet) throw httpError(404, '网段不存在');
  const limit = Math.min(Number(req.query.limit || 200), 500);
  res.json({ items: diagnoseSubnet(subnet, { limit }) });
}));

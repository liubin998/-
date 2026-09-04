import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';
import { parsePagination, paged } from '../domain/util.js';
import { schedulerStatus } from '../scheduler.js';

export const auditRouter = Router();
auditRouter.use(authMiddleware);

auditRouter.get('/logs', requireCap('audit_view'), wrap(async (req, res) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
  const { action, entity_type, username } = req.query;
  const where = [];
  const vals = [];
  if (!req.userCtx.is_hq_admin && req.userCtx.branch_ids.length) {
    where.push(`(branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR branch_id IS NULL)`);
    vals.push(...req.userCtx.branch_ids);
  }
  if (action) { where.push('action LIKE ?'); vals.push(`%${action}%`); }
  if (entity_type) { where.push('entity_type = ?'); vals.push(entity_type); }
  if (username) { where.push('username LIKE ?'); vals.push(`%${username}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...vals).c;
  const rows = db.prepare(`
    SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...vals, limit, (page - 1) * limit);
  res.json(paged(rows, total, { page, limit }));
}));

export const dashboardRouter = Router();
dashboardRouter.use(authMiddleware);

dashboardRouter.get('/summary', requireCap('view'), wrap(async (req, res) => {
  const branchFilter = req.userCtx.is_hq_admin ? '' : `AND (branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR branch_id IS NULL)`;
  const bv = req.userCtx.is_hq_admin ? [] : req.userCtx.branch_ids;

  const subnetCount = db.prepare(`SELECT COUNT(*) AS c FROM subnets WHERE 1=1 ${branchFilter}`).get(...bv).c;
  const ledgerTotal = db.prepare(`SELECT COUNT(*) AS c FROM ip_ledger WHERE 1=1 ${branchFilter}`).get(...bv).c;
  const byStatus = db.prepare(`
    SELECT business_status, COUNT(*) AS c FROM ip_ledger WHERE 1=1 ${branchFilter} GROUP BY business_status
  `).all(...bv);
  const ticketByStatus = db.prepare(`
    SELECT status, COUNT(*) AS c FROM tickets WHERE 1=1 ${branchFilter} GROUP BY status
  `).all(...bv);
  const devices = db.prepare(`SELECT status, COUNT(*) AS c FROM devices GROUP BY status`).all();
  const recentRuns = db.prepare(`
    SELECT r.*, d.name AS device_name FROM collect_runs r JOIN devices d ON d.id = r.device_id
    ORDER BY r.started_at DESC LIMIT 10
  `).all();
  const openTickets = db.prepare(`
    SELECT COUNT(*) AS c FROM tickets WHERE status IN ('open','in_progress') ${branchFilter}
  `).get(...bv).c;
  res.json({
    subnets: subnetCount,
    ledger_total: ledgerTotal,
    ledger_by_status: byStatus,
    tickets_by_status: ticketByStatus,
    devices,
    open_tickets: openTickets,
    recent_runs: recentRuns,
    scheduler: schedulerStatus(),
  });
}));

export const searchRouter = Router();
searchRouter.use(authMiddleware);

searchRouter.get('/', requireCap('view'), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ips: [], subnets: [], devices: [], tickets: [] });
  const like = `%${q}%`;
  const branchClause = req.userCtx.is_hq_admin
    ? ''
    : `AND (branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR branch_id IS NULL)`;
  const bv = req.userCtx.is_hq_admin ? [] : req.userCtx.branch_ids;
  const ips = db.prepare(`
    SELECT id, address, business_status, mac, description FROM ip_ledger
    WHERE (address LIKE ? OR mac LIKE ? OR description LIKE ?) ${branchClause} LIMIT 20
  `).all(like, like, like, ...bv);
  const subnets = db.prepare(`
    SELECT id, cidr, purpose, description FROM subnets
    WHERE (cidr LIKE ? OR purpose LIKE ? OR description LIKE ?) ${branchClause} LIMIT 20
  `).all(like, like, like, ...bv);
  const devices = db.prepare(`SELECT id, name, vendor, status FROM devices WHERE name LIKE ? LIMIT 20`).all(like);
  const tickets = db.prepare(`
    SELECT id, title, type, status FROM tickets
    WHERE (title LIKE ? OR ip LIKE ?) ${branchClause.replace(/branch_id/g, 'branch_id')} LIMIT 20
  `).all(like, like, ...bv);
  res.json({ ips, subnets, devices, tickets });
}));

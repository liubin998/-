import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';
import { schedulerStatus } from '../scheduler.js';

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

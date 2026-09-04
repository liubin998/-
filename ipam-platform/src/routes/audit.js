import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';
import { parsePagination, paged } from '../domain/util.js';

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

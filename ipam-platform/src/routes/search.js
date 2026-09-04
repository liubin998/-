import { Router } from 'express';
import { db } from '../db.js';
import { wrap } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';

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
    WHERE (title LIKE ? OR ip LIKE ?) ${branchClause} LIMIT 20
  `).all(like, like, ...bv);
  res.json({ ips, subnets, devices, tickets });
}));

import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import { requireCap, authMiddleware } from '../domain/authHelpers.js';
import {
  listBranches, getBranch, createBranch, updateBranch, grantBranch, clearGrants,
} from '../domain/authHelpers.js';
import { hashPassword, ROLES } from '../domain/auth.js';
import { recordAudit } from '../domain/audit.js';
import { EVIDENCE_TYPES } from '../domain/observations.js';

export const adminRouter = Router();
adminRouter.use(authMiddleware);

adminRouter.get('/branches', requireCap('view'), wrap(async (req, res) => {
  res.json({ branches: listBranches() });
}));

adminRouter.post('/branches', requireCap('user'), wrap(async (req, res) => {
  const { name, code, parent_id = null, owner = null } = req.body || {};
  if (!name || !code) throw httpError(400, '分支名称与编码不能为空');
  const branch = createBranch({ name, code, parent_id, owner });
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'branch.create',
    entityType: 'branch', entityId: branch.id, after: branch, source: 'web',
  });
  res.status(201).json({ branch });
}));

adminRouter.patch('/branches/:id', requireCap('user'), wrap(async (req, res) => {
  const branch = getBranch(Number(req.params.id));
  if (!branch) throw httpError(404, '分支不存在');
  const updated = updateBranch(branch.id, req.body || {});
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'branch.update',
    entityType: 'branch', entityId: branch.id, before: branch, after: updated, source: 'web',
  });
  res.json({ branch: updated });
}));

adminRouter.get('/users', requireCap('user'), wrap(async (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, email, department, status, created_at FROM users ORDER BY id
  `).all();
  for (const u of users) {
    u.grants = db.prepare(`
      SELECT g.role, g.branch_id, g.valid_until, b.name AS branch_name
      FROM user_grants g JOIN branches b ON b.id = g.branch_id WHERE g.user_id = ?
    `).all(u.id);
  }
  res.json({ users });
}));

adminRouter.post('/users', requireCap('user'), wrap(async (req, res) => {
  const { username, password, display_name, email = null, department = null, grants = [] } = req.body || {};
  if (!username || !password || !display_name) throw httpError(400, '用户名、密码、显示名不能为空');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw httpError(409, '用户名已存在');
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, department, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(username, hashPassword(password), display_name, email, department, Date.now(), Date.now());
  for (const g of grants) grantBranch(info.lastInsertRowid, g.branch_id, g.role, g.valid_until || null);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'user.create',
    entityType: 'user', entityId: username, after: { username, display_name, grants }, source: 'web',
  });
  res.status(201).json({ id: info.lastInsertRowid });
}));

adminRouter.patch('/users/:id', requireCap('user'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw httpError(404, '用户不存在');
  const { status, display_name, email, department, password, grants } = req.body || {};
  const sets = [];
  const vals = [];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (display_name !== undefined) { sets.push('display_name = ?'); vals.push(display_name); }
  if (email !== undefined) { sets.push('email = ?'); vals.push(email); }
  if (department !== undefined) { sets.push('department = ?'); vals.push(department); }
  if (password !== undefined) { sets.push('password_hash = ?'); vals.push(hashPassword(password)); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (Array.isArray(grants)) {
    clearGrants(id);
    for (const g of grants) {
      if (!ROLES.includes(g.role)) throw httpError(400, `角色非法: ${g.role}`);
      grantBranch(id, g.branch_id, g.role, g.valid_until || null);
    }
  }
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'user.update',
    entityType: 'user', entityId: target.username,
    after: { status, display_name, grants_reset: Array.isArray(grants), password_reset: password !== undefined }, source: 'web',
  });
  res.json({ ok: true });
}));

adminRouter.get('/windows', requireCap('view'), wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM window_settings ORDER BY scope, evidence_type').all();
  res.json({ windows: rows, evidence_types: EVIDENCE_TYPES });
}));

adminRouter.put('/windows', requireCap('config'), wrap(async (req, res) => {
  const { scope = 'global', scope_id = null, evidence_type, window_min } = req.body || {};
  if (!EVIDENCE_TYPES.includes(evidence_type)) throw httpError(400, `证据类型非法: ${evidence_type}`);
  if (!Number.isFinite(window_min) || window_min < 1) throw httpError(400, '时间窗口必须为大于 0 的分钟数');
  db.prepare(`
    INSERT INTO window_settings (scope, scope_id, evidence_type, window_min) VALUES (?, ?, ?, ?)
    ON CONFLICT (scope, scope_id, evidence_type) DO UPDATE SET window_min = excluded.window_min
  `).run(scope, scope_id, evidence_type, window_min);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'config.window',
    entityType: 'window_settings', entityId: `${scope}:${evidence_type}`,
    after: { scope, scope_id, evidence_type, window_min }, source: 'web',
  });
  res.json({ ok: true });
}));

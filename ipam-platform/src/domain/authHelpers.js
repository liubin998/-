import { db, now } from '../db.js';
import { recordAudit } from './audit.js';

export {
  verifyPassword, issueToken, revokeToken, decorateUser, authMiddleware,
  requireCap, assertBranch, assertCap, hashPassword, ROLES, CAPS, initRoleCaps, HIGH_RISK_ACTIONS,
} from './auth.js';

export function recordLoginAudit(userId, username, success) {
  recordAudit({
    userId: userId || null,
    username,
    action: 'auth.login',
    entityType: 'user',
    entityId: username,
    result: success ? 'ok' : 'fail',
    reason: success ? null : '密码错误或账号不可用',
    source: 'web',
  });
}

export function listBranches() {
  return db.prepare('SELECT * FROM branches ORDER BY id').all();
}

export function getBranch(id) {
  return db.prepare('SELECT * FROM branches WHERE id = ?').get(id) || null;
}

export function createBranch({ name, code, parent_id = null, owner = null }) {
  const t = now();
  const info = db.prepare(`
    INSERT INTO branches (name, code, parent_id, owner, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(name, code, parent_id, owner, t, t);
  return getBranch(info.lastInsertRowid);
}

export function updateBranch(id, patch) {
  const allowed = ['name', 'code', 'parent_id', 'owner', 'status'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getBranch(id);
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE branches SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getBranch(id);
}

export function grantBranch(userId, branchId, role, validUntil = null) {
  db.prepare('INSERT INTO user_grants (user_id, branch_id, role, valid_until, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, branchId, role, validUntil, now());
}

export function clearGrants(userId) {
  db.prepare('DELETE FROM user_grants WHERE user_id = ?').run(userId);
}

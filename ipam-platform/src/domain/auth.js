import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config } from '../config.js';

export const ROLES = ['hq_admin', 'branch_admin', 'maintainer', 'viewer', 'auditor'];

export const CAPS = [
  'view', 'create', 'edit', 'allocate', 'import', 'conflict', 'device',
  'probe', 'user', 'config', 'audit_view',
];

const ROLE_CAPS = {
  hq_admin: CAPS,
  branch_admin: ['view', 'create', 'edit', 'allocate', 'import', 'conflict', 'device', 'probe'],
  maintainer: ['view', 'edit', 'allocate', 'conflict'],
  viewer: ['view'],
  auditor: ['view', 'audit_view'],
};

export const HIGH_RISK_ACTIONS = ['subnet.delete', 'ip.batch_release', 'probe.bulk', 'credential.update', 'collector.register', 'branch.delete'];

export function initRoleCaps() {
  const insert = db.prepare('INSERT OR IGNORE INTO role_caps (role, cap) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [role, caps] of Object.entries(ROLE_CAPS)) {
      for (const cap of caps) insert.run(role, cap);
    }
  });
  tx();
}

export function capsForRole(role) {
  return db.prepare('SELECT cap FROM role_caps WHERE role = ?').all(role).map((r) => r.cap);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now(), now() + config.tokenTtlMs);
  return token;
}

export function revokeToken(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row || row.session_expires < now()) return null;
  if (row.status !== 'active') return null;
  return row;
}

export function grantsForUser(userId) {
  return db.prepare(`
    SELECT g.*, b.name AS branch_name, b.code AS branch_code
    FROM user_grants g JOIN branches b ON b.id = g.branch_id
    WHERE g.user_id = ? AND (g.valid_until IS NULL OR g.valid_until > ?)
  `).all(userId, now());
}

export function decorateUser(user) {
  const grants = grantsForUser(user.id);
  const caps = new Set();
  const branchIds = new Set();
  for (const g of grants) {
    if (g.role === 'hq_admin') {
      CAPS.forEach((c) => caps.add(c));
      db.prepare('SELECT id FROM branches').all().forEach((b) => branchIds.add(b.id));
    } else {
      for (const c of capsForRole(g.role)) caps.add(c);
      branchIds.add(g.branch_id);
    }
  }
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    department: user.department,
    grants: grants.map((g) => ({ branch_id: g.branch_id, branch_name: g.branch_name, role: g.role, valid_until: g.valid_until })),
    caps: [...caps].sort(),
    branch_ids: [...branchIds],
    is_hq_admin: grants.some((g) => g.role === 'hq_admin'),
  };
}

export function visibleBranchIds(userCtx) {
  if (userCtx.is_hq_admin) return null;
  return userCtx.branch_ids;
}

export function assertBranch(userCtx, branchId, cap = 'view') {
  if (!branchId) throw new AuthError('缺少分支信息');
  if (!userCtx.caps.includes(cap)) throw new AuthError('缺少操作权限', 403);
  if (userCtx.is_hq_admin) return;
  if (!userCtx.branch_ids.includes(branchId)) throw new AuthError('无权访问该分支', 403);
}

export function assertCap(userCtx, cap) {
  if (!userCtx.caps.includes(cap)) throw new AuthError('缺少操作权限', 403);
}

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '未登录或会话已过期' });
  req.user = user;
  req.userCtx = decorateUser(user);
  next();
}

export function requireCap(cap) {
  return (req, res, next) => {
    try {
      assertCap(req.userCtx, cap);
      next();
    } catch (e) {
      next(e);
    }
  };
}

import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import {
  verifyPassword, issueToken, revokeToken, decorateUser, authMiddleware, recordLoginAudit,
} from '../domain/authHelpers.js';

export const authRouter = Router();

authRouter.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw httpError(400, '用户名和密码不能为空');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!user || user.status !== 'active' || !verifyPassword(String(password), user.password_hash)) {
    recordLoginAudit(user?.id, String(username), false);
    throw httpError(401, '用户名或密码错误', 'AUTH_FAILED');
  }
  const token = issueToken(user.id);
  recordLoginAudit(user.id, user.username, true);
  res.json({ token, user: decorateUser(user) });
}));

authRouter.post('/logout', authMiddleware, wrap(async (req, res) => {
  const header = req.headers.authorization || '';
  revokeToken(header.slice(7));
  res.json({ ok: true });
}));

authRouter.get('/me', authMiddleware, wrap(async (req, res) => {
  res.json({ user: req.userCtx });
}));

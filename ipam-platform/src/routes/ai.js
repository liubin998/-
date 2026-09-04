import { Router } from 'express';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';
import { answerQuestion } from '../domain/ai.js';
import { recordAudit } from '../domain/audit.js';

export const aiRouter = Router();
aiRouter.use(authMiddleware);

aiRouter.post('/query', requireCap('view'), wrap(async (req, res) => {
  const { question } = req.body || {};
  if (!question || !String(question).trim()) throw httpError(400, '问题不能为空');
  const result = answerQuestion(question, req.userCtx);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ai.query',
    entityType: 'ai', entityId: null, after: { question, intent: result.intent }, source: 'web',
  });
  res.json(result);
}));

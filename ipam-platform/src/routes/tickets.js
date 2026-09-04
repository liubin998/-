import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap, assertBranch } from '../domain/authHelpers.js';
import { createTicket, getTicket, updateTicket, addComment, listComments, TICKET_STATUS, SEVERITIES } from '../domain/tickets.js';
import { parsePagination, paged } from '../domain/util.js';
import { recordAudit } from '../domain/audit.js';

export const ticketRouter = Router();
ticketRouter.use(authMiddleware);

ticketRouter.get('/', requireCap('view'), wrap(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { status, severity, type, branch_id } = req.query;
  const where = [];
  const vals = [];
  if (!req.userCtx.is_hq_admin && req.userCtx.branch_ids.length) {
    where.push(`(t.branch_id IN (${req.userCtx.branch_ids.map(() => '?').join(',')}) OR t.branch_id IS NULL)`);
    vals.push(...req.userCtx.branch_ids);
  } else if (!req.userCtx.is_hq_admin) {
    return res.json(paged([], 0, { page, limit }));
  }
  if (status) { where.push('t.status = ?'); vals.push(status); }
  if (severity) { where.push('t.severity = ?'); vals.push(severity); }
  if (type) { where.push('t.type = ?'); vals.push(type); }
  if (branch_id) { where.push('t.branch_id = ?'); vals.push(Number(branch_id)); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM tickets t ${whereSql}`).get(...vals).c;
  const rows = db.prepare(`
    SELECT t.*, b.name AS branch_name FROM tickets t LEFT JOIN branches b ON b.id = t.branch_id
    ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).all(...vals, limit, (page - 1) * limit);
  res.json(paged(rows, total, { page, limit }));
}));

ticketRouter.post('/', requireCap('conflict'), wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.title || !body.type) throw httpError(400, '事项类型与标题不能为空');
  if (body.branch_id) assertBranch(req.userCtx, body.branch_id, 'conflict');
  const ticket = createTicket(body);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ticket.create',
    entityType: 'ticket', entityId: ticket.id, branchId: ticket.branch_id, after: ticket, source: 'web',
  });
  res.status(201).json({ ticket });
}));

ticketRouter.get('/:id', requireCap('view'), wrap(async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) throw httpError(404, '事项不存在');
  if (ticket.branch_id) assertBranch(req.userCtx, ticket.branch_id, 'view');
  res.json({ ticket, comments: listComments(ticket.id) });
}));

ticketRouter.patch('/:id', requireCap('conflict'), wrap(async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) throw httpError(404, '事项不存在');
  if (ticket.branch_id) assertBranch(req.userCtx, ticket.branch_id, 'conflict');
  const { status, severity } = req.body || {};
  if (status && !TICKET_STATUS.includes(status)) throw httpError(400, '状态非法');
  if (severity && !SEVERITIES.includes(severity)) throw httpError(400, '严重度非法');
  const updated = updateTicket(ticket.id, req.body || {});
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'ticket.update',
    entityType: 'ticket', entityId: ticket.id, branchId: ticket.branch_id,
    before: ticket, after: updated, source: 'web',
  });
  res.json({ ticket: updated });
}));

ticketRouter.post('/:id/comments', requireCap('view'), wrap(async (req, res) => {
  const ticket = getTicket(Number(req.params.id));
  if (!ticket) throw httpError(404, '事项不存在');
  const { content } = req.body || {};
  if (!content) throw httpError(400, '评论内容不能为空');
  const comments = addComment(ticket.id, req.user.id, content);
  res.json({ comments });
}));

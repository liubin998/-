import { db, now } from '../db.js';

export const TICKET_TYPES = {
  unregistered_use: '疑似未登记占用',
  idle_occupied: '闲置/占用无证据',
  ip_conflict_multi_mac: 'IP 冲突（多 MAC）',
  mac_mismatch: '台账 MAC 与现场不一致',
  source_inconsistent: '数据源不一致',
  subnet_overlap: '网段重叠',
  device_offline: '设备离线',
  import_conflict: '导入冲突',
  manual: '人工事项',
};

export const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export class TicketError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createTicket({
  type, title, severity = 'medium', branch_id = null, ip = null, subnet_id = null,
  device_id = null, assignee = null, detail = null, ticket_key = null, due_at = null,
}) {
  const t = now();
  if (ticket_key) {
    const existing = db.prepare("SELECT id FROM tickets WHERE ticket_key = ? AND status IN ('open','in_progress')").get(ticket_key);
    if (existing) return { ...getTicket(existing.id), deduped: true };
  }
  const info = db.prepare(`
    INSERT INTO tickets (ticket_key, type, title, severity, branch_id, ip, subnet_id, device_id, assignee, status, detail_json, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `).run(ticket_key, type, title, severity, branch_id, ip, subnet_id, device_id, assignee, detail ? JSON.stringify(detail) : null, due_at, t, t);
  return getTicket(info.lastInsertRowid);
}

export function getTicket(id) {
  const row = db.prepare(`
    SELECT t.*, b.name AS branch_name
    FROM tickets t LEFT JOIN branches b ON b.id = t.branch_id
    WHERE t.id = ?
  `).get(id);
  if (!row) return null;
  row.detail = row.detail_json ? safeParse(row.detail_json) : null;
  delete row.detail_json;
  return row;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function updateTicket(id, patch) {
  const cur = getTicket(id);
  if (!cur) throw new TicketError('事项不存在', 404);
  const allowed = ['severity', 'assignee', 'status', 'resolution', 'close_reason', 'due_at', 'branch_id'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (patch.status === 'closed' || patch.status === 'resolved') {
    sets.push('closed_at = ?');
    vals.push(now());
  }
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getTicket(id);
}

export function addComment(ticketId, userId, content) {
  const t = getTicket(ticketId);
  if (!t) throw new TicketError('事项不存在', 404);
  db.prepare('INSERT INTO ticket_comments (ticket_id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, userId, content, now());
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), ticketId);
  return listComments(ticketId);
}

export function listComments(ticketId) {
  return db.prepare(`
    SELECT c.*, u.display_name AS username
    FROM ticket_comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.ticket_id = ? ORDER BY c.created_at ASC
  `).all(ticketId);
}

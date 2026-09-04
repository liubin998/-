import { db, now } from '../db.js';
import { redact } from './util.js';

export function recordAudit({
  userId = null,
  username = null,
  action,
  entityType = null,
  entityId = null,
  branchId = null,
  before = null,
  after = null,
  result = 'ok',
  reason = null,
  source = 'web',
}) {
  db.prepare(`
    INSERT INTO audit_logs
      (user_id, username, action, entity_type, entity_id, branch_id, before_json, after_json, result, reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    username,
    action,
    entityType,
    entityId === null || entityId === undefined ? null : String(entityId),
    branchId,
    before ? JSON.stringify(redact(before)) : null,
    after ? JSON.stringify(redact(after)) : null,
    result,
    reason,
    source,
    now(),
  );
}

export function auditFromReq(req, action, extra = {}) {
  return recordAudit({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? 'system',
    action,
    source: req.user ? 'web' : 'scheduler',
    ...extra,
  });
}

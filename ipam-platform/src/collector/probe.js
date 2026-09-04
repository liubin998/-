import { db, now } from '../db.js';
import { recordObservation } from '../domain/observations.js';
import { recordAudit } from '../domain/audit.js';

export function manualProbe({ userId, username, ip, probeType = 'icmp', subnet = null }) {
  const success = Math.random() > 0.5;
  const t = now();
  db.prepare('INSERT INTO probes (initiator_id, ip, subnet_id, probe_type, result, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, ip, subnet?.id ?? null, probeType, success ? 'reachable' : 'unreachable', null, t);
  if (success) {
    recordObservation({
      device_id: probeDeviceId(),
      branch_id: subnet?.branch_id ?? null,
      evidence_type: probeType === 'tcp' ? 'tcp_port' : 'icmp',
      ip,
      confidence: 'medium',
    });
  }
  recordAudit({
    userId, username, action: 'probe.manual', entityType: 'ip', entityId: ip,
    branchId: subnet?.branch_id ?? null, source: 'web',
    after: { probe_type: probeType, result: success ? 'reachable' : 'unreachable' },
  });
  return { ip, result: success ? 'reachable' : 'unreachable', note: '主动探测仅作为辅助证据，不能单独证明 IP 已使用' };
}

function probeDeviceId() {
  const d = db.prepare("SELECT id FROM devices WHERE role = 'collector' LIMIT 1").get();
  if (d) return d.id;
  const info = db.prepare(`
    INSERT INTO devices (name, vendor, role, protocol, capabilities_json, enabled, status, created_at, updated_at)
    VALUES ('平台探测器', 'platform', 'collector', 'none', '[]', 1, 'online', ?, ?)
  `).run(now(), now());
  return info.lastInsertRowid;
}

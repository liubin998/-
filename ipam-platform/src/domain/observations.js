import { db, now } from '../db.js';
import { toBuffer } from './ip.js';
import { normalizeMac } from './util.js';

export const EVIDENCE_TYPES = [
  'ac_online_user', 'ac_ipmac_bind', 'arp', 'ipv6_neighbor', 'mac_table',
  'dhcp_lease', 'icmp', 'tcp_port', 'manual',
];

export const EVIDENCE_CONFIDENCE = {
  ac_online_user: 'high',
  ac_ipmac_bind: 'medium-high',
  arp: 'high',
  ipv6_neighbor: 'high',
  mac_table: 'high',
  dhcp_lease: 'high',
  icmp: 'medium',
  tcp_port: 'medium',
  manual: 'low-medium',
};

export const DEFAULT_WINDOW_MIN = {
  ac_online_user: 5,
  ac_ipmac_bind: 10,
  arp: 10,
  ipv6_neighbor: 10,
  mac_table: 10,
  dhcp_lease: 15,
  icmp: 5,
  tcp_port: 5,
  manual: 60,
};

export function windowFor(evidenceType, deviceId = null, branchId = null) {
  const row = db.prepare(`
    SELECT window_min FROM window_settings
    WHERE evidence_type = ? AND ((scope = 'device' AND scope_id = ?) OR (scope = 'branch' AND scope_id = ?) OR scope = 'global')
    ORDER BY CASE scope WHEN 'device' THEN 0 WHEN 'branch' THEN 1 ELSE 2 END
    LIMIT 1
  `).get(evidenceType, deviceId, branchId);
  const minutes = row ? row.window_min : (DEFAULT_WINDOW_MIN[evidenceType] ?? 10);
  return minutes * 60 * 1000;
}

export function recordObservation({
  device_id, branch_id = null, evidence_type, ip, mac = null, username = null,
  terminal = null, port = null, vlan = null, detail = null, login_time = null,
  online_seconds = null, confidence = null, observed_at = null, ttl_ms = null,
}) {
  const buf = toBuffer(ip);
  const family = buf.length === 4 ? 4 : 6;
  const ts = observed_at ?? now();
  const conf = confidence || EVIDENCE_CONFIDENCE[evidence_type] || 'medium';
  const ttl = ttl_ms ?? windowFor(evidence_type, device_id, branch_id);
  db.prepare(`
    INSERT INTO observations
      (device_id, branch_id, evidence_type, ip, value, family, mac, username, terminal, port, vlan, detail_json, login_time, online_seconds, confidence, observed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(device_id, branch_id, evidence_type, ip, buf, family, mac ? normalizeMac(mac) : null, username, terminal, port, vlan, detail ? JSON.stringify(detail) : null, login_time, online_seconds, conf, ts, ts + ttl);
}

export function clearObservationsForDevice(deviceId) {
  db.prepare('DELETE FROM observations WHERE device_id = ?').run(deviceId);
}

export function queryObservations({ ip = null, evidence_type = null, within_ms = null, device_id = null, family = null, limit = 500 }) {
  const t = now();
  const conditions = [];
  const params = [];
  if (ip) {
    const buf = toBuffer(ip);
    conditions.push('o.value = ?');
    params.push(buf);
    conditions.push('o.family = ?');
    params.push(buf.length === 4 ? 4 : 6);
  } else if (family) {
    conditions.push('o.family = ?');
    params.push(family);
  }
  if (evidence_type) {
    conditions.push('o.evidence_type = ?');
    params.push(evidence_type);
  }
  if (device_id) {
    conditions.push('o.device_id = ?');
    params.push(device_id);
  }
  if (within_ms) {
    conditions.push('o.observed_at >= ?');
    params.push(t - within_ms);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT o.*, d.name AS device_name, d.vendor AS device_vendor
    FROM observations o JOIN devices d ON d.id = o.device_id
    ${where}
    ORDER BY o.observed_at DESC LIMIT ?
  `).all(...params, limit);
}

export function freshObservations({ ip, within_ms = null }) {
  const t = now();
  const rows = queryObservations({ ip, limit: 2000 });
  return rows.filter((r) => {
    const win = within_ms ?? windowFor(r.evidence_type, r.device_id, r.branch_id);
    return t - r.observed_at <= win;
  });
}

export function purgeExpired() {
  const cutoff = now() - 7 * 24 * 3600 * 1000;
  const res = db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
  return res.changes;
}

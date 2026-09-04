import { db, now } from '../db.js';
import { getIp, currentAssignment } from './ipLedger.js';
import { longestPrefixMatch } from './subnet.js';
import { queryObservations, windowFor } from './observations.js';
import { normalizeMac } from './util.js';

export const FIELD_STATUS = {
  confirmed_use: '明确使用',
  possible_use: '可能使用',
  not_found: '未发现使用',
  undetermined: '无法判断',
  ledger_conflict: '台账冲突',
  incomplete: '采集不完整',
};

function deviceUsable(deviceId) {
  const d = db.prepare('SELECT enabled, status, last_comm_at FROM devices WHERE id = ?').get(deviceId);
  if (!d) return false;
  if (!d.enabled) return false;
  if (d.status === 'offline' || d.status === 'error') return false;
  return true;
}

export function diagnoseIp(ipText, { includeEvidence = true } = {}) {
  const t = now();
  const ledger = getIp(ipText);
  const match = longestPrefixMatch(ipText);
  const allObs = queryObservations({ ip: ipText, limit: 2000 });

  const evidence = [];
  const sourceDevices = new Set();
  let anyFresh = false;
  let anyDeviceBlocked = false;
  let truncated = false;

  for (const o of allObs) {
    const win = windowFor(o.evidence_type, o.device_id, o.branch_id);
    const fresh = t - o.observed_at <= win;
    const usable = deviceUsable(o.device_id);
    if (!usable) {
      anyDeviceBlocked = true;
      continue;
    }
    sourceDevices.add(o.device_id);
    if (fresh) {
      anyFresh = true;
      evidence.push({ ...o, fresh: true });
    }
  }

  const strongTypes = new Set(['ac_online_user', 'arp', 'ipv6_neighbor', 'mac_table', 'dhcp_lease']);
  const hasStrong = evidence.some((e) => strongTypes.has(e.evidence_type));
  const hasAcOnline = evidence.some((e) => e.evidence_type === 'ac_online_user');
  const hasWeak = evidence.some((e) => e.evidence_type === 'icmp' || e.evidence_type === 'tcp_port' || e.evidence_type === 'ac_ipmac_bind');

  const runs = sourceDevices.size
    ? db.prepare(`
        SELECT completeness FROM collect_runs
        WHERE device_id IN (${[...sourceDevices].map(() => '?').join(',')})
        ORDER BY started_at DESC LIMIT 20
      `).all(...sourceDevices)
    : [];
  truncated = runs.some((r) => r.completeness === 'incomplete');

  let fieldStatus;
  let confidence = 'low';
  if (truncated) {
    fieldStatus = 'incomplete';
  } else if (hasAcOnline && hasStrong) {
    fieldStatus = 'confirmed_use';
    confidence = 'high';
  } else if (hasStrong) {
    fieldStatus = 'confirmed_use';
    confidence = 'high';
  } else if (hasWeak) {
    fieldStatus = 'possible_use';
    confidence = 'medium';
  } else if (sourceDevices.size === 0 || anyDeviceBlocked) {
    fieldStatus = 'undetermined';
  } else if (!anyFresh) {
    fieldStatus = 'undetermined';
  } else {
    fieldStatus = 'not_found';
    confidence = 'medium';
  }

  let conflict = null;
  if (ledger && (fieldStatus === 'confirmed_use' || fieldStatus === 'possible_use')) {
    const ledgerMac = normalizeMac(ledger.mac);
    const obsMac = evidence.map((e) => normalizeMac(e.mac)).filter(Boolean)[0] || null;
    if (ledger.business_status === 'free' || ledger.business_status === 'released') {
      conflict = { type: 'unregistered_use', message: '台账为空闲/已释放，但现场发现使用证据' };
    } else if (ledgerMac && obsMac && ledgerMac !== obsMac) {
      conflict = { type: 'mac_mismatch', message: `台账 MAC ${ledgerMac} 与现场 MAC ${obsMac} 不一致`, ledger_mac: ledgerMac, observed_mac: obsMac };
      fieldStatus = 'ledger_conflict';
    }
  }
  if (ledger && ledger.business_status === 'occupied' && fieldStatus === 'not_found') {
    conflict = conflict || { type: 'occupied_no_evidence', message: '台账为占用，但在有效采集窗口内未发现使用证据' };
  }

  return {
    ip: ipText,
    generated_at: t,
    ledger: ledger ? {
      id: ledger.id,
      business_status: ledger.business_status,
      mac: ledger.mac,
      subnet_cidr: ledger.subnet_cidr,
      branch_name: ledger.branch_name,
      source: ledger.source,
      assignment: currentAssignment(ledger.id) || null,
    } : null,
    subnet: match.best ? { cidr: match.best.cidr, branch_id: match.best.branch_id, nested: match.all.length > 1, candidates: match.all.map((m) => m.cidr) } : null,
    field_status: fieldStatus,
    field_status_label: FIELD_STATUS[fieldStatus],
    confidence,
    conflict,
    evidence_count: evidence.length,
    evidence: includeEvidence ? evidence.map((e) => ({
      evidence_type: e.evidence_type,
      device_name: e.device_name,
      ip: e.ip,
      mac: e.mac,
      username: e.username,
      terminal: e.terminal,
      port: e.port,
      confidence: e.confidence,
      observed_at: e.observed_at,
      age_ms: t - e.observed_at,
    })) : [],
    truncated,
    device_blocked: anyDeviceBlocked,
  };
}

export function diagnoseSubnet(subnet, { limit = 500 } = {}) {
  const rows = db.prepare('SELECT address FROM ip_ledger WHERE subnet_id = ? LIMIT ?').all(subnet.id, limit);
  return rows.map((r) => ({ ip: r.address, diagnosis: diagnoseIp(r.address, { includeEvidence: false }) }));
}

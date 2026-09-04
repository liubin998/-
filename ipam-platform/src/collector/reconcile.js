import { db, now } from '../db.js';
import { createTicket } from '../domain/tickets.js';
import { recordAudit } from '../domain/audit.js';

export function runReconcileAll() {
  const created = [];
  const t = now();
  const obs = db.prepare(`
    SELECT o.ip, o.mac, o.evidence_type, o.observed_at, o.device_id, o.branch_id, d.status AS device_status, d.enabled
    FROM observations o JOIN devices d ON d.id = o.device_id
  `).all();

  const freshByIp = new Map();
  for (const o of obs) {
    if (t - o.observed_at > 10 * 60 * 1000) continue;
    if (!o.enabled || o.device_status !== 'online') continue;
    if (!freshByIp.has(o.ip)) freshByIp.set(o.ip, []);
    freshByIp.get(o.ip).push(o);
  }

  const ledgerRows = db.prepare("SELECT address, business_status, mac, branch_id FROM ip_ledger").all();
  const ledgerByIp = new Map(ledgerRows.map((r) => [r.address, r]));

  for (const [ip, evidences] of freshByIp) {
    const ledger = ledgerByIp.get(ip);
    const branchId = evidences[0].branch_id;
    const macs = [...new Set(evidences.map((e) => e.mac).filter(Boolean))];

    if (macs.length > 1) {
      const tk = createTicket({
        type: 'ip_conflict_multi_mac',
        title: `IP ${ip} 在 ${macs.length} 个设备上出现不同 MAC`,
        severity: 'high',
        branch_id: branchId,
        ip,
        ticket_key: `multi_mac:${ip}`,
        detail: { macs },
      });
      if (!tk.deduped) created.push(tk);
    }

    if (!ledger) {
      const tk = createTicket({
        type: 'unregistered_use',
        title: `现场发现未登记使用的 IP ${ip}`,
        severity: 'medium',
        branch_id: branchId,
        ip,
        ticket_key: `unreg:${ip}`,
        detail: { evidence_count: evidences.length },
      });
      if (!tk.deduped) created.push(tk);
    } else if (ledger.business_status === 'free' || ledger.business_status === 'released') {
      const tk = createTicket({
        type: 'unregistered_use',
        title: `台账为${ledger.business_status === 'free' ? '空闲' : '已释放'}，但现场发现 ${ip} 正在使用`,
        severity: 'medium',
        branch_id: branchId,
        ip,
        ticket_key: `unreg:${ip}`,
        detail: { business_status: ledger.business_status, evidence_count: evidences.length },
      });
      if (!tk.deduped) created.push(tk);
    } else if (ledger.business_status === 'occupied' && ledger.mac && macs.length === 1 && ledger.mac.toLowerCase().replace(/[^0-9a-f]/g, '') !== macs[0].toLowerCase().replace(/[^0-9a-f]/g, '')) {
      const tk = createTicket({
        type: 'mac_mismatch',
        title: `IP ${ip} 台账 MAC 与现场 MAC 不一致`,
        severity: 'medium',
        branch_id: branchId,
        ip,
        ticket_key: `macmm:${ip}`,
        detail: { ledger_mac: ledger.mac, observed_mac: macs[0] },
      });
      if (!tk.deduped) created.push(tk);
    }
  }

  for (const ledger of ledgerRows) {
    if (ledger.business_status !== 'occupied') continue;
    if (!freshByIp.has(ledger.address)) {
      const tk = createTicket({
        type: 'idle_occupied',
        title: `台账占用的 ${ledger.address} 在有效窗口内无使用证据`,
        severity: 'low',
        branch_id: ledger.branch_id,
        ip: ledger.address,
        ticket_key: `idle:${ledger.address}`,
        detail: { business_status: ledger.business_status },
      });
      if (!tk.deduped) created.push(tk);
    }
  }

  const offlineDevices = db.prepare("SELECT * FROM devices WHERE enabled = 1 AND status IN ('offline','error')").all();
  for (const d of offlineDevices) {
    const tk = createTicket({
      type: 'device_offline',
      title: `设备 ${d.name} 离线或采集失败`,
      severity: 'high',
      branch_id: d.branch_id,
      device_id: d.id,
      ticket_key: `devoff:${d.id}`,
      detail: { last_error: d.last_error, status: d.status },
    });
    if (!tk.deduped) created.push(tk);
  }

  if (created.length) {
    recordAudit({
      action: 'reconcile.generate_tickets',
      entityType: 'ticket',
      result: 'ok',
      source: 'scheduler',
      after: { created_count: created.length, ids: created.map((c) => c.id) },
    });
  }
  return created;
}

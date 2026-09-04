import { db, now } from '../db.js';
import { SangforAcAdapter, normalizeAcUser, mapError } from './adapters/sangfor.js';
import { HuaweiSwitchAdapter } from './adapters/huawei.js';
import { recordObservation, clearObservationsForDevice } from '../domain/observations.js';
import { markDeviceStatus } from '../domain/devices.js';
import { toBuffer, bufferToBigInt, bigIntToBuffer, fromBuffer, cidrRange } from '../domain/ip.js';
import { createTicket } from '../domain/tickets.js';
import { recordAudit } from '../domain/audit.js';
import { config } from '../config.js';

const MAX_SHARDS_PER_RUN = 40;

function shardPlan(branchId) {
  const subnets = db.prepare(`
    SELECT cidr, family, prefix FROM subnets WHERE branch_id = ? AND status = 'active' ORDER BY prefix ASC
  `).all(branchId);
  const shards = [];
  for (const s of subnets) {
    if (s.family !== 4) continue;
    if (s.prefix >= 24) {
      shards.push(s.cidr);
    } else {
      const r = cidrRange(s.cidr);
      const start = bufferToBigInt(r.startBuf);
      const step = 1n << BigInt(32 - 24);
      const totalShards = Number((r.endBuf.length, (bufferToBigInt(r.endBuf) - start + 1n) / step));
      const limit = Math.min(totalShards, MAX_SHARDS_PER_RUN);
      for (let i = 0; i < limit; i++) {
        const base = start + BigInt(i) * step;
        shards.push(`${fromBuffer(bigIntToBuffer(base, 4))}/24`);
      }
    }
  }
  return shards;
}

async function collectSangforAc(device) {
  const adapter = new SangforAcAdapter(device, { transport: 'sim' });
  const run = { device_id: device.id, task: 'ac_full', started_at: now(), completeness: 'complete', record_count: 0, detail: {} };
  try {
    const version = await adapter.getVersion();
    const health = await adapter.getHealthStats();
    run.detail.version = version?.version ?? null;
    run.detail.health = health;
    markDeviceStatus(device.id, 'online');

    db.prepare("DELETE FROM observations WHERE device_id = ? AND evidence_type IN ('ac_online_user','ac_ipmac_bind')").run(device.id);

    const shards = shardPlan(device.branch_id);
    run.detail.shards_queried = shards.length;
    run.detail.shard_ranges = shards.slice(0, 20);
    let total = 0;
    let incomplete = false;
    for (const shard of shards) {
      let resp;
      try {
        resp = await adapter.queryOnlineUsers({ type: 'ip', value: [shard] });
      } catch (e) {
        if (e.category === 'auth' || e.category === 'whitelist' || e.category === 'config' || e.category === 'network_scope') throw e;
        continue;
      }
      const users = (resp.users || []).map(normalizeAcUser);
      total += users.length;
      if (resp.count > users.length || users.length >= config.acOnlineUserCap) incomplete = true;
      for (const u of users) {
        recordObservation({
          device_id: device.id,
          branch_id: device.branch_id,
          evidence_type: 'ac_online_user',
          ip: u.ip,
          mac: u.mac,
          username: u.username,
          terminal: u.terminal,
          login_time: u.login_time,
          online_seconds: u.online_seconds,
          confidence: 'high',
        });
      }
      if (users.length) {
        const sample = users[0];
        const binding = await adapter.queryIpMacBinding(sample.ip).catch(() => null);
        for (const b of binding?.bindings || []) {
          recordObservation({
            device_id: device.id,
            branch_id: device.branch_id,
            evidence_type: 'ac_ipmac_bind',
            ip: b.ip,
            mac: b.mac,
            confidence: 'medium-high',
            detail: { desc: b.desc },
          });
        }
      }
    }
    run.record_count = total;
    if (incomplete) run.completeness = 'incomplete';
    return run;
  } catch (e) {
    const err = mapError(e.code ?? null, e.message);
    markDeviceStatus(device.id, 'error', err.message);
    run.completeness = 'failed';
    run.detail.error = err;
    return run;
  }
}

async function collectHuaweiSwitch(device) {
  const adapter = new HuaweiSwitchAdapter(device, { transport: 'sim' });
  const run = { device_id: device.id, task: 'switch_full', started_at: now(), completeness: 'complete', record_count: 0, detail: {} };
  try {
    await adapter.testConnection();
    markDeviceStatus(device.id, 'online');
    db.prepare("DELETE FROM observations WHERE device_id = ? AND evidence_type IN ('arp','mac_table')").run(device.id);
    const arp = await adapter.getArpTable();
    for (const a of arp) {
      recordObservation({
        device_id: device.id,
        branch_id: device.branch_id,
        evidence_type: 'arp',
        ip: a.ip,
        mac: a.mac,
        port: a.interface,
        vlan: a.vlan,
        confidence: 'high',
      });
    }
    const macs = await adapter.getMacTable();
    for (const m of macs) {
      recordObservation({
        device_id: device.id,
        branch_id: device.branch_id,
        evidence_type: 'mac_table',
        ip: arp.find((a) => a.mac === m.mac)?.ip ?? '0.0.0.0',
        mac: m.mac,
        port: m.port,
        vlan: m.vlan,
        confidence: 'high',
      });
    }
    run.record_count = arp.length + macs.length;
    run.detail.arp_count = arp.length;
    run.detail.mac_count = macs.length;
    return run;
  } catch (e) {
    markDeviceStatus(device.id, 'error', e.message);
    run.completeness = 'failed';
    run.detail.error = { message: e.message, category: e.category || 'unknown' };
    return run;
  }
}

export async function runCollectForDevice(device) {
  let run;
  if (device.vendor === 'sangfor' || device.role === 'ac') {
    run = await collectSangforAc(device);
  } else if (device.vendor === 'huawei' || device.role === 'switch') {
    run = await collectHuaweiSwitch(device);
  } else {
    run = { device_id: device.id, task: 'skip', started_at: now(), status: 'skipped', completeness: 'complete', record_count: 0, detail: { reason: 'unsupported vendor/role' } };
  }
  run.finished_at = now();
  run.status = run.completeness === 'failed' ? 'failed' : 'success';
  db.prepare(`
    INSERT INTO collect_runs (device_id, task, started_at, finished_at, status, completeness, record_count, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.device_id, run.task, run.started_at, run.finished_at, run.status, run.completeness, run.record_count, JSON.stringify(run.detail));
  return run;
}

export async function runCollectAll() {
  const devices = db.prepare('SELECT * FROM devices WHERE enabled = 1').all();
  const results = [];
  for (const d of devices) {
    results.push(await runCollectForDevice(d));
  }
  return results;
}

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

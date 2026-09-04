import { db, now } from '../db.js';
import { SangforAcAdapter, normalizeAcUser, mapError } from './adapters/sangfor.js';
import { HuaweiSwitchAdapter } from './adapters/huawei.js';
import { recordObservation } from '../domain/observations.js';
import { markDeviceStatus } from '../domain/devices.js';
import { bufferToBigInt, bigIntToBuffer, fromBuffer, cidrRange } from '../domain/ip.js';
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

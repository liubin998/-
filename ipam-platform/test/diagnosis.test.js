import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { toBuffer } from '../src/domain/ip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(__dirname, '..', 'data', `.test-diag-${process.pid}`);
process.env.DATA_DIR = tmpDir;

const { db, now } = await import('../src/db.js');
const { diagnoseIp } = await import('../src/domain/diagnosis.js');
const { recordObservation } = await import('../src/domain/observations.js');

function seedDevice(name, { enabled = 1, status = 'online' } = {}) {
  const t = now();
  const r = db.prepare(`
    INSERT INTO devices (name, vendor, capabilities_json, enabled, status, created_at, updated_at)
    VALUES (?, 'test', '[]', ?, ?, ?, ?)
  `).run(name, enabled, status, t, t);
  return Number(r.lastInsertRowid);
}

function seedLedger(address, { business_status = 'occupied', mac = null } = {}) {
  const buf = toBuffer(address);
  const t = now();
  db.prepare(`
    INSERT INTO ip_ledger (address, family, value, business_status, mac, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(address, buf.length === 4 ? 4 : 6, buf, business_status, mac, t, t);
}

function seedRun(deviceId, completeness) {
  db.prepare(`
    INSERT INTO collect_runs (device_id, task, started_at, status, completeness, record_count)
    VALUES (?, 'collect', ?, 'success', ?, 0)
  `).run(deviceId, now(), completeness);
}

before(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('强证据（ARP 新鲜）→ 明确使用/高置信', () => {
  const dev = seedDevice('sw-arp');
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.1', mac: 'aa:bb:cc:00:00:01', observed_at: now() - 60_000 });
  const d = diagnoseIp('10.90.0.1');
  assert.equal(d.field_status, 'confirmed_use');
  assert.equal(d.field_status_label, '明确使用');
  assert.equal(d.confidence, 'high');
  assert.equal(d.evidence_count, 1);
  assert.equal(d.conflict, null);
});

test('仅弱证据（ICMP）→ 可能使用/中置信', () => {
  const dev = seedDevice('sw-icmp');
  recordObservation({ device_id: dev, evidence_type: 'icmp', ip: '10.90.0.2', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.2');
  assert.equal(d.field_status, 'possible_use');
  assert.equal(d.confidence, 'medium');
});

test('证据过期 → 无法判断', () => {
  const dev = seedDevice('sw-stale');
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.3', mac: 'aa:bb:cc:00:00:03', observed_at: now() - 2 * 3600_000 });
  const d = diagnoseIp('10.90.0.3');
  assert.equal(d.field_status, 'undetermined');
  assert.equal(d.evidence_count, 0);
});

test('设备禁用时证据不计入并标记 device_blocked', () => {
  const dev = seedDevice('sw-disabled', { enabled: 0 });
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.4', mac: 'aa:bb:cc:00:00:04', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.4');
  assert.equal(d.field_status, 'undetermined');
  assert.equal(d.device_blocked, true);
  assert.equal(d.evidence_count, 0);
});

test('台账空闲但现场在用 → 未登记使用冲突', () => {
  const dev = seedDevice('sw-free');
  seedLedger('10.90.0.5', { business_status: 'free' });
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.5', mac: 'aa:bb:cc:00:00:05', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.5');
  assert.equal(d.field_status, 'confirmed_use');
  assert.equal(d.conflict?.type, 'unregistered_use');
});

test('台账 MAC 与现场不一致 → 台账冲突', () => {
  const dev = seedDevice('sw-mac');
  seedLedger('10.90.0.6', { business_status: 'occupied', mac: 'aa:bb:cc:00:00:aa' });
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.6', mac: 'aa:bb:cc:00:00:bb', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.6');
  assert.equal(d.field_status, 'ledger_conflict');
  assert.equal(d.conflict?.type, 'mac_mismatch');
});

test('台账占用但窗口内无证据（弱外的新鲜证据判未发现）→ 占用无证据冲突', () => {
  const dev = seedDevice('sw-manual');
  seedLedger('10.90.0.7', { business_status: 'occupied' });
  recordObservation({ device_id: dev, evidence_type: 'manual', ip: '10.90.0.7', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.7');
  assert.equal(d.field_status, 'not_found');
  assert.equal(d.conflict?.type, 'occupied_no_evidence');
});

test('采集不完整 → incomplete 优先于其他判定', () => {
  const dev = seedDevice('sw-trunc');
  seedRun(dev, 'incomplete');
  recordObservation({ device_id: dev, evidence_type: 'arp', ip: '10.90.0.8', mac: 'aa:bb:cc:00:00:08', observed_at: now() - 30_000 });
  const d = diagnoseIp('10.90.0.8');
  assert.equal(d.field_status, 'incomplete');
  assert.equal(d.truncated, true);
});

test('无任何观测与台账 → 无法判断且无冲突', () => {
  const d = diagnoseIp('10.90.0.99');
  assert.equal(d.field_status, 'undetermined');
  assert.equal(d.ledger, null);
  assert.equal(d.subnet, null);
  assert.equal(d.conflict, null);
});

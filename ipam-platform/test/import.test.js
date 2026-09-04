import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { toBuffer } from '../src/domain/ip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(__dirname, '..', 'data', `.test-import-${process.pid}`);
process.env.DATA_DIR = tmpDir;

const { db, now } = await import('../src/db.js');
const pipeline = await import('../src/import/pipeline.js');
const { detectFileType, autoMapColumns, precheckBatch, registerBatch, commitBatch, batchErrors, batchTraces } = pipeline;

let userId;
let branchId;

function seedLedger(address, { business_status = 'occupied', mac = null } = {}) {
  const buf = toBuffer(address);
  const t = now();
  db.prepare(`
    INSERT INTO ip_ledger (address, family, value, business_status, mac, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(address, buf.length === 4 ? 4 : 6, buf, business_status, mac, t, t);
}

before(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  const t = now();
  userId = Number(db.prepare(`
    INSERT INTO users (username, password_hash, display_name, status, created_at, updated_at)
    VALUES ('tester', 'x', '测试员', 'active', ?, ?)
  `).run(t, t).lastInsertRowid);
  branchId = Number(db.prepare(`
    INSERT INTO branches (name, code, status, created_at, updated_at)
    VALUES ('总部', 'hq', 'active', ?, ?)
  `).run(t, t).lastInsertRowid);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('detectFileType 按扩展名与魔数识别', () => {
  assert.equal(detectFileType('a.CSV', Buffer.alloc(4)), 'csv');
  assert.equal(detectFileType('a.xlsx', Buffer.alloc(4)), 'xlsx');
  assert.equal(detectFileType('noext', Buffer.from([0x50, 0x4b, 3, 4])), 'xlsx');
  assert.equal(detectFileType('noext', Buffer.from('ip')), 'csv');
});

test('autoMapColumns 中文表头别名映射', () => {
  const m = autoMapColumns(['IP地址', '业务状态', 'MAC地址', '网段', '分支', '备注'], 'ip');
  assert.deepEqual(m, { address: 0, business_status: 1, mac: 2, subnet_cidr: 3, branch: 4, description: 5 });
  const ms = autoMapColumns(['CIDR', '用途', '类型', 'VLAN', '网关'], 'subnet');
  assert.deepEqual(ms, { cidr: 0, purpose: 1, kind: 2, vlan: 3, gateway: 4 });
});

test('precheckBatch 行级分级：ok/warning/error/conflict', () => {
  seedLedger('192.168.60.11', { business_status: 'occupied', mac: 'aa:bb:cc:60:00:11' });
  seedLedger('192.168.60.12', { business_status: 'occupied', mac: 'aa:bb:cc:60:00:12' });
  const mapping = { address: 0, business_status: 1, mac: 2, subnet_cidr: 3, branch: 4, description: 5 };
  const rows = [
    ['192.168.60.10', '占用', 'aa:bb:cc:60:00:10', '192.168.60.0/24', '总部', '新行'],
    ['192.168.60.11', '空闲', '', '', '', '状态与台账不一致'],
    ['192.168.60.12', '占用', 'aa:bb:cc:60:00:12', '', '', '字段一致'],
    ['192.168.60.10', '占用', '', '', '', '文件内重复'],
    ['300.1.1.1', '占用', '', '', '', '非法 IP'],
    ['192.168.60.13', '神秘状态', '不是MAC', '不是网段', '不存在分部', '多重警告'],
    ['', '', '', '', '', ''],
  ];
  const r = precheckBatch({ rows, mapping, target: 'ip', defaultBranchId: branchId });
  assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].level, 'ok');
  assert.equal(r.rows[0].data.branch_id, branchId);
  assert.equal(r.rows[1].level, 'conflict');
  assert.ok(r.rows[1].warnings.some((w) => w.error_type === 'ledger_conflict'));
  assert.equal(r.rows[2].level, 'warning');
  assert.ok(r.rows[2].warnings.some((w) => w.error_type === 'ledger_exists'));
  assert.equal(r.rows[3].level, 'error');
  assert.ok(r.rows[3].errors.some((e) => e.error_type === 'duplicate_in_file'));
  assert.equal(r.rows[4].level, 'error');
  assert.ok(r.rows[4].errors.some((e) => e.error_type === 'invalid_ip'));
  assert.ok(r.rows[5].warnings.some((w) => w.error_type === 'unknown_status'));
  assert.equal(r.rows[5].data.business_status, 'pending');
  assert.ok(r.rows[5].warnings.some((w) => w.error_type === 'invalid_cidr'));
  assert.ok(r.rows[5].warnings.some((w) => w.error_type === 'unknown_branch'));
  assert.deepEqual(r.counts, { ok: 1, warning: 2, error: 2, conflict: 1 });
});

test('commitBatch 不覆盖：新增入库、冲突与错误跳过', () => {
  seedLedger('192.168.70.11', { business_status: 'occupied' });
  const csv = Buffer.from('IP地址,业务状态,备注\n192.168.70.10,占用,新增行\n192.168.70.11,空闲,冲突行\n300.1.1.1,占用,非法行\n');
  const batch = registerBatch({ filename: 't1.csv', buf: csv, fileType: 'csv', userId });
  assert.ok(fs.existsSync(batch.stored_path));
  const res = commitBatch(batch.id, { target: 'ip', overwrite: false });
  assert.deepEqual(res.stats, { inserted: 1, updated: 0, skipped: 2 });
  const row = db.prepare('SELECT * FROM ip_ledger WHERE address = ?').get('192.168.70.10');
  assert.equal(row.source, 'import');
  assert.equal(row.import_batch_id, batch.id);
  assert.equal(row.import_row, 2);
  assert.equal(db.prepare('SELECT business_status FROM ip_ledger WHERE address = ?').get('192.168.70.11').business_status, 'occupied');

  const errs = batchErrors(batch.id);
  assert.ok(errs.some((e) => e.error_type === 'invalid_ip' && e.row_no === 4));
  assert.ok(errs.some((e) => e.error_type === 'ledger_conflict' && e.row_no === 3));
  const traces = batchTraces(batch.id);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].address, '192.168.70.10');

  assert.throws(
    () => commitBatch(batch.id, { target: 'ip', overwrite: true }),
    (e) => e.status === 409 && e.code === 'BATCH_COMMITTED',
  );
});

test('commitBatch 覆盖模式：冲突行被更新并留痕', () => {
  const csv = Buffer.from('IP地址,业务状态,备注\n192.168.70.11,空闲,覆盖提交\n');
  const batch = registerBatch({ filename: 't2.csv', buf: csv, fileType: 'csv', userId });
  const res = commitBatch(batch.id, { target: 'ip', overwrite: true });
  assert.deepEqual(res.stats, { inserted: 0, updated: 1, skipped: 0 });
  const row = db.prepare('SELECT * FROM ip_ledger WHERE address = ?').get('192.168.70.11');
  assert.equal(row.business_status, 'free');
  assert.equal(row.source, 'import');
  assert.equal(row.import_batch_id, batch.id);
});

test('网段目标导入：新网段入库、文件内重复跳过', () => {
  const csv = Buffer.from('CIDR,类型,VLAN,网关,备注\n172.16.0.0/24,lan,10,172.16.0.1,新网段\n172.16.0.0/24,lan,,,文件内重复\n');
  const batch = registerBatch({ filename: 's1.csv', buf: csv, fileType: 'csv', userId });
  const res = commitBatch(batch.id, { target: 'subnet', overwrite: false });
  assert.deepEqual(res.stats, { inserted: 1, updated: 0, skipped: 1 });
  const sn = db.prepare('SELECT * FROM subnets WHERE cidr = ?').get('172.16.0.0/24');
  assert.equal(sn.kind, 'lan');
  assert.equal(sn.vlan, 10);
  assert.equal(sn.gateway, '172.16.0.1');
});

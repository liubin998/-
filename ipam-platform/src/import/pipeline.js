import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { parseCsv } from './csv.js';
import { parseXlsx } from './xlsx.js';
import { isValidIp, normalizeIp, cidrRange, toBuffer } from '../domain/ip.js';
import { normalizeMac } from '../domain/util.js';
import { BUSINESS_STATUS } from '../domain/ipLedger.js';
import { SUBNET_KINDS, longestPrefixMatch } from '../domain/subnet.js';

export class ImportError extends Error {
  constructor(message, status = 400, code = 'IMPORT_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const FIELD_ALIASES = {
  address: ['address', 'ip', 'ip地址', 'ip 地址', 'ipaddress', '地址', '主机地址'],
  business_status: ['status', 'business_status', '状态', '业务状态', '使用状态'],
  mac: ['mac', 'mac地址', 'mac 地址', '物理地址', '硬件地址', 'macaddress'],
  subnet_cidr: ['subnet', 'subnet_cidr', 'cidr', '网段', '子网', '子网段', '网络段'],
  branch: ['branch', 'branch_name', '分支', '分支机构', '站点', '分部', '分公司', '区域'],
  description: ['description', 'desc', 'remark', 'remarks', '备注', '说明', '描述', '用途说明'],
  purpose: ['purpose', '用途'],
  kind: ['kind', 'type', '类型', '网段类型'],
  vlan: ['vlan', 'vlan id', 'vlanid', '虚拟局域网'],
  gateway: ['gateway', '网关', '默认网关'],
};

export const STATUS_ALIASES = {
  free: ['free', '空闲', '可用', '未使用'],
  occupied: ['occupied', '占用', '使用中', '已使用', '在用'],
  reserved: ['reserved', '预留', '保留'],
  released: ['released', '已释放', '释放'],
  conflict: ['conflict', '冲突'],
  unavailable: ['unavailable', '不可用', '禁用', '保留不用'],
  pending: ['pending', '待确认', '待定'],
};

export function detectFileType(filename, buf) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';
  return 'csv';
}

export function parseImportFile(buf, fileType) {
  if (fileType === 'xlsx') return parseXlsx(buf);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return [{ name: 'csv', rows: parseCsv(text) }];
}

export function autoMapColumns(headerRow, target = 'ip') {
  const mapping = {};
  headerRow.forEach((raw, idx) => {
    const h = String(raw ?? '').trim().toLowerCase();
    if (!h) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (target === 'ip' && (field === 'kind' || field === 'gateway')) continue;
      if (!aliases.includes(h)) continue;
      if (target === 'subnet' && field === 'subnet_cidr') {
        if (mapping.cidr === undefined) mapping.cidr = idx;
      } else if (!(field in mapping)) {
        mapping[field] = idx;
      }
      break;
    }
  });
  return mapping;
}

export function registerBatch({ filename, buf, fileType, userId, sheet = null }) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const storedDir = path.join(config.dataDir, 'imports');
  fs.mkdirSync(storedDir, { recursive: true });
  const storedPath = path.join(storedDir, `${hash.slice(0, 12)}_${Date.now()}${path.extname(filename) || '.bin'}`);
  fs.writeFileSync(storedPath, buf);
  const info = db.prepare(`
    INSERT INTO import_batches (filename, file_hash, stored_path, file_type, sheet, uploaded_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)
  `).run(filename, hash, storedPath, fileType, sheet, userId, now());
  return { id: info.lastInsertRowid, file_hash: hash, stored_path: storedPath };
}

function resolveBranch(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  return db.prepare('SELECT * FROM branches WHERE name = ? OR code = ?').get(trimmed, trimmed) || null;
}

function mapStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const [canonical, aliases] of Object.entries(STATUS_ALIASES)) {
    if (aliases.includes(v)) return canonical;
  }
  return BUSINESS_STATUS.includes(v) ? v : undefined;
}

function cell(row, idx) {
  if (idx === undefined || idx === null) return '';
  return String(row[idx] ?? '').trim();
}

export function precheckBatch({ rows, mapping, target = 'ip', defaultBranchId = null }) {
  const headerSkipped = mapping && Object.keys(mapping).length;
  const result = { rows: [], counts: { ok: 0, warning: 0, error: 0, conflict: 0 }, issues: [] };
  const seenInFile = new Map();
  const dataRows = rows;
  for (let i = 0; i < dataRows.length; i++) {
    const rowNo = i + 2;
    const raw = dataRows[i];
    if (!raw || raw.every((c) => !String(c ?? '').trim())) continue;
    const record = { row_no: rowNo, level: 'ok', errors: [], warnings: [], data: {} };

    if (target === 'ip') {
      const addrRaw = cell(raw, mapping.address);
      if (!addrRaw) {
        record.errors.push({ error_type: 'missing_ip', column_name: 'address', message: '缺少 IP 地址列或该行为空' });
      } else if (!isValidIp(addrRaw)) {
        record.errors.push({ error_type: 'invalid_ip', column_name: 'address', original_value: addrRaw, message: `IP 地址格式非法: ${addrRaw}` });
      } else {
        const normalized = normalizeIp(addrRaw);
        record.data.address = normalized;
        if (seenInFile.has(normalized)) {
          record.errors.push({ error_type: 'duplicate_in_file', column_name: 'address', original_value: addrRaw, message: `文件内重复: 与第 ${seenInFile.get(normalized)} 行相同 IP` });
        } else {
          seenInFile.set(normalized, rowNo);
        }
      }

      const macRaw = cell(raw, mapping.mac);
      if (macRaw) {
        try {
          record.data.mac = normalizeMac(macRaw);
        } catch {
          record.warnings.push({ error_type: 'invalid_mac', column_name: 'mac', original_value: macRaw, message: `MAC 格式可疑: ${macRaw}，将忽略该字段` });
        }
      }

      const statusRaw = cell(raw, mapping.business_status);
      if (statusRaw) {
        const mapped = mapStatus(statusRaw);
        if (mapped === undefined) {
          record.warnings.push({ error_type: 'unknown_status', column_name: 'business_status', original_value: statusRaw, message: `无法识别状态「${statusRaw}」，将置为 pending` });
          record.data.business_status = 'pending';
        } else {
          record.data.business_status = mapped;
        }
      } else {
        record.data.business_status = 'pending';
      }

      const subnetRaw = cell(raw, mapping.subnet_cidr);
      if (subnetRaw) {
        try {
          record.data.subnet_hint = cidrRange(subnetRaw).cidr;
        } catch (e) {
          record.warnings.push({ error_type: 'invalid_cidr', column_name: 'subnet_cidr', original_value: subnetRaw, message: `网段格式非法: ${subnetRaw}（${e.message}），将按最长前缀自动归属` });
        }
      }

      const branchRaw = cell(raw, mapping.branch);
      if (branchRaw) {
        const b = resolveBranch(branchRaw);
        if (!b) record.warnings.push({ error_type: 'unknown_branch', column_name: 'branch', original_value: branchRaw, message: `分支「${branchRaw}」不存在，将使用默认分支或不归属` });
        else record.data.branch_id = b.id;
      }
      if (record.data.branch_id === undefined && defaultBranchId) record.data.branch_id = defaultBranchId;

      record.data.description = cell(raw, mapping.description) || null;

      if (record.data.address) {
        const existing = db.prepare('SELECT id, business_status, mac FROM ip_ledger WHERE address = ?').get(record.data.address);
        if (existing) {
          const diffs = [];
          if (record.data.business_status && existing.business_status !== record.data.business_status) diffs.push(`状态 ${existing.business_status} → ${record.data.business_status}`);
          if (record.data.mac && existing.mac && existing.mac !== record.data.mac) diffs.push(`MAC ${existing.mac} → ${record.data.mac}`);
          if (diffs.length) {
            record.level = 'conflict';
            record.warnings.push({ error_type: 'ledger_conflict', column_name: 'address', original_value: record.data.address, message: `台账已存在且字段不一致（${diffs.join('；')}），确认导入将覆盖`, suggestion: '如需保留台账原值，请取消该行的导入' });
          } else {
            record.level = 'warning';
            record.warnings.push({ error_type: 'ledger_exists', column_name: 'address', message: '台账已存在该 IP，字段一致将仅刷新来源追溯' });
          }
        }
      }
    } else {
      const cidrRaw = cell(raw, mapping.cidr);
      if (!cidrRaw) {
        record.errors.push({ error_type: 'missing_cidr', column_name: 'cidr', message: '缺少网段列或该行为空' });
      } else {
        try {
          const r = cidrRange(cidrRaw);
          record.data.cidr = r.cidr;
          const dup = db.prepare('SELECT id FROM subnets WHERE cidr = ?').get(r.cidr);
          if (dup) {
            record.level = 'conflict';
            record.warnings.push({ error_type: 'subnet_exists', column_name: 'cidr', original_value: r.cidr, message: '网段已存在，导入将跳过该行', suggestion: '如需修改请在网段管理页面编辑' });
          }
          if (seenInFile.has(r.cidr)) {
            record.errors.push({ error_type: 'duplicate_in_file', column_name: 'cidr', message: `文件内重复: 与第 ${seenInFile.get(r.cidr)} 行相同网段` });
          } else {
            seenInFile.set(r.cidr, rowNo);
          }
        } catch (e) {
          record.errors.push({ error_type: 'invalid_cidr', column_name: 'cidr', original_value: cidrRaw, message: `网段格式非法: ${cidrRaw}（${e.message}）` });
        }
      }
      const vlanRaw = cell(raw, mapping.vlan);
      if (vlanRaw) {
        const n = Number(vlanRaw);
        if (!Number.isInteger(n) || n < 1 || n > 4094) record.warnings.push({ error_type: 'invalid_vlan', column_name: 'vlan', original_value: vlanRaw, message: `VLAN 非法: ${vlanRaw}，将忽略` });
        else record.data.vlan = n;
      }
      const gwRaw = cell(raw, mapping.gateway);
      if (gwRaw) {
        if (!isValidIp(gwRaw)) record.warnings.push({ error_type: 'invalid_gateway', column_name: 'gateway', original_value: gwRaw, message: `网关非法: ${gwRaw}，将忽略` });
        else record.data.gateway = normalizeIp(gwRaw);
      }
      const kindRaw = cell(raw, mapping.kind);
      if (kindRaw) {
        const k = String(kindRaw).trim().toLowerCase();
        record.data.kind = SUBNET_KINDS.includes(k) ? k : 'other';
      }
      record.data.purpose = cell(raw, mapping.purpose) || null;
      record.data.description = cell(raw, mapping.description) || null;
      const branchRaw = cell(raw, mapping.branch);
      if (branchRaw) {
        const b = resolveBranch(branchRaw);
        if (!b) record.warnings.push({ error_type: 'unknown_branch', column_name: 'branch', original_value: branchRaw, message: `分支「${branchRaw}」不存在` });
        else record.data.branch_id = b.id;
      }
      if (record.data.branch_id === undefined && defaultBranchId) record.data.branch_id = defaultBranchId;
    }

    if (record.errors.length) record.level = 'error';
    else if (record.warnings.length && record.level === 'ok') record.level = 'warning';
    result.counts[record.level] = (result.counts[record.level] || 0) + 1;
    result.rows.push(record);
  }
  return result;
}

export function extractRows(buf, fileType, sheetName) {
  const sheets = parseImportFile(buf, fileType);
  if (!sheets.length) throw new ImportError('文件中没有可解析的工作表');
  let sheet = sheets[0];
  if (sheetName) {
    sheet = sheets.find((s) => s.name === sheetName);
    if (!sheet) throw new ImportError(`工作表「${sheetName}」不存在，可选: ${sheets.map((s) => s.name).join(', ')}`);
  }
  if (sheet.rows.length < 2) throw new ImportError('工作表至少需要表头和一行数据');
  return { sheet, sheets: sheets.map((s) => ({ name: s.name, rowCount: s.rows.length })) };
}

export function getBatch(batchId) {
  return db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) || null;
}

export function writeBatchErrors(batchId, precheck) {
  db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(batchId);
  const ins = db.prepare(`
    INSERT INTO import_errors (batch_id, row_no, level, error_type, column_name, original_value, message, suggestion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of precheck.rows) {
    for (const e of [...r.errors, ...r.warnings]) {
      ins.run(batchId, r.row_no, r.errors.length ? 'error' : 'warning', e.error_type, e.column_name || null, e.original_value || null, e.message, e.suggestion || null);
    }
  }
}

export function commitBatch(batchId, { target = 'ip', overwrite = false } = {}) {
  const batch = getBatch(batchId);
  if (!batch) throw new ImportError('导入批次不存在', 404, 'BATCH_NOT_FOUND');
  if (batch.status === 'committed') throw new ImportError('该批次已入库，不能重复提交', 409, 'BATCH_COMMITTED');
  const buf = fs.readFileSync(batch.stored_path);
  const { sheet } = extractRows(buf, batch.file_type, batch.sheet);
  const header = sheet.rows[0];
  const mapping = autoMapColumns(header, target);
  if (target === 'ip' && mapping.address === undefined) throw new ImportError('无法识别 IP 地址列，请检查表头');
  if (target === 'subnet' && mapping.cidr === undefined) throw new ImportError('无法识别网段列，请检查表头');
  const precheck = precheckBatch({ rows: sheet.rows.slice(1), mapping, target, defaultBranchId: batch.branch_id });
  writeBatchErrors(batchId, precheck);

  const stats = { inserted: 0, updated: 0, skipped: 0 };
  const t = now();
  const txn = db.transaction(() => {
    for (const r of precheck.rows) {
      if (r.level === 'error') { stats.skipped++; continue; }
      if (r.level === 'conflict' && !overwrite) { stats.skipped++; continue; }
      if (target === 'ip') {
        const existing = db.prepare('SELECT id FROM ip_ledger WHERE address = ?').get(r.data.address);
        upsertLedgerRow(r, batchId);
        if (existing) stats.updated++; else stats.inserted++;
      } else {
        if (r.level === 'conflict') { stats.skipped++; continue; }
        insertSubnetRow(r, batchId);
        stats.inserted++;
      }
    }
    db.prepare(`UPDATE import_batches SET status = 'committed', stats_json = ?, committed_at = ? WHERE id = ?`)
      .run(JSON.stringify(stats), t, batchId);
  });
  txn();
  return { batch_id: batchId, stats, counts: precheck.counts };
}

function upsertLedgerRow(r, batchId) {
  const { address, business_status = 'pending', mac = null, branch_id = null, description = null } = r.data;
  const buf = toBuffer(address);
  const family = buf.length === 4 ? 4 : 6;
  const subnet = longestPrefixMatch(address).best;
  const t = now();
  const existing = db.prepare('SELECT id FROM ip_ledger WHERE address = ?').get(address);
  if (existing) {
    db.prepare(`
      UPDATE ip_ledger SET family = ?, value = ?, subnet_id = ?, business_status = ?, mac = ?, branch_id = ?,
        description = ?, source = 'import', import_batch_id = ?, import_row = ?, updated_at = ?
      WHERE id = ?
    `).run(family, buf, subnet?.id ?? null, business_status, mac, branch_id, description, batchId, r.row_no, t, existing.id);
  } else {
    db.prepare(`
      INSERT INTO ip_ledger (address, family, value, subnet_id, business_status, mac, branch_id, description, source, import_batch_id, import_row, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
    `).run(address, family, buf, subnet?.id ?? null, business_status, mac, branch_id, description, batchId, r.row_no, t, t);
  }
}

function insertSubnetRow(r, batchId) {
  const range = cidrRange(r.data.cidr);
  const t = now();
  db.prepare(`
    INSERT INTO subnets (cidr, family, prefix, network_start, network_end, purpose, kind, branch_id, vlan, gateway, description, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(range.cidr, range.family, range.prefix, range.startBuf, range.endBuf,
    r.data.purpose, r.data.kind ?? 'other', r.data.branch_id ?? null, r.data.vlan ?? null,
    r.data.gateway ?? null, r.data.description, t, t);
}

export function listBatches({ limit = 50, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function batchErrors(batchId) {
  return db.prepare('SELECT * FROM import_errors WHERE batch_id = ? ORDER BY row_no').all(batchId);
}

export function batchTraces(batchId) {
  return db.prepare('SELECT id, address, business_status, mac, import_row FROM ip_ledger WHERE import_batch_id = ? ORDER BY import_row').all(batchId);
}

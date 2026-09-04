import { db } from '../db.js';
import { jsonCol, normalizeMac } from '../domain/util.js';
import { toBuffer, bufferToBigInt, bigIntToBuffer, fromBuffer } from '../domain/ip.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededMac(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const rnd = mulberry32(h >>> 0);
  const bytes = [0x02, 0x42];
  for (let i = 0; i < 4; i++) bytes.push(Math.floor(rnd() * 256));
  return normalizeMac(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
}

export function getSimConfig(branchId) {
  const row = db.prepare('SELECT config_json FROM sim_world WHERE branch_id = ?').get(branchId);
  return row ? jsonCol(row.config_json, {}) : {};
}

export function setSimConfig(branchId, config) {
  db.prepare(`
    INSERT INTO sim_world (branch_id, config_json) VALUES (?, ?)
    ON CONFLICT(branch_id) DO UPDATE SET config_json = excluded.config_json
  `).run(branchId, JSON.stringify(config));
}

const TERMINALS = ['PC', '笔记本', '手机', '打印机', '摄像头', '服务器', 'IP话机'];
const USERS = ['zhang.wei', 'li.na', 'wang.fang', 'chen.jun', 'liu.yang', 'zhao.lei', 'sun.min', 'zhou.tao'];

function branchLedgerEndpoints(branchId) {
  return db.prepare(`
    SELECT address, mac FROM ip_ledger
    WHERE branch_id = ? AND business_status = 'occupied' AND mac IS NOT NULL AND mac != ''
  `).all(branchId);
}

export function buildBranchWorld(branchId, { now = Date.now() } = {}) {
  const cfg = getSimConfig(branchId);
  const offline = cfg.offline === true;
  const rnd = mulberry32(branchId * 7919 + 13);
  const endpoints = new Map();

  for (const row of branchLedgerEndpoints(branchId)) {
    endpoints.set(row.address, {
      ip: row.address,
      mac: normalizeMac(row.mac),
      username: USERS[Math.floor(rnd() * USERS.length)],
      terminal: TERMINALS[Math.floor(rnd() * TERMINALS.length)],
      login_time: now - Math.floor(rnd() * 6 * 3600 * 1000),
      port: `GE0/0/${1 + Math.floor(rnd() * 24)}`,
      vlan: String(10 + Math.floor(rnd() * 40)),
    });
  }

  for (const m of cfg.mismatches || []) {
    if (endpoints.has(m.ip)) {
      endpoints.get(m.ip).mac = normalizeMac(m.field_mac || seededMac(`${branchId}:${m.ip}:alt`));
    }
  }

  for (const ip of cfg.no_evidence || []) {
    endpoints.delete(ip);
  }

  for (const g of cfg.ghosts || []) {
    endpoints.set(g.ip, {
      ip: g.ip,
      mac: normalizeMac(g.mac || seededMac(`${branchId}:${g.ip}`)),
      username: g.username || 'unknown',
      terminal: g.terminal || '未知终端',
      login_time: now - Math.floor(rnd() * 3600 * 1000),
      port: `GE0/0/${1 + Math.floor(rnd() * 24)}`,
      vlan: String(10 + Math.floor(rnd() * 40)),
    });
  }

  const extra = [];
  const extraCount = cfg.extra_online || 0;
  for (let i = 0; i < extraCount; i++) {
    const buf = toBuffer(cfg.extra_base_ip || '10.250.0.1');
    const v = bufferToBigInt(buf) + BigInt(i);
    const ip = fromBuffer(bigIntToBuffer(v, buf.length));
    extra.push({
      ip,
      mac: seededMac(`${branchId}:extra:${i}`),
      username: USERS[i % USERS.length],
      terminal: TERMINALS[i % TERMINALS.length],
      login_time: now - Math.floor(rnd() * 3600 * 1000),
      port: `GE0/0/${1 + (i % 24)}`,
      vlan: String(10 + (i % 40)),
    });
  }

  return { offline, endpoints: [...endpoints.values()].concat(extra) };
}

import crypto from 'node:crypto';
import { buildBranchWorld } from '../simulator.js';
import { normalizeMac, jsonCol } from '../../domain/util.js';
import { ipInRange } from '../../domain/ip.js';
import { config } from '../../config.js';

export function computeAuth(sharedSecret) {
  const random = crypto.randomBytes(8).toString('hex');
  const md5 = crypto.createHash('md5').update(sharedSecret + random).digest('hex');
  return { random, md5 };
}

export function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

export function mapError(code, message) {
  const text = String(message || '');
  if (text.includes('只支持本地请求') || code === 4031) return { category: 'network_scope', message: '只支持本地请求：采集器必须部署在 AC 本地管理网络' };
  if (text.includes('未启用') || text.includes('Restful') || code === 4032) return { category: 'config', message: 'Restful 服务未启用，请在 AC 开放接口配置中启用' };
  if (text.includes('白名单') || code === 4033) return { category: 'whitelist', message: '请求方 IP 不在白名单，请将采集器 IP 加入 AC 白名单' };
  if (text.includes('权限') || text.includes('校验') || code === 4010) return { category: 'auth', message: '权限校验失败，请检查共享密钥配置' };
  if (code === 1 || text.includes('获取数据失败')) return { category: 'business', message: '业务失败：接口返回 code=1，不得将空数据视为无在线用户' };
  return { category: 'unknown', message: text || '未知错误' };
}

export class SangforAcAdapter {
  constructor(device, { transport = 'sim', baseUrl = null, sharedSecret = null } = {}) {
    this.device = device;
    this.transport = transport;
    this.baseUrl = baseUrl || (device.mgmt_ip ? `http://${device.mgmt_ip}:9999` : null);
    this.sharedSecret = sharedSecret;
  }

  async testConnection() {
    const v = await this.getVersion();
    return { ok: true, version: v };
  }

  async getVersion() {
    return this.request('/v1/status/version', 'GET', {});
  }

  async getHealthStats() {
    const [online, sessions] = await Promise.all([
      this.request('/v1/status/online-user', 'GET', {}),
      this.request('/v1/status/session-num', 'GET', {}),
    ]);
    return { online_users: online, session_num: sessions };
  }

  async queryOnlineUsers(filter = {}) {
    return this.request('/v1/online-users?_method=GET', 'POST', { filter });
  }

  async queryIpMacBinding(search) {
    return this.request(`/v1/ipmac-bindinfo?search=${encodeURIComponent(search)}`, 'GET', {});
  }

  async request(path, method, body) {
    if (this.transport === 'sim') return this.simulate(path, method, body);
    return this.httpRequest(path, method, body);
  }

  async httpRequest(path, method, body) {
    const { random, md5 } = computeAuth(this.sharedSecret);
    const headers = { 'Accept-Language': 'zh-CN' };
    let url = `${this.baseUrl}${path}`;
    const init = { method, headers };
    if (method === 'GET') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}random=${encodeURIComponent(random)}&md5=${md5}`;
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ random, md5, ...body });
    }
    const resp = await fetch(url, init);
    const payload = await resp.json().catch(() => null);
    if (!payload) {
      const err = mapError(resp.status, `HTTP ${resp.status}`);
      throw Object.assign(new Error(err.message), { category: err.category });
    }
    if (payload.code && payload.code !== 0) {
      const err = mapError(payload.code, payload.message || payload.msg);
      throw Object.assign(new Error(err.message), { category: err.category, code: payload.code });
    }
    return payload.data ?? payload;
  }

  simulate(path, method, body) {
    if (this.device.status === 'offline' || !this.device.enabled) {
      throw Object.assign(new Error('AC 设备不可达（模拟离线）'), { category: 'network' });
    }
    const world = buildBranchWorld(this.device.branch_id);
    if (world.offline) {
      throw Object.assign(new Error('AC 设备不可达（模拟离线）'), { category: 'network' });
    }
    if (path.startsWith('/v1/status/version')) {
      return { version: this.device.software_version || 'AC-12.0.8 (sim)' };
    }
    if (path.startsWith('/v1/status/online-user')) {
      return { count: world.endpoints.length };
    }
    if (path.startsWith('/v1/status/session-num')) {
      return { count: world.endpoints.length * 37 };
    }
    if (path.startsWith('/v1/online-users')) {
      let list = world.endpoints;
      const filter = body?.filter || {};
      if (filter.type === 'ip') {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value];
        list = list.filter((e) => values.some((v) => (String(v).includes('/') ? ipInRange(e.ip, v) : e.ip === v)));
      } else if (filter.type === 'mac') {
        list = list.filter((e) => e.mac === normalizeMac(filter.value));
      } else if (filter.type === 'user') {
        list = list.filter((e) => e.username === filter.value);
      }
      const total = list.length;
      const capped = list.slice(0, config.acOnlineUserCap);
      return {
        count: total,
        users: capped.map((e) => ({
          name: e.username,
          show_name: e.username,
          father_path: '/默认组织',
          ip: e.ip,
          mac: e.mac,
          terminal: e.terminal,
          authway: 'password',
          login_time: Math.floor(e.login_time / 1000),
          online_time: Math.floor((Date.now() - e.login_time) / 1000),
        })),
      };
    }
    if (path.startsWith('/v1/ipmac-bindinfo')) {
      const search = decodeURIComponent(path.split('search=')[1] || '');
      const list = world.endpoints.filter((e) => e.ip === search || e.mac === normalizeMac(search));
      return { bindings: list.map((e) => ({ ip: e.ip, mac: e.mac, desc: 'sim-static-binding' })) };
    }
    throw Object.assign(new Error(`未知接口: ${path}`), { category: 'unknown' });
  }
}

export function normalizeAcUser(u) {
  return {
    ip: u.ip,
    mac: normalizeMac(u.mac),
    username: u.name || u.show_name || null,
    terminal: u.terminal || null,
    login_time: normalizeTimestamp(u.login_time),
    online_seconds: Number(u.online_time) || 0,
  };
}

export { jsonCol };

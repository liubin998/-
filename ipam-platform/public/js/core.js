import { render } from './router.js';

export const STATUS_ZH = { free: '空闲', occupied: '已占用', reserved: '预留', released: '已释放', conflict: '冲突', unavailable: '不可用', pending: '待定' };
export const STATUS_BADGE = { free: 'b-green', occupied: 'b-blue', reserved: 'b-purple', released: 'b-gray', conflict: 'b-red', unavailable: 'b-gray', pending: 'b-amber' };
export const FIELD_STATUS_ZH = { confirmed_use: '明确使用', possible_use: '可能使用', not_found: '未发现使用', undetermined: '无法判断', ledger_conflict: '台账冲突', incomplete: '证据不足' };
export const FIELD_STATUS_BADGE = { confirmed_use: 'b-green', possible_use: 'b-blue', not_found: 'b-gray', undetermined: 'b-amber', ledger_conflict: 'b-red', incomplete: 'b-amber' };
export const SUBNET_STATUS_ZH = { active: '在用', planned: '规划中', retired: '已退役' };
export const KIND_ZH = { lan: '局域网', wan: '广域网', mgmt: '管理网', wifi: '无线', cloud: '云上', p2p: '互联', reserved: '预留', other: '其他' };
export const TICKET_STATUS_ZH = { open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
export const TICKET_STATUS_BADGE = { open: 'b-red', in_progress: 'b-amber', resolved: 'b-green', closed: 'b-gray' };
export const SEVERITY_ZH = { low: '低', medium: '中', high: '高', critical: '严重' };
export const DEVICE_STATUS_ZH = { online: '在线', offline: '离线', error: '异常', unknown: '未知' };
export const DEVICE_STATUS_BADGE = { online: 'b-green', offline: 'b-red', error: 'b-amber', unknown: 'b-gray' };
export const ROLE_ZH = { hq_admin: '总部管理员', branch_admin: '分支管理员', maintainer: '运维人员', viewer: '只读用户', auditor: '审计员' };
export const LEVEL_BADGE = { ok: 'b-green', warning: 'b-amber', error: 'b-red', conflict: 'b-purple' };
export const LEVEL_ZH = { ok: '正常', warning: '警告', error: '错误', conflict: '冲突' };

export const state = {
  token: localStorage.getItem('ipam_token') || null,
  me: null,
  branches: [],
};

export function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (raw) delete headers['Content-Type'];
  const res = await fetch('/api' + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && state.token) {
    logout(false);
    throw { status: 401, message: '会话已过期，请重新登录' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: res.status, message: data.message || data.error || '请求失败', ...data };
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function badge(text, cls) { return `<span class="badge ${cls || 'b-gray'}">${esc(text)}</span>`; }
export function fmtTime(t) { return t ? String(t).replace('T', ' ').slice(0, 19) : '-'; }
export function branchName(id) { const b = state.branches.find((x) => x.id === id); return b ? b.name : (id == null ? '未指定' : `#${id}`); }

export function logout(callApi) {
  if (callApi && state.token) api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = null; state.me = null;
  localStorage.removeItem('ipam_token');
  location.hash = '#/login';
  render();
}

export function hasCap(cap) { return state.me && Array.isArray(state.me.caps) && state.me.caps.includes(cap); }

export async function ensureBranches() {
  if (!state.branches.length) {
    try { const r = await api('/admin/branches'); state.branches = r.branches || []; } catch { state.branches = []; }
  }
}

import { state, api, esc, badge, toast, logout, STATUS_ZH, STATUS_BADGE, DEVICE_STATUS_ZH, DEVICE_STATUS_BADGE, TICKET_STATUS_ZH, TICKET_STATUS_BADGE } from './core.js';
import { shell } from './ui.js';
import { viewDashboard } from './views/dashboard.js';
import { viewSubnets, viewSubnet } from './views/subnets.js';
import { viewIps, viewIp } from './views/ips.js';
import { viewDevices } from './views/devices.js';
import { viewTickets, viewTicket } from './views/tickets.js';
import { viewImport } from './views/import.js';
import { viewAudit } from './views/audit.js';
import { viewAi } from './views/ai.js';
import { viewAdmin } from './views/admin.js';

const $app = document.getElementById('app');

export function render() {
  const hash = location.hash || '#/dashboard';
  const [route, ...rest] = hash.replace(/^#\//, '').split('/');
  if (!state.token) { renderLogin(); return; }
  if (!state.me) {
    api('/auth/me').then((r) => { state.me = r.user; render(); }).catch(() => logout(false));
    $app.innerHTML = `<div class="content muted">加载中…</div>`;
    return;
  }
  const views = {
    login: renderLogin, dashboard: viewDashboard, subnets: () => rest.length ? viewSubnet(decodeURIComponent(rest[0])) : viewSubnets(),
    ips: () => rest.length ? viewIp(decodeURIComponent(rest[0])) : viewIps(),
    devices: viewDevices, tickets: () => rest.length ? viewTicket(rest[0]) : viewTickets(),
    import: viewImport, audit: viewAudit, ai: viewAi, admin: viewAdmin,
  };
  const fn = views[route] || viewDashboard;
  Promise.resolve(fn()).then((html) => {
    if (!state.token) return;
    $app.innerHTML = route === 'login' ? html : shell(html);
    bindGlobalSearch();
  }).catch((e) => { $app.innerHTML = shell(`<div class="card err">${esc(e.message || '加载失败')}</div>`); });
}

export function bindGlobalSearch() {
  const el = document.getElementById('globalSearch');
  if (!el) return;
  el.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = el.value.trim();
    if (!q) return;
    try {
      const r = await api('/search?q=' + encodeURIComponent(q));
      const seg = (title, rows, html) => rows.length ? `<h2>${title}（${rows.length}）</h2><div class="card">${html(rows)}</div>` : '';
      const content = `
        ${seg('IP 台账', r.ips, (rows) => `<table><tr><th>地址</th><th>状态</th><th>MAC</th><th>描述</th></tr>${rows.map((x) => `<tr><td><a href="#/ips/${encodeURIComponent(x.address)}">${esc(x.address)}</a></td><td>${badge(STATUS_ZH[x.business_status] || x.business_status, STATUS_BADGE[x.business_status])}</td><td>${esc(x.mac || '-')}</td><td>${esc(x.description || '')}</td></tr>`).join('')}</table>`)}
        ${seg('网段', r.subnets, (rows) => `<table><tr><th>CIDR</th><th>用途</th><th>描述</th></tr>${rows.map((x) => `<tr><td><a href="#/subnets/${x.id}">${esc(x.cidr)}</a></td><td>${esc(x.purpose || '-')}</td><td>${esc(x.description || '')}</td></tr>`).join('')}</table>`)}
        ${seg('设备', r.devices, (rows) => `<table><tr><th>名称</th><th>厂商</th><th>状态</th></tr>${rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.vendor)}</td><td>${badge(DEVICE_STATUS_ZH[x.status] || x.status, DEVICE_STATUS_BADGE[x.status])}</td></tr>`).join('')}</table>`)}
        ${seg('协同事项', r.tickets, (rows) => `<table><tr><th>标题</th><th>类型</th><th>状态</th></tr>${rows.map((x) => `<tr><td><a href="#/tickets/${x.id}">${esc(x.title)}</a></td><td>${esc(x.type)}</td><td>${badge(TICKET_STATUS_ZH[x.status] || x.status, TICKET_STATUS_BADGE[x.status])}</td></tr>`).join('')}</table>`)}
        ${(!r.ips.length && !r.subnets.length && !r.devices.length && !r.tickets.length) ? '<div class="card muted">未找到匹配结果</div>' : ''}`;
      $app.innerHTML = shell(`<h1>搜索："${esc(q)}"</h1>${content}`);
      bindGlobalSearch();
    } catch (err) { toast(err.message, true); }
  });
}

export function renderLogin() {
  $app.innerHTML = `<div class="login-wrap"><div class="login-box">
    <h1>IP 资产管理平台</h1>
    <p>企业 IP 地址与网段资产管理 · 事实台账 + 现场观测 + 规则引擎诊断</p>
    <input id="lu" placeholder="用户名" autocomplete="username" />
    <input id="lp" type="password" placeholder="密码" autocomplete="current-password" />
    <button class="btn primary" id="lbtn">登 录</button>
    <div id="lerr" class="err" style="margin-top:10px;font-size:13px"></div>
  </div></div>`;
  const doLogin = async () => {
    const btn = document.getElementById('lbtn');
    btn.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: document.getElementById('lu').value.trim(), password: document.getElementById('lp').value } });
      state.token = r.token; state.me = r.user;
      localStorage.setItem('ipam_token', r.token);
      location.hash = '#/dashboard';
      render();
    } catch (e) {
      document.getElementById('lerr').textContent = e.message || '登录失败';
      btn.disabled = false;
    }
  };
  document.getElementById('lbtn').addEventListener('click', doLogin);
  document.getElementById('lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

import { state, esc, toast, hasCap, ROLE_ZH } from './core.js';

export function nav() {
  const items = [
    ['#/dashboard', '仪表盘', 'view'],
    ['#/subnets', '网段管理', 'view'],
    ['#/ips', 'IP 台账', 'view'],
    ['#/devices', '设备与采集', 'view'],
    ['#/tickets', '协同事项', 'view'],
    ['#/import', '导入中心', 'import'],
    ['#/audit', '审计日志', 'audit_view'],
    ['#/ai', 'AI 查询助手', 'view'],
  ];
  if (state.me && state.me.is_hq_admin) items.push(['#/admin', '系统管理', 'user']);
  const seg = '#/' + ((location.hash || '#/dashboard').slice(2).split(/[/?]/)[0] || 'dashboard');
  return items
    .filter(([, , cap]) => hasCap(cap))
    .map(([href, label]) => `<a href="${href}" class="${href === seg ? 'active' : ''}">${label}</a>`)
    .join('');
}

export function shell(content) {
  return `<div class="layout">
    <div class="sidebar">
      <div class="brand">企业 IP 地址与<br>网段资产管理平台</div>
      <nav>${nav()}</nav>
      <div class="userbox">
        ${esc(state.me ? state.me.display_name || state.me.username : '')}
        <div class="muted">${esc(state.me ? ROLE_ZH[state.me.role] || state.me.role : '')}</div>
        <a style="color:#93c5fd" onclick="window.__logout()">退出登录</a>
      </div>
    </div>
    <div class="main">
      <div class="topbar">
        <input type="search" id="globalSearch" placeholder="全局搜索：IP / 网段 / MAC / 设备 / 事项…" />
        <span class="muted">权限范围：${state.me && state.me.is_hq_admin ? '全部数据' : (state.me ? `${(state.me.branch_ids || []).length} 个分支` : '')}</span>
      </div>
      <div class="content">${content}</div>
    </div>
  </div>`;
}

export function modal(title, bodyHtml, onSubmit, submitText) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <h3>${esc(title)}</h3>
    <div class="modal-body">${bodyHtml}</div>
    ${submitText ? `<div class="actions">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn primary" data-act="ok">${esc(submitText)}</button>
    </div>` : ''}
  </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) { mask.remove(); return; }
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'cancel') mask.remove();
    if (act === 'ok') {
      Promise.resolve(onSubmit(mask)).then((keep) => { if (!keep) mask.remove(); })
        .catch((err) => toast(err.message || '操作失败', true));
    }
  });
  return mask;
}

export function field(label, inner) { return `<div class="field"><label>${esc(label)}</label>${inner}</div>`; }
export function fv(mask, name) { const el = mask.querySelector(`[name="${name}"]`); return el ? el.value : ''; }
export function branchOptions(sel) {
  return `<option value="">未指定</option>` + state.branches.map((b) => `<option value="${b.id}" ${sel == b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
}

export function pager(page, total, limit, onGo) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const wrapId = 'pg' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const el = document.getElementById(wrapId);
    if (el) el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => onGo(Number(b.dataset.page))));
  }, 0);
  return `<div class="pager" id="${wrapId}">
    <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="muted">第 ${page} / ${pages} 页，共 ${total} 条</span>
    <button class="btn sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
  </div>`;
}

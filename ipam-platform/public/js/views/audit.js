import { api, esc, badge, fmtTime, branchName } from '../core.js';
import { pager } from '../ui.js';

export async function viewAudit() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const page = Number(q.get('page')) || 1;
  const qs = new URLSearchParams({ page, limit: 50 });
  for (const k of ['action', 'entity_type', 'username']) if (q.get(k)) qs.set(k, q.get(k));
  const r = await api('/audit/logs?' + qs.toString());
  const setFilter = (k, v) => {
    const cur = new URLSearchParams(location.hash.split('?')[1] || '');
    if (v) cur.set(k, v); else cur.delete(k);
    cur.delete('page');
    location.hash = '#/audit?' + cur.toString();
  };
  setTimeout(() => {
    document.getElementById('faction')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') setFilter('action', e.target.value.trim()); });
    document.getElementById('fuser')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') setFilter('username', e.target.value.trim()); });
    document.getElementById('fentity')?.addEventListener('change', (e) => setFilter('entity_type', e.target.value));
  }, 0);
  return `
    <h1>审计日志</h1>
    <div class="toolbar">
      <input id="faction" placeholder="操作类型，如 login / ip.update" value="${esc(q.get('action') || '')}" />
      <input id="fuser" placeholder="用户名" value="${esc(q.get('username') || '')}" />
      <select id="fentity"><option value="">全部对象类型</option>${['ip', 'subnet', 'device', 'ticket', 'user', 'branch', 'import_batch', 'auth', 'config', 'collect'].map((t) => `<option value="${t}" ${q.get('entity_type') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    </div>
    <table>
      <tr><th>时间</th><th>用户</th><th>操作</th><th>对象</th><th>分支</th><th>结果</th><th>变更详情</th></tr>
      ${r.items.map((a) => `<tr>
        <td style="white-space:nowrap">${fmtTime(a.created_at)}</td>
        <td>${esc(a.username || '-')}</td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.entity_type || '-')} ${a.entity_id != null ? '#' + esc(a.entity_id) : ''}</td>
        <td>${esc(branchName(a.branch_id))}</td>
        <td>${a.result === 'fail' || a.result === 'denied' ? badge('失败', 'b-red') : badge('成功', 'b-green')}</td>
        <td class="muted" style="max-width:380px;overflow:hidden;text-overflow:ellipsis">${esc(a.after ? JSON.stringify(a.after).slice(0, 160) : (a.reason || '-'))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无日志</td></tr>'}
    </table>
    ${pager(r.page, r.total, r.limit, (p) => { const cur = new URLSearchParams(location.hash.split('?')[1] || ''); cur.set('page', p); location.hash = '#/audit?' + cur.toString(); })}`;
}

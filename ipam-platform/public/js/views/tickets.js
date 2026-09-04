import { api, toast, esc, badge, fmtTime, branchName, hasCap, ensureBranches, TICKET_STATUS_ZH, TICKET_STATUS_BADGE, SEVERITY_ZH } from '../core.js';
import { modal, field, fv, branchOptions, pager } from '../ui.js';
import { render } from '../router.js';

export async function viewTickets() {
  await ensureBranches();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const page = Number(q.get('page')) || 1;
  const qs = new URLSearchParams({ page, limit: 20 });
  for (const k of ['status', 'severity', 'type', 'branch_id']) if (q.get(k)) qs.set(k, q.get(k));
  const r = await api('/tickets?' + qs.toString());
  const setFilter = (k, v) => {
    const cur = new URLSearchParams(location.hash.split('?')[1] || '');
    if (v) cur.set(k, v); else cur.delete(k);
    cur.delete('page');
    location.hash = '#/tickets?' + cur.toString();
  };
  setTimeout(() => {
    ['fstatus', 'fsev', 'ftype', 'fbranch'].forEach((id) => {
      const map = { fstatus: 'status', fsev: 'severity', ftype: 'type', fbranch: 'branch_id' };
      document.getElementById(id)?.addEventListener('change', (e) => setFilter(map[id], e.target.value));
    });
    document.getElementById('addTicket')?.addEventListener('click', addTicketModal);
  }, 0);
  return `
    <h1>协同事项</h1>
    <div class="toolbar">
      <select id="fstatus"><option value="">全部状态</option>${Object.keys(TICKET_STATUS_ZH).map((k) => `<option value="${k}" ${q.get('status') === k ? 'selected' : ''}>${TICKET_STATUS_ZH[k]}</option>`).join('')}</select>
      <select id="fsev"><option value="">全部级别</option>${Object.keys(SEVERITY_ZH).map((k) => `<option value="${k}" ${q.get('severity') === k ? 'selected' : ''}>${SEVERITY_ZH[k]}</option>`).join('')}</select>
      <select id="fbranch">${branchOptions(q.get('branch_id'))}</select>
      ${hasCap('conflict') ? '<button class="btn primary" id="addTicket">新建事项</button>' : ''}
    </div>
    <table>
      <tr><th>#</th><th>标题</th><th>类型</th><th>级别</th><th>状态</th><th>IP</th><th>分支</th><th>创建时间</th></tr>
      ${r.items.map((t) => `<tr>
        <td>${t.id}</td>
        <td><a href="#/tickets/${t.id}">${esc(t.title)}</a></td>
        <td>${esc(t.type)}</td>
        <td>${badge(SEVERITY_ZH[t.severity] || t.severity, t.severity === 'critical' || t.severity === 'high' ? 'b-red' : 'b-amber')}</td>
        <td>${badge(TICKET_STATUS_ZH[t.status] || t.status, TICKET_STATUS_BADGE[t.status])}</td>
        <td>${t.ip ? `<a href="#/ips/${encodeURIComponent(t.ip)}">${esc(t.ip)}</a>` : '-'}</td>
        <td>${esc(branchName(t.branch_id))}</td>
        <td>${fmtTime(t.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无协同事项</td></tr>'}
    </table>
    ${pager(r.page, r.total, r.limit, (p) => { const cur = new URLSearchParams(location.hash.split('?')[1] || ''); cur.set('page', p); location.hash = '#/tickets?' + cur.toString(); })}`;
}

function addTicketModal() {
  modal('新建协同事项', `
    ${field('标题 *', '<input name="title" />')}
    ${field('类型', `<select name="type"><option value="unregistered_use">疑似未登记占用</option><option value="idle_occupied">闲置/占用无证据</option><option value="ip_conflict_multi_mac">IP 冲突（多 MAC）</option><option value="mac_mismatch">台账 MAC 与现场不一致</option><option value="manual">人工事项</option></select>`)}
    ${field('级别', `<select name="severity"><option value="low">低</option><option value="medium" selected>中</option><option value="high">高</option><option value="critical">严重</option></select>`)}
    ${field('关联 IP', '<input name="ip" placeholder="可选" />')}
    ${field('分支', `<select name="branch_id">${branchOptions()}</select>`)}
    ${field('描述', '<textarea name="detail" rows="3"></textarea>')}
  `, async (mask) => {
    await api('/tickets', { method: 'POST', body: { title: fv(mask, 'title'), type: fv(mask, 'type'), severity: fv(mask, 'severity'), ip: fv(mask, 'ip') || null, branch_id: fv(mask, 'branch_id') || null, detail: fv(mask, 'detail') || null } });
    toast('事项已创建');
    render();
  }, '创建');
}

export async function viewTicket(id) {
  await ensureBranches();
  const r = await api('/tickets/' + id);
  const t = r.ticket;
  const comments = r.comments || [];
  setTimeout(() => {
    document.getElementById('tStatus')?.addEventListener('change', async (e) => {
      try { await api('/tickets/' + id, { method: 'PATCH', body: { status: e.target.value } }); toast('状态已更新'); render(); } catch (err) { toast(err.message, true); render(); }
    });
    document.getElementById('cSubmit')?.addEventListener('click', async () => {
      const text = document.getElementById('cText').value.trim();
      if (!text) return;
      try { await api(`/tickets/${id}/comments`, { method: 'POST', body: { content: text } }); render(); } catch (err) { toast(err.message, true); }
    });
  }, 0);
  return `
    <h1><a href="#/tickets">协同事项</a> / #${t.id} ${esc(t.title)} ${badge(TICKET_STATUS_ZH[t.status] || t.status, TICKET_STATUS_BADGE[t.status])}</h1>
    <div class="card">
      <div class="kv">
        <span class="k">类型</span><span>${esc(t.type)}</span>
        <span class="k">级别</span><span>${badge(SEVERITY_ZH[t.severity] || t.severity, t.severity === 'critical' || t.severity === 'high' ? 'b-red' : 'b-amber')}</span>
        <span class="k">关联 IP</span><span>${t.ip ? `<a href="#/ips/${encodeURIComponent(t.ip)}">${esc(t.ip)}</a>` : '-'}</span>
        <span class="k">分支</span><span>${esc(branchName(t.branch_id))}</span>
        <span class="k">去重键</span><span class="muted">${esc(t.ticket_key || '-')}</span>
        <span class="k">描述</span><span>${esc(t.detail ? (typeof t.detail === 'string' ? t.detail : JSON.stringify(t.detail)) : '-')}</span>
        <span class="k">创建 / 更新</span><span>${fmtTime(t.created_at)} / ${fmtTime(t.updated_at)}</span>
      </div>
      ${hasCap('conflict') ? `<div class="toolbar" style="margin-top:14px">
        <label class="muted">更新状态：</label>
        <select id="tStatus">${Object.keys(TICKET_STATUS_ZH).map((k) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${TICKET_STATUS_ZH[k]}</option>`).join('')}</select>
      </div>` : ''}
    </div>
    <div class="card"><h2 style="margin-top:0">处理记录（${comments.length}）</h2>
      ${comments.map((c) => `<div style="border-bottom:1px solid var(--border);padding:8px 0">
        <div><strong>${esc(c.username || ('用户#' + c.user_id))}</strong> <span class="muted">${fmtTime(c.created_at)}</span></div>
        <div style="margin-top:4px">${esc(c.content)}</div>
      </div>`).join('') || '<p class="muted">暂无记录</p>'}
      <div class="toolbar" style="margin-top:12px">
        <input id="cText" placeholder="添加处理记录…" style="flex:1" />
        <button class="btn primary" id="cSubmit">提交</button>
      </div>
    </div>`;
}

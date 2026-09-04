import { api, toast, esc, badge, fmtTime, branchName, hasCap, ensureBranches, STATUS_ZH, STATUS_BADGE, FIELD_STATUS_ZH, FIELD_STATUS_BADGE } from '../core.js';
import { modal, field, fv, branchOptions, pager } from '../ui.js';
import { render } from '../router.js';

export async function viewIps() {
  await ensureBranches();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const page = Number(q.get('page')) || 1;
  const qs = new URLSearchParams({ page, limit: 20 });
  for (const k of ['subnet_id', 'branch_id', 'status', 'q']) if (q.get(k)) qs.set(k, q.get(k));
  const r = await api('/ips?' + qs.toString());
  const subnetsR = await api('/subnets?page=1&limit=200');
  const setFilter = (k, v) => {
    const cur = new URLSearchParams(location.hash.split('?')[1] || '');
    if (v) cur.set(k, v); else cur.delete(k);
    cur.delete('page');
    location.hash = '#/ips?' + cur.toString();
  };
  setTimeout(() => {
    const bind = (id, key) => document.getElementById(id)?.addEventListener('change', (e) => setFilter(key, e.target.value));
    bind('fsubnet', 'subnet_id'); bind('fbranch', 'branch_id'); bind('fstatus', 'status');
    document.getElementById('fq')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') setFilter('q', e.target.value.trim()); });
    document.getElementById('addIp')?.addEventListener('click', () => ipFormModal(null, () => render()));
    document.getElementById('probeBtn')?.addEventListener('click', () => probeModal());
  }, 0);
  return `
    <h1>IP 台账</h1>
    <div class="toolbar">
      <select id="fsubnet"><option value="">全部网段</option>${(subnetsR.items || []).map((s) => `<option value="${s.id}" ${q.get('subnet_id') == s.id ? 'selected' : ''}>${esc(s.cidr)}</option>`).join('')}</select>
      <select id="fbranch">${branchOptions(q.get('branch_id'))}</select>
      <select id="fstatus"><option value="">全部状态</option>${Object.keys(STATUS_ZH).map((k) => `<option value="${k}" ${q.get('status') === k ? 'selected' : ''}>${STATUS_ZH[k]}</option>`).join('')}</select>
      <input id="fq" placeholder="搜索 IP/MAC/描述" value="${esc(q.get('q') || '')}" />
      ${hasCap('create') ? '<button class="btn primary" id="addIp">登记 IP</button>' : ''}
      ${hasCap('probe') ? '<button class="btn" id="probeBtn">主动探测</button>' : ''}
    </div>
    <table>
      <tr><th>地址</th><th>状态</th><th>MAC</th><th>所属网段</th><th>分支</th><th>描述</th><th>来源</th><th>更新时间</th></tr>
      ${r.items.map((x) => `<tr>
        <td><a href="#/ips/${encodeURIComponent(x.address)}">${esc(x.address)}</a></td>
        <td>${badge(STATUS_ZH[x.business_status] || x.business_status, STATUS_BADGE[x.business_status])}</td>
        <td>${esc(x.mac || '-')}</td>
        <td>${x.subnet_cidr ? `<a href="#/subnets/${x.subnet_id}">${esc(x.subnet_cidr)}</a>` : '-'}</td>
        <td>${esc(branchName(x.branch_id))}</td>
        <td>${esc(x.description || '')}</td>
        <td>${esc(x.source || '-')}</td>
        <td>${fmtTime(x.updated_at)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无记录</td></tr>'}
    </table>
    ${pager(r.page, r.total, r.limit, (p) => { const cur = new URLSearchParams(location.hash.split('?')[1] || ''); cur.set('page', p); location.hash = '#/ips?' + cur.toString(); })}`;
}

function ipFormModal(existing, onDone) {
  modal(existing ? `编辑 ${existing.address}` : '登记 IP', `
    ${!existing ? field('IP 地址 *', '<input name="address" placeholder="如 10.0.0.88" />') : ''}
    ${field('业务状态', `<select name="business_status">${Object.keys(STATUS_ZH).map((k) => `<option value="${k}" ${(existing ? existing.business_status : 'free') === k ? 'selected' : ''}>${STATUS_ZH[k]}</option>`).join('')}</select>`)}
    ${field('MAC', `<input name="mac" value="${esc(existing?.mac || '')}" placeholder="aa:bb:cc:dd:ee:ff" />`)}
    ${field('分支', `<select name="branch_id">${branchOptions(existing?.branch_id)}</select>`)}
    ${field('描述', `<textarea name="description" rows="2">${esc(existing?.description || '')}</textarea>`)}
  `, async (mask) => {
    const body = { business_status: fv(mask, 'business_status'), mac: fv(mask, 'mac') || null, branch_id: fv(mask, 'branch_id') || null, description: fv(mask, 'description') };
    if (!existing) body.address = fv(mask, 'address');
    await api(existing ? `/ips/${encodeURIComponent(existing.address)}` : '/ips', { method: existing ? 'PATCH' : 'POST', body });
    toast(existing ? '已更新' : '已登记');
    onDone();
  }, '保存');
}

function probeModal() {
  modal('主动探测', `
    ${field('IP 地址 *', '<input name="address" placeholder="如 10.0.0.88" />')}
    <p class="muted" style="font-size:12px">探测结果写入观测数据（icmp / tcp_port），限流 20 次/分钟。设备离线不等于目标空闲。</p>
  `, async (mask) => {
    const r = await api('/ips/probe', { method: 'POST', body: { ip: fv(mask, 'address') } });
    toast(`探测完成：${r.field_status ? FIELD_STATUS_ZH[r.field_status] || r.field_status : '已记录观测'}`);
  }, '探测');
}

export async function viewIp(address) {
  await ensureBranches();
  const r = await api('/ips/' + encodeURIComponent(address));
  const ip = r.ip;
  const assign = r.assignment;
  setTimeout(() => {
    document.getElementById('diagBtn')?.addEventListener('click', () => diagnoseIpView(address));
    document.getElementById('editBtn')?.addEventListener('click', () => ipFormModal(ip, () => render()));
    document.getElementById('assignBtn')?.addEventListener('click', () => {
      modal(`分配 ${address}`, `
        ${field('对象类型', `<select name="object_type"><option>主机</option><option>服务器</option><option>打印机</option><option>网络设备</option><option>摄像头</option><option>其他</option></select>`)}
        ${field('对象名称 *', '<input name="object_name" placeholder="如 FIN-PC-012" />')}
        ${field('原因', '<input name="reason" placeholder="分配原因（记入审计）" />')}
      `, async (mask) => {
        await api(`/ips/${encodeURIComponent(address)}/assign`, { method: 'POST', body: { object_type: fv(mask, 'object_type'), object_name: fv(mask, 'object_name'), reason: fv(mask, 'reason') } });
        toast('分配成功');
        render();
      }, '分配');
    });
    document.getElementById('releaseBtn')?.addEventListener('click', async () => {
      if (!confirm(`确认释放 ${address}？`)) return;
      try { await api(`/ips/${encodeURIComponent(address)}/release`, { method: 'POST', body: {} }); toast('已释放'); render(); } catch (e) { toast(e.message, true); }
    });
  }, 0);
  return `
    <h1><a href="#/ips">IP 台账</a> / ${esc(ip.address)} ${badge(STATUS_ZH[ip.business_status] || ip.business_status, STATUS_BADGE[ip.business_status])}</h1>
    <div class="card">
      <h2 style="margin-top:0">台账信息</h2>
      <div class="kv">
        <span class="k">MAC</span><span>${esc(ip.mac || '-')}</span>
        <span class="k">所属网段</span><span>${ip.subnet_cidr ? `<a href="#/subnets/${ip.subnet_id}">${esc(ip.subnet_cidr)}</a>` : '-'}</span>
        <span class="k">分支</span><span>${esc(branchName(ip.branch_id))}</span>
        <span class="k">用途</span><span>${esc(ip.purpose || '-')}</span>
        <span class="k">描述</span><span>${esc(ip.description || '-')}</span>
        <span class="k">来源</span><span>${esc(ip.source || '-')}</span>
        <span class="k">导入追溯</span><span>${ip.import_batch_id ? `批次 #${ip.import_batch_id} 行 ${ip.import_row}` : '-'}</span>
        <span class="k">更新时间</span><span>${fmtTime(ip.updated_at)}</span>
        ${assign ? `<span class="k">当前分配</span><span>${esc(assign.object_name || '')}（${esc(assign.object_type || '')}）自 ${fmtTime(assign.assigned_at)}${assign.reason ? `，原因：${esc(assign.reason)}` : ''}</span>` : ''}
      </div>
      <div class="toolbar" style="margin-top:14px">
        <button class="btn primary" id="diagBtn">现场诊断</button>
        ${hasCap('edit') ? '<button class="btn" id="editBtn">编辑</button>' : ''}
        ${hasCap('allocate') ? '<button class="btn" id="assignBtn">分配</button>' : ''}
        ${hasCap('allocate') ? '<button class="btn danger" id="releaseBtn">释放</button>' : ''}
      </div>
    </div>
    <div id="diagPanel"></div>`;
}

async function diagnoseIpView(address) {
  const panel = document.getElementById('diagPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="card muted">诊断中…</div>';
  try {
    const d = await api(`/ips/${encodeURIComponent(address)}/diagnosis`);
    const ev = d.evidence || [];
    panel.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">诊断结论 ${badge(FIELD_STATUS_ZH[d.field_status] || d.field_status, FIELD_STATUS_BADGE[d.field_status])}</h2>
        <div class="kv">
          <span class="k">置信度</span><span>${esc(typeof d.confidence === 'number' ? Math.round(d.confidence * 100) + '%' : (d.confidence || '-'))}</span>
          <span class="k">结论说明</span><span>${esc(d.reason || d.summary || '-')}</span>
          ${d.conflict ? `<span class="k">冲突信息</span><span class="err">${esc(typeof d.conflict === 'string' ? d.conflict : d.conflict.message || JSON.stringify(d.conflict))}</span>` : ''}
        </div>
        <h2>现场证据（${ev.length}）</h2>
        ${ev.length ? `<table><tr><th>证据类型</th><th>MAC</th><th>来源</th><th>观测时间</th><th>详情</th></tr>
          ${ev.map((x) => `<tr>
            <td>${esc(x.evidence_type)}</td>
            <td>${esc(x.mac || '-')}</td>
            <td>${esc(x.source_device || x.device_name || '-')}</td>
            <td>${fmtTime(x.observed_at)}</td>
            <td class="muted">${esc(x.detail || x.extra || '')}</td>
          </tr>`).join('')}</table>` : '<p class="muted">时间窗口内无现场证据。注意：设备离线/采集失败不代表目标空闲。</p>'}
      </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

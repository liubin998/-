import { api, toast, esc, badge, fmtTime, branchName, hasCap, ensureBranches, state, SUBNET_STATUS_ZH, KIND_ZH, STATUS_ZH, STATUS_BADGE, FIELD_STATUS_ZH, FIELD_STATUS_BADGE } from '../core.js';
import { modal, field, fv, branchOptions, pager } from '../ui.js';
import { render } from '../router.js';

export async function viewSubnets() {
  await ensureBranches();
  const params = new URLSearchParams(location.search ? '' : '');
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const page = Number(q.get('page')) || 1;
  const qs = new URLSearchParams({ page, limit: 20 });
  for (const k of ['branch_id', 'status', 'kind', 'q']) if (q.get(k)) qs.set(k, q.get(k));
  const r = await api('/subnets?' + qs.toString());
  const setFilter = (k, v) => {
    const cur = new URLSearchParams(location.hash.split('?')[1] || '');
    if (v) cur.set(k, v); else cur.delete(k);
    cur.delete('page');
    location.hash = '#/subnets?' + cur.toString();
  };
  setTimeout(() => {
    ['fbranch', 'fstatus', 'fkind'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => setFilter(id.slice(1).replace('branch', 'branch_id'), el.value));
    });
    const fq = document.getElementById('fq');
    if (fq) fq.addEventListener('keydown', (e) => { if (e.key === 'Enter') setFilter('q', fq.value.trim()); });
    const addBtn = document.getElementById('addSubnet');
    if (addBtn) addBtn.addEventListener('click', addSubnetModal);
    const ovBtn = document.getElementById('overlapBtn');
    if (ovBtn) ovBtn.addEventListener('click', showOverlaps);
  }, 0);
  return `
    <h1>网段管理</h1>
    <div class="toolbar">
      <select id="fbranch">${branchOptions(q.get('branch_id'))}</select>
      <select id="fstatus"><option value="">全部状态</option>${Object.keys(SUBNET_STATUS_ZH).map((k) => `<option value="${k}" ${q.get('status') === k ? 'selected' : ''}>${SUBNET_STATUS_ZH[k]}</option>`).join('')}</select>
      <select id="fkind"><option value="">全部类型</option>${Object.keys(KIND_ZH).map((k) => `<option value="${k}" ${q.get('kind') === k ? 'selected' : ''}>${KIND_ZH[k]}</option>`).join('')}</select>
      <input id="fq" placeholder="搜索 CIDR/用途/描述" value="${esc(q.get('q') || '')}" />
      ${hasCap('create') ? '<button class="btn primary" id="addSubnet">新增网段</button>' : ''}
      <button class="btn" id="overlapBtn">重叠检测</button>
    </div>
    <table>
      <tr><th>CIDR</th><th>分支</th><th>类型</th><th>状态</th><th>用途</th><th>网关</th><th>VLAN</th><th>操作</th></tr>
      ${r.items.map((s) => `<tr>
        <td><a href="#/subnets/${s.id}">${esc(s.cidr)}</a></td>
        <td>${esc(branchName(s.branch_id))}</td>
        <td>${KIND_ZH[s.kind] || esc(s.kind)}</td>
        <td>${badge(SUBNET_STATUS_ZH[s.status] || s.status, s.status === 'active' ? 'b-green' : 'b-gray')}</td>
        <td>${esc(s.purpose || '-')}</td>
        <td>${esc(s.gateway || '-')}</td>
        <td>${esc(s.vlan ?? '-')}</td>
        <td><a href="#/subnets/${s.id}">详情</a></td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无网段</td></tr>'}
    </table>
    ${pager(r.page, r.total, r.limit, (p) => { const cur = new URLSearchParams(location.hash.split('?')[1] || ''); cur.set('page', p); location.hash = '#/subnets?' + cur.toString(); })}`;
}

function addSubnetModal() {
  modal('新增网段', `
    ${field('CIDR *', '<input name="cidr" placeholder="如 192.168.10.0/24" />')}
    ${field('分支', `<select name="branch_id">${branchOptions()}</select>`)}
    ${field('类型', `<select name="kind">${Object.keys(KIND_ZH).map((k) => `<option value="${k}">${KIND_ZH[k]}</option>`).join('')}</select>`)}
    ${field('状态', `<select name="status">${Object.keys(SUBNET_STATUS_ZH).map((k) => `<option value="${k}">${SUBNET_STATUS_ZH[k]}</option>`).join('')}</select>`)}
    ${field('用途', '<input name="purpose" />')}
    ${field('网关', '<input name="gateway" />')}
    ${field('VLAN', '<input name="vlan" type="number" />')}
    ${field('描述', '<textarea name="description" rows="2"></textarea>')}
  `, async (mask) => {
    const body = {
      cidr: fv(mask, 'cidr'), branch_id: fv(mask, 'branch_id') || null, kind: fv(mask, 'kind'),
      status: fv(mask, 'status'), purpose: fv(mask, 'purpose'), gateway: fv(mask, 'gateway'),
      vlan: fv(mask, 'vlan') || null, description: fv(mask, 'description'),
    };
    await api('/subnets', { method: 'POST', body });
    toast('网段创建成功');
    render();
  }, '创建');
}

async function showOverlaps() {
  const r = await api('/subnets/overlaps');
  modal('网段重叠检测', r.overlaps.length
    ? `<table><tr><th>网段 A</th><th>网段 B</th><th>关系</th></tr>${r.overlaps.map((o) => `<tr><td>${esc(o.a_cidr || o.cidr_a || JSON.stringify(o.a))}</td><td>${esc(o.b_cidr || o.cidr_b || JSON.stringify(o.b))}</td><td>${esc(o.relation || o.type || '-')}</td></tr>`).join('')}</table>`
    : '<p class="ok">未发现重叠网段</p>', () => {}, '关闭');
}

export async function viewSubnet(id) {
  await ensureBranches();
  const r = await api('/subnets/' + id);
  const s = r.subnet;
  const st = r.stats || {};
  const ipsR = await api(`/subnets/${id}/ips?page=1&limit=20`);
  setTimeout(() => {
    document.getElementById('freeBtn')?.addEventListener('click', async () => {
      const n = Number(document.getElementById('freeCount').value) || 5;
      try {
        const fr = await api(`/subnets/${id}/free?count=${n}`);
        modal(`空闲 IP 推荐（${fr.free.length} 个）`, fr.free.length
          ? `<p style="margin-bottom:8px">${fr.free.map((x) => `<span class="tag">${esc(typeof x === 'string' ? x : x.address)}</span>`).join('')}</p>`
          : '<p class="muted">该网段已无空闲地址</p>', () => {}, '关闭');
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('diagSubnet')?.addEventListener('click', async () => {
      try {
        const dr = await api(`/subnets/${id}/diagnosis?limit=100`);
        modal('网段诊断（冲突/未登记线索）', dr.items.length
          ? `<table><tr><th>IP</th><th>结论</th><th>说明</th></tr>${dr.items.map((x) => `<tr><td><a href="#/ips/${encodeURIComponent(x.address || x.ip)}">${esc(x.address || x.ip)}</a></td><td>${badge(FIELD_STATUS_ZH[x.field_status] || x.field_status, FIELD_STATUS_BADGE[x.field_status])}</td><td>${esc(x.reason || x.summary || '')}</td></tr>`).join('')}</table>`
          : '<p class="ok">该网段暂无冲突或未登记线索</p>', () => {}, '关闭');
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('editSubnet')?.addEventListener('click', () => editSubnetModal(s));
    document.getElementById('delSubnet')?.addEventListener('click', async () => {
      if (!confirm(`确认删除网段 ${s.cidr}？该操作为高危操作，将影响其下所有台账 IP。`)) return;
      try { await api('/subnets/' + id, { method: 'DELETE' }); toast('网段已删除'); location.hash = '#/subnets'; } catch (e) { toast(e.message, true); }
    });
  }, 0);
  const usedPct = st.total ? Math.round(((st.occupied || 0) + (st.reserved || 0)) / st.total * 100) : 0;
  return `
    <h1><a href="#/subnets">网段</a> / ${esc(s.cidr)} ${badge(SUBNET_STATUS_ZH[s.status] || s.status, s.status === 'active' ? 'b-green' : 'b-gray')}</h1>
    <div class="cards">
      <div class="stat"><div class="num">${st.total ?? '-'}</div><div class="label">地址总数（可用主机数 ${st.usable ?? '-'})</div></div>
      <div class="stat"><div class="num" style="color:var(--green)">${st.free ?? '-'}</div><div class="label">空闲</div></div>
      <div class="stat"><div class="num">${st.occupied ?? '-'}</div><div class="label">已占用</div></div>
      <div class="stat"><div class="num" style="color:var(--purple)">${st.reserved ?? '-'}</div><div class="label">预留</div></div>
      <div class="stat"><div class="num" style="color:var(--red)">${st.conflict ?? '-'}</div><div class="label">冲突</div></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">基本信息</h2>
      <div class="kv">
        <span class="k">分支</span><span>${esc(branchName(s.branch_id))}</span>
        <span class="k">类型</span><span>${KIND_ZH[s.kind] || esc(s.kind)}</span>
        <span class="k">用途</span><span>${esc(s.purpose || '-')}</span>
        <span class="k">网关 / VLAN</span><span>${esc(s.gateway || '-')} / ${esc(s.vlan ?? '-')}</span>
        <span class="k">地址范围</span><span>${esc(s.first_usable || '')} ~ ${esc(s.last_usable || '')}</span>
        <span class="k">使用率</span><span><span class="usage-bar"><div style="width:${usedPct}%"></div></span>${usedPct}%</span>
        <span class="k">描述</span><span>${esc(s.description || '-')}</span>
        <span class="k">创建时间</span><span>${fmtTime(s.created_at)}</span>
      </div>
      <div class="toolbar" style="margin-top:14px">
        <input id="freeCount" type="number" value="5" style="width:80px" />
        <button class="btn" id="freeBtn">查找空闲 IP</button>
        <button class="btn" id="diagSubnet">网段诊断</button>
        ${hasCap('edit') ? `<button class="btn" id="editSubnet">编辑</button>` : ''}
        ${state.me && state.me.is_hq_admin ? `<button class="btn danger" id="delSubnet">删除</button>` : ''}
      </div>
    </div>
    <div class="card"><h2 style="margin-top:0">网段内台账（${ipsR.total}）</h2>
      <table><tr><th>地址</th><th>状态</th><th>MAC</th><th>对象</th><th>描述</th><th>来源</th></tr>
      ${ipsR.items.map((x) => `<tr>
        <td><a href="#/ips/${encodeURIComponent(x.address)}">${esc(x.address)}</a></td>
        <td>${badge(STATUS_ZH[x.business_status] || x.business_status, STATUS_BADGE[x.business_status])}</td>
        <td>${esc(x.mac || '-')}</td>
        <td>${esc(x.object_name || '-')}</td>
        <td>${esc(x.description || '')}</td>
        <td>${esc(x.source || '-')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无记录</td></tr>'}
      </table>
      ${pager(ipsR.page, ipsR.total, ipsR.limit, (p) => { location.hash = `#/ips?subnet_id=${id}&page=${p}`; })}
    </div>`;
}

function editSubnetModal(s) {
  modal('编辑网段 ' + s.cidr, `
    ${field('状态', `<select name="status">${Object.keys(SUBNET_STATUS_ZH).map((k) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${SUBNET_STATUS_ZH[k]}</option>`).join('')}</select>`)}
    ${field('类型', `<select name="kind">${Object.keys(KIND_ZH).map((k) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${KIND_ZH[k]}</option>`).join('')}</select>`)}
    ${field('用途', `<input name="purpose" value="${esc(s.purpose || '')}" />`)}
    ${field('网关', `<input name="gateway" value="${esc(s.gateway || '')}" />`)}
    ${field('VLAN', `<input name="vlan" type="number" value="${esc(s.vlan ?? '')}" />`)}
    ${field('描述', `<textarea name="description" rows="2">${esc(s.description || '')}</textarea>`)}
  `, async (mask) => {
    await api('/subnets/' + s.id, { method: 'PATCH', body: { status: fv(mask, 'status'), kind: fv(mask, 'kind'), purpose: fv(mask, 'purpose'), gateway: fv(mask, 'gateway'), vlan: fv(mask, 'vlan') || null, description: fv(mask, 'description') } });
    toast('已更新');
    render();
  }, '保存');
}

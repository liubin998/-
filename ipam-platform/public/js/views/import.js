import { state, api, toast, esc, badge, fmtTime, ensureBranches, STATUS_ZH, STATUS_BADGE, LEVEL_ZH, LEVEL_BADGE } from '../core.js';
import { modal, branchOptions } from '../ui.js';
import { render } from '../router.js';

export async function viewImport() {
  const r = await api('/import/batches');
  await ensureBranches();
  setTimeout(() => {
    const fileInput = document.getElementById('impFile');
    document.getElementById('impUpload')?.addEventListener('click', async () => {
      const f = fileInput.files[0];
      if (!f) { toast('请选择文件', true); return; }
      const fd = new FormData();
      fd.append('file', f);
      const branchSel = document.getElementById('impBranch');
      if (branchSel.value) fd.append('branch_id', branchSel.value);
      try {
        const res = await fetch('/api/import/upload', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: fd });
        const data = await res.json();
        if (!res.ok) throw { message: data.message || '上传失败' };
        toast(`上传成功，批次 #${data.batch_id}`);
        render();
      } catch (e) { toast(e.message || '上传失败', true); }
    });
    document.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => previewBatch(b.dataset.preview)));
  }, 0);
  return `
    <h1>导入中心</h1>
    <div class="card">
      <h2 style="margin-top:0">上传台账文件（CSV / XLSX）</h2>
      <div class="toolbar">
        <input type="file" id="impFile" accept=".csv,.xlsx,.xls,.zip" />
        <select id="impBranch">${branchOptions()}</select>
        <button class="btn primary" id="impUpload">上传并预检</button>
      </div>
      <p class="muted" style="font-size:12px">导入采用确认式入库：预检会将与台账不一致的行标记为冲突，冲突行仅在您显式勾选"覆盖"时才会写入；每行保留批次与行号追溯。</p>
    </div>
    <div class="card"><h2 style="margin-top:0">导入批次</h2>
      <table><tr><th>#</th><th>文件名</th><th>类型</th><th>状态</th><th>上传人</th><th>上传时间</th><th>统计</th><th>操作</th></tr>
      ${(r.batches || []).map((b) => `<tr>
        <td>${b.id}</td>
        <td>${esc(b.filename)}</td>
        <td>${esc(b.file_type)}</td>
        <td>${b.status === 'committed' ? badge('已入库', 'b-green') : badge(b.status === 'uploaded' ? '待确认' : b.status, b.status === 'failed' ? 'b-red' : 'b-amber')}</td>
        <td>${esc(b.username || ('#' + b.user_id))}</td>
        <td>${fmtTime(b.created_at)}</td>
        <td class="muted">${b.stats_json ? esc(typeof b.stats_json === 'string' ? b.stats_json : JSON.stringify(b.stats_json)) : '-'}</td>
        <td>
          <button class="btn sm" data-preview="${b.id}">预览/预检</button>
          <a class="btn sm" href="javascript:void(0)" onclick="window.__traces(${b.id})">追溯</a>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无导入批次</td></tr>'}
      </table>
    </div>`;
}

window.__traces = async (id) => {
  try {
    const r = await api(`/import/batches/${id}/traces`);
    modal(`批次 #${id} 行级追溯`, r.traces.length
      ? `<table><tr><th>行号</th><th>地址</th><th>状态</th><th>来源</th></tr>${r.traces.map((x) => `<tr><td>${x.import_row}</td><td><a href="#/ips/${encodeURIComponent(x.address)}">${esc(x.address)}</a></td><td>${badge(STATUS_ZH[x.business_status] || x.business_status, STATUS_BADGE[x.business_status])}</td><td>${esc(x.source || '-')}</td></tr>`).join('')}</table>`
      : '<p class="muted">该批次尚未写入任何台账行</p>', () => {}, '关闭');
  } catch (e) { toast(e.message, true); }
};

async function previewBatch(id) {
  try {
    const p = await api(`/import/batches/${id}/preview?target=ip`);
    const counts = p.counts || {};
    const mapping = p.mapping || {};
    const hasConflict = (counts.conflict || 0) > 0;
    modal(`批次 #${id} 预检：${p.filename}`, `
      <div class="kv" style="margin-bottom:12px">
        <span class="k">表头列</span><span>${(p.header || []).map((h) => `<span class="tag">${esc(h)}</span>`).join('')}</span>
        <span class="k">字段映射</span><span>${Object.entries(mapping).filter(([, v]) => v != null).map(([k, v]) => `<span class="tag">${esc(k)} ← ${esc(v)}</span>`).join('') || '<span class="err">未识别到任何字段</span>'}</span>
        ${p.sheets && p.sheets.length > 1 ? `<span class="k">工作表</span><span>${p.sheets.map((s) => esc(typeof s === 'string' ? s : s.name)).join('、')}</span>` : ''}
        <span class="k">预检统计</span><span>
          ${badge('正常 ' + (counts.ok || 0), 'b-green')}
          ${badge('警告 ' + (counts.warning || 0), 'b-amber')}
          ${badge('错误 ' + (counts.error || 0), 'b-red')}
          ${badge('冲突 ' + (counts.conflict || 0), 'b-purple')}
        </span>
      </div>
      <div style="max-height:300px;overflow-y:auto">
        <table><tr><th>行</th><th>级别</th><th>地址</th><th>状态</th><th>问题</th></tr>
        ${(p.sample || []).map((x) => `<tr>
          <td>${x.row_no}</td>
          <td>${badge(LEVEL_ZH[x.level] || x.level, LEVEL_BADGE[x.level])}</td>
          <td>${esc(x.data?.address || '-')}</td>
          <td>${esc(STATUS_ZH[x.data?.business_status] || x.data?.business_status || '-')}</td>
          <td class="muted">${[...(x.errors || []), ...(x.warnings || [])].map((e) => esc(typeof e === 'string' ? e : e.message || JSON.stringify(e))).join('；') || '-'}</td>
        </tr>`).join('')}</table>
      </div>
      <div class="toolbar" style="margin-top:14px">
        ${hasConflict ? '<label><input type="checkbox" id="ovCheck" /> 覆盖冲突行（用文件值更新台账）</label>' : '<span class="muted">无冲突行，可直接入库</span>'}
      </div>
      <div class="actions">
        <button class="btn" onclick="this.closest('.modal-mask').remove()">关闭</button>
        <button class="btn primary" id="commitBtn">确认入库</button>
      </div>
    `, () => {}, null);
    setTimeout(() => {
      document.getElementById('commitBtn')?.addEventListener('click', async () => {
        const overwrite = Boolean(document.getElementById('ovCheck')?.checked);
        if (hasConflict && !overwrite && !confirm('存在冲突行，未勾选覆盖时冲突行将被跳过。确认继续？')) return;
        try {
          const rr = await api(`/import/batches/${id}/commit`, { method: 'POST', body: { target: 'ip', overwrite } });
          const st = rr.stats || {};
          toast(`入库完成：新增 ${st.inserted || 0}，更新 ${st.updated || 0}，跳过 ${st.skipped || 0}`);
          document.querySelector('.modal-mask')?.remove();
          render();
        } catch (e) { toast(e.message, true); }
      });
    }, 0);
  } catch (e) { toast(e.message, true); }
}

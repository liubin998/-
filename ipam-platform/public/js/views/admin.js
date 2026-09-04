import { state, api, toast, esc, badge, hasCap, ensureBranches, ROLE_ZH, branchName } from '../core.js';
import { modal, field, fv, branchOptions } from '../ui.js';
import { render } from '../router.js';

export async function viewAdmin() {
  await ensureBranches();
  const users = await api('/admin/users');
  const windows = await api('/admin/windows');
  setTimeout(() => {
    document.getElementById('addBranch')?.addEventListener('click', () => {
      modal('新增分支', `
        ${field('名称 *', '<input name="name" />')}
        ${field('编码 *', '<input name="code" placeholder="如 SH" />')}
        ${field('负责人', '<input name="owner" />')}
      `, async (mask) => {
        await api('/admin/branches', { method: 'POST', body: { name: fv(mask, 'name'), code: fv(mask, 'code'), owner: fv(mask, 'owner') } });
        state.branches = [];
        toast('分支已创建');
        render();
      }, '创建');
    });
    document.getElementById('addUser')?.addEventListener('click', addUserModal);
    document.querySelectorAll('[data-edituser]').forEach((b) => b.addEventListener('click', () => {
      const u = (users.users || []).find((x) => x.id === Number(b.dataset.edituser));
      if (u) editUserModal(u);
    }));
    document.querySelectorAll('[data-win]').forEach((inp) => inp.addEventListener('change', async () => {
      const [et, pk, sk] = inp.dataset.win.split('|');
      try {
        await api('/admin/windows', { method: 'PUT', body: { scope: pk, scope_id: sk === 'null' ? null : Number(sk), evidence_type: et, window_min: Number(inp.value) } });
        toast('时间窗口已更新');
      } catch (e) { toast(e.message, true); render(); }
    }));
  }, 0);
  return `
    <h1>系统管理</h1>
    <div class="tabs">
      <button class="active" data-tab="branches">分支组织</button>
      <button data-tab="users">用户与授权</button>
      <button data-tab="windows">诊断时间窗口</button>
    </div>
    <div id="tab-branches">
      <div class="toolbar">${state.me && state.me.is_hq_admin ? '<button class="btn primary" id="addBranch">新增分支</button>' : ''}</div>
      <table><tr><th>#</th><th>名称</th><th>编码</th><th>负责人</th><th>上级</th></tr>
      ${(state.branches || []).map((b) => `<tr><td>${b.id}</td><td>${esc(b.name)}</td><td>${esc(b.code)}</td><td>${esc(b.owner || '-')}</td><td>${b.parent_id ? '#' + b.parent_id : '-'}</td></tr>`).join('')}
      </table>
    </div>
    <div id="tab-users" style="display:none">
      <div class="toolbar"><button class="btn primary" id="addUser">新增用户</button></div>
      <table><tr><th>#</th><th>用户名</th><th>姓名</th><th>部门</th><th>状态</th><th>授权分支</th><th>操作</th></tr>
      ${(users.users || []).map((u) => `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.display_name || '-')}</td>
        <td>${esc(u.department || '-')}</td>
        <td>${u.status === 'active' ? badge('启用', 'b-green') : badge('停用', 'b-gray')}</td>
        <td>${(u.grants || []).map((g) => `<span class="tag">${esc(branchName(g.branch_id))}·${ROLE_ZH[g.role] || g.role}</span>`).join('') || '<span class="muted">无</span>'}</td>
        <td><button class="btn sm" data-edituser="${u.id}">编辑</button></td>
      </tr>`).join('')}
      </table>
    </div>
    <div id="tab-windows" style="display:none">
      <p class="muted" style="margin-bottom:10px">各类现场证据的有效期（分钟）。窗口外的证据不参与诊断，避免把过期观测当作事实。</p>
      <table><tr><th>证据类型</th><th>范围</th><th>窗口（分钟）</th></tr>
      ${(windows.evidence_types || []).map((et) => {
        const found = (windows.windows || []).find((w) => w.evidence_type === et);
        return `<tr><td>${esc(et)}</td><td>${found && found.scope_id ? `分支 #${found.scope_id}` : '全局'}</td>
          <td><input type="number" style="width:100px" value="${found ? found.window_min : ''}" placeholder="默认" data-win="${et}|global|null" /></td></tr>`;
      }).join('')}
      </table>
    </div>`;
}

function addUserModal() {
  modal('新增用户', `
    ${field('用户名 *', '<input name="username" />')}
    ${field('密码 *', '<input name="password" type="password" />')}
    ${field('姓名', '<input name="display_name" />')}
    ${field('邮箱', '<input name="email" />')}
    ${field('部门', '<input name="department" />')}
    ${field('授权分支与角色', `<div id="grantRows"></div><button class="btn sm" type="button" id="addGrant">+ 添加授权</button>`)}
  `, async (mask) => {
    const grants = [];
    mask.querySelectorAll('.grant-row').forEach((row) => {
      const bid = row.querySelector('select').value;
      const role = row.querySelectorAll('select')[1].value;
      if (bid) grants.push({ branch_id: Number(bid), role });
    });
    await api('/admin/users', { method: 'POST', body: { username: fv(mask, 'username'), password: fv(mask, 'password'), display_name: fv(mask, 'display_name'), email: fv(mask, 'email'), department: fv(mask, 'department'), grants } });
    toast('用户已创建');
    render();
  }, '创建');
  setTimeout(() => {
    const addGrantRow = (container) => {
      const row = document.createElement('div');
      row.className = 'grant-row';
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
      row.innerHTML = `<select style="flex:1">${branchOptions()}</select>
        <select>${Object.keys(ROLE_ZH).filter((r) => r !== 'hq_admin').map((r) => `<option value="${r}">${ROLE_ZH[r]}</option>`).join('')}</select>
        <button class="btn sm" type="button">删</button>`;
      row.querySelector('button').addEventListener('click', () => row.remove());
      container.appendChild(row);
    };
    const c = document.getElementById('grantRows');
    document.getElementById('addGrant').addEventListener('click', () => addGrantRow(c));
    if (c) addGrantRow(c);
  }, 0);
}

function editUserModal(u) {
  modal(`编辑用户 ${u.username}`, `
    ${field('状态', `<select name="status"><option value="active" ${u.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${u.status !== 'active' ? 'selected' : ''}>停用</option></select>`)}
    ${field('姓名', `<input name="display_name" value="${esc(u.display_name || '')}" />`)}
    ${field('邮箱', `<input name="email" value="${esc(u.email || '')}" />`)}
    ${field('部门', `<input name="department" value="${esc(u.department || '')}" />`)}
    ${field('重置密码（留空不改）', '<input name="password" type="password" />')}
    ${field('授权分支与角色', `<div id="grantRows"></div><button class="btn sm" type="button" id="addGrant">+ 添加授权</button>`)}
  `, async (mask) => {
    const grants = [];
    mask.querySelectorAll('.grant-row').forEach((row) => {
      const bid = row.querySelector('select').value;
      const role = row.querySelectorAll('select')[1].value;
      if (bid) grants.push({ branch_id: Number(bid), role });
    });
    const body = { status: fv(mask, 'status'), display_name: fv(mask, 'display_name'), email: fv(mask, 'email'), department: fv(mask, 'department'), grants };
    const pwd = fv(mask, 'password');
    if (pwd) body.password = pwd;
    await api('/admin/users/' + u.id, { method: 'PATCH', body });
    toast('用户已更新');
    render();
  }, '保存');
  setTimeout(() => {
    const c = document.getElementById('grantRows');
    const addGrantRow = (container, g) => {
      const row = document.createElement('div');
      row.className = 'grant-row';
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
      row.innerHTML = `<select style="flex:1">${branchOptions(g ? g.branch_id : null)}</select>
        <select>${Object.keys(ROLE_ZH).filter((r) => r !== 'hq_admin').map((r) => `<option value="${r}" ${g && g.role === r ? 'selected' : ''}>${ROLE_ZH[r]}</option>`).join('')}</select>
        <button class="btn sm" type="button">删</button>`;
      row.querySelector('button').addEventListener('click', () => row.remove());
      container.appendChild(row);
    };
    document.getElementById('addGrant').addEventListener('click', () => addGrantRow(c));
    (u.grants || []).forEach((g) => addGrantRow(c, g));
    if (!(u.grants || []).length) addGrantRow(c);
  }, 0);
}

export function setupAdminTabs() {
  setTimeout(() => {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      ['branches', 'users', 'windows'].forEach((t) => {
        const el = document.getElementById('tab-' + t);
        if (el) el.style.display = b.dataset.tab === t ? '' : 'none';
      });
    }));
  }, 0);
}

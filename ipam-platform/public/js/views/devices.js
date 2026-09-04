import { api, toast, esc, badge, fmtTime, hasCap, DEVICE_STATUS_ZH, DEVICE_STATUS_BADGE } from '../core.js';
import { modal, field, fv, branchOptions } from '../ui.js';
import { render } from '../router.js';

export async function viewDevices() {
  const r = await api('/devices');
  setTimeout(() => {
    document.getElementById('addDevice')?.addEventListener('click', addDeviceModal);
    document.getElementById('collectAll')?.addEventListener('click', async () => {
      try { await api('/collect/run', { method: 'POST', body: {} }); toast('已触发全量采集'); setTimeout(render, 800); } catch (e) { toast(e.message, true); }
    });
    document.getElementById('reconcileAll')?.addEventListener('click', async () => {
      try { await api('/reconcile/run', { method: 'POST', body: {} }); toast('已触发对账'); setTimeout(render, 800); } catch (e) { toast(e.message, true); }
    });
    document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
      try { const rr = await api(`/devices/${b.dataset.test}/test`, { method: 'POST', body: {} }); toast(rr.ok ? '连接成功' : `连接失败：${rr.error}`, !rr.ok); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', async () => {
      try { const rr = await api(`/devices/${b.dataset.collect}/collect`, { method: 'POST', body: {} }); toast(`采集完成：${rr.run?.observation_count ?? 0} 条观测`); setTimeout(render, 600); } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-runs]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const rr = await api(`/devices/${b.dataset.runs}/runs`);
        modal('采集历史', `<table><tr><th>状态</th><th>完整性</th><th>观测数</th><th>开始时间</th><th>耗时</th></tr>
          ${(rr.runs || []).map((x) => `<tr><td>${x.status}</td><td>${esc(x.completeness || '-')}</td><td>${x.observation_count ?? 0}</td><td>${fmtTime(x.started_at)}</td><td>${x.duration_ms != null ? x.duration_ms + 'ms' : '-'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无</td></tr>'}</table>`, () => {}, '关闭');
      } catch (e) { toast(e.message, true); }
    }));
  }, 0);
  return `
    <h1>设备与采集</h1>
    <div class="toolbar">
      ${hasCap('device') ? '<button class="btn primary" id="addDevice">注册设备</button><button class="btn" id="collectAll">立即全量采集</button><button class="btn" id="reconcileAll">立即对账</button>' : ''}
    </div>
    <table>
      <tr><th>名称</th><th>角色</th><th>厂商/型号</th><th>协议</th><th>地址</th><th>状态</th><th>最近采集</th><th>操作</th></tr>
      ${(r.devices || []).map((d) => `<tr>
        <td>${esc(d.name)}</td>
        <td>${esc(d.role)}</td>
        <td>${esc(d.vendor || '-')} ${esc(d.model || '')}</td>
        <td>${esc(d.protocol)}</td>
        <td>${esc(d.host || '-')}:${esc(d.port ?? '-')}</td>
        <td>${badge(DEVICE_STATUS_ZH[d.status] || d.status, DEVICE_STATUS_BADGE[d.status])}</td>
        <td>${fmtTime(d.last_collect_at)}</td>
        <td>
          ${hasCap('device') ? `<button class="btn sm" data-test="${d.id}">测试</button> <button class="btn sm" data-collect="${d.id}">采集</button>` : ''}
          <button class="btn sm" data-runs="${d.id}">历史</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无设备</td></tr>'}
    </table>
    <p class="muted" style="margin-top:10px">深信服 AC 在线用户接口单次最多返回 100 条，采集器按 /24 分片查询并标记完整性。</p>`;
}

function addDeviceModal() {
  modal('注册采集设备', `
    ${field('名称 *', '<input name="name" placeholder="如 HQ-AC-01" />')}
    ${field('角色', `<select name="role"><option value="ac">无线控制器/AC</option><option value="switch">交换机</option><option value="router">路由器</option><option value="firewall">防火墙</option><option value="collector">采集器</option><option value="other">其他</option></select>`)}
    ${field('厂商', `<select name="vendor"><option value="sangfor">深信服</option><option value="huawei">华为</option><option value="h3c">新华三</option><option value="cisco">思科</option><option value="other">其他</option></select>`)}
    ${field('型号', '<input name="model" />')}
    ${field('协议', `<select name="protocol"><option value="restful">RESTful</option><option value="netconf">NETCONF</option><option value="restconf">RESTCONF</option><option value="snmpv3">SNMPv3</option><option value="ssh_readonly">SSH 只读</option></select>`)}
    ${field('主机/IP *', '<input name="host" />')}
    ${field('端口', '<input name="port" type="number" placeholder="深信服 AC 默认 9999" />')}
    ${field('凭据引用', '<input name="credential_ref" placeholder="vault://devices/hq-ac-01（不存明文密码）" />')}
    ${field('分支', `<select name="branch_id">${branchOptions()}</select>`)}
  `, async (mask) => {
    await api('/devices', { method: 'POST', body: { name: fv(mask, 'name'), role: fv(mask, 'role'), vendor: fv(mask, 'vendor'), model: fv(mask, 'model'), protocol: fv(mask, 'protocol'), host: fv(mask, 'host'), port: Number(fv(mask, 'port')) || null, credential_ref: fv(mask, 'credential_ref'), branch_id: fv(mask, 'branch_id') || null } });
    toast('设备已注册');
    render();
  }, '注册');
}

import { api, esc, badge, fmtTime, STATUS_ZH, STATUS_BADGE, TICKET_STATUS_ZH, TICKET_STATUS_BADGE } from '../core.js';

export async function viewDashboard() {
  const s = await api('/dashboard/summary');
  const led = {};
  (s.ledger_by_status || []).forEach((r) => { led[r.business_status] = r.c; });
  const tks = {};
  (s.tickets_by_status || []).forEach((r) => { tks[r.status] = r.c; });
  const dev = {};
  (s.devices || []).forEach((r) => { dev[r.status] = r.c; });
  const sched = s.scheduler || {};
  return `
    <h1>仪表盘</h1>
    <div class="cards">
      <div class="stat"><div class="num">${s.subnets}</div><div class="label">网段总数</div></div>
      <div class="stat"><div class="num">${s.ledger_total}</div><div class="label">台账 IP 总数</div></div>
      <div class="stat"><div class="num" style="color:var(--red)">${s.open_tickets}</div><div class="label">未决协同事项</div></div>
      <div class="stat"><div class="num">${dev.online || 0}<span class="muted" style="font-size:14px"> / ${s.devices.reduce((a, b) => a + b.c, 0)}</span></div><div class="label">设备在线 / 总数</div></div>
    </div>
    <div class="cards">
      <div class="card"><h2 style="margin-top:0">台账状态分布</h2>
        ${Object.keys(STATUS_ZH).map((k) => led[k] ? `<div style="margin:4px 0">${badge(STATUS_ZH[k], STATUS_BADGE[k])} ${led[k]}</div>` : '').join('') || '<span class="muted">暂无数据</span>'}
      </div>
      <div class="card"><h2 style="margin-top:0">协同事项状态</h2>
        ${Object.keys(TICKET_STATUS_ZH).map((k) => tks[k] ? `<div style="margin:4px 0">${badge(TICKET_STATUS_ZH[k], TICKET_STATUS_BADGE[k])} ${tks[k]}</div>` : '').join('') || '<span class="muted">暂无数据</span>'}
      </div>
      <div class="card"><h2 style="margin-top:0">调度器</h2>
        <div class="kv">
          <span class="k">运行状态</span><span>${sched.running ? badge('运行中', 'b-green') : badge('未启动', 'b-gray')}</span>
          <span class="k">采集间隔</span><span>${sched.collect_interval_ms ? sched.collect_interval_ms / 1000 + 's' : '-'}</span>
          <span class="k">对账间隔</span><span>${sched.reconcile_interval_ms ? sched.reconcile_interval_ms / 1000 + 's' : '-'}</span>
          <span class="k">最近采集</span><span>${fmtTime(sched.last_collect_at)}</span>
          <span class="k">最近对账</span><span>${fmtTime(sched.last_reconcile_at)}</span>
        </div>
      </div>
    </div>
    <div class="card"><h2 style="margin-top:0">最近采集任务</h2>
      <table><tr><th>设备</th><th>状态</th><th>完整性</th><th>观测条数</th><th>开始时间</th><th>耗时</th></tr>
      ${(s.recent_runs || []).map((r) => `<tr>
        <td>${esc(r.device_name)}</td>
        <td>${r.status === 'success' ? badge('成功', 'b-green') : r.status === 'running' ? badge('运行中', 'b-amber') : badge('失败', 'b-red')}</td>
        <td>${r.completeness === 'complete' ? badge('完整', 'b-green') : r.completeness === 'incomplete' ? badge('不完整', 'b-amber') : badge(r.completeness || '-', 'b-gray')}</td>
        <td>${r.observation_count ?? 0}</td>
        <td>${fmtTime(r.started_at)}</td>
        <td>${r.duration_ms != null ? r.duration_ms + 'ms' : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无采集记录</td></tr>'}
      </table>
    </div>`;
}

import { api, esc } from '../core.js';

export async function viewAi() {
  setTimeout(() => {
    document.getElementById('aiSend')?.addEventListener('click', sendAi);
    document.getElementById('aiInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAi(); });
    document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => { document.getElementById('aiInput').value = b.dataset.q; sendAi(); }));
  }, 0);
  return `
    <h1>AI 查询助手</h1>
    <p class="muted" style="margin-bottom:12px">AI 仅做理解与解释：问题会被解析为意图，实际数据一律来自规则引擎与台账，并受您当前权限过滤。</p>
    <div class="toolbar">
      <button class="btn sm" data-q="10.0.0.5 这个 IP 现在有人在用吗？">查 IP 使用</button>
      <button class="btn sm" data-q="10.0.1.0/24 里找 5 个空闲 IP">找空闲 IP</button>
      <button class="btn sm" data-q="目前有哪些 IP 冲突？">冲突清单</button>
      <button class="btn sm" data-q="有哪些未登记的 IP？">未登记占用</button>
      <button class="btn sm" data-q="台账里各状态的 IP 统计">台账统计</button>
    </div>
    <div class="chat" id="aiChat"></div>
    <div class="toolbar" style="margin-top:14px">
      <input id="aiInput" placeholder="例如：10.0.0.5 是否在用？/ 10.0.2.0/24 使用率如何？" style="flex:1" />
      <button class="btn primary" id="aiSend">提问</button>
    </div>`;
}

async function sendAi() {
  const input = document.getElementById('aiInput');
  const chat = document.getElementById('aiChat');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  chat.insertAdjacentHTML('beforeend', `<div class="msg q">${esc(q)}</div>`);
  const holder = document.createElement('div');
  holder.className = 'msg a muted';
  holder.textContent = '思考中…';
  chat.appendChild(holder);
  try {
    const r = await api('/ai/query', { method: 'POST', body: { question: q } });
    let html = `<strong>意图：</strong>${esc(r.intent || '-')}<br><br>${esc(r.answer || '')}`;
    if (r.data && Array.isArray(r.data) && r.data.length) {
      const rows = r.data.slice(0, 20);
      const cols = Object.keys(rows[0] || {});
      html += `<div style="overflow-x:auto;margin-top:8px"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c] ?? '-')}</td>`).join('')}</tr>`).join('')}</table></div>`;
    }
    if (r.caveats && r.caveats.length) html += `<div class="caveat">${r.caveats.map(esc).join('；')}</div>`;
    holder.classList.remove('muted');
    holder.innerHTML = html;
  } catch (e) {
    holder.classList.remove('muted');
    holder.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

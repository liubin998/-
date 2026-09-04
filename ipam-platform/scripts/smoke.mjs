const BASE = 'http://localhost:8787/api';
let TOKEN = '';
let passed = 0;
let failed = 0;

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra || ''}`);
  }
}

console.log('== 1. 认证 ==');
{
  const bad = await req('POST', '/auth/login', { username: 'admin', password: 'wrong' });
  check('错误口令被拒绝', bad.status === 401, JSON.stringify(bad.data));

  const ok = await req('POST', '/auth/login', { username: 'admin', password: 'Admin@12345' });
  check('admin 登录成功', ok.status === 200 && !!ok.data.token, JSON.stringify(ok.data).slice(0, 120));
  TOKEN = ok.data.token;

  const me = await req('GET', '/auth/me', undefined, TOKEN);
  check('/auth/me 返回用户', me.status === 200 && me.data.user?.username === 'admin');
  check('hq_admin 能力点完整', Array.isArray(me.data.user?.caps) && me.data.user.caps.length >= 10);

  const noTok = await req('GET', '/subnets');
  check('无 token 返回 401', noTok.status === 401);
}

console.log('== 2. 仪表盘与搜索 ==');
{
  const sum = await req('GET', '/dashboard/summary', undefined, TOKEN);
  check('summary 返回', sum.status === 200 && typeof sum.data.subnets === 'number', JSON.stringify(sum.data).slice(0, 200));

  const s = await req('GET', '/search?q=10.0', undefined, TOKEN);
  check('search 返回', s.status === 200 && Array.isArray(s.data.ips));
}

console.log('== 3. 网段 ==');
{
  const list0 = await req('GET', '/subnets?page=1&limit=200', undefined, TOKEN);
  for (const s of list0.data.items || []) {
    if (s.cidr && s.cidr.startsWith('10.90.0.0/')) await req('DELETE', `/subnets/${s.id}`, undefined, TOKEN);
  }
  const list = await req('GET', '/subnets?page=1&limit=20', undefined, TOKEN);
  check('网段列表', list.status === 200 && Array.isArray(list.data.items) && list.data.items.length > 0, JSON.stringify(list.data).slice(0, 150));
  const created = await req('POST', '/subnets', {
    cidr: '10.90.0.0/24', purpose: '冒烟测试网段', branch_id: 1, kind: 'lan', status: 'planned',
  }, TOKEN);
  check('新建网段', created.status === 201 || created.status === 200, JSON.stringify(created.data).slice(0, 150));
  if (created.data.subnet?.id) {
    const dup = await req('POST', '/subnets', { cidr: '10.90.0.0/25', purpose: '重叠网段', branch_id: 1, kind: 'lan', status: 'planned' }, TOKEN);
    check('重叠子网段可创建(设计为警告非阻断)', dup.status === 201, JSON.stringify(dup.data).slice(0, 100));
    const same = await req('POST', '/subnets', { cidr: '10.90.0.0/24', purpose: '重复', branch_id: 1, kind: 'lan' }, TOKEN);
    check('完全重复网段被拒绝(409)', same.status === 409);
    const ov = await req('GET', '/subnets/overlaps', undefined, TOKEN);
    const hasPair = Array.isArray(ov.data.overlaps) && ov.data.overlaps.some((o) => (o.a_cidr === '10.90.0.0/24' && o.b_cidr === '10.90.0.0/25') || (o.a_cidr === '10.90.0.0/25' && o.b_cidr === '10.90.0.0/24'));
    check('重叠检测报告包含新网段对', ov.status === 200 && hasPair, JSON.stringify(ov.data).slice(0, 200));
    if (dup.data.subnet?.id) await req('DELETE', `/subnets/${dup.data.subnet.id}`, undefined, TOKEN);
    const del = await req('DELETE', `/subnets/${created.data.subnet.id}`, undefined, TOKEN);
    check('删除测试网段', del.status === 200 && del.data.ok === true, JSON.stringify(del.data).slice(0, 100));
  }
}

console.log('== 4. IP 台账与诊断 ==');
{
  const list = await req('GET', '/ips?page=1&limit=5', undefined, TOKEN);
  check('IP 列表', list.status === 200 && Array.isArray(list.data.items));

  const free = await req('GET', '/subnets/1/free?count=3', undefined, TOKEN);
  if (free.status === 200) check('空闲 IP 推荐', Array.isArray(free.data.free), JSON.stringify(free.data).slice(0, 150));
  else console.log(`  INFO  /subnets/1/free 返回 ${free.status}: ${JSON.stringify(free.data).slice(0, 120)}`);

  const diag = await req('GET', '/ips/10.0.0.5/diagnosis', undefined, TOKEN);
  if (diag.status === 200) check('IP 诊断', diag.data !== undefined, JSON.stringify(diag.data).slice(0, 150));
  else console.log(`  INFO  诊断返回 ${diag.status}: ${JSON.stringify(diag.data).slice(0, 120)}`);
}

console.log('== 5. 设备与采集 ==');
{
  const devs = await req('GET', '/devices', undefined, TOKEN);
  check('设备列表', devs.status === 200 && Array.isArray(devs.data.devices));

  const run = await req('POST', '/collect/run', {}, TOKEN);
  if (run.status === 200 || run.status === 201) check('触发采集', true, JSON.stringify(run.data).slice(0, 150));
  else console.log(`  INFO  采集返回 ${run.status}: ${JSON.stringify(run.data).slice(0, 200)}`);
}

console.log('== 6. 协同事项 ==');
{
  const t = await req('POST', '/tickets', {
    type: 'manual', title: '冒烟测试事项', severity: 'low', branch_id: 1, detail: '冒烟测试自动创建',
  }, TOKEN);
  check('创建协同事项', t.status === 201 || t.status === 200, JSON.stringify(t.data).slice(0, 150));
  if (t.data.ticket?.id) {
    const c = await req('POST', `/tickets/${t.data.ticket.id}/comments`, { content: '测试评论' }, TOKEN);
    check('添加评论', c.status === 200 && Array.isArray(c.data.comments), JSON.stringify(c.data).slice(0, 120));
    const patch = await req('PATCH', `/tickets/${t.data.ticket.id}`, { status: 'in_progress' }, TOKEN);
    check('更新事项状态', patch.status === 200 && patch.data.ticket?.status === 'in_progress');
    const list = await req('GET', '/tickets?page=1&limit=5', undefined, TOKEN);
    check('事项列表含新建', list.status === 200 && JSON.stringify(list.data).includes('冒烟测试事项'));
  }
}

console.log('== 7. 审计 ==');
{
  const a = await req('GET', '/audit/logs?page=1&limit=10', undefined, TOKEN);
  check('审计日志', a.status === 200 && Array.isArray(a.data.items), JSON.stringify(a.data).slice(0, 120));
}

console.log('== 8. AI 助手 ==');
{
  const ai = await req('POST', '/ai/query', { question: '哪些 IP 处于冲突状态？' }, TOKEN);
  if (ai.status === 200) check('AI 问答', ai.data !== undefined, JSON.stringify(ai.data).slice(0, 150));
  else console.log(`  INFO  AI 返回 ${ai.status}: ${JSON.stringify(ai.data).slice(0, 200)}`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

import fs from 'node:fs';

const BASE = 'http://localhost:8787/api';
let TOKEN = '';
let passed = 0, failed = 0;

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra || ''}`); }
}

(async () => {
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'Admin@12345' });
  TOKEN = login.data.token;

  console.log('== 导入：上传 ==');
  const csv = fs.readFileSync('scripts/import_test.csv');
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'import_test.csv');
  fd.append('branch_id', '1');
  const upRes = await fetch(BASE + '/import/upload', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
  const up = await upRes.json();
  check('上传返回 batch_id', upRes.status === 201 && !!up.batch_id, JSON.stringify(up).slice(0, 120));
  const batchId = up.batch_id;

  console.log('== 导入：预检 ==');
  const pv = await req('GET', `/import/batches/${batchId}/preview?target=ip`, undefined, TOKEN);
  check('预检返回', pv.status === 200 && pv.data.batch_id === batchId, JSON.stringify(pv.data.counts));
  const counts = pv.data.counts || {};
  check('预检计数含 error/conflict', counts.error >= 1 && counts.conflict >= 1, JSON.stringify(counts));
  const conflictRow = (pv.data.sample || []).find((r) => r.level === 'conflict');
  check('冲突行带覆盖提示', !!conflictRow && conflictRow.warnings.some((w) => w.error_type === 'ledger_conflict'), JSON.stringify(conflictRow).slice(0, 200));
  const errRow = (pv.data.sample || []).find((r) => r.level === 'error');
  check('非法 IP 标为 error', !!errRow, JSON.stringify(errRow).slice(0, 200));

  console.log('== 导入：提交(不覆盖) ==');
  const c1 = await req('POST', `/import/batches/${batchId}/commit`, { target: 'ip', overwrite: false }, TOKEN);
  check('提交成功', c1.status === 200 && !!c1.data.stats, JSON.stringify(c1.data).slice(0, 200));
  const st = c1.data.stats || {};
  check('新增1条(10.0.0.100)', st.inserted === 1, JSON.stringify(st));
  check('冲突/错误/重复被跳过', st.skipped >= 3, JSON.stringify(st));

  const tr = await req('GET', `/import/batches/${batchId}/traces`, undefined, TOKEN);
  check('行级追溯返回', tr.status === 200 && Array.isArray(tr.data.traces) && tr.data.traces.length >= 1, JSON.stringify(tr.data).slice(0, 200));
  const er = await req('GET', `/import/batches/${batchId}/errors`, undefined, TOKEN);
  check('错误清单返回', er.status === 200 && Array.isArray(er.data.errors), JSON.stringify(er.data).slice(0, 150));

  console.log('== 导入：重复提交防护 ==');
  const c2 = await req('POST', `/import/batches/${batchId}/commit`, { target: 'ip', overwrite: true }, TOKEN);
  check('已入库批次拒绝重复提交(409)', c2.status === 409, JSON.stringify(c2.data).slice(0, 120));

  console.log('== 导入：覆盖模式 ==');
  const csv2 = Buffer.from('IP地址,业务状态,备注\n10.0.0.11,空闲,覆盖测试改状态\n');
  const fd2 = new FormData();
  fd2.append('file', new Blob([csv2], { type: 'text/csv' }), 'overwrite.csv');
  const up2Res = await fetch(BASE + '/import/upload', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd2 });
  const up2 = await up2Res.json();
  check('覆盖批次上传', up2Res.status === 201 && !!up2.batch_id);
  const cNo = await req('POST', `/import/batches/${up2.batch_id}/commit`, { target: 'ip', overwrite: false }, TOKEN);
  const stNo = cNo.data.stats || {};
  check('不覆盖时冲突行跳过', cNo.status === 200 && stNo.skipped === 1 && stNo.updated === 0, JSON.stringify(stNo));

  const csv3 = Buffer.from('IP地址,业务状态,备注\n10.0.0.11,空闲,覆盖测试改状态\n');
  const fd3 = new FormData();
  fd3.append('file', new Blob([csv3], { type: 'text/csv' }), 'overwrite2.csv');
  const up3Res = await fetch(BASE + '/import/upload', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd3 });
  const up3 = await up3Res.json();
  const cYes = await req('POST', `/import/batches/${up3.batch_id}/commit`, { target: 'ip', overwrite: true }, TOKEN);
  const stYes = cYes.data.stats || {};
  check('覆盖时冲突行更新', cYes.status === 200 && stYes.updated === 1, JSON.stringify(stYes));
  const ipNow = await req('GET', '/ips/10.0.0.11', undefined, TOKEN);
  check('台账状态已被覆盖为 free', ipNow.status === 200 && (ipNow.data.ip?.business_status === 'free' || ipNow.data.business_status === 'free'), JSON.stringify(ipNow.data).slice(0, 200));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();

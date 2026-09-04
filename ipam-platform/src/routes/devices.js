import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap, assertBranch } from '../domain/authHelpers.js';
import { createDevice, getDevice, updateDevice, DEVICE_ROLES, PROTOCOLS } from '../domain/devices.js';
import { recordAudit } from '../domain/audit.js';
import { runCollectForDevice } from '../collector/runner.js';
import { SangforAcAdapter } from '../collector/adapters/sangfor.js';
import { HuaweiSwitchAdapter } from '../collector/adapters/huawei.js';

export const deviceRouter = Router();
deviceRouter.use(authMiddleware);

deviceRouter.get('/', requireCap('view'), wrap(async (req, res) => {
  let rows;
  if (req.userCtx.is_hq_admin) {
    rows = db.prepare('SELECT d.*, b.name AS branch_name FROM devices d LEFT JOIN branches b ON b.id = d.branch_id ORDER BY d.id').all();
  } else {
    const ids = req.userCtx.branch_ids;
    if (!ids.length) return res.json({ devices: [] });
    rows = db.prepare(`
      SELECT d.*, b.name AS branch_name FROM devices d LEFT JOIN branches b ON b.id = d.branch_id
      WHERE d.branch_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id
    `).all(...ids);
  }
  res.json({ devices: rows, roles: DEVICE_ROLES, protocols: PROTOCOLS });
}));

deviceRouter.post('/', requireCap('device'), wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.vendor) throw httpError(400, '设备名称与厂商不能为空');
  if (body.branch_id) assertBranch(req.userCtx, body.branch_id, 'device');
  const device = createDevice(body);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'device.create',
    entityType: 'device', entityId: device.name, branchId: device.branch_id,
    after: { ...device, credential_ref: device.credential_ref }, source: 'web',
  });
  res.status(201).json({ device });
}));

deviceRouter.patch('/:id', requireCap('device'), wrap(async (req, res) => {
  const device = getDevice(Number(req.params.id));
  if (!device) throw httpError(404, '设备不存在');
  if (device.branch_id) assertBranch(req.userCtx, device.branch_id, 'device');
  const updated = updateDevice(device.id, req.body || {});
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'device.update',
    entityType: 'device', entityId: device.name, branchId: device.branch_id,
    before: device, after: updated, source: 'web',
  });
  res.json({ device: updated });
}));

deviceRouter.post('/:id/test', requireCap('device'), wrap(async (req, res) => {
  const device = getDevice(Number(req.params.id));
  if (!device) throw httpError(404, '设备不存在');
  const adapter = device.vendor === 'sangfor' || device.role === 'ac'
    ? new SangforAcAdapter(device, { transport: 'sim' })
    : new HuaweiSwitchAdapter(device, { transport: 'sim' });
  try {
    const r = await adapter.testConnection();
    res.json({ ok: true, result: r });
  } catch (e) {
    res.json({ ok: false, error: e.message, category: e.category || 'unknown' });
  }
}));

deviceRouter.post('/:id/collect', requireCap('device'), wrap(async (req, res) => {
  const device = getDevice(Number(req.params.id));
  if (!device) throw httpError(404, '设备不存在');
  if (device.branch_id) assertBranch(req.userCtx, device.branch_id, 'device');
  const run = await runCollectForDevice(device);
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'device.collect_manual',
    entityType: 'device', entityId: device.name, branchId: device.branch_id,
    after: { status: run.status, completeness: run.completeness, record_count: run.record_count }, source: 'web',
  });
  res.json({ run });
}));

deviceRouter.get('/:id/runs', requireCap('view'), wrap(async (req, res) => {
  const device = getDevice(Number(req.params.id));
  if (!device) throw httpError(404, '设备不存在');
  const runs = db.prepare('SELECT * FROM collect_runs WHERE device_id = ? ORDER BY started_at DESC LIMIT 50').all(device.id);
  res.json({ runs });
}));

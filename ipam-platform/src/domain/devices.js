import { db, now } from '../db.js';
import { jsonCol } from './util.js';

export const DEVICE_ROLES = ['switch', 'ac', 'router', 'firewall', 'collector', 'other'];
export const PROTOCOLS = ['netconf', 'restconf', 'snmpv3', 'ssh_readonly', 'restful', 'none'];
export const DEVICE_STATUS = ['online', 'offline', 'error', 'unknown'];

export class DeviceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createDevice(fields) {
  const t = now();
  const info = db.prepare(`
    INSERT INTO devices (name, vendor, model, software_version, mgmt_ip, branch_id, role, protocol, capabilities_json, credential_ref, enabled, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
  `).run(
    fields.name, fields.vendor, fields.model ?? null, fields.software_version ?? null,
    fields.mgmt_ip ?? null, fields.branch_id ?? null, fields.role ?? 'other',
    fields.protocol ?? 'none', JSON.stringify(fields.capabilities ?? []),
    fields.credential_ref ?? null, fields.enabled ? 1 : 0, t, t,
  );
  return getDevice(info.lastInsertRowid);
}

export function getDevice(idOrName) {
  const isId = typeof idOrName === 'number' || /^\d+$/.test(String(idOrName));
  const row = db.prepare(`
    SELECT d.*, b.name AS branch_name
    FROM devices d LEFT JOIN branches b ON b.id = d.branch_id
    WHERE d.${isId ? 'id' : 'name'} = ?
  `).get(isId ? Number(idOrName) : String(idOrName));
  if (!row) return null;
  row.capabilities = jsonCol(row.capabilities_json, []);
  return row;
}

export function updateDevice(id, patch) {
  const cur = getDevice(id);
  if (!cur) throw new DeviceError('设备不存在', 404);
  const allowed = ['name', 'vendor', 'model', 'software_version', 'mgmt_ip', 'branch_id', 'role', 'protocol', 'credential_ref', 'enabled'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if ('capabilities' in patch) {
    sets.push('capabilities_json = ?');
    vals.push(JSON.stringify(patch.capabilities));
  }
  if (!sets.length) return cur;
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDevice(id);
}

export function markDeviceStatus(id, status, error = null) {
  db.prepare('UPDATE devices SET status = ?, last_comm_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), error, now(), id);
}

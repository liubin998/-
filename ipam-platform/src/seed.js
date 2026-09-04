import { db, now } from './db.js';
import { config } from './config.js';
import { initRoleCaps, hashPassword } from './domain/auth.js';
import { createBranch, grantBranch } from './domain/authHelpers.js';
import { createSubnet } from './domain/subnet.js';
import { upsertIp } from './domain/ipLedger.js';
import { createDevice } from './domain/devices.js';

export function seed() {
  initRoleCaps();
  const t = now();

  let admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, email, department, status, created_at, updated_at)
      VALUES ('admin', ?, '总部管理员', 'admin@corp.example', '信息中心', 'active', ?, ?)
    `).run(hashPassword(config.seedAdminPassword), t, t);
    admin = { id: info.lastInsertRowid };
  }

  let hq = db.prepare("SELECT id FROM branches WHERE code = 'HQ'").get();
  if (!hq) hq = { id: createBranch({ name: '总部', code: 'HQ', owner: '信息中心' }).id };
  let sh = db.prepare("SELECT id FROM branches WHERE code = 'SH'").get();
  if (!sh) sh = { id: createBranch({ name: '上海分公司', code: 'SH', owner: '上海IT' }).id };
  let gz = db.prepare("SELECT id FROM branches WHERE code = 'GZ'").get();
  if (!gz) gz = { id: createBranch({ name: '广州分公司', code: 'GZ', owner: '广州IT' }).id };

  const adminGrant = db.prepare('SELECT id FROM user_grants WHERE user_id = ? AND role = ?').get(admin.id, 'hq_admin');
  if (!adminGrant) grantBranch(admin.id, hq.id, 'hq_admin');

  const subnetSpecs = [
    { cidr: '10.0.0.0/16', branch_id: hq.id, purpose: '总部办公', kind: 'lan', vlan: 10, gateway: '10.0.0.1', description: '总部内网主网段' },
    { cidr: '10.0.1.0/24', branch_id: hq.id, purpose: '总部服务器', kind: 'lan', vlan: 20, gateway: '10.0.1.1', description: '总部机房服务器区' },
    { cidr: '10.0.2.0/24', branch_id: hq.id, purpose: '总部无线', kind: 'wifi', vlan: 30, gateway: '10.0.2.1' },
    { cidr: '10.10.0.0/23', branch_id: sh.id, purpose: '上海办公', kind: 'lan', vlan: 100, gateway: '10.10.0.1' },
    { cidr: '10.20.0.0/24', branch_id: gz.id, purpose: '广州办公', kind: 'lan', vlan: 200, gateway: '10.20.0.1' },
    { cidr: '2001:db8:1::/64', branch_id: hq.id, purpose: '总部IPv6', kind: 'lan' },
  ];
  const subnetIds = {};
  for (const s of subnetSpecs) {
    const exists = db.prepare('SELECT id, cidr FROM subnets WHERE cidr = ?').get(s.cidr);
    if (exists) { subnetIds[s.cidr] = exists.id; continue; }
    try {
      const created = createSubnet(s);
      subnetIds[s.cidr] = created.id;
    } catch { /* already exists after normalization */ }
  }

  const ipSpecs = [
    { address: '10.0.0.1', business_status: 'unavailable', branch_id: hq.id, description: '总部网关' },
    { address: '10.0.0.10', business_status: 'occupied', mac: 'aa:bb:cc:00:00:10', branch_id: hq.id, description: '财务部-张三' },
    { address: '10.0.0.11', business_status: 'occupied', mac: 'aa:bb:cc:00:00:11', branch_id: hq.id, description: '财务部-李四' },
    { address: '10.0.0.12', business_status: 'occupied', mac: 'aa:bb:cc:00:00:12', branch_id: hq.id, description: '人事部-王五' },
    { address: '10.0.0.13', business_status: 'free', branch_id: hq.id, description: '备用' },
    { address: '10.0.0.14', business_status: 'reserved', branch_id: hq.id, description: '预留-打印机' },
    { address: '10.0.0.15', business_status: 'released', mac: 'aa:bb:cc:00:00:15', branch_id: hq.id, description: '离职员工回收' },
    { address: '10.0.1.5', business_status: 'occupied', mac: 'aa:bb:cc:01:00:05', branch_id: hq.id, description: 'OA 服务器' },
    { address: '10.0.1.6', business_status: 'occupied', mac: 'aa:bb:cc:01:00:06', branch_id: hq.id, description: '数据库服务器' },
    { address: '10.0.1.7', business_status: 'occupied', branch_id: hq.id, description: '无 MAC 历史遗留' },
    { address: '10.10.0.20', business_status: 'occupied', mac: 'aa:bb:cc:10:00:20', branch_id: sh.id, description: '上海-销售部' },
    { address: '10.10.0.21', business_status: 'occupied', mac: 'aa:bb:cc:10:00:21', branch_id: sh.id, description: '上海-前台' },
    { address: '10.20.0.30', business_status: 'occupied', mac: 'aa:bb:cc:20:00:30', branch_id: gz.id, description: '广州-运营部' },
    { address: '2001:db8:1::10', business_status: 'occupied', mac: 'aa:bb:cc:60:00:10', branch_id: hq.id, description: 'IPv6 测试主机' },
  ];
  for (const spec of ipSpecs) {
    const exists = db.prepare('SELECT id FROM ip_ledger WHERE address = ?').get(spec.address);
    if (exists) continue;
    upsertIp({ ...spec, source: 'seed' });
  }

  const deviceSpecs = [
    { name: 'HQ-AC-01', vendor: 'sangfor', role: 'ac', protocol: 'restful', branch_id: hq.id, mgmt_ip: '10.0.1.250', credential_ref: 'vault://sangfor/hq-ac-01', enabled: true, capabilities: ['online_users', 'ipmac_binding', 'health'] },
    { name: 'HQ-SW-01', vendor: 'huawei', role: 'switch', protocol: 'netconf', branch_id: hq.id, mgmt_ip: '10.0.1.251', credential_ref: 'vault://huawei/hq-sw-01', enabled: true, capabilities: ['arp', 'mac_table', 'port_status'] },
    { name: 'SH-AC-01', vendor: 'sangfor', role: 'ac', protocol: 'restful', branch_id: sh.id, mgmt_ip: '10.10.0.250', credential_ref: 'vault://sangfor/sh-ac-01', enabled: true, capabilities: ['online_users', 'ipmac_binding', 'health'] },
    { name: 'GZ-SW-01', vendor: 'huawei', role: 'switch', protocol: 'snmpv3', branch_id: gz.id, mgmt_ip: '10.20.0.251', credential_ref: 'vault://huawei/gz-sw-01', enabled: true, capabilities: ['arp', 'mac_table'] },
  ];
  for (const spec of deviceSpecs) {
    const exists = db.prepare('SELECT id FROM devices WHERE name = ?').get(spec.name);
    if (exists) continue;
    createDevice(spec);
  }
}

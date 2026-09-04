import { buildBranchWorld } from '../simulator.js';
import { ipInRange } from '../../domain/ip.js';

export class HuaweiSwitchAdapter {
  constructor(device, { transport = 'sim', protocol = null } = {}) {
    this.device = device;
    this.transport = transport;
    this.protocol = protocol || device.protocol || 'snmpv3';
  }

  async testConnection() {
    if (this.device.status === 'offline' || !this.device.enabled) {
      throw Object.assign(new Error('交换机不可达（模拟离线）'), { category: 'network' });
    }
    const world = buildBranchWorld(this.device.branch_id);
    if (world.offline) throw Object.assign(new Error('交换机不可达（模拟离线）'), { category: 'network' });
    return { ok: true, protocol: this.protocol, model: this.device.model };
  }

  async getArpTable({ cidrFilter = null } = {}) {
    const world = buildBranchWorld(this.device.branch_id);
    let entries = world.endpoints.filter((e) => e.mac);
    if (cidrFilter) entries = entries.filter((e) => ipInRange(e.ip, cidrFilter));
    return entries.map((e) => ({
      ip: e.ip,
      mac: e.mac,
      interface: `Vlanif${e.vlan}`,
      vlan: e.vlan,
      age_ms: Math.floor((Date.now() - e.login_time)),
    }));
  }

  async getMacTable({ cidrFilter = null } = {}) {
    const world = buildBranchWorld(this.device.branch_id);
    let entries = world.endpoints;
    if (cidrFilter) entries = entries.filter((e) => ipInRange(e.ip, cidrFilter));
    return entries.map((e) => ({
      mac: e.mac,
      port: e.port,
      vlan: e.vlan,
      type: 'dynamic',
    }));
  }

  async getPortStatus() {
    const world = buildBranchWorld(this.device.branch_id);
    const ports = new Map();
    for (const e of world.endpoints) {
      if (!ports.has(e.port)) ports.set(e.port, { port: e.port, status: 'up', vlan: e.vlan, mac_count: 0 });
      ports.get(e.port).mac_count++;
    }
    return [...ports.values()];
  }
}

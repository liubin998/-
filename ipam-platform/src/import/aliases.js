import { BUSINESS_STATUS } from '../domain/ipLedger.js';

export const FIELD_ALIASES = {
  address: ['address', 'ip', 'ip地址', 'ip 地址', 'ipaddress', '地址', '主机地址'],
  business_status: ['status', 'business_status', '状态', '业务状态', '使用状态'],
  mac: ['mac', 'mac地址', 'mac 地址', '物理地址', '硬件地址', 'macaddress'],
  subnet_cidr: ['subnet', 'subnet_cidr', 'cidr', '网段', '子网', '子网段', '网络段'],
  branch: ['branch', 'branch_name', '分支', '分支机构', '站点', '分部', '分公司', '区域'],
  description: ['description', 'desc', 'remark', 'remarks', '备注', '说明', '描述', '用途说明'],
  purpose: ['purpose', '用途'],
  kind: ['kind', 'type', '类型', '网段类型'],
  vlan: ['vlan', 'vlan id', 'vlanid', '虚拟局域网'],
  gateway: ['gateway', '网关', '默认网关'],
};

export const STATUS_ALIASES = {
  free: ['free', '空闲', '可用', '未使用'],
  occupied: ['occupied', '占用', '使用中', '已使用', '在用'],
  reserved: ['reserved', '预留', '保留'],
  released: ['released', '已释放', '释放'],
  conflict: ['conflict', '冲突'],
  unavailable: ['unavailable', '不可用', '禁用', '保留不用'],
  pending: ['pending', '待确认', '待定'],
};

export function mapStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const [canonical, aliases] of Object.entries(STATUS_ALIASES)) {
    if (aliases.includes(v)) return canonical;
  }
  return BUSINESS_STATUS.includes(v) ? v : undefined;
}

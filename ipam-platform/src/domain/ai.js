import { db } from '../db.js';
import { isValidIp, normalizeIp, cidrRange } from './ip.js';
import { diagnoseIp, FIELD_STATUS } from './diagnosis.js';
import { subnetStats } from './subnet.js';
import { findFreeInSubnet } from './ipLedger.js';

const STATUS_LABEL = {
  free: '空闲', occupied: '占用', reserved: '预留', released: '已释放',
  conflict: '冲突', unavailable: '不可用', pending: '待确认',
};

function branchClause(userCtx, alias = '') {
  if (userCtx.is_hq_admin) return { sql: '', vals: [] };
  if (!userCtx.branch_ids.length) return { sql: ' AND 1=0 ', vals: [] };
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  return {
    sql: ` AND (${col} IN (${userCtx.branch_ids.map(() => '?').join(',')}) OR ${col} IS NULL) `,
    vals: [...userCtx.branch_ids],
  };
}

function extractIp(text) {
  const m = text.match(/((?:\d{1,3}\.){3}\d{1,3})|([0-9a-fA-F:]*:[0-9a-fA-F:]+)/);
  return m ? (m[1] || m[2]) : null;
}

function extractCidr(text) {
  const m = text.match(/((?:\d{1,3}\.){3}\d{1,3}\/\d{1,2})|([0-9a-fA-F:]+::?[0-9a-fA-F:]*\/\d{1,3})/i);
  return m ? (m[1] || m[2]) : null;
}

function extractCount(text) {
  const m = text.match(/(\d+)\s*个/);
  return m ? Math.min(Number(m[1]), 100) : 10;
}

export function answerQuestion(question, userCtx) {
  const q = String(question || '').trim();
  const caveats = ['AI 仅能访问您当前权限范围内的数据，结果以规则引擎与台账为准。'];
  const ip = extractIp(q);
  const cidr = extractCidr(q);

  if (ip && isValidIp(ip)) {
    const ledger = db.prepare('SELECT * FROM ip_ledger WHERE address = ?').get(normalizeIp(ip));
    if (ledger?.branch_id && !userCtx.is_hq_admin && !userCtx.branch_ids.includes(ledger.branch_id)) {
      return { intent: 'ip_detail', answer: `IP ${ip} 属于您无权访问的分支，已按权限过滤。`, data: null, caveats };
    }
    const diag = diagnoseIp(ip, { includeEvidence: true });
    const ledgerText = diag.ledger
      ? `台账状态「${STATUS_LABEL[diag.ledger.business_status] || diag.ledger.business_status}」，MAC ${diag.ledger.mac || '未登记'}，归属网段 ${diag.ledger.subnet_cidr || '未归属'}。`
      : '台账中没有该 IP 的记录。';
    const conflictText = diag.conflict ? `注意：${diag.conflict.message}。` : '';
    return {
      intent: 'ip_detail',
      answer: `IP ${ip}：现场诊断为「${diag.field_status_label}」（置信度 ${diag.confidence}）。${ledgerText}${conflictText}共 ${diag.evidence_count} 条新鲜证据。`,
      data: diag,
      caveats,
    };
  }

  if (cidr) {
    try {
      const range = cidrRange(cidr);
      const subnet = db.prepare('SELECT * FROM subnets WHERE cidr = ?').get(range.cidr);
      if (!subnet) return { intent: 'subnet_detail', answer: `网段 ${range.cidr} 未登记。`, data: { range: { cidr: range.cidr, prefix: range.prefix, total: range.total.toString() } }, caveats };
      if (subnet.branch_id && !userCtx.is_hq_admin && !userCtx.branch_ids.includes(subnet.branch_id)) {
        return { intent: 'subnet_detail', answer: `网段 ${range.cidr} 属于您无权访问的分支，已按权限过滤。`, data: null, caveats };
      }
      const stats = subnetStats(subnet);
      if (/空闲|可用|可用地址|找.*(个|地址)/.test(q)) {
        const count = extractCount(q);
        const free = findFreeInSubnet({ ...subnet, first_usable: range.firstUsable }, { count });
        return {
          intent: 'free_ips',
          answer: free.length
            ? `在 ${range.cidr} 中找到 ${free.length} 个台账未登记的候选地址：${free.join('、')}。这些仅是台账层面的候选，启用前建议先做现场诊断。`
            : `在 ${range.cidr} 中未找到台账空闲地址。`,
          data: { cidr: range.cidr, free },
          caveats,
        };
      }
      return {
        intent: 'subnet_detail',
        answer: `网段 ${subnet.cidr}：容量 ${stats.total}，已记录 ${stats.recorded}，占用 ${stats.occupied}，空闲约 ${stats.free_approx}，使用率 ${stats.usage_pct}%。`,
        data: { subnet, stats },
        caveats,
      };
    } catch (e) {
      return { intent: 'subnet_detail', answer: `网段格式无法解析：${e.message}`, data: null, caveats };
    }
  }

  const bc = branchClause(userCtx);

  if (/冲突/.test(q)) {
    const rows = db.prepare(`
      SELECT id, title, ip, severity, status FROM tickets
      WHERE type IN ('ip_conflict_multi_mac','mac_mismatch') AND status IN ('open','in_progress') ${bc.sql}
      ORDER BY created_at DESC LIMIT 20
    `).all(...bc.vals);
    return {
      intent: 'conflicts',
      answer: rows.length ? `当前有 ${rows.length} 个未解决的 IP 冲突相关事项。` : '当前权限范围内没有未解决的冲突事项。',
      data: { tickets: rows },
      caveats,
    };
  }

  if (/未登记|未注册|黑户/.test(q)) {
    const rows = db.prepare(`
      SELECT id, title, ip, severity, status FROM tickets
      WHERE type = 'unregistered_use' AND status IN ('open','in_progress') ${bc.sql}
      ORDER BY created_at DESC LIMIT 20
    `).all(...bc.vals);
    return {
      intent: 'unregistered',
      answer: rows.length ? `发现 ${rows.length} 个疑似未登记使用的 IP，需要人工核实并补录或清理。` : '当前权限范围内没有未登记使用的事项。',
      data: { tickets: rows },
      caveats,
    };
  }

  if (/离线|采集失败|设备状态/.test(q)) {
    const rows = db.prepare("SELECT id, name, vendor, status, last_error, last_comm_at FROM devices WHERE status IN ('offline','error')").all();
    return {
      intent: 'device_health',
      answer: rows.length ? `有 ${rows.length} 台设备离线或采集失败，相关网段的现场诊断将标记为无法判断而不是空闲。` : '所有设备采集正常。',
      data: { devices: rows },
      caveats,
    };
  }

  if (/统计|汇总|多少|占比|使用率/.test(q)) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ip_ledger WHERE 1=1 ${bc.sql}`).get(...bc.vals).c;
    const byStatus = db.prepare(`SELECT business_status, COUNT(*) AS c FROM ip_ledger WHERE 1=1 ${bc.sql} GROUP BY business_status`).all(...bc.vals);
    const parts = byStatus.map((r) => `${STATUS_LABEL[r.business_status] || r.business_status} ${r.c}`);
    return {
      intent: 'stats',
      answer: `权限范围内台账共 ${total} 条记录：${parts.join('，') || '无'}。`,
      data: { total, byStatus },
      caveats,
    };
  }

  const statusHit = Object.entries(STATUS_LABEL).find(([, label]) => q.includes(label));
  if (statusHit) {
    const rows = db.prepare(`
      SELECT id, address, business_status, mac, description FROM ip_ledger
      WHERE business_status = ? ${bc.sql} LIMIT 50
    `).all(statusHit[0], ...bc.vals);
    return {
      intent: 'status_query',
      answer: `找到 ${rows.length} 条状态为「${statusHit[1]}」的记录${rows.length >= 50 ? '（最多显示 50 条）' : ''}。`,
      data: { ips: rows },
      caveats,
    };
  }

  return {
    intent: 'unknown',
    answer: '我可以帮您：查询某个 IP 的状态与现场诊断（如「10.1.2.3 谁在用」）、查看网段容量（如「10.1.0.0/24 使用情况」）、在某网段找空闲地址（如「在 10.1.0.0/24 找 5 个空闲 IP」）、统计台账状态、列出冲突或未登记事项。请尝试更具体的问法。',
    data: null,
    caveats,
  };
}

export { FIELD_STATUS };

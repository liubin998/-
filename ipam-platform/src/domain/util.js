const SECRET_KEYS = new Set([
  'shared_secret', 'sharedSecret', 'secret', 'password', 'password_hash',
  'token', 'credential', 'credential_ref', 'random', 'md5',
]);

export function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.has(k)) {
        out[k] = v === null || v === undefined || v === '' ? null : '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return obj;
}

export function parsePagination(query, { defaultLimit = 20, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function paged(rows, total, { page, limit }) {
  return { items: rows, page, limit, total };
}

export function jsonCol(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeMac(input) {
  if (!input) return null;
  const hex = String(input).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return String(input).toLowerCase();
  return hex.match(/.{2}/g).join(':');
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export function diffRecord(before, after) {
  const b = before || {};
  const a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changes = {};
  for (const k of keys) {
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      changes[k] = { before: b[k] ?? null, after: a[k] ?? null };
    }
  }
  return changes;
}

export function validateEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    const e = new Error(`${label} 非法: ${value}`);
    e.status = 400;
    throw e;
  }
  return value;
}

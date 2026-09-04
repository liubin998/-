export class IpError extends Error {
  constructor(message, code = 'IP_INVALID') {
    super(message);
    this.code = code;
  }
}

export function familyOf(value) {
  const buf = toBuffer(value);
  return buf.length === 4 ? 4 : 6;
}

export function toBuffer(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length === 4 || input.length === 16) return input;
    throw new IpError(`非法地址字节长度: ${input.length}`);
  }
  const text = normalizeText(input);
  const v4 = parseV4(text);
  if (v4) return v4;
  const v6 = parseV6(text);
  if (v6) return v6;
  throw new IpError(`无法解析 IP 地址: ${input}`);
}

export function fromBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  if (b.length === 16) return formatV6(b);
  throw new IpError(`非法地址字节长度: ${b.length}`);
}

function parseV4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === '0') return null;
    const n = Number(p);
    if (n > 255) return null;
    buf[i] = n;
  }
  return buf;
}

function splitV6Groups(part) {
  if (part === '') return [];
  const segs = part.split(':');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === segs.length - 1 && seg.includes('.')) {
      const v4 = parseV4(seg);
      if (!v4) return null;
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
  }
  return out;
}

function parseV6(text) {
  let t = text;
  const zone = t.indexOf('%');
  if (zone >= 0) t = t.slice(0, zone);
  if (!t.includes(':')) return null;
  let groups;
  const dcIdx = t.indexOf('::');
  if (dcIdx >= 0) {
    if (t.indexOf('::', dcIdx + 1) >= 0) return null;
    const head = splitV6Groups(t.slice(0, dcIdx));
    const tail = splitV6Groups(t.slice(dcIdx + 2));
    if (head === null || tail === null) return null;
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    groups = splitV6Groups(t);
    if (groups === null || groups.length !== 8) return null;
  }
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i], i * 2);
  return buf;
}

function formatV6(buf) {
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(i * 2));
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

export function bufferToBigInt(buf) {
  let v = 0n;
  for (const byte of buf) v = (v << 8n) | BigInt(byte);
  return v;
}

export function bigIntToBuffer(v, size) {
  const buf = Buffer.alloc(size);
  let x = v;
  for (let i = size - 1; i >= 0; i--) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}

function normalizeText(input) {
  if (typeof input !== 'string') throw new IpError('IP 必须是字符串');
  const t = input.trim();
  if (!t) throw new IpError('IP 不能为空');
  return t;
}

export function normalizeIp(input) {
  return fromBuffer(toBuffer(input));
}

export function isValidIp(input) {
  try {
    toBuffer(input);
    return true;
  } catch {
    return false;
  }
}

export function maskToPrefix(mask) {
  const buf = toBuffer(mask);
  const bits = bufferToBigInt(buf);
  const total = BigInt(buf.length * 8);
  if (bits === 0n) return 0;
  const inv = ((1n << total) - 1n) ^ bits;
  if ((inv & (inv + 1n)) !== 0n) {
    throw new IpError(`子网掩码不连续: ${mask}`, 'MASK_NOT_CONTIGUOUS');
  }
  let prefix = 0;
  let v = bits;
  const top = 1n << (total - 1n);
  while (prefix < total && (v & top) !== 0n) {
    prefix++;
    v = (v << 1n) & ((1n << total) - 1n);
  }
  return prefix;
}

export function prefixToMask(prefix, family) {
  const total = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > total) {
    throw new IpError(`前缀长度非法: ${prefix}`, 'PREFIX_INVALID');
  }
  const bits = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(total - prefix));
  return fromBuffer(bigIntToBuffer(bits, family === 4 ? 4 : 16));
}

export function parseCidr(input) {
  const text = normalizeText(input);
  const slash = text.indexOf('/');
  if (slash < 0) throw new IpError(`缺少前缀长度: ${input}`, 'CIDR_INVALID');
  const addrPart = text.slice(0, slash);
  const prefixPart = text.slice(slash + 1);
  const buf = toBuffer(addrPart);
  const family = buf.length === 4 ? 4 : 6;
  const total = family === 4 ? 32 : 128;
  let prefix;
  if (prefixPart.includes('.')) {
    prefix = maskToPrefix(prefixPart);
  } else {
    prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > total) {
      throw new IpError(`前缀长度非法: ${prefixPart}`, 'PREFIX_INVALID');
    }
  }
  return { address: fromBuffer(buf), prefix, family };
}

export function cidrRange(cidrText) {
  const { address, prefix, family } = parseCidr(cidrText);
  const size = family === 4 ? 4 : 16;
  const total = BigInt(size * 8);
  const addr = bufferToBigInt(toBuffer(address));
  const hostBits = total - BigInt(prefix);
  const networkBits = prefix === 0 ? 0n : (addr >> hostBits) << hostBits;
  const broadcastBits = networkBits + ((1n << hostBits) - 1n);
  return {
    cidr: `${fromBuffer(bigIntToBuffer(networkBits, size))}/${prefix}`,
    family,
    prefix,
    network: fromBuffer(bigIntToBuffer(networkBits, size)),
    broadcast: family === 4 ? fromBuffer(bigIntToBuffer(broadcastBits, size)) : null,
    firstUsable:
      family === 4 && prefix >= 31
        ? fromBuffer(bigIntToBuffer(networkBits, size))
        : fromBuffer(bigIntToBuffer(networkBits + 1n, size)),
    lastUsable:
      family === 4 && prefix >= 31
        ? fromBuffer(bigIntToBuffer(broadcastBits, size))
        : fromBuffer(bigIntToBuffer(broadcastBits - 1n, size)),
    startBuf: bigIntToBuffer(networkBits, size),
    endBuf: bigIntToBuffer(broadcastBits, size),
    total: 1n << hostBits,
  };
}

export function ipInRange(ipText, cidrText) {
  const r = cidrRange(cidrText);
  const ipBuf = toBuffer(ipText);
  if (ipBuf.length !== r.startBuf.length) return false;
  return ipBuf.compare(r.startBuf) >= 0 && ipBuf.compare(r.endBuf) <= 0;
}

export function containsCidr(outer, inner) {
  const a = cidrRange(outer);
  const b = cidrRange(inner);
  if (a.family !== b.family) return false;
  if (b.prefix < a.prefix) return false;
  return b.startBuf.compare(a.startBuf) >= 0 && b.endBuf.compare(a.endBuf) <= 0;
}

export function overlapsCidr(aText, bText) {
  const a = cidrRange(aText);
  const b = cidrRange(bText);
  if (a.family !== b.family) return false;
  return a.startBuf.compare(b.endBuf) <= 0 && b.startBuf.compare(a.endBuf) <= 0;
}

export function relation(aText, bText) {
  if (!overlapsCidr(aText, bText)) return 'none';
  const a = cidrRange(aText);
  const b = cidrRange(bText);
  if (a.cidr === b.cidr) return 'equal';
  if (containsCidr(aText, bText)) return 'contains';
  if (containsCidr(bText, aText)) return 'inside';
  return 'overlap';
}

export function capacity(prefix, family) {
  const total = family === 4 ? 32 : 128;
  return 1n << BigInt(total - prefix);
}

export function ipv4ReservedCount(prefix, policy = {}) {
  const total = capacity(prefix, 4);
  if (prefix >= 31) return 0n;
  let reserved = policy.keepNetwork === false ? 0n : 1n;
  reserved += policy.keepBroadcast === false ? 0n : 1n;
  if (policy.keepGateway !== false && total > 3n) reserved += 1n;
  reserved += BigInt(policy.extraReserved || 0);
  return reserved > total ? total : reserved;
}

export function describeCapacity(prefix, family, policy = {}) {
  const total = capacity(prefix, family);
  if (family === 4) {
    return { total, reserved: ipv4ReservedCount(prefix, policy) };
  }
  return { total, reserved: 0n };
}

export function incrementIp(ipText, step = 1n) {
  const buf = toBuffer(ipText);
  const v = bufferToBigInt(buf) + step;
  const max = (1n << BigInt(buf.length * 8)) - 1n;
  if (v < 0n || v > max) throw new IpError('IP 越界');
  return fromBuffer(bigIntToBuffer(v, buf.length));
}

export function compareIpBuf(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a.compare(b);
}

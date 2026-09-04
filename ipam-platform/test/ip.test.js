import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IpError, familyOf, toBuffer, fromBuffer, normalizeIp, isValidIp,
  maskToPrefix, prefixToMask, parseCidr, cidrRange, ipInRange,
  containsCidr, overlapsCidr, relation, capacity, ipv4ReservedCount,
  describeCapacity, incrementIp,
} from '../src/domain/ip.js';

test('IPv4 解析与归一化', () => {
  assert.deepEqual([...toBuffer('10.0.0.1')], [10, 0, 0, 1]);
  assert.equal(normalizeIp(' 192.168.1.10 '), '192.168.1.10');
  assert.equal(familyOf('10.0.0.1'), 4);
  assert.equal(fromBuffer(Buffer.from([1, 2, 3, 4])), '1.2.3.4');
});

test('IPv4 非法输入全部拒绝', () => {
  for (const bad of ['10.0.0', '10.0.0.1.2', '256.1.1.1', '10.00.0.1', '010.0.0.1', 'a.b.c.d', '10.0.0.-1', '']) {
    assert.equal(isValidIp(bad), false, `应当拒绝: ${bad}`);
  }
  assert.throws(() => toBuffer(12345), IpError);
  assert.throws(() => toBuffer('   '), IpError);
});

test('IPv6 解析：压缩/内嵌 IPv4/zone id', () => {
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(normalizeIp('::'), '::');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('::ffff:192.168.1.1'), '::ffff:c0a8:101');
  assert.equal(familyOf('2001:db8::1'), 6);
  assert.equal(normalizeIp('2001:db8:0:1:2:3:4:5'), '2001:db8:0:1:2:3:4:5');
});

test('IPv6 非法输入全部拒绝', () => {
  for (const bad of ['1::2::3', ':::', '1:2:3:4:5:6:7:8:9', 'gggg::1', '1:2:3:4:5:6:7']) {
    assert.equal(isValidIp(bad), false, `应当拒绝: ${bad}`);
  }
});

test('格式化遵循最长零段压缩', () => {
  assert.equal(fromBuffer(toBuffer('2001:db8:0:1:0:0:0:1')), '2001:db8:0:1::1');
  assert.equal(fromBuffer(Buffer.alloc(16)), '::');
});

test('掩码与前缀互转', () => {
  assert.equal(maskToPrefix('255.255.255.0'), 24);
  assert.equal(maskToPrefix('255.255.240.0'), 20);
  assert.equal(maskToPrefix('0.0.0.0'), 0);
  assert.equal(maskToPrefix('255.255.255.255'), 32);
  assert.throws(() => maskToPrefix('255.0.255.0'), /不连续/);
  assert.equal(prefixToMask(20, 4), '255.255.240.0');
  assert.equal(prefixToMask(0, 4), '0.0.0.0');
  assert.equal(prefixToMask(32, 4), '255.255.255.255');
  assert.equal(prefixToMask(64, 6), 'ffff:ffff:ffff:ffff::');
  assert.throws(() => prefixToMask(33, 4), IpError);
});

test('parseCidr 支持数字前缀与掩码形式', () => {
  assert.deepEqual(parseCidr('10.0.0.5/24'), { address: '10.0.0.5', prefix: 24, family: 4 });
  assert.deepEqual(parseCidr('10.0.0.5/255.255.255.0'), { address: '10.0.0.5', prefix: 24, family: 4 });
  assert.deepEqual(parseCidr('2001:db8::/32'), { address: '2001:db8::', prefix: 32, family: 6 });
  assert.throws(() => parseCidr('10.0.0.1'), IpError);
  assert.throws(() => parseCidr('10.0.0.1/33'), IpError);
});

test('cidrRange IPv4 /24 边界计算', () => {
  const r = cidrRange('192.168.1.0/24');
  assert.equal(r.cidr, '192.168.1.0/24');
  assert.equal(r.network, '192.168.1.0');
  assert.equal(r.broadcast, '192.168.1.255');
  assert.equal(r.firstUsable, '192.168.1.1');
  assert.equal(r.lastUsable, '192.168.1.254');
  assert.equal(r.total, 256n);
});

test('cidrRange 非规范地址归一化', () => {
  assert.equal(cidrRange('10.0.0.5/24').cidr, '10.0.0.0/24');
  assert.equal(cidrRange('10.0.3.200/8').cidr, '10.0.0.0/8');
});

test('cidrRange /31 与 /32 特殊处理', () => {
  const r31 = cidrRange('192.168.1.0/31');
  assert.equal(r31.firstUsable, '192.168.1.0');
  assert.equal(r31.lastUsable, '192.168.1.1');
  assert.equal(r31.total, 2n);
  const r32 = cidrRange('192.168.1.7/32');
  assert.equal(r32.network, '192.168.1.7');
  assert.equal(r32.firstUsable, '192.168.1.7');
  assert.equal(r32.lastUsable, '192.168.1.7');
  assert.equal(r32.total, 1n);
});

test('cidrRange IPv6 无广播地址', () => {
  const r = cidrRange('2001:db8::1/32');
  assert.equal(r.cidr, '2001:db8::/32');
  assert.equal(r.broadcast, null);
  assert.equal(r.firstUsable, '2001:db8::1');
  assert.equal(r.total, 1n << 96n);
});

test('ipInRange 含跨族判断', () => {
  assert.equal(ipInRange('10.0.0.55', '10.0.0.0/24'), true);
  assert.equal(ipInRange('10.0.1.1', '10.0.0.0/24'), false);
  assert.equal(ipInRange('2001:db8::5', '2001:db8::/32'), true);
  assert.equal(ipInRange('10.0.0.1', '2001:db8::/32'), false);
});

test('containsCidr / overlapsCidr', () => {
  assert.equal(containsCidr('10.0.0.0/24', '10.0.0.0/25'), true);
  assert.equal(containsCidr('10.0.0.0/25', '10.0.0.0/24'), false);
  assert.equal(containsCidr('10.0.0.0/24', '2001:db8::/32'), false);
  assert.equal(overlapsCidr('10.0.0.0/24', '10.0.0.128/25'), true);
  assert.equal(overlapsCidr('10.0.0.0/25', '10.0.0.128/25'), false);
});

test('relation 区分 equal/contains/inside/none', () => {
  assert.equal(relation('10.0.0.0/24', '10.0.0.5/24'), 'equal');
  assert.equal(relation('10.0.0.0/24', '10.0.0.0/25'), 'contains');
  assert.equal(relation('10.0.0.0/25', '10.0.0.0/24'), 'inside');
  assert.equal(relation('10.0.0.0/25', '10.0.0.128/25'), 'none');
  assert.equal(relation('10.0.0.0/24', '2001:db8::/32'), 'none');
});

test('容量与保留数计算', () => {
  assert.equal(capacity(24, 4), 256n);
  assert.equal(capacity(32, 6), 1n << 96n);
  assert.equal(capacity(128, 6), 1n);
  assert.equal(ipv4ReservedCount(24), 3n);
  assert.equal(ipv4ReservedCount(24, { keepGateway: false }), 2n);
  assert.equal(ipv4ReservedCount(24, { keepNetwork: false, keepBroadcast: false, keepGateway: false }), 0n);
  assert.equal(ipv4ReservedCount(31), 0n);
  assert.equal(ipv4ReservedCount(24, { extraReserved: 2 }), 5n);
  const d = describeCapacity(64, 6);
  assert.equal(d.reserved, 0n);
});

test('incrementIp 进位与越界', () => {
  assert.equal(incrementIp('10.0.0.255'), '10.0.1.0');
  assert.equal(incrementIp('10.0.0.1', 10n), '10.0.0.11');
  assert.equal(incrementIp('::ffff'), '::1:0');
  assert.throws(() => incrementIp('255.255.255.255'), IpError);
});

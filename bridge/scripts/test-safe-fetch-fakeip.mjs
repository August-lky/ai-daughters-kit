// 代理虚拟 IP 模式（2026-10-26）：198.18.0.0/15 的占位地址查一次真实地址，公网放行、内网拦、查不到拦。
import assert from 'node:assert/strict';
import { isFakeIp, realAddresses, resolveSafeAddresses } from '../src/safe-fetch.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

assert.ok(isFakeIp('198.18.0.32') && isFakeIp('198.19.255.1'));
assert.ok(!isFakeIp('198.20.0.1') && !isFakeIp('10.0.0.1') && !isFakeIp('222.79.1.1'));
ok('虚拟地址段只认 198.18.0.0/15');

{
  const calls = [];
  const query = async (endpoint, host, type) => { calls.push([endpoint, type]); return type === 1 ? ['222.79.1.1'] : []; };
  assert.deepEqual(await realAddresses('img.example', { query, now: 1 }), ['222.79.1.1']);
  assert.deepEqual(await realAddresses('img.example', { query, now: 2 }), ['222.79.1.1'], '5 分钟内走缓存');
  assert.equal(calls.length, 2, '缓存命中不再查');
  const flaky = async (endpoint, host, type) => { if (endpoint.includes('223.5.5.5')) throw new Error('down'); return type === 1 ? ['1.2.3.4'] : []; };
  assert.deepEqual(await realAddresses('b.example', { query: flaky, now: 1 }), ['1.2.3.4'], '第一个 DNS 挂了换下一个');
  await assert.rejects(realAddresses('c.example', { query: async () => { throw new Error('down'); }, now: 1 }), /查不到真实地址/, '都查不到就拦');
  ok('真实地址：缓存、换备用、都失败就拦');
}

{
  // 真机：本机开着代理虚拟 IP 时才有意义；没开时这两条也该成立（公网照常过、内网照常拦）
  const pub = await resolveSafeAddresses('multimedia.nt.qq.com.cn');
  assert.ok(pub.length > 0, 'QQ 图床放行');
  await assert.rejects(resolveSafeAddresses('localtest.me'), /内网|本机/, '真实地址是 127.0.0.1 的域名照样拦');
  await assert.rejects(resolveSafeAddresses('127.0.0.1'), /内网|本机/);
  ok(`真机：QQ 图床放行（${pub[0]}${isFakeIp(pub[0]) ? '，虚拟地址' : ''}），指向本机的域名照样拦`);
}
console.log(`全部通过：${passed} 组`);

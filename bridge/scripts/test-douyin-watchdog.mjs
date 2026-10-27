// 抖音页面看门：超线才刷新；她在刷视频 / 在忙 / 私信在回都不动；调试口连不上就什么都不做。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reloadReason, checkDouyinPages, maybeRecycleEdge, withChatPaused, DEFAULT_DOUYIN_WATCHDOG } from '../src/douyin-page-watchdog.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

{
  const c = DEFAULT_DOUYIN_WATCHDOG;
  assert.equal(reloadReason({ nodes: 14420, heapMB: 366 }, c), null);
  assert.match(reloadReason({ nodes: 12_005_759, heapMB: 2395 }, c), /元素 1201 万/);
  assert.match(reloadReason({ nodes: 5000, heapMB: 2000 }, c), /JS 内存/);
  ok('超线才算：1200 万元素 / 2GB 内存要刷，1.4 万元素不刷');
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyw-'));
  const cfg = { ...DEFAULT_DOUYIN_WATCHDOG, watchLock: path.join(dir, 'watch-loop.lock') };
  // 调试口连不上
  const none = await checkDouyinPages({ cfg, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(none, []);
  // 没有抖音页面（只有新标签页）就不连 WebSocket
  const noDy = await checkDouyinPages({ cfg, fetchImpl: async () => ({ json: async () => [{ type: 'page', url: 'edge://newtab/' }] }) });
  assert.deepEqual(noDy, []);
  ok('浏览器没开 / 没有抖音页：什么都不做');
}

{
  // port:1 + 假的 kill：万一走进重开流程，也碰不到真的抖音 Edge（10-26 这里漏了一次，测试把真 Edge 杀了）
  const cfg = { ...DEFAULT_DOUYIN_WATCHDOG, port: 1 };
  const kill = async () => { throw new Error('这组用例不该走到重开'); };
  const logs = [];
  const log = (l) => logs.push(l);
  const notBusyChat = async () => ({ json: async () => ({ chat: { busy: false } }) });
  const busyChat = async () => ({ json: async () => ({ chat: { busy: true } }) });
  const t0 = 1_800_000_000_000;
  const r1 = await maybeRecycleEdge({ cfg, kill, memGB: async () => 1.7, fetchImpl: notBusyChat, log, now: t0 });
  assert.deepEqual(r1, { recycled: false, overSince: 0 }, '没到线不动');
  const r2 = await maybeRecycleEdge({ cfg, kill, memGB: async () => 12, isBusy: () => true, fetchImpl: notBusyChat, log, now: t0 });
  assert.deepEqual(r2, { recycled: false, overSince: t0 }, '她在忙先等，记下第一次到线的时间');
  const r3 = await maybeRecycleEdge({ cfg, kill, memGB: async () => 12, fetchImpl: busyChat, log, overSince: t0, now: t0 + 30e3 });
  assert.deepEqual(r3, { recycled: false, overSince: t0 }, '私信在回、还没等满 1 分钟，接着等');
  const r4 = await maybeRecycleEdge({ cfg, kill, memGB: async () => 0, fetchImpl: notBusyChat, log, now: t0 });
  assert.deepEqual(r4, { recycled: false, overSince: 0 }, '读不到内存不动');
  assert.equal(logs.length, 2, '等她的两次都记了一笔');
  ok('整个重开：没到线、读不到内存不动；她在忙、私信在回最多等 1 分钟');
}

{
  // 到线（正好 5GB 也算）就重开：等满 3 分钟她还在忙也照样重开；正常关完剩下的进程强制结束，核对到一个不剩
  const cfg = { ...DEFAULT_DOUYIN_WATCHDOG, port: 1 };
  const posts = [];
  const fakeFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') { posts.push(url.replace(/^.*douyin-browser/, '')); return { ok: true, json: async () => ({}) }; }
    if (/\/state$/.test(url)) return { ok: true, json: async () => ({ token: 't', chat: { running: true, busy: true }, watch: { running: false } }) };
    throw new Error('没有 Edge');
  };
  const logs = [];
  let kills = 0;
  const kill = async () => (++kills === 1 ? 3 : 0); // 第一次还剩 3 个，第二次清干净
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // 跳过等待
  try {
    const t0 = 1_800_000_000_000;
    const r = await maybeRecycleEdge({ cfg, memGB: async () => 5, isBusy: () => true, fetchImpl: fakeFetch, kill, log: (l) => logs.push(l), overSince: t0, now: t0 + 60e3 });
    assert.deepEqual(r, { recycled: true, overSince: 0 });
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(kills, 2, '剩下的进程强制结束，没清干净再来一次');
  assert.deepEqual(posts, ['/chat/stop', '/chat/start'], '先停私信，重开后接上');
  assert.match(logs[0], /5GB.*等了 1 分钟她还在忙，照样全部关掉重开/);
  assert.ok(!logs.some((l) => /还剩/.test(l)), '清干净了就不报');
  ok('到 5GB：等满 1 分钟照样重开，进程强制清干净，私信接上');
}

{
  // 刷新页面前后：私信开着先停、刷完再开；没开就直接刷，不碰私信
  const cfg = { ...DEFAULT_DOUYIN_WATCHDOG, settingsUrl: 'http://127.0.0.1:1/api/douyin-browser/state' };
  const make = (running) => {
    const calls = [];
    let on = running;
    const fetchImpl = async (url, init) => {
      const p = new URL(url).pathname.replace('/api/douyin-browser', '');
      if (init?.method === 'POST') { calls.push(p); if (p === '/chat/stop') on = false; if (p === '/chat/start') on = true; return { ok: true }; }
      return { json: async () => ({ token: 't', chat: { running: on, busy: false } }) };
    };
    return { calls, fetchImpl };
  };
  const a = make(true);
  const order = [];
  await withChatPaused({ cfg, fetchImpl: a.fetchImpl, wait: async () => {} }, async () => { order.push([...a.calls]); });
  assert.deepEqual(order[0], ['/chat/stop'], '刷新时私信已经停了');
  assert.deepEqual(a.calls, ['/chat/stop', '/chat/start'], '刷完接上私信');
  const b = make(false);
  let ran = false;
  await withChatPaused({ cfg, fetchImpl: b.fetchImpl, wait: async () => {} }, async () => { ran = true; });
  assert.ok(ran && b.calls.length === 0, '私信没开就不碰');
  const c = make(true);
  await assert.rejects(withChatPaused({ cfg, fetchImpl: c.fetchImpl, wait: async () => {} }, async () => { throw new Error('reload 超时'); }));
  assert.deepEqual(c.calls, ['/chat/stop', '/chat/start'], '刷新失败也把私信开回来');
  ok('刷新页面：私信开着先停再开（10-26 18:49 直接刷新把两个联系人弄暂停了），失败也接上');
}

console.log(`全部通过：${passed} 组`);

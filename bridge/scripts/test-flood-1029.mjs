// 刷屏提速（2026-10-29 主人）自检：全部离线，桥接跑在隔离的测试桩里（audit-bridge-harness），姐姐只测导出的纯函数 + 源码接线，
// 不碰活的 QQ / DSH / 配置 / 进程，不叫 claude。
// 覆盖：② 重放只补没读过的 + 多条暂存合并成一次；③ 快照一次给够（条数 / 字数）；④ 小鲸鱼图片预取（只对叫她的那条、命中缓存、有上限和过期）；
//       ⑤ 姐姐群唤醒最多 1 张图、优先叫她的那条、跳过别人发的动画表情；⑥ rotateIdleMin；⑦ 防抖最长等 8 秒。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  planImages, groupMaxImagesOf, selectGroupImageRefs, isAnimatedImageRef, groupDebounceDelayMs, groupMaxWaitMsOf, rotateIdleMsOf
} from '../sister/sister.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, run) {
  try { await run(); passed += 1; console.log('✅', name); }
  catch (error) { failures += 1; console.error('❌', name, error.stack); }
}
async function withBridge(config, run) {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] }, ...config } });
  h.setMode('reserved2');
  h.setSelfIdentity('小鲸鱼测试', '999');
  try { await run(h); } finally { await h.close(); }
}
const KEY = 'group:456';
/** 往群里塞 n 条消息（seq 从当前水位继续），返回这些消息的 seq。 */
function feed(h, n, from = 0) {
  const seqs = [];
  for (let i = 0; i < n; i += 1) {
    h.appendSocialV2Message(KEY, `群友${from + i}`, `第${from + i}句话`, `第${from + i}句话`, false, false, 9000 + from + i, [], String(5000 + i));
    seqs.push(h.getSocialV2State(KEY).lastUnreadSeq);
  }
  return seqs;
}
const clearWake = (h) => { const st = h.getSocialV2State(KEY); if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; };

// ── ② 重放判断 ──────────────────────────────────────────────────────────────
await test('② 刷屏时：暂存的 @ 那条她已经读过 → 不补叫醒（以前 seq >= 条件永远为真）', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    const st = h.getSocialV2State(KEY);
    const [s1, s2, s3, s4, s5] = feed(h, 5);
    // 这一轮她读到了 s3：1~3 标读，4、5 是刷屏里新进来的
    st.unread = st.unread.filter((m) => m.seq > s3);
    st.pendingWakeReasons = [{ reason: 'atMention', seq: s1 }, { reason: 'nameMention', seq: s2 }];
    const r = h.replayPendingWakeReasonsV2(KEY);
    assert.equal(r.action, 'skipped', `读过的 @ 不补发（实际 ${JSON.stringify(r)}）`);
    assert.equal(r.merged, 0);
    assert.equal(st.pendingWakeTimer, null, '没有排出新的唤醒');
    assert.equal(st.pendingWakeReasons.length, 0);
    assert.ok(s4 > s1 && s5 > s2, '前提：后面确实有更新的未读（旧条件下这会让它们全部补发）');
  });
});

await test('② 那条消息还在未读里 → 照补（只补没读过的）', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    const st = h.getSocialV2State(KEY);
    const [s1, s2, s3] = feed(h, 3);
    st.pendingWakeReasons = [{ reason: 'atMention', seq: s2 }];
    const r = h.replayPendingWakeReasonsV2(KEY);
    assert.equal(r.action, 'replayed');
    assert.equal(r.reason, 'atMention');
    assert.ok(st.pendingWakeTimer, '排出了一次唤醒');
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.ok(s1 < s2 && s2 < s3);
    clearWake(h);
  });
});

await test('② 多条暂存：没读过的合并成一次唤醒，原因取优先级最高的，读过的不算', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    const st = h.getSocialV2State(KEY);
    const [s1, s2, s3, s4, s5] = feed(h, 5);
    st.unread = st.unread.filter((m) => m.seq > s1); // s1 她读过了
    st.pendingWakeReasons = [
      { reason: 'atMention', seq: s1 },     // 读过 → 丢
      { reason: 'nameMention', seq: s2 },   // 没读
      { reason: 'question', seq: s4 },      // 没读，优先级比 nameMention 高
      { reason: 'keyword:小鲸鱼', seq: s5 }, // 没读，优先级最低
    ];
    const r = h.replayPendingWakeReasonsV2(KEY);
    assert.equal(r.action, 'replayed');
    assert.equal(r.merged, 3, '三条没读过的并成一次');
    assert.equal(r.reason, 'question', '原因取优先级最高的');
    assert.equal(st.pendingWakeReasons.length, 0, '一个回合结束就把暂存的全部看完，不再一回合只补一条');
    assert.ok(st.pendingWakeTimer);
    assert.equal(st.pendingWakeReason, 'question');
    assert.ok(s3 > s2, '（s3 夹在中间没有暂存原因，不影响）');
    // 再调一次什么都没有：不会再排第二次唤醒
    assert.equal(h.replayPendingWakeReasonsV2(KEY), null);
    clearWake(h);
  });
});

await test('② 定时器类（timeout）仍按定时器语义补，同一次里消息类照样合并', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    const st = h.getSocialV2State(KEY);
    const [, s2] = feed(h, 2);
    st.pendingWakeReasons = [{ reason: 'proactiveCheck', seq: 0 }, { reason: 'atMention', seq: s2 }];
    const r = h.replayPendingWakeReasonsV2(KEY);
    assert.equal(r.action, 'timer', 'proactiveCheck 走定时器类（跳过）');
    assert.equal(r.merged, 1, '同一次里的 @ 照样补');
    assert.equal(st.pendingWakeReason, 'atMention');
    clearWake(h);
  });
});

await test('② 源码：不再有 seq >= item.seq 的判断，也不再递归逐条补', () => {
  const src = read('src/bridge.js');
  const body = src.slice(src.indexOf('function replayPendingWakeReasonsV2'), src.indexOf('function setupSleepTimerV2'));
  assert.ok(!/Number\(m\.seq\) >= Number\(item\.seq\)/.test(body), '旧的 >= 判断已去掉');
  assert.ok(!/replayPendingWakeReasonsV2\(key\) \?\?/.test(body), '不再每回合递归只补一条');
  assert.match(body, /unreadSeqs\.has\(seq\)/, '改成那条消息本身还在 unread 里才算没读过');
});

// ── ③ 快照一次给够 ──────────────────────────────────────────────────────────
await test('③ 快照条数：默认 / config 都是 30 条、14000 字，未读 40 条一次带满 30 条', async () => {
  const cfg = JSON.parse(read('config.json'));
  assert.equal(cfg.socialV2.context.wakeMessageLimit, 30);
  assert.equal(cfg.socialV2.context.wakeMaxChars, 14000);
  const ex = JSON.parse(read('config.example.json'));
  assert.equal(ex.socialV2.context.wakeMessageLimit, 30);
  assert.equal(ex.socialV2.context.wakeMaxChars, 14000);
  await withBridge({ socialV2: { context: { unreadLimit: 60 } } }, async (h) => {
    // 配置里没写 wakeMessageLimit / wakeMaxChars：用代码里的新默认（30 条 / 14000 字）
    feed(h, 40);
    const snap = h.buildWakeSnapshotV2(KEY);
    assert.equal(snap.messages.length, 30, `一次带满 30 条（实际 ${snap.messages.length}）`);
    assert.equal(snap.unreadCount, 40);
    assert.ok(JSON.stringify(snap).length <= 14000);
  });
  await withBridge({ socialV2: { context: { unreadLimit: 60, wakeMessageLimit: 100, wakeMaxChars: 20000 } } }, async (h) => {
    feed(h, 60);
    assert.equal(h.buildWakeSnapshotV2(KEY).messages.length, 60, '上限（100 条 / 20000 字）没有被新默认值压低');
  });
  const src = read('src/bridge.js');
  assert.match(src, /bounded\('wakeMaxChars', 14000, 500, 20000\)/);
  assert.match(src, /bounded\('wakeMessageLimit', 30, 1, 100\)/);
});

// ── ④ 小鲸鱼图片预取 ────────────────────────────────────────────────────────
const imgEv = (id, mid, extra = {}, segs = []) => ({
  self_id: 999, user_id: id, message_id: mid,
  message: [...segs, { type: 'image', data: { file: `${String(mid).padStart(8, '0')}abcdef0123456789abcdef.jpg`, summary: '[图片]' } }],
  raw_message: '[图片]', sender: { nickname: `昵称${id}`, card: '' }, ...extra
});
const AT_ME = [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' 看这个' } }];
const settle = async (h) => { for (const e of new Set(h.imagePrefetch.values())) await e.promise; await sleep(20); };

await test('④ 刷屏里别人的图不预取；@ 她那条的图消息一到就预取，取图命中缓存不再下第二遍', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    // 刷屏：5 条别人发的图，没 @ 她
    for (let i = 0; i < 5; i += 1) await h.handleIncoming('group', '456', imgEv(555, 7100 + i), h.cfg);
    await sleep(30);
    assert.equal(h.imagePrefetch.size, 0, '没叫她的图一张都不预取');
    assert.equal(h.calls.images.length, 0, '一次下载都没有');
    // @ 她的那条带图
    await h.handleIncoming('group', '456', imgEv(555, 7200, {}, AT_ME), h.cfg);
    assert.ok(h.imagePrefetch.size > 0, '开了预取');
    await settle(h);
    assert.equal(h.calls.images.length, 1, '预取下了一遍');
    // 她调 qq_get_message_images（同一个 messageId）→ 命中缓存
    const media = h.findMessageMedia(KEY, '7200');
    const images = await h.loadMessageImagesV2(KEY, '7200', media);
    assert.ok(images.length === 1 && images[0].data, '拿到处理好的图');
    assert.equal(h.calls.images.length, 1, '没有再下第二遍');
    assert.equal(h.imagePrefetchStats.hits, 1);
    // 用本地序号取也命中（工具既认 messageId 也认 seq）
    const seq = h.getSocialV2State(KEY).lastUnreadSeq;
    await h.loadMessageImagesV2(KEY, String(seq), media);
    assert.equal(h.calls.images.length, 1);
    assert.equal(h.imagePrefetchStats.hits, 2);
    // 刷屏里别人的那条没预取过：取图是现取（未命中）
    const floodMedia = h.findMessageMedia(KEY, '7100');
    assert.ok(floodMedia.length === 1);
    await h.loadMessageImagesV2(KEY, '7100', floodMedia);
    assert.equal(h.imagePrefetchStats.misses, 1);
    assert.equal(h.calls.images.length, 2);
    for (const k of ['group:456']) { const st = h.getSocialV2State(k); if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer); }
  });
});

await test('④ 叫她名字 / 引用她 / 私聊 也预取；视频和大合集不预取', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    // 叫名字
    await h.handleIncoming('group', '456', imgEv(555, 7301, { raw_message: '小鲸鱼测试看这个' }, [{ type: 'text', data: { text: '小鲸鱼测试看这个' } }]), h.cfg);
    // 私聊
    await h.handleIncoming('private', '123', imgEv(123, 7302), h.cfg);
    await settle(h);
    assert.equal(new Set(h.imagePrefetch.values()).size, 2, '叫名字 + 私聊各一条');
    // 视频：不预取
    const before = new Set(h.imagePrefetch.values()).size;
    await h.handleIncoming('group', '456', { self_id: 999, user_id: 555, message_id: 7303, message: [...AT_ME, { type: 'video', data: { file: 'v.mp4', url: 'https://public.invalid/v.mp4' } }], raw_message: '看', sender: { nickname: 'x', card: '' } }, h.cfg);
    assert.equal(new Set(h.imagePrefetch.values()).size, before, '视频不预取');
    // 大合集（> 4 张）：不预取
    const many = { self_id: 999, user_id: 555, message_id: 7304, message: [...AT_ME, ...Array.from({ length: 6 }, (_, i) => ({ type: 'image', data: { file: `0000000${i}abcdef0123456789abcdef.jpg` } }))], raw_message: '看', sender: { nickname: 'x', card: '' } };
    await h.handleIncoming('group', '456', many, h.cfg);
    assert.equal(new Set(h.imagePrefetch.values()).size, before, '大合集不预取');
    const st = h.getSocialV2State(KEY); if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
  });
});

await test('④ 缓存有上限（条数）和过期（过了时间就当没有，重新取）', async () => {
  await withBridge({ socialV2: { proactive: { enabled: false } } }, async (h) => {
    for (let i = 0; i < 16; i += 1) { await h.handleIncoming('group', '456', imgEv(555, 7400 + i, {}, AT_ME), h.cfg); await settle(h); }
    const entries = new Set(h.imagePrefetch.values());
    assert.ok(entries.size <= 12, `最多留 12 条（实际 ${entries.size}）`);
    assert.ok(!h.imagePrefetch.has(`${KEY}|7400`), '最旧的被挤掉了');
    assert.ok(h.imagePrefetch.has(`${KEY}|7415`), '最新的还在');
    // 过期
    const e = h.imagePrefetch.get(`${KEY}|7415`);
    e.at = Date.now() - 16 * 60e3;
    const before = h.calls.images.length;
    await h.loadMessageImagesV2(KEY, '7415', h.findMessageMedia(KEY, '7415'));
    assert.equal(h.calls.images.length, before + 1, '过期了：重新取');
    const st = h.getSocialV2State(KEY); if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
  });
});

await test('④ 源码：取图端点先查缓存；刷屏消息只在叫她时才预取', () => {
  const src = read('src/bridge.js');
  assert.match(src, /const images = await loadMessageImagesV2\(key, messageId, media\);/);
  assert.match(src, /if \(mediaList\?\.length\) prefetchDirectedImagesV2\(key, event, kind, plainContent, quoteTargetIsSelf, mediaList\);/);
  assert.match(src, /if \(!isCallingHerV2\(event, kind, plainContent, quoteTargetIsSelf\)\) return false;/);
});

// ── ⑤ 姐姐群唤醒带图 ────────────────────────────────────────────────────────
const photo = (n, extra = {}) => ({ url: `https://public.invalid/${n}.jpg`, file: `${n}abcdef0123456789abcdef.jpg`, urls: [`https://public.invalid/${n}.jpg`], key: `f:${n}abcdef0123456789abcdef.jpg`, sticker: false, ...extra });
const sticker = (n) => photo(n, { sticker: true, emojiId: String(n).repeat(32).slice(0, 32) });

await test('⑤ 姐姐：groupMaxImages 默认 1，配置里也是 1', () => {
  assert.equal(groupMaxImagesOf({}), 1);
  assert.equal(groupMaxImagesOf(undefined), 1);
  assert.equal(groupMaxImagesOf({ groupMaxImages: 2 }), 2);
  assert.equal(groupMaxImagesOf({ groupMaxImages: 0 }), 0, '0 = 不带图');
  assert.equal(groupMaxImagesOf({ groupMaxImages: 'x' }), 1);
  assert.equal(JSON.parse(read('sister/config.json')).groupMaxImages, 1);
});

await test('⑤ 姐姐：最多 1 张，优先叫她那条的图，别人发的动画表情 / 动图跳过', () => {
  const lines = [
    { who: 'A', imgs: [sticker('aa')] },                 // 别人发的动画表情 → 不要
    { who: 'B', imgs: [photo('bb')] },                   // 别人发的普通图
    { who: 'C', imgs: [photo('cc.gif', { file: 'cc.gif' })] }, // 别人发的 gif → 不要
    { who: 'D', calls: true, imgs: [photo('dd')] },      // 叫她的那条
    { who: 'E', imgs: [photo('ee')] },                   // 叫她那条之后别人又发了一张
  ];
  const refs = selectGroupImageRefs(lines, 6);
  assert.deepEqual(refs.map((r) => r.key), [photo('bb').key, photo('ee').key, photo('dd').key], '动画表情 / gif 没进来，叫她的排最后');
  const plan = planImages(refs, {}, groupMaxImagesOf({}));
  const want = plan.filter((p) => p.status === 'want');
  assert.equal(want.length, 1, '一次只附 1 张');
  assert.equal(want[0].key, photo('dd').key, '留的是叫她那条的图（哪怕后面别人又发了图）');
  assert.equal(plan.filter((p) => p.status === 'skipped').length, 2, '其余写明这次没附');
  // 叫她的那条里就是动画表情：照样给她看（是对她发的）
  const only = selectGroupImageRefs([{ imgs: [photo('x1')] }, { calls: true, imgs: [sticker('yy')] }], 6);
  assert.equal(planImages(only, {}, 1).find((p) => p.status === 'want').key, sticker('yy').key);
  // 没有叫她的那条（路过）：别人的普通图里留最新的，动画表情不带
  const lurk = selectGroupImageRefs([{ imgs: [photo('p1')] }, { imgs: [sticker('p2')] }, { imgs: [photo('p3')] }, { imgs: [sticker('p4')] }], 8);
  assert.equal(planImages(lurk, {}, 1).find((p) => p.status === 'want').key, photo('p3').key);
  // 看过的不再附：叫她的那条已经看过 → 让位给别人的最新一张
  const seen = { [photo('dd').key]: 1 };
  assert.equal(planImages(refs, seen, 1).find((p) => p.status === 'want').key, photo('ee').key);
  assert.ok(isAnimatedImageRef(sticker('z')) && isAnimatedImageRef({ file: 'a.GIF' }) && !isAnimatedImageRef(photo('q')));
});

await test('⑤ 姐姐源码：groupImages 走 selectGroupImageRefs + groupMaxImagesOf(cfg)，叫她的那条在 groupLine 里打标记', () => {
  const src = read('sister/sister.mjs');
  assert.match(src, /function groupImages\(g, lastN = 6, max = groupMaxImagesOf\(cfg\)\) \{\n    return prepareImages\(selectGroupImageRefs\(g\.lines, lastN\), max\);/);
  assert.match(src, /groupLine\(gid, who, line, event\.message_id \?\? null, ex\.imgs \|\| \[\], from, wantsHer\);/);
  assert.match(src, /\.\.\.\(calls \? \{ calls: true \} : \{\}\)/);
  assert.ok(!/const pics = await groupImages\(g, \d+, 3\)/.test(src), '没有哪里还死写 3 张');
});

// ── ⑥ rotateIdleMin ─────────────────────────────────────────────────────────
await test('⑥ 姐姐：rotateIdleMin 10 → 3，换会话的空闲判断用它', () => {
  const cfg = JSON.parse(read('sister/config.json'));
  assert.equal(cfg.rotateIdleMin, 3);
  assert.equal(cfg.rotateAtTokens, 75000, '到 75K 先标记要换');
  assert.equal(rotateIdleMsOf(cfg), 3 * 60e3);
  assert.equal(rotateIdleMsOf({}), 3 * 60e3, '没写默认 3 分钟');
  assert.equal(rotateIdleMsOf({ rotateIdleMin: 10 }), 10 * 60e3, '写了就按写的');
  const src = read('sister/sister.mjs');
  assert.match(src, /st\.rotatePending && !running && !claudeBusy[\s\S]{0,260}Date\.now\(\) - lastWakeEndAt > rotateIdleMsOf\(cfg\)\) \{/);
  // 空闲 2 分钟还不换，过了 3 分钟才换（刷屏中间有一小段安静就够）
  const last = 1_000_000;
  assert.equal(last + 2 * 60e3 - last > rotateIdleMsOf(cfg), false);
  assert.equal(last + 3 * 60e3 + 1 - last > rotateIdleMsOf(cfg), true);
});

// ── ⑦ 防抖最长 8 秒 ─────────────────────────────────────────────────────────
/** 模拟：从 0 秒起每隔 stepMs 来一条叫她的消息，一共 total 毫秒；返回定时器真正触发的时间（毫秒）。 */
function simulateDebounce({ stepMs, totalMs, debounceMs, maxWaitMs, gapLeftMs = 0 }) {
  let pendingSince = null, fireAt = Infinity;
  for (let t = 0; t <= totalMs; t += stepMs) {
    if (fireAt <= t) return fireAt; // 到点已经发了
    if (pendingSince === null) pendingSince = t;
    fireAt = t + groupDebounceDelayMs({ now: t, pendingSince, debounceMs, maxWaitMs, gapLeftMs });
  }
  return fireAt;
}
await test('⑦ 姐姐：连续 @ 时最长等 8 秒（以前每条都重置，要等对方停手）', () => {
  const cfg = JSON.parse(read('sister/config.json'));
  assert.equal(cfg.groupDebounceSec, 2);
  assert.equal(cfg.groupMaxWaitSec, 8);
  assert.equal(groupMaxWaitMsOf(cfg), 8000);
  assert.equal(groupMaxWaitMsOf({}), 8000, '没写默认 8 秒');
  assert.equal(groupMaxWaitMsOf({ groupMaxWaitSec: 0 }), 0, '0 = 不设上限');
  // 每秒一条 @，持续 60 秒：旧写法（无上限）一直不发；新写法 8 秒到点
  const old = simulateDebounce({ stepMs: 1000, totalMs: 60000, debounceMs: 2000, maxWaitMs: 0 });
  assert.ok(old > 60000, `无上限时一直顺延（实际 ${old}）`);
  const now = simulateDebounce({ stepMs: 1000, totalMs: 60000, debounceMs: 2000, maxWaitMs: 8000 });
  assert.equal(now, 8000, `从第一条起 8 秒到点（实际 ${now}）`);
  // 只有一条 @：照旧等 2 秒，不会拖到 8 秒
  assert.equal(simulateDebounce({ stepMs: 1000, totalMs: 0, debounceMs: 2000, maxWaitMs: 8000 }), 2000);
  // 稀疏 @（每 5 秒一条）：每条之间 2 秒就发了，用不上最长等待
  assert.equal(simulateDebounce({ stepMs: 5000, totalMs: 20000, debounceMs: 2000, maxWaitMs: 8000 }), 2000);
  // 慢群防抖 15 秒 > 最长等待 8 秒：按防抖本身，不被截短
  assert.equal(groupDebounceDelayMs({ now: 0, pendingSince: 0, debounceMs: 15000, maxWaitMs: 8000 }), 15000);
  // 慢群离上次叫她还没到间隔：不早于间隔
  assert.equal(groupDebounceDelayMs({ now: 0, pendingSince: 0, debounceMs: 2000, maxWaitMs: 8000, gapLeftMs: 30000 }), 30000);
  // 已经超过最长等待还有新的：马上发（0 毫秒）
  assert.equal(groupDebounceDelayMs({ now: 9000, pendingSince: 0, debounceMs: 2000, maxWaitMs: 8000 }), 0);
});

await test('⑦ 姐姐源码：scheduleGroupWake 非小房子分支用 groupDebounceDelayMs，定时器触发时清掉起算点', () => {
  const src = read('sister/sister.mjs');
  const body = src.slice(src.indexOf('function scheduleGroupWake'), src.indexOf('async function runGroupWake'));
  assert.match(body, /g0\.debouncePendingSince \|\|= Date\.now\(\);/);
  assert.match(body, /delay = groupDebounceDelayMs\(\{ now: Date\.now\(\), pendingSince: g0\.debouncePendingSince, debounceMs: .*maxWaitMs: groupMaxWaitMsOf\(cfg\), gapLeftMs: gapLeft \}\);/);
  assert.match(body, /delete groupTimers\[gid\];\n      g0\.debouncePendingSince = 0;/);
  assert.match(body, /if \(ctx\.inHouse\) \{[\s\S]*sisterMaxWaitSec/, '小房子分支原有的 sisterMaxWaitSec 没动');
});

console.log(`\n${failures ? '有失败' : '全部通过'}：${passed} 组通过${failures ? `，${failures} 组失败` : ''}`);
if (failures) process.exit(1);

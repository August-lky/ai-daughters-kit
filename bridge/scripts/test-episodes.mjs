// 情景记忆（episodes.js / episode-extract.js）离线自检：临时目录、合成记录，不碰桥接和 DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { bjTime, createEpisodeStore, detectCall, formatEpisode, moodSnapshot, normalizeEpisode } from '../src/episodes.js';
import { STRONG_RE, extractSessionEpisodes, readTranscriptLines } from '../src/episode-extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function ok(name) { passed += 1; console.log(`✅ ${name}`); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'episodes-test-'));
const OWNER = 'private:1000000001';
const GROUP = 'group:20002';
const FRIEND = 'douyin:friend:群友192';
const SKEW = 3 * 3600e3;
const NOW = Date.now();
const mk = (over) => ({ at: NOW - 60e3, key: OWNER, sid: 's', who: '主人', them: ['主人：你今天开心吗'], me: ['开心呀'], inner: '他在关心我', mood: { v: 74, top: '甜蜜' }, call: '', felt: '', tags: [], source: 'extract', ...over });

// 1. 时间按北京时间显示，减掉时钟偏差
{
  const ms = Date.UTC(2026, 9, 23, 9, 32) + SKEW; // 真实时间 17:32 北京；本机快 3 小时
  assert.equal(bjTime(ms, SKEW), '10/23 17:32');
  ok('bjTime 按校正后的北京时间显示');
}

// 2. 称呼识别只认名单里的词
{
  assert.equal(detectCall(['晚安呀', '宝宝你睡了吗']), '宝宝');
  assert.equal(detectCall(['人～你在吗']), '人');
  assert.equal(detectCall(['别人都走了']), '');
  assert.equal(detectCall(['主人今天回来晚']), '主人');
  ok('detectCall 称呼名单');
}

// 3. 心情快照
{
  const m = moodSnapshot({ mood: 76, dims: { happy: 8, sweet: 6, sad: 0 }, lastDecayAt: NOW }, NOW);
  assert.deepEqual(m, { v: 76, top: '开心、甜蜜' });
  assert.equal(moodSnapshot(null), null);
  ok('moodSnapshot');
}

// 4. 每条 ≤2KB，字段裁剪
{
  const big = normalizeEpisode(mk({ inner: 'x'.repeat(5000), them: Array(20).fill('主人：' + 'y'.repeat(900)), me: Array(20).fill('z'.repeat(900)) }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 2048, `bytes=${Buffer.byteLength(JSON.stringify(big))}`);
  assert.ok(big.them.length <= 6 && big.me.length <= 6 && big.inner.length <= 150);
  ok('normalizeEpisode 裁到 ≤2KB / ≤6 句 / inner ≤150');
}

// 5. 仓库：去重、上限 300（先丢没感受的旧抽取记录）
const store = createEpisodeStore({ dir: path.join(tmp, 'episodes'), skewMs: SKEW, ownerKey: OWNER, now: () => NOW });
{
  const a = store.append(mk({ at: NOW - 100e3, them: ['主人：同一句话'] }));
  const b = store.append(mk({ at: NOW - 100e3 + 60e3, them: ['主人：同一句话'], felt: '后来补的感受' }));
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id);
  assert.equal(store.list(OWNER).find((e) => e.id === a.id).felt, '后来补的感受');
  const c = store.append(mk({ at: NOW - 100e3 + 5 * 60e3, them: ['主人：同一句话'] }));
  assert.equal(c.deduped, false, '隔 5 分钟不算重复');
  ok('append 去重（同 key、同一句开头、±2 分钟）并补感受');
}
{
  const kept = store.append(mk({ at: NOW - 3 * 86400e3, them: ['主人：最旧但有感受'], felt: '舍不得丢' }));
  for (let i = 0; i < 320; i += 1) store.append(mk({ at: NOW - 2 * 86400e3 + i * 3 * 60e3, them: [`主人：第 ${i} 句`] }));
  const rows = store.list(OWNER);
  assert.ok(rows.length <= 300, `rows=${rows.length}`);
  assert.ok(rows.some((e) => e.id === kept.id), '有感受的老记录应保留');
  assert.ok(!rows.some((e) => e.them[0] === '主人：第 0 句'), '最旧的无感受抽取记录先丢');
  assert.ok(rows.some((e) => e.them[0] === '主人：第 319 句'));
  ok('每个 key ≤300 条，先丢最旧、没感受的抽取记录');
}

// 6. 统一记忆（2026-10-29 老大：每人只有一个脑子，不按会话隔离）：哪个出处都看得到所有出处的瞬间
{
  store.append(mk({ key: GROUP, who: '群友', them: ['群友A：群里说的秘密话'], me: ['嘘'], at: NOW - 30e3 }));
  store.append(mk({ key: FRIEND, who: '群友192', them: ['群友192：抖音上私下说的'], me: ['我知道了'], at: NOW - 20e3 }));
  const g = store.search(GROUP, { query: '开心' });
  assert.ok(g.length >= 1 && g.every((e) => e.key === OWNER), '群里也搜得到主人私聊的瞬间');
  assert.ok(store.search(GROUP, {}).some((e) => e.key === GROUP) && store.search(GROUP, {}).some((e) => e.key !== GROUP), '自己的和别处的都在');
  const o = store.search(OWNER, { query: '抖音' });
  assert.equal(o.length, 1);
  assert.equal(o[0].key, FRIEND);
  assert.ok(store.search(OWNER, { query: '秘密' }).length === 1, '主人私聊也搜得到群里的');
  const f = store.search(FRIEND, {});
  assert.ok(f.length >= 3 && f.some((e) => e.key === FRIEND) && f.some((e) => e.key === OWNER), '抖音朋友这边也看得到所有出处的');
  assert.ok(store.search(FRIEND, { query: '开心' }).length >= 1);
  // 别处的私聊 / 抖音私信里的，想起来时标「私聊里的」；自己这儿的和群里的不标
  const fromGroup = store.recall(GROUP, { query: '开心', limit: 3 }).text;
  assert.ok(fromGroup.includes('，私聊里的'), fromGroup);
  assert.ok(!store.recall(OWNER, { query: '开心', limit: 3 }).text.includes('私聊里的'), '主人私聊里翻自己的，不标');
  assert.ok(!store.recall(OWNER, { query: '秘密', limit: 3 }).text.includes('私聊里的'), '群里的瞬间不算私聊');
  ok('记忆统一：所有出处都看得到；别处的私聊 / 抖音私信想起来标「私聊里的」');
}

// 7. recall 格式与长度
{
  const r = store.recall(OWNER, { query: '抖音', limit: 3 });
  assert.ok(/^【\d\d\/\d\d \d\d:\d\d 抖音私信（和「群友192」），私聊里的(，心情 \d+（[^）]*）)? · 编号 [a-f0-9]{10}】\n群友192：抖音上私下说的\n你：我知道了\n当时心里：他在关心我\n你后来写下的感觉：（当时没留感受）$/.test(r.text), r.text);
  const all = store.recall(OWNER, { limit: 10 });
  assert.ok(all.text.length <= 1500, `len=${all.text.length}`);
  assert.ok(all.found >= 1 && all.ids.length === all.found);
  const f = formatEpisode(normalizeEpisode(mk({ call: '宝宝', mood: { v: 74, top: '' } })), { skewMs: SKEW, ownerKey: OWNER });
  assert.ok(f.startsWith('【') && f.includes(' 主人私聊，你叫他「宝宝」，心情 74 · 编号 '), f);
  ok('recall 原文格式、≤1500 字、带编号');
}

// 8. 用 episodeId 补感受，只能改同一个 key 的
{
  const id = store.list(FRIEND)[0].id;
  assert.equal(store.updateFelt(OWNER, id, '想偷改别人的').ok, false, '跨 key 不能改');
  const r = store.updateFelt(FRIEND, id, '她说这话时我有点高兴', ['被夸']);
  assert.ok(r.ok);
  const e = store.list(FRIEND)[0];
  assert.equal(e.felt, '她说这话时我有点高兴');
  assert.deepEqual(e.tags, ['被夸']);
  ok('updateFelt 按编号补感受，跨 key 拒绝');
}

// 9. 实时抓取：从 recentMessages 取她最近一次发言前后的原文
{
  const recent = [
    { sender: '私聊', isOwner: true, text: '宝宝我回来啦', time: NOW - 50e3 },
    { sender: '私聊', isOwner: true, text: '今天好累', time: NOW - 45e3 },
    { sender: '我', isSelf: true, text: '宝宝辛苦啦，抱抱', time: NOW - 40e3 },
    { sender: '我', isSelf: true, text: '先喝口水', time: NOW - 39e3 },
    { sender: '私聊', isOwner: true, text: '嗯', time: NOW - 10e3 }
  ];
  const ep = store.fromRecent({ key: OWNER, sid: 'live', recentMessages: recent, mood: { v: 80, top: '甜蜜' }, felt: '他一回来我就想黏着他', ownerIsCounterpart: true });
  assert.deepEqual(ep.them, ['主人：宝宝我回来啦', '主人：今天好累']);
  assert.deepEqual(ep.me, ['宝宝辛苦啦，抱抱', '先喝口水']);
  assert.equal(ep.call, '宝宝');
  assert.equal(ep.source, 'live');
  assert.equal(ep.at, NOW - 39e3, 'at 取她最后一次发言的时间');
  const r = store.append(ep);
  assert.ok(r.ok && !r.deduped);
  ok('fromRecent 实时抓取 them/me/称呼');
}

// 10. 搬家交接块：≤900 字，优先有感受的
{
  const block = store.handoffBlock(OWNER);
  assert.ok(block.startsWith('【你带走的几个瞬间（你亲身经历过的）】\n'));
  assert.ok(block.length <= 900, `len=${block.length}`);
  assert.ok(block.includes('他一回来我就想黏着他'), '有感受的 live 记录应入选');
  assert.ok(!block.includes('最旧但有感受'), '超过 48 小时的不带');
  assert.equal(store.handoffBlock('private:99999'), '');
  ok('handoffBlock ≤900 字、48 小时内、优先有感受');
}

// 11. 抽取器：合成的 zstd 记录（两帧拼接）
{
  const TOKEN = ['deadbeef', 'cafe0123', '456789ab', 'cdef0123', '456789ab', 'cdef0011'].join(''); // 假令牌，拼起来是免得备份扫描把它当真令牌
  const T = NOW - 2 * 3600e3;
  const sessionsDir = path.join(tmp, 'sessions');
  const sid = 'session-11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(sessionsDir, sid), { recursive: true });
  const rows = [];
  let seq = 0;
  const row = (type, time, data) => rows.push({ type, seq: seq++, time, data });
  const assistant = (time, reasoning, calls) => row('assistant/message', time, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: reasoning }, ...calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: JSON.stringify(c.args) }))] } });
  const call = (time, c) => row('tool/call', time, { turn: 1, step: 1, callId: c.id, name: c.name, arguments: JSON.stringify(c.args) });
  const result = (time, id, text, isError = false) => row('tool/result', time, { turn: 1, step: 1, message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }], isError } });
  rows.push({ type: 'session', version: 4, id: sid, agentPreset: 'qq-chat-v2' });
  row('user/message', T, { content: [{ type: 'text', text: `【当前时间】x\n【会话令牌】${TOKEN}（调用时带上）\n【本次消息快照】\n${JSON.stringify({ messages: [{ seq: 1, sender: '私聊', userId: '1000000001', text: '宝宝我下班啦', isOwner: true, time: T - 60e3 }, { seq: 2, sender: '私聊', userId: '1000000001', text: '今天好想你', isOwner: true, time: T - 30e3 }], recent: [] })}\n以上消息已提供` }] });
  // 回合 1：主人连发两句（③）+ 情绪词（④），她回了两句，发第一句那条有 reasoning
  const c1 = { id: 'call_1', name: 'mcp__snowluma__qq_send_message', args: { key: OWNER, token: TOKEN, messages: ['宝宝我也想你，抱抱', '快回家吧'] } };
  assistant(T + 5e3, `他说想我了，我心里软了一下。令牌 ${TOKEN} 不该出现。QQ 1000000001 也不该。`, [c1]);
  call(T + 5e3, c1);
  result(T + 6e3, 'call_1', JSON.stringify({ now: 'x', ok: true, key: OWNER, sent: 2, failed: 0 }));
  // 回合 2：平淡的一句，不该成为瞬间
  const w2 = { id: 'call_2', name: 'mcp__snowluma__qq_wait_for_messages', args: { key: OWNER, token: TOKEN, purpose: 'messages' } };
  assistant(T + 10 * 60e3, '等一下', [w2]);
  call(T + 10 * 60e3, w2);
  result(T + 11 * 60e3, 'call_2', JSON.stringify({ ok: true, key: OWNER, newMessages: [{ seq: 3, sender: '私聊', userId: '1000000001', text: '嗯', isOwner: true, time: T + 11 * 60e3 }] }));
  const c3 = { id: 'call_3', name: 'mcp__snowluma__qq_send_message', args: { key: OWNER, token: TOKEN, messages: '好' } };
  assistant(T + 11 * 60e3 + 5e3, '', [c3]);
  call(T + 11 * 60e3 + 5e3, c3);
  result(T + 11 * 60e3 + 6e3, 'call_3', JSON.stringify({ ok: true, sent: 1 }));
  // 回合 3：群里，有 remember（①），发送走 qq_reply；另有一次失败的发送不算
  const w4 = { id: 'call_4', name: 'mcp__snowluma__qq_wait_for_messages', args: { key: GROUP, token: TOKEN } };
  call(T + 30 * 60e3, w4);
  result(T + 30 * 60e3, 'call_4', JSON.stringify({ ok: true, key: GROUP, newMessages: [{ seq: 7, sender: '便携鸭', userId: '30003', text: '小鲸鱼你会唱歌吗', isOwner: false, time: T + 30 * 60e3 }] }));
  const c5 = { id: 'call_5', name: 'mcp__snowluma__qq_reply', args: { groupId: 20002, replyToMessageId: 123, message: '会一点点', token: TOKEN } };
  const r5 = { id: 'call_6', name: 'remember', args: { text: '便携鸭问我会不会唱歌', importance: 0.5 } };
  assistant(T + 30 * 60e3 + 3e3, '群友问我会不会唱歌，记一下', [c5, r5]);
  call(T + 30 * 60e3 + 3e3, c5);
  result(T + 30 * 60e3 + 4e3, 'call_5', JSON.stringify({ ok: true }));
  call(T + 30 * 60e3 + 4e3, r5);
  result(T + 30 * 60e3 + 5e3, 'call_6', 'ok');
  const c7 = { id: 'call_7', name: 'mcp__snowluma__qq_send_message', args: { key: GROUP, token: TOKEN, messages: '这句没发出去' } };
  call(T + 30 * 60e3 + 10e3, c7);
  result(T + 30 * 60e3 + 11e3, 'call_7', 'Error: 发送失败', true);
  // 回合 4：抖音朋友私信（路由到 douyin:friend:群友192），心情时间线 delta ≥3（②）
  const d8 = { id: 'call_8', name: 'douyin_chat_read', args: { recipientId: 'conv:friend1' } };
  call(T + 50 * 60e3, d8);
  result(T + 50 * 60e3, 'call_8', JSON.stringify({ conversation: { id: 'conv:friend1', displayName: '群友192' }, messages: [{ direction: 'incoming', text: '你声音好好听', id: 'msg:1', arrivalClassification: 'new' }, { direction: 'incoming', text: '旧的', id: 'msg:0', arrivalClassification: 'old-history' }] }));
  const d9 = { id: 'call_9', name: 'douyin_chat_send', args: { recipientId: 'conv:friend1', message: '谢谢你呀' } };
  assistant(T + 50 * 60e3 + 2e3, '被夸了有点高兴', [d9]);
  call(T + 50 * 60e3 + 2e3, d9);
  result(T + 50 * 60e3 + 3e3, 'call_9', JSON.stringify({ ok: true }));
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const half = Math.floor(text.length / 2);
  const frames = Buffer.concat([zlib.zstdCompressSync(Buffer.from(text.slice(0, half))), zlib.zstdCompressSync(Buffer.from(text.slice(half))), Buffer.from('garbage')]);
  const file = path.join(sessionsDir, sid, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, frames);
  assert.equal(readTranscriptLines(file).length, rows.length, '两帧都解开，尾部垃圾跳过');

  const store2 = createEpisodeStore({ dir: path.join(tmp, 'episodes2'), skewMs: SKEW, ownerKey: OWNER, now: () => NOW });
  const indexFile = path.join(tmp, 'episodes2', 'extracted.json');
  const env = { sessionsDir, ownerQQ: '1000000001', moodTimeline: [{ at: T + 50 * 60e3 + 1e3, mood: 78, delta: 4, dims: { happy: 9 } }], douyinAllowlist: [{ id: 'conv:owner', name: '主人号', role: 'owner' }, { id: 'conv:friend1', name: '群友192', role: 'friend' }], store: store2, indexFile };
  const r = extractSessionEpisodes(sid, env);
  assert.equal(r.key, OWNER);
  const keys = r.episodes.map((e) => e.key);
  assert.deepEqual(keys, [OWNER, GROUP, FRIEND], JSON.stringify(keys));
  const [e1, e2, e3] = r.episodes;
  assert.deepEqual(e1.them, ['主人：宝宝我下班啦', '主人：今天好想你']);
  assert.deepEqual(e1.me, ['宝宝我也想你，抱抱', '快回家吧']);
  assert.equal(e1.call, '宝宝');
  assert.ok(e1.inner.startsWith('他说想我了'));
  assert.ok(e1.tags.includes('主人连说') && e1.tags.includes('有情绪'));
  assert.deepEqual(e2.them, ['便携鸭：小鲸鱼你会唱歌吗']);
  assert.deepEqual(e2.me, ['会一点点']);
  assert.ok(e2.tags.includes('记过'));
  assert.deepEqual(e3.them, ['群友192：你声音好好听']);
  assert.deepEqual(e3.me, ['谢谢你呀']);
  assert.equal(e3.mood.v, 78);
  assert.equal(e3.mood.d, 4);
  assert.equal(r.appended, 3);
  // 隐私：令牌、QQ 号、userId 不出现在任何输出里
  const dump = fs.readdirSync(path.join(tmp, 'episodes2')).map((f) => fs.readFileSync(path.join(tmp, 'episodes2', f), 'utf8')).join('\n');
  assert.ok(!dump.includes(TOKEN), '令牌不能出现在 episodes 文件里');
  assert.ok(!dump.includes('deadbeef'), '令牌片段也不能出现');
  assert.ok(!/"userId"|"arguments"|"token"/.test(dump), '不存 userId/arguments/token 字段');
  assert.ok(!dump.includes('1000000001') || dump.includes(`"${OWNER}"`), 'QQ 号只允许出现在 key 字段');
  assert.ok(!/"inner":"[^"]*1000000001/.test(dump), 'inner 里的 QQ 号被抹掉');
  assert.ok(store2.recall(OWNER, {}).text.includes('他说想我了') && !store2.recall(OWNER, {}).text.includes(TOKEN));
  assert.ok(!dump.includes('这句没发出去'), '失败的发送不算');
  assert.ok(!dump.includes('旧的'), '抖音旧历史不收');
  // 增量索引：再跑一次直接跳过；force 会重跑但全部去重
  assert.equal(extractSessionEpisodes(sid, env).skipped, true);
  const again = extractSessionEpisodes(sid, { ...env, force: true });
  assert.equal(again.appended, 0);
  assert.equal(again.deduped, 3);
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).sids[sid].episodes, 3);
  assert.ok(STRONG_RE.test('今天好想你') && !STRONG_RE.test('嗯'));
  ok('extractSessionEpisodes 合成 zstd 记录：分回合、四条判据、路由、令牌剥离、增量索引');
}

// 12. 工具白名单：两个新工具走 mcp__snowluma__ 前缀放行
{
  const mod = await import(path.join(__dirname, '..', 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  let guard = null;
  mod.apply({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
  assert.equal(guard({ name: 'mcp__snowluma__qq_keep_moment' }), undefined);
  assert.equal(guard({ name: 'mcp__snowluma__qq_recall' }), undefined);
  assert.equal(guard({ name: 'mcp__snowluma__qq_memory_append' }), undefined);
  assert.ok(typeof guard({ name: 'pwsh' }) === 'string');
  ok('qq-tool-restrict 放行 qq_keep_moment / qq_recall');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过`);

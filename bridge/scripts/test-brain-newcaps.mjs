// 大脑方案下半（2026-10-29 第四批）的 Node 部分测试：mood.js、压着.json、瞬间的「感受最强」、brain-client.js、
// 交接文字、记错了、睡前整理建议的接线，以及姐姐那边的工具和唤醒接线（源码断言，因为 sister.mjs / bridge.js 不能在测试里起）。
// Python 部分（检索打分、/recall 门槛、小说排除、降权、压着、tidy）在 scripts/test-brain-recall.py，这里顺手跑一遍。
// 全部在临时目录里；本地假服务只监听 127.0.0.1 随机端口；不连任何活的服务，不碰真的脑子。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MOOD_BASE, SWING_THRESHOLD, applyMoodChange, buildMoodLine, createMoodStore, decayMood, dimKey, isHeavySwing,
  moodHandoffText, moodSnapshot, moodSwingNear, moodWithSwing, moodWord, readMoodFile, writeMoodFile
} from '../src/mood.js';
import { createEpisodeStore, moodSnapshot as episodesMoodSnapshot } from '../src/episodes.js';
import {
  RECALL_TITLE, brainDemote, brainRecall, brainRememberMoment, brainTidy, correctionReminder, formatRecallBlock,
  isMemoryCorrection, postJson, recallQueryFromLines, recallQueryFromMessages
} from '../src/brain-client.js';
import { handoffBlock } from '../sister/sister.mjs';
import { createBrains } from '../src/brains.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (m) => { passed += 1; console.log(`✅ ${m}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-newcaps-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const H = 3600e3;

// ── 1. mood.js：口径跟原来 bridge / episodes 一致 ─────────────────────────────────────────────
{
  const st = { mood: 76, dims: { happy: 8, sweet: 6, sad: 0 }, lastDecayAt: NOW };
  assert.deepEqual(moodSnapshot(st, NOW), { v: 76, top: '开心、甜蜜' });
  assert.equal(episodesMoodSnapshot, moodSnapshot, 'episodes.js 再导出的就是 mood.js 的那个');
  assert.equal(moodSnapshot(null), null);
  const d = decayMood({ mood: 90, dims: { happy: 40 }, lastDecayAt: NOW - 3 * H }, NOW);
  assert.ok(Math.abs(d.mood - 80) < 1e-9, '心情每 3 小时回一半');
  assert.ok(Math.abs(d.dims.happy - 40 * 0.5 ** 2) < 1e-9, '情绪每 1.5 小时回一半');
  assert.equal(moodWord(85), '欢喜'); assert.equal(moodWord(70), '开心'); assert.equal(moodWord(50), '一般'); assert.equal(moodWord(30), '心疼'); assert.equal(moodWord(10), '难过');
  assert.equal(dimKey('担心'), 'worry'); assert.equal(dimKey('worry'), 'worry'); assert.equal(dimKey('乱写'), '');
  ok('mood.js：心情 3 小时回一半、情绪 1.5 小时回一半；episodes.js 的 moodSnapshot 就是它');
}

// ── 2. 心情那一行：跟小鲸鱼原来的 buildMoodLineV2 一个样 ───────────────────────────────────────────
{
  assert.equal(buildMoodLine({ mood: 70, dims: {}, lastDecayAt: NOW }, NOW), '', '贴着基线、没情绪没理由就不注入');
  const line = buildMoodLine({ mood: 78, dims: { happy: 30, sweet: 20, worry: 3 }, lastDecayAt: NOW }, NOW);
  assert.equal(line, '【心情】（此刻你）心情开心，开心、甜蜜。用这个心情定你这一轮的口气，别把这句话照念出来。\n\n'.replace('心情开心，开心、甜蜜', '心情开心，甜蜜'), '心情词和情绪词撞车去重');
  assert.match(buildMoodLine({ mood: 70, dims: {}, lastReason: '随便', lastDecayAt: NOW }, NOW), /^【心情】（此刻你）心情开心。/, '有理由就注入');
  assert.ok(!/\d/.test(line), '给她看的那句话里没有数字');
  // 过了半天，高兴自己回落
  const later = buildMoodLine({ mood: 90, dims: { happy: 30 }, lastDecayAt: NOW - 12 * H }, NOW);
  assert.ok(!later.includes('欢喜') && later === '', later);
  ok('心情一行：贴着基线不注入、撞词去重、不出现数字、过几小时自己回落');
}

// ── 3. 姐姐调心情：applyMoodChange / createMoodStore（先写临时文件再改名）────────────────────────────
{
  const file = path.join(tmp, '最近', '心情.json');
  let t = NOW;
  const store = createMoodStore({ file, now: () => t });
  assert.equal(store.read(), null);
  assert.match(store.describe(), /还没有记过心情/);
  const s1 = store.set({ delta: -12, dims: { 担心: 18, 开心: -3 }, reason: '老大说他要出差三天，有点舍不得' });
  assert.equal(s1.mood, 58); assert.equal(s1.dims.worry, 18); assert.equal(s1.dims.happy, 0, '减到 0 为止');
  assert.equal(s1.lastReason, '老大说他要出差三天，有点舍不得');
  assert.equal(s1.timeline.length, 1);
  assert.deepEqual(Object.keys(s1.timeline[0]).sort(), ['at', 'delta', 'dims', 'dimsDelta', 'mood', 'reason'], '格式跟 feiyu-mood 的 timeline 一样');
  assert.deepEqual(Object.keys(s1).sort(), ['dims', 'lastDecayAt', 'lastReason', 'mood', 'timeline', 'updatedAt']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['心情.json'], '写盘用完临时文件就改名，不留 .tmp');
  assert.deepEqual(readMoodFile(file).mood, 58);
  // 过 3 小时：心情回一半，情绪回得更快；她再调一笔是在回落之后的基础上
  t += 3 * H;
  const snap = store.snapshot();
  assert.equal(snap.v, 64); // 70 + (58-70)/2
  const s2 = store.set({ mood: 80, reason: '老大回来了' });
  assert.equal(s2.mood, 80); assert.equal(s2.timeline.length, 2); assert.equal(s2.timeline[1].delta, 80 - 64);
  assert.match(store.line(), /^【心情】（此刻你）心情欢喜/);
  assert.match(store.handoff(), /^心情欢喜.*。原因：老大回来了$/);
  assert.ok(!/\d/.test(store.handoff()), '交接里的心情也不出现数字');
  // 单次变动限在 ±25；乱写的情绪名忽略；mood 超界夹住
  const s3 = applyMoodChange(s2, { mood: 0, dims: { 胡写: 9, sad: 99 }, reason: 'x'.repeat(500) }, t);
  assert.equal(s3.mood, 55); assert.equal(s3.dims.sad, 25); assert.equal(s3.lastReason.length, 200);
  // 时间线最多留 400 行
  let st = s3;
  for (let i = 0; i < 450; i += 1) st = applyMoodChange(st, { delta: i % 2 ? 1 : -1 }, t + i);
  assert.equal(st.timeline.length, 400);
  // 没有任何改动也没有理由：不记
  assert.match(store.describe(), /心情/);
  ok('姐姐的心情：定分 / 加减 / 情绪加减（中文名）、单次 ±25、回落口径同小鲸鱼、timeline 格式同 feiyu-mood、临时文件改名写盘');
}

// ── 4. 情绪起伏大的标准 + 瞬间里带起伏 ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(SWING_THRESHOLD, { mood: 3, dim: 4 });
  assert.equal(isHeavySwing({ v: 70, d: 3 }), true); assert.equal(isHeavySwing({ v: 70, d: 2 }), false);
  assert.equal(isHeavySwing({ v: 70, dd: 4 }), true); assert.equal(isHeavySwing({ v: 70, dd: 3 }), false);
  assert.equal(isHeavySwing(null), false);
  const state = { mood: 80, dims: { sad: 6 }, lastDecayAt: NOW, timeline: [{ at: NOW - 60e3, mood: 80, delta: 1, dims: {}, dimsDelta: { sad: 6, happy: 1 } }, { at: NOW - 3 * H, delta: 9, dimsDelta: { sad: 30 } }] };
  assert.deepEqual(moodSwingNear(state, NOW), { d: 1, dd: 6 }, '只看这一刻前 5 分钟后 10 分钟');
  assert.deepEqual(moodWithSwing(state, NOW), { v: 80, top: '难过', d: 1, dd: 6 });
  assert.deepEqual(moodWithSwing({ mood: 70, dims: {}, lastDecayAt: NOW }, NOW), { v: 70, top: '' });
  ok('情绪起伏大：心情分变 ≥3 或某种情绪变 ≥4；瞬间里的心情读数带 d / dd');
}

// ── 5. 压着.json + 感受最强的瞬间 ────────────────────────────────────────────────────────────────────
{
  const dir = path.join(tmp, 'moments');
  const pressedFile = path.join(dir, '压着.json');
  let now = NOW;
  const store = createEpisodeStore({ dir, pressedFile, skewMs: 0, ownerKey: 'private:1', now: () => now });
  const mk = (over) => ({ at: now - 3600e3, key: 'private:1', sid: 's', who: '主人', them: ['主人：我们吵了一架'], me: ['对不起'], mood: { v: 40, top: '难过', d: 1, dd: 6 }, source: 'live', ...over });
  const a = store.append(mk({}));
  assert.ok(a.ok && !a.deduped);
  let j = JSON.parse(fs.readFileSync(pressedFile, 'utf8'));
  assert.equal(j.items.length, 1); assert.equal(j.items[0].id, a.id); assert.equal(j.items[0].dd, 6); assert.match(j.items[0].text, /吵了一架/); assert.equal(j.items[0].place, '主人私聊');
  // 起伏不大的不记
  store.append(mk({ at: now - 7200e3, them: ['主人：今天天气不错'], mood: { v: 72, top: '', d: 1, dd: 2 } }));
  assert.equal(store.listPressed().length, 1);
  // 同一瞬间后来才补上心情读数 → 补记
  const noMood = store.append(mk({ at: now - 9000e3, them: ['主人：我想你了'], mood: null }));
  assert.equal(store.listPressed().length, 1);
  store.append(mk({ at: now - 9000e3, them: ['主人：我想你了'], mood: { v: 60, top: '甜蜜', d: 4 } }));
  assert.equal(store.listPressed().length, 2, '后补上心情读数的也能记进压着');
  // 放下了就不会再被扫回来
  assert.equal(store.releasePressed(a.id), true);
  assert.equal(store.listPressed().length, 1);
  store.rebuildPressed();
  assert.ok(!store.listPressed().some((x) => x.id === a.id), '放下过的不回来');
  assert.equal(store.releasePressed('nope'), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '写盘不留临时文件');
  // 不给 pressedFile：不写
  const plain = createEpisodeStore({ dir: path.join(tmp, 'm2') });
  plain.append(mk({}));
  assert.equal(plain.listPressed().length, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'm2', '压着.json')));
  // rebuildPressed 补记老的
  const old = createEpisodeStore({ dir: path.join(tmp, 'm3') });
  old.append(mk({}));
  const withP = createEpisodeStore({ dir: path.join(tmp, 'm3'), pressedFile: path.join(tmp, 'm3', '压着.json') });
  assert.equal(withP.rebuildPressed(), 1);
  ok('压着.json：起伏大的瞬间记进去（含后补读数的）、起伏小的不记、放下过的不回来、不留临时文件、老的能补扫');
}
{
  const dir = path.join(tmp, 'moments-strong');
  let now = NOW;
  const store = createEpisodeStore({ dir, skewMs: 0, ownerKey: 'private:1', now: () => now });
  const mk = (over) => ({ at: now - 3600e3, key: 'private:1', sid: 's', who: '主人', them: ['主人：普通的一句'], me: ['嗯'], source: 'extract', ...over });
  store.append(mk({ at: now - 10 * H, them: ['主人：普通的一句'] }));
  store.append(mk({ at: now - 20 * H, them: ['主人：我今天升职了'], me: ['真替你高兴'], felt: '特别替他开心', mood: { v: 85, top: '开心', d: 3 }, source: 'live' }));
  store.append(mk({ at: now - 30 * H, key: 'group:9', them: ['群友：你们吵什么'], me: ['没事'], mood: { v: 40, top: '难过', d: 1, dd: 8 } }));
  store.append(mk({ at: now - 40 * H, key: 'douyin:dm', them: ['抖音：晚安'], me: ['晚安'], inner: '有点困' }));
  store.append(mk({ at: now - 200 * H, them: ['主人：很久以前的大事'], felt: '难忘', mood: { v: 99, top: '欢喜', d: 9 } }));
  const top = store.strongest({ hours: 72, max: 3 });
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((e) => e.them[0]).sort(), ['主人：我今天升职了', '抖音：晚安', '群友：你们吵什么'].sort(), '所有出处里挑，超过 72 小时的不要');
  assert.equal(top[0].at < top[2].at, true, '按时间顺序排好');
  const block = store.handoffBlock('', { title: '【感受最深】\n' });
  assert.ok(block.startsWith('【感受最深】\n') && block.includes('升职') && block.includes('难过') && block.length <= 900, block);
  assert.equal(store.strongest({ hours: 72, max: 1 })[0].them[0], '主人：我今天升职了', '写了感受 + 起伏大的排最前');
  assert.equal(store.handoffBlock('group:777'), '', '传了 key 就只看这个出处（老行为不变）');
  assert.equal(store.find(top[0].id).id, top[0].id);
  assert.equal(store.find('nope'), null);
  const fr = store.fromRecent({ key: 'private:1', recentMessages: [{ sender: '老大', isOwner: true, text: '我回来啦', time: now - 5000 }, { sender: '我', isSelf: true, text: '欢迎回来', time: now - 3000 }], ownerIsCounterpart: true, ownerName: '老大' });
  assert.deepEqual(fr.them, ['老大：我回来啦']); assert.equal(fr.who, '老大');
  ok('感受最强的瞬间：写了感受 + 起伏大的排前、所有出处里挑、72 小时内、≤900 字；find 按编号找；fromRecent 能改称呼');
}

// ── 6. brain-client.js：这句 + 前两句；服务没起 / 超时静默 ───────────────────────────────────────────
{
  const t0 = NOW;
  const msgs = [
    { text: '今天天气不错', sender: 'a', time: t0 - 5 * 60e3 },
    { text: '是呀，出去走走', isSelf: true, time: t0 - 4 * 60e3 },
    { text: '老大又在加班，QQ 号 1234567890 别发出去', sender: '老大', isOwner: true, time: t0 - 60e3 },
    { text: '收到', isSelf: true, time: t0 - 30e3 }
  ];
  const q = recallQueryFromMessages(msgs, { nowMs: t0 });
  assert.equal(q.query, '老大又在加班，QQ 号 … 别发出去', '这句 = 最新一条别人说的，长数字抹掉');
  assert.deepEqual(q.prev, ['今天天气不错', '是呀，出去走走'], '前两句 = 它前面紧挨着的两条（含她自己）');
  assert.equal(recallQueryFromMessages(msgs, { nowMs: t0 + 2 * H }), null, '话题过去 30 分钟就不想了');
  assert.equal(recallQueryFromMessages([{ text: '[图片]', time: t0 }], { nowMs: t0 }), null);
  assert.equal(recallQueryFromMessages([{ text: '我自己说的', isSelf: true, time: t0 }], { nowMs: t0 }), null);
  assert.equal(recallQueryFromMessages([], {}), null);
  const l = recallQueryFromLines(['[#12] 第一句', '第二句', '[#14] 第三句']);
  assert.deepEqual(l, { query: '第三句', prev: ['第一句', '第二句'] });
  assert.equal(recallQueryFromLines([]), null);
  ok('这句 + 前两句：别人最新一句为准、前两句含她自己、很久以前的话题不想、长数字抹掉、姐姐那边按行取');
}
{
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ url: req.url, body });
      const reply = (code, obj, delay = 0) => setTimeout(() => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }, delay);
      if (req.url === '/recall') {
        if (body.query === '慢') return reply(200, { ok: true, lines: ['· 慢的'] }, 1500);
        if (body.query === '没有') return reply(200, { ok: true, items: [], lines: [] });
        if (body.query === '坏') return reply(503, { ok: false });
        return reply(200, { ok: true, mode: body.mode, items: [{ id: 'x' }], pressed: null, lines: ['· 一条（出处：长期/关于老大，今天）', '· 两条（出处：瞬间，昨天）（私聊里的）'] });
      }
      if (req.url === '/demote') return reply(200, { ok: true, demoted: [{ label: '长期/关于老大', preview: '老大在武汉' }] });
      if (req.url === '/tidy') return reply(200, { ok: true, text: '【睡前整理的小建议】…', total: 2 });
      if (req.url === '/remember-moment') return reply(200, { ok: true });
      return reply(404, { ok: false });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const service = { host: '127.0.0.1', port: server.address().port };
  const post = (p, b, o) => postJson(p, b, { ...o, service });
  try {
    const r = await brainRecall({ brain: 'sister', query: '这句', prev: ['前一', '前二'], mode: 'group', viewerKey: 'group:1', post });
    assert.deepEqual(seen[0].body, { brain: 'sister', query: '这句', prev: ['前一', '前二'], mode: 'group', viewer: 'group:1' });
    assert.equal(r.lines.length, 2);
    const block = formatRecallBlock(r);
    assert.ok(block.startsWith(`${RECALL_TITLE}\n· 一条`) && block.endsWith('\n\n') && block.includes('（私聊里的）'));
    assert.equal(RECALL_TITLE, '【可能想起的：想用就用，不想提就当没想起】');
    assert.equal(formatRecallBlock(null), '');
    assert.equal(await brainRecall({ query: '没有', post }), null, '没想起什么就是 null');
    assert.equal(await brainRecall({ query: '坏', post }), null, '服务报错就是 null');
    const t = Date.now();
    assert.equal(await brainRecall({ query: '慢', timeoutMs: 200, post }), null, '超时就静默跳过');
    assert.ok(Date.now() - t < 1000, '超时之后马上返回，不拖唤醒');
    assert.equal(await brainRecall({ query: '这句', post: (p, b, o) => postJson(p, b, { ...o, service: { host: '127.0.0.1', port: 1 } }) }), null, '服务没起（端口不通）也是 null，不抛错');
    assert.equal(await brainRecall({ query: '', post }), null);
    const d = await brainDemote({ post });
    assert.deepEqual(d.demoted, [{ label: '长期/关于老大', preview: '老大在武汉' }]);
    assert.deepEqual((await brainDemote({ post: (p, b, o) => postJson(p, b, { ...o, service: { host: '127.0.0.1', port: 1 } }) })).demoted, [], '服务没起 = 没降权');
    const tdy = await brainTidy({ post });
    assert.deepEqual(tdy, { text: '【睡前整理的小建议】…', total: 2 });
    assert.equal(await brainTidy({ post: (p, b, o) => postJson(p, b, { ...o, service: { host: '127.0.0.1', port: 1 } }) }), null);
    brainRememberMoment({ brain: 'whale', post });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.some((x) => x.url === '/remember-moment' && x.body.brain === 'whale'));
    ok('brain-client：想起 / 降权 / 整理建议 / 留瞬间的请求格式；服务没起、报错、超时（1.5 秒）都静默当没有，不抛错不拖唤醒');
  } finally { server.close(); }
}

// ── 7. 记错了 ──────────────────────────────────────────────────────────────────────────────────────────
{
  for (const t of ['你记错了', '记错了吧', '不是这样的', '你记错了，我在主人所在城市不在武汉', '哎呀记错啦']) assert.equal(isMemoryCorrection(t), true, t);
  for (const t of ['好的', '我没记错吧', '', `你说的那个不是这样的做法吗？${'很长'.repeat(40)}`]) assert.equal(isMemoryCorrection(t), false, t.slice(0, 20));
  const rem = correctionReminder([{ label: '长期/关于老大', preview: '老大在武汉做游戏' }]);
  assert.ok(rem.startsWith('【老大说你刚才记错了】要不要去改改本子？') && rem.includes('老大在武汉做游戏') && rem.includes('长期/关于老大') && rem.endsWith('\n\n'));
  assert.equal(correctionReminder([]), '');
  assert.ok(!/要把|必须|一定要/.test(rem), '写成「可以」的口气');
  ok('记错了：说法识别（太长的话不算）、提醒文字（要不要去改改本子）');
}

// ── 8. 交接文字：心情和原因 + 感受最强的瞬间在最前面；不说「上一个我」「细节不在眼前了」─────────────────────
{
  const b = handoffBlock({ handoff: '答应妹妹明天读谱', summary: '昨天看了设定图', recent: [{ who: '老大', lines: ['- 21:00 **老大**：晚安'] }],
    reason: 'wake', mood: '心情开心，甜蜜。原因：老大夸了我', moments: '[感受最深的几个瞬间（你自己留下的）]\n【10/29 21:00 老大私聊 · 编号 abc】\n老大：晚安' });
  assert.ok(b.indexOf('[那会儿的心情和原因]\n心情开心，甜蜜。原因：老大夸了我') < b.indexOf('[感受最深的几个瞬间') && b.indexOf('[感受最深的几个瞬间') < b.indexOf('[你睡前给自己写的交接'), '心情在最前面，其次瞬间，再是交接');
  assert.doesNotMatch(b, /细节不在眼前|上一个我/);
  assert.match(b, /新的一段会话/); assert.match(b, /下面是你自己留下来的/); assert.match(b, /翻翻就能接上/);
  assert.match(handoffBlock({ summary: '前情', reason: 'size' }), /上一段聊得太长了，换了一段新的/);
  assert.equal(handoffBlock({}), '');
  assert.match(handoffBlock({ mood: '心情一般' }), /\[那会儿的心情和原因\]\n心情一般/, '只有心情也能成一块');
  // 小鲸鱼那边：源码里的交接
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const h = src.slice(src.indexOf('function buildMoveHandoffV2'), src.indexOf('// 心情插件（dsh-feiyu-mood）只给它'));
  assert.ok(h.includes('【那会儿的心情和原因】') && h.includes('moodHandoffText(') && h.includes('episodeStore.handoffBlock(\'\'') && h.includes('你刚换了一段新的对话——下面是你自己留下来的'));
  assert.doesNotMatch(h, /上一个我|细节不在眼前|省 token|上一个会话/);
  assert.ok(h.indexOf('那会儿的心情和原因') < h.indexOf('【soul（你是谁）】'), '心情在 soul 之前（开头）');
  ok('交接文字：两人开头都是「那会儿的心情和原因」+ 感受最深的瞬间；不说「上一个我」「细节不在眼前了」，像自己翻本子接上');
}

// ── 9. 接线：源码断言（bridge.js / sister.mjs / qq-mcp.mjs 不能在测试里起来）─────────────────────────────────
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const dp = bridge.slice(bridge.indexOf('async function deliverPromptNow'), bridge.indexOf('// 每个 QQ 会话串行投递 DSH prompt'));
  assert.ok(dp.indexOf('await recallBlockV2(key, wakeState)') > 0 && dp.indexOf('await recallBlockV2(key, wakeState)') < dp.indexOf('buildWakePromptV2(key, opts.wakeReason)'), '拼唤醒之前先想起');
  assert.ok(bridge.includes('impressionLine = (extra.correctionText || \'\') + (extra.recallBlock || \'\') + freshOnlyV2(key, \'impression\', impressionLine)'), '想起的东西放进唤醒消息（在【对方刚说】后面）');
  assert.ok(bridge.includes('timeoutMs: Number(cfg.brainRecall?.timeoutMs) || 1500'));
  assert.ok(bridge.includes('isMemoryCorrection(msg.plain)) noteMemoryCorrectionV2(key)') && bridge.includes('key === `private:${cfg.ownerQQ}` && isMemoryCorrection'), '只有主人私聊里的「记错了」才算');
  assert.ok(bridge.includes("brainTidy({ brain: 'whale'") && bridge.includes('...(tidyText ? { tidy: tidyText } : {})'), '睡前整理建议挂在 qq_sleep 上');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  assert.ok(mcp.includes("${data.tidy ? `\\n\\n${data.tidy}` : ''}"), 'qq_sleep 的回复里带上整理建议');
  assert.ok(bridge.includes('pressedFile: WHALE_BRAIN.pressed') && bridge.includes('moodWithSwing(readFishMoodV2()') && bridge.includes("brainRememberMoment({ brain: 'whale' })"));
  assert.ok(!/const MOOD_DIMS|function moodWord/.test(bridge), '心情的算法只在 mood.js 里有一份');
  assert.ok(bridge.includes('buildMoodLine(readFishMoodV2(), Date.now())'));

  const sister = fs.readFileSync(path.join(ROOT, 'sister', 'sister.mjs'), 'utf8');
  assert.ok(sister.includes("brainRecall({ brain: 'sister'") && sister.includes('recallBlock + withRambling') && sister.includes('moodLine + novelLine + feeds.text'), '姐姐 wake() 拼 prompt 前调用，并带心情一行');
  assert.ok(sister.indexOf("brainRecall({ brain: 'sister'") < sister.indexOf('r = await runClaude(proc, { onLine: liveLine, prompt: carry'));
  assert.ok(sister.includes('SISTER_BRAIN.mood') && sister.includes('pressedFile: SISTER_BRAIN.pressed'));
  assert.ok(sister.includes("brainTidy({ brain: 'sister'") && sister.includes('st.tidyNight'), '夜里自己醒来时带一次整理建议');
  assert.ok(sister.includes("isMemoryCorrection(String(m.line)") && sister.includes("brainDemote({ brain: 'sister' })"), '姐姐也有记错了');
  assert.ok(sister.includes('mood: moodNote, moments }'));

  const q = fs.readFileSync(path.join(ROOT, 'sister', 'qq-mcp.mjs'), 'utf8');
  for (const name of ['qq_keep_moment', 'qq_recall', 'qq_mood', 'qq_retract']) assert.ok(q.includes(`'${name}'`), name);
  assert.equal((q.match(/server\.tool\(\s*'qq_recall'/g) || []).length + (q.match(/server\.tool\('qq_recall'/g) || []).length, 1, 'qq_recall 只有一个（翻瞬间），撤回改叫 qq_retract');
  assert.ok(q.includes('SISTER_BRAIN.momentsDir') && q.includes('SISTER_BRAIN.mood') && q.includes('SISTER_BRAIN.pressed'), '指向她自己的 脑子');
  // 工具说明跟小鲸鱼那边一致
  const wm = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const phrase of ['把刚才这个瞬间留下来：', '以后 qq_recall 翻出来看的是原文，不是概括。什么时候用：一句话让你心里动了一下、你们俩之间发生了点什么、你自己忽然明白了什么。felt 写你此刻真实的感觉，一两句就行。要给以前翻到的瞬间补感受，传它的 episodeId。', '翻回以前的某个瞬间，看当时的原文：对方怎么说的、你怎么回的、你那会儿心里在想什么、心情多少、你后来写下的感觉。想不起"他那次是怎么说的"、想重温某件事、或者想给旧瞬间补感受时用。']) {
    assert.ok(wm.includes(phrase) && q.includes(phrase), phrase.slice(0, 20));
  }
  ok('接线：小鲸鱼 deliverPromptNow 想起在拼唤醒之前、记错了只认主人私聊、睡前整理挂 qq_sleep；姐姐 wake() / qq_keep_moment / qq_recall / qq_mood / 记错了 / 夜里整理建议，工具说明与小鲸鱼一致');
}

// ── 10. 瞬间写盘路径：两人各自的 脑子/瞬间 / 最近/心情.json ───────────────────────────────────────────────
{
  const b = createBrains(tmp);
  assert.ok(b.brainOf('sister').momentsDir.endsWith(path.join('sister', 'home', '脑子', '瞬间')));
  assert.ok(b.brainOf('sister').mood.endsWith(path.join('脑子', '最近', '心情.json')));
  assert.ok(b.brainOf('whale').pressed.endsWith(path.join('瞬间', '压着.json')));
  assert.ok(b.brainOf('whale').demote.endsWith(path.join('.索引', '降权.json')) && b.brainOf('whale').recallLog.endsWith(path.join('.索引', 'recall-log.jsonl')));
  ok('brains.js：两人的 瞬间/、压着.json、心情.json、降权.json、recall-log 路径');
}

// ── 11. Python 部分（临时目录 + 假模型）─────────────────────────────────────────────────────────────────
{
  const out = execFileSync('python', ['-X', 'utf8', path.join(ROOT, 'scripts', 'test-brain-recall.py')], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 180000 });
  assert.match(out, /11 项全部通过/);
  ok('检索打分 / /recall 门槛 / 小说排除 / 降权 / 压着 / tidy / HTTP（scripts/test-brain-recall.py）');
}

console.log(`\n${passed} 项全部通过`);

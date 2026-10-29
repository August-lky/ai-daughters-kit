// 激素影子记录的接线（2026-10-29 第五批第 4 项）：src/hormone-feed.js 的事件翻译、心情 / 天气 / 兴趣换算、安全壳，
// src/weather.mjs 的结构化天气，姐姐 runClaude 的工具出错计数。全是纯函数 / 临时目录，不碰活的 QQ、DSH、配置、进程。
// 桥接里的接线（事件进来 → 影子文件里有记录）在 scripts/test-hormone-chatlog-bridge.mjs。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HORMONE_REFRESH, createHormoneFeed, createNoveltyTracker, extractKeywords, incomingHormoneEvents, loadFishInterests, loadSisterInterests,
  moodHormoneEvent, sentHormoneEvent, sisterInterestsFrom, toolHormoneEvents, toolSendHormoneEvents, weatherHormoneEvents,
} from '../src/hormone-feed.js';
import { weatherState } from '../src/weather.mjs';
import { runClaude } from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hormone-feed-'));

// ① 收到消息 → 事件
{
  assert.deepEqual(incomingHormoneEvents({ where: 'private', isOwner: true, text: '真棒' }), [{ type: 'msg_from_owner', text: '真棒' }], '老大私聊');
  assert.deepEqual(incomingHormoneEvents({ where: 'private', isSister: true, text: 'x' }).map((e) => e.type), ['msg_from_sister'], '姐妹私聊');
  assert.deepEqual(incomingHormoneEvents({ where: 'group', isSister: true, text: 'x' }).map((e) => e.type), ['msg_from_sister'], '小房子里姐妹说话（调用方只在私聊 / 小房子才传 isSister）');
  const g = incomingHormoneEvents({ where: 'group', text: '大家好', novelty: 0.4 });
  assert.deepEqual(g, [{ type: 'group_msg', toMe: false, text: '大家好', novelty: 0.4 }], '普通群消息');
  const at = incomingHormoneEvents({ where: 'group', atMe: true, text: '在吗' });
  assert.deepEqual(at.map((e) => e.type), ['group_msg', 'mentioned']);
  assert.equal(at[0].toMe, true, '被 @ 算冲她来的');
  assert.equal(incomingHormoneEvents({ where: 'group', nameMention: true, text: '小鲸鱼呢' }).length, 2, '叫名字也算被提到');
  const stranger = incomingHormoneEvents({ where: 'private', text: '你好' });
  assert.deepEqual(stranger.map((e) => e.type), ['group_msg'], '陌生人私聊记 group_msg，不记 mentioned');
  assert.equal(stranger[0].toMe, true);
  assert.deepEqual(incomingHormoneEvents({ where: 'group', isOwner: true, text: 'x' }).map((e) => e.type), ['group_msg'], '老大在群里说话不算「老大私聊」');
  assert.equal('novelty' in incomingHormoneEvents({ where: 'group', text: 'x' })[0], false, '没传新鲜度就不带');
  ok('收到消息翻成事件：老大私聊 / 姐妹 / 群 / 被提到 / 陌生人');
}

// ② 发出去 → 事件；工具 → 事件
{
  assert.deepEqual(sentHormoneEvent('owner'), { type: 'sent_to_owner' });
  assert.deepEqual(sentHormoneEvent('sister'), { type: 'sent_to_sister' });
  assert.deepEqual(sentHormoneEvent('group'), { type: 'sent_group' });
  assert.equal(sentHormoneEvent('other'), null, '别的私聊不记');

  assert.deepEqual(toolHormoneEvents('mcp__snowluma-safe__rambling_append'), [{ type: 'created', kind: 'tidbit' }]);
  assert.deepEqual(toolHormoneEvents('qq_growth_note'), [{ type: 'created', kind: 'diary' }]);
  assert.deepEqual(toolHormoneEvents('mcp__x__novel_section_done'), [{ type: 'created', kind: 'novel' }]);
  assert.deepEqual(toolHormoneEvents('qq_post_qzone'), [{ type: 'posted' }]);
  assert.deepEqual(toolHormoneEvents('mcp__sister-qq__qq_qzone_post'), [{ type: 'posted' }]);
  assert.deepEqual(toolHormoneEvents('pc_screenshot'), [{ type: 'peeked' }]);
  assert.deepEqual(toolHormoneEvents('rambling_append', {}, { ok: false }), [{ type: 'tool_fail' }], '出错只记 tool_fail，不算写了东西');
  assert.deepEqual(toolHormoneEvents('qq_send_message'), [], '不认识的工具不记');
  // 姐姐的 qq_explore：点开了几条记几次 novelty，记感想算一轮逛完，write / deep 另算写了东西
  assert.deepEqual(toolHormoneEvents('mcp__sister-qq__qq_explore', { activity: 'bili' }), [], '只拿清单还没看到新东西');
  assert.deepEqual(toolHormoneEvents('mcp__sister-qq__qq_explore', { open: [1, 2] }).map((e) => e.type), ['novelty', 'novelty']);
  assert.deepEqual(toolHormoneEvents('mcp__sister-qq__qq_explore', { note: { kind: 'write', impression: 'x' } }).map((e) => `${e.type}:${e.kind || ''}`), ['explored:', 'created:work']);
  assert.deepEqual(toolHormoneEvents('mcp__sister-qq__qq_explore', { note: { kind: 'deep', impression: 'x' } }).map((e) => `${e.type}:${e.kind || ''}`), ['explored:', 'created:diary']);
  // 姐姐直接写文件
  assert.deepEqual(toolHormoneEvents('Edit', { file_path: 'E:\\qq-bridge\\sister\\home\\脑子\\日子\\碎碎念\\碎碎念.md' }), [{ type: 'created', kind: 'tidbit' }]);
  assert.deepEqual(toolHormoneEvents('Write', { file_path: 'sister/home/脑子/日子/日记/2026-10-29.md' }), [{ type: 'created', kind: 'diary' }]);
  assert.deepEqual(toolHormoneEvents('Write', { file_path: 'sister/home/脑子/作品/小诗.md' }), [{ type: 'created', kind: 'work' }]);
  assert.deepEqual(toolHormoneEvents('Write', { file_path: 'sister/home/脑子/笔记/随手记.md' }), [], '别的文件不算');

  const ctx = { ownerId: '111', fishId: '222', houseIds: ['333'], houseNames: ['小房子'] };
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: '老大' }, ctx), [{ type: 'sent_to_owner' }]);
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: '小鲸鱼' }, ctx), [{ type: 'sent_to_sister' }]);
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: 'private:222' }, ctx), [{ type: 'sent_to_sister' }]);
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send_voice', { where: 'group:333' }, ctx), [{ type: 'sent_to_sister' }], '小房子算姐妹之间');
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: '小房子' }, ctx), [{ type: 'sent_to_sister' }], '小房子按名字也认');
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: '群D' }, ctx), [{ type: 'sent_group' }]);
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send_fish_sticker', { where: '老大', name: '开心' }, ctx).map((e) => e.type), ['sent_to_owner', 'sticker_sent']);
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_recent', { where: '老大' }, ctx), [], '不是发送工具');
  assert.deepEqual(toolSendHormoneEvents('mcp__sister-qq__qq_send', { where: 'private:999' }, ctx), [], '别的私聊不记');
  ok('发出去 / 工具用过 → 事件（写碎碎念、札记、小说一节、说说、看老大电脑、逛、发表情、出错）');
}

// ③ 群消息新鲜度
{
  const t = createNoveltyTracker();
  const first = t.score('g', '今天天气真好呀我们出去玩吧');
  assert.ok(first >= 0.5 && first <= 1, `头一句算新的：${first}`);
  const again = t.score('g', '今天天气真好呀我们出去玩吧');
  assert.ok(again <= 0.2, `重复的话是老一套：${again}`);
  assert.ok(t.score('g', '哈') <= 0.2, '太短的算老一套');
  assert.ok(t.score('g', '昨晚的比赛太精彩了那个绝杀谁看了') > 0.6, '换了话题又是新的');
  assert.ok(t.score('other', '今天天气真好呀我们出去玩吧') >= 0.5, '各会话分开记');
  ok('群消息新鲜度：新话题高、重复的低、各会话分开');
}

// ④ 心情 → mood 事件
{
  const now = 1_000_000_000_000;
  const base = { mood: 60, dims: { happy: 15, calm: 6, sweet: 3, worry: 9, sad: 3, heartache: 12 }, updatedAt: now, lastDecayAt: now };
  assert.deepEqual(moodHormoneEvent(base, now), { type: 'mood', negative: 0.4, positive: 0.5 }, '正面取 开心 / 踏实 / 甜蜜 最大，负面取 心疼 / 担心 / 难过 / 吃醋 最大，各除以 30');
  const later = moodHormoneEvent(base, now + 3 * 3600e3); // 3 小时 = 两个半衰期（1.5h）→ 原来的 1/4
  assert.equal(later.positive, 0.125, `按时间衰减：${later.positive}`);
  assert.equal(moodHormoneEvent({ mood: 90, dims: { happy: 100 }, updatedAt: now }, now).positive, 1, '压到 1 封顶');
  assert.equal(moodHormoneEvent(null, now), null, '没有心情文件');
  assert.equal(moodHormoneEvent('x', now), null);
  ok('心情换算：正负各取最大、除以 30、按时间衰减、封顶 1');
}

// ⑤ 天气：weather.mjs 的 weatherState + weatherHormoneEvents
{
  const j = (code, precip = 0, temp = 18.3, isDay = 1) => ({ current: { weather_code: code, precipitation: precip, temperature_2m: temp, is_day: isDay }, daily: { time: ['2026-10-29'], sunrise: ['2026-10-29T06:12'], sunset: ['2026-10-29T17:08'] } });
  const rain = weatherState(j(61, 0.4), 123);
  assert.deepEqual({ rain: rain.rain, sunny: rain.sunny, tempC: rain.tempC, sunrise: rain.sunrise, sunset: rain.sunset, text: rain.text, at: rain.at }, { rain: true, sunny: false, tempC: 18.3, sunrise: 6.2, sunset: 17.13, text: '小雨', at: 123 });
  assert.equal(weatherState(j(0)).sunny, true);
  assert.equal(weatherState(j(0, 0, 20, 0)).sunny, false, '晴朗的夜里不算 sunny');
  assert.equal(weatherState(j(3)).rain, false);
  assert.equal(weatherState(j(95)).rain, true, '雷阵雨算下雨');
  assert.equal(weatherState({}), null, '没数据返回 null');
  const evs = weatherHormoneEvents(rain);
  assert.deepEqual(evs.map((e) => e.type), ['weather', 'sun']);
  assert.equal(evs[0].kind, 'rain');
  assert.equal(evs[0].tempC, 18.3);
  assert.deepEqual({ sunrise: evs[1].sunrise, sunset: evs[1].sunset }, { sunrise: 6.2, sunset: 17.13 });
  assert.deepEqual(weatherHormoneEvents(null), []);
  ok('结构化天气：下雨 / 晴 / 几度 / 日出日落（北京时间的小时数）；null 安全');
}

// ⑥ 兴趣词
{
  const dir = tmp();
  const persona = path.join(dir, 'state.json');
  fs.writeFileSync(persona, JSON.stringify({ interests: [
    { topic: '洛天依/术力口 歌曲', evidence: [{ signal: 'like' }, { signal: 'like' }, { signal: 'like' }] },
    { topic: '八卦新闻', evidence: [{ signal: 'dislike' }, { signal: 'like' }] },
  ] }));
  const fish = loadFishInterests(persona);
  assert.ok(fish.some((x) => x.word === '洛天依'), '正向证据够的选题拆成词');
  assert.ok(!fish.some((x) => x.word.includes('八卦')), '反感多于喜欢的不要');
  assert.deepEqual(loadFishInterests(path.join(dir, '没有.json')), [], '读不到返回空');
  fs.writeFileSync(persona, '{坏的');
  assert.deepEqual(loadFishInterests(persona), [], '坏文件返回空');

  // 姐姐：只用她自己的观看记录（who 是 sister 的 video 行）和「我自己.md」，不用妹妹的
  const lines = [
    { who: 'sister', kind: 'video', title: '洛天依 别把夏天关掉 翻唱', up: '某UP' },
    { who: 'sister', kind: 'video', title: '洛天依 新曲 夏天', up: '某UP' },
    { who: 'fish', kind: 'video', title: '我的世界红石音乐 教程', up: '别的UP' },
    { who: 'sister', kind: 'debrief', title: '', up: '' },
  ].map((x) => JSON.stringify(x));
  const self = '# 我自己\n- 我喜欢《别把夏天关掉》这首词\n- 老大叫我小克\n';
  const sis = sisterInterestsFrom({ lines, selfText: self });
  const words = sis.map((x) => x.word);
  assert.ok(words.includes('洛天依'), `观看记录里重复出现的词：${words.join(',')}`);
  assert.ok(words.includes('《别把夏天关掉》') || words.includes('别把夏天关掉'), '自己写的喜欢的书名 / 歌名');
  assert.ok(!words.some((w) => w.includes('红石')), '妹妹看的不算姐姐的');
  assert.ok(!words.includes('老大'), '停用词不要');
  assert.ok(sis.every((x) => x.weight >= 0.5 && x.weight <= 2));
  assert.deepEqual(sisterInterestsFrom({}), [], '什么都没有就是空');
  const bili = path.join(dir, 'bili-watch.jsonl');
  const selfFile = path.join(dir, '我自己.md');
  fs.writeFileSync(bili, `${lines.join('\n')}\n`);
  fs.writeFileSync(selfFile, self);
  assert.ok(loadSisterInterests({ biliFile: bili, selfFile }).some((x) => x.word === '洛天依'), '从文件读');
  assert.deepEqual(loadSisterInterests({ biliFile: path.join(dir, 'x'), selfFile: path.join(dir, 'y') }), [], '文件都不在也不抛');
  assert.ok(extractKeywords(['天依唱歌', '天依新曲']).some((x) => x.word === '天依'), '至少出现在两段文字里才算');
  ok('兴趣词：小鲸鱼从抖音人格资料、姐姐从自己的观看记录和我自己.md（不共用）；读不到不抛');
}

// ⑦ 安全壳：开关、出错、同类出错去重、真的写到影子文件
{
  const dir = tmp();
  const errors = [];
  const off = createHormoneFeed({ who: 'fish', stateDir: dir, enabled: false, onError: (e) => errors.push(e) });
  off.record({ type: 'msg_from_owner', text: '你好' });
  off.tick();
  assert.equal(off.enabled, false);
  assert.deepEqual(fs.readdirSync(dir), [], 'hormones.enabled=false 什么都不写');

  let clock = Date.parse('2026-10-29T10:00:00Z');
  const on = createHormoneFeed({ who: 'sister', stateDir: dir, skewMs: () => 3 * 3600e3, clock: () => clock, onError: (e) => errors.push(e) });
  assert.equal(on.enabled, true);
  on.record({ type: 'msg_from_owner', text: '你今天真棒，谢谢你' });
  on.record({ type: 'sent_to_owner' });
  on.record({ type: 'send_fail' });
  on.record({ type: 'send_fail' }); // 3 秒内同类出错只记一次
  const line = on.tick();
  assert.ok(line, 'tick 写了一行');
  assert.deepEqual(line.ev, ['msg_from_owner', 'sent_to_owner', 'send_fail'], `事件按顺序进了影子记录：${line.ev}`);
  assert.ok(line.ap.includes('praise'), '消息文字过了关键词判断，只记强度标签');
  const raw = fs.readFileSync(path.join(dir, 'hormones-sister.jsonl'), 'utf8');
  assert.ok(!raw.includes('你今天真棒'), '原文不落盘');
  assert.ok(on.snapshot().levels, 'snapshot 能取');
  on.setInterests(['猫']);
  clock += 120e3;
  assert.ok(on.tick(), '之后还能接着记');

  // 记录器出错也不抛
  const bad = createHormoneFeed({ who: 'fish', stateDir: dir, createShadow: () => ({ record() { throw new Error('boom'); }, tick() { throw new Error('boom2'); }, setInterests() { throw new Error('boom3'); }, snapshot() { throw new Error('boom4'); } }), onError: (e) => errors.push(e) });
  bad.record({ type: 'msg_from_owner' });
  assert.equal(bad.tick(), null);
  bad.setInterests(['x']);
  assert.equal(bad.snapshot(), null);
  const broken = createHormoneFeed({ who: 'fish', stateDir: dir, createShadow: () => { throw new Error('建不起来'); }, onError: (e) => errors.push(e) });
  assert.equal(broken.enabled, false, '建不起来就当没开，不抛');
  broken.record({ type: 'sleep' });
  assert.ok(errors.length >= 5, '出的错都交给 onError');
  assert.deepEqual(Object.keys(HORMONE_REFRESH).sort(), ['interestsMs', 'moodMs', 'weatherMs']);
  assert.equal(HORMONE_REFRESH.weatherMs, 30 * 60e3, '天气 30 分钟一次');
  assert.equal(HORMONE_REFRESH.interestsMs, 3600e3, '兴趣表一小时刷新');
  ok('安全壳：关了不写、出错不抛、同类出错去重、原文不落盘、真的写进 hormones-<who>.jsonl');
}

// ⑧ 姐姐 runClaude 数工具出错（is_error 的 tool_result）
{
  const mk = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; return c; };
  const child = mk();
  const line = (x) => `${JSON.stringify(x)}\n`;
  const p = runClaude({ child }, { prompt: 'x', sessionId: 's' });
  child.stdout.emit('data', line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sister-qq__qq_send', input: {} }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'boom' }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'fine' }, { type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'boom' }] } })
    + line({ type: 'user', message: { content: 'plain text' } })
    + line({ type: 'result', is_error: false, result: '好', session_id: 's' }));
  const r = await p;
  assert.equal(r.toolErrors, 2, '数出两次工具出错');
  assert.equal(r.toolsUsed.length, 1);
  const c2 = mk();
  const p2 = runClaude({ child: c2 }, { prompt: 'x', sessionId: 's' });
  c2.stdout.emit('data', line({ type: 'result', is_error: false, result: '好', session_id: 's' }));
  assert.equal((await p2).toolErrors, 0, '没出错就是 0');
  ok('姐姐 runClaude 返回 toolErrors（tool_result 的 is_error 计数）');
}

// ⑨ 2026-10-29 借鉴积温：戒备（面子）、专注（沉浸）、想念驱力不需要新的接线——用接线里已有的事件就能推出来
{
  const dir = tmp();
  let clock = Date.parse('2026-10-29T10:00:00Z');
  const feed = createHormoneFeed({ who: 'fish', stateDir: dir, clock: () => clock });
  const feedAll = (evs) => { for (const e of evs) feed.record({ ...e, at: clock }); };
  // 老大私聊来回聊得热：收到（msg_from_owner）、她发（sent_to_owner）交替
  feedAll(sentHormoneEvent('owner') ? [sentHormoneEvent('owner')] : []);
  clock += 30e3;
  feedAll(incomingHormoneEvents({ where: 'private', isOwner: true, text: '在呢，怎么了' }));
  clock += 30e3;
  feedAll([sentHormoneEvent('owner')]);
  clock += 30e3;
  feedAll(incomingHormoneEvents({ where: 'private', isOwner: true, text: '哈哈真的吗' }));
  // 刚写完一节小说（工具用过 → created novel）
  feedAll(toolHormoneEvents('novel_section_done', {}));
  const line = feed.tick();
  assert.ok(line, 'tick 写了一行');
  assert.ok(line.lv.focus > 0.4, `接线里已有的事件就能推出专注（${line.lv.focus}）`);
  assert.ok(Number.isFinite(line.lv.guard) && Number.isFinite(line.lv.driveOwner) && Number.isFinite(line.lv.driveSister), '日志里有戒备和驱力');
  // 被敷衍（私聊里只回一个「嗯」）→ 戒备起来（妹妹对冷落敏感）
  clock += 120e3;
  feedAll(incomingHormoneEvents({ where: 'private', isOwner: true, text: '嗯' }));
  feedAll(incomingHormoneEvents({ where: 'private', isOwner: true, text: '哦' }));
  clock += 120e3;
  assert.ok(feed.tick().lv.guard > 0.1, '被敷衍两次，戒备起来');
  assert.equal(feed.snapshot().persona, 'fish');
  ok('接线：不新增调用方接口，已有事件就能推出专注 / 戒备，日志里带 guard / focus / driveOwner / driveSister');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n激素接线：${passed} 项通过`);

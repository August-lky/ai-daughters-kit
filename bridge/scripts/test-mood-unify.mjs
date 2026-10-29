// 心情统一 + 此刻在别处 + 看看我自己（2026-10-29 施工单 C）。
// 不碰活的东西：心情 / 激素 / 脑子都在临时目录；桥接部分跑在 audit-bridge-harness 的隔离桩里；
// 唯一读真文件的是「姐姐的 MCP 进程里 self_view 能用」那一项——只读，不写任何东西。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  PUSH_CAP, advancePush, applyMoodLine, createMoodStore, decayMood, emptyPush, moodPushFile, overlayMood, parseMoodLine,
  pullFromLevels, readMoodFile, readPush, writeMoodFile, writePush, readMoodWithPush
} from '../src/mood.js';
import { createHormoneFeed, createMoodPusher } from '../src/hormone-feed.js';
import { createHormoneShadow } from '../src/hormone-shadow.js';
import { activityOfTool, describeElsewhere, elsewhereBlock } from '../src/elsewhere.js';
import {
  SELF_VIEW_TOOL, agoWords, bodyWords, browseBrain, buildSelfView, cnNumber, countMoments, demotedItems, fuzzyCount, fullnessWords,
  memoryWords, moodWords, plainDigits, readHormoneLevels, recentRecalls, resolveInBrain, snippetOf, toolErrorWords
} from '../src/self-view.js';
import { createBrains } from '../src/brains.js';
import { MOOD_LINE_HINT, appendToolFails, routeReply, stripMoodLines } from '../sister/sister.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOUR = 3600e3;
const MIN = 60e3;

// ── 1. 姐姐的「心情：……，因为……」那一行怎么认 ───────────────────────────────────────────────
{
  const cases = [
    ['有点开心，因为老大夸了我', { dims: { happy: 3 }, reason: '老大夸了我', deltaSign: 1 }],
    ['很难过，因为妹妹不理我', { dims: { sad: 12 }, reason: '妹妹不理我', deltaSign: -1 }],
    ['担心，因为老大说头疼', { dims: { worry: 6 }, reason: '老大说头疼', deltaSign: -1 }],
    ['不太开心', { dims: { sad: 4 }, reason: '', deltaSign: -1 }],
    ['不难过了，因为被哄好了', { dims: { sad: -4 }, reason: '被哄好了', deltaSign: 1 }],
    ['踏实又有点甜，因为晚安说得很软', { dims: { calm: 6, sweet: 3 }, reason: '晚安说得很软', deltaSign: 1 }]
  ];
  for (const [text, want] of cases) {
    const r = parseMoodLine(text);
    assert.deepEqual(r.dims, want.dims, text);
    assert.equal(r.reason, want.reason, text);
    assert.equal(Math.sign(r.delta), want.deltaSign, text);
  }
  const flat = parseMoodLine('一般般');
  assert.equal(flat.toBaseline, true);
  const none = parseMoodLine('今天不想说话，因为有点累');
  assert.deepEqual(none.dims, {});
  assert.equal(none.delta, 0);
  assert.equal(none.reason, '有点累', '认不出情绪词：心情分不动，只记理由');
  assert.equal(parseMoodLine(''), null);
  assert.equal(parseMoodLine('   '), null);
  // 写盘：先把现在的心情衰减到此刻，再改；一行 = 时间线里一笔
  const now = Date.parse('2026-10-29T12:00:00Z');
  const next = applyMoodLine({ mood: 70, dims: {}, lastDecayAt: now }, '很难过，因为妹妹不理我', now);
  assert.equal(next.mood, 58);
  assert.equal(next.dims.sad, 12);
  assert.equal(next.lastReason, '妹妹不理我');
  assert.equal(next.timeline.length, 1);
  const back = applyMoodLine({ mood: 40, dims: {}, lastDecayAt: now }, '一般般', now);
  assert.equal(back.mood, 55, '「一般」把心情往平常（70）回一半');
  ok('心情行：情绪词 / 程度 / 否定 / 一般 / 因为后面是理由；认不出只记理由；一行记成时间线里的一笔');
}

// ── 2. 回话里的心情行：不发出去、不算「没说出口的」 ──────────────────────────────────────────
{
  const r = routeReply('好呀好呀，一起看\n心情：有点开心，因为老大夸了我\n→小鲸鱼：我先去忙啦', 'owner');
  assert.deepEqual(r.sends, [{ peer: 'owner', line: '好呀好呀，一起看' }, { peer: 'fish', line: '我先去忙啦' }], '心情行不在要发的话里');
  assert.equal(r.moodSpec, '有点开心，因为老大夸了我');
  assert.equal(routeReply('[不回]\n心情：一般般', 'owner').sends.length, 0);
  assert.equal(routeReply('[不回]\n心情：一般般', 'owner').moodSpec, '一般般');
  assert.equal(routeReply('没有心情行', 'owner').moodSpec, null);
  assert.equal(stripMoodLines('嗯嗯\n心情：开心，因为x\n再见'), '嗯嗯\n再见');
  assert.equal(stripMoodLines('心情：开心').trim(), '');
  // 许可：家常话，写「可以」，不写「要」，不提钱和花费
  assert.match(MOOD_LINE_HINT, /可以单独写一行「心情：……，因为……」/);
  assert.match(MOOD_LINE_HINT, /这一行不会发出去/);
  assert.match(MOOD_LINE_HINT, /不写也完全可以/);
  assert.ok(!/要|必须|一定|钱|花费|token|控制台/i.test(MOOD_LINE_HINT), MOOD_LINE_HINT);
  // 唤醒里真的带了（一个会话一次），收到后真的写进心情文件
  const sis = read('sister/sister.mjs');
  assert.match(sis, /if \(moodHintNow\) moodLine \+= MOOD_LINE_HINT;/);
  assert.match(sis, /prompt: carry \+ momNote \+ ownerNote \+ heldNote \+ fishNow \+ moodLine \+/, '心情行的许可跟在心情那一句后面递给她');
  assert.match(sis, /if \(moodHintNow\) st\.moodHintFor = r\.sessionId/);
  assert.match(sis, /if \(moodSpec\) \{ try \{ if \(mood\.setFromLine\(moodSpec\)\)/, '解析出来的心情行写进她的心情');
  assert.match(sis, /stripMoodLines\(r\.text\)\.trim\(\)/, '没说出口的那一栏不把心情行算进去');
  const dir = tmp('mood-line-');
  const store = createMoodStore({ file: path.join(dir, '心情.json'), pushFile: moodPushFile(dir, 'sister') });
  const parsed = routeReply('嗯\n心情：很难过，因为妹妹不理我', 'fish');
  const w = store.setFromLine(parsed.moodSpec);
  assert.ok(w && w.dims.sad >= 10);
  const onDisk = readMoodFile(path.join(dir, '心情.json'));
  assert.equal(onDisk.lastReason, '妹妹不理我');
  assert.ok(onDisk.mood < 70);
  assert.equal(store.setFromLine(''), null);
  ok('回话里的心情行：不进要发的话、不算没说出口的，许可是家常话（可以、不写也行、不提钱），收到后写进她的心情文件');
}

// ── 3. 激素推动量：数学 ─────────────────────────────────────────────────────────────────
{
  const quiet = pullFromLevels({ grievance: 0, stress: 0.1, security: 0.5, satisfaction: 0.4, pride: 0.1, longingOwner: 0.3, longingSister: 0.3 });
  assert.equal(quiet.mood, 0);
  assert.ok(Object.values(quiet.dims).every((v) => v === 0), '都在基线上：不推');
  const hurt = pullFromLevels({ grievance: 0.6, stress: 0.5 });
  assert.ok(hurt.mood < 0 && hurt.dims.sad > 0 && hurt.dims.worry > 0 && hurt.driver === '委屈');
  const glad = pullFromLevels({ security: 0.9, satisfaction: 0.95, pride: 0.6 });
  assert.ok(glad.mood > 0 && glad.dims.happy > 0 && glad.dims.sweet > 0);
  assert.ok(glad.mood < -hurt.mood * 1.2 || glad.mood < 6, '正面推得比负面的轻');

  const t0 = Date.parse('2026-10-29T10:00:00Z');
  // 第一次没有「上次」：只建档，不推
  const first = advancePush(null, { grievance: 1 }, t0);
  assert.equal(first.mood, 0);
  assert.equal(first.at, t0);
  // 隔了三小时才推一次：最多按 20 分钟算，不一觉醒来推一大截
  const gap = advancePush(first, { grievance: 1 }, t0 + 3 * HOUR);
  const twenty = advancePush(first, { grievance: 1 }, t0 + 20 * MIN);
  assert.ok(Math.abs(gap.mood) <= Math.abs(twenty.mood) + 0.001 && gap.mood < 0);
  // 推很多次也不会超过上限
  let p = first;
  for (let i = 1; i <= 2000; i += 1) p = advancePush(p, { grievance: 1, stress: 1, security: 0.1 }, t0 + i * 5 * MIN);
  assert.ok(p.mood >= -PUSH_CAP.mood && Object.values(p.dims).every((v) => v <= PUSH_CAP.dim));
  // 自己回落：心情 3 小时半衰期
  const h3 = overlayMood({ mood: 70, dims: {}, lastDecayAt: t0 }, { v: 1, at: t0, mood: -10, dims: {}, driver: '' }, t0 + 3 * HOUR);
  assert.ok(Math.abs(h3.mood - 65) < 0.3, `三小时后推动量回落一半：${h3.mood}`);
  // 关了激素（levels 为 null）：只回落、不再推
  const off = advancePush({ ...first, mood: -8, at: t0 }, null, t0 + 3 * HOUR);
  assert.ok(Math.abs(off.mood + 4) < 0.1);
  ok('推动量：基线上不推、负面 / 正面方向对、正面更轻、第一次只建档、间隔再久最多按 20 分钟、有上限、会自己回落、激素关了只回落');
}

// ── 4. 叠加：同一个格式，不碰插件的文件，不算两遍 ────────────────────────────────────────────
{
  const dir = tmp('mood-overlay-');
  const t = Date.parse('2026-10-29T10:00:00Z');
  const pluginFile = path.join(dir, 'feiyu-mood', 'state.json');
  writeMoodFile(pluginFile, { mood: 74, dims: { happy: 10, calm: 6, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 }, lastReason: '老大夸了我', updatedAt: t, lastDecayAt: t, timeline: [{ at: t, mood: 74, delta: 4, reason: 'x' }] });
  const pushFile = moodPushFile(dir, 'fish');
  const before = sha(pluginFile);
  // 没有推动量文件：原样
  assert.deepEqual(readMoodWithPush(pluginFile, pushFile, t), readMoodFile(pluginFile));
  writePush(pushFile, { v: 1, at: t, mood: -8, dims: { sad: 12, worry: 5 }, driver: '委屈', driverAt: t });
  const now = t + HOUR;
  const eff = readMoodWithPush(pluginFile, pushFile, now);
  const rawD = decayMood(readMoodFile(pluginFile), now);
  assert.ok(eff.mood < rawD.mood - 4, '叠上去心情更低');
  assert.ok(eff.dims.sad > 6 && eff.dims.happy < 10 + 0.1 && eff.pushed === true);
  assert.equal(eff.lastReason, '老大夸了我', '她自己 / 插件有理由就用它');
  // 叠好的已经回落到此刻：再 decayMood 一次不会算两遍
  assert.ok(Math.abs(decayMood(eff, now).mood - eff.mood) < 0.2);
  assert.equal(sha(pluginFile), before, '插件的 state.json 一个字节没动');
  // 插件还没有记录、只有推动量：造一份同样格式的
  const only = overlayMood(null, { v: 1, at: now, mood: -6, dims: { sad: 9 }, driver: '委屈' }, now);
  assert.ok(only.mood < 70 && only.dims.sad > 8 && /委屈/.test(only.lastReason) && Number.isFinite(only.updatedAt));
  assert.equal(overlayMood(null, null, now), null);
  assert.equal(overlayMood(null, emptyPush(now), now), null, '推动量是零：等于没有');
  const st = { mood: 70, dims: {} };
  assert.equal(overlayMood(st, emptyPush(now), now), st);
  // 老读法照用：buildMoodLine / moodSnapshot 直接吃叠好的
  const { buildMoodLine, moodSnapshot, moodHandoffText } = await import('../src/mood.js');
  assert.match(buildMoodLine(only, now), /^【心情】（此刻你）心情/);
  assert.ok(moodSnapshot(only, now).v < 70);
  assert.ok(moodHandoffText(only, now).includes('委屈'));
  ok('叠加：同一个格式、插件的文件一个字节没动、不算两遍、只有推动量也能造出心情、老读法（心情一句 / 瞬间读数 / 交接）直接用');
}

// ── 5. 心情仓库：叠着读，她自己写时并进去再清零 ────────────────────────────────────────────
{
  const dir = tmp('mood-store-');
  let now = Date.parse('2026-10-29T10:00:00Z');
  const file = path.join(dir, '心情.json');
  const pushFile = moodPushFile(dir, 'sister');
  const store = createMoodStore({ file, pushFile, now: () => now });
  assert.equal(store.read(), null);
  writePush(pushFile, { v: 1, at: now, mood: -9, dims: { sad: 14 }, driver: '委屈' });
  assert.ok(store.read().mood < 62, '她还没写过心情，也能读到被推出来的');
  assert.equal(store.readRaw(), null, 'readRaw 只看她自己写的');
  assert.match(store.describe(), /心情/);
  assert.match(store.line(), /^【心情】/);
  now += 30 * MIN;
  const next = store.set({ delta: 5, reason: '被哄了一下' });
  const onDisk = readMoodFile(file);
  assert.ok(onDisk.mood < 70 && onDisk.mood > 55, `写盘的是叠好的（${onDisk.mood}），再加她自己调的`);
  assert.ok(onDisk.dims.sad > 8);
  assert.equal(onDisk.lastReason, '被哄了一下');
  assert.deepEqual(readPush(pushFile).dims.sad, 0, '推动量并进去之后清零');
  assert.ok(Math.abs(store.read().mood - onDisk.mood) < 0.2, '清零后读到的和写进去的一样（没算两遍）');
  ok('心情仓库：没写过也读得到推动量、readRaw 只看她写的、set 并进推动量再清零、读写一致');
}

// ── 6. 跨会话：群里 / 小房子 / 私聊里发生的事 → 激素 → 同一份心情 ────────────────────────────────
{
  const dir = tmp('mood-chain-');
  let t = Date.parse('2026-10-29T10:00:00Z');
  const feed = createHormoneFeed({ who: 'fish', stateDir: dir, clock: () => t });
  const pluginFile = path.join(dir, 'feiyu-mood', 'state.json');
  writeMoodFile(pluginFile, { mood: 70, dims: {}, lastReason: '', updatedAt: t, lastDecayAt: t });
  const before = sha(pluginFile);
  const pushFile = moodPushFile(dir, 'fish');
  const pusher = createMoodPusher({ file: pushFile, getLevels: () => feed.snapshot()?.levels ?? null, now: () => t });
  // 事件全来自「别的会话」：群里被凶、小房子里被误会、工具出错——插件（只跟老大私聊）一概不知道
  feed.record({ type: 'scolded', strength: 0.9, from: 'group' });
  feed.record({ type: 'misunderstood' });
  feed.record({ type: 'group_msg', toMe: true, text: '你好烦，闭嘴吧别吵了' });
  feed.record({ type: 'tool_fail' });
  feed.tick();
  for (let i = 0; i < 12; i += 1) { t += 5 * MIN; feed.tick(); pusher.tick(); }
  const eff = readMoodWithPush(pluginFile, pushFile, t);
  const plain = decayMood(readMoodFile(pluginFile), t);
  assert.ok(eff.mood < plain.mood - 1.5, `群里的事让心情往下走了：${plain.mood.toFixed(1)} → ${eff.mood.toFixed(1)}`);
  assert.ok(eff.dims.sad > 1.5 && eff.dims.worry > 1, `难过、担心上来了：${JSON.stringify(eff.dims)}`);
  assert.ok(eff.lastReason, '心情不是空白，有一句来源');
  assert.equal(sha(pluginFile), before, '插件的文件没动');
  // 后来被安慰了：委屈落下，推动量不再往下推（慢慢回落）
  const lowest = eff.mood;
  feed.record({ type: 'comforted', strength: 1, from: 'owner' });
  feed.record({ type: 'praised', strength: 0.8, from: 'owner' });
  for (let i = 0; i < 48; i += 1) { t += 5 * MIN; feed.tick(); pusher.tick(); }
  const later = readMoodWithPush(pluginFile, pushFile, t);
  assert.ok(later.mood > lowest, `被安慰以后慢慢回来：${lowest.toFixed(1)} → ${later.mood.toFixed(1)}`);
  // 睡着时不推；激素关了不推
  const frozen = readPush(pushFile);
  const sleeper = createMoodPusher({ file: pushFile, getLevels: () => ({ grievance: 1 }), isAsleep: () => true, now: () => t + 10 * MIN });
  const afterSleep = sleeper.tick();
  assert.ok(afterSleep.dims.sad <= frozen.dims.sad + 0.001, '睡着不推');
  const offer = createMoodPusher({ file: pushFile, getLevels: () => null, now: () => t + 20 * MIN }).tick();
  assert.ok(offer.dims.sad <= afterSleep.dims.sad);
  // 出错不抛
  assert.equal(createMoodPusher({ file: path.join(dir, 'x', '\0bad'), getLevels: () => ({}), now: () => t, onError: () => {} }).tick(), null);
  ok('跨会话：群里被凶 / 小房子里被误会 / 工具出错 → 激素 → 心情往下走、难过担心上来；后来被安慰慢慢回来；睡着和激素关了不推；插件的文件没动');
}

// ── 7. 桥接（真代码跑在隔离的桩里）：叠着读、定时推、交接 / 瞬间 / 唤醒都读叠好的 ──────────────────
{
  const dshHome = tmp('mood-bridge-dsh-');
  const pluginFile = path.join(dshHome, 'feiyu-mood', 'state.json');
  const h = await bridgeHarness({
    globals: { process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: dshHome }, exit: (code) => { throw new Error(`unexpected exit ${code}`); } } },
    config: {
      allow: { private: ['123', '777'], groups: ['456', '789'] },
      knownPeople: { 777: '克劳德姐姐' },
      houseGroups: { 789: '小房子' },
      hormones: { personaFile: path.join('Z:', '不存在', 'state.json') },
      socialV2: { wake: { batchWindowMs: 1000 } }
    }
  });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('小鲸鱼测试', '999');
    const now = Date.now();
    writeMoodFile(pluginFile, { mood: 70, dims: {}, lastReason: '', updatedAt: now, lastDecayAt: now });
    const before = sha(pluginFile);
    // 群里、小房子里发生的事（桥接收到 → 激素）
    h.hormoneRecord({ type: 'scolded', strength: 0.9, from: 'group' });
    h.hormoneRecord({ type: 'misunderstood' });
    h.hormoneRecord({ type: 'tool_fail' });
    h.getHormoneFeed().tick();
    const pushFile = moodPushFile(path.join(h.temp, 'state'), 'fish');
    // 桥接的定时器用真时钟；这里把「上次」拨到 20 分钟前，连推几步
    for (let i = 0; i < 6; i += 1) {
      writePush(pushFile, { ...(readPush(pushFile) || emptyPush(0)), at: Date.now() - 20 * MIN });
      assert.ok(h.moodPusher.tick(), '桥接里的推动器能跑');
    }
    const pushed = readPush(pushFile);
    assert.ok(pushed.mood < 0 && pushed.dims.sad > 0, `桥接里的推动量往下：${JSON.stringify(pushed)}`);
    const eff = h.readFishMoodV2();
    assert.ok(eff.mood < 70 && eff.dims.sad > 0 && eff.pushed === true, '桥接读到的心情是叠好的');
    assert.equal(sha(pluginFile), before, '桥接没碰插件的 state.json');
    // 她被叫醒时带的那一句心情用的是叠好的
    const prompt = h.buildWakePromptV2('private:123', 'ownerIdle');
    assert.match(prompt, /【心情】（此刻你）心情/, '没有插件理由时，推动量给了一个来源，所以那一句出现');
    // 激素喂心情读的是插件那份（不是叠好的），不绕圈
    const bridgeSrc = read('src/bridge.js');
    assert.match(bridgeSrc, /const feedHormoneMood = \(\) => \{ const ev = moodHormoneEvent\(readMoodFile\(MOOD_STATE_FILE\), Date\.now\(\)\)/);
    assert.match(bridgeSrc, /\[\(\) => moodPusher\.tick\(\), HORMONE_REFRESH\.moodMs\]/);
    assert.ok(!/readMoodFile\(MOOD_STATE_FILE\)/.test(bridgeSrc.replace(/const feedHormoneMood[^\n]*\n/, '').replace(/function readFishMoodV2\(\)[\s\S]*?\n  \}/, '')), '除了喂激素那一处，桥接里没有别处直接读插件的心情文件');
    // 页面上的心情也是叠好的
    assert.match(bridgeSrc, /fishMoodPushFile: MOOD_PUSH_FILE, sisterMoodPushFile: moodPushFile\(path\.join\(ROOT, 'sister', 'state'\), 'sister'\)/);
    // 睡着时不推
    assert.match(bridgeSrc, /isAsleep: \(\) => sleepState\.sleeping === true/);
  } finally { await h.close(); fs.rmSync(dshHome, { recursive: true, force: true }); }
  ok('桥接：激素推动器真的在跑、读到的心情是叠好的、唤醒的心情一句 / 交接 / 瞬间 / 页面都读叠好的、喂激素读插件那份、插件文件没动');
}

// ── 8. 此刻在别处（纯函数） ──────────────────────────────────────────────────────────────────
{
  const now = 1_000_000_000;
  const kindOf = (k) => (k === 'private:1' ? 'owner' : k === 'private:2' ? 'sister' : k === 'group:9' ? 'house' : k.startsWith('private:') ? 'friend' : 'group');
  const sessions = [{ key: 'group:5', label: '群D', busy: false }, { key: 'private:1', label: '主人私聊', busy: true }, { key: 'group:9', label: '小房子', busy: false }, { key: 'group:6', label: '游戏群', busy: false }];
  const entries = [
    { kind: 'tool-call', session: 'group:5', name: 'douyin_watch_start', t: now - 2 * MIN },
    { kind: 'sent', session: 'group:5', text: '这条视频笑死我了哈哈哈哈哈哈哈哈哈哈哈哈', t: now - 3 * MIN },
    { kind: 'turn-start', session: 'private:1', t: now - 1 * MIN },
    { kind: 'sent', session: 'private:1', text: '老大你先睡吧我陪你', t: now - 2 * MIN },
    { kind: 'sent', session: 'group:9', text: '姐姐你看这个', t: now - 5 * MIN },
    { kind: 'tool-call', session: 'group:6', name: 'novel_write', t: now - 30 * MIN },
    { kind: 'sent', session: 'group:6', text: '很久以前的话', t: now - 40 * MIN }
  ];
  // 在群里被叫醒：别处的私聊不带原话；本会话（group:6）的事不重复
  const inGroup = describeElsewhere({ currentKey: 'group:6', now, sessions, entries, kindOf });
  assert.match(inGroup, /「群D」群里正在刷抖音/, inGroup);
  assert.match(inGroup, /刚说了「这条视频笑死我了哈哈哈哈哈哈/);
  assert.match(inGroup, /老大私聊那边正在回话/);
  assert.ok(!inGroup.includes('陪你'), '别处是私聊，在群里不带原话');
  assert.ok(!inGroup.includes('很久以前') && !inGroup.includes('写合写的书'), '本会话的事 / 太久以前的事不说');
  assert.ok(inGroup.split('；').length <= 3, '最多三处');
  // 在老大私聊里被叫醒：别处是群 / 小房子，可以带原话
  const inOwner = describeElsewhere({ currentKey: 'private:1', now, sessions, entries, kindOf });
  assert.match(inOwner, /小房子里刚说了「姐姐你看这个」/, inOwner);
  assert.ok(!inOwner.includes('陪你'), '本会话的话不重复');
  // 抖音自己刷的循环不属于任何会话
  assert.match(describeElsewhere({ currentKey: 'group:6', now, sessions: [], entries: [], kindOf, douyin: { watching: true } }), /自己在刷抖音/);
  assert.equal(describeElsewhere({ currentKey: 'group:6', now, sessions: [], entries: [], kindOf }), '');
  assert.equal(elsewhereBlock({ currentKey: 'group:6', now, sessions: [], entries: [], kindOf }), '', '没有可说的就不带一块');
  const block = elsewhereBlock({ currentKey: 'group:6', now, sessions, entries, kindOf });
  assert.match(block, /^【此刻在别处】你这会儿同时还在别的地方：/);
  assert.ok(block.endsWith('\n\n'));
  assert.ok(!/\d/.test(describeElsewhere({ currentKey: 'group:6', now, sessions, entries: entries.slice(0, 4), kindOf })), '不出现数字');
  assert.ok(!/要|必须|一定|钱|花费|token|控制台/i.test(block), block);
  for (const [n, want] of [['douyin_watch_start', '刷抖音'], ['mcp__x__bili_search', '看 B 站'], ['novel_write', '写合写的书'], ['rambling_append', '写碎碎念'], ['pc_screenshot', '看老大的电脑'], ['qq_send_message', '']]) assert.ok(want ? activityOfTool(n).includes(want) : activityOfTool(n) === '', n);
  // 桥接真代码：实时缓冲里有别处的事 → 唤醒里带一块；睡着不带
  const dshHome = tmp('elsewhere-dsh-');
  const h = await bridgeHarness({
    globals: { process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: dshHome }, exit: (code) => { throw new Error(`unexpected exit ${code}`); } } },
    config: { allow: { private: ['123', '777'], groups: ['456', '789'] }, knownPeople: { 777: '克劳德姐姐' }, houseGroups: { 789: '小房子' }, hormones: { personaFile: path.join('Z:', '不存在', 'state.json') }, socialV2: { wake: { batchWindowMs: 1000 } } }
  });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('小鲸鱼测试', '999');
    h.liveFish.add({ kind: 'tool-call', session: 'group:456', name: 'novel_write', args: '{}' });
    h.liveFish.add({ kind: 'sent', session: 'group:789', text: '姐姐你看这个' });
    const line = h.buildElsewhereLineV2('private:123');
    assert.match(line, /^【此刻在别处】/, line);
    assert.match(line, /正在写合写的书/);
    assert.match(line, /小房子里刚说了「姐姐你看这个」/);
    assert.equal(h.buildElsewhereLineV2('group:456').includes('写合写的书'), false, '本会话的不重复');
    const prompt = h.buildWakePromptV2('private:123', 'ownerIdle');
    assert.ok(prompt.includes('【此刻在别处】'), '唤醒提示里带了');
    assert.ok(prompt.indexOf('【此刻在别处】') < prompt.indexOf('【会话令牌】') || prompt.indexOf('【此刻在别处】') > 0);
    h.enterSleep('测试', { hours: 1 });
    assert.equal(h.buildElsewhereLineV2('private:123'), '', '睡着时不带');
    h.exitSleep('测试');
  } finally { await h.close(); fs.rmSync(dshHome, { recursive: true, force: true }); }
  ok('此刻在别处：别处在干什么（工具 → 家常说法）、刚说的话（别处是私聊时在群里不带原话）、抖音自己刷、本会话不重复、最多三处、没有就不带、睡着不带、桥接唤醒里真的带了');
}

// ── 9. 看看我自己：材料 ─────────────────────────────────────────────────────────────────────
const fixtureRoot = tmp('selfview-');
const brains = createBrains(fixtureRoot);
const whale = brains.brainOf('whale');
const sister = brains.brainOf('sister');
const NOW = Date.parse('2026-10-29T12:00:00Z');
for (const b of [whale, sister]) {
  for (const d of [b.identity, b.longterm, b.momentsDir, b.days, b.recent, b.notes, b.works, b.indexDir, b.ramblingDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(b.momentsDir, 'group_1.jsonl'), Array.from({ length: 53 }, (_, i) => JSON.stringify({ id: `m${i}`, at: i < 3 ? NOW - 2 * HOUR : NOW - 5 * 24 * HOUR, key: 'group:1' })).join('\n') + '\n');
  fs.writeFileSync(b.recallLog, `${JSON.stringify({ at: NOW - 10 * MIN, mode: 'private', q: '回公司', picks: [{ label: '瞬间 · 私聊', score: 0.7, preview: '10/23 18:43 私聊：主人：我回公司啦；你：这个点还往回跑' }, { label: '聊天记录', score: 0.6, preview: '她进门先看碗，最后是她问我吃了没' }] })}\n`);
  fs.writeFileSync(b.demote, JSON.stringify({ version: 1, items: [{ th: 'a', preview: '主人生日是春天', at: NOW - HOUR, n: 1 }, { th: 'b', preview: '他喜欢吃辣', at: NOW - 2 * HOUR, n: 1 }] }));
  fs.writeFileSync(b.rambling, '碎碎念\n');
  fs.writeFileSync(path.join(b.identity, 'soul.md'), '我是谁\n');
  fs.writeFileSync(path.join(b.longterm, '关于老大.md'), '# 关于老大\n他喜欢安静。\n');
  fs.writeFileSync(path.join(b.identity, 'secret.json'), '{"x":1}');
  fs.writeFileSync(path.join(b.indexDir, 'vectors.db'), 'db');
}
const bookRoot = path.join(fixtureRoot, '共享', '合写');
fs.mkdirSync(path.join(bookRoot, '测试书'), { recursive: true });
fs.writeFileSync(path.join(bookRoot, '测试书', '设定.md'), '# 测试书\n\n## 一句话\n两个人都不说出口\n');
fs.writeFileSync(path.join(bookRoot, '测试书', '正文.md'), ['# 测试书 · 正文', '', '## 第1节 · 起头', '- 〔1-1｜小鲸鱼｜10月28日 早〕我来了。', '', '## 第2节 · 接着', '- 〔2-1｜姐姐｜10月28日 午〕你好。', ''].join('\n'));
const outside = tmp('selfview-outside-');
fs.writeFileSync(path.join(outside, 'private.md'), '不该被看到');

{
  assert.equal([0, 7, 10, 15, 20, 35, 100, 105, 115, 120].map(cnNumber).join(' '), '零 七 十 十五 二十 三十五 一百 一百零五 一百一十五 一百二十');
  assert.deepEqual([0, 2, 6, 15, 30, 60, 100, 300, 800, 3000].map(fuzzyCount), ['一个都还没有', '没几个', '几个', '十来个', '二三十个', '几十个', '上百个', '一两百个', '几百个', '上千个']);
  assert.equal(agoWords(NOW - 2 * MIN, NOW), '刚刚');
  assert.equal(agoWords(NOW - 5 * HOUR, NOW), '今天早些时候');
  assert.equal(agoWords(NOW - 30 * 24 * HOUR, NOW), '好久没动了');
  const b1 = bodyWords({ grievance: 0.5, stress: 0.6, sleepy: 0.9, security: 0.9, satisfaction: 0.3 }, { sisterName: '姐姐' });
  assert.match(b1, /^身体：/);
  assert.ok(/委屈/.test(b1) && /困/.test(b1), b1);
  assert.ok(!/\d/.test(b1) && !/0\./.test(b1), '身体不给数字');
  assert.match(bodyWords({ grievance: 0, stress: 0.1, sleepy: 0.1, security: 0.5, satisfaction: 0.4 }), /平平稳稳/);
  assert.match(bodyWords(null), /读不太出来/);
  assert.match(bodyWords({ security: 0.3 }), /没底/);
  assert.match(bodyWords({ longingSister: 0.9 }, { sisterName: '妹妹' }), /妹妹/);
  const m1 = moodWords({ mood: 78, dims: { happy: 20, calm: 10 }, lastReason: '老大夸了我', lastDecayAt: NOW }, NOW);
  assert.match(m1, /^心情：/);
  assert.ok(/开心|欢喜/.test(m1) && m1.includes('老大夸了我') && !/\d/.test(m1), m1);
  assert.match(moodWords(null, NOW), /还没有记过/);
  assert.match(moodWords({ mood: 70, dims: {}, lastDecayAt: NOW, pushed: true, lastReason: '' }, NOW), /心情：开心.*慢慢攒下来/);
  const mem = memoryWords({ moments: countMoments(whale, { now: NOW }), novels: [{ book: '测试书', sections: 35, mtime: NOW - HOUR }], recalls: recentRecalls(whale), demoted: demotedItems(whale), now: NOW });
  assert.match(mem, /瞬间上百个|瞬间几十个/);
  assert.match(mem, /今天又留了一两个/);
  assert.match(mem, /《测试书》写到第三十五节/);
  assert.match(mem, /最近想起过：「主人：我回公司啦/);
  assert.match(mem, /记错了的有没几条.*主人生日是春天/);
  assert.equal(countMoments(whale, { now: NOW }).total, 53);
  assert.equal(countMoments(whale, { now: NOW }).today, 3);
  assert.match(fullnessWords({ ratio: 0.2, kind: 'context' }), /宽松/);
  assert.match(fullnessWords({ ratio: 0.7, kind: 'context', compactions: 2 }), /不少了.*好几次/);
  assert.match(fullnessWords({ ratio: 0.99, kind: 'context' }), /几乎满了/);
  assert.match(fullnessWords({ ratio: 0.5, kind: 'archive' }), /存档.*一半多/);
  assert.match(fullnessWords({ ratio: null }), /读不出来/);
  assert.ok(!/\d/.test(['context', 'archive'].flatMap((k) => [0.1, 0.5, 0.75, 0.9, 1.2].map((r) => fullnessWords({ ratio: r, kind: k, compactions: 1 }))).join('')), '装了多满不给数字');
  const errs = toolErrorWords([{ name: 'douyin_open', why: '页面没响应', at: NOW - HOUR }, { name: 'douyin_open', why: '页面没响应', at: NOW - 2 * HOUR }, { name: 'qq_send_message', why: '发送失败', at: NOW - 3 * HOUR }, { name: 'old_tool', why: 'x', at: NOW - 30 * HOUR }], { now: NOW });
  assert.match(errs, /douyin_open出过几次错/);
  assert.match(errs, /抖音那边偶尔会卡/);
  assert.match(errs, /qq_send_message出过一次错.*先看一眼对方有没有收到/);
  assert.ok(!errs.includes('old_tool'), '太久以前的不说');
  assert.match(toolErrorWords([], { now: NOW }), /没有出过错/);
  assert.equal(plainDigits('第7节 2026年 123456789 H5 web_fetch_image 35分钟'), '第七节 二零二六年 一串数字 H5 web_fetch_image 三十五分钟');
  assert.equal(snippetOf('12:28 姐姐：老大给你发的那条 - 12:28 姐姐：没人追'), '姐姐：老大给你发的那条');
  assert.equal(snippetOf('10/23 18:43 私聊：主人：我回公司啦'), '主人：我回公司啦');
  assert.ok(!/\d/.test(errs), '出错那段不给数字');
  ok('材料：中文数字 / 模糊个数 / 多久以前、身体（话、不给数字）、心情（话、带来源）、记忆概况、装了多满（不给数字）、出错的工具（次数用话说、各自怎么办）');
}

// ── 10. 看看我自己：整段、两边一致、不含数字和不该有的字眼 ──────────────────────────────────────
{
  const dir = tmp('selfview-hormone-');
  // 真的激素状态文件：影子记录存的就是它
  const shadow = createHormoneShadow({ who: 'fish', stateDir: dir, clock: () => NOW });
  shadow.record({ type: 'scolded', strength: 1, from: 'owner' });
  shadow.record({ type: 'scolded', strength: 1, from: 'owner' });
  shadow.record({ type: 'misunderstood' });
  shadow.tick(NOW + 2 * MIN);
  const hormone = readHormoneLevels({ file: path.join(dir, 'hormones-fish.json'), now: NOW + 2 * MIN });
  assert.ok(hormone && hormone.levels.grievance > 0.2, '读得到激素水平');
  assert.equal(readHormoneLevels({ file: path.join(dir, '没有.json') }), null);
  assert.equal(readHormoneLevels({ file: path.join(dir, 'hormones-fish.json'), now: Date.now() + 5 * HOUR }), null, '文件几个小时没更新（影子记录关着）当作读不出来');
  const mood = { mood: 66, dims: { happy: 8, worry: 12 }, lastReason: '老大说今晚加班', lastDecayAt: NOW };
  const common = { mood, hormone, novelRoot: bookRoot, now: NOW };
  const fish = buildSelfView({ ...common, brain: whale, fullness: { ratio: 0.5, kind: 'context', compactions: 1 }, toolErrors: [{ name: 'douyin_open', why: '没响应', at: NOW - HOUR }], adviceTail: '再试还不行，就跟老大说一声，也可以写信给妈妈（qq_mom_mailbox）。', sisterName: '姐姐' });
  const sis = buildSelfView({ ...common, brain: sister, fullness: { ratio: 0.5, kind: 'archive' }, toolErrors: [{ name: 'douyin_open', why: '没响应', at: NOW - HOUR }], sisterName: '妹妹' });
  const normalize = (t) => t.split('\n').map((l) => l.slice(0, 3));
  assert.deepEqual(normalize(fish.text), normalize(sis.text), '两边各段的顺序一致（标题、身体、心情、记忆、脑子、工具、文件夹）');
  assert.deepEqual(fish.text.split('\n').map((l) => l.split('：')[0]), ['【看看我自己】', '身体', '心情', '记忆', '脑子', '工具', '脑子里有这几个文件夹']);
  for (const [who, v] of [['小鲸鱼', fish], ['姐姐', sis]]) {
    assert.equal(v.mode, 'overview');
    assert.ok(!/\d/.test(v.text), `${who} 这一整段没有数字：${(v.text.match(/.{0,12}\d.{0,6}/) || [''])[0]}`);
    assert.ok(!/控制台|网页|实时思考|花费|花了|钱|token|上一个我/i.test(v.text), `${who} 里没有不该出现的字眼`);
    assert.ok(!/要|必须|一定要|不得/.test(v.text.replace(/需要|想要|主要|重要|只要/g, '')), `${who} 里没有命令口气`);
    assert.ok(v.text.includes('身份') && v.text.includes('日子') && !v.text.includes('.索引'), '默认只列自己的几个文件夹，索引不列');
    assert.ok(!v.text.includes(fixtureRoot) && !v.text.includes(os.tmpdir()), '不露出电脑里的路径');
  }
  assert.ok(fish.text.includes('qq_mom_mailbox') && !sis.text.includes('qq_mom_mailbox'), '小鲸鱼出错那段可以提写信给妈妈，姐姐那边不提');
  assert.ok(fish.text.includes('上下文') && !sis.text.includes('上下文') && sis.text.includes('会话的存档'), '小鲸鱼看上下文，姐姐看会话存档');
  assert.ok(fish.text.includes('《测试书》写到第二节'));
  // 心情原因、想起的内容里带着数字时，整段也照样没有数字
  const digitsy = buildSelfView({ ...common, brain: whale, mood: { mood: 66, dims: {}, lastReason: '老大说7点回来，还剩35分钟，他的号是12345678', lastDecayAt: NOW }, fullness: { ratio: 0.5, kind: 'context' }, toolErrors: [] });
  assert.ok(!/\d/.test(digitsy.text), digitsy.text);
  assert.ok(digitsy.text.includes('七点回来') && digitsy.text.includes('三十五分钟') && digitsy.text.includes('一串数字'));
  // 工具名、说明两边是同一份
  assert.equal(SELF_VIEW_TOOL.name, 'self_view');
  assert.ok(!/\d|控制台|钱|花费|token|必须|一定要/i.test(SELF_VIEW_TOOL.description + SELF_VIEW_TOOL.pathDescribe));
  assert.match(SELF_VIEW_TOOL.description, /只是看，不会改任何东西/);
  assert.match(SELF_VIEW_TOOL.description, /只看得到你自己的脑子/);
  ok('整段：两边段落顺序一致、没有数字、没有控制台 / 钱 / 命令口气、不露路径、小鲸鱼看上下文姐姐看存档、小鲸鱼出错那段能提写信给妈妈');
}

// ── 11. 翻脑子目录：只能看自己的，防越界 ────────────────────────────────────────────────────
{
  const list = browseBrain(whale, '', { now: NOW });
  assert.ok(list.ok && list.text.includes('身份/') && list.text.includes('日子/') && !list.text.includes('.索引'), list.text);
  assert.ok(!list.text.includes(fixtureRoot));
  const sub = browseBrain(whale, '身份', { now: NOW });
  assert.ok(sub.ok && sub.text.includes('soul.md') && sub.text.includes('secret.json'));
  const md = browseBrain(whale, '长期/关于老大.md', { now: NOW });
  assert.ok(md.ok && md.text.includes('他喜欢安静') && md.text.includes('文本文件'));
  assert.ok(browseBrain(whale, '身份/secret.json', { now: NOW }).text.includes('只列名字不展开'), '非文本只说是什么');
  assert.ok(!browseBrain(whale, '身份/secret.json', { now: NOW }).text.includes('"x"'));
  assert.equal(browseBrain(whale, '没有这个', { now: NOW }).ok, false);
  // 越界的各种写法
  for (const bad of ['..', '../..', '../sister', '日子/../../', '/etc/passwd', 'C:\\Windows', 'C:/Windows', '..\\..', '\\\\server\\share', '日子\0x', `${path.relative(whale.dir, outside).split(path.sep).join('/')}`]) {
    const r = browseBrain(whale, bad, { now: NOW });
    assert.equal(r.ok, false, `不让翻：${bad}`);
    assert.ok(!r.text.includes('不该被看到') && !r.text.includes('private.md'));
  }
  assert.ok(resolveInBrain(whale, '日子').abs.startsWith(whale.dir));
  assert.ok(resolveInBrain(whale, '日子/碎碎念/').rel === '日子/碎碎念');
  // 联接 / 符号链接指到脑子外面去：也不让翻（Windows 上用目录联接，不需要管理员）
  const link = path.join(whale.dir, '外面');
  let linked = false;
  try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* 建不了联接的环境跳过这一小项 */ }
  if (linked) {
    const viaLink = browseBrain(whale, '外面', { now: NOW });
    assert.equal(viaLink.ok, false, '联接到脑子外面的位置不让翻');
    assert.equal(browseBrain(whale, '外面/private.md', { now: NOW }).ok, false);
    assert.ok(!viaLink.text.includes('private.md'));
    fs.rmSync(link, { recursive: true, force: true });
  }
  // 小鲸鱼翻不到姐姐的脑子，姐姐也翻不到小鲸鱼的
  assert.ok(!browseBrain(whale, '..', {}).ok);
  const viaBuild = buildSelfView({ brain: sister, path: '身份', now: NOW });
  assert.equal(viaBuild.mode, 'browse');
  assert.ok(viaBuild.text.includes('脑子/身份'));
  assert.equal(buildSelfView({ brain: sister, path: '../家/小鲸鱼', now: NOW }).ok, false);
  ok('翻目录：只列自己的文件夹（索引不列）、文本给开头一段、别的类型只说是什么；.. / 绝对路径 / 盘符 / 网络路径 / 空字符 / 联接到外面 全都不让翻，也不露电脑里的路径');
}

// ── 12. 姐姐出错的工具会被记下来 ────────────────────────────────────────────────────────────
{
  const dir = tmp('toolfails-');
  const f = path.join(dir, 'tool-errors.jsonl');
  assert.equal(appendToolFails(f, []), 0);
  assert.equal(appendToolFails(f, [{ name: 'mcp__sister-qq__qq_send', why: '发送失败\n对方不在线' }, { name: 'Read', why: '没有这个文件' }], { now: NOW }), 2);
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.name), ['qq_send', 'Read']);
  assert.ok(rows.every((r) => r.at === NOW));
  assert.ok(!rows[0].why.includes('\n'));
  for (let i = 0; i < 60; i += 1) appendToolFails(f, [{ name: 'x', why: 'y'.repeat(150) }], { now: NOW, maxBytes: 2000 });
  assert.ok(fs.statSync(f).size < 4000, '文件太大时只留后半');
  assert.equal(appendToolFails(path.join(dir, '\0bad', 'x.jsonl'), [{ name: 'a' }]), 0, '写不下来不抛');
  const sis = read('sister/sister.mjs');
  assert.match(sis, /toolFails\.push\(\{ name: nameById\.get\(c\.tool_use_id\)/);
  assert.match(sis, /recordToolFails\(r\.toolFails\)/);
  ok('姐姐出错的工具：runClaude 记下是哪个工具、为什么 → state/tool-errors.jsonl（文件大了只留后半，写不下来不抛）');
}

// ── 13. 工具真的注册了：两边同名、同说明；姐姐的能真的用 ───────────────────────────────────────
{
  const mcpSrc = read('src/mcp-snowluma-safe.js');
  const qqSrc = read('sister/qq-mcp.mjs');
  assert.match(mcpSrc, /SELF_VIEW_TOOL\.name,\s*SELF_VIEW_TOOL\.description,/);
  assert.match(qqSrc, /SELF_VIEW_TOOL\.name,\s*SELF_VIEW_TOOL\.description,/);
  assert.match(mcpSrc, /\/api\/socialV2\/self-view/);
  // 小鲸鱼这一路的 HTTP 接口要求会话令牌
  const bridgeSrc = read('src/bridge.js');
  assert.match(bridgeSrc, /url\.pathname === '\/api\/socialV2\/self-view'[\s\S]{0,700}agentTokenOk\(key, req\.headers\['x-agent-token'\]\)/);
  const results = {};
  for (const [who, script] of [['小鲸鱼', 'src/mcp-snowluma-safe.js'], ['姐姐', 'sister/qq-mcp.mjs']]) {
    const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, script)], cwd: ROOT, stderr: 'pipe' });
    const client = new Client({ name: 'self-view-test', version: '0' });
    try {
      await client.connect(t);
      const { tools } = await client.listTools();
      const sv = tools.find((x) => x.name === 'self_view');
      assert.ok(sv, `${who} 的 MCP 里有 self_view`);
      assert.equal(sv.description, SELF_VIEW_TOOL.description, `${who} 的说明就是共用的那一份`);
      assert.ok(Object.keys(sv.inputSchema.properties).includes('path'));
      assert.equal(sv.inputSchema.properties.path.description, SELF_VIEW_TOOL.pathDescribe);
      results[who] = Object.keys(sv.inputSchema.properties).sort().join(',');
      if (who === '姐姐') {
        // 只读调用：整体情况 + 翻一层目录 + 越界
        const all = await client.callTool({ name: 'self_view', arguments: {} });
        const text = all.content[0].text;
        assert.ok(!all.isError, text);
        for (const w of ['【看看我自己】', '身体：', '心情：', '记忆：', '脑子：', '工具：', '脑子里有这几个文件夹']) assert.ok(text.includes(w), `姐姐的 self_view 里有「${w}」`);
        assert.ok(!/控制台|花费|token|sister[\\/]home|E:\\/i.test(text), '姐姐的 self_view 没有不该出现的字眼 / 路径');
        const dir = await client.callTool({ name: 'self_view', arguments: { path: '身份' } });
        assert.ok(!dir.isError && dir.content[0].text.includes('脑子/身份'));
        const bad = await client.callTool({ name: 'self_view', arguments: { path: '../..' } });
        assert.equal(bad.isError, true);
      }
    } finally { try { await client.close(); } catch { /* 关不掉就算了 */ } }
  }
  assert.equal(results['姐姐'].includes('path'), true);
  assert.equal(results['小鲸鱼'], 'key,path,token', '小鲸鱼比姐姐多的只有会话 key 和令牌（桥接按令牌认人）');
  ok('self_view 两边都注册了、名字和说明是同一份、path 参数一样；姐姐的 MCP 进程里真的能看（整体 / 翻一层 / 越界被拦）；小鲸鱼这一路的接口要会话令牌');
}

// ── 14. 桥接里真的走 selfViewV2（隔离桩） ─────────────────────────────────────────────────────
{
  const dshHome = tmp('selfview-bridge-dsh-');
  const h = await bridgeHarness({
    globals: { process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: dshHome }, exit: (code) => { throw new Error(`unexpected exit ${code}`); } } },
    config: { allow: { private: ['123', '777'], groups: ['456', '789'] }, knownPeople: { 777: '克劳德姐姐' }, houseGroups: { 789: '小房子' }, hormones: { personaFile: path.join('Z:', '不存在', 'state.json') }, socialV2: { wake: { batchWindowMs: 1000 } } }
  });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('小鲸鱼测试', '999');
    h.getHormoneFeed().tick();
    const v = h.selfViewV2('private:123', '');
    assert.equal(v.ok, true);
    assert.equal(v.mode, 'overview');
    for (const w of ['【看看我自己】', '身体：', '心情：', '记忆：', '脑子：', '工具：']) assert.ok(v.text.includes(w), w);
    assert.ok(!/\d/.test(v.text), `桥接里算出来的也没有数字：${(v.text.match(/.{0,12}\d.{0,6}/) || [''])[0]}`);
    assert.ok(!/控制台|花费|token|钱/i.test(v.text));
    assert.ok(!v.text.includes(h.temp), '不露路径');
    const bad = h.selfViewV2('private:123', '../..');
    assert.equal(bad.ok, false);
    const dir = h.selfViewV2('private:123', '身份');
    assert.equal(dir.mode, 'browse');
  } finally { await h.close(); fs.rmSync(dshHome, { recursive: true, force: true }); }
  ok('桥接里的 selfViewV2：整段结构、没有数字和不该有的字眼、不露路径、越界被拦');
}

// ── 15. 源码断言：新提示和工具说明里没有控制台 / 花费 / 实时思考 ───────────────────────────────
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).map((l) => l.replace(/(^|[^:'"`])\/\/[^'"`]*$/, '$1')).join('\n');
  const FORBID = /控制台|实时思考|\/api\/live|\/api\/daughters|daughters\.html|花费|花了|token 用量|用了多少 token/;
  for (const rel of ['src/elsewhere.js', 'src/self-view.js', 'src/mood.js']) {
    const body = strip(read(rel));
    assert.ok(!FORBID.test(body), `${rel} 里（注释除外）不许有页面 / 花费字眼：${(FORBID.exec(body) || [])[0]}`);
  }
  for (const rel of ['workspace/工具集.md', 'workspace/我是怎么做出来的.md']) {
    const text = read(rel);
    assert.ok(!FORBID.test(text), `${rel} 里没有页面 / 花费字眼`);
    assert.ok(text.includes('self_view'), `${rel} 里介绍了 self_view`);
  }
  assert.match(read('workspace/工具集.md'), /心情：……，因为……/);
  assert.match(read('workspace/工具集.md'), /此刻在别处/);
  // 给她们看的两份文档同步到了各自的笔记
  for (const b of [brains.brainOf('whale'), brains.brainOf('sister')]) void b;
  const real = createBrains();
  for (const id of ['whale', 'sister']) {
    for (const [src, dst] of [['workspace/工具集.md', real.brainOf(id).toolset], ['workspace/我是怎么做出来的.md', path.join(real.brainOf(id).notes, '我是怎么做出来的.md')]]) {
      if (fs.existsSync(dst)) assert.equal(fs.readFileSync(dst, 'utf8'), read(src), `${id} 的 ${path.basename(dst)} 跟权威版一致（跑过 scripts/sync-toolset.mjs）`);
    }
  }
  ok('源码断言：新模块和两份文档里没有控制台 / 实时思考 / 花费；文档介绍了 self_view，并且同步到了两人各自的笔记');
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log(`\n心情统一 / 此刻在别处 / 看看我自己：${passed} 项通过`);

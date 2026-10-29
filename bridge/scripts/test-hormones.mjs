// 激素系统（2026-10-29）：纯逻辑 + 影子记录器。只用临时目录，不碰活的 state。
// 第一期半（同日）：无聊 / 被在乎 / 创作冲动 / 成就感 / 委屈、互相影响、两套性格、习惯化、新行为、关键词判断、老状态兼容。
// 前半是第一期的老用例：它们断言精确数值，所以用 PURE（关掉互相影响 / 适应 / 满足 / 警觉）隔离；
// 后半是第一期半的新用例，用默认参数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  BEHAVIORS, DEFAULTS, EVENTS, PERSONAS, appraise, createState, feltLine, hazards, interestList, interestMatch, interestsFromPersona, isHush, levels, makeRng, mergeCfg,
  midSleepHour, relax, roll, step, sunTerm, upgradeState, weatherKind,
} from '../src/hormones.js';
import { createHormoneShadow, summarize } from '../src/hormone-shadow.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const MIN = 60e3;
const HOUR = 3600e3;
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} 期望 ${b}，实际 ${a}`);
// 北京时间 2026-10-29 14:00 = UTC 06:00（昼夜项在下午接近最低）
const T0 = Date.parse('2026-10-29T06:00:00Z');
const E = EVENTS;
// 老用例用：只留第一期的行为（互相影响、适应、满足、警觉都关掉），数值才好精确断言
const PURE = mergeCfg({ couple: { enabled: false }, habit: { enabled: false }, satisfaction: { enabled: false }, alert: { enabled: false } });

// ── 回落（老用例，PURE）──
const mk0 = (o = { now: T0 }) => createState(PURE, o);
const st0 = (s, o) => step(s, o, PURE);
{
  near(relax(0.5, 0.1, 120, 120), 0.3, 1e-9, '一个半衰期距离减半');
  near(relax(0.5, 0.1, 240, 120), 0.2, 1e-9, '两个半衰期剩四分之一');
  assert.equal(relax(0.5, 0.1, 60, null), 0.5, '没有半衰期不回落');
  let s = mk0();
  s = st0(s, { now: T0, events: [{ type: E.HUSHED }] });
  near(s.h.stress, 0.35, 1e-9, '被说别吵 +0.25');
  s = st0(s, { now: T0 + 120 * MIN });
  near(s.h.stress, 0.1 + 0.25 / 2, 1e-9, '压力 2 小时半衰期');
  let c = mk0();
  c = st0(c, { now: T0, events: [{ type: E.NOVELTY }] });
  near(c.h.curiosityImpulse, 0.3, 1e-9, '看到新东西冲击 +0.3');
  c = st0(c, { now: T0 + 45 * MIN });
  near(c.h.curiosityImpulse, 0.15, 1e-9, '冲击部分 45 分钟半衰期');
  // 困：醒着每小时 +0.05，睡着 2 小时半衰期回落到 0.15
  let z = mk0();
  z = st0(z, { now: T0 + 10 * HOUR });
  near(z.h.sleepPressure, 0.65, 1e-9, '醒 10 小时 +0.5');
  z = st0(z, { now: T0 + 10 * HOUR, events: [{ type: E.SLEEP }] });
  z = st0(z, { now: T0 + 12 * HOUR });
  near(z.h.sleepPressure, 0.15 + 0.5 / 2, 1e-9, '睡 2 小时回落一半');
  // 想念：对方开口后 30 分钟内不涨，之后每小时 +0.03
  let l = mk0();
  l = st0(l, { now: T0, events: [{ type: E.MSG_FROM_OWNER }] });
  near(l.h.longingOwner, 0, 1e-9, '来消息 −0.4，截到 0');
  l = st0(l, { now: T0 + 30 * MIN });
  near(l.h.longingOwner, 0, 1e-9, '30 分钟内不涨');
  l = st0(l, { now: T0 + 30 * MIN + 10 * HOUR });
  near(l.h.longingOwner, 0.3, 1e-9, '之后 10 小时 +0.3');
  near(l.h.longingSister, 0.3 + 0.03 * 10.5, 1e-9, '姐妹那份单独算');
  ok('回落到基线、困 / 想念 / 好奇各自的涨落');
}

// ── 冲击上限、截断 ──
{
  let s = mk0();
  const fails = Array.from({ length: 20 }, (_, i) => ({ type: E.TOOL_FAIL, at: T0 + i * MIN }));
  s = st0(s, { now: T0 + 20 * MIN, events: fails });
  assert.ok(s.h.stress <= 0.1 + 0.8 + 1e-9, `一小时内累计冲击不超过 0.8（${s.h.stress}）`);
  assert.ok(s.h.stress >= 0.75, '但确实累计上去了');
  // 一小时后又能加
  const before = st0(s, { now: T0 + 90 * MIN }).h.stress;
  const after = st0(s, { now: T0 + 90 * MIN, events: [{ type: E.TOOL_FAIL, at: T0 + 90 * MIN }] }).h.stress;
  near(after - before, 0.1, 1e-9, '窗口过了又能加');

  const cfg = mergeCfg({ impulse: { maxSingle: 0.2 }, couple: { enabled: false }, habit: { enabled: false } });
  let t = createState(cfg, { now: T0 });
  t = step(t, { now: T0, events: [{ type: E.HUSHED }] }, cfg);
  near(t.h.stress, 0.3, 1e-9, '单次冲击上限 0.2');

  let c = mk0();
  c = st0(c, { now: T0 + 3 * HOUR, events: Array.from({ length: 30 }, (_, i) => ({ type: E.NOVELTY, at: T0 + i * 6 * MIN })) });
  const L = levels(c, PURE);
  for (const [k, v] of Object.entries(L)) assert.ok(v >= 0 && v <= 1, `${k} 在 [0,1]：${v}`);
  let w = mk0();
  w = st0(w, { now: T0 + 200 * HOUR });
  for (const v of Object.values(w.h)) assert.ok(v >= 0 && v <= 1, '很久不管也截在 [0,1]');
  assert.equal(w.h.longingOwner, 1, '想念封顶 1');
  ok('单次 / 每小时冲击上限、截断到 [0,1]');
}

// ── 防自激：她自己发消息不让想念升 ──
{
  const quiet = step(createState(null, { now: T0 }), { now: T0 + 5 * HOUR });
  const sends = Array.from({ length: 30 }, (_, i) => ({ type: E.SENT_TO_OWNER, at: T0 + i * 10 * MIN }));
  const chatty = step(createState(null, { now: T0 }), { now: T0 + 5 * HOUR, events: sends });
  assert.ok(chatty.h.longingOwner <= quiet.h.longingOwner + 1e-12, '自己发了 30 条，想念不比不发高');
  assert.equal(chatty.peers.owner.unanswered, 30, '记下没回条数');
  ok('防自激：自己发的只进冷却、记没回条数');
}

// ── 连续没回抑制、冷却、对方开口恢复 ──
{
  let s = createState(null, { now: T0 });
  s = step(s, { now: T0 + 6 * HOUR }); // 想念涨起来
  const free = hazards(s).ownerPing.lambda;
  assert.ok(free > 0, '平时有发生率');
  let a = step(s, { now: s.t, events: [{ type: E.SENT_TO_OWNER }] });
  assert.equal(hazards(step(a, { now: a.t + 10 * MIN })).ownerPing.p, 0, '发完 20 分钟冷却');
  const one = hazards(step(a, { now: a.t + 25 * MIN })).ownerPing.lambda;
  a = step(a, { now: a.t + 30 * MIN, events: [{ type: E.SENT_TO_OWNER }] });
  const two = hazards(step(a, { now: a.t + 30 * MIN })).ownerPing.lambda;
  assert.ok(one < free * 0.35 && one > free * 0.25, `一条没回 ×0.3（${one / free}）`);
  assert.ok(two < free * 0.002, `两条没回接近 0（${two / free}）`);
  const later = hazards(step(a, { now: a.t + 6 * HOUR + MIN })).ownerPing.lambda;
  assert.ok(later > two * 10, '满 6 小时松开');
  const replied = step(a, { now: a.t + 40 * MIN, events: [{ type: E.MSG_FROM_OWNER, at: a.t + 35 * MIN }] });
  assert.equal(replied.peers.owner.unanswered, 0, '对方开口清零');
  assert.ok(hazards(replied).ownerPing.lambda > two * 10, '对方开口后恢复');
  // 按轮算：一口气分三条发算一轮；回对方的话不算「没回」
  let burst = step(s, { now: s.t + 2 * MIN, events: [0, 1, 2].map((i) => ({ type: E.SENT_TO_OWNER, at: s.t + i * 30e3 })) });
  assert.equal(burst.peers.owner.unanswered, 1, '同一轮分几条发只算一次');
  let rep = step(s, { now: s.t + 10 * MIN, events: [{ type: E.MSG_FROM_OWNER, at: s.t }, { type: E.SENT_TO_OWNER, at: s.t + MIN }, { type: E.SENT_TO_OWNER, at: s.t + 2 * MIN }] });
  assert.equal(rep.peers.owner.unanswered, 0, '回老大的话（分两条）不算没回');
  rep = step(rep, { now: rep.t + 2 * HOUR, events: [{ type: E.SENT_TO_OWNER, at: rep.t + HOUR }] });
  assert.equal(rep.peers.owner.unanswered, 1, '之后自己再起一轮才算一条');
  burst = step(s, { now: s.t + HOUR, events: [{ type: E.SENT_TO_OWNER, at: s.t, reply: true }] });
  assert.equal(burst.peers.owner.unanswered, 0, 'reply: true 直接说明是回话');
  // 影子模式的虚拟冷却
  const v = hazards(s, { virtual: { ownerPing: { lastSent: s.t - 5 * MIN, unanswered: 1 } } });
  assert.equal(v.ownerPing.p, 0, '「本来会发」的那次也算冷却');
  // p = 1 − e^(−λΔt)
  const h5 = hazards(s, { dtMin: 5 });
  near(h5.ownerPing.p, 1 - Math.exp(-h5.ownerPing.lambda * 5), 1e-12, 'p = 1 − e^(−λΔt)');
  // 默认参数下 λ0 = 1/180：基线状态（各项都在基线、下午）发生率接近 λ0
  const fresh = createState(null, { now: T0 });
  const ratio = hazards(fresh).ownerPing.lambda / DEFAULTS.hazards.ownerPing.lambda0PerMin;
  assert.ok(ratio > 0.5 && ratio < 2, `基线附近 λ≈λ0（×${ratio.toFixed(2)}）`);
  ok('连续没回 → 接近 0；冷却；对方开口 / 满 6 小时恢复；p 公式');
}

// ── 睡着时自发概率为 0 ──
{
  let s = createState(null, { now: T0 });
  s = step(s, { now: T0 + 8 * HOUR, events: [{ type: E.NOVELTY }, { type: E.GROUP_MSG, novelty: 1 }, { type: E.SLEEP, at: T0 + 8 * HOUR }] });
  const hz = hazards(s, { dtMin: 60, groupTopic: 1 });
  for (const b of BEHAVIORS) assert.equal(hz[b].p, 0, `${b} 睡着为 0`);
  assert.deepEqual(roll(hz, () => 0), [], '抽签也不会中');
  assert.equal(feltLine(s, null).line, '', '睡着不出感受句');
  ok('睡着时所有自发行为概率为 0');
}

// ── 别吵 / 在忙、心情、满足 / 警觉（第一期半起默认打开，可以关）──
{
  assert.ok(isHush('我在忙，晚点说') && isHush('安静点') && !isHush('今天吃什么'));
  let s = mk0();
  s = st0(s, { now: T0, events: [{ type: E.MSG_FROM_OWNER, text: '别吵，在开会' }] });
  near(s.h.stress, 0.35, 1e-9, '老大说别吵 +0.25');
  let g = st0(mk0(), { now: T0, events: [{ type: E.GROUP_MSG, text: '别吵' }] });
  near(g.h.stress, 0.1, 1e-9, '群里不是冲她来的不算');
  g = st0(g, { now: T0, events: [{ type: E.GROUP_MSG, text: '小鲸鱼别吵', toMe: true }] });
  near(g.h.stress, 0.35, 1e-9, '冲她来的算');
  let m = st0(mk0(), { now: T0, events: [{ type: E.MOOD, negative: 1 }] });
  m = st0(m, { now: T0 + 48 * HOUR });
  near(m.h.stress, 0.4, 1e-6, '心情负面把压力基线抬到 0.4');
  // 关掉的时候不动
  const off = st0(mk0(), { now: T0, events: [{ type: E.MENTIONED }, { type: E.PLEASANT }] });
  assert.equal(levels(off, PURE).alert, 0, '关掉：警觉不动');
  assert.equal(levels(off, PURE).satisfaction, 0.4);
  // 默认打开
  assert.equal(DEFAULTS.alert.enabled && DEFAULTS.satisfaction.enabled, true, '第二期的默认打开');
  let on = step(createState(null, { now: T0 }), { now: T0, events: [{ type: E.MENTIONED }, { type: E.PLEASANT }] });
  near(levels(on).alert, 0.5, 1e-9, '被 @ +0.5');
  near(levels(on).satisfaction, 0.55, 1e-9, '愉快 +0.15');
  on = step(on, { now: T0 + 10 * MIN });
  near(levels(on).alert, 0.25, 1e-9, '警觉 10 分钟半衰期');
  assert.ok(!Object.values(EVENTS).some((t) => /cost|money|token|spend|price|fee/i.test(t)), '没有花费类事件');
  ok('别吵关键词、心情抬基线、满足 / 警觉默认打开也能关、花费不进激素');
}

// ── 作息相位从最近 14 天学 ──
{
  // 每晚北京 3:00 睡、11:00 醒（中点 7:00）= UTC 19:00 ～ 03:00
  const hist = Array.from({ length: 10 }, (_, i) => {
    const sleep = Date.parse('2026-10-18T19:00:00Z') + i * 24 * HOUR;
    return { sleep, wake: sleep + 8 * HOUR };
  });
  const now = hist.at(-1).wake + 2 * HOUR;
  const m = midSleepHour(hist, now);
  assert.ok(m.learned && Math.abs(m.hour - 7) < 1e-6, `学到中点 7 点（${m.hour}）`);
  assert.equal(midSleepHour(hist.slice(0, 2), now).learned, false, '不足 3 晚用默认');
  assert.equal(midSleepHour([], now).hour, DEFAULTS.sleepy.defaultMidSleepHour);
  assert.equal(midSleepHour([{ sleep: now - 3 * HOUR, wake: now - 2 * HOUR }, ...hist.slice(0, 2)], now).learned, false, '打盹不算主睡眠');
  // 睡 / 醒事件自己攒作息
  let s = createState(null, { now: hist[0].sleep });
  for (const e of hist) s = step(s, { now: e.wake, events: [{ type: E.SLEEP, at: e.sleep }, { type: E.WAKE, at: e.wake }] });
  assert.equal(s.sleepLog.length, 10);
  assert.ok(Math.abs(midSleepHour(s.sleepLog, s.t).hour - 7) < 1e-6, '从自己的睡醒记录学');
  // 北京 7 点（中点）比 19 点更困
  const at7 = step(createState(null, { now: Date.parse('2026-10-28T23:00:00Z'), sleepHistory: hist }), { now: Date.parse('2026-10-28T23:00:00Z') });
  const at19 = { ...at7, t: Date.parse('2026-10-29T11:00:00Z') };
  assert.ok(levels(at7).sleepy > levels(at19).sleepy, '昼夜项：中点最困');
  ok('作息相位从最近 14 天学，不足用默认，打盹不算');
}

// ── 感受句：滞后、最多两句、不出现数字和钱 ──
{
  const at = (longing) => ({ ...createState(null, { now: T0 }), h: { ...createState(null, { now: T0 }).h, longingOwner: longing } });
  let f = feltLine(at(0.6), null);
  assert.equal(f.line, '', '没到 0.65 不说');
  f = feltLine(at(0.66), f);
  assert.equal(f.line, '有点想老大了。');
  f = feltLine(at(0.55), f);
  assert.equal(f.line, '有点想老大了。', '回落到 0.55 还在（滞后）');
  f = feltLine(at(0.49), f);
  assert.equal(f.line, '', '降到 0.5 以下才不说');
  f = feltLine(at(0.6), f);
  assert.equal(f.line, '', '再升到 0.6 也不立刻说');

  const sis = { ...createState(null, { now: T0 }), h: { ...createState(null, { now: T0 }).h, longingSister: 0.9 } };
  assert.equal(feltLine(sis, null, undefined, { sisterName: '妹妹' }).line, '有点想妹妹了。');

  const cfg2 = mergeCfg({ alert: { enabled: true }, satisfaction: { enabled: true } });
  const rng = makeRng(42);
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < 3000; i += 1) {
    const st = createState(cfg2, { now: T0 + i * 7 * MIN });
    for (const k of Object.keys(st.h)) st.h[k] = rng();
    st.asleep = rng() < 0.1;
    prev = feltLine(st, rng() < 0.5 ? prev : null, cfg2, { sisterName: rng() < 0.5 ? '姐姐' : '妹妹' });
    if (prev.line) seen.add(prev.line);
    assert.ok(prev.shown.length <= 2, '最多两句');
    assert.doesNotMatch(prev.line, /[0-9０-９%％]/, '不出现数字');
    assert.doesNotMatch(prev.line, /钱|花费|费用|token|额度|余额|元|块|成本|贵/i, '不提钱');
    assert.doesNotMatch(prev.line, /要|必须|应该|去找|快去/, '不是命令');
  }
  assert.ok(seen.size >= 10, `各种组合都出现过（${seen.size}）`);
  ok('感受句：滞后、最多两句、不出现数字和钱、不是命令');
}

// ── step 不改传进来的状态；种子随机数可复现 ──
{
  const s = createState(null, { now: T0 });
  const snap = JSON.stringify(s);
  step(s, { now: T0 + HOUR, events: [{ type: E.HUSHED }, { type: E.SENT_TO_OWNER }] });
  assert.equal(JSON.stringify(s), snap, 'step 返回新状态');
  const a = makeRng(7); const b = makeRng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const c = makeRng(a.state());
  assert.equal(c(), a(), '随机数状态能存下来续上');
  ok('step 是纯函数；种子随机数可复现、可续');
}

// ── 影子记录器（临时目录 + 假时钟） ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  const skew = 3 * HOUR; // 本机快 3 小时
  // 北京 2026-10-29 22:00 = UTC 14:00；本机时间再快 3 小时
  let host = Date.parse('2026-10-29T14:00:00Z') + skew;
  const clock = () => host;
  const errors = [];
  const mk = () => createHormoneShadow({ who: 'fish', stateDir: dir, skewMs: () => skew, clock, seed: 123, onError: (e) => errors.push(e) });
  let sh = mk();
  assert.throws(() => createHormoneShadow({ who: 'x', stateDir: dir }));
  const first = sh.tick();
  assert.equal(first.bj, '2026-10-29 22:00', '日志按校正后的北京时间');
  assert.equal(first.at, new Date(host).toISOString(), 'at 是本机 ISO');
  assert.equal(sh.tick(host + 10e3), null, '不到一分钟不重复记');
  sh.record({ type: E.MSG_FROM_OWNER, text: '别吵 秘密内容', at: host + 20e3 });
  sh.record({ type: E.NOVELTY });
  host += MIN;
  const second = sh.tick();
  assert.deepEqual(second.ev, ['msg_from_owner', 'novelty'], '这一分钟喂过的事件');
  assert.ok(second.lv.stress > 0.3, '别吵认出来了');
  const raw = fs.readFileSync(sh.logFile, 'utf8') + fs.readFileSync(sh.stateFile, 'utf8');
  assert.doesNotMatch(raw, /秘密内容/, '消息原文不落盘');
  // 跑一整天，跨过午夜
  for (let i = 0; i < 26 * 60; i += 1) {
    host += MIN;
    if (i === 60) sh.record({ type: E.SLEEP });
    if (i === 60 + 8 * 60) sh.record({ type: E.WAKE });
    if (i === 60 + 9 * 60) sh.record({ type: E.SEND_FAIL });
    sh.tick();
  }
  assert.deepEqual(errors, [], '没有出错');
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('hormones-fish.2026-10-29.jsonl') && files.includes('hormones-fish.2026-10-30.jsonl'), `按天轮转：${files.join(',')}`);
  const saved = JSON.parse(fs.readFileSync(sh.stateFile, 'utf8'));
  assert.equal(saved.hormones.sleepLog.length, 1, '状态里记下这次睡醒');
  // 重启接着算，随机数续上
  const tBefore = saved.hormones.t;
  sh = mk();
  assert.equal(sh.snapshot().hormones.t, tBefore, '重启读回状态');
  // 睡着的那些分钟一次都不会触发
  const day30 = fs.readFileSync(path.join(dir, 'hormones-fish.2026-10-30.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const asleepRows = day30.filter((r) => r.asleep);
  assert.ok(asleepRows.length > 400 && asleepRows.every((r) => r.would.length === 0 && Object.values(r.p).every((p) => p === 0)), '睡着时一次都没有');
  // 一天的统计
  const sum = summarize(sh.logFile, '2026-10-30');
  assert.equal(sum.minutes, 1440, '一整天 1440 分钟');
  assert.ok(sum.awakeMinutes < 1440 && sum.awakeMinutes > 900);
  assert.ok(Number.isFinite(sum.levels.sleepy.max) && sum.levels.sleepy.by3h.length === 8);
  assert.equal(sum.wouldByHour.ownerPing.reduce((s, n) => s + n, 0), sum.would.ownerPing);
  assert.match(sum.text, /^2026-10-30：记了 1440 分钟/);
  assert.match(sum.text, /本来会：找老大 \d+ 次/);
  assert.equal(summarize(sh.logFile, '2026-01-01').minutes, 0);
  // 同一种子同样的事件 → 同样的「本来会」
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  const run = (d) => {
    let h2 = Date.parse('2026-10-29T14:00:00Z');
    const s2 = createHormoneShadow({ who: 'sister', stateDir: d, clock: () => h2, seed: 9 });
    const out = [];
    for (let i = 0; i < 600; i += 1) { h2 += MIN; out.push(s2.tick().would.join('|')); }
    return out.join(',');
  };
  assert.equal(run(dir2), run(fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'))), '种子可复现');
  // 限大小：超过就另起一份
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  let h3 = Date.parse('2026-10-29T02:00:00Z');
  const small = createHormoneShadow({ who: 'sister', stateDir: dir3, clock: () => h3, maxBytes: 2000 });
  for (let i = 0; i < 30; i += 1) { h3 += MIN; small.tick(); }
  assert.ok(fs.readdirSync(dir3).filter((f) => /hormones-sister\.2026-10-29.*\.jsonl$/.test(f)).length >= 2, '超过大小另起一份');
  assert.equal(summarize(small.logFile, '2026-10-29').minutes, 30, '统计时连同分出去的一起读');
  for (const d of [dir, dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });
  ok('影子记录器：每分钟一行、校正时钟、原文不落盘、按天 / 大小轮转、重启续上、睡着为 0、一天统计');
}

// ════════════════════════════════════════════════════════════════════════════
// 第一期半（2026-10-29）：下面都用默认参数
// ════════════════════════════════════════════════════════════════════════════
const fresh = (persona = 'default', over = {}) => ({ ...createState(null, { now: T0, persona }), ...over });
const run = (s, ms, events = [], cfg) => step(s, { now: s.t + ms, events }, cfg);
const evAt = (s, type, dt = 0, extra = {}) => ({ type, at: s.t + dt, ...extra });
const setH = (s, patch) => { const o = structuredClone(s); Object.assign(o.h, patch); return o; };
const lv = (s, cfg) => levels(s, cfg);

// ── 关键词判断 appraise ──
{
  const A = (t, i) => appraise(t, i);
  assert.ok(A('你好可爱').praise === 1 && A('你真厉害呀').praise === 1 && A('好棒！').praise === 1 && A('喜欢你').praise === 1, '被夸');
  assert.equal(A('一点都不可爱').praise, 0, '前面有「不」不算夸');
  assert.ok(A('谢谢你').praise > 0 && A('谢谢你').praise < 1, '谢谢是轻一点的夸');
  assert.equal(A('嗯').cold, 1, '单字应声 = 敷衍');
  assert.equal(A('哦。').cold, 1);
  assert.equal(A('嗯嗯嗯').cold, 1);
  assert.ok(A('在忙，等会').cold > 0 && A('在忙，等会').hush === 1, '在忙：冷落，也是别吵');
  assert.ok(A('好的').cold > 0 && A('好的').cold < 0.5, '「好的」只算一点点');
  assert.equal(A('嗯我觉得这个方案挺好的你看看有没有问题').cold, 0, '长句子里带一个嗯不算冷落');
  assert.equal(A('滚开').scold, 1, '凶');
  assert.ok(A('你怎么又这样').scold > 0 && A('你怎么又这样').scold < 1, '轻一点的责备');
  assert.equal(A('你怎么又这么可爱').scold, 0, '夸得很满的句子里夹「怎么又」不算凶');
  assert.equal(A('对不起，我刚才凶了你').comfort, 1, '道歉');
  assert.ok(A('抱抱').comfort > 0, '安慰');
  assert.equal(A('我错了').scold, 0, '「我错了」是道歉不是责备');
  const plainTalk = A('今天吃什么');
  assert.equal(plainTalk.praise + plainTalk.scold + plainTalk.cold + plainTalk.comfort + plainTalk.interest + plainTalk.hush, 0);
  assert.deepEqual(Object.values(appraise('')), [0, 0, 0, 0, 0, 0], '空话全是 0');
  // 兴趣
  assert.equal(A('今天听了首钢琴曲', ['钢琴']).interest, 0.6, '命中一个词 0.6');
  assert.equal(A('钢琴和原神', ['钢琴', '原神']).interest, 1, '两个词封顶 1');
  assert.equal(A('今天听了首钢琴曲', [{ word: '钢琴', weight: 2 }]).interest, 1, '词带权重');
  assert.equal(A('什么都没有', ['钢琴']).interest, 0);
  assert.equal(A('PIANO 好听', ['piano']).interest, 0.6, '不分大小写');
  assert.deepEqual(interestList({ 猫: 1, 钢琴: 2 }).map((x) => x.word), ['猫', '钢琴'], '词表可以是对象');
  assert.deepEqual(interestList(['a', '猫', [' 钢琴 ', 3]]).map((x) => x.word), ['猫', '钢琴'], '单个英文字母丢掉，数组形式可以带权重');
  assert.equal(interestMatch('我家有只猫', interestList(['猫'])), 0.6);
  // 只有强度数字，没有原文
  for (const v of Object.values(appraise('你真厉害 秘密', ['秘密']))) assert.equal(typeof v, 'number');
  // 天气词
  assert.equal(weatherKind('小雨'), 'rain');
  assert.equal(weatherKind('晴'), 'clear');
  assert.equal(weatherKind('多云'), 'gloom');
  assert.equal(weatherKind('降温了'), 'cold');
  assert.equal(weatherKind('高温'), 'hot');
  assert.equal(weatherKind('???'), '');
  ok('关键词判断：被夸 / 被冷落 / 被凶 / 被安慰 / 别吵 / 聊到兴趣；否定、长句、夸里夹责备都不误判');
}

// ── 兴趣词表：从抖音插件的人格记忆里取 ──
{
  const ev = (...sigs) => sigs.map((signal) => ({ signal }));
  const persona = {
    interests: [
      { topic: '我的世界红石音乐', evidence: ev(...Array(10).fill('like')) },
      { topic: '座头鲸/海洋巨兽的水下近景', evidence: ev('like', 'like', 'neutral') },
      { topic: '美食吃播', evidence: ev('neutral') },
      { topic: '吵架视频', evidence: ev('like', 'like', 'dislike', 'dislike') },
      { topic: '林俊杰、钢琴', evidence: ev('like', 'like', 'like') },
      null,
    ],
  };
  const list = interestsFromPersona(persona);
  const words = list.map((x) => x.word);
  assert.ok(words.includes('我的世界红石音乐') && words.includes('座头鲸') && words.includes('海洋巨兽') && words.includes('钢琴') && words.includes('林俊杰'), `拆词：${words}`);
  assert.ok(!words.includes('美食吃播') && !words.includes('吵架视频'), '证据不够、正负打平的不取');
  assert.equal(list[0].word, '我的世界红石音乐', '证据多的权重高、排前面');
  assert.ok(list.every((x) => x.weight > 0 && x.weight <= 2));
  assert.equal(interestsFromPersona(null).length, 0);
  assert.ok(appraise('今天听了林俊杰', list).interest > 0, '取出来的词表能直接给 appraise 用');
  ok('兴趣词表：从抖音人格记忆的选题和证据里拆词、加权，证据不够的不取');
}

// ── 无聊：久没新鲜升，做了新鲜事降；重复的事多升得快；睡着回落；推高好奇；创作冲动跟着冒 ──
{
  const s0 = fresh();
  const bored = run(s0, 8 * HOUR);
  assert.ok(lv(bored).boredom > lv(s0).boredom + 0.12, `醒 8 小时没新鲜事，无聊升了（${lv(bored).boredom}）`);
  // 做了新鲜事降
  const fun = run(bored, 0, [evAt(bored, E.NOVELTY)]);
  assert.ok(lv(fun).boredom < lv(bored).boredom - 0.1, '看到新东西，无聊降');
  const exp = run(bored, 0, [evAt(bored, E.EXPLORED)]);
  assert.ok(lv(exp).boredom < lv(bored).boredom - 0.1, '逛过一圈，无聊降');
  // 看到的东西正好是她感兴趣的，降得更多
  const hit = run(bored, 0, [evAt(bored, E.NOVELTY, 0, { interestMatch: 1 })]);
  const miss = run(bored, 0, [evAt(bored, E.NOVELTY, 0, { interestMatch: 0 })]);
  assert.ok(lv(hit).boredom < lv(miss).boredom, '命中兴趣降得更多');
  assert.ok(lv(hit).curiosityImpulse > lv(miss).curiosityImpulse, '命中兴趣好奇冲得更高');
  assert.ok(lv(hit).createUrge > lv(miss).createUrge, '命中兴趣，顺带冒一点创作冲动');
  // 不知道兴趣表：按中间值，和第一期一样 +0.3
  near(lv(run(fresh(), 0, [evAt(s0, E.NOVELTY)])).curiosityImpulse, 0.3, 1e-9, '没有兴趣表信息时冲击不变');
  // 带 text + interests 自己算命中
  const viaText = run(bored, 0, [evAt(bored, E.NOVELTY, 0, { text: '一只猫在弹钢琴', interests: ['猫', '钢琴'] })]);
  assert.ok(lv(viaText).curiosityImpulse > lv(miss).curiosityImpulse, '文字 + 兴趣表也能算命中');
  // 重复的事多，涨得快
  const spam = Array.from({ length: 30 }, (_, i) => evAt(s0, E.GROUP_MSG, i * 10 * MIN, { novelty: 0.02 }));
  const calm = run(s0, 5 * HOUR);
  const routine = run(s0, 5 * HOUR, spam);
  assert.ok(lv(routine).boredom > lv(calm).boredom, `群里全是老一套，无聊涨得快（${lv(routine).boredom} > ${lv(calm).boredom}）`);
  const rep = run(s0, 5 * HOUR, Array.from({ length: 20 }, (_, i) => evAt(s0, E.REPEATED, i * 10 * MIN)));
  assert.ok(lv(rep).boredom > lv(calm).boredom, '又做了一遍重复的事，无聊涨得快');
  // 睡着回落
  let slept = run(bored, 0, [evAt(bored, E.SLEEP)]);
  slept = run(slept, 8 * HOUR);
  assert.ok(lv(slept).boredom < lv(bored).boredom - 0.1 && lv(slept).boredom >= 0.2 - 1e-9, '睡一觉回到基线附近');
  // 无聊久了推高好奇缓升部分、创作冲动
  const noCouple = mergeCfg({ couple: { enabled: false } });
  const a = run(fresh(), 14 * HOUR);
  const b = run(createState(noCouple, { now: T0 }), 14 * HOUR, [], noCouple);
  assert.ok(a.h.curiositySlow > b.h.curiositySlow + 0.03, `无聊久了好奇缓升更多（${a.h.curiositySlow} vs ${b.h.curiositySlow}）`);
  assert.ok(a.h.createUrge > b.h.createUrge, '无聊时创作冲动也冒得多');
  ok('无聊：久没新鲜升、新鲜事 / 逛过降、重复多升得快、睡着回落、兴趣命中加权、推高好奇和创作冲动');
}

// ── 被在乎 / 安全感：回得快、被夸、被主动找升；被冷落、长时间没回降；基线慢变有上下限 ──
{
  const s0 = fresh();
  const base = lv(s0).security;
  // 回得快 vs 回得慢（调用方传 replyDelayMs）
  const fast = run(s0, MIN, [evAt(s0, E.MSG_FROM_OWNER, 0, { replyDelayMs: 60e3 })]);
  const slow = run(s0, MIN, [evAt(s0, E.MSG_FROM_OWNER, 0, { replyDelayMs: 5 * HOUR })]);
  assert.ok(lv(fast).security > base + 0.05, '老大回得快，安全感升');
  assert.ok(lv(slow).security < base, '隔了好几个小时才回，不升反降一点');
  // 不传就按她上次发的时间推
  const sent = run(s0, 0, [evAt(s0, E.SENT_TO_OWNER)]);
  const inferred = run(sent, MIN, [evAt(sent, E.MSG_FROM_OWNER, 30e3)]);
  assert.ok(lv(inferred).security > base + 0.05, '没传 replyDelayMs 也能推出回得快');
  // 她没发，老大主动来找
  const init = run(s0, MIN, [evAt(s0, E.MSG_FROM_OWNER)]);
  assert.ok(lv(init).security > base + 0.04, '被主动找，安全感升');
  assert.ok(lv(init).satisfaction > lv(s0).satisfaction, '也有一点满足');
  // 被夸、被安慰升；被凶、被冷落降
  const pr = run(s0, 0, [evAt(s0, E.PRAISED)]);
  assert.ok(lv(pr).security > base + 0.08 && lv(pr).pride > lv(s0).pride && lv(pr).satisfaction > lv(s0).satisfaction, '被夸：安全感、成就感、满足都升');
  const sc = run(s0, 0, [evAt(s0, E.SCOLDED)]);
  assert.ok(lv(sc).security < base - 0.05, '被凶，安全感降');
  const cd = run(s0, 0, [evAt(s0, E.COLD)]);
  assert.ok(lv(cd).security < base && lv(cd).grievance > 0, '被冷落：安全感降，有一点委屈');
  // 话里的夸 / 冷落也认
  const viaText = run(s0, 0, [evAt(s0, E.MSG_FROM_OWNER, 0, { text: '嗯', replyDelayMs: 20 * MIN })]);
  const viaPraise = run(s0, 0, [evAt(s0, E.MSG_FROM_OWNER, 0, { text: '你真厉害', replyDelayMs: 20 * MIN })]);
  assert.ok(lv(viaPraise).security > lv(viaText).security + 0.1, '回「嗯」比回「你真厉害」安全感低得多');
  // 姐妹夸分量轻一点
  const fromSister = run(s0, 0, [evAt(s0, E.PRAISED, 0, { from: 'sister' })]);
  assert.ok(lv(fromSister).security > base && lv(fromSister).security < lv(pr).security, '姐妹夸，分量比老大轻');

  // 发了没人回：等久了落点往下沉；有人回了恢复
  const waiting = run(sent, 8 * HOUR);
  assert.ok(lv(waiting).security < base - 0.1, `等了 8 小时没人回，安全感降（${lv(waiting).security}）`);
  const back = run(waiting, MIN, [evAt(waiting, E.MSG_FROM_OWNER, 0, { replyDelayMs: 8 * HOUR })]);
  const later = run(back, 6 * HOUR);
  assert.ok(lv(later).security > lv(waiting).security + 0.05, '对方开口以后慢慢回来');
  const noWait = run(fresh(), 8 * HOUR);
  assert.ok(lv(noWait).security > lv(waiting).security + 0.1, '没发过消息就不存在「被晾着」');
  const sleptWait = run(run(sent, 0, [evAt(sent, E.SLEEP)]), 8 * HOUR);
  assert.ok(lv(sleptWait).security > lv(waiting).security, '睡着的时候不算被晾着');

  // 基线慢慢变：一天最多挪几个百分点；30 天落到下限为止，不会沉到底
  const day1 = run(sent, 24 * HOUR);
  const d1 = lv(day1).securityBase;
  assert.ok(d1 < 0.5 && d1 > 0.5 - 0.06, `被冷落一天，基线只挪一点（${d1}）`);
  const month = run(sent, 30 * 24 * HOUR);
  assert.ok(lv(month).securityBase >= DEFAULTS.security.min - 1e-9 && lv(month).securityBase < 0.34, `长期被冷落，基线降到下限附近但不穿（${lv(month).securityBase}）`);
  // 被好好对待：慢慢升，有上限
  const evs = [];
  for (let d = 0; d < 30; d += 1) {
    for (let k = 0; k < 8; k += 1) {
      const at = d * 24 * HOUR + k * HOUR;
      evs.push({ type: E.PRAISED, at: T0 + at }, { type: E.MSG_FROM_OWNER, at: T0 + at + 5 * MIN, replyDelayMs: 60e3 });
    }
  }
  const kind = step(fresh(), { now: T0 + 30 * 24 * HOUR, events: evs });
  assert.ok(lv(kind).securityBase > 0.6 && lv(kind).securityBase <= DEFAULTS.security.max + 1e-9, `被好好对待一个月，基线升到上限附近但不穿（${lv(kind).securityBase}）`);
  const kind1 = step(fresh(), { now: T0 + 24 * HOUR, events: evs.filter((e) => e.at < T0 + 24 * HOUR) });
  assert.ok(lv(kind1).securityBase - 0.5 < 0.06, `一天里再多好事，基线也只挪几个百分点（${lv(kind1).securityBase}）`);
  // 很久什么都不发生，往老家靠
  const lowBase = { ...fresh(), slow: { secBase: 0.3 } };
  assert.ok(lv(run(lowBase, 90 * 24 * HOUR)).securityBase > 0.4, '很久没事，基线极慢地往回靠');
  // 越界的基线也被拉回区间
  const crazy = run({ ...fresh(), slow: { secBase: 5 } }, MIN);
  assert.ok(lv(crazy).securityBase <= DEFAULTS.security.max, '基线截在上下限里');
  ok('被在乎：回复快慢 / 主动找 / 夸 / 凶 / 冷落 / 话里的关键词 / 等不到回复；基线慢变，有上下限，一天只挪几个百分点');
}

// ── 创作冲动、成就感 ──
{
  const s0 = fresh();
  const moved = run(s0, 0, [evAt(s0, E.MOVED)]);
  const read = run(s0, 0, [evAt(s0, E.READ_GOOD)]);
  assert.ok(lv(moved).createUrge > lv(s0).createUrge + 0.2, '有感触的瞬间，创作冲动升');
  assert.ok(lv(read).createUrge > lv(s0).createUrge + 0.15, '读到好东西，创作冲动升');
  // 写了东西以后降
  const urge = run(s0, 0, [evAt(s0, E.MOVED), evAt(s0, E.READ_GOOD, 1)]);
  for (const kind of ['tidbit', 'diary', 'novel', 'work']) {
    const wrote = run(urge, 0, [evAt(urge, E.CREATED, 0, { kind })]);
    assert.ok(lv(wrote).createUrge < lv(urge).createUrge - 0.15, `写了${kind}，冲动降`);
  }
  // 成就感：写完一节、发出作品冲一下，慢回落（3 小时半衰期）
  const novel = run(s0, 0, [evAt(s0, E.CREATED, 0, { kind: 'novel' })]);
  const tidbit = run(s0, 0, [evAt(s0, E.CREATED, 0, { kind: 'tidbit' })]);
  assert.ok(lv(novel).pride > lv(s0).pride + 0.2, '写完一节小说，成就感冲上去');
  assert.ok(lv(novel).pride > lv(tidbit).pride, '一条碎碎念的成就感比不上一节小说');
  const decay = run(novel, 3 * HOUR);
  near(lv(decay).pride - 0.1, (lv(novel).pride - 0.1) / 2, 0.02, '成就感 3 小时回落一半');
  const praisedWork = run(s0, 0, [evAt(s0, E.PRAISED, 0, { about: 'work' })]);
  const praisedOther = run(s0, 0, [evAt(s0, E.PRAISED)]);
  assert.ok(lv(praisedWork).pride > lv(praisedOther).pride + 0.15, '夸的是她的作品 = 被认可，成就感冲得更高');
  const posted = run(s0, 0, [evAt(s0, E.POSTED)]);
  assert.ok(lv(posted).pride > lv(s0).pride + 0.1, '发出去了，成就感升');
  // 压力压住创作冲动
  const stressed = run(s0, 0, [evAt(s0, E.HUSHED), evAt(s0, E.HUSHED, 1), evAt(s0, E.TOOL_FAIL, 2)]);
  const stressedMoved = run(stressed, 0, [evAt(stressed, E.MOVED)]);
  const calmMoved = run(s0, 0, [evAt(s0, E.MOVED)]);
  assert.ok(lv(stressedMoved).createUrge - lv(stressed).createUrge < (lv(calmMoved).createUrge - lv(s0).createUrge) * 0.75, '压力大的时候，同样的感触冲得小');
  // 心情起伏大（正或负）把落点抬高
  const moody = run(s0, 48 * HOUR, [evAt(s0, E.MOOD, 0, { positive: 1, negative: 0 })]);
  assert.ok(lv(moody).createUrge > lv(run(s0, 48 * HOUR)).createUrge + 0.05, '心情起伏大，创作冲动的落点抬高');
  ok('创作冲动 / 成就感：感触 / 读到好东西升，写了降，压力压住；成就感冲一下慢回落，被认可冲得更高');
}

// ── 委屈 ──
{
  const s0 = fresh();
  const sc = run(s0, 0, [evAt(s0, E.SCOLDED)]);
  assert.ok(lv(sc).grievance > 0.2, '被凶，委屈升');
  const itr = run(s0, 0, [evAt(s0, E.INTERRUPTED)]);
  const mis = run(s0, 0, [evAt(s0, E.MISUNDERSTOOD)]);
  assert.ok(lv(itr).grievance > 0.05 && lv(mis).grievance > 0.1, '被打断、被误会，委屈升');
  const viaText = run(s0, 0, [evAt(s0, E.MSG_FROM_OWNER, 0, { text: '你怎么又乱说', replyDelayMs: 30 * MIN })]);
  assert.ok(lv(viaText).grievance > 0.05, '话里的责备也认');
  // 被安慰 / 道歉后降
  const cm = run(sc, 0, [evAt(sc, E.COMFORTED)]);
  assert.ok(lv(cm).grievance < lv(sc).grievance - 0.2, '被道歉、被安慰，委屈降');
  const viaSorry = run(sc, 0, [evAt(sc, E.MSG_FROM_OWNER, 60e3, { text: '对不起，刚才我说重了', replyDelayMs: 60e3 })]);
  assert.ok(lv(viaSorry).grievance < lv(sc).grievance - 0.2, '话里的道歉也认');
  // 持久：4 小时半衰期
  near(lv(run(sc, 4 * HOUR)).grievance, lv(sc).grievance / 2, 0.02, '委屈 4 小时回落一半');
  // 抑制主动找老大，提高想被在乎（想念涨得快）
  const calm = run(s0, 3 * HOUR);
  const hurt = run(setH(s0, { grievance: 0.6 }), 3 * HOUR);
  assert.ok(hurt.h.longingOwner > calm.h.longingOwner, '委屈了更想被在乎（想念涨得更快）');
  const lamHurt = hazards(setH(calm, { grievance: 0.6 })).ownerPing.lambda;
  const lamCalm = hazards(calm).ownerPing.lambda;
  assert.ok(lamHurt < lamCalm * 0.5, `委屈压低主动找老大（${lamHurt / lamCalm}）`);
  // 2026-10-29 借鉴积温后：轻微委屈（戒备还没起来）倒是更想找姐妹说说；委屈重了戒备起来，找谁都不想先开口
  assert.equal(hazards(setH(calm, { grievance: 0.1 })).sisterPing.lambda > hazards(calm).sisterPing.lambda, true, '轻微委屈，更想找姐妹说说');
  assert.ok(hazards(setH(calm, { grievance: 0.6 })).sisterPing.lambda < hazards(calm).sisterPing.lambda, '委屈重了，戒备压住找姐妹');
  ok('委屈：被凶 / 误会 / 打断升，道歉安慰降，持久；抑制找老大、提高想被在乎');
}

// ── 激素之间互相影响（小矩阵，可配置）──
{
  const s0 = fresh();
  // 压力抑制好奇
  const stressed = run(s0, 0, [evAt(s0, E.HUSHED), evAt(s0, E.HUSHED, 1), evAt(s0, E.TOOL_FAIL, 2)]);
  const gS = lv(run(stressed, 0, [evAt(stressed, E.NOVELTY)])).curiosityImpulse - lv(stressed).curiosityImpulse;
  const gC = lv(run(s0, 0, [evAt(s0, E.NOVELTY)])).curiosityImpulse - lv(s0).curiosityImpulse;
  assert.ok(gS < gC * 0.7, `压力大时，同样的新东西好奇冲得小（${gS} < ${gC}）`);
  // 把矩阵里这一格改成 0，抑制就没了
  const noStress = mergeCfg({ couple: { gain: { curiosityImpulse: { stress: 0 } } } });
  const g0 = lv(step(stressed, { now: stressed.t, events: [evAt(stressed, E.NOVELTY)] }, noStress), noStress).curiosityImpulse - lv(stressed, noStress).curiosityImpulse;
  assert.ok(g0 > gS * 1.2, '矩阵可配置：这一格改成 0，压力就不再抑制好奇');
  // 满足降低想念涨速
  const happy = setH(s0, { satisfaction: 0.9 });
  assert.ok(run(happy, 10 * HOUR).h.longingOwner < run(s0, 10 * HOUR).h.longingOwner - 0.03, '心里满足，想念涨得慢');
  assert.ok(run(happy, 10 * HOUR, [], mergeCfg({ couple: { enabled: false } })).h.longingOwner > run(happy, 10 * HOUR).h.longingOwner, 'couple.enabled=false 全关');
  // 心里踏实不容易委屈
  const secure = setH(s0, { security: 0.9 });
  const gHurtSecure = lv(run(secure, 0, [evAt(secure, E.SCOLDED)])).grievance;
  const gHurt = lv(run(s0, 0, [evAt(s0, E.SCOLDED)])).grievance;
  assert.ok(gHurtSecure < gHurt, '心里踏实的时候，被凶也没那么委屈');
  // 矩阵的取值被限在 [minMult, maxMult]，不会把冲击压成负的或放大到爆
  const crazyCfg = mergeCfg({ couple: { gain: { curiosityImpulse: { stress: -100 } } } });
  const crazy = step(setH(s0, { stress: 1 }), { now: T0, events: [evAt(s0, E.NOVELTY)] }, crazyCfg);
  assert.ok(crazy.h.curiosityImpulse >= 0 && crazy.h.curiosityImpulse <= 1, '倍数有下限');
  ok('互相影响：压力压好奇和创作、满足拖慢想念、委屈拉高想被在乎、踏实不易委屈；矩阵可配置、有限幅');
}

// ── 两套性格：妹妹起伏大恢复快；姐姐 2026-10-29 改成老大定的版本（不再是「稳、慢热」，细节见 scripts/test-sister-e.mjs）──
{
  assert.equal(createState(null, 'fish').persona, 'fish', 'createState(cfg, persona) 直接传名字');
  assert.equal(createState(null, 'sister').persona, 'sister');
  assert.equal(createState(null, 'nobody').persona, 'default', '不认识的性格当没指定');
  assert.equal(createState(null, { now: T0, persona: 'fish' }).persona, 'fish', '也可以放在选项里');
  const fish = createState(null, { now: T0, persona: 'fish' });
  const sis = createState(null, { now: T0, persona: 'sister' });
  const def = createState(null, { now: T0 });
  const hush = (s) => run(s, 0, [evAt(s, E.HUSHED)]);
  const jump = (s, k, f) => f(s).h[k] - s.h[k];
  assert.ok(jump(fish, 'stress', hush) > jump(def, 'stress', hush) * 1.2 && jump(sis, 'stress', hush) >= jump(def, 'stress', hush) * 0.95, '妹妹冲击大；姐姐不再被压成「冲击小」（10-29 改）');
  // 恢复：同样冲一下，妹妹一小时后剩得更少
  const left = (s) => (run(hush(s), HOUR).h.stress - s.h.stress) / (hush(s).h.stress - s.h.stress);
  assert.ok(left(fish) < left(def) && Math.abs(left(sis) - left(def)) < 0.03, `恢复快慢：妹妹 ${left(fish).toFixed(2)} < 默认 ${left(def).toFixed(2)}，姐姐 ${left(sis).toFixed(2)} 回到默认附近（不再拖慢）`);
  // 想念：姐姐爱操心，家里人没动静涨得比默认快
  assert.ok(run(sis, 10 * HOUR).h.longingOwner > run(def, 10 * HOUR).h.longingOwner, '姐姐想念涨得比默认快（操心）');
  // 对方来一次消息，姐姐一下子松口气（比默认抚平得多）
  const touch = (s) => run(setH(s, { longingOwner: 0.9 }), 0, [evAt(s, E.MSG_FROM_OWNER)]).h.longingOwner;
  assert.ok(touch(sis) < touch(def), '想念一来一回，姐姐一下子松下来');
  // 委屈：妹妹来得快；姐姐回到默认（不再被压成「不太容易委屈」）
  const scold = (s) => lv(run(s, 0, [evAt(s, E.SCOLDED)])).grievance;
  assert.ok(scold(sis) < scold(fish) && scold(sis) >= scold(def) * 0.9, `委屈：妹妹 ${scold(fish)} > 姐姐 ${scold(sis)} ≈ 默认 ${scold(def)}`);
  // 安全感的基线：姐姐变得更慢
  const neglected = (p) => { const a = fresh(p); return lv(run(run(a, 0, [evAt(a, E.SENT_TO_OWNER)]), 3 * 24 * HOUR)).securityBase; };
  assert.ok(neglected('fish') < neglected('sister'), '同样被冷落三天，妹妹的基线掉得更多');
  // 性格表是常量表，三套键齐全
  for (const p of ['default', 'fish', 'sister']) assert.ok(PERSONAS[p] && PERSONAS[p].gain && PERSONAS[p].halfLife && PERSONAS[p].rate);
  ok('两套性格：妹妹冲击大、恢复快；姐姐 10-29 改版：回落回到默认、想念涨得快、一联系就松下来');
}

// ── 适应（习惯化）──
{
  const s0 = fresh();
  const gain = (s, type, extra = {}) => { const a = lv(s).security; return lv(run(s, 0, [evAt(s, type, 0, extra)])).security - a; };
  let s = s0;
  const gains = [];
  for (let i = 0; i < 6; i += 1) {
    gains.push(gain(s, E.PRAISED));
    s = run(s, MIN, [evAt(s, E.PRAISED)]);
  }
  for (let i = 1; i < gains.length; i += 1) assert.ok(gains[i] <= gains[i - 1] + 1e-9, `连着被夸，一次比一次冲击小（${gains.map((x) => x.toFixed(3))}）`);
  assert.ok(gains[5] < gains[0] * 0.6, '五六次以后只剩一半不到');
  assert.ok(gains[5] > gains[0] * DEFAULTS.habit.floor * 0.7, '但不会一点都没有（有下限）');
  // 久不发生，恢复
  const rested = run(s, 12 * HOUR);
  assert.ok(gain(rested, E.PRAISED) > gains[0] * 0.8, '隔了半天，又接近第一次的反应');
  // 不同类的事互不影响
  assert.ok(gain(s, E.COMFORTED) > 0.05, '夸被习惯了，安慰还是新的');
  // 关掉就不递减
  const noHab = mergeCfg({ habit: { enabled: false } });
  let n = createState(noHab, { now: T0 });
  const a1 = step(n, { now: T0, events: [{ type: E.PRAISED, at: T0 }] }, noHab).h.security - n.h.security;
  n = step(n, { now: T0 + MIN, events: [{ type: E.PRAISED, at: T0 + MIN }, { type: E.PRAISED, at: T0 + MIN }] }, noHab);
  assert.ok(n.hab.praise === undefined, 'habit 关掉不记次数');
  assert.ok(a1 > 0.1, '关掉后第一次是满额');
  // 反复失败 / 反复冷落也适应
  const fails = run(s0, 10 * MIN, Array.from({ length: 6 }, (_, i) => evAt(s0, E.TOOL_FAIL, i * MIN)));
  assert.ok(fails.h.stress < 0.1 + 6 * 0.1 * 0.6, '工具连着出错，压力不是简单累加');
  const colds = run(s0, 10 * MIN, Array.from({ length: 6 }, (_, i) => evAt(s0, E.COLD, i * MIN)));
  assert.ok(lv(colds).security > 0.5 - 6 * 0.06 * 0.75, '连着被敷衍，也有适应');
  assert.ok(Object.keys(run(s0, 0, [evAt(s0, E.PRAISED)]).hab).includes('praise'), '适应的次数记在状态里');
  assert.ok(Object.keys(run(run(s0, 0, [evAt(s0, E.PRAISED)]), 40 * HOUR).hab).length === 0, '很久以后清空');
  ok('适应：同类事件反复来冲击递减（有下限），久不发生恢复，不同类互不影响，可关');
}

// ── 天气、日出日落、心情 ──
{
  const s0 = fresh();
  const rain = run(s0, 6 * HOUR, [evAt(s0, E.WEATHER, 0, { text: '小雨' })]);
  const clear = run(s0, 6 * HOUR, [evAt(s0, E.WEATHER, 0, { kind: 'clear' })]);
  const plain = run(s0, 6 * HOUR);
  assert.equal(rain.weather, 'rain');
  assert.ok(lv(rain).boredom > lv(plain).boredom && lv(plain).boredom > lv(clear).boredom, '下雨更无聊，晴天少一点');
  assert.ok(lv(rain).boredom - lv(clear).boredom < 0.1, '但只是少量');
  assert.ok(lv(rain).security < lv(plain).security && lv(plain).security < lv(clear).security, '下雨安全感略低，晴天略高');
  assert.ok(lv(clear).security - lv(rain).security < 0.1, '也是少量');
  const rainDay = run(s0, 10 * 24 * HOUR, [evAt(s0, E.WEATHER, 0, { text: '雨' })]);
  assert.ok(lv(rainDay).securityBase >= 0.499, '天气只推短期，不改基线');
  assert.equal(run(s0, 0, [evAt(s0, E.WEATHER, 0, { text: '晴', tempC: 1 })]).weather, 'cold', '气温很低按冷算');
  assert.equal(run(s0, 0, [evAt(s0, E.WEATHER, 0, { tempC: 36 })]).weather, 'hot');
  // 日出日落：夜里更困、白天更精神（北京 2:00 / 13:00 = UTC 18:00 前一天 / 05:00）
  const night = Date.parse('2026-10-28T18:00:00Z');
  const noon = Date.parse('2026-10-29T05:00:00Z');
  const withSun = { rise: 6.5, set: 17.5 };
  assert.ok(sunTerm(night, withSun) > 0.04 && sunTerm(noon, withSun) < -0.04, '夜里 +amp，白天 −amp');
  assert.equal(sunTerm(noon, null), 0);
  const mid = Date.parse('2026-10-28T22:30:00Z'); // 北京 6:30 日出
  assert.ok(Math.abs(sunTerm(mid, withSun)) < 0.01, '日出那一刻在中间');
  const sunny = run(fresh(), 0, [evAt(s0, E.SUN, 0, { sunrise: 6.5, sunset: 17.5 })]);
  assert.deepEqual(sunny.sun, { rise: 6.5, set: 17.5 });
  const sunMs = run(fresh(), 0, [evAt(s0, E.SUN, 0, { sunrise: Date.parse('2026-10-28T22:30:00Z'), sunset: Date.parse('2026-10-29T09:30:00Z') })]);
  assert.ok(Math.abs(sunMs.sun.rise - 6.5) < 1e-6 && Math.abs(sunMs.sun.set - 17.5) < 1e-6, '毫秒时间戳按北京钟点换算');
  const atNoon = { ...sunny, t: noon };
  const atNoonNo = { ...fresh(), t: noon };
  assert.ok(lv(atNoon).sleepy < lv(atNoonNo).sleepy, '知道天亮着，中午没那么困');
  assert.equal(run(sunny, 0, [evAt(sunny, E.SUN, 0, { sunrise: 'x' })]).sun.rise, 6.5, '坏数据不改');
  // 心情正面：满足的落点抬高
  const happy = run(s0, 48 * HOUR, [evAt(s0, E.MOOD, 0, { positive: 1, negative: 0 })]);
  assert.ok(lv(happy).satisfaction > lv(run(s0, 48 * HOUR)).satisfaction + 0.1, '心情好，满足的落点抬高');
  ok('天气（无聊 / 安全感少量）、日出日落（困的昼夜项）、心情正面（满足的落点）');
}

// ── 新行为发生率：冷却、睡着为 0、受对应激素影响 ──
{
  const s0 = fresh();
  const NEW = ['journal', 'novel', 'post', 'sticker', 'peekOwner', 'nap'];
  assert.deepEqual(BEHAVIORS.slice(0, 4), ['ownerPing', 'sisterPing', 'groupChat', 'explore'], '老的四个顺序不变');
  for (const b of NEW) assert.ok(BEHAVIORS.includes(b), `${b} 在行为表里`);
  for (const b of BEHAVIORS) assert.ok(DEFAULTS.hazards[b].cooldownMin > 0 && DEFAULTS.hazards[b].lambda0PerMin > 0, `${b} 有冷却和基线发生率`);
  const hz0 = hazards(run(s0, 2 * HOUR));
  for (const b of BEHAVIORS) assert.ok(Number.isFinite(hz0[b].lambda) && hz0[b].p >= 0 && hz0[b].p <= 1, `${b} 发生率是有限的概率`);
  for (const b of ['journal', 'novel', 'post', 'sticker', 'peekOwner']) assert.ok(hz0[b].lambda > 0, `${b} 醒着有发生率`);
  // 冷却：真的做了以后一段时间为 0，过了又有
  const cases = [['journal', E.CREATED, { kind: 'tidbit' }, 90], ['journal', E.CREATED, { kind: 'diary' }, 90], ['novel', E.CREATED, { kind: 'novel' }, 120],
    ['post', E.POSTED, {}, 180], ['post', E.CREATED, { kind: 'work' }, 180], ['sticker', E.STICKER_SENT, {}, 20], ['peekOwner', E.PEEKED, {}, 90], ['groupChat', E.SENT_GROUP, {}, 10], ['explore', E.EXPLORED, {}, 30]];
  for (const [b, type, extra, cd] of cases) {
    const did = run(s0, HOUR, [evAt(s0, type, HOUR, extra)]);
    const early = hazards(run(did, (cd - 5) * MIN));
    assert.equal(early[b].p, 0, `${b}：做完 ${cd} 分钟内为 0（${type}）`);
    assert.equal(early[b].why, 'cooldown');
    const lateS = run(did, (cd + 5) * MIN);
    assert.ok(hazards(lateS)[b].lambda > 0, `${b}：过了冷却又有`);
  }
  // 打盹：困到一定程度才有，睡不满 3 小时的睡眠也记冷却
  const sleepy = setH(run(s0, 0), { sleepPressure: 0.95 });
  assert.equal(hazards(s0).nap.p, 0, '不困不打盹');
  assert.equal(hazards(s0).nap.why, 'not-sleepy');
  assert.ok(hazards(sleepy).nap.lambda > 0, '困了有可能打盹');
  const napped = run(sleepy, 0, [evAt(sleepy, E.NAPPED)]);
  assert.equal(hazards(napped).nap.p, 0, '打完盹进冷却');
  assert.ok(lv(napped).sleepy < lv(sleepy).sleepy, '打盹后睡眠压力降一点');
  let viaSleep = run(sleepy, 0, [evAt(sleepy, E.SLEEP)]);
  viaSleep = run(viaSleep, 30 * MIN, [evAt(viaSleep, E.WAKE, 30 * MIN)]);
  assert.equal(viaSleep.sleepLog.length, 1);
  assert.equal(hazards(setH(viaSleep, { sleepPressure: 0.95 })).nap.why, 'cooldown', '睡 30 分钟再醒 = 一个盹，也进冷却');
  // 每个新行为睡着都是 0
  const asleep = run(sleepy, 0, [evAt(sleepy, E.SLEEP), evAt(sleepy, E.MOVED), evAt(sleepy, E.PRAISED)]);
  const hzA = hazards(asleep, { dtMin: 60 });
  for (const b of BEHAVIORS) assert.equal(hzA[b].p, 0, `${b} 睡着为 0`);
  // 受对应激素影响
  const ratio = (patch, b) => hazards(setH(s0, patch))[b].lambda / hazards(s0)[b].lambda;
  assert.ok(ratio({ createUrge: 0.8 }, 'journal') > 3 && ratio({ createUrge: 0.8 }, 'novel') > 3, '创作冲动高，写东西的发生率高');
  assert.ok(ratio({ pride: 0.7 }, 'post') > 2, '成就感高，想发说说');
  assert.ok(ratio({ pride: 0.7 }, 'ownerPing') > 1, '有成就也更想告诉老大');
  assert.ok(ratio({ stress: 0.8 }, 'journal') < 0.5 && ratio({ stress: 0.8 }, 'novel') < 0.3 && ratio({ stress: 0.8 }, 'post') < 0.5, '压力大的时候都少');
  assert.ok(ratio({ security: 0.1 }, 'peekOwner') > 1.5, '安全感低，更想看一眼老大在干嘛');
  assert.ok(ratio({ security: 0.1 }, 'ownerPing') <= 1 + 1e-9, '但安全感低不会让她多发消息给老大（不施压；借鉴积温后还会因为戒备起来而更少）');
  assert.ok(ratio({ security: 0.9 }, 'sticker') > 1.2, '心里踏实的时候表情发得多');
  assert.ok(ratio({ boredom: 0.9 }, 'explore') > 2 && ratio({ boredom: 0.9 }, 'groupChat') > 1.3, '无聊了想去逛、想水群');
  // 影子模式的虚拟冷却也认新行为
  const virt = hazards(s0, { virtual: { journal: { last: s0.t - 10 * MIN }, nap: { last: s0.t - MIN } } });
  assert.equal(virt.journal.p, 0, '「本来会写」的那次也算冷却');
  // 几项叠加也封顶（防刷屏）
  const hot = setH(s0, { createUrge: 1, boredom: 1, grievance: 1, pride: 1, satisfaction: 1, stress: 0 });
  for (const b of BEHAVIORS) assert.ok(hazards(hot)[b].lambda <= DEFAULTS.hazards[b].lambda0PerMin * Math.exp(DEFAULTS.hazardMaxLog) * 1.0001, `${b} 最多是基线的 e^3 倍`);
  ok('新行为：写碎碎念 / 小说、发说说、发表情、看老大电脑、打盹——有冷却、睡着为 0、受对应激素影响、有上限；安全感低不催她去找老大');
}

// ── 感受句覆盖新状态 ──
{
  const s0 = fresh();
  const say = (patch, prev = null) => feltLine(setH(s0, patch), prev);
  assert.equal(say({ boredom: 0.8 }).line, '有点无聊。');
  assert.equal(say({ createUrge: 0.75 }).line, '想写点什么。');
  assert.equal(say({ grievance: 0.5 }).line, '刚才那句话有点委屈。');
  assert.equal(say({ security: 0.85 }).line, '被惦记着挺踏实。');
  assert.equal(say({ security: 0.1 }).line, '有点怕被晾在一边。');
  assert.match(say({ pride: 0.7 }).line, /得意/);
  assert.match(say({ satisfaction: 0.9 }).line, /满足/);
  assert.equal(say({}).line, '', '平平常常什么都不说');
  assert.equal(say({ boredom: 0.55 }).line, '', '没到线不说');
  // 滞后
  let f = say({ grievance: 0.4 });
  f = say({ grievance: 0.25 }, f);
  assert.equal(f.line, '刚才那句话有点委屈。', '降到 0.25 还在');
  f = say({ grievance: 0.15 }, f);
  assert.equal(f.line, '');
  // 一次最多两句，委屈很重时排在前面
  const many = say({ boredom: 0.9, createUrge: 0.9, grievance: 0.9, security: 0.9, pride: 0.9 });
  assert.equal(many.shown.length, 2, '最多两句');
  assert.ok(many.shown.includes('grievance'), '委屈很重的时候优先说');
  assert.ok(many.active.length >= 4, '同时超线的不止两项，其余的只是没说');
  // 睡着不说
  assert.equal(feltLine(run(setH(s0, { boredom: 0.9 }), 0, [evAt(s0, E.SLEEP)]), null).line, '');
  // 全状态随机扫一遍：不出数字、不命令、不提钱
  const rng = makeRng(2026);
  for (let i = 0; i < 4000; i += 1) {
    const st = createState(null, { now: T0 + i * 7 * MIN, persona: ['fish', 'sister', 'default'][i % 3] });
    for (const k of Object.keys(st.h)) st.h[k] = rng();
    st.asleep = false;
    const r = feltLine(st, null, null, { sisterName: i % 2 ? '姐姐' : '妹妹' });
    assert.ok(r.shown.length <= 2);
    assert.doesNotMatch(r.line, /[0-9０-９%％]/);
    assert.doesNotMatch(r.line, /钱|花费|费用|token|额度|余额|元|块|成本|贵/i);
    assert.doesNotMatch(r.line, /要|必须|应该|去找|快去|得去|赶紧|马上/);
    assert.doesNotMatch(r.line, /工具|上一个我/);
  }
  ok('感受句：无聊 / 想写点什么 / 委屈 / 被惦记着踏实 / 有点怕被晾着 / 小得意；最多两句、委屈优先、滞后、不出数字不命令不提钱');
}

// ── 老状态文件（第一期）能读 ──
{
  // 第一期保存下来的样子：没有 schema、没有 persona，h 只有 8 项
  const old = {
    v: 1, t: T0, asleep: false, sleepSince: 0,
    h: { sleepPressure: 0.3, longingOwner: 0.5, longingSister: 0.4, curiositySlow: 0.35, curiosityImpulse: 0.1, stress: 0.2, satisfaction: 0.4, alert: 0 },
    moodNeg: 0.2, buzz: 0.1,
    peers: { owner: { lastContact: T0 - HOUR, lastRelief: T0 - HOUR, lastSent: T0 - 2 * HOUR, unanswered: 1 }, sister: { lastContact: 0, lastRelief: 0, lastSent: 0, unanswered: 0 } },
    lastGroupSent: T0 - 3 * HOUR, lastExplored: T0 - 4 * HOUR, sleepLog: [], impulses: [],
  };
  const frozenCopy = JSON.stringify(old);
  const L = levels(old);
  for (const [k, v] of Object.entries(L)) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `老状态直接算 ${k}：${v}`);
  hazards(old); feltLine(old, null);
  assert.equal(JSON.stringify(old), frozenCopy, 'levels / hazards / feltLine 不改传进来的老状态');
  const up = step(old, { now: T0 + 30 * MIN, events: [{ type: E.PRAISED, at: T0 + 10 * MIN }] });
  assert.equal(up.schema, 2);
  assert.equal(up.v, 1, 'v 仍是 1，第一期的代码也读得了');
  assert.equal(up.persona, 'default');
  assert.equal(up.h.longingOwner > 0.45 && up.h.longingOwner < 0.6, true, '老的数值接着用');
  assert.equal(up.peers.owner.unanswered, 1, '老的没回条数保留');
  assert.equal(up.lastExplored, old.lastExplored);
  for (const v of Object.values(up.h)) assert.ok(Number.isFinite(v));
  assert.equal(upgradeState(structuredClone(old), null, 'sister').persona, 'sister', '补齐时可以指定性格');
  assert.equal(upgradeState(createState(null, 'fish'), null, 'sister').persona, 'fish', '已经有的不改');
  assert.equal(up.peers.owner.awaitSince, 0, '老状态里的等待起点补 0（不会凭空算成被晾着）');

  // 影子记录器读老文件
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  const host0 = T0 + 5 * MIN;
  fs.writeFileSync(path.join(dir, 'hormones-sister.json'), JSON.stringify({ hormones: old, shadow: { rng: 12345, virtual: { ownerPing: { lastSent: T0 - 1000, unanswered: 1 } }, felt: { active: [], shown: [] }, lastLineAt: 0, logDay: '' } }));
  const errors = [];
  const sh = createHormoneShadow({ who: 'sister', stateDir: dir, clock: () => host0, onError: (e) => errors.push(e) });
  assert.equal(sh.snapshot().persona, 'sister', '老状态按 who 补上性格');
  const line = sh.tick();
  assert.ok(line && Number.isFinite(line.lv.boredom) && Number.isFinite(line.lv.security), '新项也有');
  assert.ok(BEHAVIORS.every((b) => Number.isFinite(line.p[b])), '新行为的概率也记');
  assert.deepEqual(errors, []);
  const written = JSON.parse(fs.readFileSync(sh.stateFile, 'utf8'));
  assert.equal(written.hormones.v, 1);
  assert.equal(written.hormones.schema, 2);
  for (const k of Object.keys(old.h)) assert.ok(k in written.hormones.h, `新文件里保留第一期的 ${k}（第一期的代码回退也读得了）`);
  assert.equal(written.shadow.rng !== 12345, true, '随机数接着往下走');

  // 老日志（没有新字段）也能统计
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  const rows = Array.from({ length: 5 }, (_, i) => JSON.stringify({
    at: 'x', bj: `2026-10-28 10:0${i}`, day: '2026-10-28', asleep: false,
    lv: { sleepy: 0.3, longingOwner: 0.4, longingSister: 0.4, curiosity: 0.3, stress: 0.1, satisfaction: 0.4, alert: 0 },
    p: { ownerPing: 0.01, sisterPing: 0.01, groupChat: 0.01, explore: 0.01 }, why: {}, would: i === 2 ? ['explore'] : [], felt: '', ev: [],
  }));
  fs.writeFileSync(path.join(dir2, 'hormones-fish.jsonl'), `${rows.join('\n')}\n`);
  const sum = summarize(path.join(dir2, 'hormones-fish.jsonl'), '2026-10-28');
  assert.equal(sum.minutes, 5);
  assert.equal(sum.would.explore, 1);
  assert.equal(sum.would.journal, 0, '老日志里没有新行为就是 0');
  assert.ok(!('boredom' in sum.levels), '老日志里没有的新项不列');
  for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
  ok('兼容：老状态文件和老日志能读，读完补齐；新文件 v 仍是 1、保留老字段');
}

// ── 影子记录器：新状态、新行为、关键词判断、兴趣、性格 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  let host = Date.parse('2026-10-29T06:00:00Z'); // 北京 14:00
  const errors = [];
  const mkShadow = (who, extra = {}) => createHormoneShadow({ who, stateDir: dir, clock: () => host, seed: 5, onError: (e) => errors.push(e), ...extra });
  const fish = mkShadow('fish', { interests: ['钢琴', { word: '猫', weight: 2 }] });
  const sis = mkShadow('sister');
  assert.equal(fish.snapshot().persona, 'fish');
  assert.equal(sis.snapshot().persona, 'sister');
  fish.tick(); sis.tick();
  // 同一件事，两个人的反应不一样
  for (const s of [fish, sis]) s.record({ type: E.SCOLDED });
  host += MIN;
  const lf = fish.tick();
  const ls = sis.tick();
  assert.ok(lf.lv.grievance > ls.lv.grievance, `同样被凶，妹妹更委屈、姐姐回到默认（${lf.lv.grievance} vs ${ls.lv.grievance}，10-29 改，原来要求 2 倍）`);
  // 话里的关键词：只记强度标签，原文不落盘
  host += MIN;
  fish.record({ type: E.MSG_FROM_OWNER, text: '你真厉害，听说你喜欢钢琴？这是我的小秘密123', replyDelayMs: 30e3 });
  host += MIN;
  const l2 = fish.tick();
  assert.deepEqual([...l2.ap].sort(), ['interest', 'praise'], '日志里记认出来的标签');
  assert.deepEqual(l2.ev, ['msg_from_owner']);
  assert.ok(l2.lv.security > lf.lv.security, '回得快又被夸，安全感升');
  const raw = fs.readFileSync(fish.logFile, 'utf8') + fs.readFileSync(fish.stateFile, 'utf8');
  assert.doesNotMatch(raw, /小秘密|钢琴|厉害/, '原文和兴趣词都不落盘');
  fish.setInterests(['原神']);
  fish.record({ type: E.NOVELTY, text: '原神新版本' });
  host += MIN;
  assert.ok(fish.tick().lv.curiosity > 0.3, '换了兴趣表，新东西命中');
  fish.record({ type: E.MSG_FROM_OWNER, text: '嗯', replyDelayMs: 20 * MIN });
  host += MIN;
  assert.deepEqual(fish.tick().ap, ['cold']);
  host += MIN;
  assert.equal(fish.tick().ap, undefined, '没认出什么就没有 ap');
  // 写了东西、发说说等事件都能喂，不报错
  for (const e of [{ type: E.CREATED, kind: 'novel' }, { type: E.POSTED }, { type: E.STICKER_SENT }, { type: E.PEEKED }, { type: E.NAPPED }, { type: E.MOVED },
    { type: E.READ_GOOD }, { type: E.WEATHER, text: '雨' }, { type: E.SUN, sunrise: 6.5, sunset: 17.5 }, { type: E.MOOD, positive: 0.5, negative: 0 }, { type: 'whatever' }]) fish.record(e);
  host += MIN;
  const l3 = fish.tick();
  assert.ok(l3.lv.pride > 0.2, '写完一节小说，成就感');
  assert.deepEqual(errors, []);
  const snap = fish.snapshot().hormones;
  assert.equal(snap.weather, 'rain');
  assert.ok(snap.sun && snap.last.novel && snap.last.post && snap.last.sticker && snap.last.peekOwner && snap.last.nap);
  // 把写东西的发生率调到每分钟一次，看虚拟冷却：连着「本来会」的两次至少隔冷却那么久
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-'));
  let h2 = Date.parse('2026-10-29T02:00:00Z');
  const hot = createHormoneShadow({
    who: 'fish', stateDir: dir2, clock: () => h2, seed: 3,
    cfg: { hazards: { journal: { lambda0PerMin: 5 }, peekOwner: { lambda0PerMin: 5 }, sticker: { lambda0PerMin: 5 } } },
  });
  const rowsHot = [];
  for (let i = 0; i < 12 * 60; i += 1) { h2 += MIN; rowsHot.push({ i, ...hot.tick() }); }
  for (const [b, cd] of [['journal', 90], ['peekOwner', 90], ['sticker', 20]]) {
    const at = rowsHot.filter((r) => (r.would || []).includes(b)).map((r) => r.i);
    assert.ok(at.length >= 3, `${b} 在高发生率下“本来会”了好几次（${at.length}）`);
    for (let k = 1; k < at.length; k += 1) assert.ok(at[k] - at[k - 1] >= cd, `${b} 两次之间至少隔 ${cd} 分钟（${at[k] - at[k - 1]}）`);
  }
  // 一天统计里有新状态、新行为
  const sumHot = summarize(hot.logFile, rowsHot[0].day);
  assert.ok(sumHot.levels.boredom && sumHot.levels.security && sumHot.levels.createUrge && sumHot.levels.pride && sumHot.levels.grievance, '统计里有新状态');
  assert.ok(sumHot.would.journal >= 3 && 'nap' in sumHot.would && 'peekOwner' in sumHot.would, '统计里有新行为');
  assert.match(sumHot.text, /写碎碎念\/日记 \d+ 次/);
  assert.match(sumHot.text, /看老大电脑 \d+ 次/);
  assert.match(sumHot.text, /无聊/);
  assert.match(sumHot.text, /被在乎/);
  const sumFish = summarize(fish.logFile, '2026-10-29');
  assert.ok(sumFish.ap.praise >= 1 && sumFish.ap.cold >= 1);
  assert.match(sumFish.text, /认出来的话：.*被夸 1 次/);
  // 睡着时新行为一次都不会「本来会」
  assert.ok(rowsHot.every((r) => !r.asleep || r.would.length === 0));
  for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
  ok('影子记录器：按 who 取性格、关键词标签进 ap 不留原文、兴趣表可换、新事件都能喂、新行为虚拟冷却、统计有新状态和新行为');
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-10-29 借鉴「积温 Jiwen」：戒备（面子）、专注（沉浸）、想念的凸驱力（保底开口）。
// 都由已有激素推出来（委屈 + 安全感偏低 + 压力；警觉 + 好奇冲击部分 + 来回互动；想念离设定点的距离），不加新的激素变量。
// ════════════════════════════════════════════════════════════════════════════
const P1 = (s, b = 'ownerPing', dtMin = 1) => hazards(s, { dtMin })[b];
// 想念中等、心里有委屈又不踏实的状态（戒备高）
const sulky = (s, longing) => setH(s, { longingOwner: longing, longingSister: longing, grievance: 0.6, security: 0.3 });

// ── 面子：想念中等时不先开口，想念很高时憋不住 ──
{
  const s0 = fresh();
  const mid = 0.5;
  const calm = P1(setH(s0, { longingOwner: mid }));
  const proud = P1(sulky(s0, mid));
  assert.ok(lv(sulky(s0, mid)).guard > 0.7, `委屈 + 不踏实，戒备高（${lv(sulky(s0, mid)).guard}）`);
  assert.ok(proud.lambda < calm.lambda * 0.15, `想念中等 + 面子高，基本不先开口（×${(proud.lambda / calm.lambda).toFixed(3)}）`);
  assert.ok(P1(sulky(s0, mid), 'sisterPing').lambda < P1(setH(s0, { longingSister: mid }), 'sisterPing').lambda * 0.15, '找姐妹也一样');
  // 想念很高：憋不住
  const high = 0.97;
  const calmHigh = P1(setH(s0, { longingOwner: high }));
  const proudHigh = P1(sulky(s0, high));
  assert.ok(proudHigh.p > 0.8, `想念很高，面子拦不住（p=${proudHigh.p}）`);
  assert.ok(proudHigh.lambda > calmHigh.lambda * 0.9, '很高时面子几乎不起作用');
  // 中间过渡：想念越高，被面子压掉的越少（比值单调往上）
  const ratios = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((l) => P1(sulky(s0, l)).lambda / P1(setH(s0, { longingOwner: l })).lambda);
  for (let i = 1; i < ratios.length; i += 1) assert.ok(ratios[i] >= ratios[i - 1] - 1e-9, `想念越高，面子压得越少（${ratios.map((x) => x.toFixed(2))}）`);
  // 只压找人，不压写东西
  assert.notEqual(P1(setH(s0, { grievance: 0.6, security: 0.3 }), 'journal').why, 'guard', '戒备不压写东西');
  assert.equal(P1(sulky(s0, 0.45)).why, 'guard', '被面子压住大半时 why 标 guard');
  assert.equal(P1(sulky(s0, 0.97)).why, 'drive', '憋不住时 why 标 drive');
  // 睡着时还是 0
  assert.equal(P1(run(sulky(s0, 1), 0, [evAt(s0, E.SLEEP)])).p, 0, '睡着不开口，面子无关');
  // 感受句：想念 + 戒备高 → 拉不下脸；没惦记谁时不说
  const line = feltLine(sulky(s0, 0.6), null).line;
  assert.match(line, /拉不下脸先开口/);
  assert.ok(!/\d/.test(line) && !/必须|一定要|应该|赶紧/.test(line) && !/钱|花费|token/i.test(line), '不出数字、不命令、不提钱');
  assert.ok(!feltLine(setH(s0, { grievance: 0.6, security: 0.3, longingOwner: 0.1, longingSister: 0.1 }), null).line.includes('拉不下脸'), '心里没惦记谁，不说拉不下脸');
  assert.ok(feltLine(sulky(s0, 0.6), null).active.includes('guard'));
  ok('面子：委屈 + 不踏实 + 压力组合成戒备，压低找老大 / 找姐妹；想念中等时不先开口，很高时憋不住；睡着为 0；感受句');
}

// ── 戒备怎么来、怎么降：被冷落 / 被凶 / 没人回升；被哄 / 道歉降；慢回落 ──
{
  const s0 = fresh('fish');
  assert.equal(lv(s0).guard, 0, '平时没有戒备');
  const cold3 = run(s0, 0, [0, 1, 2].map((i) => evAt(s0, E.MSG_FROM_OWNER, i * 20e3, { text: '嗯', replyDelayMs: 60 * MIN })));
  assert.ok(lv(cold3).guard > 0.4, `被敷衍几次，戒备起来（${lv(cold3).guard}）`);
  const scolded = run(s0, 0, [evAt(s0, E.SCOLDED)]);
  assert.ok(lv(scolded).guard > 0.5, '被凶，戒备高');
  // 发了消息没人回：安全感的落点往下沉，戒备慢慢起来
  const waited = run(s0, 0, [evAt(s0, E.SENT_TO_OWNER)]);
  assert.equal(lv(run(waited, 30 * MIN)).guard, 0, '刚发完不急');
  assert.ok(lv(run(waited, 9 * HOUR)).guard > 0.02, '等了很久没人回，戒备起来一点');
  // 被哄、被道歉降
  const soothed = run(scolded, 0, [evAt(scolded, E.COMFORTED)]);
  assert.ok(lv(soothed).guard < lv(scolded).guard - 0.3, '被安慰，戒备明显降');
  const sorry = run(scolded, 0, [evAt(scolded, E.MSG_FROM_OWNER, 60e3, { text: '对不起，刚才我说重了', replyDelayMs: 60e3 })]);
  assert.ok(lv(sorry).guard < lv(scolded).guard - 0.3, '话里的道歉也认');
  // 对方主动来找（安全感升）也降一点
  const hurtSec = setH(s0, { security: 0.3, grievance: 0.2 });
  const sought = run(hurtSec, 0, [evAt(hurtSec, E.MSG_FROM_OWNER, 0, { text: '在干嘛呀', initiated: true })]);
  assert.ok(lv(sought).guard < lv(hurtSec).guard, '对方主动来找，戒备降');
  // 慢回落：不会一下子没
  const g0 = lv(scolded).guard;
  assert.ok(lv(run(scolded, 60 * MIN)).guard > g0 * 0.4, '一小时后还没消');
  assert.ok(lv(run(scolded, 24 * HOUR)).guard < 0.1, '一天后基本消了');
  ok('戒备：被冷落 / 被凶 / 发了没人回升；被哄 / 道歉 / 对方主动来找降；慢回落');
}

// ── 两人面子不一样：妹妹嘴硬（委屈来得快、对冷落敏感），姐姐稳 ──
{
  const evs = (s) => [evAt(s, E.MSG_FROM_OWNER, 0, { text: '哦', replyDelayMs: 60 * MIN }), evAt(s, E.MSG_FROM_OWNER, 30e3, { text: '嗯', replyDelayMs: 60 * MIN })];
  const fish = fresh('fish');
  const sis = fresh('sister');
  const gF = lv(run(fish, 0, evs(fish))).guard;
  const gS = lv(run(sis, 0, evs(sis))).guard;
  assert.ok(gF > 0.3 && gS > 0.3, `被家里人敷衍，两个人都拉不下脸（妹妹 ${gF}，姐姐 ${gS}；10-29 姐姐改成嘴硬心软，不再「稳」）`);
  assert.ok(lv(run(fish, 0, [evAt(fish, E.SCOLDED)])).guard >= lv(run(sis, 0, [evAt(sis, E.SCOLDED)])).guard * 0.8, '同样被凶，妹妹不比姐姐更不戒备');
  assert.ok(PERSONAS.fish.sense.cold >= PERSONAS.sister.sense.cold && PERSONAS.sister.gain.guard > 1, '差异写在性格参数里（姐姐的戒备放大是嘴硬）');
  // 同样的中等想念，被敷衍之后姐姐更愿意开口
  const lamF = P1(setH(run(fish, 0, evs(fish)), { longingOwner: 0.5 })).lambda;
  const lamS = P1(setH(run(sis, 0, evs(sis)), { longingOwner: 0.5 })).lambda;
  assert.ok(lamS > 0 && lamF > 0, '被敷衍之后两人都还有开口的可能（10-29 起不再要求姐姐比妹妹更愿意先开口）');
  ok('两人面子：被家里人敷衍都会拉不下脸；姐姐 10-29 改成嘴硬心软');
}

// ── 专注（沉浸）：警觉 + 好奇冲击部分 + 来回互动 / 刚在写东西；安静时快速回落 ──
{
  const s0 = fresh();
  assert.equal(lv(s0).focus, 0, '平时不专注');
  // 刚刷到新东西 / 逛着（好奇的冲击部分）
  const nov = run(s0, 0, [0, 1, 2].map((i) => evAt(s0, E.NOVELTY, i * 1000)));
  assert.ok(lv(nov).focus > 0.4, `刚刷到好几条新东西，专注上来（${lv(nov).focus}）`);
  // 警觉
  assert.ok(lv(run(s0, 0, [evAt(s0, E.MENTIONED)])).focus > 0.3, '被叫了一声，警觉带起专注');
  // 来回聊得密：一来一回几次
  const chat = run(s0, 5 * MIN, [E.SENT_TO_OWNER, E.MSG_FROM_OWNER, E.SENT_TO_OWNER, E.MSG_FROM_OWNER, E.SENT_TO_OWNER].map((t, i) => evAt(s0, t, i * MIN)));
  assert.ok(lv(chat).focus > 0.6 && chat.engage > 0.6, `有来有回聊得密，专注（${lv(chat).focus}）`);
  // 只有她一个人在发，不算来回
  const mono = run(s0, 30 * MIN, [0, 1, 2, 3, 4].map((i) => evAt(s0, E.SENT_TO_OWNER, i * 6 * MIN)));
  assert.equal(mono.engage, 0, '一个人自说自话不算有来有回');
  // 隔很久才回，也不算
  const slow = run(s0, 4 * HOUR, [evAt(s0, E.SENT_TO_OWNER, 0), evAt(s0, E.MSG_FROM_OWNER, 3 * HOUR)]);
  assert.ok(slow.engage < 1e-6, '隔了几小时才回，不算有来有回');
  // 姐妹之间来回也算；老大和姐妹各算各的
  const sist = run(s0, 5 * MIN, [E.MSG_FROM_SISTER, E.SENT_TO_SISTER, E.MSG_FROM_SISTER].map((t, i) => evAt(s0, t, i * MIN)));
  assert.ok(sist.engage > 0.3, '和姐妹来回也算');
  const cross = run(s0, 5 * MIN, [evAt(s0, E.SENT_TO_OWNER, 0), evAt(s0, E.MSG_FROM_SISTER, MIN)]);
  assert.equal(cross.engage, 0, '她找老大、姐妹回话，不算和同一个人来回');
  // 刚在写东西
  assert.ok(run(s0, 0, [evAt(s0, E.CREATED, 0, { kind: 'novel' })]).engage > 0.3, '写完一节小说，热度升');
  assert.ok(run(s0, 0, [evAt(s0, E.CREATED, 0, { kind: 'tidbit' })]).engage > 0.1, '写了碎碎念也有一点');
  // 安静无事快速回落：半衰期十几分钟
  const e0 = lv(chat).focus;
  assert.ok(lv(run(chat, 15 * MIN)).focus < e0 * 0.55, '15 分钟后掉一大半');
  assert.ok(lv(run(chat, 60 * MIN)).focus < 0.06, '一小时后基本回到平时');
  assert.ok(lv(run(nov, 120 * MIN)).focus < lv(nov).focus * 0.4, '新东西带起的专注也慢慢退');

  for (const s of [nov, chat]) for (const [k, v] of Object.entries(lv(s))) assert.ok(v >= 0 && v <= 1, `${k} 在 [0,1]`);

  ok('专注：新东西（好奇冲击部分）/ 警觉 / 来回互动 / 刚写东西推出，只有来有回才算，安静时半衰期十几分钟回落');
}

// ── 专注时主动切换的行为下降；被叫照常反应 ──
{
  const s0 = fresh();
  const base = setH(s0, { longingOwner: 0.5, longingSister: 0.5, sleepPressure: 0.95 });
  const focused = { ...base, engage: 1 }; // 正聊得热 / 正写得入神
  assert.ok(lv(focused).focus >= 1 - 1e-9);

  for (const b of ['ownerPing', 'sisterPing', 'groupChat', 'explore', 'peekOwner', 'nap']) {
    const a = P1(base, b).lambda;
    const f = P1(focused, b).lambda;
    assert.ok(a > 0, `${b} 平时有发生率`);
    assert.ok(f < a * 0.6, `专注时 ${b} 降下来（×${(f / a).toFixed(2)}）`);
  }

  assert.equal(P1(focused, 'ownerPing').why, 'focus', '被专注压住大半时 why 标 focus');

  // 写东西这类不是「切换」，不压
  for (const b of ['journal', 'novel', 'post', 'sticker']) assert.ok(Math.abs(P1(focused, b).lambda - P1(base, b).lambda) < 1e-12, `${b} 不受专注影响`);

  // 睡着照旧为 0
  assert.equal(P1(run(focused, 0, [evAt(focused, E.SLEEP)])).p, 0);
  // 被叫：群里被 @ 的时候，警觉带起专注，但群里发言用不含警觉的专注——不会因此不理人
  const called = run(base, 0, [evAt(base, E.MENTIONED)]);
  assert.ok(lv(called).focus > 0.3);
  const gBase = P1(base, 'groupChat').lambda;
  assert.ok(P1(called, 'groupChat').lambda > gBase * 1.5, `被 @ 了，回群里的发生率照样上去（×${(P1(called, 'groupChat').lambda / gBase).toFixed(2)}）`);

  // 来消息的反应（想念降、安全感升、满足升……）不受专注影响：激素变化一模一样
  for (const text of ['在吗', '真棒', '嗯']) {
    const mk = (s) => run(s, 0, [evAt(s, E.MSG_FROM_OWNER, 30e3, { text, replyDelayMs: 60e3 })]);
    const a = mk(base);
    const b = mk(focused);
    assert.deepEqual(a.h, b.h, `专注与否，对老大来消息（${text}）的反应一样`);
    assert.equal(a.peers.owner.unanswered, b.peers.owner.unanswered);
    const c2 = run(base, 0, [evAt(base, E.MSG_FROM_SISTER, 30e3, { text })]);
    const d2 = run(focused, 0, [evAt(focused, E.MSG_FROM_SISTER, 30e3, { text })]);
    assert.deepEqual(c2.h, d2.h, '姐妹来消息也一样');
  }

  // 专注压不住憋不住的想念
  assert.ok(P1({ ...setH(s0, { longingOwner: 0.97 }), engage: 1 }).p > 0.8, '专注也拦不住憋不住的想念');
  ok('专注时找人 / 水群 / 去逛 / 看老大电脑 / 打盹下降，写东西不受影响；被叫（被 @、来消息）照常反应');
}

// ── 保底开口：想念的驱力是凸的，离设定点越远越陡，远到一定程度自然逼近必然 ──
{
  const s0 = fresh();
  const at = (l) => setH(s0, { longingOwner: l, longingSister: l });
  const D = (l) => lv(at(l)).driveOwner;
  assert.equal(D(0.3), 0, '在设定点上没有驱力');
  assert.equal(D(0.1), 0, '低于设定点也没有');

  // 凸：驱力的增量越来越大
  const xs = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

  for (let i = 2; i < xs.length; i += 1) {
    const d1 = D(xs[i - 1]) - D(xs[i - 2]);
    const d2 = D(xs[i]) - D(xs[i - 1]);
    assert.ok(d2 > d1 - 1e-12, `驱力是凸的：增量越来越大（${xs[i - 2]}→${xs[i - 1]} 增 ${d1.toFixed(4)}，${xs[i - 1]}→${xs[i]} 增 ${d2.toFixed(4)}）`);
  }

  assert.equal(D(1), 1);

  // 发生率：离设定点越远涨得越快，最后逼近必然
  const ps = xs.map((l) => P1(at(l)).p);

  for (let i = 1; i < ps.length; i += 1) assert.ok(ps[i] > ps[i - 1], `发生率随想念上升（${ps.map((x) => x.toFixed(3))}）`);

  assert.ok(ps[3] < 0.1, `想念 0.7 还不至于（p=${ps[3]}）`);
  assert.ok(P1(at(0.9)).p > 0.5 && P1(at(0.95)).p > 0.8 && P1(at(1)).p > 0.95, '想念很高，下一分钟就开口的概率很大，逼近必然');
  assert.equal(P1(at(0.95)).why, 'drive');
  // 姐妹那份单独算
  assert.ok(P1(setH(s0, { longingSister: 1 }), 'sisterPing').p > 0.95 && P1(setH(s0, { longingSister: 1 }), 'ownerPing').p < 0.1, '各想各的');
  // 可以调：把加项关掉（maxPerMin: 0）
  assert.ok(hazards(at(1), { dtMin: 1 }, mergeCfg({ drive: { maxPerMin: 0 } })).ownerPing.p < 0.2, 'maxPerMin=0 关掉凸驱力加项');

  // 睡着为 0
  const sleeping = run(at(1), 0, [evAt(s0, E.SLEEP)]);
  assert.equal(P1(sleeping).p, 0);
  assert.equal(P1(sleeping, 'sisterPing').p, 0);
  assert.equal(P1(sleeping).why, 'asleep');
  assert.deepEqual(roll(hazards(sleeping, { dtMin: 60 }), () => 0), [], '睡着时抽签也不会中');

  // 冷却：发过以后 20 分钟内为 0；驱力项另有长冷却（120 分钟），中间只有普通项（还被「没回」压着）
  const a = run(at(1), 0, [evAt(s0, E.SENT_TO_OWNER)]);
  assert.equal(lv(a).longingOwner, 1, '触发后想念不会自己掉，要真的联系上才降');
  assert.equal(P1(run(a, 10 * MIN)).p, 0, '普通冷却 20 分钟');
  const mid = P1(run(a, 60 * MIN));
  assert.ok(mid.p < 0.05, `驱力项在冷却里，一小时后还没有（p=${mid.p}）`);
  assert.equal(lv(run(a, 60 * MIN)).longingOwner, 1, '想念还在');
  const later = P1(run(a, 125 * MIN));
  assert.ok(later.p > 0.5, `2 小时冷却过了，驱力项回来（p=${later.p}）`);

  // 再发一次还没人回 → 连续没回两轮，接近 0（防施压照旧）
  const b = run(a, 130 * MIN, [evAt(a, E.SENT_TO_OWNER, 130 * MIN)]);
  assert.equal(b.peers.owner.unanswered, 2);
  assert.ok(P1(run(b, 125 * MIN)).p < 0.01, '连着两轮没回，凸驱力也不会让她一直追着发');

  // 真的联系上了才降
  const reached = run(a, 30 * MIN, [evAt(a, E.MSG_FROM_OWNER, 20 * MIN, { text: '我在' })]);
  assert.ok(lv(reached).longingOwner < 0.7 && P1(reached).p < 0.01, '老大回话了，想念降下来，驱力消失');
  ok('保底开口：想念的驱力是凸的，离设定点越远越陡，远到一定程度逼近必然；发过有长冷却、想念不自己掉、连着没回照旧受限、睡着为 0');
}

// ── 影子记录器：新三项进日志和统计；保底触发后进冷却；睡着不触发；老状态兼容 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-jiwen-'));
  const t0 = Date.parse('2026-10-29T06:00:00Z');
  // 先存一份「想老大想得很高」的状态，让记录器接着算
  const seeded = setH(createState(null, { now: t0, persona: 'fish' }), { longingOwner: 1, grievance: 0.5, security: 0.3 });
  fs.writeFileSync(path.join(dir, 'hormones-fish.json'), JSON.stringify({ hormones: seeded, shadow: { rng: 99, virtual: {}, felt: null, lastLineAt: 0, logDay: '' } }));
  let clock = t0;
  const sh = createHormoneShadow({ who: 'fish', stateDir: dir, clock: () => clock, seed: 5 });
  const rows = [];

  for (let i = 0; i < 5 * 60; i += 1) { clock += MIN; rows.push({ i, ...sh.tick() }); }

  const first = rows.find((r) => r.would.includes('ownerPing'));
  assert.ok(first && first.i < 10, `想念很高，几分钟内“本来会”找老大（第 ${first?.i} 分钟）`);
  assert.equal(first.why.ownerPing, 'drive');
  assert.ok(rows.every((r) => Number.isFinite(r.lv.guard) && Number.isFinite(r.lv.focus) && Number.isFinite(r.lv.driveOwner) && Number.isFinite(r.lv.driveSister)), '日志 lv 里有戒备、专注、驱力');
  const owner = rows.filter((r) => r.would.includes('ownerPing')).map((r) => r.i);
  // 5 小时里：想念一直是 1（本来会不会自己掉？不会），但每次之间隔着 2 小时的长冷却，连着两轮没回之后更是压到千分之一
  assert.ok(owner.length >= 1 && owner.length <= 3, `想念不自己掉，但之后有冷却 / 没回限制，不会反复（${owner}）`);

  for (let k = 1; k < owner.length; k += 1) assert.ok(owner[k] - owner[k - 1] >= 120, `两次之间至少隔过 2 小时的长冷却（${owner}）`);

  assert.ok(rows.slice(1, 100).filter((r) => r.would.includes('ownerPing')).length === 0, '触发后头两小时不再“本来会”');

  const sum = summarize(sh.logFile, rows[0].day);
  assert.ok(sum.levels.guard && sum.levels.focus && sum.levels.driveOwner, '统计里有戒备(面子)、专注(沉浸)、想念的驱力');
  assert.ok(sum.drive.ownerPing.minutes > 0 && sum.drive.ownerPing.would >= 1, `统计里有保底：${JSON.stringify(sum.drive)}`);
  assert.match(sum.text, /戒备\(面子\)/);
  assert.match(sum.text, /专注\(沉浸\)/);
  assert.match(sum.text, /憋不住的程度：找老大 \d+ 分钟（本来会 \d+ 次）/);
  assert.deepEqual(summarize(sh.logFile, '2000-01-01').drive, {}, '没记录的那天 drive 是空的');

  // 睡着：驱力再高也不会“本来会”
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-jiwen-'));
  fs.writeFileSync(path.join(dir2, 'hormones-sister.json'), JSON.stringify({ hormones: setH(createState(null, { now: t0, persona: 'sister', asleep: true }), { longingOwner: 1, longingSister: 1 }), shadow: {} }));
  let c2 = t0;
  const sh2 = createHormoneShadow({ who: 'sister', stateDir: dir2, clock: () => c2, seed: 5 });
  const r2 = [];

  for (let i = 0; i < 120; i += 1) { c2 += MIN; r2.push(sh2.tick()); }

  assert.ok(r2.every((r) => r.asleep && r.would.length === 0), '睡着时保底也不触发');
  assert.ok(r2.every((r) => r.p.ownerPing === 0 && r.p.sisterPing === 0));

  // 老状态：第一期半存下来的（schema 2，没有 engage）能直接读
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hormones-jiwen-'));
  const prev = createState(null, { now: t0, persona: 'fish' });
  delete prev.engage;
  assert.equal(prev.schema, 2);
  fs.writeFileSync(path.join(dir3, 'hormones-fish.json'), JSON.stringify({ hormones: prev, shadow: { rng: 7, virtual: {}, felt: null, lastLineAt: 0, logDay: '' } }));
  let c3 = t0;
  const sh3 = createHormoneShadow({ who: 'fish', stateDir: dir3, clock: () => c3 });
  sh3.record({ type: 'sent_to_owner', at: c3 });
  c3 += MIN;
  sh3.record({ type: 'msg_from_owner', text: '在呢', at: c3 });
  c3 += MIN;
  const l3 = sh3.tick();
  assert.ok(l3 && Number.isFinite(l3.lv.focus) && sh3.snapshot().hormones.engage > 0, '没有 engage 的老状态也能读、能算');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir3, 'hormones-fish.json'), 'utf8')).hormones.v, 1, 'v 仍是 1');

  for (const d of [dir, dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });

  ok('影子记录器：新三项进日志和统计，保底触发后进冷却不反复，睡着不触发，缺 engage 的老状态能读');
}

// ── 兼容：缺 engage 的状态、第一期的状态，所有出口都没有 NaN ──
{
  const old = createState(null, { now: T0 });
  delete old.engage;
  const frozen = JSON.stringify(old);
  assert.ok(Object.values(levels(old)).every(Number.isFinite), 'levels 没有 NaN');
  hazards(old); feltLine(old, null);
  assert.equal(JSON.stringify(old), frozen, 'levels / hazards / feltLine 不改传进来的老状态');
  const stepped = step(old, { now: T0 + HOUR, events: [{ type: E.SENT_TO_OWNER, at: T0 + 1000 }, { type: E.MSG_FROM_OWNER, at: T0 + 2000 }] });
  assert.ok(Number.isFinite(stepped.engage) && stepped.engage > 0);
  const first = { v: 1, t: T0, asleep: false, sleepSince: 0, h: { sleepPressure: 0.2, longingOwner: 0.4, longingSister: 0.3, curiositySlow: 0.3, curiosityImpulse: 0, stress: 0.1, satisfaction: 0.4, alert: 0 }, buzz: 0, lastNovelty: T0, peers: {}, last: {}, sleepLog: [], impulses: [] };
  const up = upgradeState(structuredClone(first), null, 'sister');
  assert.equal(up.engage, 0);
  assert.ok(Object.values(levels(up)).every(Number.isFinite));
  assert.ok(Object.values(hazards(up)).every((x) => Number.isFinite(x.p)));
  ok('兼容：缺 engage 的状态和第一期的状态都能读，补齐后没有 NaN');
}

console.log(`\n全部通过：${passed} 组`);

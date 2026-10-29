// 心情（两个人共用一套格式和算法）。
//
// 2026-10-29 大脑方案第四批下半：小鲸鱼的心情来自插件 dsh-feiyu-mood 的 state.json，姐姐一直没有心情。
// 现在统一成同一份格式——{ mood, dims, lastReason, updatedAt, lastDecayAt, timeline[] }——
// 把原来散在 bridge.js（buildMoodLineV2）和 episodes.js（moodSnapshot）里的衰减口径收到这里：
//   · 心情基线 70，每 3 小时往基线回一半；
//   · 七种情绪（开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 / 吃醋），每 1.5 小时回一半。
// 小鲸鱼照旧读插件的状态文件（~/.dsh/feiyu-mood/state.json，只读）；
// 姐姐存在自己脑子的 最近/心情.json，她自己用 qq_mood 调心情、写理由，写盘是先写临时文件再改名（两人可能同时写）。
//
// 这里的数字只在程序里算，给她看的是一句话（心情一般 / 开心，带点担心），不出现分数。
//
// 2026-10-29 老大同意（施工单 C）：两人的心情都要做到「哪里发生的事都算、一个人一份」。
//   · 激素推动量：委屈、压力、被在乎、满足、成就感、想念这些激素（src/hormones.js）持续往心情里推一点点——
//     推动量存在单独的一个小文件里（小鲸鱼 state/mood-push-fish.json，姐姐 sister/state/mood-push-sister.json），
//     **不碰插件的 state.json**（插件在 DSH 进程里写它，会把我们写进去的覆盖掉）。读心情的人用 overlayMood 把两份叠起来：
//     叠加后的值仍是同一个格式，所以老的读法（decayMood / buildMoodLine / moodSnapshot……）不用改。
//   · 姐姐回话最后可以单独写一行「心情：……，因为……」，parseMoodLine 把它认成一次心情调整（写盘走 applyMoodChange）。
//   · 她自己写了心情（qq_mood、心情行）时，推动量先并进去再清零（createMoodStore.set），不会算两遍。
import fs from 'node:fs';
import path from 'node:path';

export const MOOD_BASE = 70;
export const MOOD_HALF_LIFE_H = 3;
export const DIM_HALF_LIFE_H = 1.5;
/** [英文键, 中文名]；顺序跟 dsh-feiyu-mood 一致。 */
export const MOOD_DIMS = Object.freeze([
  ['happy', '开心'], ['calm', '踏实'], ['sweet', '甜蜜'], ['heartache', '心疼'],
  ['worry', '担心'], ['sad', '难过'], ['jealous', '吃醋']
].map((x) => Object.freeze(x)));
/** 情绪起伏算「大」的阈值：心情分一次变动 ≥3，或者某种情绪一次变动 ≥4（实测时间线里 99% 的变动都在这之下）。 */
export const SWING_THRESHOLD = Object.freeze({ mood: 3, dim: 4 });
const TIMELINE_MAX = 400;

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 中文名或英文键 → 英文键；认不出返回 ''。 */
export function dimKey(name) {
  const s = String(name ?? '').trim();
  for (const [k, label] of MOOD_DIMS) if (s === k || s === label) return k;
  return '';
}

export function moodWord(v) {
  if (v >= 80) return '欢喜';
  if (v >= 62) return '开心';
  if (v >= 42) return '一般';
  if (v >= 25) return '心疼';
  return '难过';
}

/** 状态里「上次衰减到哪一刻」。 */
function lastAt(state, nowMs) {
  return num(state?.lastDecayAt) || num(state?.updatedAt) || num(state?.at) || nowMs;
}

/**
 * 按时间补算衰减后的心情和各种情绪（插件只在轮次结束时落盘，读到的可能是几小时前的快照，不补算会在「很高兴」上卡一整天）。
 * 返回 { mood（浮点）, dims: { happy: n … }, hours }。
 */
export function decayMood(state, nowMs = Date.now()) {
  const s = state && typeof state === 'object' ? state : {};
  const hours = Math.max(0, (nowMs - lastAt(s, nowMs)) / 3600000);
  const m0 = s.mood === undefined || s.mood === null || s.mood === '' ? MOOD_BASE : num(s.mood, MOOD_BASE);
  const mood = MOOD_BASE + (m0 - MOOD_BASE) * 0.5 ** (hours / MOOD_HALF_LIFE_H);
  const dims = {};
  for (const [k] of MOOD_DIMS) dims[k] = num(s.dims?.[k]) * 0.5 ** (hours / DIM_HALF_LIFE_H);
  return { mood, dims, hours };
}

/**
 * 压成 { v, top }：v 是心情分（整数），top 是最强的两种情绪（≥5 才算）的中文名，用「、」连起来。
 * 跟 episodes.js 原来的 moodSnapshot 一个口径（瞬间里存的心情读数就是它）。
 */
export function moodSnapshot(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return null;
  if (!Number.isFinite(Number(state.mood))) return null;
  const d = decayMood(state, nowMs);
  const top = MOOD_DIMS
    .map(([k, label]) => [label, d.dims[k]])
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label]) => label)
    .join('、');
  return { v: Math.round(d.mood), top };
}

/**
 * 这一刻前后心情的起伏有多大：看时间线里 [at - beforeMs, at + afterMs] 的几行，取最大的 |delta| 和最大的 |某种情绪的变动|。
 * 返回 { d, dd }（都是非负整数；没有时间线就是 0）。
 */
export function moodSwingNear(state, atMs = Date.now(), { beforeMs = 5 * 60e3, afterMs = 10 * 60e3 } = {}) {
  const rows = (Array.isArray(state?.timeline) ? state.timeline : []).filter((r) => r && Number.isFinite(Number(r.at)) && r.at >= atMs - beforeMs && r.at <= atMs + afterMs);
  return rowsSwing(rows);
}

export function rowsSwing(rows) {
  let d = 0;
  let dd = 0;
  for (const r of rows) {
    d = Math.max(d, Math.abs(num(r.delta)));
    for (const v of Object.values(r.dimsDelta && typeof r.dimsDelta === 'object' ? r.dimsDelta : {})) dd = Math.max(dd, Math.abs(num(v)));
  }
  return { d: Math.round(d), dd: Math.round(dd) };
}

/**
 * 存进瞬间的心情读数：{ v, top } 再加上这一刻前后心情的起伏（d = 心情分最大变动，dd = 某种情绪最大变动，有才带）。
 * 瞬间里带着 d / dd，压着.json 才知道哪些是「情绪起伏大」的（见 episodes.js markPressed）。
 */
export function moodWithSwing(state, nowMs = Date.now(), at = nowMs) {
  const snap = moodSnapshot(state, nowMs);
  if (!snap) return null;
  const sw = moodSwingNear(state, at);
  return { ...snap, ...(sw.d ? { d: sw.d } : {}), ...(sw.dd ? { dd: sw.dd } : {}) };
}

/** 一个瞬间的心情读数（{ v, top, d?, dd? }）算不算「情绪起伏大」。 */
export function isHeavySwing(mood, threshold = SWING_THRESHOLD) {
  if (!mood || typeof mood !== 'object') return false;
  return Math.abs(num(mood.d)) >= threshold.mood || Math.abs(num(mood.dd)) >= threshold.dim;
}

/**
 * 给她看的那一行心情（老 buildMoodLineV2 的内容原样搬来）：贴着基线、没有情绪、也没有理由时返回 ''（省 token）。
 * minDim：某种情绪要多强才提（默认 15）。
 */
export function buildMoodLine(state, nowMs = Date.now(), { minDim = 15 } = {}) {
  if (!state || typeof state !== 'object') return '';
  const d = decayMood(state, nowMs);
  const top = MOOD_DIMS.filter(([k]) => d.dims[k] >= minDim).sort((a, b) => d.dims[b[0]] - d.dims[a[0]]).slice(0, 2);
  if (!state.lastReason && !top.length && Math.abs(d.mood - MOOD_BASE) < 5) return '';
  // 心情值和情绪词可能撞车（30 分叫「心疼」，情绪里也有「心疼」），去个重。
  const word = moodWord(d.mood);
  const parts = top.map(([, label]) => label).filter((label) => label !== word);
  const text = `（此刻你）心情${word}` + (parts.length ? `，${parts.join('、')}` : '') + '。用这个心情定你这一轮的口气，别把这句话照念出来。';
  return `【心情】${text}\n\n`;
}

/**
 * 交接里「那会儿的心情和原因」：心情词 + 情绪 + 她自己（或插件）写的最后一条理由。没有任何读数返回 ''。
 * 不出现分数。
 */
export function moodHandoffText(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return '';
  const d = decayMood(state, nowMs);
  const top = MOOD_DIMS.filter(([k]) => d.dims[k] >= 8).sort((a, b) => d.dims[b[0]] - d.dims[a[0]]).slice(0, 2).map(([, label]) => label);
  const reason = String(state.lastReason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!reason && !top.length && Math.abs(d.mood - MOOD_BASE) < 5) return '';
  const word = moodWord(d.mood);
  const parts = top.filter((l) => l !== word);
  return `心情${word}${parts.length ? `，${parts.join('、')}` : ''}${reason ? `。原因：${reason}` : ''}`;
}

// ── 激素推动量（2026-10-29 施工单 C）──────────────────────────────────────────

/**
 * 每种激素偏离自己的基线 1.0（满格）时，每小时往心情 / 各种情绪里推多少。
 * 都是很小的数：激素是背景，真正的起伏靠插件 / 她自己判；推动量也会像心情一样自己回落（心情 3 小时半衰期，情绪 1.5 小时）。
 * 稳态大致是 速率 × 4.3 小时（心情）/ 2.2 小时（情绪），所以满格委屈挂着不放，大约把「难过」推到十八九分、心情压下十几分（上限 PUSH_CAP）；
 * 正面的推得比负面的轻一点（满足、被在乎本来就常常偏高，不该让她一直「欢喜」）。
 * base：激素在这条线以下不推；level(levels)：从 levels() 的读数里取这个激素的水平。
 */
export const PUSH_RULES = Object.freeze([
  { key: 'grievance', label: '委屈', base: 0, mood: -5, dims: { sad: 8.5, heartache: 5 }, level: (l) => l.grievance },
  { key: 'stress', label: '压力', base: 0.1, mood: -3.4, dims: { worry: 7 }, level: (l) => l.stress },
  { key: 'security', label: '被在乎', base: 0.6, mood: 1.8, dims: { sweet: 4.5, calm: 3 }, level: (l) => l.security },
  { key: 'satisfaction', label: '满足', base: 0.65, mood: 2.4, dims: { happy: 4.5, calm: 2.5 }, level: (l) => l.satisfaction },
  { key: 'pride', label: '成就感', base: 0.2, mood: 2, dims: { happy: 4 }, level: (l) => l.pride },
  { key: 'longing', label: '想念', base: 0.5, mood: -0.8, dims: { heartache: 3.4 }, level: (l) => Math.max(num(l.longingOwner), num(l.longingSister)) }
]);
/** 推动量的上限：心情最多 ±15 分，某种情绪最多 35 分（再大也是别的东西的事了）。 */
export const PUSH_CAP = Object.freeze({ mood: 15, dim: 35 });
/** 两次推动之间隔得再久（程序没开、睡过去），也只按这么久算——不能一觉醒来一次性推一大截。 */
export const PUSH_MAX_DT_MIN = 20;

/** 推动量文件的路径（stateDir 是 state/ 目录；who 是 fish / sister）。 */
export const moodPushFile = (stateDir, who) => path.join(stateDir, `mood-push-${who}.json`);

export function emptyPush(at = 0) {
  return { v: 1, at, mood: 0, dims: Object.fromEntries(MOOD_DIMS.map(([k]) => [k, 0])), driver: '', driverAt: 0 };
}

function cleanPush(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dims = {};
  for (const [k] of MOOD_DIMS) dims[k] = num(raw.dims?.[k]);
  return { v: 1, at: num(raw.at), mood: num(raw.mood), dims, driver: String(raw.driver || ''), driverAt: num(raw.driverAt) };
}

/** 推动量也按时间回落（口径跟心情一样）。返回新对象；没有推动量返回 null。 */
export function decayPush(push, nowMs = Date.now()) {
  const p = cleanPush(push);
  if (!p) return null;
  const hours = Math.max(0, (nowMs - p.at) / 3600000);
  const dims = {};
  for (const [k] of MOOD_DIMS) dims[k] = p.dims[k] * 0.5 ** (hours / DIM_HALF_LIFE_H);
  return { ...p, at: nowMs, mood: p.mood * 0.5 ** (hours / MOOD_HALF_LIFE_H), dims };
}

/** 激素水平（levels() 的返回）→ 每小时往心情推多少：{ mood, dims, driver（推得最多的那个激素的中文名，没有就 ''）}。 */
export function pullFromLevels(levels) {
  const l = levels && typeof levels === 'object' ? levels : {};
  const dims = Object.fromEntries(MOOD_DIMS.map(([k]) => [k, 0]));
  let mood = 0;
  let best = { w: 0, label: '' };
  for (const r of PUSH_RULES) {
    const lv = num(r.level(l), NaN);
    if (!Number.isFinite(lv)) continue;
    const x = clamp((lv - r.base) / (1 - r.base), 0, 1);
    if (x <= 0) continue;
    mood += r.mood * x;
    let w = Math.abs(r.mood) * x;
    for (const [k, v] of Object.entries(r.dims)) { dims[k] += v * x; w += v * x * 0.5; }
    if (w > best.w) best = { w, label: r.label };
  }
  return { mood, dims, driver: best.label };
}

/**
 * 往前推一步：先把旧的推动量回落到此刻，再按这段时间（最多 PUSH_MAX_DT_MIN 分钟）加上激素的推动。
 * levels 为 null（激素没开 / 睡着）时只回落、不加。返回新的推动量（不写盘）。
 */
export function advancePush(push, levels, nowMs = Date.now()) {
  const old = decayPush(push, nowMs) || emptyPush(nowMs);
  const last = cleanPush(push)?.at || 0;
  const dtH = last ? Math.min(PUSH_MAX_DT_MIN, Math.max(0, (nowMs - last) / 60000)) / 60 : 0;
  const next = { ...old, at: nowMs };
  if (levels && dtH > 0) {
    const pull = pullFromLevels(levels);
    next.mood = clamp(old.mood + pull.mood * dtH, -PUSH_CAP.mood, PUSH_CAP.mood);
    next.dims = Object.fromEntries(MOOD_DIMS.map(([k]) => [k, clamp(old.dims[k] + pull.dims[k] * dtH, 0, PUSH_CAP.dim)]));
    if (pull.driver) { next.driver = pull.driver; next.driverAt = nowMs; }
  }
  return next;
}

/**
 * 把插件 / 她自己写的心情 state 和激素推动量叠成一份（同一个格式）。两边都没有东西返回 state 原样（可能是 null）。
 * 叠出来的 mood / dims 已经回落到 nowMs，lastDecayAt = nowMs，所以再 decayMood 一次不会算两遍。
 * lastReason：state 自己有就用它；没有而推动量有个明显的来源，就写一句「委屈慢慢积在心里」这样的话（不带数字）。
 */
export function overlayMood(state, push, nowMs = Date.now()) {
  const p = decayPush(push, nowMs);
  const quiet = !p || (Math.abs(p.mood) < 0.3 && MOOD_DIMS.every(([k]) => p.dims[k] < 0.3));
  if (quiet) return state && typeof state === 'object' ? state : null;
  const s = state && typeof state === 'object' ? state : {};
  const d = decayMood(s, nowMs);
  const dims = {};
  for (const [k] of MOOD_DIMS) dims[k] = Math.round(clamp(d.dims[k] + p.dims[k], 0, 100) * 10) / 10;
  const reason = s.lastReason || (p.driver ? `${p.driver}这件事一直在心里，慢慢影响了心情` : '');
  return {
    ...s,
    mood: Math.round(clamp(d.mood + p.mood, 0, 100) * 10) / 10,
    dims,
    lastReason: reason,
    updatedAt: num(s.updatedAt) || nowMs,
    lastDecayAt: nowMs,
    pushed: true
  };
}

export function readPush(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return cleanPush(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  } catch { return null; }
}

export function writePush(file, push) {
  const p = cleanPush(push) || emptyPush(Date.now());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读心情文件 + 推动量文件，叠好返回（小鲸鱼桥接里读插件的 state.json 用这个）。 */
export function readMoodWithPush(moodFile, pushFile, nowMs = Date.now()) {
  return overlayMood(readMoodFile(moodFile), pushFile ? readPush(pushFile) : null, nowMs);
}

// ── 姐姐回话里的「心情：……，因为……」一行 ─────────────────────────────────────
//
// 她想写就写（唤醒提示里只是说「可以」）：这一行不发出去，读到后记成一次心情调整。
// 认法很朴素（关键词，不调模型）：
//   · 情绪词 → 对应的情绪加几分：「有点 / 一点 / 稍微」3 分，不加修饰 6 分，「很 / 特别 / 非常 / 超」12 分；
//   · 前面有「不 / 没」的：正面的词当成难过 +4，负面的词当成减 4（「不难过了」）；
//   · 「一般 / 还好 / 平常」且没有别的情绪词：心情往平常（70）回一半；
//   · 「因为」后面是理由；没写「因为」、整句又够长，整句当理由。
//   · 一个词也认不出：只记理由，心情分不动。
const MOOD_WORDS = Object.freeze({
  happy: ['开心', '高兴', '欢喜', '快乐', '雀跃', '兴奋', '得意', '满足', '美滋滋', '心情好', '心情很好', '喜欢', '惊喜', '好玩', '有趣'],
  calm: ['踏实', '安心', '放松', '平静', '安稳', '舒服', '松了口气', '松口气', '笃定'],
  sweet: ['甜', '甜蜜', '幸福', '暖', '温暖', '被宠', '被在乎', '心软', '软软'],
  heartache: ['心疼', '舍不得', '心酸', '揪心', '怜惜'],
  worry: ['担心', '紧张', '焦虑', '不安', '害怕', '慌', '忐忑', '发愁', '犯愁', '怕'],
  sad: ['难过', '伤心', '低落', '失落', '沮丧', '委屈', '难受', '郁闷', '烦', '烦躁', '憋屈', '生气', '孤单', '寂寞'],
  jealous: ['吃醋', '酸溜溜', '醋', '嫉妒']
});
const MODIFIER_WEAK = /(有点|有些|一点|稍微|略微|略|微微|淡淡|还有点|多少有点)$/;
const MODIFIER_STRONG = /(很|特别|非常|超级|超|极其|极|太|好|真的很|满满|十分|格外|真)$/;
const NEGATION = /(不|没有|没|并不|不太|不怎么)$/;
const FLAT_WORDS = /(一般|还好|还行|平常|平平|普通|没什么特别|没什么|正常|无波无澜)/;
const POSITIVE_DIMS = new Set(['happy', 'calm', 'sweet']);

export function parseMoodLine(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const cut = raw.search(/(?:是)?因为|由于/);
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  let reason = cut >= 0 ? raw.slice(cut).replace(/^(?:是)?(?:因为|由于)[，,:：\s]*/, '') : (raw.length > 8 ? raw : '');
  reason = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  const dims = {};
  const matched = [];
  const hits = [];
  for (const [k, words] of Object.entries(MOOD_WORDS)) {
    for (const w of words) {
      let from = 0;
      for (;;) {
        const i = head.indexOf(w, from);
        if (i < 0) break;
        hits.push({ k, w, i, end: i + w.length });
        from = i + w.length;
      }
    }
  }
  // 重叠的取最长（「心情很好」里的「好」别再算一次；「烦躁」里的「烦」）
  hits.sort((a, b) => a.i - b.i || (b.end - b.i) - (a.end - a.i));
  const used = [];
  for (const h of hits) {
    if (used.some((u) => h.i < u.end && h.end > u.i)) continue;
    used.push(h);
    const before = head.slice(Math.max(0, h.i - 4), h.i);
    const negated = NEGATION.test(before);
    const lead = before.replace(NEGATION, '');
    let amount = 6;
    if (MODIFIER_WEAK.test(lead)) amount = 3;
    else if (MODIFIER_STRONG.test(lead)) amount = 12;
    let key = h.k;
    if (negated) {
      // 「不开心」当成有点难过，「不难过了」当成难过减一点
      amount = Math.max(3, Math.min(8, Math.round(amount * 0.7)));
      if (POSITIVE_DIMS.has(key)) key = 'sad'; else amount = -amount;
    }
    dims[key] = (dims[key] || 0) + amount;
    matched.push(h.w);
  }
  let pos = 0; let neg = 0;
  for (const [k, v] of Object.entries(dims)) { if (POSITIVE_DIMS.has(k)) pos += v; else neg += v; }
  const delta = matched.length ? clamp(Math.round(0.8 * pos - 1.0 * neg), -20, 20) : 0;
  const toBaseline = matched.length === 0 && FLAT_WORDS.test(head);
  return { dims, delta, toBaseline, reason: reason || (matched.length ? '' : head.trim().slice(0, 200)), matched, raw: raw.slice(0, 300) };
}

/** 一行心情 → 新的心情 state（不写盘）。state 是现在的（叠好的）心情；认不出任何东西也会记一笔理由。 */
export function applyMoodLine(state, spec, nowMs = Date.now()) {
  const p = typeof spec === 'string' ? parseMoodLine(spec) : spec;
  if (!p) return null;
  const change = { dims: p.dims, reason: p.reason };
  if (p.toBaseline) {
    const cur = Math.round(decayMood(state, nowMs).mood);
    change.mood = Math.round(cur + (MOOD_BASE - cur) * 0.5);
  } else if (p.delta) change.delta = p.delta;
  return applyMoodChange(state, change, nowMs);
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

export function readMoodFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return s && typeof s === 'object' ? s : null;
  } catch { return null; }
}

/** 先写临时文件再改名：两人可能同时写，读的人不会读到写到一半的。 */
export function writeMoodFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 她自己调心情：返回新状态（不写盘）。change：
 *   mood   直接定成多少分（0–100）；或 delta 加减几分（跟 mood 二选一，mood 优先）；
 *   dims   { 开心: 3, 担心: -2 } 各种情绪加减几分（中文名或英文键都行）；
 *   reason 为什么这样（她自己的话，≤200 字）。
 * 先按时间把旧的衰减到此刻，再改；单次变动都限在 ±25 以内。
 */
export function applyMoodChange(state, change = {}, nowMs = Date.now()) {
  const cur = decayMood(state, nowMs);
  const prevMood = Math.round(cur.mood);
  let mood = prevMood;
  if (change.mood !== undefined && change.mood !== null && Number.isFinite(Number(change.mood))) mood = clamp(Math.round(num(change.mood)), prevMood - 25, prevMood + 25);
  else if (change.delta !== undefined && change.delta !== null) mood = prevMood + clamp(Math.round(num(change.delta)), -25, 25);
  mood = clamp(mood, 0, 100);
  const dims = {};
  const dimsDelta = {};
  const wanted = change.dims && typeof change.dims === 'object' ? change.dims : {};
  for (const [k] of MOOD_DIMS) {
    const before = Math.round(cur.dims[k]);
    dims[k] = before;
    dimsDelta[k] = 0;
  }
  for (const [name, v] of Object.entries(wanted)) {
    const k = dimKey(name);
    if (!k) continue;
    const dv = clamp(Math.round(num(v)), -25, 25);
    const after = clamp(dims[k] + dv, 0, 100);
    dimsDelta[k] = after - dims[k];
    dims[k] = after;
  }
  const reason = String(change.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const old = state && typeof state === 'object' ? state : {};
  const row = { at: nowMs, mood, delta: mood - prevMood, reason, dims: { ...dims }, dimsDelta };
  const timeline = [...(Array.isArray(old.timeline) ? old.timeline : []), row].slice(-TIMELINE_MAX);
  return { mood, dims, lastReason: reason || old.lastReason || '', updatedAt: nowMs, lastDecayAt: nowMs, timeline };
}

/**
 * 一个人的心情仓库（姐姐用：file = 她脑子的 最近/心情.json；小鲸鱼只读插件的文件，不走 set）。
 * now 可以注入（测试用）。
 * 2026-10-29 施工单 C：pushFile（可选）= 激素推动量文件。给了就把推动量叠在上面读（read / snapshot / line / handoff / describe 都是叠好的），
 * readRaw 只读她自己写的那份（激素喂心情时用——叠好的再喂回激素会绕圈）。set / setFromLine 写盘前先把推动量并进去，写完清零。
 */
export function createMoodStore({ file, pushFile = '', now = () => Date.now() } = {}) {
  if (!file) throw new Error('createMoodStore 需要 file');
  const readRaw = () => readMoodFile(file);
  const read = () => overlayMood(readRaw(), pushFile ? readPush(pushFile) : null, now());
  const commit = (next) => {
    writeMoodFile(file, next);
    if (pushFile) { try { writePush(pushFile, emptyPush(now())); } catch { /* 清不掉就让它自己回落 */ } }
    return next;
  };
  return {
    file,
    pushFile,
    read,
    readRaw,
    snapshot: () => moodSnapshot(read(), now()),
    line: (opts) => buildMoodLine(read(), now(), opts),
    handoff: () => moodHandoffText(read(), now()),
    /** 她调心情：写盘（先写临时文件再改名），返回新状态。 */
    set(change) {
      return commit(applyMoodChange(read(), change, now()));
    },
    /** 回话里的「心情：……，因为……」那一行 → 记一笔；一个字都没有返回 null。 */
    setFromLine(spec) {
      const next = applyMoodLine(read(), spec, now());
      return next ? commit(next) : null;
    },
    /** 她现在的样子，给 qq_mood 的 read 用：心情词、最强的情绪、最后一条理由。 */
    describe() {
      const s = read();
      if (!s) return '你还没有记过心情（用 qq_mood 写一笔就有了）。';
      const t = moodHandoffText(s, now());
      return t || `心情${moodWord(decayMood(s, now()).mood)}，没什么特别的情绪。`;
    }
  };
}

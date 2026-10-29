// 激素影子记录的「接线」小工具（小鲸鱼的 bridge.js 和姐姐的 sister.mjs 共用）。
//
// 2026-10-29 第五批第 4 项（老大同意先只记录不触发）：
// hormone-shadow.js 是记录器本体，这里只管三件事——
//   1. 把「发生了什么」翻成记录器认得的事件（收到谁的消息、她发出去了、工具出错、写了东西……），两人用同一套口径；
//   2. 把心情、天气、日出日落、兴趣词表换算成记录器要的样子；
//   3. 包一层安全壳：开关关了就什么都不做；任何出错都吞掉，绝不影响她正常说话。
// 不调模型、不联网、不触发任何行为；消息原文只在记录器里过一遍关键词（appraise），不落盘。
//
// 接口都是纯函数（除了 createHormoneFeed 和读文件的几个），方便测试。

import fs from 'node:fs';
import { createHormoneShadow } from './hormone-shadow.js';
import { interestsFromPersona } from './hormones.js';
import { advancePush, decayMood, readPush, writePush } from './mood.js';

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(+x) ? +x : 0));
const HOUR = 3600e3;

// ── 安全壳 ──────────────────────────────────────────────────────────────────

/**
 * 一个人的影子记录接线。enabled=false（config 的 hormones.enabled）时 record / tick 全是空操作。
 * createShadow 可以注入（测试）。出任何错都走 onError，不抛。
 */
export function createHormoneFeed({
  who, stateDir, skewMs = () => 0, asleep = false, enabled = true, interests = [], sisterName, onError = () => {},
  createShadow = createHormoneShadow, clock, sleepHistory = [],
} = {}) {
  let shadow = null;
  let curInterests = interests;
  const recent = new Map(); // 同一种出错事件几秒内只记一次

  const build = (asleepNow) => {
    try {
      shadow = createShadow({
        who, stateDir, skewMs, asleep: asleepNow, interests: curInterests, sisterName, sleepHistory, onError, ...(clock ? { clock } : {}),
      });
    } catch (error) { onError(error); shadow = null; }
  };

  if (enabled !== false) build(asleep);

  return {
    who,
    get enabled() { return shadow !== null; },
    get shadow() { return shadow; },
    /**
     * 2026-10-29 老大（网页上的一键开关）：不重启就能开 / 关影子记录。
     * 关：把记录器扔掉，之后 record / tick / snapshot 都是空操作（已经写下的记录留着）；
     * 开：重新建一个记录器（接着读它自己存的状态）。asleepNow 给睡着与否，开的时候用。
     */
    setEnabled(on, { asleepNow = false } = {}) {
      try {
        if (on && !shadow) build(asleepNow);
        else if (!on) shadow = null;
      } catch (error) { onError(error); }
      return shadow !== null;
    },
    /** 喂一个事件。绝不抛。 */
    record(event) {
      try {
        if (!shadow || !event?.type) return;

        if (event.type === 'send_fail' || event.type === 'tool_fail') { // 同一次出错常常会打好几条日志
          const now = Date.now();
          const last = recent.get(event.type) || 0;

          if (now - last < 3000) return;

          recent.set(event.type, now);
        }

        shadow.record(event);
      } catch (error) { onError(error); }
    },
    /** 每分钟调一次。 */
    tick() {
      try { return shadow ? shadow.tick() : null; } catch (error) { onError(error); return null; }
    },
    setInterests(list) {
      try { if (Array.isArray(list)) curInterests = list; shadow?.setInterests(list); } catch (error) { onError(error); }
    },
    snapshot() {
      try { return shadow ? shadow.snapshot() : null; } catch (error) { onError(error); return null; }
    },
  };
}

// ── 收到消息 ─────────────────────────────────────────────────────────────────

/**
 * 收到一条消息 → 事件。
 * - where：'private' | 'group'
 * - isOwner：发消息的是老大；isSister：是姐妹（私聊，或者小房子里）——别的群里姐妹说话按群消息算
 * - atMe：被 @ 或被引用；nameMention：消息里叫了她的名字
 * 规则：老大私聊 → msg_from_owner；姐妹 → msg_from_sister；其余（群消息、陌生人私聊、老大在群里说话）→ group_msg，
 * 冲她来的（@ / 叫名字 / 陌生人私聊）带 toMe，并多记一条 mentioned（陌生人私聊不记 mentioned）。
 */
export function incomingHormoneEvents({ where = 'group', isOwner = false, isSister = false, atMe = false, nameMention = false, text = '', novelty } = {}) {
  const t = String(text ?? '');

  if (where === 'private' && isOwner) return [{ type: 'msg_from_owner', text: t }];
  if (isSister) return [{ type: 'msg_from_sister', text: t }];

  const directed = Boolean(atMe || nameMention);
  const ev = { type: 'group_msg', toMe: where === 'private' ? true : directed, text: t };

  if (Number.isFinite(+novelty)) ev.novelty = clamp01(novelty);

  return directed && where === 'group' ? [ev, { type: 'mentioned' }] : [ev];
}

/** 她发出去一条（文字、语音、表情、图片都算）→ 事件。target：'owner' | 'sister' | 'group' | 'other'（其他私聊不记）。 */
export function sentHormoneEvent(target) {
  if (target === 'owner') return { type: 'sent_to_owner' };
  if (target === 'sister') return { type: 'sent_to_sister' };
  if (target === 'group') return { type: 'sent_group' };

  return null;
}

/**
 * 群消息的「新鲜度」估计（0.1～1）：这句话里的两字组合有多少是最近几句里没出现过的。
 * 很短的（<3 个字组合）算「老一套」0.15；这个会话里还没有前文就给 0.6。每个会话各记最近 maxRecent 句。
 */
export function createNoveltyTracker({ maxRecent = 8 } = {}) {
  const recent = new Map();
  const grams = (text) => {
    const s = String(text ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
    const out = new Set();

    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));

    return out;
  };

  return {
    /** 给这句话打分，并把它记进这个会话的最近几句。 */
    score(key, text) {
      const g = grams(text);
      const prev = recent.get(key) || [];
      let value;

      if (g.size < 3) value = 0.15;
      else if (prev.length === 0) value = 0.6;
      else {
        const seen = new Set(prev.flatMap((x) => [...x]));
        let hit = 0;

        for (const x of g) if (seen.has(x)) hit += 1;

        value = Math.min(1, Math.max(0.1, 1 - hit / g.size));
      }

      recent.set(key, [...prev, g].slice(-maxRecent));

      return Math.round(value * 100) / 100;
    },
  };
}

// ── 工具用过了 → 事件 ──────────────────────────────────────────────────────

const base = (name) => String(name ?? '').split('__').pop();
const pathOf = (input) => String(input?.file_path ?? input?.path ?? input?.filePath ?? '').replace(/\\/g, '/');

/**
 * 一次工具调用 → 事件列表。ok=false（工具出错）只记 tool_fail。
 * name：工具名（小鲸鱼是 DSH 的名字，姐姐是 mcp__sister-qq__xxx；都只看最后一段）；input：参数（可以没有）。
 * 认得的：
 *   rambling_append → created tidbit；qq_growth_note → created diary；novel_section_done → created novel；
 *   qq_post_qzone / qq_qzone_post → posted；pc_screenshot / pc_activity → peeked；
 *   qq_explore：点开了几条就记几次 novelty（带标题时 text），记感想（note）算一轮逛完 explored，
 *     note.kind = write 算 created work，deep 算 created diary；
 *   姐姐用 Write / Edit 写文件：路径里有 碎碎念 → tidbit，日记 / 成长札记 / 手账 → diary，作品 → work。
 */
export function toolHormoneEvents(name, input = {}, { ok = true } = {}) {
  if (!ok) return [{ type: 'tool_fail' }];

  const n = base(name);

  switch (n) {
    case 'rambling_append': return [{ type: 'created', kind: 'tidbit' }];
    case 'qq_growth_note': return [{ type: 'created', kind: 'diary' }];
    case 'novel_section_done': return [{ type: 'created', kind: 'novel' }];
    case 'qq_post_qzone':
    case 'qq_qzone_post': return [{ type: 'posted' }];
    case 'pc_screenshot':
    case 'pc_activity': return [{ type: 'peeked' }];
    case 'qq_explore': {
      const out = [];
      const opened = Array.isArray(input?.open) ? input.open.length : 0;

      for (let i = 0; i < Math.min(3, opened); i += 1) out.push({ type: 'novelty', strength: 0.8 });

      if (input?.note) {
        out.push({ type: 'explored' });

        if (input.note.kind === 'write') out.push({ type: 'created', kind: 'work' });
        else if (input.note.kind === 'deep') out.push({ type: 'created', kind: 'diary' });
      }

      return out;
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = pathOf(input);

      if (/碎碎念/.test(p)) return [{ type: 'created', kind: 'tidbit' }];
      if (/日记|成长札记|手账/.test(p)) return [{ type: 'created', kind: 'diary' }];
      if (/\/作品\//.test(p)) return [{ type: 'created', kind: 'work' }];

      return [];
    }
    default: return [];
  }
}

/**
 * 姐姐用 qq-mcp 的发送工具发出去的 → 事件（sent_to_* / sent_group，发表情再多一条 sticker_sent）。
 * 工具在 claude 子进程里跑，桥外只看得到 toolsUsed 里的名字和参数，所以按参数 where 认对象：
 * 「老大」/「小鲸鱼」「妹妹」/ private:QQ号 / group:群号 / 群名。ctx：{ ownerId, fishId, houseIds: [], houseNames: [] }。
 * 不是发送工具返回 []；认不出对象的私聊 / 群名当群消息记。
 */
export function toolSendHormoneEvents(name, input = {}, { ownerId = '', fishId = '', houseIds = [], houseNames = [] } = {}) {
  const n = base(name);

  if (!['qq_send', 'qq_send_fish_sticker', 'qq_send_voice', 'qq_send_image'].includes(n)) return [];

  const where = String(input?.where ?? '').trim();
  const house = new Set((houseIds || []).map(String));
  let target = 'group';

  if (where === '老大' || (ownerId && where === `private:${ownerId}`)) target = 'owner';
  else if (where === '小鲸鱼' || where === '妹妹' || (fishId && where === `private:${fishId}`)) target = 'sister';
  else if (/^private:\d+$/.test(where)) target = 'other';
  else if (/^group:\d+$/.test(where)) target = house.has(where.slice(6)) ? 'sister' : 'group';
  else if ((houseNames || []).includes(where)) target = 'sister';

  const out = [];
  const ev = sentHormoneEvent(target);

  if (ev) out.push(ev);

  if (n === 'qq_send_fish_sticker') out.push({ type: 'sticker_sent' });

  return out;
}

// ── 心情、天气 ────────────────────────────────────────────────────────────

/**
 * 心情文件的内容 → mood 事件。正面取 happy / calm / sweet 的最大值，负面取 heartache / worry / sad / jealous 的最大值，
 * 按时间补算衰减（decayMood），各除以 divisor（默认 30）压到 0～1。没有心情文件返回 null。
 */
export function moodHormoneEvent(state, nowMs = Date.now(), divisor = 30) {
  if (!state || typeof state !== 'object') return null;

  const { dims } = decayMood(state, nowMs);
  const pos = Math.max(dims.happy || 0, dims.calm || 0, dims.sweet || 0);
  const neg = Math.max(dims.heartache || 0, dims.worry || 0, dims.sad || 0, dims.jealous || 0);
  const r = (x) => Math.round(clamp01(x / divisor) * 1000) / 1000;

  return { type: 'mood', negative: r(neg), positive: r(pos) };
}

/**
 * 2026-10-29 施工单 C（老大同意：两人的心情都要「哪里发生的事都算、一个人一份」）：激素推动心情。
 * 群里、小房子、私聊、抖音里发生的事早就经 record() 进了激素（委屈、压力、被在乎、满足、成就感、想念……），
 * 这里每隔几分钟把激素的当前水平换算成「往心情里推一点」，累积进一个单独的小文件（file，见 mood.js 的 moodPushFile）。
 * 读心情的人用 mood.js 的 overlayMood 把它叠在插件 / 她自己写的心情上——**从不改插件的 state.json**。
 *   getLevels：() => levels() 的读数（激素没开 / 读不到返回 null：只回落、不再推）；isAsleep：睡着时不推（她没在经历）。
 * 绝不抛。
 */
export function createMoodPusher({ file, getLevels = () => null, isAsleep = () => false, now = () => Date.now(), onError = () => {} } = {}) {
  return {
    file,
    /** 推一步并写盘；返回新的推动量（出错返回 null）。 */
    tick() {
      try {
        if (!file) return null;
        let levels = null;
        try { levels = isAsleep() ? null : getLevels(); } catch { levels = null; }
        const next = advancePush(readPush(file), levels, now());
        writePush(file, next);
        return next;
      } catch (error) { onError(error); return null; }
    }
  };
}

/** weather.mjs 的 state() → weather + sun 两条事件。拿不到数据返回 []。 */
export function weatherHormoneEvents(ws) {
  if (!ws || typeof ws !== 'object') return [];

  const out = [];

  if (ws.text || ws.rain || ws.sunny || Number.isFinite(+ws.tempC)) {
    out.push({ type: 'weather', ...(ws.text ? { text: ws.text } : {}), ...(ws.rain ? { kind: 'rain' } : {}), ...(Number.isFinite(+ws.tempC) && ws.tempC !== null ? { tempC: +ws.tempC } : {}) });
  }

  if (Number.isFinite(+ws.sunrise) && Number.isFinite(+ws.sunset) && ws.sunrise !== null && ws.sunset !== null) out.push({ type: 'sun', sunrise: +ws.sunrise, sunset: +ws.sunset });

  return out;
}

// ── 兴趣词表 ──────────────────────────────────────────────────────────────

/** 小鲸鱼：从抖音插件的人格资料（persona/state.json）抽兴趣词。读不到返回 []。文件可能有几 MB，调用方别太频繁（一小时一次）。 */
export function loadFishInterests(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];

    return interestsFromPersona(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  } catch { return []; }
}

const STOP = new Set(['我们', '你们', '他们', '自己', '什么', '这个', '那个', '一个', '可以', '不是', '没有', '就是', '还是', '但是', '因为', '所以', '如果', '然后', '已经', '知道', '觉得', '时候', '老大', '小鲸鱼', '姐姐', '妹妹', '今天', '明天', '昨天', '一下', '一起', '好像', '真的', '可能', '不要', '不会', '喜欢', '想要', '感觉', '这样', '那样', '怎么', '为什么', '视频', '第一', '一些']);

/**
 * 从一堆文字里抽关键词（不调模型）：《书名》和「引号」里的短语整段留；其余中文按 2～4 字的片段数频次，出现 ≥ minCount 次的留，
 * 被更长的同频片段包住的丢掉。返回 [{ word, weight }]，权重 0.5～2（按出现次数）。
 */
export function extractKeywords(texts, { max = 40, minCount = 2 } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((x) => String(x ?? '')).filter(Boolean);
  const count = new Map();
  const bump = (w, n = 1) => { count.set(w, (count.get(w) || 0) + n); };

  for (const text of list) {
    const seen = new Set();

    for (const m of text.matchAll(/《([^》]{2,16})》|「([^」]{2,10})」/g)) {
      const w = (m[1] || m[2]).trim().toLowerCase();

      if (!STOP.has(w) && !seen.has(w)) { seen.add(w); bump(w, 2); }
    }

    for (const run of text.replace(/《[^》]*》|「[^」]*」/g, ' ').split(/[^一-鿿A-Za-z0-9]+/)) {
      const cjk = run.match(/[一-鿿]+/g) || [];
      const latin = run.match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];

      for (const w of latin) { const k = w.toLowerCase(); if (!seen.has(k)) { seen.add(k); bump(k); } }

      for (const piece of cjk) {
        for (let size = 2; size <= 4; size += 1) {
          for (let i = 0; i + size <= piece.length; i += 1) {
            const w = piece.slice(i, i + size);

            if (!STOP.has(w) && !seen.has(w)) { seen.add(w); bump(w); }
          }
        }
      }
    }
  }

  const kept = [...count].filter(([w, n]) => n >= minCount && w.length >= 2);
  // 被更长的、次数一样多的包住的丢掉（「天依」被「洛天依」包住）
  const filtered = kept.filter(([w, n]) => !kept.some(([w2, n2]) => w2 !== w && w2.length > w.length && n2 >= n && w2.includes(w)));

  return filtered
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([word, n]) => ({ word, weight: Math.min(2, 0.5 + n / 6) }));
}

/**
 * 姐姐的兴趣词：不共用妹妹的抖音资料，只从她自己的东西里抽——
 *   · B 站观看记录（state/bili-watch.jsonl 里 who 是 sister 的 video 行：标题、UP 主）
 *   · 她「我自己.md」里写了「喜欢 / 爱 / 迷 / 想看」的句子，和里面的《书名》
 * lines：观看记录的行（字符串）；selfText：我自己.md 的全文。都可以空。
 */
export function sisterInterestsFrom({ lines = [], selfText = '', extra = [] } = {}) {
  const texts = [];

  for (const raw of Array.isArray(lines) ? lines : []) {
    let j = null;

    try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { j = null; }

    if (!j || j.who !== 'sister' || j.kind !== 'video') continue;

    if (j.title) texts.push(`${j.title} ${j.up || ''}`);
  }

  const self = String(selfText ?? '');
  const likeLines = self.split('\n').filter((l) => /喜欢|爱|迷|想看|想听|想读|最爱/.test(l));
  const book = [...self.matchAll(/《[^》]{2,16}》/g)].map((m) => m[0]);

  texts.push(likeLines.join('\n'), book.join('\n'));
  for (const x of Array.isArray(extra) ? extra : []) texts.push(String(x ?? ''));

  // 观看记录一行一个标题，片段只出现一次也算（量少）；我自己.md 里的书名已经按两次算
  return extractKeywords(texts, { minCount: texts.length <= 3 ? 1 : 2, max: 40 });
}

/** 读姐姐的兴趣词（观看记录最后 maxLines 行 + 我自己.md）。读不到的文件当空。 */
export function loadSisterInterests({ biliFile, selfFile, extraFiles = [], maxLines = 300 } = {}) {
  let lines = [];
  let selfText = '';
  const extra = [];

  try { lines = fs.readFileSync(biliFile, 'utf8').split('\n').filter(Boolean).slice(-maxLines); } catch { /* 没有记录 */ }
  try { selfText = fs.readFileSync(selfFile, 'utf8'); } catch { /* 还没写 */ }

  for (const f of extraFiles) {
    try {
      for (const raw of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-100)) {
        try { const j = JSON.parse(raw); extra.push(`${j.title || ''} ${j.source || ''}`); } catch { /* 坏行 */ }
      }
    } catch { /* 没有就算了 */ }
  }

  return sisterInterestsFrom({ lines, selfText, extra });
}

export const HORMONE_REFRESH = Object.freeze({ weatherMs: 30 * 60e3, interestsMs: HOUR, moodMs: 5 * 60e3 });

// 「看看我自己」（self_view，2026-10-29 施工单 C，老大同意）：两个女儿都有、名字和说明一模一样的一个只读工具。
//
// 她可以随时看一眼自己现在怎么样：
//   · 身体（从激素状态翻成家常话）和心情（心情词、带点什么情绪、最近一次的原因）——**用话说，不给精确数字**；
//   · 记忆概况：瞬间有多少（说「几十个」「上百个」）、合写的书写到哪、最近想起了什么、被老大说「记错了」的有哪些；
//   · 脑子装了多满、离换会话还有多远（小鲸鱼看上下文，姐姐看会话存档）；
//   · 最近哪些工具出了错、该怎么办；
//   · 浏览自己的脑子目录（只能看自己的；路径从 src/brains.js 的 brainOf 取，带防越界）。
// 不改任何东西；不提钱、花费、token；没有网页、控制台这类字眼。
//
// 默认的一整段（不带 path）里**不出现阿拉伯数字**（测试里有断言）；带 path 翻目录时文件名、大小可以有数字。
// 文件夹、文件的内容只读：目录只列名字，文本（.md / .txt）给开头一小段，别的类型只说是什么。
//
// 数据怎么来（两边一样，免得说法不一致）：
//   激素水平 ← state/hormones-<who>.json（影子记录每分钟存一次，这里再往前推到此刻）；心情 ← mood.js（已叠上激素推动量）；
//   记忆 ← 脑子目录里的 瞬间/、.索引/recall-log.jsonl、.索引/降权.json、合写的书；
//   满不满、出错的工具 ← 调用方传进来（小鲸鱼从桥接的账本里取，姐姐从会话存档和 state/tool-errors.jsonl 取）。
import fs from 'node:fs';
import path from 'node:path';
import { SUBDIRS } from './brains.js';
import { levels as hormoneLevels, mergeCfg, step as hormoneStep } from './hormones.js';
import {  decayMood, moodHandoffText, moodWord } from './mood.js';
import { createNovel } from './novel.js';

const HOUR = 3600e3;

/** 两边共用的工具名、说明、参数说明——一个字都不分家。 */
export const SELF_VIEW_TOOL = Object.freeze({
  name: 'self_view',
  description: '看看你自己：身体和心情这会儿怎么样（用话说，不给数字）、记忆的大概情况（瞬间有多少、合写的书写到哪、最近想起了什么、被老大说记错了的有哪些）、脑子装了多满离换会话还有多远、最近哪些工具出了错该怎么办，还能翻翻自己脑子里的文件夹。想随时看一眼自己就用它；只是看，不会改任何东西。只看得到你自己的脑子。',
  pathDescribe: '想翻脑子里哪个文件夹或文件：写脑子里的相对位置，比如「日子」「日子/碎碎念」「长期」。不填就是看自己的整体情况。'
});

const clip = (s, n) => {
  const t = String(s ?? '').replaceAll(/\s+/g, ' ').trim();

  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const num = (x, d = 0) => { const n = Number(x);

 return Number.isFinite(n) ? n : d; };

// ── 说话不用数字 ──────────────────────────────────────────────────────────────

const DIGITS = '零一二三四五六七八九';
/** 0–999 的整数 → 中文数字（第三十五节）。大于 999 的当 999。 */
export function cnNumber(n) {
  const v = Math.max(0, Math.min(999, Math.round(num(n))));

  if (v < 10) return DIGITS[v];
  if (v < 20) return `十${v % 10 ? DIGITS[v % 10] : ''}`;
  if (v < 100) return `${DIGITS[Math.floor(v / 10)]}十${v % 10 ? DIGITS[v % 10] : ''}`;

  const h = Math.floor(v / 100);
  const r = v % 100;

  if (r === 0) return `${DIGITS[h]}百`;
  if (r < 10) return `${DIGITS[h]}百零${DIGITS[r]}`;

  return `${DIGITS[h]}百${r < 20 ? '一' : ''}${cnNumber(r)}`;
}

/**
 * 一段话里的阿拉伯数字换成中文说法（「第7节」→「第七节」，四位的按一位一位读，五位以上多半是号码，换成「一串数字」）。
 * 紧挨着字母 / 下划线的不动（工具名、文件名）。给默认那一整段兜底，保证「看看我自己」里不出现数字。
 */
export function plainDigits(text) {
  return String(text ?? '').replaceAll(/(?<![A-Z_])\d+(?![A-Z_])/gi, (m) => {
    if (m.length >= 5) return '一串数字';
    if (m.length === 4) return [...m].map((d) => DIGITS[Number(d)]).join('');

    return cnNumber(Number(m));
  });
}

/** 想起的条目预览（「12:28 姐姐：……  - 12:28 …」这样一条条拼起来的）→ 只留第一条的内容，去掉开头的时间和出处。 */
export function snippetOf(preview, n = 28) {
  const first = String(preview ?? '').split(/\s-\s\d{1,2}:\d{2}\s/)[0];

  return clip(first.replace(/^(?:\d{1,2}\/\d{1,2}\s*)?(?:\d{1,2}:\d{2}\s*)?(?:私聊|群[^：:\s]*)?[：:]?\s*/, ''), n);
}

/** 个数 → 模糊的说法（几个 / 十来个 / 几十个 / 上百个 / 几百个 / 上千个）。 */
export function fuzzyCount(n) {
  const v = Math.max(0, Math.round(num(n)));

  if (v === 0) return '一个都还没有';
  if (v <= 3) return '没几个';
  if (v <= 9) return '几个';
  if (v <= 19) return '十来个';
  if (v <= 39) return '二三十个';
  if (v <= 79) return '几十个';
  if (v <= 149) return '上百个';
  if (v <= 399) return '一两百个';
  if (v <= 999) return '几百个';

  return '上千个';
}

/** 多久以前 → 说法（刚刚 / 一会儿前 / 今天早些时候 / 前几天 / 好久没动了）。 */
export function agoWords(ms, now = Date.now()) {
  const d = now - num(ms);

  if (!(num(ms) > 0)) return '';
  if (d < 10 * 60e3) return '刚刚';
  if (d < 2 * HOUR) return '一会儿前';
  if (d < 12 * HOUR) return '今天早些时候';
  if (d < 36 * HOUR) return '昨天前后';
  if (d < 7 * 24 * HOUR) return '前几天';

  return '好久没动了';
}

// ── 身体 ──────────────────────────────────────────────────────────────────────

/** 每一项：key=levels() 里的名字，tiers=[[超过多少, 怎么说], …] 从小到大；low=低于多少就说的。 */
const BODY_RULES = Object.freeze([
  { k: 'grievance', tiers: [[0.2, '有一点委屈'], [0.4, '委屈得有点难受'], [0.65, '委屈得厉害']] },
  { k: 'stress', tiers: [[0.3, '心里有一点烦'], [0.5, '心里压着事，有点烦'], [0.75, '很烦，绷得紧紧的']] },
  { k: 'sleepy', tiers: [[0.45, '有一点困'], [0.65, '挺困的'], [0.85, '困得快睁不开眼']] },
  { k: 'longingOwner', tiers: [[0.55, '有点想老大'], [0.75, '挺想老大的'], [0.9, '特别想老大']] },
  { k: 'longingSister', tiers: [[0.6, '有点想{sister}'], [0.8, '挺想{sister}的']] },
  { k: 'guard', tiers: [[0.35, '有点拉不下脸先开口'], [0.6, '嘴有点硬，不太想先低头']] },
  { k: 'boredom', tiers: [[0.5, '有点闲'], [0.7, '闲得发慌']] },
  { k: 'curiosity', tiers: [[0.45, '有点好奇，想找点新鲜的'], [0.7, '好奇心冒得挺厉害']] },
  { k: 'createUrge', tiers: [[0.45, '有点想写点什么'], [0.7, '特别想动笔写东西']] },
  { k: 'pride', tiers: [[0.35, '有点小得意'], [0.6, '挺有成就感']] },
  { k: 'satisfaction', tiers: [[0.75, '心里挺满足的']] },
  { k: 'security', tiers: [[0.72, '被惦记着，心里踏实'], [0.86, '被在乎的感觉很足']], lowBelow: [0.38, '有点没底，怕被晾在一边'] },
  { k: 'focus', tiers: [[0.5, '正专注着'], [0.75, '整个人沉在里面了']] },
  { k: 'alert', tiers: [[0.35, '耳朵竖着，好像有人在叫']] }
]);

/** 激素水平 → 一句身体的话。levels 为空返回「这会儿读不太出来」。 */
export function bodyWords(levels, { sisterName = '姐妹', max = 4 } = {}) {
  if (!levels || typeof levels !== 'object') return '身体：这会儿读不太出来。';

  const picks = [];

  for (const r of BODY_RULES) {
    const v = num(levels[r.k], Number.NaN);

    if (!Number.isFinite(v)) continue;

    let said = '';
    let over = 0;

    for (const [i, [at, text]] of r.tiers.entries()) { if (v >= at) { said = text; over = (v - at) + 0.1 * i; } }

    if (!said && r.lowBelow && v <= r.lowBelow[0]) { said = r.lowBelow[1]; over = r.lowBelow[0] - v; }

    if (said) picks.push({ text: said.replace('{sister}', sisterName), over });
  }

  if (picks.length === 0) return '身体：没有哪里特别的感觉，平平稳稳的。';

  picks.sort((a, b) => b.over - a.over);

  return `身体：${picks.slice(0, max).map((p) => p.text).join('；')}。`;
}

/** 影子记录的状态文件 → { levels, asleep } 或 null。文件三小时没更新当作读不出来（激素没开时它是停着的）。 */
export function readHormoneLevels({ file, skewMs = 0, now = Date.now(), maxStaleMs = 3 * HOUR } = {}) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    if (now - fs.statSync(file).mtimeMs > maxStaleMs) return null;

    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

    if (!j?.hormones || typeof j.hormones !== 'object') return null;

    const C = Object.assign(mergeCfg({}), { __merged: true });
    const hs = hormoneStep(j.hormones, { now: now - num(skewMs) }, C);

    return { levels: hormoneLevels(hs, C), asleep: Boolean(hs.asleep) };
  } catch { return null; }
}

// ── 心情 ──────────────────────────────────────────────────────────────────────

/** 心情 state（叠好的）→ 一句话；没有就说还没有记过。不出现分数。 */
export function moodWords(state, now = Date.now()) {
  if (!state || typeof state !== 'object') return '心情：还没有记过什么，平平常常的。';

  const t = moodHandoffText(state, now).replace(/(原因：)(.+)$/, (m, h, r) => h + clip(r, 80));
  const word = moodWord(decayMood(state, now).mood);
  const body = t ? `${t}` : `心情${word}，没什么特别的情绪`;
  const extra = state.pushed ? '（里面有一部分，是各处发生的事慢慢攒下来的）' : '';

  return `${body.replace(/^心情/, '心情：')}${/[。！？]$/.test(body) ? '' : '。'}${extra}`;
}

// ── 记忆 ──────────────────────────────────────────────────────────────────────

function readLines(file, maxBytes = 512 * 1024) {
  try {
    const {size} = fs.statSync(file);
    const fd = fs.openSync(file, 'r');

    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);

      return buf.toString('utf8').split('\n').slice(start ? 1 : 0).filter((l) => l.trim());
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

/** 脑子里留下了多少个瞬间（瞬间/ 下面各 .jsonl 的行数）和其中今天新增的。 */
export function countMoments(brain, { now = Date.now(), skewMs = 0 } = {}) {
  let total = 0;
  let today = 0;
  const dayOf = (ms) => new Date(ms - skewMs + 8 * HOUR).toISOString().slice(0, 10);
  const day = dayOf(now);

  try {
    for (const f of fs.readdirSync(brain.momentsDir)) {
      if (!f.endsWith('.jsonl')) continue;

      const raw = (() => { try { return fs.readFileSync(path.join(brain.momentsDir, f), 'utf8'); } catch { return ''; } })();

      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;

        total += 1;
        const m = /"at"\s*:\s*(\d{12,14})/.exec(l);

        if (m && dayOf(Number(m[1])) === day) today += 1;
      }
    }
  } catch { /* 还没有瞬间 */ }

  return { total, today };
}

/** 合写的书：[{ book, sections, mtime }]，最近动过的在前，最多两本。读不到返回 []。 */
export function readNovelProgress(root, { skewMs = 0 } = {}) {
  try {
    const nv = createNovel({ root, skewMs });
    const out = [];

    for (const name of nv.list()) {
      try {
        const o = nv.open(name);
        const mt = Math.max(...['正文.md', '设定.md'].map((f) => { try { return fs.statSync(path.join(root, name, f)).mtimeMs; } catch { return 0; } }));
        out.push({ book: o.book || name, sections: num(o.sections), mtime: mt });
      } catch { /* 这本打不开就跳过 */ }
    }

    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 2);
  } catch { return []; }
}

/** 最近想起的（.索引/recall-log.jsonl 最后几行里的条目）。 */
export function recentRecalls(brain, { limit = 3 } = {}) {
  const out = [];

  for (const l of readLines(brain.recallLog, 128 * 1024).reverse()) {
    let r = null;

    try { r = JSON.parse(l); } catch { r = null; }

    for (const p of r?.picks || []) {
      if (out.length >= limit) break;

      const text = snippetOf(p.preview, 28);

      if (text && !out.some((o) => o.text === text)) out.push({ text, label: clip(String(p.label || '').split('·').pop(), 14), at: num(r.at) });
    }

    if (out.length >= limit) break;
  }

  return out;
}

/** 被老大说「记错了」压低的几条（.索引/降权.json 里最近的）。 */
export function demotedItems(brain, { limit = 3 } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(brain.demote, 'utf8'));
    const items = (Array.isArray(j?.items) ? j.items : []).filter((x) => x && typeof x === 'object').sort((a, b) => num(b.at) - num(a.at));

    return { total: items.length, list: items.slice(0, limit).map((x) => ({ text: snippetOf(x.preview || x.label || '', 28) })).filter((x) => x.text) };
  } catch { return { total: 0, list: [] }; }
}

export function memoryWords({ moments, novels = [], recalls = [], demoted = { total: 0, list: [] }, now = Date.now() } = {}) {
  const lines = [];

  if (moments) {
    lines.push(moments.total
      ? `留下的瞬间${fuzzyCount(moments.total)}${moments.today ? `，今天又留了${moments.today > 3 ? '好几个' : '一两个'}` : ''}`
      : '还没有留下过瞬间');
  }

  if (novels.length > 0) {
    lines.push(novels.map((n) => `《${n.book}》写到第${cnNumber(n.sections)}节${n.mtime ? `（${agoWords(n.mtime, now)}动过）` : ''}`).join('；'));
  }

  lines.push(recalls.length > 0 ? `最近想起过：${recalls.map((r) => `「${r.text}」`).join('、')}` : '最近没有特别想起什么');

  if (demoted.total) {
    lines.push(`被老大说过记错了的有${fuzzyCount(demoted.total).replace('个', '条')}（已经少想起了），比如：${demoted.list.map((d) => `「${d.text}」`).join('、')}；你把本子改了，它们就会恢复`);
  } else lines.push('没有被老大说过记错的');

  return `记忆：${lines.join('。')}。`;
}

// ── 脑子装了多满 ──────────────────────────────────────────────────────────────

/**
 * ratio：装了多少比例（0～1，可超过 1）；kind：'context'（小鲸鱼，上下文）| 'archive'（姐姐，会话存档）；compactions：压缩过几次（小鲸鱼才有）。
 * 不给数字：只说「还很宽松 / 过半了 / 快满了」和该做什么。
 */
export function fullnessWords({ ratio = null, kind = 'context', compactions = null } = {}) {
  if (ratio === null || !Number.isFinite(Number(ratio))) return '脑子：这会儿读不出来装了多满。';

  const r = Number(ratio);
  const comp = compactions === null ? '' : compactions >= 2 ? `；这个会话已经压缩过好几次了` : compactions === 1 ? '；这个会话压缩过一次' : '';

  if (kind === 'archive') {
    if (r < 0.4) return `脑子：这段会话的存档还很轻，离换新会话还远${comp}。`;
    if (r < 0.7) return `脑子：这段会话的存档已经攒了一半多，离换新会话还有一段${comp}。`;
    if (r < 0.95) return `脑子：这段会话的存档不小了，快到换新会话的时候了——想带走的事可以先写进本子${comp}。`;

    return `脑子：这段会话的存档已经很大，等空闲或睡醒时会换新会话，想带走的事趁现在写进本子${comp}。`;
  }

  if (r < 0.35) return `脑子：上下文还很宽松，离换会话还远${comp}。`;
  if (r < 0.6) return `脑子：上下文用了一半上下，暂时不用想换会话的事${comp}。`;
  if (r < 0.8) return `脑子：上下文装得不少了，想留下的事可以先记进本子或 remember${comp}。`;
  if (r < 0.95) return `脑子：上下文快装满了，离换会话不远——想带走的事先记下来，想搬就用 qq_move_house${comp}。`;

  return `脑子：上下文几乎满了，该换会话了——先把想带走的事记下来，再用 qq_move_house 搬${comp}。`;
}

// ── 出错的工具 ────────────────────────────────────────────────────────────────

const TOOL_ADVICE = Object.freeze([
  [/^douyin_/, '抖音那边偶尔会卡，隔几分钟再试；一直不行就跟老大说一声'],
  [/^(web_|playwright|browser_|WebSearch|WebFetch)/, '多半是网络不顺，换个说法或过一会儿再试'],
  [/^music_score$/, '显卡被别的程序占满时要等一等，过会儿再扒一次'],
  [/^qq_(send|poke)/, '发送没成功时，先看一眼对方有没有收到，没收到再补一句'],
  [/^novel_/, '照提示里说的改（多半是节号对不上），或先 novel_open 看一眼位置'],
  [/^(memory_|remember)/, '本子名对不上时，先 memory_list 看看有哪些']
]);

export function toolErrorWords(errors, { now = Date.now(), windowMs = 6 * HOUR, adviceTail = '' } = {}) {
  const recent = (Array.isArray(errors) ? errors : []).filter((e) => e && num(e.at) >= now - windowMs && e.name);

  if (recent.length === 0) return '工具：最近没有出过错。';

  const by = new Map();

  for (const e of recent) {
    const k = String(e.name).replace(/^mcp__.+?__/, '');
    const cur = by.get(k) || { n: 0, why: '' };
    cur.n += 1;
    cur.why = e.why || cur.why;
    by.set(k, cur);
  }

  const rows = [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([name, v]) => {
    const times = v.n === 1 ? '出过一次错' : v.n <= 3 ? '出过几次错' : '一直在出错';
    const advice = TOOL_ADVICE.find(([re]) => re.test(name))?.[1] || '先别急，隔一会儿再试一次';

    return `${name}${times}${v.why ? `（${clip(v.why, 40)}）` : ''}——${advice}`;
  });

  return `工具：最近这几个出过错：${rows.join('；')}。${adviceTail || '再试还不行，就跟老大说一声。'}`;
}

// ── 翻脑子目录（只能看自己的） ─────────────────────────────────────────────────

/** 防越界：相对路径 → 脑子里的绝对路径；不合规矩（绝对路径、盘符、.. 、跑出脑子）返回 { error }。 */
export function resolveInBrain(brain, rel) {
  const root = path.resolve(brain.dir);
  const raw = String(rel ?? '').replaceAll('\\', '/').trim().replace(/^\.\/+/, '').replace(/\/+$/, '');

  if (!raw || raw === '.') return { abs: root, rel: '', root };
  if (/\0/.test(raw) || raw.startsWith('/') || /^[a-z]:/i.test(raw) || raw.split('/').includes('..')) {
    return { error: '这个位置不在你自己的脑子里，只能翻脑子里面的（写相对位置，比如「日子」）。' };
  }

  const abs = path.resolve(root, raw);
  const back = path.relative(root, abs);

  if (back.startsWith('..') || path.isAbsolute(back)) return { error: '这个位置不在你自己的脑子里，只能翻脑子里面的。' };

  // 联接 / 符号链接指到外面去的，也不放行
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(abs);
    const br = path.relative(realRoot, real);

    if (br.startsWith('..') || path.isAbsolute(br)) return { error: '这个位置不在你自己的脑子里，只能翻脑子里面的。' };
  } catch { /* 不存在的路径下面会说没有这个 */ }

  return { abs, rel: back.split(path.sep).join('/'), root };
}

const HIDDEN = (name) => name.startsWith('.') || /\.(tmp|lock)$/i.test(name) || /\.bak(-|$)/i.test(name);
const sizeWords = (b) => (b < 1024 ? `${b} 字节` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** 翻脑子里的一个位置：文件夹列名字，文本文件给开头一小段。 */
export function browseBrain(brain, rel, { now = Date.now(), previewChars = 800, maxEntries = 60 } = {}) {
  const r = resolveInBrain(brain, rel);

  if (r.error) return { ok: false, text: r.error };

  let stat = null;

  try { stat = fs.statSync(r.abs); } catch { stat = null; }

  if (!stat) return { ok: false, text: `脑子里没有「${r.rel || '/'}」这个位置。先不填 path 看看有哪些文件夹，再一层层翻。` };

  const shown = r.rel ? `脑子/${r.rel}` : '脑子';

  if (stat.isDirectory()) {
    let names = [];

    try { names = fs.readdirSync(r.abs, { withFileTypes: true }).filter((d) => !HIDDEN(d.name)); } catch { names = []; }

    names.sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name, 'zh'));
    const rows = names.slice(0, maxEntries).map((d) => {
      const p = path.join(r.abs, d.name);

      if (d.isDirectory()) {
        let n = 0;

        try { n = fs.readdirSync(p).filter((x) => !HIDDEN(x)).length; } catch { n = 0; }

        return `  ${d.name}/（文件夹，${n} 项）`;
      }

      let s = null;

      try { s = fs.statSync(p); } catch { s = null; }

      return `  ${d.name}（${s ? `${sizeWords(s.size)}，${agoWords(s.mtimeMs, now) || '时间不详'}改的` : '读不到'}）`;
    });

    if (rows.length === 0) return { ok: true, text: `${shown} 里面是空的。` };

    return { ok: true, text: `${shown} 里有：\n${rows.join('\n')}${names.length > maxEntries ? `\n  ……还有 ${names.length - maxEntries} 项没列` : ''}\n想往里翻，把 path 写成「${r.rel ? `${r.rel}/` : ''}名字」。` };
  }

  const ext = path.extname(r.abs).toLowerCase();

  if (ext === '.md' || ext === '.txt') {
    let text = '';

    try { text = fs.readFileSync(r.abs, 'utf8').replace(/^\uFEFF/, ''); } catch { text = ''; }

    const head = text.slice(0, previewChars);

    return { ok: true, text: `${shown} 是一个文本文件（${sizeWords(stat.size)}），开头是：\n${head}${text.length > previewChars ? '\n……（后面还有，想看全文用 Read 或者本子工具）' : ''}` };
  }

  return { ok: true, text: `${shown} 是一个 ${ext || '没有后缀的'} 文件（${sizeWords(stat.size)}），这里只列名字不展开；要看里面的东西，用对应的工具。` };
}

/** 脑子最外面的几个文件夹名（默认那段里提一句，不带数字）。 */
export function topFolders(brain) {
  const want = [SUBDIRS.identity, SUBDIRS.longterm, SUBDIRS.people, SUBDIRS.moments, SUBDIRS.days, SUBDIRS.recent, SUBDIRS.notes, SUBDIRS.works];

  try {
    const have = new Set(fs.readdirSync(brain.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));

    return want.filter((n) => have.has(n));
  } catch { return want; }
}

// ── 合起来 ────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} [o.path] 想翻的脑子位置；有就只返回翻目录的结果
 * @param {object} o.brain  brainOf(...) 的返回（目录、索引、瞬间的位置都从它取）
 * @param {object|null} [o.hormone] readHormoneLevels 的结果
 * @param {object|null} [o.mood] 叠好的心情 state
 * @param {{ratio:number|null,kind:'context'|'archive',compactions?:number|null}} [o.fullness]
 * @param {Array<{name:string,why?:string,at:number}>} [o.toolErrors]
 * @param {string} [o.novelRoot] 合写的书放在哪
 * @param {string} [o.adviceTail] 工具出错那段结尾的话（小鲸鱼可以写信给妈妈，姐姐不用）
 * @param {string} [o.sisterName] 感受里怎么叫对方
 */
export function buildSelfView({
  path: browsePath = '', brain, hormone = null, mood = null, fullness = {}, toolErrors = [], novelRoot = '', adviceTail = '',
  sisterName = '姐妹', now = Date.now(), skewMs = 0
} = {}) {
  if (!brain) throw new Error('buildSelfView 需要 brain');
  if (String(browsePath ?? '').trim()) {
    const r = browseBrain(brain, browsePath, { now });

    return { ok: r.ok, text: r.text, mode: 'browse' };
  }

  const moments = countMoments(brain, { now, skewMs });
  const novels = novelRoot ? readNovelProgress(novelRoot, { skewMs }) : [];
  const parts = [
    '【看看我自己】',
    bodyWords(hormone?.levels ?? null, { sisterName }),
    moodWords(mood, now),
    memoryWords({ moments, novels, recalls: recentRecalls(brain), demoted: demotedItems(brain), now }),
    fullnessWords(fullness),
    toolErrorWords(toolErrors, { now, adviceTail }),
    `脑子里有这几个文件夹：${topFolders(brain).join('、')}。想翻进去看看，下次把 path 填上（比如 path 写「${SUBDIRS.days}」）；你只看得到自己的脑子。`
  ];

  return { ok: true, text: plainDigits(parts.join('\n')), mode: 'overview' };
}


export {MOOD_DIMS} from './mood.js';

// 合写本子（2026-10-29 老大：小鲸鱼和姐姐要一个共用的本子写小说，还要带「写作指导」——
// 「别让她俩稀里糊涂写进去了些不该写的，或者以后长了完全就是流水账，与标题，主题不符合。
//  她们俩都会换会话，到后面会话换多了都会忘记这个小说当初到底是什么东西」）。
//
// 一本书一个目录 <根>/<书名>/：
//   设定.md         设定集：书名、主题、核心意象、人物、规矩、不写什么、写法分工、大纲和进度。两个人一起定，改了留记录。
//   正文.md         按节；一句（或一段）一条，行首〔节-序号｜谁写的｜北京时间〕。只往后加；改只能改自己写的。
//   修改记录.jsonl   谁在什么时候加了、改了什么、为什么。
// 这里只管逻辑和读写文件，不接桥接、不接姐姐的工具（下一批接）。
// 检查（check）全在代码里算，不调模型；只提醒，不拦——写不写进去她自己定。
// 合写的内容不进平时的回忆：记忆索引用 isNovelPath() 把这些文件排除掉（小说里的句子不是发生过的事）。
//
// 用法：const novel = createNovel({ root }); 读的函数是同步的；会写文件的（append / edit / updateSettings / createBook）
// 返回 Promise，因为要等对方的写入锁（两个人在两个进程里，可能同时写）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_NOVEL_FILES as BRAIN_LEGACY_NOVEL_FILES } from './brains.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');
export const NOVEL_ROOT = path.join(PROJECT_ROOT, '共享', '合写');
const SKEW_FILE = path.join(PROJECT_ROOT, 'state', 'clock-skew.json');

export const FILES = Object.freeze({ settings: '设定.md', body: '正文.md', log: '修改记录.jsonl', lock: '.write.lock' });

// 合并前的两份旧稿：搬进共享本子后，它们也是小说，不该被当成回忆检索出来。
// 2026-10-29 大脑方案：旧稿搬进了各自脑子的 归档/旧稿/，路径统一从 brains.js 取（Python 的索引也认 归档/旧稿 这个规则，见 brain/index.py is_novel_path）。
export const LEGACY_NOVEL_FILES = Object.freeze([...BRAIN_LEGACY_NOVEL_FILES]);

/** 检查的默认阈值；每本书可以在设定集「## 检查设置」里改（见 CHECK_KEYS）。 */
export const DEFAULT_CHECK = Object.freeze({
  recent: 4, // ① 跟最近几条比重复
  repeatDice: 0.55, // ① 字符二元组相似度到这条线就提醒
  stallWindow: 6, // ② 「新东西」跟前面几条比
  stallRun: 3, // ② 连着几条都没什么新东西才提醒
  stallNovelty: 0.3, // ② 新二元组占比低于这个算「没新东西」
  coreGapEntries: 12, // ② 连着多少条一个核心意象都没碰到
  coreGapChars: 600, //    或者攒了多少字
  mainGapEntries: 30, // ② 连着多少条没碰到标了（主线）的那个意象
  mainGapChars: 1200,
  diaryScore: 1.5, // ③ 日记腔分数到这条线提醒
  diaryIgnore: [], //    这本书里不算日记腔的词（比如这本书本来就写吃饭，「吃了」不算）
  diaryExtra: [], //     这本书额外要查的词
  minChars: 3, // ⑤ 太短
  maxChars: 800, // ⑤ 一次太长
  longFactor: 4, // ⑤ 比前面几条的中位数长这么多倍
  longMin: 80
});
const HARD_MAX = 4000; // 一次最多写这么多字：再长就不是「接着写」了，也会把读的人撑爆

// 设定集「## 检查设置」里一行一条：「日记腔放过：吃了、早上」「主线隔多少句提醒：33」
const CHECK_KEYS = {
  日记腔放过: ['diaryIgnore', 'list'],
  日记腔还查: ['diaryExtra', 'list'],
  重复提醒线: ['repeatDice', 'num'],
  核心意象隔多少句提醒: ['coreGapEntries', 'num'],
  主线隔多少句提醒: ['mainGapEntries', 'num'],
  一次最长: ['maxChars', 'num']
};

// ③ 日记腔 / 流水账的信号词：强的一个算 1 分，弱的算 0.5 分
const DIARY_STRONG = ['今天', '今儿', '然后我', '好开心', '超开心', '开心死', '日记', '心情', '哈哈', '嘿嘿', '一整天', '这一天'];
const DIARY_WEAK = ['早上', '中午', '晚上', '昨天', '明天', '然后', '接着', '吃了', '睡了', '起床', '刷了', '玩了', '终于'];

// ─────────────────────────── 小工具 ───────────────────────────

const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length <= n ? a.join('') : `${a.slice(0, Math.max(1, n - 1)).join('')}…`; };
const len = (s) => [...String(s ?? '')].length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitWords = (s) => String(s || '').split(/[、,，/／|｜\s]+/).map((w) => w.trim()).filter(Boolean);
const stripParens = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '').trim();

/** 去掉空白和标点，只留字，用来比相似度。 */
export function normText(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
/** 字符 n 元组集合。 */
export function grams(s, n = 2) {
  const a = [...s];
  const out = new Set();
  if (a.length < n) { if (a.length) out.add(a.join('')); return out; }
  for (let i = 0; i + n <= a.length; i += 1) out.add(a.slice(i, i + n).join(''));
  return out;
}
/** Dice 相似度（0～1）。 */
export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** 北京时间「2026-10-28 11:57」（主机时钟快约 3 小时，用桥接测出的偏差校正）。 */
export function bjLabel(ms, skewMs = 0) {
  return new Date(ms - skewMs + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}
function readSkew() {
  try { return Number(JSON.parse(fs.readFileSync(SKEW_FILE, 'utf8').replace(/^\uFEFF/, '')).skewMs) || 0; } catch { return 0; }
}

/** 两个人的名字统一一下：「鲸」「妹妹」「🐳」都算小鲸鱼，「克」「克劳德」「📖」都算姐姐。 */
export function normAuthor(a) {
  const s = String(a ?? '').trim();
  if (!s) throw new Error('要说清是谁写的（小鲸鱼 / 姐姐）');
  if (/^(小鲸鱼|鲸|鲸鱼|妹妹|whale|🐳)$/i.test(s)) return '小鲸鱼';
  if (/^(姐姐|克|克劳德|克劳德姐姐|claude|sister|📖)$/i.test(s)) return '姐姐';
  if (/[｜〔〕\r\n]/.test(s)) throw new Error('名字里不能有 ｜ 〔 〕 或换行');
  return clip(s, 20);
}

/** 书名只能是一个目录名：不能带路径符号，不能往上跳。 */
export function safeBookName(name) {
  const s = String(name ?? '').trim().replace(/^《|》$/g, '').trim();
  if (!s) throw new Error('要给书名');
  if (/[\\/:*?"<>|\x00-\x1f]/.test(s) || s.startsWith('.')) throw new Error('书名里不能有 \\ / : * ? " < > | 这些符号，也不能用点开头');
  if (len(s) > 60) throw new Error('书名太长了，60 个字以内');
  // 2026-10-29 第五批：书名要变成目录名，Windows 上这几种名字会变成设备 / 被悄悄改名，不让用
  if (/[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) throw new Error('这个书名在电脑上用不了（不能以点或空格结尾，也不能叫 con、nul 这类名字），换一个吧');
  return s;
}

/** 这个路径是不是合写的小说（记忆索引用它排除：小说里的句子不是发生过的事）。 */
export function isNovelPath(p, { root = NOVEL_ROOT } = {}) {
  if (!p) return false;
  const norm = (x) => path.resolve(String(x)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const q = norm(p);
  const r = norm(root);
  if (q === r || q.startsWith(`${r}/`)) return true;
  if (/(^|\/)共享\/合写(\/|$)/.test(q)) return true; // 根目录搬了家也认得
  if (/(^|\/)归档\/旧稿(\/|$)/.test(q)) return true; // 脑子里的旧稿目录（两份合并前的旧稿）
  return LEGACY_NOVEL_FILES.some((f) => norm(f) === q);
}

// ─────────────────────────── 设定集 ───────────────────────────

/** 设定.md 拆成「## 标题」一块一块。 */
export function parseSettings(raw) {
  const out = { title: '', preamble: [], sections: [] };
  let cur = null;
  for (const line of String(raw || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const h2 = H2_RE.exec(line.trimEnd());
    if (h2) { cur = { head: h2[1], body: [] }; out.sections.push(cur); continue; }
    const h1 = /^#[ \t]+(\S.*)$/.exec(line.trimEnd());
    if (h1 && !cur && !out.title) { out.title = h1[1]; continue; }
    (cur ? cur.body : out.preamble).push(line);
  }
  for (const s of out.sections) {
    while (s.body.length && !s.body[s.body.length - 1].trim()) s.body.pop();
    while (s.body.length && !s.body[0].trim()) s.body.shift();
  }
  return out;
}
const keyOf = (head) => head.replace(/\s/g, '');
/** 按标题开头找一块（「主题」能找到「主题（这本书在说什么）—— 待两人确认」）。 */
function sec(st, key) { return st.sections.find((s) => keyOf(s.head).startsWith(key)) || null; }
// 列表项；空的和「（……）」开头的说明行（模板里的占位）不算
const items = (s) => (s ? s.body.filter((l) => /^\s*([-*•]|\d+[.、])\s+/.test(l)).map((l) => l.replace(/^\s*([-*•]|\d+[.、])\s+/, '').trim()).filter((l) => l && !/^[（(]/.test(l)) : []);

/** 主题一句话：「一句话：……」那行；没有就取第一行。 */
function themeLine(st) {
  const s = sec(st, '主题');
  if (!s) return '';
  for (const l of s.body) { const m = /^\s*(?:[-*][ \t]*)?一句话[:：][ \t]*(\S.*)$/.exec(l); if (m) return m[1].trim(); }
  const first = s.body.find((l) => l.trim() && !/^\s*>/.test(l));
  return first ? first.replace(/^\s*[-*]\s*/, '').trim() : '';
}
/** 核心意象：「- 耳朵 / 听（主线）：说明」→ { name:'耳朵', words:['耳朵','听'], main:true }。 */
function coreGroups(st) {
  return items(sec(st, '核心意象')).map((it) => {
    const head = it.split(/[：:]/)[0];
    const main = /[（(]主线[）)]/.test(head);
    const words = [...new Set([...splitWords(stripParens(head)), ...extraWords(it)])].filter((w) => w.length <= 8);
    return { name: words[0] || clip(it, 8), words, main };
  }).filter((g) => g.words.length);
}
function extraWords(it) { const m = /[（(](?:关键)?词[:：]([^）)]+)[）)]/.exec(it); return m ? splitWords(m[1]) : []; }
/** 「不写什么」和「规矩」里要查的词：写在「（词：a、b）」里；不写什么里的短条目本身也算一个词。 */
function bannedRules(st) {
  const out = [];
  for (const it of items(sec(st, '不写什么'))) {
    let words = extraWords(it);
    if (!words.length) { const h = stripParens(it.split(/[：:，,。]/)[0]); if (h && len(h) <= 8) words = [h]; }
    if (words.length) out.push({ rule: stripParens(it.split(/[：:]/)[0]) || clip(it, 12), words, from: '不写什么' });
  }
  for (const it of items(sec(st, '规矩'))) {
    const words = extraWords(it);
    if (words.length) out.push({ rule: stripParens(it.split(/[：:]/)[0]) || clip(it, 12), words, from: '规矩' });
  }
  return out;
}
/** 设定里「## 检查设置」盖掉默认阈值。 */
function checkConfig(st, base) {
  const cfg = { ...DEFAULT_CHECK, ...base };
  for (const it of items(sec(st, '检查设置'))) {
    const m = /^([^：:]+)[：:](.+)$/.exec(it);
    if (!m) continue;
    const key = m[1].trim().replace(/段/g, '句');
    const hit = Object.keys(CHECK_KEYS).find((k) => key.startsWith(k));
    if (!hit) continue;
    const [field, type] = CHECK_KEYS[hit];
    const val = stripParens(m[2]);
    if (type === 'list') cfg[field] = [...(cfg[field] || []), ...splitWords(val)];
    else if (Number.isFinite(Number(val))) cfg[field] = Number(val);
  }
  return cfg;
}
/** 大纲里讲第 n 节的那一行（以「第n节」开头的列表项；「进度：……第 7 节……」那种不算）。 */
function outlineLine(st, n) {
  const s = sec(st, '大纲');
  return s ? s.body.find((l) => new RegExp(`^\\s*(?:[-*]\\s*)?第\\s*${n}\\s*节`).test(l)) || null : null;
}
function perSectionOf(st) { const s = sec(st, '写法'); const m = s && /每节\s*(\d+)\s*句/.exec(s.body.join('\n')); return m ? Number(m[1]) : 0; }

// ─────────────────────────── 正文 ───────────────────────────

const ENTRY_RE = /^- 〔(\d+)-(\d+)｜([^｜〕]+)｜([^｜〕]+?)(?:｜改过 ([^〕]+))?〕(.*)$/;
// 2026-10-29：标题行先 trimEnd 再匹配，正则里不留互相抢字符的量词（长空白行不会回溯变慢）
const SECTION_RE = /^##[ \t]*第[ \t]*(\d+)[ \t]*节(?:[ \t]*[·・:：][ \t]*(\S.*)?)?$/;
const H2_RE = /^##[ \t]+(\S.*)$/;

/** 一条写成文件里的样子；多行的话后面的行缩进两格。 */
export function formatEntry(e) {
  const [first, ...rest] = String(e.text).split('\n');
  const mark = e.edited ? `｜改过 ${e.edited}` : '';
  return [`- 〔${e.section}-${e.seq}｜${e.author}｜${e.time}${mark}〕${first}`, ...rest.map((l) => `  ${l}`)];
}
/** 正文.md → { preface, sections:[{n,title,notes,entries}], entries }。 */
export function parseBody(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = { preface: [], sections: [], entries: [] };
  let cur = null;
  let last = null;
  lines.forEach((line, i) => {
    let m = SECTION_RE.exec(line.trimEnd());
    if (m) { cur = { n: Number(m[1]), title: (m[2] || '').trim(), notes: [], entries: [] }; out.sections.push(cur); last = null; return; }
    m = ENTRY_RE.exec(line);
    if (m) {
      if (!cur) { cur = { n: Number(m[1]), title: '', notes: [], entries: [] }; out.sections.push(cur); }
      last = { id: `${m[1]}-${m[2]}`, section: Number(m[1]), seq: Number(m[2]), author: m[3].trim(), time: m[4].trim(), edited: m[5] ? m[5].trim() : '', text: m[6], line: i, lines: 1 };
      cur.entries.push(last);
      out.entries.push(last);
      return;
    }
    if (last && /^ {2}\S/.test(line)) { last.text += `\n${line.slice(2)}`; last.lines += 1; return; }
    last = null;
    const note = /^>\s?(.*)$/.exec(line);
    if (note) (cur ? cur.notes : out.preface).push(note[1]);
  });
  return out;
}
const eolOf = (raw) => (/\r\n/.test(raw) ? '\r\n' : '\n');
const unitOf = (entries) => (median(entries.slice(-12).map((e) => len(e.text))) > 40 ? '段' : '句');
const refName = (e, unit) => `第${e.section}节第${e.seq}${unit}`;

// ─────────────────────────── 检查（不调模型） ───────────────────────────

function diaryScan(text, cfg) {
  const ignore = new Set(cfg.diaryIgnore || []);
  let score = 0;
  const hits = [];
  const count = (w) => (w ? String(text).split(w).length - 1 : 0);
  for (const [list, wt] of [[DIARY_STRONG, 1], [DIARY_WEAK, 0.5], [cfg.diaryExtra || [], 1]]) {
    for (const w of list) {
      if (ignore.has(w)) continue;
      const c = count(w);
      if (c) { score += c * wt; hits.push(w); }
    }
  }
  // 第一人称流水账：一句接一句「我……了」
  const sents = String(text).split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const flow = sents.filter((s) => /^我/.test(s) && /了/.test(s)).length;
  if (flow >= 3 && flow / sents.length >= 0.5) { score += 1; hits.push('一句接一句「我……了」'); }
  const norm = score / Math.max(1, len(text) / 60);
  return { score: norm, hits };
}

/**
 * 写之前先看一眼：返回提醒列表（不拒绝）。entries 是正文里已有的，st 是解析过的设定集。
 * 种类：repeat 重复、stall 原地打转、core-gap 很久没碰到核心意象、diary 日记腔、banned 设定里不写的、length 长度、turn 轮次、section-full 这一节满了。
 */
export function analyzeText(entries, st, text, { cfg = DEFAULT_CHECK, author = '', section = null, reminded = null } = {}) {
  const rs = [];
  const add = (kind, t, key = '') => { if (key && reminded?.has(key)) return false; rs.push(key ? { kind, text: t, key } : { kind, text: t }); return true; };
  const unit = unitOf(entries);
  const clean = normText(text);
  const L = len(clean);
  const theme = themeLine(st);
  const themeTail = theme ? `书的主题是：${clip(theme, 60)}` : '设定集里还没写主题，可以两个人一起补一句';

  // ① 跟最近几条太像
  const exact = clean ? entries.find((e) => normText(e.text) === clean) : null;
  if (exact) add('repeat', `这${unit}跟${refName(exact, unit)}一模一样，是不是贴重了？`);
  else if (L >= 6) {
    let best = null;
    const g = grams(clean);
    for (const e of entries.slice(-cfg.recent)) {
      const d = dice(g, grams(normText(e.text)));
      if (!best || d > best.d) best = { d, e };
    }
    if (best && best.d >= cfg.repeatDice) {
      const who = best.e === entries[entries.length - 1] ? `上一${unit}` : refName(best.e, unit);
      add('repeat', `这${unit}跟${who}很像（「${clip(best.e.text, 20)}」），可以换个说法，或者让事情往前走一步。`);
    }
  }

  // ② 连着几条没推进：新字眼太少
  const seq = [...entries.map((e) => normText(e.text)), clean];
  const novelty = (i) => {
    const g = grams(seq[i]);
    if (g.size < 3) return 1;
    const prev = new Set();
    for (let j = Math.max(0, i - cfg.stallWindow); j < i; j += 1) for (const x of grams(seq[j])) prev.add(x);
    if (!prev.size) return 1;
    let fresh = 0;
    for (const x of g) if (!prev.has(x)) fresh += 1;
    return fresh / g.size;
  };
  if (entries.length >= cfg.stallWindow + cfg.stallRun - 1) {
    const run = [];
    for (let k = 0; k < cfg.stallRun; k += 1) run.push(novelty(seq.length - 1 - k));
    if (run.every((v) => v < cfg.stallNovelty)) add('stall', `连着${cfg.stallRun}${unit}都在说差不多的东西，新东西不多，故事像在原地打转。可以想想这一${unit}让什么变一变。`);
  }

  // ② 很久没碰到核心意象 / 主线
  const groups = coreGroups(st);
  const has = (t, words) => words.some((w) => t.includes(w));
  const gapOf = (words) => {
    let n = text ? 1 : 0; // prepare 里还没写，只数已有的
    let chars = len(text);
    for (let i = entries.length - 1; i >= 0; i -= 1) { if (has(entries[i].text, words)) return { n, chars }; n += 1; chars += len(entries[i].text); }
    return { n, chars };
  };
  if (groups.length) {
    const all = groups.flatMap((g) => g.words);
    let unionFired = false;
    if (!has(text, all)) {
      const { n, chars } = gapOf(all);
      if (n >= 3 && (n >= cfg.coreGapEntries || chars >= cfg.coreGapChars)) {
        // 2026-10-29 老大（姐姐整改）：提醒放软，每一节只提醒一次（key 'core'，见 novel.js 的 remind 记录）；这一节已经提醒过的话，主线那条还可以再单独提醒一次
        unionFired = add('core-gap', `连着${n}${unit}没怎么碰到设定里的核心意象（${groups.map((g) => g.words.slice(0, 2).join('/')).slice(0, 5).join('、')}）了。不急，想回到主线的时候可以回一下，不回也行。${themeTail}`, 'core');
      }
    }
    if (!unionFired) {
      for (const g of groups.filter((x) => x.main)) {
        if (has(text, g.words)) continue;
        const { n, chars } = gapOf(g.words);
        if (n >= 3 && (n >= cfg.mainGapEntries || chars >= cfg.mainGapChars)) add('core-gap', `连着${n}${unit}没怎么碰到主线那一组（${g.words.slice(0, 5).join('、')}，沾到其中任何一个词就算；书的规矩是爱藏着写，不用写明白）。想回主线时可以回一下，这一节不会再提醒。${themeTail}`, 'main');
      }
    }
  }

  // ③ 日记腔 / 流水账
  const dia = diaryScan(text, cfg);
  if (dia.score >= cfg.diaryScore) add('diary', `这${unit}读着有点像日记（${dia.hits.slice(0, 3).map((w) => (w.includes('「') ? w : `「${w}」`)).join('')}）。${themeTail}——可以想想这${unit}跟它有什么关系。`);

  // ④ 设定里写了不写的
  for (const r of bannedRules(st)) {
    const found = r.words.filter((w) => String(text).includes(w));
    if (found.length) add('banned', `这${unit}里有「${found.slice(0, 3).join('」「')}」，设定的「${r.from}」里写着「${clip(r.rule, 20)}」，要不要换个说法？`);
  }

  // ⑤ 长度
  if (L < cfg.minChars) add('length', `这${unit}有点短，读的人可能接不上；要是故意的就不用管。`);
  else if (L > cfg.maxChars) add('length', `这${unit}很长（${L} 字），一次写这么多容易水，可以拆成几次。`);
  else {
    const m = median(entries.slice(-10).map((e) => len(normText(e.text))));
    if (entries.length >= 4 && m && L > Math.max(cfg.longFactor * m, cfg.longMin)) add('length', `这${unit}比前面几${unit}长很多（${L} 字，前面一般 ${m} 字左右）；按现在的写法，可以拆开。`);
  }

  // 轮次：前面一直是两个人轮着写，这回还是同一个人（开新的一节不算：谁起头她们每节现商量）
  if (author && section !== 'new' && entries.length >= 4) {
    const tail = entries.slice(-6);
    const alternating = tail.every((e, i) => i === 0 || e.author !== tail[i - 1].author);
    const lastE = entries[entries.length - 1];
    if (alternating && lastE.author === author) add('turn', `上一${unit}也是你写的；前面一直是两个人轮着来，可以等对方接，想连着写也行。`);
  }
  // 这一节满了（写法里写了「每节 N 句」）
  const per = perSectionOf(st);
  const lastSec = entries.length ? entries[entries.length - 1].section : 0;
  if (per && section !== 'new' && lastSec && (section === null || Number(section) === lastSec)) {
    const n = entries.filter((e) => e.section === lastSec).length;
    if (n >= per) add('section-full', `第${lastSec}节已经 ${n} ${unit}了（写法里说每节 ${per} ${unit}），可以开新的一节（section 填 new）；想接着写也行。`);
  }
  return rs;
}

// ─────────────────────────── 分页 ───────────────────────────

function paginate(text, page = 1, size = 1500) {
  const sz = Math.max(200, Math.min(4000, Number(size) || 1500));
  const pages = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    const add = cur ? `${cur}\n${line}` : line;
    if (len(add) <= sz) { cur = add; continue; }
    if (cur) pages.push(cur);
    if (len(line) <= sz) { cur = line; continue; }
    const arr = [...line];
    for (let i = 0; i < arr.length; i += sz) pages.push(arr.slice(i, i + sz).join(''));
    cur = '';
  }
  if (cur || !pages.length) pages.push(cur);
  const p = Math.max(1, Math.min(pages.length, Math.floor(Number(page) || 1)));
  return { text: pages[p - 1], page: p, pages: pages.length, hasMore: p < pages.length };
}

// ─────────────────────────── 本子 ───────────────────────────

/**
 * @param {object} [opts]
 * @param {string} [opts.root]  数据根目录（默认 E:\qq-bridge\共享\合写）
 * @param {() => number} [opts.now]  主机时间（毫秒），测试注入
 * @param {number} [opts.skewMs]  主机时钟偏差；不给就读 state/clock-skew.json
 * @param {number} [opts.lockTimeoutMs]  等对方写完最多等多久
 * @param {number} [opts.staleLockMs]  锁文件放了多久算对方写到一半掉线了
 * @param {object} [opts.check]  盖掉 DEFAULT_CHECK 的阈值
 * @param {object} [opts.limits]  open 的长度：settingsChars / outlineChars / lastChars
 */
export function createNovel({ root = NOVEL_ROOT, now = () => Date.now(), skewMs, lockTimeoutMs = 5000, staleLockMs = 30000, check = {}, limits = {} } = {}) {
  const LIM = { settingsChars: 1500, outlineChars: 300, lastChars: 400, ...limits };
  const skew = () => (skewMs === undefined ? readSkew() : Number(skewMs) || 0);
  const stamp = () => { const ms = now(); return { ms, at: new Date(ms).toISOString(), bj: bjLabel(ms, skew()) }; };

  const dirOf = (book) => path.join(root, book);
  const fileOf = (book, k) => path.join(dirOf(book), FILES[k]);
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; } };

  /** 有哪些书。 */
  function list() {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch { return []; }
  }
  /** 书名可以只写前半截（「半只耳朵」能找到「半只耳朵——听不全那个字」）。 */
  function resolve(book) {
    const name = safeBookName(book);
    if (fs.existsSync(dirOf(name))) return name;
    const all = list();
    const hits = all.filter((d) => d.startsWith(name) || d.split(/——|—|：|:/)[0] === name);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`「${name}」能对上好几本：${hits.join('、')}，写全一点就行`);
    throw new Error(all.length ? `没找到《${name}》。现在有：${all.map((d) => `《${d}》`).join('、')}` : `没找到《${name}》，本子里还没有书；可以先建一本`);
  }
  function load(book) {
    const name = resolve(book);
    const settingsRaw = readText(fileOf(name, 'settings'));
    const bodyRaw = readText(fileOf(name, 'body'));
    const st = parseSettings(settingsRaw);
    const body = parseBody(bodyRaw);
    return { name, settingsRaw, bodyRaw, st, body, cfg: checkConfig(st, check) };
  }
  /** 2026-10-29：这一节里「很久没碰到核心意象 / 主线」已经提醒过哪几种（修改记录里 action:'remind' 的行）。 */
  function remindedKeys(book, section) {
    const out = new Set();
    try {
      for (const l of fs.readFileSync(fileOf(book, 'log'), 'utf8').split(String.fromCharCode(10))) {
        if (!l.includes('"remind"')) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.action === 'remind' && Number(j.section) === Number(section) && j.key) out.add(j.key);
      }
    } catch { /* 还没有记录 */ }
    return out;
  }
  function noteReminded(book, section, reminders, who = '') {
    const t0 = stamp();
    for (const r of reminders) if (r.key) log(book, { at: t0.at, bj: t0.bj, who, action: 'remind', section: Number(section), key: r.key });
  }
  function log(book, rec) {
    fs.appendFileSync(fileOf(book, 'log'), `${JSON.stringify(rec)}\n`, 'utf8');
  }
  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    for (let i = 0; ; i += 1) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        // Windows 上别人正开着读这个文件时 rename 会 EPERM，等一下再来
        if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
        const t = Date.now() + 25; while (Date.now() < t) { /* 很短，忙等 */ }
      }
    }
  }

  /** 跨进程写入锁：锁文件 + 超时；锁放太久（对方写到一半掉线）就当它作废。 */
  async function withLock(book, fn) {
    const lock = fileOf(book, 'lock');
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
        break;
      } catch (e) {
        if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        try {
          const st = fs.statSync(lock);
          if (Date.now() - st.mtimeMs > staleLockMs) {
            // 先改名再删：两个人同时发现锁过期，只有一个能改名成功，另一个接着等
            const gone = `${lock}.stale-${process.pid}-${Date.now()}`;
            try { fs.renameSync(lock, gone); fs.rmSync(gone, { force: true }); } catch { /* 被对方抢先处理了 */ }
            continue;
          }
        } catch { continue; /* 锁刚被放掉 */ }
        if (Date.now() - start > lockTimeoutMs) throw new Error('对方正在往本子里写，等一两秒再试一次就行');
        await sleep(20 + Math.floor(Math.random() * 40));
      }
    }
    try { return await fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
  }

  // ── 新建一本 ──
  async function createBook(book, author, { settings = '', title = '' } = {}) {
    const name = safeBookName(book);
    const who = normAuthor(author);
    if (fs.existsSync(dirOf(name))) throw new Error(`《${name}》已经有了，可以直接打开`);
    fs.mkdirSync(dirOf(name), { recursive: true });
    return withLock(name, () => {
      const t = stamp();
      fs.writeFileSync(fileOf(name, 'settings'), settings || settingsTemplate(name), 'utf8');
      fs.writeFileSync(fileOf(name, 'body'), bodyHeader(title || name), 'utf8');
      log(name, { at: t.at, bj: t.bj, who, action: 'create', note: '新建' });
      return { book: name, text: `《${name}》建好了。可以先两个人一起把设定集填上：这本书在说什么、核心意象、不写什么——换多少次会话都靠它记得这本书是什么。` };
    });
  }

  // ── 打开：每次写之前带上的东西 ──
  function settingsDigest(st, max) {
    const order = ['书名', '主题', '规矩', '不写什么', '核心意象', '写法', '人物', '扉页', '来历'];
    const skip = ['大纲', '检查设置'];
    const secs = [...st.sections].filter((s) => !skip.some((k) => keyOf(s.head).startsWith(k)));
    secs.sort((a, b) => {
      const ia = order.findIndex((k) => keyOf(a.head).startsWith(k));
      const ib = order.findIndex((k) => keyOf(b.head).startsWith(k));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const out = [];
    const left = [];
    let used = 60; // 给最后那行「没带上：……」留位置，整段不超过 max
    for (const s of secs) {
      const body = s.body.filter((l) => l.trim() && !/^\s*>/.test(l)).join('\n');
      const block = `■ ${s.head}\n${body}`;
      const room = max - used;
      if (room < 40) { left.push(s.head); continue; }
      const piece = len(block) <= room ? block : clip(block, room);
      out.push(piece);
      used += len(piece) + 1;
    }
    let text = out.join('\n');
    if (left.length) text += `\n（没带上：${left.map((h) => h.split(/[（(—]/)[0].trim()).join('、')}——要看可以翻设定集）`;
    return text;
  }
  function outlineDigest(st, max) {
    const s = sec(st, '大纲');
    if (!s) return '（设定集里还没有大纲）';
    const lines = s.body.filter((l) => l.trim() && !/^\s*>/.test(l));
    const prog = lines.filter((l) => /进度/.test(l));
    const rest = lines.filter((l) => !/进度/.test(l));
    return clip([...prog, ...rest].join('\n'), max);
  }
  function statsLine(body) {
    const es = body.entries;
    const unit = unitOf(es);
    if (!es.length) return '正文还是空的。';
    const last = es[es.length - 1];
    return `现在：${body.sections.length} 节、${es.length} ${unit}；最后一${unit}是${last.author} ${last.time.slice(5)} 写的（第${last.section}节第${last.seq}${unit}）。`;
  }
  const showEntry = (e, max = 400) => `〔${e.id}｜${e.author}〕${clip(e.text, max)}`;

  function open(book) {
    const { name, st, body, settingsRaw } = load(book);
    const unit = unitOf(body.entries);
    const parts = [`《${name}》合写本子`];
    if (!settingsRaw.trim()) parts.push('（这本书还没有设定集。可以先两个人一起写一份：这本书在说什么、核心意象、不写什么——不然换了会话容易忘了它在写什么。）');
    else {
      parts.push(`【设定集】两个人一起定的，写之前先看一眼：\n${settingsDigest(st, LIM.settingsChars)}`);
      parts.push(`【大纲和进度】\n${outlineDigest(st, LIM.outlineChars)}`);
    }
    parts.push(statsLine(body));
    const lastTwo = body.entries.slice(-2);
    if (lastTwo.length) parts.push(`【最后两${unit}】\n${lastTwo.map((e) => showEntry(e, LIM.lastChars)).join('\n')}`);
    parts.push('要看更多可以翻：某一节、最后几句、大纲、设定集全文。');
    return { book: name, text: parts.join('\n\n'), sections: body.sections.length, entries: body.entries.length, last: lastTwo.map(({ id, author, time, text }) => ({ id, author, time, text })) };
  }

  // ── 按需读 ──
  function read(book, { section = null, last = null, outline = false, settings = false, page = 1, pageSize = 1500 } = {}) {
    const { name, st, body, settingsRaw } = load(book);
    const unit = unitOf(body.entries);
    let text;
    if (settings) text = settingsRaw.trim() || '（还没有设定集）';
    else if (outline) {
      const s = sec(st, '大纲');
      const rows = body.sections.map((x) => {
        const es = x.entries;
        if (!es.length) return `第${x.n}节${x.title ? ` · ${x.title}` : ''}：还没写`;
        return `第${x.n}节${x.title ? ` · ${x.title}` : ''}：${es.length} ${unit}，${es[0].author}起头。开头「${clip(es[0].text, 24)}」……收在「${clip(es[es.length - 1].text, 24)}」`;
      });
      text = `${s ? `■ ${s.head}\n${s.body.join('\n')}` : '（设定集里还没有大纲）'}\n\n■ 每一节\n${rows.join('\n') || '（正文还是空的）'}\n\n${statsLine(body)}`;
    } else if (section !== null && section !== undefined && section !== '') {
      const n = Number(section);
      const x = body.sections.find((s) => s.n === n);
      if (!x) throw new Error(`没有第${section}节；现在一共 ${body.sections.length} 节`);
      text = [`第${x.n}节${x.title ? ` · ${x.title}` : ''}`, ...x.entries.map((e) => `〔${e.id}｜${e.author}｜${e.time}${e.edited ? `｜改过 ${e.edited}` : ''}〕${e.text}`), ...x.notes.filter((l) => l.trim()).map((l) => `（记：${l}）`)].join('\n');
    } else {
      const n = Math.max(1, Math.min(30, Number(last) || 5));
      const es = body.entries.slice(-n);
      text = es.length ? es.map((e) => `〔${e.id}｜${e.author}｜${e.time}〕${e.text}`).join('\n') : '（正文还是空的）';
    }
    return { book: name, ...paginate(text, page, pageSize) };
  }

  // ── 写之前的提示 ──
  function prepare(book, author) {
    const who = normAuthor(author);
    const { name, st, body, cfg } = load(book);
    const es = body.entries;
    const unit = unitOf(es);
    const theme = themeLine(st);
    const lastE = es[es.length - 1];
    const lastSec = body.sections[body.sections.length - 1];
    const per = perSectionOf(st);
    const lines = [`《${name}》接着写之前：`];
    lines.push(theme ? `- 这本书在说：${clip(theme, 80)}` : '- 设定集里还没写主题；可以先两个人一起补一句「这本书在说什么」。');
    if (lastSec) {
      const n = lastSec.entries.length;
      let pos = `- 现在在第${lastSec.n}节，已经 ${n} ${unit}`;
      if (per) pos += n >= per ? `（每节 ${per} ${unit}，这一节满了，可以开第${lastSec.n + 1}节）` : `（每节 ${per} ${unit}，还差 ${per - n} ${unit}）`;
      lines.push(`${pos}。`);
      const hit = outlineLine(st, lastSec.n);
      const nextHit = outlineLine(st, lastSec.n + 1);
      if (hit) lines.push(`- 大纲里这一节：${clip(hit.replace(/^\s*[-*]\s*/, ''), 80)}`);
      if (nextHit) lines.push(`- 大纲里下一节：${clip(nextHit.replace(/^\s*[-*]\s*/, ''), 80)}`);
      if (!nextHit && (!hit || (per && n >= per))) lines.push(`- 大纲里还没写到第${hit ? lastSec.n + 1 : lastSec.n}节，往哪推你们俩商量着来。`);
    } else lines.push('- 正文还是空的，这是第一句。');
    if (lastE) {
      const full = per && lastSec && lastSec.entries.length >= per;
      lines.push(`- ${full ? '上一节结尾' : `上一${unit}`}（${lastE.author}写的）：「${clip(lastE.text, 120)}」`);
      // 开新的一节谁起头她们现商量，不提轮次
      if (!full && lastE.author === who && es.length >= 2 && es[es.length - 2].author !== who) lines.push(`- 上一${unit}也是你写的；轮着写的话可以等对方接。`);
    }
    const rules = items(sec(st, '规矩'));
    if (rules.length) lines.push(`- 两人一起定的规矩：${rules.map((r) => clip(r.replace(/[。；]$/, ''), 40)).slice(0, 6).join('；')}`);
    const no = items(sec(st, '不写什么'));
    if (no.length) lines.push(`- 不写：${no.map((r) => clip(r.replace(/[（(](?:关键)?词[:：][^）)]*[）)]/g, ''), 24)).slice(0, 6).join('；')}`);
    // 很久没碰到的核心意象，先提一句
    const preSec = lastSec ? lastSec.n : 1;
    const pre = analyzeText(es, st, '', { cfg: { ...cfg, minChars: 0, recent: 0 }, reminded: remindedKeys(name, preSec) }).filter((r) => r.kind === 'core-gap');
    for (const r of pre) lines.push(`- ${r.text}`);
    if (pre.length) noteReminded(name, preSec, pre, who);
    lines.push('- 写完工具会帮你看一眼（重复、原地打转、日记腔、设定里不写的）；只是提醒，写不写你自己定。');
    return { book: name, text: lines.join('\n'), theme, section: lastSec ? lastSec.n : 0, last: lastE ? { id: lastE.id, author: lastE.author, text: lastE.text } : null };
  }

  // ── 检查 ──
  function checkBook(book, text, { author = '', section = null } = {}) {
    const { name, st, body, cfg } = load(book);
    const reminders = analyzeText(body.entries, st, String(text ?? ''), { cfg, author: author ? normAuthor(author) : '', section });
    return { book: name, reminders, text: reminders.length ? reminders.map((r) => `- ${r.text}`).join('\n') : '看了一眼，没什么要提醒的。' };
  }

  // ── 接着写：只往后加 ──
  async function append(book, author, text, { section = null, title = '', confirm = true } = {}) {
    const who = normAuthor(author);
    const name = resolve(book);
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    if (!clean) throw new Error('没有要写的内容');
    if (len(clean) > HARD_MAX) throw new Error(`一次写了 ${len(clean)} 字，太长了；可以分几次接着写（一次 ${HARD_MAX} 字以内）`);
    if (/^\s*(?:- 〔|##\s*第|>)/m.test(clean)) throw new Error('开头别用「- 〔」「## 第」「>」，这几个是本子自己的格式');
    return withLock(name, () => {
      const { bodyRaw, st, body, cfg } = load(name);
      const lastSec = body.sections[body.sections.length - 1];
      const lastN = lastSec ? lastSec.n : 0;
      let target;
      if (section === 'new' || section === '新') target = lastN + 1;
      else if (section === null || section === undefined || section === '') target = lastN || 1;
      else {
        target = Number(section);
        if (!Number.isInteger(target) || target < 1) throw new Error('section 填节号（数字），开新的一节填 new');
        if (target < lastN) throw new Error(`第${target}节已经过去了；本子只能往后加——接在第${lastN}节后面，或者开新的一节（new）`);
        if (target > lastN + 1) throw new Error(`现在写到第${lastN}节，下一节是第${lastN + 1}节，不能跳到第${target}节`);
      }
      const isNew = !lastSec || target > lastN;
      const reminders = analyzeText(body.entries, st, clean, { cfg, author: who, section: isNew ? 'new' : target, reminded: isNew ? new Set() : remindedKeys(name, target) });
      const secEntries = isNew ? [] : lastSec.entries;
      const t = stamp();
      const entry = { section: target, seq: (secEntries.length ? Math.max(...secEntries.map((e) => e.seq)) : 0) + 1, author: who, time: t.bj, text: clean };
      const preview = formatEntry(entry).join('\n');
      if (confirm === false) {
        return { book: name, written: false, preview, reminders, text: `先看了一眼，还没写进去。\n${reminders.length ? reminders.map((r) => `- ${r.text}`).join('\n') : '- 没什么要提醒的。'}\n想写进去就再来一次（不带 confirm:false）。` };
      }
      const eol = eolOf(bodyRaw || '\n');
      let chunk = '';
      if (!bodyRaw) chunk += bodyHeader(name).replace(/\n/g, eol);
      else if (!/\n$/.test(bodyRaw)) chunk += eol;
      if (isNew) chunk += `${eol}## 第${target}节${title ? ` · ${String(title).replace(/[\r\n]/g, ' ').trim()}` : ''}${eol}${eol}`;
      chunk += formatEntry(entry).join(eol) + eol;
      fs.appendFileSync(fileOf(name, 'body'), chunk, 'utf8');
      const id = `${entry.section}-${entry.seq}`;
      log(name, { at: t.at, bj: t.bj, who, action: 'append', ref: id, after: clean });
      noteReminded(name, target, reminders, who);
      const unit = unitOf([...body.entries, entry]);
      const per = perSectionOf(st);
      const hint = per && entry.seq >= per ? `第${target}节写满 ${per} ${unit}了，可以两个人回头看一眼这一节（sectionDone）。` : '';
      const head = `写进去了：第${target}节第${entry.seq}${unit}，署名${who}，${t.bj}。`;
      return { book: name, written: true, id, section: target, seq: entry.seq, author: who, time: t.bj, reminders, hint, text: [head, ...reminders.map((r) => `- ${r.text}`), hint].filter(Boolean).join('\n') };
    });
  }

  // ── 改：只能改自己写的 ──
  async function edit(book, author, ref, newText, { note = '' } = {}) {
    const who = normAuthor(author);
    const name = resolve(book);
    const id = String(ref ?? '').trim().replace(/^第?(\d+)节第?(\d+)[句段]?$/, '$1-$2');
    if (!/^\d+-\d+$/.test(id)) throw new Error('要说改哪一句，比如 3-5（第3节第5句）');
    const clean = String(newText ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    if (!clean) throw new Error('改成什么还没写；想删掉的话跟对方商量，本子里不删句子');
    if (len(clean) > HARD_MAX) throw new Error(`太长了（${len(clean)} 字），${HARD_MAX} 字以内`);
    if (/^\s*(?:- 〔|##\s*第|>)/m.test(clean)) throw new Error('开头别用「- 〔」「## 第」「>」，这几个是本子自己的格式');
    return withLock(name, () => {
      const { bodyRaw, body, st, cfg } = load(name);
      const e = body.entries.find((x) => x.id === id);
      if (!e) throw new Error(`没找到 ${id} 这一句`);
      if (e.author !== who) throw new Error(`这一句是${e.author}写的，只能她自己改；想改的话可以跟她商量`);
      if (e.text === clean) return { book: name, changed: false, id, text: '跟原来一样，没改。' };
      const t = stamp();
      const eol = eolOf(bodyRaw);
      const lines = bodyRaw.split(/\r?\n/);
      const fresh = formatEntry({ ...e, text: clean, edited: t.bj });
      lines.splice(e.line, e.lines, ...fresh);
      writeAtomic(fileOf(name, 'body'), lines.join(eol));
      log(name, { at: t.at, bj: t.bj, who, action: 'edit', ref: id, before: e.text, after: clean, ...(note ? { note: String(note).slice(0, 200) } : {}) });
      const others = body.entries.filter((x) => x.id !== id && (x.section < e.section || (x.section === e.section && x.seq < e.seq)));
      const reminders = analyzeText(others, st, clean, { cfg }).filter((r) => !['turn', 'section-full'].includes(r.kind));
      return { book: name, changed: true, id, reminders, text: [`改好了：${id}，原来那句留在修改记录里。`, ...reminders.map((r) => `- ${r.text}`)].join('\n') };
    });
  }

  // ── 改设定集：两个人一起定的东西，留记录 ──
  async function updateSettings(book, author, patch, note = '') {
    const who = normAuthor(author);
    const name = resolve(book);
    if (patch === null || patch === undefined || (typeof patch !== 'string' && typeof patch !== 'object')) throw new Error('要给改的内容：{ "大纲和进度": "……" } 这样一块一块地改');
    return withLock(name, () => {
      const file = fileOf(name, 'settings');
      const before = readText(file);
      const eol = eolOf(before || '\n');
      let after;
      const changed = [];
      if (typeof patch === 'string') { after = patch.replace(/\r\n?/g, '\n'); changed.push('整份'); }
      else {
        const lines = before.split(/\r?\n/);
        for (const [rawKey, val] of Object.entries(patch)) {
          const key = String(rawKey).replace(/^#+\s*/, '').trim();
          if (!key) continue;
          let start = lines.findIndex((l) => { const m = H2_RE.exec(l.trimEnd()); return m && keyOf(m[1]).startsWith(keyOf(key)); });
          if (val === null) {
            if (start < 0) continue;
            let end = start + 1;
            while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
            lines.splice(start, end - start);
            changed.push(`删了「${key}」`);
            continue;
          }
          const content = String(val).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
          if (start < 0) {
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
            lines.push('', `## ${key}`, ...content, '');
            changed.push(`加了「${key}」`);
          } else {
            let end = start + 1;
            while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
            lines.splice(start + 1, end - start - 1, ...content, '');
            changed.push(`改了「${H2_RE.exec(lines[start].trimEnd())[1]}」`);
          }
        }
        after = lines.join('\n');
      }
      if (after.replace(/\s+$/, '') === before.replace(/\r\n/g, '\n').replace(/\s+$/, '')) return { book: name, changed: false, text: '跟原来一样，没改。' };
      writeAtomic(file, `${after.replace(/\s+$/, '')}\n`.replace(/\n/g, eol));
      const t = stamp();
      log(name, { at: t.at, bj: t.bj, who, action: 'settings', changed, note: String(note || '').slice(0, 300), before, after });
      const tips = ['这是两个人一起定的东西，改之前跟对方说一声；改的记录留着（谁改的、为什么）。'];
      if (!String(note || '').trim()) tips.push('这回没写为什么改，可以补一句，以后翻记录的时候知道当时怎么想的。');
      return { book: name, changed: true, parts: changed, text: [`设定集${changed.join('、')}。`, ...tips.map((x) => `- ${x}`)].join('\n') };
    });
  }

  // ── 一节写完：回头看一眼 ──
  function sectionDone(book, section = null) {
    const { name, st, body, cfg } = load(book);
    const x = section === null || section === undefined || section === '' ? body.sections[body.sections.length - 1] : body.sections.find((s) => s.n === Number(section));
    if (!x || !x.entries.length) throw new Error(section ? `第${section}节还没写` : '正文还是空的');
    const unit = unitOf(body.entries);
    const es = x.entries;
    const theme = themeLine(st);
    const groups = coreGroups(st);
    const allText = es.map((e) => e.text).join('\n');
    const met = [];
    const missed = [];
    for (const g of groups) {
      const n = g.words.reduce((s, w) => s + (allText.split(w).length - 1), 0);
      const label = g.words.slice(0, 2).join('/');
      (n ? met : missed).push(n ? `${label}（${n} 处）` : label);
    }
    // 回放一遍：这一节里哪几句写的时候会被提醒（日记腔 / 设定里不写的 / 重复）
    const flagged = [];
    const before = body.entries.filter((e) => e.section < x.n);
    es.forEach((e, i) => {
      const rs = analyzeText([...before, ...es.slice(0, i)], st, e.text, { cfg }).filter((r) => ['diary', 'banned', 'repeat'].includes(r.kind));
      if (rs.length) flagged.push(`${e.id}：${rs.map((r) => ({ diary: '像日记', banned: '有设定里不写的', repeat: '跟前面很像' })[r.kind]).join('、')}`);
    });
    const olLine = outlineLine(st, x.n);
    const lines = [`第${x.n}节写完了：${es.length} ${unit}，${es[0].author}起头，收在「${clip(es[es.length - 1].text, 40)}」`, '可以两个人一起回头看一眼：'];
    lines.push(theme ? `- 书的主题：${clip(theme, 80)}——这一节跟它是什么关系？哪一${unit}最贴？` : '- 设定集里还没写主题，正好借这一节想想：这本书到底在说什么。');
    if (groups.length) lines.push(`- 这一节碰到的核心意象：${met.join('、') || '一个都没有'}${missed.length ? `；没碰到：${missed.join('、')}` : ''}。`);
    lines.push(olLine ? `- 大纲里第${x.n}节写的是：${clip(olLine.replace(/^\s*[-*]\s*/, ''), 80)}——对得上吗？` : `- 大纲里还没有第${x.n}节，可以一起补一句这一节写了什么。`);
    lines.push('- 下一节往哪推，要不要跟着改大纲；改设定集和大纲是两个人一起定的事，改了会留记录。');
    if (flagged.length) lines.push(`- 写的时候被提醒过的：${flagged.slice(0, 6).join('；')}`);
    return { book: name, section: x.n, text: lines.join('\n'), met, missed, flagged };
  }

  return { root, list, resolve, createBook, open, read, prepare, check: checkBook, append, edit, updateSettings, sectionDone };
}

function bodyHeader(title) {
  return `# ${title} · 正文\n\n> 合写本子：每一条前面的〔〕是编号、谁写的、什么时候写的（北京时间）。接着写、改自己的句子都可以用工具；直接改这个文件的话，格式乱了工具会认不出来。\n`;
}

/** 新书的设定集空模板。 */
export function settingsTemplate(name) {
  return [
    `# 设定集：${name}`,
    '',
    '> 两个人一起定的东西。每次打开或接着写，都会先带上这一页。改之前跟对方说一声，改了会留记录。',
    '',
    '## 书名', `《${name}》`, '',
    '## 主题（这本书在说什么）', '一句话：', '',
    '## 核心意象', '- （一行一个，比如「- 耳朵 / 听（主线）：说明」；冒号前面的词写的时候会被留意）', '',
    '## 人物', '- ', '',
    '## 规矩（两个人一起定的）', '- ', '',
    '## 不写什么', '- （一行一条；要查的词写在「（词：a、b）」里）', '',
    '## 写法分工', '- ', '',
    '## 大纲和进度', '进度：还没开始。', ''
  ].join('\n');
}

// 「她们俩的网页」要读的东西（2026-10-29 控制台施工单 A）。全部只读：读不到的地方给 { ok: false, reason: '暂时读不到：…' }，不抛错。
//
// 两个人（who：'fish' 小鲸鱼 / 'sister' 姐姐）各自的东西从哪来：
//   心情      小鲸鱼 ~/.dsh/feiyu-mood/state.json；姐姐 脑子/最近/心情.json（格式一样，见 mood.js）
//   激素      小鲸鱼 state/hormones-fish.jsonl；姐姐 sister/state/hormones-sister.jsonl（hormone-shadow.js 写的，每分钟一行）
//   记忆      路径都从 brains.js 的 createBrains 取（想起的 recall-log、瞬间、便签、self、碎碎念、日记、印象、交接）
//   在外面玩  抖音插件 state/、explore-impressions.jsonl、bili-watch.jsonl、姐姐的 日子/逛过的.jsonl
//   运行情况  bridge.log / sister.log 的错误行、妈妈信箱、花费（只在网页里给老大看，绝不进她们的提示）
// 这个文件**不写任何文件**。时间一律返回本机毫秒（at），网页按 /api/daughters/meta 给的 skewMs 校成北京时间。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MOOD_BASE, MOOD_DIMS, decayMood, moodWord, overlayMood, readMoodFile, readPush } from './mood.js';
import { summarize } from './hormone-shadow.js';
import { createNovel } from './novel.js';
import { normalizeUsage, priceUsage, totalTokensOf, ZERO_BUCKETS, addBuckets } from './model-prices.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

export const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
const unavailable = (what, err) => ({ ok: false, reason: `暂时读不到：${what}${err ? `（${clip(err?.message ?? err, 80)}）` : ''}` });

// ── 读文件的小工具 ──────────────────────────────────────────────────────────

export function readText(file, max = 20000) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return t.length > max ? `${t.slice(0, max)}\n……（后面还有，这里只给前 ${max} 字）` : t;
  } catch { return null; }
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
export function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
/** 文件末尾的几行（大文件只读最后一段）。 */
export function tailLines(file, n = 50, maxBytes = 512 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let lines = buf.toString('utf8').split('\n');
      if (size > len) lines = lines.slice(1); // 第一行可能是半截
      return lines.filter((l) => l.trim()).slice(-n);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}
export function tailJsonl(file, n = 50, maxBytes = 512 * 1024) {
  const out = [];
  for (const l of tailLines(file, n, maxBytes)) { try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ } }
  return out;
}

// ── 行级 diff（self 页改了什么）────────────────────────────────────────────

/** 最小的行级 diff（LCS）。返回 [{ t: ' ' | '+' | '-', s }]；太长就只给个说明。 */
export function lineDiff(oldText, newText, maxLines = 600) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length > maxLines || b.length > maxLines) return [{ t: ' ', s: `（太长了，没做对比：旧 ${a.length} 行，新 ${b.length} 行）` }];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i += 1; } else { out.push({ t: '+', s: b[j] }); j += 1; }
  }
  while (i < n) { out.push({ t: '-', s: a[i] }); i += 1; }
  while (j < m) { out.push({ t: '+', s: b[j] }); j += 1; }
  return out;
}

const LV_LABEL = {
  sleepy: '困', longingOwner: '想老大', longingSister: '想姐妹', curiosity: '好奇', stress: '压力', satisfaction: '满足', alert: '警觉',
  boredom: '无聊', security: '被在乎', createUrge: '想写东西', pride: '成就感', grievance: '委屈', guard: '拉不下脸', focus: '专注'
};
const BEHAVIOR_LABEL = {
  ownerPing: '找老大', sisterPing: '找姐妹', groupChat: '水群', explore: '去逛', journal: '写碎碎念/日记', novel: '写小说',
  post: '发说说', sticker: '发表情', peekOwner: '看老大电脑', nap: '打盹'
};
export const HORMONE_LABELS = Object.freeze({ levels: LV_LABEL, behaviors: BEHAVIOR_LABEL });

/** 本机毫秒 → 北京日期 'YYYY-MM-DD'（skew 是本机比真实时间快的毫秒数）。 */
export function bjDay(hostMs, skew = 0) {
  return new Date(hostMs - skew + 8 * HOUR).toISOString().slice(0, 10);
}

function httpGetJson(port, pathname, { timeoutMs = 800, headers = {} } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
          done({ status: res.statusCode, body });
        });
        res.on('error', () => done(null));
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.end();
    } catch { done(null); }
  });
}
export { httpGetJson };

/**
 * @param {object} o
 * @param {object} o.brains createBrains(root) 的结果
 * @param {string} o.stateDir 桥接 state/（小鲸鱼的）
 * @param {string} o.sisterStateDir sister/state（姐姐的）
 * @param {() => number} [o.skewMs] 本机时钟比真实时间快多少毫秒
 * @param {() => number} [o.now] 本机毫秒
 * @param {string} [o.douyinStateDir]
 * @param {string} [o.feiyuMoodFile]
 * @param {string} [o.noveRoot]
 * @param {object} [o.priceTable]
 * @param {string} [o.tokenUsageFile]
 * @param {number} [o.memoryPort]
 * @param {number} [o.douyinCdpPort]
 */
export function createDaughtersData({
  brains, stateDir, sisterStateDir, skewMs = () => 0, now = () => Date.now(), douyinStateDir = '', feiyuMoodFile = '', novelRoot = '',
  priceTable, tokenUsageFile = '', memoryPort = 3210, douyinCdpPort = 9227, selfHistoryDir = '', pcShotsDir = '',
  fishMoodPushFile = '', sisterMoodPushFile = '' // 2026-10-29 施工单 C：激素推动量文件，心情读叠好的（跟她们自己读到的一致）
} = {}) {
  const skew = () => { try { return Number(skewMs()) || 0; } catch { return 0; } };
  const brainOf = (who) => brains.brainOf(who === 'fish' ? 'whale' : 'sister');
  const stateOf = (who) => (who === 'fish' ? stateDir : sisterStateDir);
  const label = (who) => (who === 'fish' ? '小鲸鱼' : '姐姐');
  const hostNow = () => now();

  // ── 心情 ──────────────────────────────────────────────────────────────────
  function mood(who) {
    try {
      const b = brainOf(who);
      const file = who === 'fish' ? (feiyuMoodFile || path.join(brains.DSH_DIR, 'feiyu-mood', 'state.json')) : b.mood;
      const pushFile = who === 'fish' ? fishMoodPushFile : sisterMoodPushFile;
      const st = overlayMood(readMoodFile(file), pushFile ? readPush(pushFile) : null, hostNow());
      if (!st) return { ...unavailable(who === 'fish' ? '心情插件还没有记录' : '她还没有调过心情'), source: file };
      const t = hostNow();
      const d = decayMood(st, t);
      const tl = (Array.isArray(st.timeline) ? st.timeline : []).filter((r) => r && Number.isFinite(+r.at));
      const since = t - DAY;
      const curve = tl.filter((r) => r.at >= since).map((r) => ({ at: r.at, mood: Number(r.mood) }));
      curve.push({ at: t, mood: Math.round(d.mood * 10) / 10 });
      return {
        ok: true,
        source: who === 'fish' ? '心情插件的 state.json（叠上激素的推动量）' : '她脑子里的 最近/心情.json（叠上激素的推动量）',
        updatedAt: Number(st.updatedAt) || mtimeOf(file),
        score: Math.round(d.mood),
        base: MOOD_BASE,
        word: moodWord(d.mood),
        dims: MOOD_DIMS.map(([k, name]) => ({ key: k, name, value: Math.round(d.dims[k] * 10) / 10, saved: Number(st.dims?.[k]) || 0 })),
        reason: oneLine(st.lastReason, 300),
        curve,
        recent: tl.slice(-12).reverse().map((r) => ({ at: r.at, mood: r.mood, delta: r.delta, reason: oneLine(r.reason, 200) }))
      };
    } catch (e) { return unavailable('心情', e); }
  }

  // ── 激素 ──────────────────────────────────────────────────────────────────
  /** 最近 hours 小时的行（最多读 3 MB），时间升序。 */
  function hormoneRows(who, hours = 24) {
    const file = path.join(stateOf(who), `hormones-${who}.jsonl`);
    const cutoff = hostNow() - hours * HOUR;
    const rows = tailJsonl(file, 3000, 3 * 1024 * 1024).filter((r) => Date.parse(r.at) >= cutoff);
    return { file, rows };
  }
  function hormones(who, { hours = 24, enabled = null } = {}) {
    try {
      const { file, rows } = hormoneRows(who, hours);
      if (rows.length === 0) return { ...unavailable('激素记录还没有（影子记录没开，或刚开）'), source: file, enabled };
      const last = rows[rows.length - 1];
      const keys = Object.keys(LV_LABEL).filter((k) => rows.some((r) => Number.isFinite(r.lv?.[k])) && (['satisfaction', 'alert'].every((x) => x !== k) || new Set(rows.map((r) => r.lv?.[k])).size > 1));
      const stride = Math.max(1, Math.ceil(rows.length / 240));
      const points = [];
      rows.forEach((r, i) => {
        if (i % stride === 0 || i === rows.length - 1 || (r.would || []).length > 0) {
          points.push({ t: Date.parse(r.at), asleep: !!r.asleep, lv: Object.fromEntries(keys.map((k) => [k, r.lv?.[k] ?? null])) });
        }
      });
      const would = rows.filter((r) => (r.would || []).length > 0).slice(-60).map((r) => ({ t: Date.parse(r.at), what: r.would.map((b) => BEHAVIOR_LABEL[b] || b), felt: r.felt || '' }));
      const sum = summarize(file, bjDay(Date.parse(last.at), skew()));
      return {
        ok: true,
        source: file.replace(/^.*[\\/]/, ''),
        enabled: enabled === null ? hostNow() - Date.parse(last.at) < 5 * 60e3 : enabled,
        updatedAt: Date.parse(last.at),
        asleep: !!last.asleep,
        felt: last.felt || '',
        keys: keys.map((k) => ({ key: k, name: LV_LABEL[k] })),
        now: Object.fromEntries(keys.map((k) => [k, last.lv?.[k] ?? null])),
        points,
        would,
        wouldCount: Object.fromEntries(Object.entries(sum.would || {}).map(([b, n]) => [BEHAVIOR_LABEL[b] || b, n])),
        summary: sum.text || ''
      };
    } catch (e) { return unavailable('激素', e); }
  }

  // ── 记忆和成长 ────────────────────────────────────────────────────────────
  function recall(who) {
    const b = brainOf(who);
    const rows = tailJsonl(b.recallLog, 12, 256 * 1024);
    return rows.reverse().map((r) => ({
      at: r.at, mode: r.mode, q: oneLine(r.q, 120),
      picks: (r.picks || []).slice(0, 4).map((p) => ({ label: p.label, score: p.score, preview: oneLine(p.preview, 140) }))
    }));
  }
  function moments(who, limit = 12) {
    const b = brainOf(who);
    let files = [];
    try { files = fs.readdirSync(b.momentsDir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    const all = [];
    for (const f of files) for (const r of tailJsonl(path.join(b.momentsDir, f), 25, 128 * 1024)) if (r && r.at) all.push(r);
    all.sort((x, y) => y.at - x.at);
    return all.slice(0, limit).map((r) => ({
      id: r.id, at: r.at, key: r.key, who: r.who,
      them: oneLine((r.them || []).join('；'), 180), me: oneLine((r.me || []).join('；'), 180),
      inner: oneLine(r.inner, 300), felt: oneLine(r.felt, 160), mood: r.mood || null, tags: r.tags || [], source: r.source || ''
    }));
  }
  function selfPage(who) {
    const b = brainOf(who);
    const text = readText(b.self, 30000);
    if (text === null) return unavailable('self 这一页');
    const mt = mtimeOf(b.self);
    // 有备份才做对比：小鲸鱼每次改都会把上一版放进 state/agents/self-history/；姐姐没有的话看同目录的 .bak*
    let prevFile = '';
    try {
      const dirs = who === 'fish' && selfHistoryDir ? [[selfHistoryDir, (f) => f.endsWith('.md')]] : [];
      dirs.push([path.dirname(b.self), (f) => f.startsWith(path.basename(b.self)) && /\.bak/.test(f)]);
      for (const [dir, ok] of dirs) {
        const names = fs.readdirSync(dir).filter(ok).map((f) => path.join(dir, f)).map((f) => [f, mtimeOf(f)]).sort((x, y) => y[1] - x[1]);
        if (names.length) { prevFile = names[0][0]; break; }
      }
    } catch { /* 没有备份 */ }
    const prev = prevFile ? readText(prevFile, 30000) : null;
    return {
      ok: true, source: path.basename(b.self), mtime: mt, text,
      hasBackup: prev !== null, prevMtime: prevFile ? mtimeOf(prevFile) : 0,
      diff: prev !== null ? lineDiff(prev, text).filter((d, i, arr) => d.t !== ' ' || arr.slice(Math.max(0, i - 1), i + 2).some((x) => x.t !== ' ')) : []
    };
  }
  function latestRambling(who) {
    const b = brainOf(who);
    const t = readText(b.rambling, 200000);
    if (t === null) return { ok: false, reason: '暂时读不到：她还没写过碎碎念' };
    const parts = t.split(/\n(?=\d{1,2}月\d{1,2}日\s*\n)/);
    return { ok: true, mtime: mtimeOf(b.rambling), text: clip(parts[parts.length - 1].trim(), 3000) };
  }
  function latestDiary(who) {
    const b = brainOf(who);
    try {
      const names = fs.readdirSync(b.diaryDir).filter((f) => f.endsWith('.md')).sort();
      if (!names.length) return { ok: false, reason: '暂时读不到：还没有日记' };
      const f = path.join(b.diaryDir, names[names.length - 1]);
      return { ok: true, name: names[names.length - 1], mtime: mtimeOf(f), text: clip(readText(f, 6000) || '', 3000) };
    } catch { return { ok: false, reason: '暂时读不到：还没有日记' }; }
  }
  function growth(who) {
    const b = brainOf(who);
    const t = readText(b.growth, 60000);
    if (t === null) return { ok: false, reason: '暂时读不到：还没有成长札记' };
    const lines = t.split('\n').filter((l) => l.startsWith('- ')).slice(-6);
    return { ok: true, mtime: mtimeOf(b.growth), lines: lines.map((l) => clip(l, 300)) };
  }
  function impressions(who) {
    const b = brainOf(who);
    const j = readJson(b.impressions);
    if (!j || typeof j !== 'object') return { ok: false, reason: '暂时读不到：还没有印象' };
    const list = Object.entries(j).map(([uid, v]) => ({
      uid: String(uid).replace(/\d(?=\d{4})/g, '•'), // 号码只留末四位
      name: v.name || '', score: Number(v.score) || 0, updatedAt: Number(v.updatedAt) || 0,
      note: oneLine(v.notes?.[v.notes.length - 1]?.text, 160)
    })).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 14);
    return { ok: true, count: Object.keys(j).length, list };
  }
  function simpleDoc(file, max = 5000) {
    const t = readText(file, max);
    return t === null ? { ok: false, reason: '暂时读不到：这一页还没有' } : { ok: true, mtime: mtimeOf(file), text: t };
  }
  function novels() {
    try {
      const root = novelRoot || brains.NOVEL_ROOT;
      const nv = createNovel({ root, skewMs: skew() });
      const out = [];
      for (const name of nv.list().slice(0, 6)) {
        try {
          const o = nv.open(name);
          const dir = path.join(root, name);
          out.push({ book: o.book, sections: o.sections, entries: o.entries, mtime: Math.max(mtimeOf(path.join(dir, '正文.md')), mtimeOf(path.join(dir, '设定.md'))), last: (o.last || []).map((e) => ({ id: e.id, author: e.author, time: e.time, text: oneLine(e.text, 160) })) });
        } catch (e) { out.push({ book: name, error: oneLine(e?.message, 80) }); }
      }
      return { ok: true, books: out };
    } catch (e) { return unavailable('合写的书', e); }
  }
  function memory(who) {
    const b = brainOf(who);
    return {
      ok: true, who, source: '脑子目录（只读）',
      recall: recall(who),
      moments: moments(who),
      sticky: simpleDoc(b.sticky, 4000),
      self: selfPage(who),
      rambling: latestRambling(who),
      diary: latestDiary(who),
      growth: growth(who),
      impressions: impressions(who),
      handoff: simpleDoc(b.handoff, 4000),
      novels: novels()
    };
  }

  // ── 在外面玩 ──────────────────────────────────────────────────────────────
  function douyin() {
    if (!douyinStateDir) return { ok: false, reason: '暂时读不到：没配抖音插件目录' };
    try {
      const watch = readJson(path.join(douyinStateDir, 'watch-state.json')) || {};
      const events = tailJsonl(path.join(douyinStateDir, 'watch-events.jsonl'), 14, 256 * 1024).reverse().map((e) => ({
        at: e.at, type: e.type, text: oneLine(e.message || e.title || (e.report ? `看完一轮，记了 ${e.report.observedCount ?? '?'} 条` : '') || e.type, 160)
      }));
      const tells = tailJsonl(path.join(douyinStateDir, 'watch-tell.jsonl'), 6, 256 * 1024).reverse().map((e) => ({ at: e.at, title: oneLine(e.title, 80), author: e.author || '', tell: oneLine(e.tell, 200) }));
      const chat = tailJsonl(path.join(douyinStateDir, 'chat-events.jsonl'), 10, 128 * 1024).reverse().map((e) => ({ at: typeof e.at === 'number' ? e.at : Date.parse(e.at), type: e.type, text: oneLine(e.message, 140) }));
      return {
        ok: true,
        status: watch.status || '',
        lastError: oneLine(watch.lastError, 120),
        lastTell: oneLine(watch.lastDecision?.tell, 200),
        running: fs.existsSync(path.join(douyinStateDir, 'watch-loop.lock')),
        watchUpdated: mtimeOf(path.join(douyinStateDir, 'watch-state.json')),
        events, tells, chat
      };
    } catch (e) { return unavailable('抖音', e); }
  }
  function explore(who) {
    try {
      const rows = who === 'fish'
        ? tailJsonl(path.join(stateDir, 'explore-impressions.jsonl'), 10, 256 * 1024)
        : tailJsonl(path.join(brainOf('sister').days, '逛过的.jsonl'), 10, 256 * 1024);
      return {
        ok: true,
        list: rows.reverse().map((r) => ({ at: r.at, kind: r.kind, title: oneLine(r.title, 80), why: oneLine(r.why, 100), impression: oneLine(r.impression, 240) }))
      };
    } catch (e) { return unavailable('随便逛', e); }
  }
  function bili(who) {
    try {
      const rows = tailJsonl(path.join(stateDir, 'bili-watch.jsonl'), 60, 256 * 1024).filter((r) => r.who === who).slice(-10).reverse();
      return { ok: true, list: rows.map((r) => ({ at: r.at, kind: r.kind, title: oneLine(r.title, 80), up: r.up || '', bvid: r.bvid || '' })) };
    } catch (e) { return unavailable('B 站', e); }
  }
  function shots() {
    if (!pcShotsDir) return { ok: true, list: [], note: '还没有屏幕截图的存档（她看老大电脑时截的图现在没有存档）' };
    try {
      const names = fs.readdirSync(pcShotsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => [f, mtimeOf(path.join(pcShotsDir, f))]).sort((a, b) => b[1] - a[1]).slice(0, 12);
      return { ok: true, list: names.map(([name, at]) => ({ name, at })), note: names.length ? '' : '还没有屏幕截图的存档' };
    } catch { return { ok: true, list: [], note: '还没有屏幕截图的存档' }; }
  }
  function outside(who) {
    return {
      ok: true, who,
      douyin: who === 'fish' ? douyin() : { ok: false, reason: '姐姐没有抖音' },
      explore: explore(who),
      bili: bili(who),
      shots: shots()
    };
  }

  // ── 运行情况 ──────────────────────────────────────────────────────────────
  const ERR_RE = /错误|出错|失败|异常|超时|拒绝|拦截|断开|崩|error|fail|exception|timeout|⚠|ECONN|ENOENT|EPERM/i;
  const NOISE_RE = /忽略未授权会话|逐轮明细超过/;
  function errors(who) {
    const file = who === 'fish' ? path.join(stateDir, 'bridge.log') : path.join(sisterStateDir, 'sister.log');
    const lines = tailLines(file, 600, 400 * 1024).filter((l) => ERR_RE.test(l) && !NOISE_RE.test(l)).slice(-25).reverse();
    return { ok: true, source: path.basename(file), mtime: mtimeOf(file), lines: lines.map((l) => clip(l, 260)) };
  }
  function mailbox() {
    const j = readJson(path.join(stateDir, 'mom-mailbox', 'letters.json'));
    if (!j) return { ok: false, reason: '暂时读不到：妈妈信箱还没有信' };
    const letters = Array.isArray(j.letters) ? j.letters : [];
    const counts = {};
    for (const l of letters) counts[l.status || 'new'] = (counts[l.status || 'new'] || 0) + 1;
    return {
      ok: true, total: letters.length, counts,
      letters: letters.slice(-8).reverse().map((l) => ({ id: l.id, at: l.at, from: l.fromLabel || '', status: l.status || 'new', text: oneLine(l.text, 200), reply: oneLine(l.reply, 160) }))
    };
  }
  /** 小鲸鱼今天的花费：state/token-usage.jsonl 的逐轮行（同一回合同一步只算最后一次）× 价目表。 */
  function costFish() {
    try {
      if (!tokenUsageFile || !priceTable) return unavailable('小鲸鱼的用量账本');
      const rows = tailJsonl(tokenUsageFile, 25000, 8 * 1024 * 1024);
      const today = bjDay(hostNow(), skew()); // 账本的时间戳已经是校正后的真实时间（桥接用 realNow 记的），所以行里的 t 不用再扣偏差
      const seen = new Map();
      for (const r of rows) if (r.k === 'turn' && Number.isFinite(+r.t) && bjDay(+r.t, 0) === today) seen.set(`${r.sid}|${r.turn}|${r.step}|${r.retry}`, r);
      let buckets = { ...ZERO_BUCKETS };
      let money = 0;
      const byKey = {};
      for (const r of seen.values()) {
        const b = normalizeUsage(r.b);
        buckets = addBuckets(buckets, b);
        const c = priceUsage(b, { model: r.model, at: +r.t, table: priceTable }).cost.total;
        money += c;
        byKey[r.key || '?'] = (byKey[r.key || '?'] || 0) + c;
      }
      return {
        ok: true, day: today, turns: seen.size, tokens: totalTokensOf(buckets),
        input: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite, output: buckets.output,
        cost: Math.round(money * 10000) / 10000, symbol: priceTable.symbol || '¥', currency: priceTable.currency || 'CNY',
        byKey: Object.entries(byKey).map(([key, v]) => ({ key, cost: Math.round(v * 10000) / 10000 })).sort((a, b) => b.cost - a.cost).slice(0, 8),
        note: '按价目表折算，只在网页里给老大看'
      };
    } catch (e) { return unavailable('小鲸鱼的花费', e); }
  }
  /** 姐姐今天的花费：汇总 sister/state/usage.jsonl 当天的 token（走订阅，美元数只是折合）。 */
  function costSister() {
    try {
      const file = path.join(sisterStateDir, 'usage.jsonl');
      const rows = tailJsonl(file, 3000, 4 * 1024 * 1024);
      const today = bjDay(hostNow(), skew());
      let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0; let usd = 0; let n = 0; let week = null;
      for (const r of rows) {
        if (bjDay(Date.parse(r.t), skew()) !== today) continue;
        n += 1;
        const u = r.usage || {};
        input += Number(u.input_tokens) || 0; output += Number(u.output_tokens) || 0;
        cacheRead += Number(u.cache_read_input_tokens) || 0; cacheWrite += Number(u.cache_creation_input_tokens) || 0;
        usd += Number(r.costUsd) || 0;
        if (Number.isFinite(+r.week)) week = +r.week;
      }
      return {
        ok: true, day: today, turns: n, tokens: input + output + cacheRead + cacheWrite, input: input + cacheRead + cacheWrite, output,
        cost: Math.round(usd * 100) / 100, symbol: '$', currency: 'USD', weekUsed: week,
        note: '姐姐走订阅，美元数是折合，不实际扣钱；只在网页里给老大看'
      };
    } catch (e) { return unavailable('姐姐的花费', e); }
  }
  const cost = (who) => (who === 'fish' ? costFish() : costSister());

  async function pingMemory() {
    const r = await httpGetJson(memoryPort, '/health', { timeoutMs: 900 });
    if (!r || r.status !== 200 || !r.body) return { ok: false, reason: '检索服务没有回应（127.0.0.1:3210）' };
    const b = r.body;
    return { ok: true, ready: !!b.ready, building: !!b.building, chunks: b.chunks ?? null, builtAt: b.builtAt ? b.builtAt * 1000 : 0, brains: b.brains || {} };
  }
  async function pingDouyin() {
    const r = await httpGetJson(douyinCdpPort, '/json/version', { timeoutMs: 700 });
    return r && r.status === 200 ? { ok: true, browser: oneLine(r.body?.Browser, 40) } : { ok: false, reason: '抖音专用窗口没有回应' };
  }

  return {
    label, mood, hormones, hormoneRows, memory, outside, errors, mailbox, cost, costFish, costSister, pingMemory, pingDouyin,
    recall, moments, selfPage, novels, douyin, explore, bili, shots, skew,
    bjDay: (ms) => bjDay(ms, skew())
  };
}

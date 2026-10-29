// 可重温的"情景记忆"（episodes）。
//
// 主人的原话：「记忆里记得和亲身经历过是两回事」—— 她本子上记着"主人说过 X"，
// 却想不起当时他是怎么说的、自己回了什么、心里在想什么。这个模块把一个个"瞬间"
// 按原文存下来：对方的原话、她发出去的原话、那一刻她脑子里的一段话（reasoning 节选）、
// 心情读数、她叫对方的称呼，以及她事后自己写下的感受。
//
// 存储：脑子的 瞬间/<出处>.jsonl（2026-10-29 大脑方案搬家，原来在 state/episodes/；路径见 src/brains.js），一个出处（会话 key）一个文件（':' → '_'）。
// 2026-10-29 老大：记忆统一，每人只有一个脑子——读的时候所有出处的瞬间都看得到（原来群看不到主人私聊的），
// 私聊 / 抖音私信里的瞬间在别处想起来时会标「私聊里的」，说不说她自己掂量。
// 一条记录：
//   { id, at, key, sid, who, them:[对方原话 ≤6], me:[她的原话 ≤6], inner:"≤150 字的推理节选",
//     mood:{v, top, d?}|null, call:"称呼或空", felt:"她自己写的感受 ≤120 字或空", tags:[], source:"live"|"extract" }
// 上限：每个 key ≤300 条（先丢最旧、没留感受的抽取记录），每条 ≤2KB。
//
// 隐私：这里只存消息正文、对方的称谓（主人 / 群友昵称 / 抖音朋友名字）、时间戳、
// 她自己的推理节选。令牌、QQ 号、userId 一律不进这个文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isHeavySwing, moodSnapshot } from './mood.js';

// 2026-10-29 大脑方案下半：心情读数的算法收进 src/mood.js（两人共用）；这里原样再导出，老的 import 不用改。
export { moodSnapshot };

export const EPISODE_LIMITS = Object.freeze({
  perKey: 300,
  bytesEach: 2048,
  lines: 6,
  lineChars: 160,
  inner: 150,
  felt: 120,
  tags: 8,
  tagChars: 20,
  recallChars: 1500,
  handoffChars: 900
});

// 主人私聊里她对主人的称呼（2026-10-23 主人定的名单）。「人」单独一个字太常见，
// 只在它独立成词时算（前后都不是汉字，如「人～」「人，你在吗」）。
const CALL_RE = /宝宝|主人|老大|用户|(?<![一-龥])人(?![一-龥])/;

/** 会话 key → 文件名安全的形式（'group:123' → 'group_123'）。 */
export function keySafe(key) {
  return String(key ?? '').replace(/:/g, '_').replace(/[^\w一-龥.\-]/g, '_');
}

/** 机器时间 → 北京时间「MM/DD HH:mm」。skewMs 是 bridge 量出来的本机快于真实时间的毫秒数。 */
export function bjTime(ms, skewMs = 0) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '??/?? ??:??';
  try {
    return new Date(n - (Number(skewMs) || 0)).toLocaleString('zh-CN', {
      hour12: false, timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return new Date(n - (Number(skewMs) || 0)).toISOString().slice(5, 16).replace('T', ' ');
  }
}

/** 从她发出去的话里找称呼（只在主人私聊里用）。 */
export function detectCall(lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    const m = CALL_RE.exec(String(line ?? ''));
    if (m) return m[0];
  }
  return '';
}

// 7 位以上的数字串（QQ 号、消息 id、手机号）和 40 位以上的十六进制串（令牌）不进记录。
// 实时抓取和离线抽取都经过 normalizeEpisode，所以在这里统一抹。
function clip(s, n) {
  const t = String(s ?? '').replace(/\b[a-f0-9]{40,}\b/gi, '［令牌］').replace(/\d{7,}/g, '…').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 只裁长度不抹数字：给 sid 这种本身就是 UUID 的字段用（"2285500d" 里的 7 位数字不是 QQ 号）。 */
function clipPlain(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function clipLines(arr, limits = EPISODE_LIMITS) {
  return (Array.isArray(arr) ? arr : [arr])
    .map((x) => clip(x, limits.lineChars))
    .filter(Boolean)
    .slice(-limits.lines);
}

/** 规范化一条记录：补默认值、裁到上限。只信任字段白名单，别的键一律丢掉。 */
export function normalizeEpisode(raw, limits = EPISODE_LIMITS) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const mood = e.mood && typeof e.mood === 'object' && Number.isFinite(Number(e.mood.v))
    ? { v: Math.round(Number(e.mood.v)), top: clip(e.mood.top, 20), ...(Number.isFinite(Number(e.mood.d)) ? { d: Math.round(Number(e.mood.d)) } : {}), ...(Number.isFinite(Number(e.mood.dd)) && Number(e.mood.dd) > 0 ? { dd: Math.round(Number(e.mood.dd)) } : {}) }
    : null;
  const ep = {
    id: typeof e.id === 'string' && /^[a-f0-9]{8,12}$/.test(e.id) ? e.id : crypto.randomBytes(5).toString('hex'),
    at: Number(e.at) || Date.now(),
    key: String(e.key ?? ''),
    sid: clipPlain(e.sid, 64),
    who: clip(e.who, 40),
    them: clipLines(e.them, limits),
    me: clipLines(e.me, limits),
    inner: clip(e.inner, limits.inner),
    mood,
    call: clip(e.call, 10),
    felt: clip(e.felt, limits.felt),
    tags: (Array.isArray(e.tags) ? e.tags : []).map((t) => clip(t, limits.tagChars)).filter(Boolean).slice(0, limits.tags),
    source: e.source === 'live' ? 'live' : 'extract'
  };
  // 每条 ≤2KB：超了就先砍 inner，再逐条砍对话。
  let guard = 0;
  while (Buffer.byteLength(JSON.stringify(ep), 'utf8') > limits.bytesEach && guard < 40) {
    guard += 1;
    if (ep.inner.length > 60) ep.inner = clip(ep.inner, Math.floor(ep.inner.length / 2));
    else if (ep.them.length > 2) ep.them.shift();
    else if (ep.me.length > 2) ep.me.pop();
    else { ep.them = ep.them.map((l) => clip(l, 60)); ep.me = ep.me.map((l) => clip(l, 60)); ep.felt = clip(ep.felt, 60); }
  }
  return ep;
}

/** 记录"值多少"：留了感受的最贵，其次是亲历（live）、有心里话、心情波动大的。用于满 300 条时决定丢谁。 */
export function episodeValue(ep) {
  return (ep.felt ? 4 : 0) + (ep.source === 'live' ? 2 : 0) + (ep.inner ? 1 : 0) + (isHeavySwing(ep.mood) ? 1 : 0);
}

/** 这个出处是不是私聊类的（QQ 私聊、抖音私信）：在别处想起来时要标「私聊里的」。 */
export function isPrivateKey(key) {
  const k = String(key ?? '');
  return k.startsWith('private:') || k.startsWith('douyin:');
}

/** 一个瞬间的文字呈现（原文格式，给她看的）。viewerKey：她现在在哪个会话；瞬间来自别处的私聊时标「私聊里的」。 */
export function formatEpisode(ep, { skewMs = 0, labelFor, ownerKey = '', viewerKey = '' } = {}) {
  const place = typeof labelFor === 'function' ? labelFor(ep.key) : defaultLabel(ep.key, ownerKey);
  const head = [`${bjTime(ep.at, skewMs)} ${place}`];
  if (viewerKey && viewerKey !== ep.key && isPrivateKey(ep.key)) head.push('私聊里的');
  if (ep.call) head.push(`你叫他「${ep.call}」`);
  if (ep.mood) head.push(`心情 ${ep.mood.v}${ep.mood.top ? `（${ep.mood.top}）` : ''}`);
  const lines = [`【${head.join('，')} · 编号 ${ep.id}】`];
  for (const l of ep.them) lines.push(l);
  for (const l of ep.me) lines.push(`你：${l}`);
  if (ep.inner) lines.push(`当时心里：${ep.inner}`);
  lines.push(`你后来写下的感觉：${ep.felt || '（当时没留感受）'}`);
  return lines.join('\n');
}

export function defaultLabel(key, ownerKey = '') {
  const k = String(key ?? '');
  if (ownerKey && k === ownerKey) return '主人私聊';
  if (k === 'douyin:dm') return '抖音私信（和主人）';
  if (k.startsWith('douyin:friend:')) return `抖音私信（和「${k.slice(14)}」）`;
  if (k.startsWith('group:')) return '群里';
  if (k.startsWith('private:')) return '私聊';
  return k || '某处';
}

/** 把一组记录拼成给她看的文本，总长 ≤ maxChars（整条整条地放，放不下就停）。 */
export function formatEpisodes(list, { skewMs = 0, labelFor, maxChars = EPISODE_LIMITS.recallChars, viewerKey = '' } = {}) {
  const out = [];
  let used = 0;
  for (const ep of list) {
    const t = formatEpisode(ep, { skewMs, labelFor, viewerKey });
    if (used + t.length + 2 > maxChars) {
      if (!out.length) out.push(clip(t, maxChars));
      break;
    }
    out.push(t);
    used += t.length + 2;
  }
  return out.join('\n\n');
}

/** 搜索用的小分词：按空白和中文标点切，去掉太短的。 */
function terms(query) {
  return String(query ?? '').split(/[\s,，。、；;!！?？]+/).map((s) => s.trim()).filter((s) => s.length >= 1).slice(0, 8);
}

function haystack(ep) {
  return [...ep.them, ...ep.me, ep.felt, ep.inner, ep.call, ...ep.tags].join('\n').toLowerCase();
}

/**
 * 情景记忆仓库。dir 是脑子的 瞬间/（brains.js 的 momentsDir）；skewMs 可以传函数（bridge 的 clockSkewMs 启动后才量出来）。
 * pressedFile：压着.json 的路径（脑子的 瞬间/压着.json，可不传）；情绪起伏大的瞬间存进去（见 markPressed）。
 * ownerKey 只用来给主人私聊起名字（"主人私聊"）。2026-10-29 记忆统一：读的时候所有出处都看得到，
 * 别处的私聊 / 抖音私信里的瞬间会标「私聊里的」（见 formatEpisode），说不说她自己掂量；写还是按出处分文件。
 */
export function createEpisodeStore({ dir, skewMs = 0, ownerKey = '', labelFor, limits = EPISODE_LIMITS, now = () => Date.now(), pressedFile = '' } = {}) {
  if (!dir) throw new Error('createEpisodeStore 需要 dir');
  const skew = () => (typeof skewMs === 'function' ? Number(skewMs()) || 0 : Number(skewMs) || 0);
  const owner = () => (typeof ownerKey === 'function' ? String(ownerKey() || '') : String(ownerKey || ''));
  const fileFor = (key) => path.join(dir, `${keySafe(key)}.jsonl`);
  const label = (k) => (typeof labelFor === 'function' ? labelFor(k) : defaultLabel(k, owner()));

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function list(key) {
    return listFile(fileFor(key));
  }

  function writeAll(key, rows) {
    ensureDir();
    const file = fileFor(key);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 满了先丢"最旧、没留感受的抽取记录"，还不够再按价值低→高、旧→新丢。 */
  function trim(rows) {
    if (rows.length <= limits.perKey) return rows;
    const ranked = rows
      .map((r, i) => ({ r, i, v: episodeValue(r) }))
      .sort((a, b) => a.v - b.v || a.r.at - b.r.at || a.i - b.i);
    const drop = new Set(ranked.slice(0, rows.length - limits.perKey).map((x) => x.i));
    return rows.filter((_, i) => !drop.has(i));
  }

  function sameMoment(a, b) {
    const fa = a.them[0] || a.me[0] || '';
    const fb = b.them[0] || b.me[0] || '';
    return fa && fa === fb && Math.abs(a.at - b.at) <= 2 * 60 * 1000;
  }

  /**
   * 追加一条。按 (key, 第一句对方原话, at±2 分钟) 去重；重复时返回已有那条的 id（deduped=true）。
   * 空的（既没对方的话也没她的话）不存。
   */
  function append(raw) {
    const ep = normalizeEpisode(raw, limits);
    if (!ep.key) throw new Error('episode 缺 key');
    if (!ep.them.length && !ep.me.length) return { ok: false, error: '这个瞬间是空的（没有对话原文）' };
    const rows = list(ep.key);
    const dup = rows.find((r) => sameMoment(r, ep));
    if (dup) {
      // 同一瞬间再来一次：只把新带来的感受 / 心里话补上，不重复存。
      let changed = false;
      if (!dup.felt && ep.felt) { dup.felt = ep.felt; changed = true; }
      if (!dup.inner && ep.inner) { dup.inner = ep.inner; changed = true; }
      if (!dup.mood && ep.mood) { dup.mood = ep.mood; changed = true; }
      if (ep.tags.length) { dup.tags = [...new Set([...dup.tags, ...ep.tags])].slice(0, limits.tags); changed = true; }
      if (changed) writeAll(ep.key, rows);
      if (changed) markPressed(dup);
      return { ok: true, id: dup.id, deduped: true };
    }
    rows.push(ep);
    writeAll(ep.key, trim(rows));
    markPressed(ep);
    return { ok: true, id: ep.id, deduped: false };
  }

  // ── 压在心里的事（2026-10-29 大脑方案下半，第 6 项）──────────────────────────────
  // 情绪起伏大的瞬间（心情分一次变 ≥3，或某种情绪一次变 ≥4，见 mood.js SWING_THRESHOLD）记进 瞬间/压着.json。
  // 检索服务（brain/recall.py）聊到相近话题时按概率把它作为第 3 条带出来，标「这件事你一直压着」，提不提她定。
  // 一条：{ id, file, at, v, d, dd, top, place, text, felt, since }；最多留最新的 60 条。
  const PRESSED_MAX = 60;
  function readPressedFile() {
    try {
      const j = JSON.parse(fs.readFileSync(pressedFile, 'utf8').replace(/^\uFEFF/, ''));
      return { items: Array.isArray(j?.items) ? j.items : [], released: Array.isArray(j?.released) ? j.released : [] };
    } catch { return { items: [], released: [] }; }
  }
  function writePressedFile(items, released) {
    fs.mkdirSync(path.dirname(pressedFile), { recursive: true });
    const tmp = `${pressedFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items, released: released.slice(-200) }, null, 2), 'utf8');
    fs.renameSync(tmp, pressedFile);
  }
  function pressedEntry(ep) {
    const text = [...ep.them.slice(-2), ...ep.me.slice(0, 2).map((l) => `你：${l}`)].join(' / ');
    return {
      id: ep.id, file: keySafe(ep.key), at: ep.at, v: ep.mood?.v ?? null, d: ep.mood?.d ?? 0, dd: ep.mood?.dd ?? 0, top: ep.mood?.top || '',
      place: label(ep.key), text: clip(text, 240), felt: ep.felt || '', since: now()
    };
  }
  /** 这个瞬间情绪起伏大就记进 压着.json（已经有的更新一下；她放下过的不再记）。返回有没有记。 */
  function markPressed(ep) {
    if (!pressedFile || !ep || !isHeavySwing(ep.mood)) return false;
    try {
      const cur = readPressedFile();
      if (cur.released.includes(ep.id)) return false;
      const prev = cur.items.find((x) => x.id === ep.id);
      const items = cur.items.filter((x) => x.id !== ep.id);
      items.push({ ...pressedEntry(ep), ...(prev?.since ? { since: prev.since } : {}) });
      writePressedFile(items.sort((a, b) => a.at - b.at).slice(-PRESSED_MAX), cur.released);
      return true;
    } catch { return false; }
  }
  function listPressed() { return pressedFile ? readPressedFile().items : []; }
  /** 放下一件压着的事（她想放下了）：从清单拿掉，以后扫描也不再把它捡回来。 */
  function releasePressed(id) {
    if (!pressedFile) return false;
    const cur = readPressedFile();
    const left = cur.items.filter((x) => x.id !== String(id));
    if (left.length === cur.items.length) return false;
    writePressedFile(left, [...cur.released, String(id)]);
    return true;
  }
  /** 把所有出处里情绪起伏大的瞬间重新扫一遍，补记老的（放下过的不会回来）。返回现在有几条。 */
  function rebuildPressed() {
    if (!pressedFile) return 0;
    const cur = readPressedFile();
    const gone = new Set(cur.released);
    const byId = new Map(cur.items.map((x) => [x.id, x]));
    for (const file of allFiles()) {
      for (const ep of listFile(file)) {
        if (!isHeavySwing(ep.mood) || gone.has(ep.id)) continue;
        byId.set(ep.id, { ...pressedEntry(ep), ...(byId.get(ep.id)?.since ? { since: byId.get(ep.id).since } : {}) });
      }
    }
    const items = [...byId.values()].sort((a, b) => a.at - b.at).slice(-PRESSED_MAX);
    writePressedFile(items, cur.released);
    return items.length;
  }

  /** 按编号在所有出处里找一个瞬间（找不到返回 null）。给「补感受」用：编号是 qq_recall 里翻到的，不一定在当前会话的文件里。 */
  function find(id) {
    const want = String(id ?? '').trim();
    if (!want) return null;
    for (const file of allFiles()) {
      const hit = listFile(file).find((e) => e.id === want);
      if (hit) return hit;
    }
    return null;
  }

  /** 给已有的瞬间补上她的感受（只能改同一个 key 下的）。 */
  function updateFelt(key, id, felt, tags = []) {
    const rows = list(key);
    const ep = rows.find((r) => r.id === String(id));
    if (!ep) return { ok: false, error: '没找到这个编号的瞬间（只能补自己这边的）' };
    ep.felt = clip(felt, limits.felt);
    if (Array.isArray(tags) && tags.length) ep.tags = [...new Set([...ep.tags, ...tags.map((t) => clip(t, limits.tagChars)).filter(Boolean)])].slice(0, limits.tags);
    writeAll(key, rows);
    return { ok: true, id: ep.id, episode: ep };
  }

  /** 这个 key 能看到哪些文件里的瞬间：自己的排第一，再加上其它所有出处的（2026-10-29 记忆统一，不再按会话隔离）。 */
  function allFiles() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  }
  function visibleFiles(key) {
    const files = [fileFor(key)];
    for (const full of allFiles()) if (!files.includes(full)) files.push(full);
    return files;
  }

  function listFile(file) {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(normalizeEpisode(JSON.parse(line), limits)); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  /**
   * 检索：query 的每个词在 them/me/felt/inner/tags 里做子串匹配，命中多的在前；同分按时间新的在前。
   * 没 query 就按时间倒序。days 限制只看最近几天。
   */
  function search(key, { query = '', days = 0, limit = 5 } = {}) {
    const ts = terms(query).map((t) => t.toLowerCase());
    const since = days > 0 ? now() - days * 86400000 : 0;
    const rows = [];
    for (const file of visibleFiles(key)) {
      for (const ep of listFile(file)) {
        if (ep.at < since) continue;
        let score = 0;
        if (ts.length) {
          const h = haystack(ep);
          for (const t of ts) if (h.includes(t)) score += 10;
          if (!score) continue;
        }
        rows.push({ ep, score });
      }
    }
    rows.sort((a, b) => b.score - a.score || b.ep.at - a.ep.at);
    const n = Math.max(1, Math.min(10, Number(limit) || 5));
    return rows.slice(0, n).map((r) => r.ep);
  }

  function recall(key, opts = {}) {
    const found = search(key, opts);
    return { found: found.length, text: formatEpisodes(found, { skewMs: skew(), labelFor: label, maxChars: limits.recallChars, viewerKey: key }), ids: found.map((e) => e.id) };
  }

  /** 一个瞬间「感受有多强」：自己写了感受的最重，其次是心情起伏大、心里话、亲历的。交接挑瞬间、压着都按它。 */
  function intensity(e) {
    const swing = Math.max(Math.abs(Number(e.mood?.d) || 0) / 3, Math.abs(Number(e.mood?.dd) || 0) / 4);
    return (e.felt ? 4 : 0) + (isHeavySwing(e.mood) ? 3 : 0) + Math.min(2, swing) + (e.inner ? 1.5 : 0) + (e.source === 'live' ? 0.5 : 0);
  }

  /**
   * 感受最强的几个瞬间（所有出处里找，默认最近 72 小时，没有就空）。交接和「压着」之外的地方也能用。
   * 2026-10-29 大脑方案下半：交接要带「2～3 个感受最强的瞬间」，按 intensity 挑，同分新的在前。
   */
  function strongest({ hours = 72, max = 3, key = '' } = {}) {
    const since = now() - hours * 3600000;
    const files = key ? [fileFor(key)] : allFiles();
    const rows = files.flatMap((f) => listFile(f)).filter((e) => e.at >= since);
    rows.sort((a, b) => intensity(b) - intensity(a) || b.at - a.at);
    return rows.slice(0, max).sort((a, b) => a.at - b.at);
  }

  /**
   * 搬家交接用：最近 48 小时里最值得带走的几个瞬间（感受最强的优先），总长 ≤900。
   * key 不传 = 所有出处里挑（记忆统一，她换了会话也接得上）；传了只看这个出处。
   */
  function handoffBlock(key, { hours = 48, max = 3, maxChars = limits.handoffChars, title: customTitle = '' } = {}) {
    const picked = strongest({ hours, max, key: key || '' });
    if (!picked.length) return '';
    const title = '【你带走的几个瞬间（你亲身经历过的）】\n';
    const head = customTitle || title;
    const body = formatEpisodes(picked, { skewMs: skew(), labelFor: label, maxChars: maxChars - head.length, viewerKey: key || '' });
    return body ? head + body : '';
  }

  /** 实时抓取：从 recentMessages 里取她最近一次发言前后的原文，拼成一条 live 记录。 */
  function fromRecent({ key, sid = '', recentMessages = [], mood = null, felt = '', tags = [], ownerIsCounterpart = false, ownerName = '主人' }) {
    const msgs = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && (m.text || m.plain));
    const lastSelfIdx = msgs.map((m) => Boolean(m.isSelf)).lastIndexOf(true);
    const them = [];
    const me = [];
    // 以她最后一次发言为锚：往前收对方的话（≤6 句），她自己的话收最后一串连续发言。
    const end = lastSelfIdx >= 0 ? lastSelfIdx : msgs.length - 1;
    for (let i = end; i >= 0 && (them.length < limits.lines || me.length < limits.lines); i -= 1) {
      const m = msgs[i];
      const text = String(m.text || m.plain || '');
      if (m.isSelf) {
        if (me.length < limits.lines && (!them.length)) me.unshift(text);
      } else if (them.length < limits.lines) {
        const placeholder = !m.sender || ['我', '私聊', '群', '对方', '系统'].includes(m.sender);
        const who = m.isOwner ? ownerName : (placeholder ? '对方' : String(m.sender));
        them.unshift(`${who}：${text}`);
      }
    }
    const lastSelf = lastSelfIdx >= 0 ? msgs[lastSelfIdx] : null;
    const at = Number(lastSelf?.time ?? lastSelf?.at) || now();
    const who = ownerIsCounterpart ? ownerName : (key.startsWith('group:') ? '群友' : '对方');
    return normalizeEpisode({
      at, key, sid, who, them, me, inner: '', mood,
      call: ownerIsCounterpart ? detectCall(me) : '',
      felt, tags, source: 'live'
    }, limits);
  }

  function counts() {
    const out = {};
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const k = f.slice(0, -6);
      out[k] = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length;
    }
    return out;
  }

  return { dir, list, append, updateFelt, search, recall, handoffBlock, strongest, find, fromRecent, visibleFiles, counts, fileFor, listPressed, releasePressed, rebuildPressed, markPressed };
}

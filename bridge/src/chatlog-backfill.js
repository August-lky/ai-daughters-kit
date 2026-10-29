// 把小鲸鱼以前的聊天补进 家/小鲸鱼/聊天记录/（2026-10-29 第五批；老大：「给妹妹也做成一样吧」）。
//
// 原料有三份（都只读）：
//   1. 她的 DSH 会话存档 ~/.dsh/sessions/--E-qq-bridge-state-agents--/<session-id>/session.v4.jsonl.zstd
//      ——唤醒提示里的「【本次消息快照】」带着当时的消息原文（对方的话 + 最近的几条），qq_wait_for_messages 等工具的返回里也有，
//      她发的话在 qq_send_message 等工具的参数里。zstd 是很多段拼起来的（每次追加一段），zlib.zstdDecompressSync 只会解第一段，
//      所以要先按段切开再逐段解（splitZstdFrames / decodeZstdLines）。
//   2. state/social-v2.json 的 recentMessages（每个会话最近 200 条，补上存档里还没有的最新几条）。
//   3. 抖音插件的 chat-inbox.jsonl（抖音私信，双方的都有）。
// 输出跟 chatlog.js 写的一样（<日期>-<会话>.md，每行 `- HH:MM **名字**：内容`），合并进已有的文件：
// 已经有的不重复写（同一个人、同样的话、前后差 1 分钟以内算同一条），没有的按时间插进去。
//
// 时间：存档里的 time 是本机毫秒，本机比真实时间快约 3 小时，换算时扣掉 skewMs。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  bjParts, chatLogFileName, chatLogHeader, chatLogLine, parseChatLogLine, sessionInfo, whoLabel,
} from './chatlog.js';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const KEY_RE = /^(?:group|private):\d+$/;
const MIN = 60e3;

// ── zstd：多段拼起来的文件按段解 ─────────────────────────────────────────────

/**
 * 找出文件里每一段 zstd 的起点。魔数（28 b5 2f fd）偶尔会恰好出现在压缩数据中间，所以这里只给「候选起点」，
 * 真正的切法在 decodeZstdFrames 里：从一个起点解不开，就试着把它和后面几个候选段连起来再解。
 */
export function zstdFrameStarts(buf) {
  const starts = [];
  let p = 0;

  while ((p = buf.indexOf(ZSTD_MAGIC, p)) !== -1) { starts.push(p); p += 4; }

  return starts;
}

/** 把拼接的 zstd 逐段解开，返回每一段解出来的文字组成的数组（坏段跳过）。 */
export function decodeZstdFrames(buf, { maxMerge = 8 } = {}) {
  const starts = zstdFrameStarts(buf);
  const out = [];

  for (let i = 0; i < starts.length;) {
    let done = false;

    for (let j = i + 1; j <= Math.min(starts.length, i + 1 + maxMerge); j += 1) {
      const end = j < starts.length ? starts[j] : buf.length;

      try {
        out.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'));
        i = j;
        done = true;
        break;
      } catch { /* 这一截不是完整的一段：把下一个候选并进来再试 */ }
    }

    if (!done) i += 1; // 从这个起点怎么也解不开（坏段）：跳到下一个候选
  }

  return out;
}

/** 整个文件解开后的 JSONL 行。 */
export function decodeZstdLines(buf, opts) {
  return decodeZstdFrames(buf, opts).join('').split('\n').filter((l) => l.trim());
}

// ── 从一个会话存档里取出聊天 ───────────────────────────────────────────────

const SEND_TOOLS = /(?:^|__)(?:qq_send_message|qq_reply|qq_send_burst|qq_send_private_message|qq_send_group_message)$/;
const INCOMING_TOOLS = /(?:^|__)(?:qq_wait_for_messages|qq_get_unread_messages|qq_get_recent_messages)$/;

const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const contentText = (content) => (Array.isArray(content) ? content : []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? ''));

  const s = String(v ?? '').trim();

  if (s.startsWith('[')) { const j = parseJson(s); if (Array.isArray(j)) return j.map((x) => String(x ?? '')); }

  return s ? [s] : [];
}

/**
 * 从一个会话存档的行里取聊天。返回 { key, incoming: [...], sent: [...], selfSeen: [...] }：
 *   incoming  对方的话 { key, at, sender, userId, isOwner, text, mid }
 *   sent      她用发送工具发的话 { key, at, text }（从工具参数里来，是原文）
 *   selfSeen  消息快照 / 工具返回里「我」说的那几条 { key, at, text, mid }（表情、语音、图片这类不走文字发送工具的在这里）
 * key：这个会话是哪个 QQ 会话（sessionKey 优先，没有就取工具参数里最常出现的）。
 */
export function extractSessionChat(lines, { sessionKey = '' } = {}) {
  const calls = new Map();
  const keyCount = new Map();
  const incoming = [];
  const sent = [];
  const selfSeen = [];

  const addMsg = (key, m, fallbackAt) => {
    const text = String(m?.text ?? m?.plain ?? '').trim();

    if (!text) return;

    const at = Number(m.time ?? m.at) || fallbackAt;

    if (m.isSelf || m.sender === '我') selfSeen.push({ key, at, text, mid: m.messageId != null ? String(m.messageId) : '' });
    else incoming.push({ key, at, sender: String(m.sender ?? ''), userId: m.userId != null ? String(m.userId) : '', isOwner: Boolean(m.isOwner), text, mid: m.messageId != null ? String(m.messageId) : '', seq: m.seq });
  };

  for (const line of lines) {
    const j = parseJson(line);

    if (!j || typeof j !== 'object') continue;

    const at = Number(j.time) || 0;

    if (j.type === 'user/message') {
      const snap = /【本次消息快照】\n(\{.*\})/.exec(contentText(j.data?.content));
      const packet = snap ? parseJson(snap[1]) : null;

      if (packet) for (const m of [...(packet.messages || []), ...(packet.recent || [])]) addMsg(null, m, at);

      continue;
    }

    if (j.type === 'tool/call') {
      const name = String(j.data?.name ?? '');
      const args = parseJson(j.data?.arguments ?? '') || {};

      if (typeof args.key === 'string' && KEY_RE.test(args.key)) keyCount.set(args.key, (keyCount.get(args.key) || 0) + 1);

      calls.set(j.data?.callId, { name, args, at });
      continue;
    }

    if (j.type !== 'tool/result') continue;

    const call = calls.get(j.data?.message?.toolCallId);

    if (!call) continue;

    const text = contentText(j.data?.message?.content);
    const failed = Boolean(j.data?.message?.isError) || /^Error\b/.test(text) || text.startsWith('没发出去');

    if (INCOMING_TOOLS.test(call.name)) {
      const data = parseJson(text);
      const key = (typeof data?.key === 'string' && KEY_RE.test(data.key) && data.key) || (KEY_RE.test(call.args.key || '') ? call.args.key : '');

      for (const m of [...(data?.newMessages || []), ...(data?.messages || [])]) addMsg(key || null, m, at);
    } else if (SEND_TOOLS.test(call.name) && !failed) {
      const a = call.args;
      let key = '';

      if (KEY_RE.test(a.key || '')) key = a.key;
      else if (a.groupId !== undefined && a.groupId !== null) key = `group:${a.groupId}`;
      else if (a.userId !== undefined && a.userId !== null) key = `private:${a.userId}`;

      if (!KEY_RE.test(key)) continue;

      for (const t of toList(a.messages ?? a.message)) if (t.trim()) sent.push({ key, at: call.at || at, text: t.trim() });
    }
  }

  const dominant = [...keyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const key = KEY_RE.test(sessionKey) ? sessionKey : dominant;

  for (const arr of [incoming, selfSeen]) for (const m of arr) if (!m.key) m.key = key;

  return { key, incoming: incoming.filter((m) => KEY_RE.test(m.key || '')), sent, selfSeen: selfSeen.filter((m) => KEY_RE.test(m.key || '')) };
}

// ── 合起来：去重、起名字、按「日期-会话」分文件 ───────────────────────────────

/**
 * 把各处取来的消息整理成聊天记录的行。
 * items：[{ key, at, who?(已经定好的名字), sender, userId, isOwner, isSelf, text, mid, source }]
 * ctx：{ skewMs, ownerQQ, knownPeople, sessionOf(key) → { type, name }, selfName }
 * 去重：有消息号的按「会话 + 消息号」；没有的按「会话 + 谁 + 前 40 字」且前后差 1 分钟以内。
 * 她自己的话：工具参数里的原文（sent）优先，快照里「我」说的（selfSeen）如果跟某条 sent 对得上（前 40 字一样、5 分钟内）就不再重复。
 * 返回 Map<文件名, { info, parts, rows: [{ at, hm, who, text }] }>。
 */
export function buildChatLogRows(items, { skewMs = 0, ownerQQ = '', knownPeople = {}, sessionOf, selfName = '小鲸鱼' } = {}) {
  const files = new Map();
  const seenMid = new Set();
  const loose = new Map(); // `${key}|${who}|${prefix}` → [at]
  const norm = (t) => String(t ?? '').replace(/\s+/g, '').slice(0, 40);
  const sentPool = items.filter((m) => m.isSelf && m.source === 'send').map((m) => ({ ...m, used: false }));

  const sorted = [...items].sort((a, b) => a.at - b.at);

  for (const m of sorted) {
    const text = String(m.text ?? '').trim();

    if (!text || !KEY_RE.test(m.key || '')) continue;

    // 快照里「我」说的，跟工具参数里的原文对上了就不重复
    if (m.isSelf && m.source !== 'send') {
      const hit = sentPool.find((s) => !s.used && s.key === m.key && Math.abs(s.at - m.at) <= 5 * MIN && (norm(s.text) === norm(text) || norm(text).startsWith(norm(s.text).slice(0, 12)) && norm(s.text).length >= 12));

      if (hit) { hit.used = true; continue; }
    }

    const who = m.who || whoLabel({ isOwner: m.isOwner || (ownerQQ && m.key === `private:${ownerQQ}` && !m.isSelf), isSelf: m.isSelf, userId: m.userId, sender: m.sender, knownPeople, selfName, key: m.key, ownerQQ });
    const midKey = m.mid ? `${m.key}#${m.mid}#${m.isSelf ? 's' : 'o'}` : '';

    if (midKey) {
      if (seenMid.has(midKey)) continue;

      seenMid.add(midKey);
    }

    const lk = `${m.key}|${who}|${norm(text)}`;
    const prev = loose.get(lk) || [];

    if (prev.some((t) => Math.abs(t - m.at) <= MIN)) continue;

    loose.set(lk, [...prev, m.at]);

    const parts = bjParts(m.at, skewMs);
    const info = sessionInfo(sessionOf(m.key) || { type: 'friend', name: m.key.slice(m.key.indexOf(':') + 1) }, selfName);
    const fileName = chatLogFileName(parts.day, info);
    const f = files.get(fileName) || files.set(fileName, { info, parts, rows: [] }).get(fileName);

    f.rows.push({ at: m.at, hm: parts.hm, who, text });
  }

  return files;
}

/** 一个已有文件的内容 → { header, rows: [{ hm, who, text, raw }] }。不是消息行的（空行、标题）归到 header / 上一条。 */
export function parseChatLogFile(content) {
  const header = [];
  const rows = [];

  for (const raw of String(content ?? '').split('\n')) {
    const p = parseChatLogLine(raw);

    if (p) rows.push({ ...p, raw });
    else if (rows.length === 0) header.push(raw);
    else if (raw.trim()) rows[rows.length - 1].raw += `\n${raw}`;
  }

  while (header.length > 0 && header[header.length - 1] === '') header.pop();

  return { header: header.join('\n'), rows };
}

const minuteOf = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/**
 * 把新来的行合进已有文件的行。已经有的（同一个人、同样的话、差 1 分钟以内，一对一消耗）不重复；
 * 其余的按钟点插进去（已有的行保持原来的先后）。返回 { rows, added }。
 */
export function mergeRows(existing, incoming) {
  const pool = existing.map((r) => ({ ...r, taken: false }));
  const fresh = [];

  for (const n of incoming) {
    const t = String(n.text).trim();
    const hit = pool.find((e) => !e.taken && e.who === n.who && e.text.trim() === t && Math.abs(minuteOf(e.hm) - minuteOf(n.hm)) <= 1);

    if (hit) hit.taken = true;
    else fresh.push(n);
  }

  const merged = existing.map((r, i) => ({ ...r, order: i, from: 0 }));
  const base = merged.length;

  fresh.forEach((n, i) => merged.push({ hm: n.hm, who: n.who, text: n.text, raw: '', order: base + i, from: 1 }));
  merged.sort((a, b) => minuteOf(a.hm) - minuteOf(b.hm) || a.from - b.from || a.order - b.order);

  return { rows: merged, added: fresh.length };
}

/**
 * 把整理好的行写进目录（dryRun 为 true 只统计不写）。返回 { files: [{ name, existing, added, total }], added, filesTouched, filesCreated }。
 * 已有文件的原样内容保留（只是新行插进去），新文件用 chatLogHeader 起头。写之前先写临时文件再改名。
 */
export function writeChatLogs(files, dir, { dryRun = true } = {}) {
  const report = { files: [], added: 0, filesTouched: 0, filesCreated: 0 };

  for (const [name, f] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = path.join(dir, name);
    let content = '';
    let exists = false;

    try { content = fs.readFileSync(file, 'utf8'); exists = true; } catch { /* 新文件 */ }

    const parsed = parseChatLogFile(content);
    // 先过一遍写文件时的同一套整理（名字去星号、换行压平、控制字符、截断），再去跟文件里已有的比：两边口径一样才对得上
    const incoming = f.rows.map((r) => parseChatLogLine(chatLogLine(r.hm, r.who, r.text))).filter(Boolean);
    const { rows, added } = mergeRows(parsed.rows, incoming);

    report.files.push({ name, existing: parsed.rows.length, added, total: rows.length });

    if (added === 0) continue;

    report.added += added;
    report.filesTouched += 1;

    if (!exists) report.filesCreated += 1;

    if (dryRun) continue;

    const header = parsed.header || chatLogHeader(f.info, f.parts).trimEnd();
    const body = rows.map((r) => (r.raw || chatLogLine(r.hm, r.who, r.text))).join('\n');

    fs.mkdirSync(dir, { recursive: true });

    const tmp = `${file}.tmp`;

    fs.writeFileSync(tmp, `${header}\n\n${body}\n`);
    fs.renameSync(tmp, file);
  }

  return report;
}

// ── 抖音私信（chat-inbox.jsonl）───────────────────────────────────────────────

/** 抖音私信一行的文字表示（跟 bridge.js 的 douyinDmTextV2 同一个口径）。 */
export function douyinDmText(e) {
  if (e?.text) return String(e.text);

  const m = e?.media || {};

  if (m.type === 'shared-work') return `[分享了一个抖音视频${m.title ? `《${String(m.title).slice(0, 40)}》` : ''}${m.author ? ` @${m.author}` : ''}]`;
  if (m.type === 'emoji') return '[表情]';
  if (m.type === 'photo') return '[图片]';

  return e?.unsupported ? '[这条抖音网页版显示不了]' : '[消息]';
}

/**
 * chat-inbox.jsonl 的行 → buildChatLogRows 的 items。allowlist：chat-policy.json 里的 allowlist（{ id, name, role }）。
 * 抖音私信没有 QQ 会话 key，这里用 `private:douyin` 之类的假 key 太乱，所以直接带 sessionSpec 成品：{ session, who, text, at }。
 */
export function douyinRows(rows, allowlist, { skewMs = 0, selfName = '小鲸鱼' } = {}) {
  const list = (Array.isArray(allowlist) ? allowlist : []).filter((a) => a && typeof a === 'object');
  const files = new Map();

  for (const e of rows) {
    const at = Number(e?.at);

    if (!Number.isFinite(at) || at <= 0) continue;

    const item = list.find((a) => a.id === e.recipientId);
    const legacyOwner = list.length === 1 && !list.some((a) => a.role) && item;
    const isOwner = item?.role === 'owner' || Boolean(legacyOwner);
    const friend = String(item?.name || e.name || '朋友');
    const info = sessionInfo(isOwner ? { type: 'douyin-owner' } : { type: 'douyin-friend', name: friend }, selfName);
    const parts = bjParts(at, skewMs);
    const text = douyinDmText(e);
    const name = chatLogFileName(parts.day, info);
    const f = files.get(name) || files.set(name, { info, parts, rows: [] }).get(name);

    f.rows.push({ at, hm: parts.hm, who: e.direction === 'outgoing' ? selfName : (isOwner ? '老大' : friend), text });
  }

  for (const f of files.values()) f.rows.sort((a, b) => a.at - b.at);

  return files;
}

/** 两份 files（Map）合并：同名文件的行并起来（按时间排）。 */
export function mergeFileMaps(...maps) {
  const out = new Map();

  for (const m of maps) {
    for (const [name, f] of m) {
      const cur = out.get(name);

      if (!cur) out.set(name, { ...f, rows: [...f.rows] });
      else cur.rows.push(...f.rows);
    }
  }

  for (const f of out.values()) f.rows.sort((a, b) => a.at - b.at);

  return out;
}

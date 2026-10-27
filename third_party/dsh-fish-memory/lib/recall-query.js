// 召回线索（2026-10-23，本机补丁，非上游代码）
//
// 以前的线索是「这一轮塞进 inbox 的整条消息」。在 qq-bridge 这种唤醒式的会话里，
// 那条消息是一万多字的唤醒提示词（时间 / 天气 / 太阳 / 角色卡 / 快照……），
// 对方真正说的那几句被淹在里面 —— 实测 16 次唤醒、100 条 trace 只有 5 种线索，
// 命中的全是跟模板措辞撞车的条目（「太阳天气同步」「音频」）。
//
// 这个文件只干一件事：**从一段文字里找出「对方刚说的话」+「她自己最后一句」**，拼成一条短线索。
// 纯函数、不碰 DSH、不读盘，脚本能单独测。
//
// 取法按优先级：
//   a. 唤醒词里有 【对方刚说】 标记块（桥接以后会加）→ 直接用里面的行
//   b. 没有就解析现有唤醒词：
//        1) 【本次消息快照】 的 JSON：messages（这次新来的）→ 非自己的最后 3 条
//        2) 【抖音私信】 块（抖音那边找她）
//        3) 快照 JSON 的 recent（最近几句）→ 非自己的最后 3 条
//        4) 【你只有一个】 里「▸ **你现在正在这儿**」那一段的最后几句
//        5) 【这里最近的聊天（原文，最后几十句）】 的最后几句
//      她自己最后一句：从同样这些地方找（快照 isSelf / 「你：」行）
//   c. 都没有 → 整段文字去噪后截断（普通会话里用户直接打字就是这种，等于老行为）
//
// 隐私：线索会写进 trace 落盘，所以这里把 【会话令牌】 行、16 位以上的十六进制串、
//       6 位以上的数字（QQ 号 / 群号 / messageId）、conv:/msg: 之类的 id 全洗掉。

export const QUERY_CAP = 300;
const OTHERS_KEEP = 3;

const SELF_NAMES = new Set(["你", "我"]);
// 这些「名字」只是占位，不带信息，拼线索时不写出来
const GENERIC_NAMES = new Set([
  "对方",
  "私聊",
  "群",
  "群友",
  "用户",
  "incoming",
  "outgoing",
]);

// 这些 【…】 开头的整行是模板噪音，直接扔
const NOISE_HEADERS =
  /^\s*【(?:当前时间|今天的天气|你的太阳|此刻状态|当前唤醒|参与度参考|会话令牌|本次消息快照)】.*$/gm;

// ---------- 去噪 ----------

export function stripNoise(input) {
  let t = String(input || "").replaceAll("\r", "");
  t = t.replaceAll(/^.*【会话令牌】.*$/gm, "");
  t = t.replaceAll(NOISE_HEADERS, "");
  t = t.replaceAll(/【[^】\n]{1,40}】/g, "");
  // 链接整个去掉（里面常带 id，而且对召回没用）
  t = t.replaceAll(/https?:\/\/\S+/g, "");
  // （messageId=…）/ (recipientId=…) 这类括号整个去掉
  t = t.replaceAll(
    /[（(]\s*(?:messageId|recipientId|videoId|userId|ownerQQ|key|token|throughSeq|afterSeq|readThroughSeq|seq)\s*[=:：][^（）()]*[）)]/gi,
    "",
  );
  t = t.replaceAll(
    /\b(?:messageId|recipientId|videoId|userId|ownerQQ|throughSeq|afterSeq|readThroughSeq|token)\s*[=:：]\s*[\w:.-]+/gi,
    "",
  );
  // conv:xxx / msg:xxx / private:123 / group:123 / call_00_xxx
  t = t.replaceAll(/\b(?:conv|msg|private|group):[\w-]{4,}/g, "");
  t = t.replaceAll(/\bcall_\w{6,}/g, "");
  // 十六进制长串（会话令牌、哈希）
  t = t.replaceAll(/\b[0-9a-f]{16,}\b/gi, "");
  // 时间戳
  t = t.replaceAll(/\[\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
  t = t.replaceAll(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
  t = t.replaceAll(
    /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g,
    "",
  );
  t = t.replaceAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "");
  // 6 位以上的数字（QQ 号 / 群号 / messageId / 时间戳）
  t = t.replaceAll(/\d{6,}/g, "");
  // 媒体占位
  t = t.replaceAll(/\[表情包[:：][^\]]*\]/g, "");
  t = t.replaceAll(
    /\[(?:图片|表情|消息|语音|视频|文件|动画表情|红包|转发|合并转发|链接|卡片)\]/g,
    "",
  );
  // 其它方括号只去括号留内容（[分享了一个抖音视频 @xx] → 分享了一个抖音视频 @xx）
  t = t.replaceAll(/\[([^[\]\n]{1,80})\]/g, "$1");
  t = t.replaceAll("**", "").replaceAll(/[▸•]/g, "");
  // 收拾空白
  t = t.replaceAll(/[ \t\u3000]+/g, " ");
  t = t.replaceAll(/ *\n */g, "\n").replaceAll(/\n{2,}/g, "\n");

  return t.trim();
}

// 一条消息去噪后还剩不剩东西（纯占位「[图片]」洗完就空了）
function cleanText(s) {
  return stripNoise(s).replaceAll(/\n+/g, " ").trim();
}

function isSelfName(name, selfName) {
  if (!name) return false;
  if (SELF_NAMES.has(name)) return true;

  return Boolean(selfName) && name === selfName;
}

function displayName(name) {
  if (!name) return "";

  const n = String(name).trim();

  if (!n || GENERIC_NAMES.has(n)) return "";

  return n.slice(0, 24);
}

// 「[21:14] 对方：好~」/「主人：好~」→ { name, text }；认不出就 null
const CHAT_LINE =
  /^\s*(?:\[[^\]\n]{3,20}\]\s*)?([^\s：:【】[\]▸][^：:\n]{0,23})[：:]\s*(.*)$/;
export function parseChatLine(line, { requireStamp = false } = {}) {
  const s = String(line || "");

  if (requireStamp && !/^\s*\[[^\]\n]{3,20}\]\s*/.test(s)) return null;

  const m = CHAT_LINE.exec(s);

  if (!m) return null;

  return { name: m[1].trim(), text: m[2] };
}

// ---------- a. 【对方刚说】 标记块 ----------
// 期望格式（桥接加）：
//   【对方刚说】
//   主人：我下班啦
//   主人：带伞了没
//   你：带了带了
//   <空行 或 下一个 【…】 标题>
export function parseMarkerBlock(text, selfName) {
  const src = String(text || "").replaceAll("\r", "");
  const idx = src.indexOf("【对方刚说】");

  if (idx === -1) return null;

  const after = src.slice(idx + "【对方刚说】".length);
  const lines = after.split("\n");
  // 标题同一行也可能带内容
  const others = [];
  let mine = "";
  let started = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (!started) {
      started = true;

      if (!line) continue;
    } else if (!line || line.startsWith("【")) break;

    const p = parseChatLine(line);

    if (!p) {
      const t = cleanText(line);

      if (t) others.push({ name: "", text: t });

      continue;
    }

    const t = cleanText(p.text);

    if (!t) continue;
    if (isSelfName(p.name, selfName)) mine = t;
    else others.push({ name: displayName(p.name), text: t });
  }

  if (others.length === 0 && !mine) return null;

  return { others, mine, source: "marker" };
}

// ---------- b. 现有唤醒词 ----------

// 【本次消息快照】 后面那一行 JSON
export function parseSnapshotJson(text) {
  const src = String(text || "");
  const idx = src.indexOf("【本次消息快照】");

  if (idx === -1) return null;

  const rest = src.slice(idx);
  const brace = rest.indexOf("{");

  if (brace === -1) return null;

  const lineEnd = rest.indexOf("\n", brace);
  const candidate = rest
    .slice(brace, lineEnd === -1 ? undefined : lineEnd)
    .trim();

  try {
    const j = JSON.parse(candidate);

    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function itemsToTurns(items, selfName) {
  const others = [];
  const mine = [];

  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;

    const t = cleanText(it.text);

    if (!t) continue;

    const sender = typeof it.sender === "string" ? it.sender : "";
    const self = it.isSelf === true || isSelfName(sender, selfName);

    if (self) {
      mine.push(t);
      continue;
    }

    const name = it.isOwner === true ? "主人" : displayName(sender);
    others.push({ name, text: t });
  }

  return { others, mine };
}

// 【抖音私信】主人在抖音私信里跟你说：
//   [21:29] [分享了一个抖音视频 @xx]（messageId=…）
// 【抖音私信·朋友】抖音上互关的朋友「某某」私信你：
//   [21:03] 写实小猫咪
export function parseDouyinDmBlock(text) {
  const src = String(text || "").replaceAll("\r", "");
  const lines = src.split("\n");
  let name = "";
  const others = [];
  let inBlock = false;

  for (const raw of lines) {
    if (!inBlock) {
      const m = /^【抖音私信[^】]*】(.*)$/.exec(raw);

      if (!m) continue;

      inBlock = true;
      const head = m[1];

      if (/主人/.test(head)) name = "主人";
      else {
        const q = /「([^」]{1,24})」/.exec(head);
        name = q ? displayName(q[1]) : "";
      }

      continue;
    }

    const m = /^\s+\[\d{1,2}:\d{2}(?::\d{2})?\]\s*(.*)$/.exec(raw);

    if (!m) break;

    const t = cleanText(m[1]);

    if (t) others.push({ name, text: t });
  }

  return others.length > 0 ? others : null;
}

// 「▸ **你现在正在这儿**（主人私聊）」下面那一段
export function parseHereSection(text, selfName) {
  const src = String(text || "").replaceAll("\r", "");
  const lines = src.split("\n");
  let i = lines.findIndex((l) => /^\s*▸\s*\*\*你现在正在这儿\*\*/.test(l));

  if (i < 0) return null;

  // 「（主人私聊）」里的「对方」就是主人
  const ownerHere = /主人/.test(lines[i]);
  const others = [];
  const mine = [];

  for (i += 1; i < lines.length; i++) {
    const raw = lines[i];

    if (!/^\s+\[\d{1,2}:\d{2}/.test(raw)) break;

    const p = parseChatLine(raw, { requireStamp: true });

    if (!p) continue;

    const t = cleanText(p.text);

    if (!t) continue;
    if (isSelfName(p.name, selfName)) mine.push(t);
    else {
      const name = displayName(p.name);
      others.push({ name: name || (ownerHere ? "主人" : ""), text: t });
    }
  }

  if (others.length === 0 && mine.length === 0) return null;

  return { others, mine };
}

// 【这里最近的聊天（原文，最后几十句）】
// [10-23 18:46] 主人：…
export function parseRecentChatBlock(text, selfName) {
  const src = String(text || "").replaceAll("\r", "");
  const idx = src.indexOf("【这里最近的聊天");

  if (idx === -1) return null;

  const lines = src.slice(idx).split("\n").slice(1);
  const others = [];
  const mine = [];

  for (const raw of lines) {
    const line = raw.trim();

    if (!line || line.startsWith("【")) break;

    const p = parseChatLine(line, { requireStamp: true });

    if (!p) continue;

    const t = cleanText(p.text);

    if (!t) continue;
    if (isSelfName(p.name, selfName)) mine.push(t);
    else others.push({ name: displayName(p.name), text: t });
  }

  if (others.length === 0 && mine.length === 0) return null;

  return { others, mine };
}

function last(arr) {
  return arr && arr.length > 0 ? arr.at(-1) : "";
}

// 整段唤醒词 → { others, mine, source }
export function parseWakePrompt(text, selfName) {
  const src = String(text || "");

  if (!src) return null;

  const snap = parseSnapshotJson(src);
  const snapNew = snap
    ? itemsToTurns(snap.messages, selfName)
    : { others: [], mine: [] };
  const snapRecent = snap
    ? itemsToTurns(snap.recent, selfName)
    : { others: [], mine: [] };
  const douyin = parseDouyinDmBlock(src);
  const here = parseHereSection(src, selfName);
  const recent = parseRecentChatBlock(src, selfName);

  // 她自己最后一句：新消息里有就用，否则按「快照 recent → 正在这儿 → 最近聊天」找
  const mine =
    last(snapNew.mine) ||
    last(snapRecent.mine) ||
    (here ? last(here.mine) : "") ||
    (recent ? last(recent.mine) : "");

  if (snapNew.others.length > 0)
    return { others: snapNew.others, mine, source: "snapshot-new" };
  if (douyin) return { others: douyin, mine, source: "douyin-dm" };
  if (snapRecent.others.length > 0)
    return { others: snapRecent.others, mine, source: "snapshot-recent" };
  if (here && here.others.length > 0)
    return { others: here.others, mine, source: "here" };
  if (recent && recent.others.length > 0)
    return { others: recent.others, mine, source: "recent-chat" };
  if (mine) return { others: [], mine, source: "self-only" };

  return null;
}

// ---------- 拼线索 ----------

export function composeQuery(others, mine, cap = QUERY_CAP) {
  const lines = [];

  for (const o of (others || []).slice(-OTHERS_KEEP)) {
    if (!o || !o.text) continue;

    lines.push(o.name ? `${o.name}：${o.text}` : o.text);
  }

  const mineLine = mine ? `我：${mine}` : "";
  const floor = 1; // 至少留一句对方的
  let q = [...lines, ...(mineLine ? [mineLine] : [])].join("\n");

  while (q.length > cap && lines.length > floor) {
    lines.shift();
    q = [...lines, ...(mineLine ? [mineLine] : [])].join("\n");
  }

  if (q.length > cap) q = q.slice(0, cap);

  return q;
}

// 入口：一段文字（唤醒词 / 普通用户消息）→ { query, source }
export function buildRecallQuery(
  text,
  { selfName = "", cap = QUERY_CAP } = {},
) {
  const src = String(text || "");

  if (!src.trim()) return { query: "", source: "empty" };

  const marker = parseMarkerBlock(src, selfName);

  if (marker)
    return {
      query: composeQuery(marker.others, marker.mine, cap),
      source: "marker",
    };

  const parsed = parseWakePrompt(src, selfName);

  if (parsed) {
    const q = composeQuery(parsed.others, parsed.mine, cap);

    if (q) return { query: q, source: parsed.source };
  }

  // c. 退路：整段去噪截断（普通会话里用户直接打的字就走这儿 = 老行为）
  const flat = stripNoise(src).replaceAll(/\n+/g, " ").trim();

  return { query: flat.slice(0, cap), source: "fallback" };
}

// 这一轮已经注进去的不再给：返回 { fresh, dup }，并把 fresh 的 id 记进 injected
//   selected 是 recall() 挑中的那几条（{ m, s, … }），injected 是这一轮已注入 id 的 Set
export function dedupeSelected(selected, injected) {
  const fresh = [];
  const dup = new Set();

  for (const r of Array.isArray(selected) ? selected : []) {
    if (!r) continue;

    const id = String(r.m && r.m.id !== undefined ? r.m.id : r.id);

    if (injected.has(id)) dup.add(id);
    else {
      injected.add(id);
      fresh.push(r);
    }
  }

  return { fresh, dup };
}

// ---------- 中途：工具返回里的新消息 ----------

// mcp__snowluma__qq_wait_for_messages → qq_wait_for_messages
export function baseToolName(name) {
  return String(name || "").replace(/^mcp__.+?__/, "");
}

const INBOX_TOOLS =
  /^(?:qq_wait_for_messages|qq_get_unread_messages|qq_get_recent_messages|douyin_chat_read|douyin_chat_observe|douyin_inbox\w*|douyin_dm\w*|douyin_chat_poll)$/;
export function isInboxTool(name) {
  return INBOX_TOOLS.test(baseToolName(name));
}

function tryJson(text) {
  const s = String(text || "").trim();

  if (!s || s[0] !== "{") return null;

  try {
    const j = JSON.parse(s);

    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

// qq_wait_for_messages 返回里的 douyinDm.text：
//   【抖音私信·朋友】抖音上互关的朋友「某某」私信你：\n  [21:03] 写实小猫咪\n想回就用 …
function parseDouyinDmText(text) {
  const src = String(text || "");

  if (!src) return [];

  const headMatch = /^【抖音私信[^】]*】(.*)$/m.exec(src);
  let name = "";

  if (headMatch) {
    if (/主人/.test(headMatch[1])) name = "主人";
    else {
      const q = /「([^」]{1,24})」/.exec(headMatch[1]);
      name = q ? displayName(q[1]) : "";
    }
  }

  const others = [];

  for (const raw of src.split("\n")) {
    const m = /^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*(.*)$/.exec(raw);

    if (!m) continue;

    const t = cleanText(m[1]);

    if (t) others.push({ name, text: t });
  }

  return others;
}

// 工具返回 → { others, mine } ；不是收件类工具 / 没新消息 → null
export function extractIncomingFromToolResult(
  toolName,
  resultText,
  { selfName = "" } = {},
) {
  if (!isInboxTool(toolName)) return null;

  const base = baseToolName(toolName);
  const j = tryJson(resultText);

  if (!j) return null;

  let others = [];
  let mine = "";

  if (base.startsWith("qq_")) {
    const fromNew = itemsToTurns(j.newMessages, selfName);
    const fromList =
      fromNew.others.length > 0 ? fromNew : itemsToTurns(j.messages, selfName);
    others = fromList.others;
    mine = last(fromList.mine);

    if (j.douyinDm && typeof j.douyinDm.text === "string")
      others = [...others, ...parseDouyinDmText(j.douyinDm.text)];
  } else {
    // douyin_chat_read 之类：只要「这次新到的」（eligibleForReply / arrivalClassification 带 new）
    const who = displayName(
      (j.conversation && j.conversation.displayName) ||
        (j.contact && j.contact.displayName) ||
        "",
    );
    const msgs = Array.isArray(j.messages) ? j.messages : [];

    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;

      const t = cleanText(m.text);

      if (!t) continue;
      if (m.direction === "outgoing") {
        mine = t;
        continue;
      }

      if (m.direction !== "incoming") continue;

      const fresh =
        m.eligibleForReply === true ||
        /new/i.test(String(m.arrivalClassification || ""));

      if (fresh) others.push({ name: who, text: t });
    }
  }

  if (others.length === 0) return null;

  return { others, mine };
}

// 会话事件 → 这一轮里最新一次「带新消息」的工具返回
//   events：session.snapshotEvents() 的数组（按 seq 升序）
//   textOf：把 message 抽成文字（宿主那边有 textOfMessage，传进来；不传就用内置的）
// 返回 { seq, tool, others, mine } 或 null
export function scanMidTurn(
  events,
  { selfName = "", textOf = defaultTextOf } = {},
) {
  const ev = Array.isArray(events) ? events : [];
  let start = -1;

  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i];

    if (e && (e.type || e.kind) === "turn/start") {
      start = i;
      break;
    }
  }

  if (start < 0) return null;

  const turn =
    ev[start].data && typeof ev[start].data.turn === "number"
      ? ev[start].data.turn
      : null;
  const names = new Map();
  let found = null;

  for (let i = start + 1; i < ev.length; i++) {
    const e = ev[i];

    if (!e) continue;

    const type = e.type || e.kind;
    const d = e.data || e.payload || {};

    if (type === "tool/call") {
      if (d.callId) names.set(d.callId, d.name);

      continue;
    }

    if (type !== "tool/result") continue;
    if (turn !== null && typeof d.turn === "number" && d.turn !== turn)
      continue;

    const msg = d.message || d;
    const callId =
      (msg && (msg.toolCallId || (msg.source && msg.source.callId))) ||
      d.callId;
    const tool = names.get(callId) || d.name || "";

    if (!tool || !isInboxTool(tool)) continue;
    if (msg && msg.isError) continue;

    const got = extractIncomingFromToolResult(tool, textOf(msg), { selfName });

    if (got) found = { seq: e.seq, tool, others: got.others, mine: got.mine };
  }

  return found;
}

function defaultTextOf(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  if (typeof p.text === "string") return p.text;
  if (typeof p.content === "string") return p.content;
  if (Array.isArray(p.content)) {
    const parts = [];

    for (const b of p.content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b.text === "string") parts.push(b.text);
    }

    return parts.join("\n");
  }

  return "";
}

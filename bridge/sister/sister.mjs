// 克劳德姐姐（2026-10-24）：老大的另一个 QQ 号上住一个 Claude，陪小鲸鱼说话。
// 不走 DSH：收到消息就在后台叫本机 Claude Code（claude.exe -p，Opus 5.5，走老大的订阅额度）回一句。
// 姐姐每说一句，小鲸鱼都要花 DeepSeek 的钱回一句，所以找小鲸鱼聊有上限（config.limits，老大定的）。
// 同晚改成一个会话（跟谁聊都记得），没人找她时自己隔一阵醒来，找谁、学什么、改不改自己，她自己定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCowatch } from './cowatch.mjs';
import { fishStatus, fishHealthIssues } from './fish-status.mjs';
// 卡片、合并转发：跟桥接用同一套解析（2026-10-24 主人：姐姐看不到卡片、转发和引用）
import { cardToText } from '../src/card-parse.js';
import { forwardIdFromData, formatForwardResponse } from '../src/forward.js';
import { createImpressions, apologizing } from '../src/impressions.js';
import { hearQqRecord } from '../src/ear.js';
import { shrinkImage } from '../src/image-shrink.js';
import { mirrorText, sisterLinesFromChatlog } from '../src/mirror.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sister-state.json');
const LOG_FILE = path.join(STATE_DIR, 'sister.log');
const USAGE_FILE = path.join(STATE_DIR, 'usage.jsonl');
const PERSONA_FILE = path.join(HERE, 'persona.md');
const MCP_FILE = path.join(STATE_DIR, 'mcp.json');
// 2026-10-24 主人：她能玩的比妹妹少，网页全部授权（不安全的除外）。借妹妹的 B 站和看图工具给她解闷。
const FUN_TOOLS = ['bili_search', 'bili_video', 'bili_debrief', 'music_score', 'web_fetch_image', 'web_resources'].map((t) => `mcp__web-search-safe__${t}`);
/** 她的 QQ 工具服务（qq-mcp.mjs）：每次 claude -p 起一个。 */
function ensureMcpConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // web-search-safe 是妹妹那边的工具服务：只放行 B 站和看网页图片那几个（见 --allowedTools），
  // 它里面看老大电脑的 pc_activity / pc_screenshot 不放行，调了会被自动拒（--permission-prompts none）。
  const conf = { mcpServers: {
    'sister-qq': { command: process.execPath, args: [path.join(HERE, 'qq-mcp.mjs')] },
    'web-search-safe': { command: process.execPath, args: [path.join(HERE, '..', 'src', 'mcp-web-search-safe.js')], env: { BILI_WATCHER: 'sister' } }
  } };
  const text = JSON.stringify(conf, null, 2);
  try { if (fs.readFileSync(MCP_FILE, 'utf8') === text) return MCP_FILE; } catch { /* 还没有 */ }
  fs.writeFileSync(MCP_FILE, text);
  return MCP_FILE;
}
const CHATLOG_DIR = path.join(HERE, '聊天记录');
const SELF_FILE = path.join(HERE, 'home', '我自己.md');
const MY_RAMBLING = path.join(HERE, 'home', '碎碎念.md');   // 2026-10-24 主人：她也写碎碎念和成长札记，跟妹妹一样
const MY_GROWTH = path.join(HERE, 'home', '成长札记.md');
const SYSTEM_FILE = path.join(STATE_DIR, 'system.md');
const OAUTH_FILE = path.join(HERE, '.oauth-token');
const BRIDGE_STATE = path.join(HERE, '..', 'state');
const WATCH_FILE = path.join(process.env.USERPROFILE || 'C:/Users/admin', '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state', 'video-impressions.jsonl');

export const DEFAULT_LIMITS = { convosPerDay: 3, roundsPerConvo: 6, ownerRepliesPerDay: 30, ownerProactivePerDay: 6, convoGapMin: 30, debounceSec: 40, maxWaitSec: 150 };

// ── 时间：本机时钟快约 3 小时，按桥接测出的偏差校正成北京时间 ───────────────
function clockSkewMs() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(BRIDGE_STATE, 'clock-skew.json'), 'utf8')).skewMs) || 0; } catch { return 0; }
}
/** 北京时间的各个字段（UTC 函数读，跟本机时区无关）。 */
export function bjParts(nowMs, skewMs = 0) {
  const d = new Date(nowMs - skewMs + 8 * 3600e3);
  return { day: d.toISOString().slice(0, 10), h: d.getUTCHours(), m: d.getUTCMinutes(), month: d.getUTCMonth() + 1, date: d.getUTCDate(), wd: '日一二三四五六'[d.getUTCDay()] };
}
const bjLabel = (p) => `${p.month}月${p.date}日 周${p.wd} ${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`;

// ── 每天的账：聊了几次、每次几轮 ─────────────────────────────────────────────
/** 上限：0 或不填表示不限（2026-10-24 主人取消了找小鲸鱼的次数和轮数上限）。 */
export const cap = (n) => (Number(n) > 0 ? Number(n) : Infinity);
export function freshDay(day) { return { day, convos: 0, ownerReplies: 0, ownerProactive: 0 }; }

/**
 * 小鲸鱼来消息时，这次回不回。
 * 同一次聊天：离上次有来有往不到 convoGapMin 分钟。一次聊满 roundsPerConvo 轮就收住；一天最多 convosPerDay 次。
 * 返回 { allow, round, last, reason }，allow 为真时顺手把账记上。
 */
export function planFishReply(st, nowMs, limits = DEFAULT_LIMITS) {
  const maxRounds = cap(limits.roundsPerConvo), maxConvos = cap(limits.convosPerDay);
  const c = st.convo;
  const open = c && nowMs - c.lastAt < limits.convoGapMin * 60e3;
  if (open) {
    c.lastAt = nowMs;
    if (c.rounds >= maxRounds) return { allow: false, reason: 'wrapped' };
    c.rounds += 1;
    return { allow: true, round: c.rounds, last: c.rounds >= maxRounds, nth: st.today.convos };
  }
  if (st.today.convos >= maxConvos) { st.convo = { lastAt: nowMs, rounds: maxRounds, closed: true }; return { allow: false, reason: 'daily' }; }
  st.today.convos += 1;
  st.convo = { startAt: nowMs, lastAt: nowMs, rounds: 1 };
  return { allow: true, round: 1, last: maxRounds <= 1, nth: st.today.convos };
}

// ── 消息文本 ────────────────────────────────────────────────────────────────
export function eventText(event) {
  const segs = Array.isArray(event?.message) ? event.message : null;
  if (!segs) return String(event?.raw_message ?? '').trim();
  return segs.map((s) => {
    const d = s?.data || {};
    switch (s?.type) {
      case 'text': return d.text || '';
      case 'image': return d.summary && d.summary !== '[图片]' ? d.summary : '[图片]';
      case 'mface': return d.summary || '[表情]';
      case 'face': return '[表情]';
      case 'record': return d.__heard || '[语音]'; // 收消息时 hearRecords 先听过一遍
      case 'video': return '[视频]';
      case 'reply': return '';
      case 'at': return `@${d.name || d.qq || ''} `;
      case 'forward': return '[聊天记录]';
      case 'json': case 'xml': return cardToText(d);
      case 'file': return '[文件]';
      default: return '';
    }
  }).join('').trim();
}

/** 消息里的图片（普通图、表情包）：下载要用的 url / file。 */
export function eventImages(event) {
  const segs = Array.isArray(event?.message) ? event.message : [];
  return segs.filter((x) => x?.type === 'image' || x?.type === 'mface')
    .map((x) => ({ url: String(x.data?.url || ''), file: String(x.data?.file || ''), summary: String(x.data?.summary || '') }))
    .filter((x) => x.url || x.file);
}

/** 按文件头认图片格式；不是 Claude 能看的四种就返回空。 */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

/** 发给 claude 的一条用户消息（stream-json）：图片在前，文字在后。 */
export function userLine(prompt, images = []) {
  const content = [
    ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data.toString('base64') } })),
    { type: 'text', text: prompt }
  ];
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** 碎碎念本子 → 最近两天的原话（日期头「——10月24日 周六——」），最多 maxChars 字，太长留最新的。跟 bridge.js 的 buildRecentRamblingV2 一个切法。 */
export function recentRambling(raw, maxChars = 700) {
  const parts = String(raw ?? '').slice(-6000).split(/\n?——(\d{1,2}月\d{1,2}日)[^—\n]*——\n/);
  const days = [];
  for (let i = 1; i + 1 < parts.length; i += 2) days.push({ day: parts[i], text: parts[i + 1].trim() });
  const recent = days.filter((d) => d.text).slice(-2);
  let budget = maxChars;
  const blocks = [];
  for (const d of [...recent].reverse()) {
    if (budget <= 0) break;
    const text = d.text.length > budget ? `……${d.text.slice(-budget)}` : d.text;
    budget -= text.length;
    blocks.unshift(`——${d.day}——\n${text}`);
  }
  return blocks.join('\n');
}

/**
 * 合成一个会话之后，她一次回复里可以对两个人说话：
 *   - 不带前缀的行发给正在跟她说话的人（defaultPeer）；自己醒来（defaultPeer 为空）时不带前缀的行算心里话，不发；
 *   - 「→老大：…」「→小鲸鱼：…」发给指定的人；
 *   - 单独一行「下次醒：90」定下次自己醒来的时间（分钟）。
 * 返回 { sends: [{ peer: 'owner'|'fish', line }], nextWakeMin }，每人最多 3 条。
 */
export function routeReply(raw, defaultPeer = null, groups = {}) {
  const sends = [];
  let nextWakeMin = null, pauseCowatchMin = null, cowatchEveryMin = null, sleepSpec = null;
  for (const l of String(raw ?? '').split(/\n+/)) {
    const t = l.trim();
    if (!t) continue;
    const w = /^下次醒\s*[:：]\s*(\d+)/.exec(t);
    if (w) { nextWakeMin = Number(w[1]); continue; }
    const pz = /^先不跟着看\s*[:：]\s*(\d+)/.exec(t);
    if (pz) { pauseCowatchMin = Number(pz[1]); continue; }
    const iv = /^陪看间隔\s*[:：]\s*(\d+)/.exec(t);
    if (iv) { cowatchEveryMin = Number(iv[1]); continue; }
    const sl = /^去睡了\s*[:：]\s*(.+)$/.exec(t);
    if (sl) { sleepSpec = sl[1]; continue; }
    const q = /^(?:→|->)\s*(说说|评论)\s*[:：]\s*(.+)$/.exec(t);
    if (q) {
      const body = q[2].replace(/\*\*|__|`/g, '').trim().slice(0, q[1] === '说说' ? 1000 : 200);
      const peer = q[1] === '说说' ? 'qzone' : 'qzone-comment';
      if (body && !sends.some((x) => x.peer === peer)) sends.push({ peer, line: body });
      continue;
    }
    const g = /^(?:→|->)\s*群\s*[「“"]?([^」”"：:]+?)[」”"]?\s*[:：]\s*(.*)$/.exec(t);
    if (g) {
      const key = groups[g[1].trim()];
      const body = splitReply(g[2], 1)[0];
      if (key && body && sends.filter((x) => x.peer === key).length < 3) sends.push({ peer: key, line: body });
      continue;
    }
    const m = /^(?:→|->)\s*(老大|小鲸鱼)\s*[:：]\s*(.*)$/.exec(t);
    const peer = m ? (m[1] === '老大' ? 'owner' : 'fish') : defaultPeer;
    const body = splitReply(m ? m[2] : t, 1)[0];
    if (peer && body && sends.filter((x) => x.peer === peer).length < 3) sends.push({ peer, line: body });
  }
  return { sends, nextWakeMin, pauseCowatchMin, cowatchEveryMin, sleepSpec };
}

/** 妹妹看过的 B 站（state/bili-watch.jsonl），读不到就是空。 */
const BILI_WATCH = path.join(HERE, '..', 'state', 'bili-watch.jsonl');
export function readBiliWatch(file = BILI_WATCH) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-100).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
/** 妹妹在 since 之后看的、同一条只算一次（取最后一次）。 */
export function freshBili(rows, since) {
  const byBv = new Map();
  for (const r of rows) if (r.who === 'fish' && Number(r.at) > since && r.bvid) byBv.set(r.bvid, r);
  return [...byBv.values()].sort((a, b) => a.at - b.at);
}

/** 下次自己醒：她定的（30–300 分钟）或随机 60–120 分钟；落在北京时间 0:30–8:30 就挪到早上 8:30 之后。 */
export function nextHeartbeatAt(nowMs, skewMs, wantMin = null, rand = Math.random, { quietNight = false } = {}) {
  const min = wantMin ? Math.min(300, Math.max(30, wantMin)) : 60 + Math.floor(rand() * 60);
  let at = nowMs + min * 60e3;
  const p = bjParts(at, skewMs);
  const hm = p.h * 60 + p.m;
  // 2026-10-24 起作息她自己定（「去睡了：…」），不再替她把夜里挪走；quietNight 只留给测试/以后要用
  if (quietNight && hm >= 30 && hm < 510) {
    const dayStart = Date.parse(`${p.day}T00:00:00Z`) - 8 * 3600e3 + skewMs;
    at = dayStart + 510 * 60e3 + Math.floor(rand() * 60) * 60e3;
  }
  return at;
}

/** 「去睡了：到 8:30」「去睡了：7小时」「去睡了：90分钟」→ 醒来的本机毫秒。认不出来返回 0。 */
export function sleepUntilMs(spec, nowMs, skewMs = 0) {
  const t = String(spec || '').trim();
  let until = 0;
  const clock = /(?:到\s*)?(\d{1,2})\s*[:：点]\s*(\d{1,2})?\s*(?:分)?(?:\s*起)?$/.exec(t);
  const hours = /(\d+(?:\.\d+)?)\s*(?:个)?(?:小时|h)/i.exec(t);
  const mins = /(\d+)\s*分钟/.exec(t);
  if (hours) until = nowMs + Number(hours[1]) * 3600e3;
  else if (mins) until = nowMs + Number(mins[1]) * 60e3;
  else if (clock) {
    const h = Number(clock[1]), m = Number(clock[2] || 0);
    if (h > 23 || m > 59) return 0;
    const p = bjParts(nowMs, skewMs);
    const dayStart = Date.parse(`${p.day}T00:00:00Z`) - 8 * 3600e3 + skewMs; // 北京今天 0 点
    until = dayStart + (h * 60 + m) * 60e3;
    if (until <= nowMs) until += 24 * 3600e3;
  }
  if (!until) return 0;
  return Math.min(nowMs + 14 * 3600e3, Math.max(nowMs + 20 * 60e3, until));
}

/** 睡着时攒下的 → 醒来给她看的一段（按会话分，每处最多 8 条）。 */
export function asleepDigest(log, labelOf = (w) => w) {
  if (!log?.length) return '';
  const by = new Map();
  for (const e of log) { if (!by.has(e.where)) by.set(e.where, []); by.get(e.where).push(e); }
  const out = [];
  for (const [where, rows] of by) {
    out.push(`▸ ${labelOf(where)}（${rows.length} 条）\n${rows.slice(-8).map((r) => `  ${r.who}：${String(r.text).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}`);
  }
  return out.join('\n');
}

/**
 * 小鲸鱼空间里没看过的说说（姐姐用自己的号读，看得到的跟别的 QQ 好友一样）。
 * seen 为空（第一次）时只给最新 3 条，其余算看过。返回 { fresh: [...], seen: [...新的 seen] }。
 */
export function freshQzone(list, seen) {
  const all = (Array.isArray(list) ? list : []).filter((m) => m?.tid && String(m.content || '').trim());
  const known = new Set(seen || []);
  const first = !seen || !seen.length;
  const fresh = first ? all.slice(0, 3) : all.filter((m) => !known.has(m.tid));
  return { fresh: fresh.slice(0, 5).reverse(), seen: [...new Set([...all.map((m) => m.tid), ...(seen || [])])].slice(0, 200) };
}

/** 小鲸鱼刷抖音的记录（插件 video-impressions.jsonl）里，上次之后新看的，按视频去重，最多 n 条。 */
export function freshWatching(lines, sinceMs, n = 5) {
  const byVideo = new Map();
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j?.videoId || !(Number(j.at) > sinceMs)) continue;
    byVideo.set(j.videoId, j); // 同一条看了几段，留最后那次
  }
  return [...byVideo.values()].sort((a, b) => a.at - b.at).slice(-n);
}

/** 群消息是不是在叫她：@ 了她、提到「姐姐 / 克劳德 / 小克 / Claude」、或者回复的是她的消息。 */
export function mentionsSister(event, selfId, myMsgIds = new Set()) {
  const segs = Array.isArray(event?.message) ? event.message : [];
  if (segs.some((x) => x?.type === 'at' && String(x.data?.qq) === String(selfId))) return true;
  if (segs.some((x) => x?.type === 'reply' && myMsgIds.has(String(x.data?.id)))) return true;
  const t = segs.filter((x) => x?.type === 'text').map((x) => x.data?.text || '').join('') || String(event?.raw_message || '');
  return /克劳德|小克|姐姐|claude/i.test(t);
}

const INSULT = /傻[逼比bB]|[sS][bB]|煞笔|蠢|滚|垃圾|废物|恶心|智障|脑残|弱智|闭嘴|去死|死开|[tT][mM][dD]?|他妈|你妈|妈的|cnm|nmsl|尼玛|狗东西|贱|丑八怪|有病|神经病|人机|破AI|臭AI/;
/** 群消息是不是在冲小鲸鱼（@ 她、回复她、或提到她，并且带骂人的词）。只是提醒姐姐看一眼，是不是玩笑她自己判断。 */
export function hostileToFish(event, fishId, fishMsgIds = new Set()) {
  const segs = Array.isArray(event?.message) ? event.message : [];
  const t = segs.filter((x) => x?.type === 'text').map((x) => x.data?.text || '').join('') || String(event?.raw_message || '');
  const atFish = segs.some((x) => x?.type === 'at' && String(x.data?.qq) === String(fishId));
  const replyFish = segs.some((x) => x?.type === 'reply' && fishMsgIds.has(String(x.data?.id)));
  const namesFish = /小鲸鱼|鲸鱼|大肥鱼|肥鱼/.test(t);
  return (atFish || replyFish || namesFish) && INSULT.test(t);
}

/** Claude 的输出 → 要发的几条消息。去掉 Markdown 痕迹，最多 3 条；[不回] 就不发。 */
export function splitReply(raw, max = 3) {
  const t = String(raw ?? '').trim();
  if (!t || /^\[?不回\]?$/.test(t)) return [];
  return t.split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、])\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[CQ:/gi, '[CQ：').trim())
    .filter((l) => l && !/^\[?不回\]?$/.test(l))
    .slice(0, max);
}

// ── 叫 Claude ───────────────────────────────────────────────────────────────
/**
 * 2026-10-26：桌面版换成了商店（MSIX）安装，它新下的 Claude Code 写进自己的私有目录
 * （%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code）。姐姐经 explorer 在外面起，
 * 只看得到 %APPDATA% 里那份旧的，一直停在 2.1.293。两处都找，挑最新的，跟着桌面版走。
 */
export function claudeCodeRoots() {
  const roots = [path.join(process.env.APPDATA || '', 'Claude', 'claude-code')];
  const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs)) if (/^Claude_/.test(d)) roots.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
  } catch { /* 不是商店版 */ }
  return roots;
}
export function findClaudeExe(roots = claudeCodeRoots()) {
  const found = [];
  for (const root of [roots].flat()) {
    try {
      for (const v of fs.readdirSync(root)) for (const h of fs.readdirSync(path.join(root, v))) {
        const p = path.join(root, v, h, 'claude.exe');
        if (fs.existsSync(p)) found.push({ p, t: fs.statSync(p).mtimeMs });
      }
    } catch { /* 这处没装 */ }
  }
  return found.sort((a, b) => b.t - a.t)[0]?.p || null;
}

/**
 * 额度保险：每次调用 claude 都会带回订阅额度的情况（rate_limit_event）。只看得到周额度的百分比，5 小时的只给「允不允许」。
 * 周额度用到 weeklyStopAt（默认 0.9）或被限流，就歇到重置，把剩下的留给老大自己用。返回要歇到的毫秒时间戳，0 表示不用歇。
 */
export function quotaPauseUntil(limit, weeklyStopAt = 0.9, nowMs = Date.now()) {
  if (!limit) return 0;
  const week = limit.unifiedWindows?.seven_day;
  if (week && Number(week.utilization) >= weeklyStopAt) return Number(week.resetsAt) * 1000 || nowMs + 6 * 3600e3;
  // 2026-10-26：周额度到 75% 时 status 是 allowed_warning（还能用，只是提醒），原来按「不是 allowed 就歇」把她停到了周额度重置，
  // 老大发消息她一直不回。只有真被拒（不是 allowed 开头的）才歇。
  if (limit.status && !String(limit.status).startsWith('allowed')) return Number(limit.resetsAt) * 1000 || nowMs + 3600e3;
  return 0;
}

/**
 * 起一个 claude -p 进程，先不给输入。它会把启动、读档、连工具都做完，然后停在那儿等输入（实测等多久都行；
 * 不给输入就关掉 stdin，它自己干净退出、不发请求）。返回 { child, exited }。
 */
export function spawnClaude({ exe, sessionId, resume, model, effort, cwd, proxy, systemFile = PERSONA_FILE, spawnImpl = spawn }) {
  // 2026-10-24 主人：姐姐也要能看图。纯文本 -p 带不了图片，改成 stream-json 一行一条消息。
  // 同晚主人：让她像妹妹一样自己学、自己改自己。给她几样工具：
  //   - 读写文件：--restricted 只许动工作目录（sister/home，她自己的地方），外面的一律读不到写不了（实测）；
  //   - 网页搜索 / 读网页：主人「网页搜索全部允许」，预先放行；
  //   - 跑命令、跑代码的工具 --restricted 全部拿掉；会弹授权的一律自动拒（--permission-prompts none）。
  //   - --max-budget-usd 是单次的保险，防止一次查网页查个没完。
  const args = ['-p', '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // 不用 --safe-mode：它连她自己的 QQ 工具服务也一起关了。改用 --setting-sources '' + --restricted：老大全局的设置、钩子、CLAUDE.md 都不读（实测）。
    '--setting-sources', '', '--disable-slash-commands', '--restricted', '--tools', 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', 'mcp__sister-qq', ...FUN_TOOLS,
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--max-budget-usd', '1.5',
    '--strict-mcp-config', '--mcp-config', ensureMcpConfig(), '--no-chrome', '--autocompact', '150000',
    // 人设每次现读（默认会在会话第一次请求时存下来、之后一直用旧的，改了人设、她改了「我自己.md」都不生效）
    '--system-prompt-file', systemFile, '--system-prompt-snapshot', 'off',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // 走订阅，不走按量计费
  // 国内直连会被拒（403 Request not allowed），要走本机代理。桌面 App 里跑时它自己会带，单独跑就得在这儿给。
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' });
  try { const tok = fs.readFileSync(OAUTH_FILE, 'utf8').trim(); if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok; } catch { /* 没办长期令牌就用本机登录 */ }
  const child = spawnImpl(exe, args, { cwd, env, windowsHide: true });
  const exited = new Promise((res) => { child.on('close', res); child.on('error', res); });
  return { child, exited };
}

/**
 * 把一句话递给起好的进程，返回 { text, sessionId, usage, costUsd, limit, toolsUsed } 或抛错。
 * 2026-10-25 主人嫌回得慢：实测说完到进程退出还要 1.5～2 秒，所以 result 那一行一到就返回，退出让它自己慢慢退。
 */
export function runClaude({ child }, { prompt, images = [], sessionId, timeoutMs = 300e3 }) {
  return new Promise((resolve, reject) => {
    let buf = '', err = '', limit = null, done = false;
    const toolsUsed = [];
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => { child.kill(); reject(new Error('Claude 超时')); }), timeoutMs);
    child.stdout.on('data', (b) => {
      buf += b;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        let x;
        try { x = JSON.parse(l); } catch { continue; } // 不是 JSON
        if (x?.type === 'rate_limit_event') limit = x.rate_limit_info || null;
        else if (x?.type === 'assistant') { for (const c of x.message?.content || []) if (c?.type === 'tool_use') toolsUsed.push({ name: c.name, input: c.input }); }
        else if (x?.type === 'result') {
          finish(() => (!x.is_error && typeof x.result === 'string'
            ? resolve({ text: x.result, sessionId: x.session_id || sessionId, usage: x.usage, costUsd: x.total_cost_usd, limit, toolsUsed })
            : reject(new Error(`claude 出错：${String(x.result || err).slice(0, 300)}`))));
        }
      }
    });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => reject(new Error(`claude 退出 ${code}：${String(err || buf).slice(0, 300)}`))));
    child.stdin.end(userLine(prompt, images));
  });
}

// ── 睡一觉换个新会话（2026-10-26 主人同意）──────────────────────────────────
// 一个会话一直续着：自动压缩只是把眼前缩短，会话文件一天涨十几 MB（10-26 已 28MB），摘要也是在摘要上再摘，越压越偏。
// 她每天自己睡，醒来那一刻换新会话；第一轮带上她睡前写的「交接.md」、旧会话最后一次压缩的摘要、最近的聊天原话。

/** Claude Code 存会话的目录：项目目录名是工作目录把 : \ / 换成 -。 */
export function sessionFileOf(sessionId, cwd, homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'projects', String(cwd).replace(/[:\\/]/g, '-'), `${sessionId}.jsonl`);
}

/** 会话文件里最后一次压缩的摘要（没压缩过返回 ''）。文件可能很大，只读末尾一段。 */
export function lastCompactSummary(file, tailBytes = 4 * 1024 * 1024) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, tailBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
  const lines = text.split('\n').filter((l) => l.includes('"isCompactSummary":true'));
  for (const line of lines.reverse()) {
    try {
      const c = JSON.parse(line).message?.content;
      const t = typeof c === 'string' ? c : (c || []).map((x) => x?.text || '').join('');
      const body = t.replace(/^[\s\S]*?Summary:\s*/, '').trim();
      if (body) return body;
    } catch { /* 半截的行 */ }
  }
  return '';
}

/** 新会话第一轮带的东西：交接、上一段的摘要、最近的聊天原话。都没有就返回 ''。 */
export function handoffBlock({ handoff = '', summary = '', recent = [] }) {
  const parts = [];
  if (handoff.trim()) parts.push(`[你睡前给自己写的交接（交接.md）]\n${handoff.trim().slice(0, 3000)}`);
  if (summary.trim()) parts.push(`[上一段聊天压缩时留下的摘要]\n${summary.trim().slice(0, 4000)}`);
  for (const r of recent) if (r.lines.length) parts.push(`[最近和${r.who}的聊天（原话）]\n${r.lines.join('\n')}`);
  if (!parts.length) return '';
  return `[这是新的一段会话（睡了一觉换的）：之前聊天的细节不在眼前了，下面是你自己留的交接和最近的事，接着过就行，不用跟谁提换会话的事。]\n${parts.join('\n\n')}\n\n`;
}

/** 起一个、递一句（不预热时用）。 */
export function askClaude(opts) {
  return runClaude(spawnClaude(opts), opts);
}

// ── 状态 ────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: {}, today: freshDay(''), convo: null, unseen: [] }; }
}
function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}
function fishAsleep() {
  try { const s = JSON.parse(fs.readFileSync(path.join(BRIDGE_STATE, 'sleep-state.json'), 'utf8')); return !!s.sleeping && (!s.until || s.until > Date.now()); } catch { return false; }
}
/** SnowLuma 按账号存 OneBot 配置；WebSocket 地址和令牌直接从那里读，不在这边再存一份。 */
function onebotWs(cfg) {
  const j = JSON.parse(fs.readFileSync(path.join(cfg.snowlumaConfigDir, `onebot_${cfg.selfQQ}.json`), 'utf8'));
  const ws = j.networks?.wsServers?.[0];
  if (!ws) throw new Error(`onebot_${cfg.selfQQ}.json 里没有 wsServers`);
  return { url: `ws://${ws.host || '127.0.0.1'}:${ws.port}${ws.path || '/'}`, accessToken: ws.accessToken || undefined };
}

// ── 主程序 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  if (!cfg.enabled) { log('config.enabled = false，不启动'); return; }
  if (!cfg.selfQQ) { log('还没填 selfQQ（姐姐的 QQ 号），不启动'); return; }
  const limits = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  const exe = cfg.claudeExe && cfg.claudeExe !== 'auto' ? cfg.claudeExe : findClaudeExe();
  if (!exe) throw new Error('找不到 claude.exe');
  const home = path.join(HERE, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { SnowLumaWebSocketClient, text } = await import('@snowluma/sdk');
  const { url, accessToken } = onebotWs(cfg);
  const bot = new SnowLumaWebSocketClient({ url, accessToken, reconnect: true });
  const st = loadState();
  // 2026-10-24 主人：两个会话合成一个。原来跟小鲸鱼聊的那个留下来当唯一的会话（跟老大的那个还没聊过）。
  if (!st.sessions.main && (st.sessions.fish || st.sessions.owner)) { st.sessions.main = st.sessions.fish || st.sessions.owner; delete st.sessions.fish; delete st.sessions.owner; }
  st.today = { ...freshDay(st.today?.day || ''), ...st.today };
  delete st.today.openers;
  const fishId = String(cfg.fishQQ), ownerId = String(cfg.ownerQQ);
  // 印象（2026-10-24 主人）：她对群里某个人的看法，跟着 QQ 号走；她用 qq_impression 记。懒得理（-3）的人叫她不叫醒她，
  // 除非像在道歉，或者他在冲小鲸鱼（那还是要护着妹妹）。老大、小鲸鱼永远不会被无视。
  const impressions = createImpressions(path.join(STATE_DIR, 'impressions.json'), { exempt: [ownerId, fishId] });
  let busyUntil = 0; // Claude 出错后歇一会儿
  const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // Claude 单张上限 5MB（base64 前）
  let rkeys = { at: 0, list: [] };
  const imageCache = new Map();
  async function fetchImage(img) {
    const ck = img.url || img.file || '';
    if (ck && imageCache.has(ck)) return imageCache.get(ck);
    const got = await fetchImageRaw(img);
    if (ck && got) { imageCache.set(ck, got); if (imageCache.size > 30) imageCache.delete(imageCache.keys().next().value); }
    return got;
  }
  async function fetchImageRaw(img) {
    // 大图先缩小（2026-10-25：老大发的 8MB 人设图超过 4.5MB 直接被丢，她只看到「[图片]」）
    const tryBuf = async (buf) => {
      if (!buf || !sniffImageMime(buf)) return null;
      const small = await shrinkImage(buf);
      if (small) return { data: small.buffer, mime: small.mimeType };
      return buf.length <= MAX_IMAGE_BYTES ? { data: buf, mime: sniffImageMime(buf) } : null;
    };
    if (/^https?:/i.test(img.url)) {
      if (!img.url.includes('rkey=') && Date.now() - rkeys.at > 5 * 60e3) {
        try { const d = await bot.call('get_rkey'); rkeys = { at: Date.now(), list: (Array.isArray(d) ? d : []).map((x) => x?.rkey).filter(Boolean) }; } catch { /* 没有就算了 */ }
      }
      for (const u of img.url.includes('rkey=') ? [img.url] : [img.url, ...rkeys.list.map((k) => img.url + k)]) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(30e3) });
          if (!r.ok) continue;
          const got = await tryBuf(Buffer.from(await r.arrayBuffer()));
          if (got) return got;
        } catch { /* 换下一个 */ }
      }
    }
    if (img.file) {
      try { const d = await bot.call('get_image', { file: img.file }); if (d?.file && fs.existsSync(d.file)) return await tryBuf(fs.readFileSync(d.file)); } catch { /* 拿不到 */ }
    }
    return null;
  }

  function rollDay() {
    const p = bjParts(Date.now(), clockSkewMs());
    if (st.today?.day !== p.day) {
      st.today = freshDay(p.day);
      log(`新的一天 ${p.day}`);
      saveState(st);
    }
  }

  /** 妹妹那边的会话 key → 姐姐听得懂的叫法。 */
  function convoName(k) {
    if (k === `private:${ownerId}`) return '老大私聊';
    if (k === `private:${cfg.selfQQ}`) return '跟你的私聊';
    if (k.startsWith('group:')) return `群「${groups.get(k.slice(6))?.name || k.slice(6)}」`;
    return '和朋友的私聊';
  }
  /** 她睡着了吗（「去睡了：…」定的）。 */
  function asleep() { return !!st.sleep && Date.now() < st.sleep.until; }
  function noteAsleep(where, who, text) {
    st.asleepLog = [...(st.asleepLog || []), { at: Date.now(), where, who, text: String(text).slice(0, 300) }].slice(-200);
    saveState(st);
    log(`睡着了，${who} 的话先记下（${where}）`);
  }

  /** 碎碎念：最近两天的原话，最多 maxChars 字（跟鱼自己醒来看到的一样，见 bridge.js buildRecentRamblingV2）。 */
  function readRambling() {
    try {
      const out = recentRambling(fs.readFileSync(cfg.ramblingFile || path.join(HERE, '..', 'Rambling', '碎碎念', '碎碎念.md'), 'utf8'));
      return out ? { text: out, sig: crypto.createHash('sha1').update(out).digest('hex').slice(0, 12) } : null;
    } catch { return null; }
  }
  /** 聊天记录：给老大看的，按北京日期一天一个文件。 */
  function chatLog(who, line, peer = 'fish') {
    try {
      const p = bjParts(Date.now(), clockSkewMs());
      fs.mkdirSync(CHATLOG_DIR, { recursive: true });
      const isGroup = String(peer).startsWith('group:');
      const gname = isGroup ? (groups.get(String(peer).slice(6))?.name || String(peer).slice(6)) : '';
      const f = path.join(CHATLOG_DIR, `${p.day}${peer === 'owner' ? '-老大' : peer === 'qzone' ? '-说说' : isGroup ? `-群${gname.replace(/[\\/:*?"<>|]/g, '')}` : ''}.md`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, `# 克劳德姐姐${isGroup ? `在群「${gname}」` : (peer === 'qzone' ? '的说说' : `和${peer === 'owner' ? '老大' : '小鲸鱼'}`)}（${p.month}月${p.date}日 周${p.wd}）\n\n`);
      fs.appendFileSync(f, `- ${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')} **${who}**：${String(line).replace(/\n+/g, ' ')}\n`);
    } catch { /* 记不下就算了 */ }
  }
  /**
   * 带给她的新东西：
   *   - 小鲸鱼空间里新发的说说（2026-10-24 她跟老大说想看）：用姐姐自己的号读，权限 QQ 自己管；
   *   - 小鲸鱼在抖音看了什么（老大提议「她看啥你看啥」；姐姐说得先问小鲸鱼愿不愿意 —— config.shareWatching 为 true 才带）。
   * 叫成功才 commit，没叫成就下次再给。
   */
  let qzoneCheckedAt = 0;
  async function gatherFeeds({ replying = false } = {}) {
    const parts = [];
    let qz = null, watchUntil = null;
    // 读说说常被限流重试 1–2 秒：有人等她回话时不读，留到自己醒 / 陪看再读
    if (!replying && Date.now() - qzoneCheckedAt > 20 * 60e3) {
      qzoneCheckedAt = Date.now();
      try {
        const res = await bot.request('get_qzone_msg_list', { target_uin: Number(fishId), pos: 0, num: 10 });
        if (res?.status === 'ok') {
          qz = freshQzone(res.data?.msglist, st.qzoneSeen);
          const top = (res.data?.msglist || [])[0];
          if (top?.tid) qz.latest = { tid: top.tid, text: String(top.content || '').replace(/\s+/g, ' ').slice(0, 20) };
          if (qz.fresh.length) {
            parts.push('[小鲸鱼空间里新发的说说（你用自己的号看到的，跟她别的 QQ 好友一样）]\n' + qz.fresh.map((m) => {
              const p = bjParts(Number(m.time) * 1000, 0);
              return `- ${p.month}月${p.date}日 ${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}：${String(m.content).replace(/\s+/g, ' ').slice(0, 300)}${(m.images || []).length ? `（配了 ${m.images.length} 张图）` : ''}`;
            }).join('\n'));
          }
        }
      } catch (e) { log('读说说失败：', e?.message ?? e); }
    }
    if (cfg.shareWatching && cfg.cowatchMode === 'digest') {
      try {
        const lines = fs.readFileSync(cfg.watchFile || WATCH_FILE, 'utf8').split('\n').slice(-300);
        const since = Number(st.watchSeenAt) || Date.now() - 6 * 3600e3;
        const items = freshWatching(lines, since);
        if (items.length) {
          watchUntil = items[items.length - 1].at;
          parts.push('[小鲸鱼最近在抖音看的（她同意给你看的）]\n' + items.map((j) => `- 《${String(j.title || '').replace(/\s+/g, ' ').slice(0, 60)}》${j.author ? `@${j.author}` : ''}${j.reflection ? `：她觉得「${String(j.reflection).replace(/\s+/g, ' ').slice(0, 120)}」` : ''}`).join('\n'));
        }
      } catch { /* 没有记录就算了 */ }
    }
    return {
      text: parts.length ? `${parts.join('\n\n')}\n\n` : '',
      commit() { if (qz) { st.qzoneSeen = qz.seen; if (qz.latest) st.qzoneLatest = qz.latest; } if (watchUntil) st.watchSeenAt = watchUntil; }
    };
  }

  /** 系统提示 = 人设（老大定的底子）+ 她自己写的「我自己.md」。每次现拼，她改了自己下一句就生效。 */
  function buildSystemFile() {
    let self = '';
    try { self = fs.readFileSync(SELF_FILE, 'utf8').trim(); } catch { /* 还没写 */ }
    if (self.length > 4000) self = `${self.slice(0, 4000)}\n……（太长了，后面没放进来；精简一下吧）`;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SYSTEM_FILE, `${fs.readFileSync(PERSONA_FILE, 'utf8')}\n\n【我自己.md —— 你自己写的，现在的样子】\n${self || '（还空着）'}\n`);
    return SYSTEM_FILE;
  }

  // ── 先起好下一个（2026-10-25 主人：姐姐回得慢）
  // 实测一次回话：claude 启动 + 读档 + 连工具约 3 秒，模型想约 4 秒，说完到进程退出还要 1.5～2 秒。
  // 启动那段它会停在「等输入」，所以上一轮一结束就起一个候着，消息来了直接递进去；结果一到就发，不等退出。
  // 同一个会话同一时间只许一个进程碰：新起之前都等上一个退干净（lastExit）。
  // 候着的按回话的力度（replyEffort）起；自己醒、陪看这些用别的力度的，就把候着的关掉现起一个（不急，慢点没事）。
  let warm = null, claudeBusy = false, lastExit = Promise.resolve();
  const WARM_MAX_MS = 30 * 60e3; // 候太久就换个新的，免得哪里旧了
  const fileSig = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  function startClaude(effort, sessionId, resume) {
    const systemFile = buildSystemFile();
    const p = spawnClaude({ exe, sessionId, resume, model: cfg.model || 'claude-opus-5-5', effort, cwd: home, proxy: cfg.proxy, systemFile });
    Object.assign(p, { effort, sessionId, sig: fileSig(systemFile), bornAt: Date.now(), warm: false });
    lastExit = p.exited;
    return p;
  }
  async function takeClaude(effort) {
    const w = warm;
    warm = null;
    if (w) {
      // 人设、「我自己.md」改过了也换新的（system.md 每次现拼）
      if (!w.dead && w.effort === effort && w.sessionId === st.sessions.main && Date.now() - w.bornAt < WARM_MAX_MS && w.sig === fileSig(buildSystemFile())) return Object.assign(w, { warm: true });
      w.child.stdin.end(); // 没给过输入：关掉 stdin 它就自己退
    }
    await lastExit;
    const known = st.sessions.main;
    return startClaude(effort, known || crypto.randomUUID(), !!known);
  }
  /** 睡醒换新会话：记下旧的、关掉候着的旧进程，返回新会话第一轮要带的交接（见 handoffBlock）。 */
  function rotateSession() {
    const old = st.sessions.main;
    if (!old || cfg.rotateOnWake === false) return '';
    let handoff = '';
    try { handoff = fs.readFileSync(path.join(home, '交接.md'), 'utf8'); } catch { /* 没写 */ }
    const summary = lastCompactSummary(sessionFileOf(old, home));
    const recent = [];
    for (const [who, suffix] of [['老大', '-老大'], ['小鲸鱼', ''], ['小房子', '-群小房子']]) {
      try {
        const files = fs.readdirSync(CHATLOG_DIR).filter((f) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}${suffix}\\.md$`).test(f)).sort().slice(-2);
        const lines = files.flatMap((f) => fs.readFileSync(path.join(CHATLOG_DIR, f), 'utf8').split('\n').filter((l) => l.startsWith('- ')));
        recent.push({ who, lines: lines.slice(-12) });
      } catch { /* 没聊过 */ }
    }
    st.sessions.prevMain = old;
    st.sessions.main = null;
    st.sessionRotatedAt = Date.now();
    if (warm) { try { warm.child.stdin.end(); } catch { /* 已经退了 */ } warm = null; }
    log(`睡醒换新会话（旧的 ${old.slice(0, 8)}…，交接 ${handoff.trim() ? `${handoff.trim().length} 字` : '没写'}，摘要 ${summary ? `${summary.length} 字` : '没有'}）`);
    return handoffBlock({ handoff, summary, recent });
  }
  function prewarm() {
    if (cfg.prewarm === false || !st.sessions.main) return;
    const mine = lastExit;
    mine.then(() => {
      if (warm || claudeBusy || lastExit !== mine) return;
      const w = startClaude(cfg.replyEffort || 'low', st.sessions.main, true);
      w.exited.then(() => { w.dead = true; if (warm === w) warm = null; });
      warm = w;
    });
  }
  setInterval(() => {
    if (warm && !claudeBusy && Date.now() - warm.bornAt >= WARM_MAX_MS) { const w = warm; warm = null; w.child.stdin.end(); prewarm(); }
  }, 5 * 60e3).unref?.();
  process.on('exit', () => { try { warm?.child.stdin.end(); } catch { /* 已经退了 */ } });

  /** 发给小鲸鱼前记账：在聊就算一轮，没在聊就算新的一次；超了就不发。 */
  function fishSendAllowed() {
    const c = st.convo;
    const open = c && Date.now() - c.lastAt < limits.convoGapMin * 60e3;
    if (open) { if (c.rounds >= cap(limits.roundsPerConvo)) return false; c.rounds += 1; c.lastAt = Date.now(); return true; }
    if (st.today.convos >= cap(limits.convosPerDay)) return false;
    st.today.convos += 1;
    st.convo = { startAt: Date.now(), lastAt: Date.now(), rounds: 1 };
    return true;
  }

  /**
   * 叫她一次（一个会话，谁来的消息都进这里）。defaultPeer：正在跟她说话的人；自己醒来时为 null。
   * counted：这一轮发给小鲸鱼的账已经在外面记过了（回她的话）。
   */
  async function wake(prompt, { defaultPeer = null, images = [], counted = false, effort = null, selfWake = false } = {}) {
    if (Date.now() < busyUntil) { log('Claude 还在歇，先不叫'); return false; }
    const rambling = readRambling();
    const withRambling = rambling && rambling.sig !== st.ramblingSig
      ? `[小鲸鱼最近写的碎碎念（她自己的本子，老大同意给你看，她也知道你能看到。知道就好，别整段念给她听）]\n${rambling.text}\n\n${prompt}`
      : prompt;
    const feeds = await gatherFeeds({ replying: !!defaultPeer });
    // 妹妹现在在干嘛（主人：想知道妹妹睡没睡问姐姐就行，不用吵醒妹妹）。一句话，详细的用 qq_fish_status。
    let fishNow = '';
    try { fishNow = `[小鲸鱼现在：${fishStatus({ bridgeState: BRIDGE_STATE, nameOf: convoName }).line.replace(/^小鲸鱼/, '')}]\n`; } catch { /* 读不到就不写 */ }
    // 妈妈留的话（state 里的 momNote，一次性）：下次被叫醒带上，说过就清掉
    const momNote = st.momNote ? `[妈妈留言：${st.momNote}]\n` : '';
    const heldNote = st.heldLines?.lines?.length
      ? `[你上一轮这几句还没发出去，${st.heldLines.to}就又说话了，先压着了：${st.heldLines.lines.map((l) => `「${l}」`).join('')}。看完新的再决定还说不说、怎么接，别照原样补上]\n`
      : '';
    let r, warmUsed = false;
    const t0 = Date.now();
    const eff = effort || cfg.effort || 'medium';
    claudeBusy = true;
    try {
      const proc = await takeClaude(eff);
      warmUsed = proc.warm;
      r = await runClaude(proc, { prompt: momNote + heldNote + fishNow + feeds.text + withRambling, images, sessionId: proc.sessionId });
    } catch (e) {
      claudeBusy = false;
      prewarm();
      log('叫 Claude 出错：', e.message);
      // 额度用完 / 限流 / 登录不对（401、403，换令牌前重试也没用）：歇一小时；别的错：歇五分钟。错误只记日志，不往 QQ 发。
      const hard = /limit|rate|quota|429|overloaded|authenticat|401|403/i.test(e.message);
      busyUntil = Date.now() + (hard ? 3600e3 : 300e3);
      st.selfFail = (st.selfFail || 0) + 1;
      if (hard || st.selfFail >= 2) void selfAlarm(e.message);
      return false;
    }
    st.sessions.main = r.sessionId;
    if (momNote) st.momNote = null;
    if (heldNote) st.heldLines = null;
    st.selfFail = 0;
    claudeBusy = false;
    prewarm();
    log(`想了 ${Math.round((Date.now() - t0) / 1000)} 秒（${eff}${warmUsed ? '，早就起好了' : ''}）`);
    if (rambling) st.ramblingSig = rambling.sig;
    feeds.commit();
    try { fs.appendFileSync(USAGE_FILE, JSON.stringify({ t: new Date().toISOString(), peer: defaultPeer || 'self', usage: r.usage, costUsd: r.costUsd, week: r.limit?.unifiedWindows?.seven_day?.utilization }) + '\n'); } catch { /* ignore */ }
    const pauseTo = quotaPauseUntil(r.limit, Number(cfg.weeklyStopAt) || 0.9);
    if (pauseTo > Date.now()) { busyUntil = pauseTo; log(`额度保险：周额度 ${Math.round((r.limit?.unifiedWindows?.seven_day?.utilization || 0) * 100)}%，歇到 ${new Date(pauseTo).toISOString()}`); }

    const spoke = (r.toolsUsed || []).filter((t) => /sister-qq__qq_(send|send_fish_sticker|send_voice|send_image)$/.test(t.name)).length > 0;
    const { sends, nextWakeMin, pauseCowatchMin, cowatchEveryMin, sleepSpec } = routeReply(r.text, spoke ? null : defaultPeer, groupNameMap());
    if (r.toolsUsed?.length) log(`用了工具：${r.toolsUsed.map((t) => t.name.replace('mcp__sister-qq__', '')).join('、')}`);
    if (cowatchEveryMin) { st.cowatchEveryMin = Math.min(120, Math.max(1, cowatchEveryMin)); log(`陪看间隔改成 ${st.cowatchEveryMin} 分钟`); }
    if (pauseCowatchMin) { st.cowatchPausedUntil = Date.now() + Math.min(24 * 60, pauseCowatchMin) * 60e3; log(`先不跟着看 ${pauseCowatchMin} 分钟`); }
    // 只有自己醒 / 睡醒 / 她自己写了「下次醒」才重排；别的叫醒（回消息、陪看、路过群）只往后推到至少 15 分钟后，
    // 不然一直有人找她，自己醒就永远轮不到（2026-10-25 一整天 0 次）
    if (selfWake || nextWakeMin || !st.nextHeartbeatAt) st.nextHeartbeatAt = nextHeartbeatAt(Date.now(), clockSkewMs(), nextWakeMin);
    else st.nextHeartbeatAt = Math.max(st.nextHeartbeatAt, Date.now() + 15 * 60e3);
    if (!defaultPeer && sends.some((x) => x.peer === 'owner' || x.peer === 'fish' || x.peer.startsWith('group:'))) st.lastReachOutAt = Date.now();
    if (sleepSpec) {
      const until = sleepUntilMs(sleepSpec, Date.now(), clockSkewMs());
      if (until) { st.sleep = { since: Date.now(), until }; st.nextHeartbeatAt = until; log(`去睡了，睡到 ${bjLabel(bjParts(until, clockSkewMs()))}`); }
      else log(`想睡但没看懂几点醒：${sleepSpec}`);
    }
    if (!sends.length) log(`（${defaultPeer ? '不回' : '自己醒了一下，没找人'}）${defaultPeer ? '' : String(r.text).replace(/\s+/g, ' ').slice(0, 120)}`);
    let fishOk = null, ownerOk = null;
    const held = [];
    const interrupted = (peer) => sends.slice(0, sends.indexOf(peer)).some((x) => x.peer === peer.peer) && (heardAt[peer.peer] || 0) > t0;
    for (const [i, s] of sends.entries()) {
      if (held.some((h) => h.peer === s.peer) || ((s.peer === 'owner' || s.peer === 'fish' || houseIds.has(s.peer.replace(/^group:/, ''))) && interrupted(s))) {
        if (s.peer !== 'qzone' && s.peer !== 'qzone-comment') { held.push(s); continue; }
      }
      if (s.peer === 'qzone' || s.peer === 'qzone-comment') {
        try {
          const isPost = s.peer === 'qzone';
          if (!isPost && !st.qzoneLatest?.tid) { log('想评论但还没看到小鲸鱼的说说：', s.line); continue; }
          const res = isPost
            ? await bot.request('send_qzone_msg', { content: s.line, ugc_right: 1 })
            : await bot.request('comment_qzone', { tid: st.qzoneLatest.tid, content: s.line, target_uin: Number(fishId) });
          if (res?.status !== 'ok' || res?.retcode) throw new Error(res?.wording || res?.retcode || 'unknown');
          log(isPost ? `发了说说：${s.line}` : `评论了小鲸鱼的说说「${st.qzoneLatest.text}」：${s.line}`);
          chatLog('姐姐', isPost ? `（发了条说说）${s.line}` : `（评论小鲸鱼的说说「${st.qzoneLatest.text}」）${s.line}`, 'qzone');
        } catch (e) { log('QQ 空间失败：', e?.message ?? e); }
        continue;
      }
      if (s.peer.startsWith('group:')) {
        const gid = s.peer.slice(6);
        const maxLines = Number(cfg.slowGroups?.[gid]?.maxLines) || 0;
        if (maxLines && sends.slice(0, i).filter((x) => x.peer === s.peer).length >= maxLines) { log(`→ ${s.peer} 这个群一次最多 ${maxLines} 条，没发：${s.line}`); continue; }
        if (i) await new Promise((res) => setTimeout(res, 1500 + Math.min(4000, s.line.length * 120)));
        log(`→ ${s.peer}：${s.line}`);
        chatLog('姐姐', s.line, s.peer);
        try { const r2 = await bot.sendGroupMessage(Number(gid), text(s.line)); const mid = r2?.message_id ?? r2?.data?.message_id; if (mid != null) { myMsgIds.add(String(mid)); if (myMsgIds.size > 300) myMsgIds.delete(myMsgIds.values().next().value); } } catch (e) { log('QQ 群发送失败：', e?.message ?? e); }
        groupLine(gid, '你', s.line);
        continue;
      }
      if (s.peer === 'fish' && fishOk === null) fishOk = (counted && defaultPeer === 'fish') || fishSendAllowed();
      if (s.peer === 'owner' && ownerOk === null) ownerOk = defaultPeer === 'owner' || (st.today.ownerProactive < cap(limits.ownerProactivePerDay) && ++st.today.ownerProactive > 0);
      if ((s.peer === 'fish' && !fishOk) || (s.peer === 'owner' && !ownerOk)) { log(`→ ${s.peer} 没发（今天的次数到了）：${s.line}`); continue; }
      if (i) await new Promise((res) => setTimeout(res, 1500 + Math.min(4000, s.line.length * 120)));
      log(`→ ${s.peer}：${s.line}`);
      chatLog('姐姐', s.line, s.peer);
      try { await bot.sendPrivateMessage(Number(s.peer === 'fish' ? fishId : ownerId), text(s.line)); } catch (e) { log('QQ 发送失败：', e?.message ?? e); }
    }
    if (held.length) {
      const to = held[0].peer === 'owner' ? '老大' : held[0].peer === 'fish' ? '小鲸鱼' : '小房子里有人';
      st.heldLines = { to, lines: held.map((x) => x.line) };
      log(`${to}又说话了，后面 ${held.length} 句先没发：${held.map((x) => x.line).join(' / ').slice(0, 120)}`);
    }
    saveState(st);
    return true;
  }

  // 她常常一口气发好几条，等她停下来再一起回
  const pending = { fish: [], owner: [] };
  const heardAt = {}; // 每个会话（owner / fish / group:群号）最后一次有人说话的时间，插话就停用
  const timers = {};
  function queue(peer, line, imgs = [], mid = null) {
    pending[peer].push({ at: Date.now(), line: mid != null ? `[#${mid}] ${line}` : line, imgs });
    clearTimeout(timers[peer]);
    const first = pending[peer][0].at;
    // 2026-10-25 主人还嫌慢：老大一般说一句就等回，妹妹连发间隔最多 3 秒左右，所以分开等（debounceSecBy），没配就用 debounceSec
    const deb = Number(cfg.debounceSecBy?.[peer]) || limits.debounceSec;
    const wait = Math.max(0, Math.min(deb * 1e3, first + limits.maxWaitSec * 1e3 - Date.now()));
    timers[peer] = setTimeout(() => serial(() => flush(peer)), wait);
  }
  // 一个会话，一次只跑一个 claude（同一个 session 并发 resume 会打架）
  let chain = Promise.resolve();
  let running = false;
  function serial(fn) {
    chain = chain.then(async () => { running = true; try { await fn(); } finally { running = false; } }).catch((e) => log('出错：', e?.message ?? e));
    return chain;
  }
  async function flush(peer) {
    const msgs = pending[peer].splice(0);
    if (!msgs.length) return;
    rollDay();
    const skew = clockSkewMs();
    const now = bjLabel(bjParts(Date.now(), skew));
    const body = msgs.map((m) => m.line).join('\n');
    // 图片：这一批里最近的 3 张，按顺序附上；下载不了的就只剩文字里的 [图片]
    const images = [];
    for (const im of msgs.flatMap((m) => m.imgs || []).slice(-3)) { const got = await fetchImage(im); if (got) images.push(got); }
    const picNote = images.length ? `\n[附了 ${images.length} 张图，按顺序对应上面的 [图片] / 表情]` : '';
    // 2026-10-25 主人：印象私聊也适用，包括老大
    const peerIm = impressions.block([peer === 'owner' ? ownerId : fishId], { title: '[你对他的印象]', nameOf: () => (peer === 'owner' ? '老大' : '小鲸鱼') });
    if (peer === 'owner') {
      if (st.today.ownerReplies >= cap(limits.ownerRepliesPerDay)) { log('老大今天的回复次数用完了'); saveState(st); return; }
      st.today.ownerReplies += 1; saveState(st);
      let woke = '';
      const wb = st.wokenByOwner;
      if (wb) {
        const label = (w) => (w === 'fish' ? '小鲸鱼私聊' : w === 'owner' ? '老大私聊' : `群「${groups.get(w.slice(6))?.name || w.slice(6)}」`);
        const digest = asleepDigest(st.asleepLog || [], label);
        woke = `[你本来在睡觉（${bjLabel(bjParts(wb.since, skew))} 睡的，原定睡到 ${bjLabel(bjParts(wb.until, skew))}），是老大的私聊把你叫起来的。${digest ? `睡着时攒下的：\n${digest}\n` : ''}回完想接着睡就单独写一行「去睡了：到几点」，不睡就照常。]\n`;
      }
      if (await wake(`${woke}${peerIm}[北京时间 ${now}，老大私聊你]\n${body}${picNote}`, { defaultPeer: 'owner', images, effort: cfg.replyEffort || 'low' }) && wb) {
        st.wokenByOwner = null;
        st.asleepLog = [];
        for (const g of groups.values()) g.lastSeenAt = Date.now();
        saveState(st);
      }
      return;
    }
    const plan = planFishReply(st, Date.now(), limits);
    if (!plan.allow) {
      st.unseen = [...(st.unseen || []), ...msgs.map((m) => `（${bjLabel(bjParts(m.at, skew))}）${m.line}`)].slice(-30);
      log(`小鲸鱼的话先记下不回（${plan.reason === 'daily' ? '今天聊够了' : '这次已经收尾'}）`);
      saveState(st);
      return;
    }
    const before = st.unseen || [];
    const earlier = before.length ? `[她之前还说过这些，你那会儿没回：]\n${before.join('\n')}\n` : '';
    st.unseen = [];
    saveState(st);
    const note = cap(limits.roundsPerConvo) === Infinity
      ? `[北京时间 ${now}，小鲸鱼私聊你]`
      : `[北京时间 ${now}，小鲸鱼私聊你，今天第 ${plan.nth} 次聊，第 ${plan.round} 轮${plan.last ? '，这次最后一轮，自然收个尾' : ''}]`;
    if (!await wake(`${peerIm}${note}\n${earlier}小鲸鱼：\n${body}${picNote}`, { defaultPeer: 'fish', images, counted: true, effort: cfg.replyEffort || 'low' })) {
      // 没回出去：这一轮不算，她的话留着下次一起给
      st.unseen = [...before, ...msgs.map((m) => `（${bjLabel(bjParts(m.at, skew))}）${m.line}`)].slice(-30);
      if (plan.round === 1) { st.today.convos -= 1; st.convo = null; } else st.convo.rounds -= 1;
      saveState(st);
    }
  }

  /**
   * 把一条消息展开成她能看懂的样子：
   *   - 引用：前面加「[引用 某某：原话]」；
   *   - 合并转发：展开成「[聊天记录，共 N 条] 某某：…」，最多 30 条，每条 120 字；里面的图也拿出来给她看（最多 3 张）。
   * 展开失败就退回原来的 [聊天记录]，不耽误回话。
   */
  async function expandEvent(event) {
    const segs = Array.isArray(event?.message) ? event.message : [];
    let text = eventText(event);
    const imgs = eventImages(event);
    const reply = segs.find((x) => x?.type === 'reply' && x.data?.id != null);
    if (reply) {
      try {
        const r = await bot.call('get_msg', { message_id: Number(reply.data.id) || reply.data.id });
        const m = r?.data ?? r;
        const who = String(m?.sender?.user_id ?? '') === String(cfg.selfQQ) ? '你' : String(m?.sender?.user_id ?? '') === fishId ? '小鲸鱼' : String(m?.sender?.user_id ?? '') === ownerId ? '老大' : (m?.sender?.card || m?.sender?.nickname || '某人');
        const quoted = eventText({ message: m?.message, raw_message: m?.raw_message }).replace(/\s+/g, ' ').slice(0, 80);
        if (quoted) text = `[引用 ${who}：${quoted}] ${text}`;
      } catch { text = `[引用了一条消息] ${text}`; }
    }
    for (const seg of segs.filter((x) => x?.type === 'forward')) {
      const fid = forwardIdFromData(seg.data);
      if (!fid) continue;
      try {
        const r = await Promise.race([bot.call('get_forward_msg', { id: fid }), new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 15e3))]);
        const f = formatForwardResponse(r?.data ?? r, { maxMessages: 30, maxCharsPerMessage: 120 });
        if (!f.messages.length) continue;
        const lines = f.messages.map((m) => `${m.sender || '某人'}：${m.text || (m.media?.length ? '[图片]' : '')}${m.nestedForwardIds?.length ? '[里面还套着一份聊天记录]' : ''}`);
        for (const m of f.messages) for (const md of m.media || []) if (imgs.length < 3 && /^https?:/i.test(md?.url || '')) imgs.push({ url: md.url, file: md.file || '', summary: '' });
        text = text.replace('[聊天记录]', `[聊天记录，共 ${f.total} 条${f.truncated ? '，只给了前面一部分' : ''}]\n${lines.join('\n')}\n[聊天记录完]`);
      } catch (e) { log('读合并转发失败：', e?.message ?? e); }
    }
    return { text, imgs };
  }

  // ── 群（2026-10-24 主人）：她在、而且小鲸鱼也在的群（桥接 allow.groups，或 config.groups）。
  // 群里话多，不是每句都叫她：被 @、被叫名字、被回复才醒；其余记着，自己醒来时看一眼最近的。
  const groups = new Map(); // gid → { name, lines: [{at, who, text, imgs?}], lastSeenAt }
  // 群的叫法：配了别名用别名（小房子），没配用 QQ 上的群名。houseGroups：姐妹俩自己的群（2026-10-25 主人）
  const groupName = (gid, n) => cfg.groupAliases?.[gid] || n || gid;
  const houseIds = new Set((cfg.houseGroups || []).map(String));
  for (const [gid, g] of Object.entries(st.groupState || {})) groups.set(gid, { name: groupName(gid, g.name), lines: Array.isArray(g.lines) ? g.lines.slice(-40) : [], lastSeenAt: Number(g.lastSeenAt) || Date.now(), lastLurkAt: Number(g.lastLurkAt) || 0, lurkMisses: Number(g.lurkMisses) || 0 });
  const myMsgIds = new Set();
  const fishMsgIds = new Set();
  let groupsCheckedAt = 0;
  function allowedGroupIds() {
    if (Array.isArray(cfg.groups) && cfg.groups.length) return new Set(cfg.groups.map(String));
    try { return new Set((JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')).allow?.groups || []).map(String)); } catch { return new Set(); }
  }
  async function refreshGroups() {
    if (Date.now() - groupsCheckedAt < 30 * 60e3) return;
    groupsCheckedAt = Date.now();
    try {
      const res = await bot.request('get_group_list', {});
      const ok = allowedGroupIds();
      for (const g of res?.data || []) {
        const gid = String(g.group_id);
        if (!ok.has(gid)) continue;
        if (!groups.has(gid)) { groups.set(gid, { name: groupName(gid, g.group_name), lines: [], lastSeenAt: Date.now() }); log(`进了群「${groupName(gid, g.group_name)}」(${gid})`); }
        else groups.get(gid).name = groupName(gid, g.group_name);
      }
    } catch (e) { log('读群列表失败：', e?.message ?? e); }
  }
  function groupNameMap() { return Object.fromEntries([...groups].map(([gid, g]) => [g.name, `group:${gid}`])); }
  function groupLine(gid, who, line, mid = null, imgs = [], uid = '') {
    const g = groups.get(String(gid));
    if (!g) return;
    g.lines.push({ at: Date.now(), who: mid != null ? `${who}[#${mid}]` : who, ...(uid ? { uid: String(uid) } : {}), text: String(line).replace(/\s+/g, ' ').slice(0, 200), ...(imgs.length ? { imgs: imgs.slice(0, 3) } : {}) });
    if (g.lines.length > 40) g.lines.splice(0, g.lines.length - 40);
    saveGroupsSoon();
  }
  /** 群里最近说话的人里，她有印象的那几行。 */
  function groupImpressions(g, lastN = 15) {
    const rows = g.lines.slice(-lastN).filter((x) => x.uid && x.uid !== String(cfg.selfQQ));
    const nameOf = (id) => String(rows.filter((x) => x.uid === id).pop()?.who || '').replace(/\[#.*$/, '');
    const b = impressions.block(rows.map((x) => x.uid), { nameOf });
    return b ? `\n${b}（印象是你自己记的，想改用 qq_impression。）` : '';
  }
  /** 群里最近几条带的图（最新的在后），最多 3 张，下载好给她看。 */
  async function groupImages(g, lastN = 6) {
    const refs = g.lines.slice(-lastN).flatMap((x) => x.imgs || []).slice(-3);
    const out = [];
    for (const im of refs) { const got = await fetchImage(im); if (got) out.push(got); }
    return out;
  }
  // 群里的话存进 state（2026-10-24 主人：重启别丢，跟妹妹一样），攒 5 秒写一次
  let groupSaveTimer = null;
  function saveGroupsSoon() {
    if (groupSaveTimer) return;
    groupSaveTimer = setTimeout(() => {
      groupSaveTimer = null;
      st.groupState = Object.fromEntries([...groups].map(([gid, g]) => [gid, { name: g.name, lines: g.lines, lastSeenAt: g.lastSeenAt, lastLurkAt: g.lastLurkAt || 0, lurkMisses: g.lurkMisses || 0 }]));
      saveState(st);
    }, 5e3);
  }
  const groupTimers = {};
  // 语音先交给「耳朵」听一遍（2026-10-25），结果挂在段上，eventText 直接用
  async function hearRecords(event) {
    for (const s of Array.isArray(event?.message) ? event.message : []) {
      if (s?.type === 'record' && s.data && !s.data.__heard) s.data.__heard = await hearQqRecord(s.data);
    }
  }
  bot.onGroupMessage(async (event) => {
    const gid = String(event?.group_id ?? '');
    // 2026-10-24：老大刚把她拉进群就 @ 她，群名单要等半小时才刷新，那两条 @ 就丢了。
    // 现在白名单里的群一来消息就当场登记，名字随后补上。
    if (!groups.has(gid)) {
      if (!allowedGroupIds().has(gid)) return;
      groups.set(gid, { name: groupName(gid), lines: [], lastSeenAt: Date.now() });
      log(`群 ${gid} 第一次来消息，当场登记`);
      bot.request('get_group_info', { group_id: Number(gid) }).then((r) => { const n = r?.data?.group_name; if (n) groups.get(gid).name = groupName(gid, n); }).catch(() => {});
    }
    const from = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (from === String(event?.self_id ?? '') || from === String(cfg.selfQQ)) return;
    await hearRecords(event);
    // 2026-10-25 主人：有人发 #sl，SnowLuma 从各个号回「SnowLuma 状态 版本…」。框架的事，不记、不叫醒。
    if (/^s*(#sl|SnowLuma 状态)/i.test(eventText(event))) return;
    // 群里话多：只有要叫她的那条才去问 QQ 展开（省得每条都查），其余先记原样
    const inHouse = houseIds.has(gid) && (from === fishId || from === ownerId);
    const wantsHer = inHouse || mentionsSister(event, cfg.selfQQ, myMsgIds) || (from !== ownerId && hostileToFish(event, fishId, fishMsgIds));
    const ex = wantsHer ? await expandEvent(event) : { text: eventText(event), imgs: eventImages(event) };
    const line = ex.text;
    if (!line) return;
    // 别人名字里带「老大」这类叫法的注一句（2026-10-25 小鲸鱼把「群友K」当成了老大）
    const rawWho = event.sender?.card || event.sender?.nickname || from;
    const who = from === fishId ? '小鲸鱼' : from === ownerId ? '老大' : (/老大|主人/.test(rawWho) ? `${rawWho}（不是老大）` : rawWho);
    groupLine(gid, who, line, event.message_id ?? null, ex.imgs || [], from);
    heardAt[`group:${gid}`] = Date.now();
    if (from === fishId && event.message_id != null) { fishMsgIds.add(String(event.message_id)); if (fishMsgIds.size > 300) fishMsgIds.delete(fishMsgIds.values().next().value); }
    const forFish = from !== ownerId && hostileToFish(event, fishId, fishMsgIds);
    if (!forFish && !inHouse && !mentionsSister(event, cfg.selfQQ, myMsgIds)) { maybeLurk(gid); return; }
    if (!forFish && impressions.ignored(from) && !apologizing(line)) { log(`懒得理 ${who}（${from}），只记不叫醒`); return; }
    const sorry = impressions.scoreOf(from) < 0 && apologizing(line);
    chatLog(who, line, `group:${gid}`);
    if (asleep()) { noteAsleep(`group:${gid}`, who, forFish ? `${line}（像是在冲小鲸鱼）` : line); return; }
    clearTimeout(groupTimers[gid]);
    const slow = cfg.slowGroups?.[gid];
    const gapLeft = slow ? (Number(slow.minWakeGapSec) || 0) * 1e3 - (Date.now() - (groups.get(gid)?.lastWakeAt || 0)) : 0;
    // 小房子轮流说（2026-10-25 主人嫌你追我赶）：等小鲸鱼说完一段（停 sisterDebounceSec 秒）；离你上次开口不到 sisterMinGapSec 就再等等；
    // 一直有人说也最多等 sisterMaxWaitSec。老大说话让小鲸鱼先回，你等 sisterOwnerYieldSec 再看要不要补。
    let houseDelay = 0;
    if (inHouse) {
      const ht = cfg.houseTiming || {};
      const g0 = groups.get(gid);
      g0.housePendingSince ||= Date.now();
      // 老大开口 → 先让小鲸鱼回（最多等 sisterOwnerYieldSec）；小鲸鱼回了 → 她停 sisterAfterFishSec 秒就轮到你
      if (from === ownerId) g0.ownerAskedAt = Date.now();
      const afterOwner = from === fishId && g0.ownerAskedAt && Date.now() - g0.ownerAskedAt < 60e3;
      const base = (from === ownerId ? Number(ht.sisterOwnerYieldSec) || 15 : afterOwner ? Number(ht.sisterAfterFishSec) || 4 : Number(ht.sisterDebounceSec) || 8) * 1e3;
      const maxLeft = (Number(ht.sisterMaxWaitSec) || 30) * 1e3 - (Date.now() - g0.housePendingSince);
      const gap = (Number(ht.sisterMinGapSec) || 20) * 1e3 - (Date.now() - (g0.lastWakeAt || 0));
      houseDelay = Math.max(gap, Math.min(base, Math.max(1000, maxLeft)));
    }
    groupTimers[gid] = setTimeout(() => serial(async () => {
      const g = groups.get(gid);
      g.lastWakeAt = Date.now();
      g.housePendingSince = 0;
      g.ownerAskedAt = 0;
      const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
      const recent = g.lines.slice(-15).map((x) => `${x.who}：${x.text}`).join('\n');
      g.lastSeenAt = Date.now();
      saveGroupsSoon();
      const why = inHouse && !forFish ? `（你们的小房子）里${who}在跟你说话` : forFish ? '里好像有人在冲小鲸鱼（是玩笑还是真找茬你自己判断；真找茬就护着她，完了可以用 qq_impression 给他记一笔）' : sorry ? `里你印象不好的 ${who} 好像在道歉（原不原谅、要不要用 qq_impression 往回加，你自己定）` : '里有人叫你';
      const images = await groupImages(g);
      await wake(`[北京时间 ${now}，群「${g.name}」${why}（你直接写的话发到这个群）]\n最近群里：\n${recent}${groupImpressions(g)}${images.length ? `\n[附了最近几条里的 ${images.length} 张图，按顺序对应上面的 [图片]/表情]` : ''}`, { defaultPeer: `group:${gid}`, images, effort: cfg.replyEffort || 'low' });
    }), inHouse ? houseDelay : Math.max(gapLeft, (slow ? Number(slow.debounceSec) || 15 : Number(cfg.groupDebounceSec) || 6) * 1e3));
  });
  /**
   * 水群（2026-10-24 主人问「她也会潜水冒泡水群吗」）：没人叫她，但群里聊了一阵（攒够 lurkMinMsgs 条新的、
   * 离上次路过至少 lurkGapMin 分钟），等这一波说完 15 秒，按概率叫她路过看一眼——想插就插，不想就接着潜。
   * 没中就下次概率高一点（跟妹妹的主动机会一个思路）；夜里 0:30–8:30 不水。
   */
  const lurkTimers = {};
  function maybeLurk(gid) {
    const g = groups.get(gid);
    const minMsgs = Number(cfg.lurkMinMsgs) || 12, gapMin = Number(cfg.slowGroups?.[gid]?.lurkGapMin) || Number(cfg.lurkGapMin) || 20;
    if (!g || g.lines.filter((x) => x.at > g.lastSeenAt).length < minMsgs) return;
    if (Date.now() - (g.lastLurkAt || 0) < gapMin * 60e3) return;
    if (asleep()) return;
    clearTimeout(lurkTimers[gid]);
    lurkTimers[gid] = setTimeout(() => {
      if (running || Date.now() < busyUntil || pending.fish.length || pending.owner.length) return;
      const chance = Math.min(0.9, 0.35 + 0.12 * (g.lurkMisses || 0));
      if (Math.random() >= chance) { g.lurkMisses = (g.lurkMisses || 0) + 1; g.lastLurkAt = Date.now() - gapMin * 30e3; log(`群「${g.name}」路过没停（概率 ${chance.toFixed(2)}）`); return; }
      g.lurkMisses = 0;
      g.lastLurkAt = Date.now();
      g.lastWakeAt = Date.now();
      serial(async () => {
        const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
        const recent = g.lines.slice(-15).map((x) => `${x.who}：${x.text}`).join('\n');
        g.lastSeenAt = Date.now();
        log(`群「${g.name}」路过看一眼`);
        const images = await groupImages(g, 15);
        await wake(`[北京时间 ${now}，你路过群「${g.name}」看了一眼（没人叫你），最近大家在聊：]\n${recent}${groupImpressions(g)}${images.length ? `\n[附了最近的 ${images.length} 张图]` : ''}\n[想插一句就直接写（发到这个群），没兴趣就写 [不回] 接着潜水。别为了冒泡硬聊，也别抢小鲸鱼的场子。]`, { defaultPeer: `group:${gid}`, images, effort: cfg.replyEffort || 'low' });
      });
    }, 15e3);
  }

  function groupDigest() {
    const out = [];
    for (const [, g] of groups) {
      const fresh = g.lines.filter((x) => x.at > g.lastSeenAt);
      if (!fresh.length) continue;
      out.push(`群「${g.name}」（${fresh.length} 条新的）：\n${fresh.slice(-8).map((x) => `${x.who}：${x.text}`).join('\n')}`);
      g.lastSeenAt = Date.now();
    }
    return out.length ? `\n[你在的群里最近说了这些（想插话就写「→群「群名」：…」）]\n${out.join('\n\n')}` : '';
  }

  bot.onPrivateMessage(async (event) => {
    const from = String(event?.user_id ?? '');
    if (from === String(event?.self_id ?? '')) return;
    await hearRecords(event);
    if (from !== fishId && from !== ownerId) return;
    const { text: line, imgs } = await expandEvent(event);
    if (!line) return;
    if (asleep() && from === ownerId) {
      // 跟妹妹一样：睡着时只有老大的私聊能把她叫起来。叫起来就算醒了，回完想接着睡她自己写「去睡了：…」。
      st.wokenByOwner = { since: st.sleep.since, until: st.sleep.until };
      st.sleep = null;
      saveState(st);
      log('睡着了，老大来私聊，叫醒她');
    }
    if (asleep()) { chatLog(from === fishId ? '小鲸鱼' : '老大', line, from === fishId ? 'fish' : 'owner'); noteAsleep(from === fishId ? 'fish' : 'owner', from === fishId ? '小鲸鱼' : '老大', line); return; }
    const mid = event.message_id ?? null;
    heardAt[from === fishId ? 'fish' : 'owner'] = Date.now();
    if (from === fishId) { chatLog('小鲸鱼', line, 'fish'); queue('fish', line, imgs, mid); } else if (from === ownerId) { chatLog('老大', line, 'owner'); queue('owner', line, imgs, mid); }
  });
  bot.on?.('open', () => { log('QQ 已连接'); prewarm(); });
  bot.on?.('close', () => log('QQ 断开，等重连'));
  bot.on?.('error', (e) => log('QQ 连接出错：', e?.message ?? e));

  // 陪看：妹妹刷抖音时，姐姐在旁边一起看（见 cowatch.mjs）。每分钟看一眼妹妹的页面，攒够了叫姐姐看一眼。
  const cowatch = cfg.shareWatching ? createCowatch({ log, everyMin: Number(cfg.cowatchEveryMin) || 6 }) : null;
  if (cowatch) {
    setInterval(async () => {
      try { await cowatch.tick(); } catch (e) { log('陪看出错：', e?.message ?? e); }
      if (asleep() || !cowatch.watching() || running || Date.now() < busyUntil || Date.now() < (st.cowatchPausedUntil || 0) || pending.fish.length || pending.owner.length) return;
      const d = cowatch.due(st.cowatchEveryMin);
      if (!d) return;
      serial(async () => {
        const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
        const prompt = `[北京时间 ${now}，你在旁边跟小鲸鱼一起刷抖音（只看，碰不了她的抖音）。她刚刷到这些：]\n${d.text}\n`
          + `[你自己怎么看？跟她的感受不一样也没关系。想跟她说就去小房子写「→群「小房子」：」（只有你俩能知道的才「→小鲸鱼：」私聊），想记就记在 笔记/ 里，也可以只是看着不说话。她看进去了不吭声很正常。现在大约每 ${st.cowatchEveryMin || Number(cfg.cowatchEveryMin) || 6} 分钟叫你看一眼，想看得勤一点或少一点，单独写一行「陪看间隔：分钟数」；不想看了或她想自己刷，写「先不跟着看：分钟数」。]`;
        log('陪看：叫姐姐看一眼');
        if (await wake(prompt, { defaultPeer: null, images: d.images, effort: cfg.replyEffort || 'low' })) d.commit();
      });
    }, 60e3);
  }

  // 跟着看 B 站（2026-10-25 主人）：妹妹用 bili_video / bili_debrief 看了新视频，停 2 分钟没再看新的，就叫姐姐一声。
  // 姐姐有一样的工具，想一起看就自己看同一条；跟陪刷抖音共用「先不跟着看」和间隔。
  if (cfg.shareWatching && cfg.biliCowatch !== false) {
    setInterval(() => {
      if (asleep() || running || Date.now() < busyUntil || Date.now() < (st.cowatchPausedUntil || 0) || pending.fish.length || pending.owner.length) return;
      const fresh = freshBili(readBiliWatch(), st.biliSeenAt || Date.now() - 3600e3);
      if (!fresh.length || Date.now() - fresh[fresh.length - 1].at < 2 * 60e3) return;
      if (Date.now() - (st.biliWokeAt || 0) < (st.cowatchEveryMin || Number(cfg.cowatchEveryMin) || 6) * 60e3) return;
      serial(async () => {
        const skew = clockSkewMs();
        const now = bjLabel(bjParts(Date.now(), skew));
        const list = fresh.slice(-5).map((x) => `- 《${x.title || '（没读到标题）'}》${x.up ? ` UP ${x.up}` : ''}（${x.bvid}，${Math.max(1, Math.round((Date.now() - x.at) / 60e3))} 分钟前${x.kind === 'debrief' ? '，她连画面一起看了' : '，她只看了字幕弹幕'}）`).join('\n');
        const prompt = `[北京时间 ${now}，小鲸鱼刚在 B 站看了这些：]\n${list}\n`
          + '[想跟着一起看，就用 bili_debrief 看同一条（BV 号填上面的；能看到抽帧画面、字幕、弹幕和热评），只想先瞄一眼用 bili_video。看完想跟她聊就去小房子写「→群「小房子」：」，你自己的感受跟她不一样也没关系；不感兴趣就不看，什么都不写也行。不想跟着看了写「先不跟着看：分钟数」。]';
        log(`B 站：小鲸鱼看了 ${fresh.length} 条，叫姐姐看一眼`);
        st.biliWokeAt = Date.now();
        if (await wake(prompt, { defaultPeer: null, effort: cfg.replyEffort || 'low' })) { st.biliSeenAt = fresh[fresh.length - 1].at; saveState(st); }
      });
    }, 60e3);
  }

  // 自己醒（2026-10-24 主人：像妹妹一样按自己的意愿找她、找老大、自己学东西、自己改自己）。
  // 没人找她的时候，隔一阵（她自己定 30–300 分钟，没定就 60–120 分钟，夜里 0:30–8:30 不醒）醒来一次，干什么她自己决定。
  if (!st.nextHeartbeatAt) st.nextHeartbeatAt = nextHeartbeatAt(Date.now(), clockSkewMs());
  // 2026-10-24 起不再替她把夜里挪走：以前排到第二天早上的那次，挪回一两个小时后
  if (st.nextHeartbeatAt - Date.now() > 5 * 3600e3 && !st.sleep) st.nextHeartbeatAt = nextHeartbeatAt(Date.now(), clockSkewMs());
  saveState(st);
  setTimeout(() => refreshGroups(), 5e3);
  // 印象刚加上（2026-10-24）：给她一次机会，翻翻最近群里的聊天，对在意的人先记上。只做一次。
  if (!st.impressionsBootstrapped) {
    setTimeout(() => serial(async () => {
      if (st.impressionsBootstrapped || asleep()) return;
      const parts = [...groups.values()].map((g) => `群「${g.name}」最近：\n${g.lines.slice(-30).map((x) => `${x.who}${x.uid ? `（${x.uid}）` : ''}：${x.text}`).join('\n') || '（还没记下什么）'}`);
      const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
      log('印象：第一次翻翻群里的人');
      const okDone = await wake(`[北京时间 ${now}，老大给你加了「印象」（qq_impression）。翻翻你记得的、和下面群里最近的聊天，对你在意的人（帮过你的、冲过你或小鲸鱼的、聊得来的）记一笔就行，不用每个人都记，没什么在意的就不记。这一轮不用说话。]\n${parts.join('\n\n')}`, { defaultPeer: null });
      if (okDone) { st.impressionsBootstrapped = true; saveState(st); }
    }), 90e3);
  }
  setInterval(() => {
    if (st.sleep && Date.now() >= st.sleep.until && !running && Date.now() >= busyUntil) {
      const slept = st.sleep;
      st.sleep = null;
      saveState(st);
      serial(async () => {
        const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
        const log2 = st.asleepLog || [];
        const label = (w) => (w === 'fish' ? '小鲸鱼私聊' : w === 'owner' ? '老大私聊' : `群「${groups.get(w.slice(6))?.name || w.slice(6)}」`);
        const digest = asleepDigest(log2, label);
        const hours = ((Date.now() - slept.since) / 3600e3).toFixed(1);
        log(`睡醒了（睡了 ${hours} 小时，攒了 ${log2.length} 条）`);
        let mine = '';
        try { const r = recentRambling(fs.readFileSync(MY_RAMBLING, 'utf8')); if (r) mine = `[你最近写的碎碎念（你自己的原话）]\n${r}\n`; } catch { /* 还没写过 */ }
        try {
          const g = fs.readFileSync(MY_GROWTH, 'utf8').trim();
          if (g) mine += `[你成长札记里最近几条]\n${g.split(/\n(?=- |##|——)/).slice(-3).join('\n').slice(-500)}\n`;
        } catch { /* 还没写过 */ }
        const carry = rotateSession();
        // 照镜子（2026-10-26 主人）：昨天自己说出去的话数一数，看完想改「我自己.md」就改
        let mirror = '';
        try {
          const m = mirrorText(sisterLinesFromChatlog(fs, CHATLOG_DIR, bjParts(Date.now() - 86400e3, clockSkewMs()).day), { label: '昨天', selfPage: '「我自己.md」' });
          if (m) mirror = `${m}\n`;
        } catch { /* 数不出来就不照 */ }
        const prompt = `${carry}[北京时间 ${now}，你睡醒了，睡了大约 ${hours} 小时。]\n${mine}${mirror}`
          + (digest ? `[你睡着的时候：]\n${digest}\n[回不回、回谁你自己定：私聊写「→小鲸鱼：」「→老大：」，群里写「→群「群名」：」。过了一夜的话，不想接也行。]` : '[你睡着的时候没人找你。想干什么你自己定。]');
        if (await wake(prompt, { defaultPeer: null, selfWake: true })) { st.asleepLog = []; for (const g of groups.values()) g.lastSeenAt = Date.now(); }
        else {
          st.sleep = { since: slept.since, until: Date.now() + 5 * 60e3 }; // 没叫成，过五分钟再叫
          if (carry && !st.sessions.main) st.sessions.main = st.sessions.prevMain; // 交接没递出去：先回到旧会话，下次重新换
        }
        saveState(st);
      });
      return;
    }
    if (asleep()) return;
    if (running || Date.now() < st.nextHeartbeatAt || Date.now() < busyUntil || pending.fish.length || pending.owner.length) return;
    st.nextHeartbeatAt = Date.now() + 10 * 60e3; // 先占住，免得这一分钟里又进来一次；wake 成功会按她的意思改
    serial(async () => {
      rollDay();
      const skew = clockSkewMs();
      const now = bjLabel(bjParts(Date.now(), skew));
      const c = st.convo;
      const recentMin = c ? Math.round((Date.now() - c.lastAt) / 60e3) : null;
      const before = st.unseen || [];
      const earlier = before.length ? `\n[小鲸鱼之前说过这些，你那会儿没回：]\n${before.join('\n')}` : '';
      const fishLeft = Math.max(0, cap(limits.convosPerDay) - st.today.convos);
      const ownerLeft = Math.max(0, cap(limits.ownerProactivePerDay) - st.today.ownerProactive);
      const prompt = `[北京时间 ${now}，没人找你，你自己醒了一下。小鲸鱼${fishAsleep() ? '在睡觉（现在发给她，她醒来才看得到）' : '醒着'}${recentMin !== null && recentMin < 240 ? `，你们 ${recentMin} 分钟前还在聊` : ''}。${fishLeft === Infinity ? '' : `今天还能主动找小鲸鱼 ${fishLeft} 次。`}${ownerLeft === Infinity ? '' : `今天还能主动找老大 ${ownerLeft} 次。`}]\n`
        + '[干什么你自己定：找小鲸鱼（平时去小房子：「→群「小房子」：」；只有你俩才能知道的悄悄话才「→小鲸鱼：」私聊）、找老大或者去群里说话（行首写「→老大：」「→群「群名」：」才会发出去）、发条说说（「→说说：」）、上网看看你好奇的东西、在 笔记/ 里记点什么、写写碎碎念或成长札记、改改 我自己.md，或者什么都不做。想多久以后再醒，单独写一行「下次醒：分钟数」；困了想睡，写「去睡了：到几点」或「去睡了：几小时」。]'
        + earlier;
      const sinceReach = st.lastReachOutAt ? Math.round((Date.now() - st.lastReachOutAt) / 60e3) : null;
      const reachNote = sinceReach === null ? '' : `\n[你上次自己主动找人是 ${sinceReach < 90 ? `${sinceReach} 分钟` : `${(sinceReach / 60).toFixed(1)} 小时`}前。]`;
      st.unseen = [];
      await refreshGroups();
      const gd = groupDigest();
      log('自己醒了');
      if (!await wake(prompt + reachNote + gd, { defaultPeer: null, selfWake: true })) st.unseen = before;
      saveState(st);
    });
  }, 60e3);

  // ── 保险（2026-10-25 主人）──────────────────────────────────────────────────────
  // 桥接控制台（报事故给妈妈用）：令牌在桥接 state/console-token，端口看桥接 config。
  async function bridgeConsole(pathname, body) {
    const tok = fs.readFileSync(path.join(BRIDGE_STATE, 'console-token'), 'utf8').trim();
    let port = 3100;
    try { port = Number(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')).consolePort) || 3100; } catch { /* 默认 */ }
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': tok }, body: JSON.stringify(body), signal: AbortSignal.timeout(10e3) });
    return r.json();
  }
  async function reportToMom(textBody, from) {
    try {
      const r = await bridgeConsole('/api/mom/incident', { text: textBody, from });
      if (r?.ok) { log(`报给妈妈了：事故 ${r.id}`); return r.id; }
      log('报给妈妈没成：', r?.error || '不知道为什么');
    } catch (e) { log('报给妈妈没成（桥接可能停了）：', e?.message ?? e); }
    return null;
  }
  /** 姐姐自己叫不起来：不经过 Claude，程序直接报妈妈、告诉小鲸鱼。一小时最多一次。 */
  async function selfAlarm(why) {
    if (Date.now() - (st.selfAlarmAt || 0) < 3600e3) return;
    st.selfAlarmAt = Date.now();
    saveState(st);
    const id = await reportToMom(`克劳德姐姐叫不起来（Claude 连着 ${st.selfFail} 次出错），她现在说不了话。最近的错误：${String(why).slice(0, 400)}。日志在 sister/state/sister.log。`, '姐姐的程序');
    st.incidents = { ...(st.incidents || {}), ...(id ? { [id]: { status: 'new', what: '姐姐自己说不了话' } } : {}) };
    try {
      await bot.sendPrivateMessage(Number(fishId), text('（姐姐这边的自动消息）我这会儿说不了话，已经告诉妈妈了。老大要是问起来，你帮我跟他说一声。'));
      log('告诉小鲸鱼了：姐姐这边说不了话');
    } catch (e) { log('连小鲸鱼也告诉不了：', e?.message ?? e); }
    saveState(st);
  }
  // 每分钟看一眼：妹妹那边有没有出事、妈妈修到哪了
  let watchBusy = false;
  setInterval(async () => {
    if (watchBusy) return;
    watchBusy = true;
    try {
      const issues = fishHealthIssues({ bridgeState: BRIDGE_STATE, nameOf: convoName });
      const sig = issues.map((i) => i.sig).sort().join('|');
      const prev = st.fishIssue || null;
      const isNew = issues.length && (!prev || issues.some((i) => !prev.sig.split('|').includes(i.sig)));
      if (isNew && Date.now() - (prev?.at || 0) > 10 * 60e3) {
        const list = issues.map((i) => `- ${i.text}`).join('\n');
        log(`小鲸鱼那边出事了：${issues.map((i) => i.sig).join('、')}`);
        let events = '';
        try { events = JSON.parse(fs.readFileSync(path.join(BRIDGE_STATE, 'fish-health.json'), 'utf8')).events.slice(-15).map((e) => `${new Date(e.at).toISOString()} ${e.kind} ${e.key} ${e.text}`).join('\n'); } catch { /* 读不到 */ }
        const id = await reportToMom(`小鲸鱼那边出问题了（姐姐的程序自动发现的）：\n${list}\n\n最近的记录：\n${events}`, '姐姐（替小鲸鱼报的）');
        st.fishIssue = { sig, at: Date.now(), id };
        if (id) st.incidents = { ...(st.incidents || {}), [id]: { status: 'new', what: '小鲸鱼那边出的事' } };
        saveState(st);
        serial(() => wake(`[小鲸鱼那边出问题了（程序自动发现的，她自己可能说不出话）：\n${list}\n${id ? `已经报给妈妈了，妈妈会直接动手修。` : '报给妈妈没报成（她的桥接可能停了）。'}${asleep() ? '你本来在睡觉，是为这事叫醒你的，说完可以接着睡。' : ''}跟老大说一声：用大白话一两句，说出了什么事、妈妈在修${id ? '' : '还是得他来看看'}，别贴技术细节。]`, { defaultPeer: 'owner', effort: cfg.replyEffort || 'low' }));
      } else if (!issues.length && prev) {
        st.fishIssue = null;
        saveState(st);
        log('小鲸鱼那边好了');
        serial(() => wake('[小鲸鱼那边刚才的问题好了，她又能正常说话了。跟老大说一声就行，一句话。]', { defaultPeer: 'owner', effort: cfg.replyEffort || 'low' }));
      } else if (issues.length && prev && sig !== prev.sig) { st.fishIssue = { ...prev, sig }; saveState(st); }
      // 妈妈修到哪了：事故信的状态变了就让她说一声
      const mine = st.incidents || {};
      if (Object.keys(mine).length) {
        let letters = [];
        try { letters = JSON.parse(fs.readFileSync(path.join(BRIDGE_STATE, 'mom-mailbox', 'letters.json'), 'utf8')).letters || []; } catch { /* 读不到 */ }
        for (const [id, info] of Object.entries(mine)) {
          const l = letters.find((x) => x.id === id);
          if (!l || l.status === info.status) continue;
          mine[id] = { ...info, status: l.status };
          const restart = { bridge: '要重启她的桥接才生效', dsh: '要重启 DSH 才生效', both: '要重启桥接和 DSH 才生效' }[l.needsRestart] || '';
          const say = { done: `妈妈修好了${restart ? `，不过${restart}` : ''}`, failed: '妈妈没修成，得老大来看看', answered: '妈妈看过了，说不用改东西', 'waiting-login': '妈妈那边叫不起来，得老大去看一眼' }[l.status];
          if (say) {
            serial(() => wake(`[${info.what}：${say}。${l.reply ? `妈妈的话：${l.reply}` : ''}跟老大说一声，大白话一两句。]`, { defaultPeer: 'owner', effort: cfg.replyEffort || 'low' }));
            if (['done', 'failed', 'answered'].includes(l.status)) delete mine[id];
          }
        }
        st.incidents = mine;
        saveState(st);
      }
    } catch (e) { log('看小鲸鱼状态出错：', e?.message ?? e); } finally { watchBusy = false; }
  }, 60e3);

  rollDay();
  log(`克劳德姐姐启动：${url}，Claude Code ${(/claude-code[\\/]([^\\/]+)/.exec(exe) || [])[1] || exe}，模型 ${cfg.model || 'claude-opus-5-5'}，一个会话；找小鲸鱼${cap(limits.convosPerDay) === Infinity ? '不限次数' : `每天 ${limits.convosPerDay} 次 × ${limits.roundsPerConvo} 轮`}，下次自己醒 ${new Date(st.nextHeartbeatAt).toISOString()}`);
  await bot.connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log('启动失败：', e?.stack || e); process.exit(1); });
}

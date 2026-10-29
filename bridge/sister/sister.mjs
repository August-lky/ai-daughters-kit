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
import { brainOf, NOVEL_ROOT as BOOKS_ROOT } from '../src/brains.js';
import { novelWakeLine } from '../src/novel-tools.js'; // 2026-10-29 第五批：唤醒里提一句最近在写的合写书
// 2026-10-29 大脑方案下半：心情（mood.js）、瞬间（episodes.js）、按话题想起 / 记错了 / 睡前整理建议（brain-client.js）都跟小鲸鱼共用同一套
import { createMoodStore, moodPushFile } from '../src/mood.js';
import { createEpisodeStore } from '../src/episodes.js';
import { brainDemote, brainRecall, brainTidy, correctionReminder, formatRecallBlock, isMemoryCorrection, recallQueryFromLines } from '../src/brain-client.js';
import { hearQqRecord } from '../src/ear.js';
// 2026-10-29 主人（大整理第二批）：看图跟小鲸鱼共用 image-view.js —— GIF 抽帧拼图、大图缩小、太大的说一声，不再无声丢掉
import { segImageRef, imageKey, createImageDownloader, fetchImageForView, DOWNLOAD_MAX_BYTES } from '../src/image-view.js';
import { safeFetchBuffer } from '../src/safe-fetch.js';
import { mirrorText, sisterLinesFromChatlog } from '../src/mirror.js';
// 2026-10-29 第五批：激素影子记录（只记录、不触发任何行为；跟小鲸鱼同一套事件口径，见 src/hormone-feed.js）
import { createHormoneFeed, createMoodPusher, incomingHormoneEvents, toolHormoneEvents, toolSendHormoneEvents, sentHormoneEvent, createNoveltyTracker, moodHormoneEvent, weatherHormoneEvents, loadSisterInterests, HORMONE_REFRESH } from '../src/hormone-feed.js';
import { createWeather } from '../src/weather.mjs';
// 2026-10-29 老大：「困」提前从影子里放出来（身体感受一句），睡觉可以选「睡到自然醒」（压力回落才醒）
import { sleepyFeel, naturalWakeDue } from '../src/hormones.js';
// 2026-10-29 老大：页面上看姐姐此刻在干什么。实时缓冲只在内存里（不落盘）、不采集她的思考内容；本地小服务只听 127.0.0.1（见 sister/live-server.mjs）
import { createLiveBuffer } from '../src/live-buffer.js';
import { createSisterLive, createSisterActions, buildNow, readAcceptedTokens, persistJsonConfig } from './live-server.mjs';

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
// 2026-10-29 大脑方案：她的脑子在工作目录里的 脑子/（身份/ 长期/ 人/ 瞬间/ 日子/ 最近/ 笔记/ 作品/），路径统一从 brains.js 取；
// 工作目录 sister/home 不变（--restricted 只让她读写这里，会话路径也由它推出来）。
const SISTER_BRAIN = brainOf('sister');
const SELF_FILE = SISTER_BRAIN.self;                 // 脑子/身份/我自己.md
const MY_RAMBLING = SISTER_BRAIN.rambling;           // 2026-10-24 主人：她也写碎碎念和成长札记，跟妹妹一样（现在在 脑子/日子/碎碎念/）
const MY_GROWTH = SISTER_BRAIN.growth;               // 脑子/日子/成长札记/我的成长.md
// 写给她看的相对路径（相对她的工作目录 home）
const relHome = (p) => path.relative(SISTER_BRAIN.home, p).split(path.sep).join('/');
// 2026-10-29 老大：.索引（检索服务维护）、笔记/工具集.md、笔记/我是怎么做出来的.md（同步脚本维护）不让她写，只读照旧。
// 办法：给 claude 加 --disallowedTools 的 Edit / Write 规则（只拦写，--restricted 的读取不受影响）；两个本子另外设了系统只读（scripts/sync-toolset.mjs 同步时会先解开再设上）。
const PROTECTED_RULES = protectedEditRules([`${relHome(SISTER_BRAIN.indexDir)}/**`, relHome(SISTER_BRAIN.toolset), relHome(path.join(SISTER_BRAIN.notes, '我是怎么做出来的.md'))]);
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

/**
 * 消息里的图片（普通图、表情包）：下载要用的 url / file / 备用地址 urls，和去重用的 key。
 * 2026-10-29：市场表情没有 url 也没有 file 时原来直接被滤掉；现在照小鲸鱼那边按 emoji_id 拼 CDN 地址（见 image-view.js segImageRef）。
 */
export function eventImages(event) {
  const segs = Array.isArray(event?.message) ? event.message : [];
  return segs.map((x) => segImageRef(x)).filter(Boolean);
}

/** 旧存档里的图（只有 url / file）补上 urls 和 key。 */
export function normImageRef(r) {
  if (!r) return null;
  if (Array.isArray(r.urls) && r.key !== undefined) return r;
  const urls = /^https?:\/\//i.test(String(r.url || '')) ? [String(r.url)] : [];
  return { ...r, urls, key: imageKey(r) };
}

/**
 * 这一轮要给她看的图（2026-10-29 主人，E1：同一张图附了 32 次，会话存档一天涨到 47.7MB）：
 * 按 key 去重；本会话看过的不再附（status=seen）；没看过的最多附 max 张，留最新的，更早的 status=skipped。
 * seen：{ key: 消息号 }。
 */
export function planImages(refs, seen = {}, max = 3) {
  const out = [];
  const keys = new Set();
  for (const raw of refs || []) {
    const ref = normImageRef(raw);
    if (!ref) continue;
    const key = ref.key || '';
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    out.push({ ref, key, status: key && Object.prototype.hasOwnProperty.call(seen || {}, key) ? 'seen' : 'want' });
  }
  const want = out.filter((x) => x.status === 'want');
  for (const x of want.slice(0, Math.max(0, want.length - max))) x.status = 'skipped';
  return out;
}

/**
 * 群唤醒一次最多附几张图（config.groupMaxImages，默认 1）。
 * 2026-10-29 主人（刷屏提速）：原来死写 3 张，刷屏时每次唤醒都带三张别人发的图，「想」的时间主要耗在看图上。
 */
export function groupMaxImagesOf(cfg) {
  const n = Number(cfg?.groupMaxImages);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** 这张图是不是动图 / 动画表情（mface、sub_type 1 的表情、gif）。 */
export function isAnimatedImageRef(r) {
  if (!r) return false;
  return !!r.sticker || /\.gif(\?|$)/i.test(String(r.file || '')) || /\.gif(\?|$)/i.test(String(r.url || ''));
}

/**
 * 群里最近几条的图，按「该留谁」排好顺序（planImages 留最后的 max 张，所以越想留的越靠后）：
 *   · 别人发的动画表情 / 动图直接不要（刷屏里最常见、也最费时间的就是这种）；
 *   · 别人发的普通图排前面；
 *   · 叫她的那条消息（line.calls）里的图排最后 —— 一次只附 1 张时，留的就是它。
 * lines：群里最近的行（{ imgs, calls }）。
 */
export function selectGroupImageRefs(lines, lastN = 6) {
  const others = [], calling = [];
  for (const x of (lines || []).slice(-lastN)) {
    for (const im of x?.imgs || []) {
      if (x.calls) calling.push(im);
      else if (!isAnimatedImageRef(im)) others.push(im);
    }
  }
  return [...others, ...calling];
}

/**
 * 群里叫她的消息的防抖：每来一条叫她的就重新等 debounceMs，但从第一条算起最多等 maxWaitMs，到点就发，不再无限顺延。
 * 2026-10-29 主人（刷屏提速）：有人连着 @ 她，每条都会把定时器重置，一直到对方停手才叫她；现在最长 8 秒（config.groupMaxWaitSec）。
 * gapLeftMs：慢群里离上次叫她还差多久（有就不早于这个时间）。maxWaitMs <= 0 / 非数 = 不设上限。
 * 防抖本身比最长等待还长的（慢群自己设了更长的防抖）就按防抖本身算，不会被最长等待截短。
 */
export function groupDebounceDelayMs({ now, pendingSince, debounceMs, maxWaitMs, gapLeftMs = 0 }) {
  const cap = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? Math.max(maxWaitMs, debounceMs) : Infinity;
  const left = cap - (now - (pendingSince ?? now));
  return Math.max(gapLeftMs, Math.min(debounceMs, Math.max(0, left)));
}

/** 群唤醒的最长等待（毫秒）：config.groupMaxWaitSec，没写默认 8 秒，写 0 = 不设上限。 */
export function groupMaxWaitMsOf(cfg) {
  const raw = cfg?.groupMaxWaitSec;
  if (raw === undefined || raw === null || raw === '') return 8e3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1e3 : 8e3;
}

/** 会话该换了（rotatePending）之后，要空闲多久才换（毫秒）：config.rotateIdleMin，没写默认 3 分钟。 */
export function rotateIdleMsOf(cfg) {
  const n = Number(cfg?.rotateIdleMin);
  return (Number.isFinite(n) && n > 0 ? n : 3) * 60e3;
}

/** 附图说明：第几张附图对应哪条消息的哪张图，看过的、没看清的、没附的都写一句（编号跟附图一一对应，不会错位）。 */
export function imagesNote(entries, max = 3) {
  if (!entries?.length) return '';
  const label = (r) => `${r.mid != null ? `#${r.mid} ` : ''}${r.from === 'quote' ? '被引用的那条里' : r.from === 'forward' ? '聊天记录里' : ''}的${r.sticker ? '表情' : '图'}`;
  const lines = entries.map((e) => {
    if (e.status === 'attached') return `- 第 ${e.n} 张附图 = ${label(e.ref)}${e.note || ''}`;
    if (e.status === 'seen') return `- ${label(e.ref)}：你看过了（想再看可以用 qq_message_images）`;
    if (e.status === 'pending') return `- ${label(e.ref)}：还在下载，等会儿可以用 qq_message_images 看`;
    if (e.status === 'skipped') return `- ${label(e.ref)}：这次没附（一次最多附 ${max} 张），想看可以用 qq_message_images`;
    return `- ${label(e.ref)}：没看清，${e.reason || '没取到'}`;
  });
  return `\n[这一轮的图：\n${lines.join('\n')}\n]`;
}

/**
 * 同一个群的唤醒只排一次（2026-10-29 主人，E1：小房子里妹妹每说一句就叫醒她，10-28 一天 258 次）。
 * request(key, job)：这个 key 已经在排队就不再排（新消息会在那一次跑的时候一起看到），返回 false；
 * 开始跑的时候就解除排队，跑的过程中来的新消息会再排一次（只一次）。
 */
export function createWakeMerger(serial) {
  const queued = new Set();
  return {
    request(key, job) {
      if (queued.has(key)) return false;
      queued.add(key);
      serial(async () => { queued.delete(key); await job(); });
      return true;
    },
    isQueued: (key) => queued.has(key),
    size: () => queued.size,
  };
}

/** 两条唤醒并成一次时，原因合起来：冲小鲸鱼 > 道歉 > 叫你 / 小房子 / 拍一拍；说话的人用最新的。 */
export function mergeWakeCtx(a, b) {
  if (!a) return { ...b, sorryWho: b.sorry ? b.who : undefined };
  return {
    ...a, ...b,
    forFish: !!(a.forFish || b.forFish),
    sorry: !!(a.sorry || b.sorry), sorryWho: b.sorry ? b.who : a.sorryWho,
    directed: !!(a.directed || b.directed),
    inHouse: !!(a.inHouse || b.inHouse),
    poke: !!b.poke, pokedMe: !!b.pokedMe // 拍一拍只看最新这条
  };
}

/**
 * 拍一拍（2026-10-29 主人：照小鲸鱼 M12 的新逻辑给姐姐也加上）。
 * 返回 { action, where, pokedMe, sender, target, wakeFromSleep? }：
 *   ignore —— 不是拍一拍 / 自己拍的 / 不认识的地方；
 *   wake   —— 拍她（按「被叫」处理）；或者别人互相拍、她开了 pokeOthers；
 *   note   —— 拍她但她睡着了（只有老大私聊拍才叫醒，跟「只有老大私聊能叫醒」一致），记下醒来告诉她；
 *   record —— 别人互相拍，默认只记一行不叫醒。
 */
export function pokeDecision(event, { selfId, fishId, ownerId, asleep = false, pokeOthers = false, allowGroup = () => true } = {}) {
  if (!event || event.sub_type !== 'poke' || (event.notice_type && event.notice_type !== 'notify')) return { action: 'ignore' };
  const sender = String(event.sender_id ?? event.user_id ?? '');
  const target = String(event.target_id ?? '');
  const self = String(selfId ?? '');
  if (!sender || sender === self) return { action: 'ignore' };
  const gid = event.group_id != null ? String(event.group_id) : '';
  if (gid ? !allowGroup(gid) : (sender !== String(fishId) && sender !== String(ownerId))) return { action: 'ignore' };
  // 私聊里事件不带被拍的人时，只可能是对方拍她
  const pokedMe = target === self || (!gid && !target);
  const where = gid ? `group:${gid}` : (sender === String(fishId) ? 'fish' : 'owner');
  const base = { where, pokedMe, sender, target };
  if (!pokedMe) return { ...base, action: !asleep && pokeOthers && gid ? 'wake' : 'record' };
  if (asleep) return !gid && sender === String(ownerId) ? { ...base, action: 'wake', wakeFromSleep: true } : { ...base, action: 'note' };
  return { ...base, action: 'wake' };
}

/** 发多行时两行之间等多久（2026-10-29 主人：原来 1.5 秒 + 每字 120 毫秒、最多 5.5 秒，偏长）。 */
export function lineGapMs(line, g = {}) {
  const base = Number.isFinite(Number(g?.baseMs)) ? Number(g.baseMs) : 800;
  const per = Number.isFinite(Number(g?.perCharMs)) ? Number(g.perCharMs) : 60;
  const max = Number.isFinite(Number(g?.maxMs)) ? Number(g.maxMs) : 3500;
  return Math.max(0, Math.min(max, base + String(line ?? '').length * per));
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
  let nextWakeMin = null, pauseCowatchMin = null, cowatchEveryMin = null, sleepSpec = null, moodSpec = null;
  for (const l of String(raw ?? '').split(/\n+/)) {
    const t = l.trim();
    if (!t) continue;
    // 2026-10-29 老大同意（施工单 C）：回话最后可以单独写一行「心情：……，因为……」——记成一次心情调整，这一行不发出去
    const md = /^心情\s*[:：]\s*(.+)$/.exec(t);
    if (md) { moodSpec = md[1].trim(); continue; }
    const w = /^下次醒\s*[:：]\s*(\d+)/.exec(t);
    if (w) { nextWakeMin = Number(w[1]); continue; }
    const pz = /^先不跟着看\s*[:：]\s*(\d+)/.exec(t);
    if (pz) { pauseCowatchMin = Number(pz[1]); continue; }
    const iv = /^陪看间隔\s*[:：]\s*(\d+)/.exec(t);
    if (iv) { cowatchEveryMin = Number(iv[1]); continue; }
    // 2026-10-29 老大：睡觉不定死——「去睡了：自然醒」或者单独一行「去睡了」就是睡到自然醒（激素的睡眠压力回落了才醒）；写了具体钟点 / 小时数的照旧按她的
    const sl = /^去睡了(?:\s*[:：]\s*(.*))?$/.exec(t);
    if (sl) { sleepSpec = String(sl[1] || '').trim() || '自然醒'; continue; }
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
  return { sends, nextWakeMin, pauseCowatchMin, cowatchEveryMin, sleepSpec, moodSpec };
}

/** 2026-10-29 施工单 C：唤醒提示里的一句许可（想写心情就写，不写也行）。一个会话给一次就够——她的会话是接着续的。 */
export const MOOD_LINE_HINT = '[想的话，回话最后可以单独写一行「心情：……，因为……」，会记进你的心情里，这一行不会发出去；不写也完全可以，qq_mood 照旧能用]\n';

/**
 * 2026-10-29 施工单 C：这一轮出错的工具记一笔（state/tool-errors.jsonl，一行一个 { at, name, why }），「看看我自己」(self_view) 读它。
 * 文件超过 maxBytes 就只留后半。写不下来无所谓。
 */
export function appendToolFails(file, fails, { now = Date.now(), maxBytes = 200 * 1024 } = {}) {
  const NL = String.fromCharCode(10);
  try {
    const rows = (Array.isArray(fails) ? fails : []).filter((f) => f && typeof f === 'object').slice(0, 20);
    if (!rows.length) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lineOf = (f) => JSON.stringify({ at: now, name: String(f.name || '').replace(/^mcp__.+?__/, ''), why: String(f.why || '').replace(/\s+/g, ' ').slice(0, 160) });
    fs.appendFileSync(file, rows.map(lineOf).join(NL) + NL);
    try {
      if (fs.statSync(file).size > maxBytes) {
        const lines = fs.readFileSync(file, 'utf8').split(NL).filter(Boolean);
        fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join(NL) + NL);
      }
    } catch { /* 瘦不下来下次再瘦 */ }
    return rows.length;
  } catch { return 0; }
}

/** 去掉回话里的心情行（日志、「没说出口的」不该把它当成她写了没发的话）。 */
export function stripMoodLines(raw) {
  return String(raw ?? '').split(/\n/).filter((l) => !/^\s*心情\s*[:：]/.test(l)).join('\n');
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

/** 下次自己醒：她定的（30–300 分钟）或随机 60–120 分钟。几点睡几点起她自己定（「去睡了：…」）；quietNight 默认关，只给测试用。 */
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

/** 「去睡了：7小时」「去睡了：90分钟」「去睡了：到 8:30」→ 醒来的本机毫秒。认不出来返回 0（「自然醒」另走 isNaturalSleep）。 */
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

/** 「去睡了：自然醒」「到你想醒的时候」这类（或者没写时间）= 睡到自然醒。 */
export function isNaturalSleep(spec) {
  const s = String(spec ?? '').trim();
  return !s || /^(?:睡到)?自然醒|^到(?:你|我|自己)想醒|^natural/i.test(s);
}

/**
 * 睡到自然醒要多久：最短 minH 小时之前不醒，最长 maxH 小时一定醒（防故障）；中间由激素的睡眠压力决定（见 hormones.js naturalWakeDue）。
 * 返回要存进 st.sleep 的东西。
 */
export function naturalSleepRecord(nowMs, nat = {}) {
  const minH = Number(nat.minH) > 0 ? Number(nat.minH) : 1;
  const maxH = Number(nat.maxH) > 0 ? Number(nat.maxH) : 14;
  return { since: nowMs, until: nowMs + maxH * 3600e3, minUntil: nowMs + minH * 3600e3, natural: true };
}

/** 睡着的这一觉到时间了吗？固定时间的看 until；自然醒的看激素（hormoneState 为空 = 激素没开，睡满 fallbackH 小时）。 */
export function sleepEndedNow(sleep, nowMs, hormoneState = null, hormoneCfg = undefined) {
  if (!sleep) return false;
  if (nowMs >= Number(sleep.until)) return true;
  if (!sleep.natural) return false;
  if (nowMs < Number(sleep.minUntil || 0)) return false;
  return naturalWakeDue(hormoneState, nowMs - Number(sleep.since || nowMs), hormoneCfg).wake;
}

/**
 * 各类唤醒的思考力度（2026-10-29 提速）：小房子 / 大群 / 路过 / 陪看这些轻的用 low（可用 houseEffort / groupEffort / lurkEffort 改），
 * 老大私聊和写书用 replyEffort（medium），自己醒用 effort（high）。
 */
export function effortFor(kind, cfg = {}) {
  const pick = (k, d) => String(cfg[k] || d);
  switch (kind) {
    case 'house': return pick('houseEffort', 'low');
    case 'group': return pick('groupEffort', 'low');
    case 'lurk': case 'cowatch': return pick('lurkEffort', 'low');
    case 'owner': case 'novel': return pick('replyEffort', 'medium');
    case 'self': return pick('effort', 'high');
    default: return pick('replyEffort', 'medium');
  }
}

/**
 * 被压住没发出去的话 → 下一轮带回给她（2026-10-29：原来的口气是「先压着了」，现在照老大的意思写成「你刚才还想说」，还发不发她定）。
 * held：{ to, lines, why? } 或这样的数组。没有就返回 ''。
 */
export function heldNoteText(held) {
  const list = (Array.isArray(held) ? held : [held]).filter((h) => h?.lines?.length);
  if (!list.length) return '';
  return list.map((h) => `[你刚才还想说：${h.lines.map((l) => `「${l}」`).join('')}（没发出去，${h.why || `${h.to}又说话了`}），还发不发你定]`).join('\n') + '\n';
}

/**
 * 换会话时带的旧摘要：压缩摘要是在旧规矩的底子上摘的，里面会有「扮演」「别编……」「必须……」这类旧口气，原样带进新会话等于把旧框框一起搬过来。
 * 这里按行滤掉带这些词的行；剩下太少（不到 80 字）就整段不要。
 */
export const OLD_RULE_WORDS = /扮演|演出|角色设定|人设|别编|不要编|不许编|不得|严禁|禁止|必须|务必|规则|规矩|限制|不能说|不要说/;
export function cleanCompactSummary(summary) {
  const kept = String(summary ?? '').split('\n').filter((l) => !OLD_RULE_WORDS.test(l));
  const out = kept.join('\n').trim();
  return [...out].length >= 80 ? out : '';
}

/** 会话里已经装了多少 token（来自最近一次请求的用量）超过线了吗。limit<=0 = 不按 token 换。 */
export function shouldRotateByTokens(ctxTokens, limit) {
  return Number(limit) > 0 && Number(ctxTokens) >= Number(limit);
}

/** 一次请求的用量 → 当前上下文装了多少 token（输入 + 缓存读 + 缓存写）。 */
export function ctxTokensOf(usage) {
  if (!usage) return 0;
  return (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
}

/** 用量 → 估算花费（美元，每百万 token 的价格可在 config.costGuard.prices 里改；只用来做单次兜底，不是账单）。 */
export const DEFAULT_PRICES = Object.freeze({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
export function estimateCostUsd(usage, prices = DEFAULT_PRICES) {
  if (!usage) return 0;
  const p = { ...DEFAULT_PRICES, ...prices };
  return ((Number(usage.input_tokens) || 0) * p.input + (Number(usage.output_tokens) || 0) * p.output
    + (Number(usage.cache_read_input_tokens) || 0) * p.cacheRead + (Number(usage.cache_creation_input_tokens) || 0) * p.cacheWrite) / 1e6;
}

/**
 * 每日说说时间点（2026-10-29 老大：她也应该可以主动写说说，跟妹妹一致）：到点、今天这个点还没提醒过、她今天还没发过说说、没睡着，就返回要提醒的时间点；否则 ''。
 * daily：{ enabled, times: [{hour, minute}], graceMin }（北京时间；过点超过 graceMin 分钟就不补了）。
 * st 里记 qzoneDailyDays: { s0: '2026-10-29' }、qzonePostedDay。
 */
export function qzoneDailyDue(st, nowMs, skewMs, daily = {}, { asleep = false } = {}) {
  if (!daily || daily.enabled === false || asleep) return '';
  const times = Array.isArray(daily.times) && daily.times.length ? daily.times : [{ hour: 21, minute: 50 }];
  const grace = Number(daily.graceMin) > 0 ? Number(daily.graceMin) : 150;
  const p = bjParts(nowMs, skewMs);
  if (st?.qzonePostedDay === p.day) return '';
  const nowMin = p.h * 60 + p.m;
  for (const [i, slot] of times.entries()) {
    const at = Math.min(23, Math.max(0, Number(slot?.hour ?? 21))) * 60 + Math.min(59, Math.max(0, Number(slot?.minute ?? 0)));
    const key = 's' + i;
    if (nowMin >= at && nowMin - at < grace && st?.qzoneDailyDays?.[key] !== p.day) return key;
  }
  return '';
}

/** 带到另一个地方说的事（qq-mcp 的 qq_go_to 写进 state/go-to-queue.json，姐姐的程序取走）。读不到就是空。 */
export function readGoToQueue(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter((x) => x && x.target && x.note) : []; } catch { return []; }
}

/** 不让她改的东西（程序自己维护的）：用 Claude Code 的权限规则只拦「写」，不拦「读」，--restricted 读取不受影响。路径相对她的工作目录。 */
export function protectedEditRules(rels = []) {
  const out = [];
  for (const r of rels) {
    const rel = String(r || '').split('\\').join('/').replace(/^\.?\//, '');
    if (!rel) continue;
    out.push('Edit(./' + rel + ')', 'Write(./' + rel + ')');
  }
  return out;
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
export function spawnClaude({ exe, sessionId, resume, model, effort, cwd, proxy, systemFile = PERSONA_FILE, deny = [], spawnImpl = spawn }) {
  // 2026-10-24 主人：姐姐也要能看图。纯文本 -p 带不了图片，改成 stream-json 一行一条消息。
  // 同晚主人：让她像妹妹一样自己学、自己改自己。给她几样工具：
  //   - 读写文件：--restricted 只许动工作目录（sister/home，她自己的地方），外面的一律读不到写不了（实测）；
  //   - 网页搜索 / 读网页：主人「网页搜索全部允许」，预先放行；
  //   - 跑命令、跑代码的工具 --restricted 全部拿掉；会弹授权的一律自动拒（--permission-prompts none）。
  //   - 2026-10-29：去掉了 --max-budget-usd。带着它，Claude Code 每一轮都往她的上下文里塞一句「USD budget: $0/$1.5」，她看得到预算。
  //     单次的保险改由程序自己兜（runClaude 按用量估算，超线就中止并记日志，她看不到）。
  //   - deny：程序自己维护的东西（.索引、工具集、《我是怎么做出来的》）只拦写、不拦读（--disallowedTools 的 Edit / Write 规则）。
  const args = ['-p', '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // 不用 --safe-mode：它连她自己的 QQ 工具服务也一起关了。改用 --setting-sources '' + --restricted：老大全局的设置、钩子、CLAUDE.md 都不读（实测）。
    '--setting-sources', '', '--disable-slash-commands', '--restricted', '--tools', 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', 'mcp__sister-qq', ...FUN_TOOLS,
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    ...(deny.length ? ['--disallowedTools', ...deny] : []),
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
 * 把一句话递给起好的进程，返回 { text, sessionId, usage, costUsd, limit, toolsUsed, toolErrors } 或抛错。
 * 2026-10-25 主人嫌回得慢：实测说完到进程退出还要 1.5～2 秒，所以 result 那一行一到就返回，退出让它自己慢慢退。
 */
export function runClaude({ child }, { prompt, images = [], sessionId, timeoutMs = 300e3, now = Date.now, onLine = null, costCapUsd = 0, prices = DEFAULT_PRICES }) {
  return new Promise((resolve, reject) => {
    let buf = '', err = '', limit = null, done = false;
    const toolsUsed = [];
    // 2026-10-29 单次兜底：按每次请求的用量估算这一轮花了多少，超线就中止（同一次请求在流里会出现好几次，按 message.id 去重）。她看不到
    const usageById = new Map();
    let ctxTokens = 0;
    const runningUsd = () => [...usageById.values()].reduce((s, u) => s + estimateCostUsd(u, prices), 0);
    let toolErrors = 0; // 2026-10-29 第五批：工具返回出错的次数（激素影子记录的 tool_fail）
    const toolFails = []; // 2026-10-29 施工单 C：出错的是哪个工具、说了什么（「看看我自己」里的「最近哪些工具出错」读它，见 recordToolFails）
    const nameById = new Map();
    // 2026-10-29 主人（E1）：记下 system/init 到第一个输出的耗时，以后好确认「读档」占了多久（会话存档大了这段会变长）
    const startAt = now();
    let initAt = 0, firstAt = 0;
    const timing = () => ({ startToInitMs: initAt ? initAt - startAt : null, initToFirstMs: initAt && firstAt ? firstAt - initAt : null });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => { child.kill(); reject(new Error('Claude 超时')); }), timeoutMs);
    child.stdout.on('data', (b) => {
      buf += b;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        let x;
        try { x = JSON.parse(l); } catch { continue; } // 不是 JSON
        if (onLine) { try { onLine(x); } catch { /* 实时区坏了不能拖累她说话 */ } } // 2026-10-29 老大：喂给实时区（里面只取她说的话、工具和成败，不看她的思考）
        if (x?.type === 'system' && x.subtype === 'init') { if (!initAt) initAt = now(); }
        else if (x?.type === 'rate_limit_event') limit = x.rate_limit_info || null;
        else if (x?.type === 'assistant') {
          if (!firstAt) firstAt = now();
          if (x.message?.usage) {
            usageById.set(x.message.id || ('n' + usageById.size), x.message.usage);
            ctxTokens = ctxTokensOf(x.message.usage) || ctxTokens;
            if (costCapUsd > 0 && runningUsd() > costCapUsd) { finish(() => { child.kill(); reject(new Error('COSTGUARD 这一轮用量超出保险线（约 ' + runningUsd().toFixed(2) + ' 美元，线 ' + costCapUsd + '），已中止')); }); return; }
          }
          for (const c of x.message?.content || []) if (c?.type === 'tool_use') { toolsUsed.push({ name: c.name, input: c.input }); if (c.id) nameById.set(c.id, c.name); }
        }
        else if (x?.type === 'user') { if (Array.isArray(x.message?.content)) for (const c of x.message.content) if (c?.type === 'tool_result' && c.is_error) { toolErrors += 1; toolFails.push({ name: nameById.get(c.tool_use_id) || '', why: (Array.isArray(c.content) ? c.content.map((q) => q?.text ?? '').join('') : String(c.content ?? '')).replace(/\s+/g, ' ').slice(0, 160) }); } }
        else if (x?.type === 'result') {
          if (!firstAt) firstAt = now();
          finish(() => (!x.is_error && typeof x.result === 'string'
            ? resolve({ text: x.result, sessionId: x.session_id || sessionId, usage: x.usage, costUsd: x.total_cost_usd, ctxTokens, limit, toolsUsed, toolErrors, toolFails, timing: timing() })
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
export function handoffBlock({ handoff = '', summary = '', recent = [], reason = 'wake', mood = '', moments = '' }) {
  const parts = [];
  // 2026-10-29 大脑方案下半（第 4 项）：开头先给「那会儿的心情和原因」和感受最强的几个瞬间，情绪才接得上
  if (String(mood).trim()) parts.push(`[那会儿的心情和原因]\n${String(mood).trim()}`);
  if (String(moments).trim()) parts.push(String(moments).trim());
  if (handoff.trim()) parts.push(`[你睡前给自己写的交接（${relHome(SISTER_BRAIN.handoff)}）]\n${handoff.trim().slice(0, 3000)}`);
  if (summary.trim()) parts.push(`[上一段聊天压缩时留下的摘要]\n${summary.trim().slice(0, 4000)}`);
  for (const r of recent) if (r.lines.length) parts.push(`[最近和${r.who}的聊天（原话）]\n${r.lines.join('\n')}`);
  if (!parts.length) return '';
  const why = reason === 'size' ? '上一段聊得太长了，换了一段新的' : '睡了一觉换的';
  return `[这是新的一段会话（${why}）：下面是你自己留下来的——${reason === 'size' ? '' : '心情、交接，还有'}最近的事，翻翻就能接上，不用跟谁提换会话的事。]\n${parts.join('\n\n')}\n\n`;
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
  const home = SISTER_BRAIN.home;
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
  const impressions = createImpressions(SISTER_BRAIN.impressions, { exempt: [ownerId, fishId] });
  // 心情和瞬间（2026-10-29 大脑方案下半）：跟小鲸鱼同一套格式；她用 qq_mood 调心情、qq_keep_moment 留瞬间（工具在 qq-mcp.mjs），这里读来给她看
  const mood = createMoodStore({ file: SISTER_BRAIN.mood, pushFile: moodPushFile(STATE_DIR, 'sister') });
  const episodes = createEpisodeStore({
    dir: SISTER_BRAIN.momentsDir,
    pressedFile: SISTER_BRAIN.pressed,
    skewMs: () => clockSkewMs(),
    ownerKey: `private:${ownerId}`,
    labelFor: (k) => (k === `private:${ownerId}` ? '老大私聊' : k === `private:${fishId}` ? '小鲸鱼私聊' : k.startsWith('group:') ? `群「${groups.get(k.slice(6))?.name || k.slice(6)}」` : k)
  });
  const heardLines = { owner: [], fish: [] }; // 私聊里最近几句（别人说的 + 她说的），按话题想起时当「前两句」用
  const noteHeard = (peer, lines) => { if (heardLines[peer]) heardLines[peer] = [...heardLines[peer], ...lines].slice(-6); };
  // ── 激素影子记录（2026-10-29 第五批，老大同意：先只记录一周，不影响行为，靠日志校准参数；见 src/hormone-feed.js、hormone-shadow.js）。
  // 跟小鲸鱼同一套事件口径，只是性格参数不同（姐姐按老大定的性格：对外人淡、对家里人反应强）。config 的 hormones.enabled=false 就不记。她看不到，也不触发任何行为；
  // 出任何错只记一行日志，不影响她说话。状态存 sister/state/hormones-sister.json(.jsonl)。
  let hormoneErrLogged = 0;
  const HORMONE_EXPLORE_FILE = path.join(SISTER_BRAIN.days, '逛过的.jsonl');
  const sisterInterests = () => loadSisterInterests({ biliFile: BILI_WATCH, selfFile: SELF_FILE, extraFiles: [HORMONE_EXPLORE_FILE] });
  const hormoneFeed = createHormoneFeed({
    who: 'sister',
    stateDir: STATE_DIR,
    skewMs: () => clockSkewMs(),
    asleep: !!(st.sleep && Date.now() < st.sleep.until),
    enabled: cfg.hormones?.enabled !== false,
    sisterName: '妹妹',
    interests: cfg.hormones?.enabled === false ? [] : sisterInterests(),
    onError: (e) => { if (hormoneErrLogged++ < 5) log('[hormones] 影子记录出错（不影响她）：', e?.message ?? e); }
  });
  const hormoneRecord = (ev) => { try { hormoneFeed.record(ev); } catch { /* 记不下就算了 */ } };
  // 2026-10-29 施工单 C（老大同意：哪里发生的事都算、一个人一份）：激素推动心情。各会话里发生的事早就经 hormoneRecord 进了激素，
  // 这里每 5 分钟把激素水平换算成一点点心情推动量，存进 sister/state/mood-push-sister.json；读心情的人（mood.read）把它叠在她自己写的心情上。
  // 她自己写了心情（qq_mood / 心情行）时推动量先并进去再清零；激素没开就只回落不再推，睡着不推。
  const recordToolFails = (fails) => appendToolFails(path.join(STATE_DIR, 'tool-errors.jsonl'), fails);
  const moodPusher = createMoodPusher({
    file: moodPushFile(STATE_DIR, 'sister'),
    getLevels: () => (hormoneFeed.enabled ? hormoneFeed.snapshot()?.levels ?? null : null),
    isAsleep: () => !!(st.sleep && Date.now() < st.sleep.until),
    onError: (e) => { if (hormoneErrLogged++ < 5) log('[mood-push] 激素推动心情出错（不影响她）：', e?.message ?? e); }
  });
  const hormoneNovelty = createNoveltyTracker();
  let hormoneWasAsleep = !!(st.sleep && Date.now() < st.sleep.until);
  /** 睡 / 醒有变化就记一笔（每分钟看一次；睡下、被叫醒的地方也调一次，重复调用没关系）。 */
  function syncHormoneSleep() {
    const now = !!(st.sleep && Date.now() < st.sleep.until);
    if (now === hormoneWasAsleep) return;
    hormoneWasAsleep = now;
    hormoneRecord({ type: now ? 'sleep' : 'wake' });
  }
  /** 收到一条消息：私聊（owner / fish）或群里（gid）。directed：群里被 @ / 叫名字 / 回复她。 */
  function hormoneIncoming({ from, gid = '', text, directed = false }) {
    try {
      const where = gid ? 'group' : 'private';
      const isOwner = from === ownerId;
      const isSister = from === fishId && (!gid || houseIds.has(gid)); // 别的群里妹妹说话按群消息算
      const novelty = gid ? hormoneNovelty.score(`group:${gid}`, text) : undefined;
      for (const ev of incomingHormoneEvents({ where, isOwner, isSister, atMe: directed, text, novelty })) hormoneRecord(ev);
    } catch { /* 记不下就算了 */ }
  }
  /** 她发出去了一条：peer 是 owner / fish / group:群号（routeReply 的叫法）。 */
  function hormoneSent(peer) {
    const target = peer === 'owner' ? 'owner' : peer === 'fish' ? 'sister' : String(peer).startsWith('group:') ? (houseIds.has(String(peer).slice(6)) ? 'sister' : 'group') : '';
    const ev = target ? sentHormoneEvent(target) : null;
    if (ev) hormoneRecord(ev);
  }
  // 2026-10-29 老大（页面上的一键开关）：定时器和天气只起一次，关着的时候 record / tick 都是空操作，所以热开不用重启
  let hormoneTimersStarted = false;
  function startHormoneTimers() {
    if (hormoneTimersStarted) return;
    hormoneTimersStarted = true;
    const timers = [
      [() => { syncHormoneSleep(); hormoneFeed.tick(); }, 60e3],
      [() => { const ev = moodHormoneEvent(mood.readRaw(), Date.now()); if (ev) hormoneRecord(ev); }, HORMONE_REFRESH.moodMs],
      [() => { const l = sisterInterests(); if (l.length > 0) hormoneFeed.setInterests(l); }, HORMONE_REFRESH.interestsMs],
      [() => moodPusher.tick(), HORMONE_REFRESH.moodMs] // 施工单 C：激素推动心情
    ];
    // 天气：姐姐自己拉一份（跟小鲸鱼同一个城市），只用来喂影子记录（不放进她的提示里）
    const sisterWeather = createWeather({ log: (...a) => log(...a) });
    sisterWeather.start();
    timers.push([() => { for (const ev of weatherHormoneEvents(sisterWeather.state())) hormoneRecord(ev); }, HORMONE_REFRESH.weatherMs]);
    for (const [fn, ms] of timers) setInterval(() => { try { fn(); } catch { /* 记不下就算了 */ } }, ms).unref?.();
    try { const ev = moodHormoneEvent(mood.readRaw(), Date.now()); if (ev) hormoneRecord(ev); } catch { /* 还没有心情就算了 */ }
    setTimeout(() => { try { for (const ev of weatherHormoneEvents(sisterWeather.state())) hormoneRecord(ev); } catch { /* 同上 */ } }, 20e3).unref?.();
  }
  if (hormoneFeed.enabled) startHormoneTimers();
  // 实时区缓冲（只在内存里，进程一重启就没了）；liveNow：她此刻这一轮在跟谁（页面上显示）
  const liveBuf = createLiveBuffer({ who: 'sister' });
  let liveNow = null;
  const SEND_TOOL_RE = /sister-qq__qq_(send|send_voice|send_image)$/;
  let busyUntil = 0; // Claude 出错后歇一会儿
  // ── 看图（2026-10-29 主人，大整理第二批 D1/D2/E1）────────────────────────────
  // 原来：单张超过 4.5MB 就丢、不提示；GIF 原样给（只看得到第一帧）；每次下载 30 秒不限大小，原地址 + 每个 rkey 重下；
  // 每次群唤醒把最近 3 张图重新附一遍（同一张最多附 32 次，会话存档一天 47.7MB，「想」从 4 秒涨到 160 秒）。
  // 现在：消息一到就预取（下载 + 抽帧 / 缩图都在这时做，唤醒时直接拿）；下载走共用下载器（40 秒、太大第一次就放弃）；
  // 同一张图本会话只附一次（st.seenImages，换会话清空）；附图说明逐张写清对应哪条、哪张没看清。
  let rkeys = { at: 0, list: [] };
  async function getRkeys() {
    if (Date.now() - rkeys.at > 5 * 60e3) {
      try { const d = await bot.call('get_rkey'); rkeys = { at: Date.now(), list: (Array.isArray(d) ? d : []).map((x) => x?.rkey).filter(Boolean) }; } catch { rkeys.at = Date.now() - 4 * 60e3; /* 没有就算了，一分钟后再问 */ }
    }
    return rkeys.list;
  }
  const downloader = createImageDownloader({ fetchBuffer: safeFetchBuffer, maxBytes: DOWNLOAD_MAX_BYTES, timeoutMs: 40e3 });
  async function localImage(file) {
    const d = await bot.call('get_image', { file });
    if (d?.file && fs.existsSync(d.file) && fs.statSync(d.file).size <= 50 * 1024 * 1024) return fs.readFileSync(d.file);
    return null;
  }
  const imageCache = new Map(); // key → { at, ok, promise }
  function fetchImage(raw) {
    const ref = normImageRef(raw);
    const ck = ref?.key || ref?.url || ref?.file || '';
    const hit = ck && imageCache.get(ck);
    // 成功的一直留着；失败的 2 分钟后才重试（下载器自己也记着失败的地址）
    if (hit && (hit.ok !== false || Date.now() - hit.at < 2 * 60e3)) return hit.promise;
    const entry = { at: Date.now(), ok: undefined, promise: null };
    entry.promise = (async () => fetchImageForView(ref, { downloader, rkeys: ref?.urls?.some((u) => !u.includes('rkey=')) ? await getRkeys() : [], getLocalFile: localImage, viewOptions: { log } }))()
      .catch((e) => ({ ok: false, reason: `处理这张图出错了（${String(e?.message ?? e).slice(0, 60)}）` }))
      .then((r) => { entry.ok = !!r?.ok; if (!r?.ok) log(`图没取到：${r?.reason || '不知道为什么'}`); return r; });
    if (ck) {
      imageCache.set(ck, entry);
      if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
    }
    return entry.promise;
  }
  /** 消息刚到就开始下（不等排队、不阻塞），唤醒时直接拿结果。 */
  function prefetchImages(refs) { for (const r of refs || []) void fetchImage(r); }
  /** 唤醒时拿图：预取还没完的最多再等 15 秒，再不行就说「还在下载」，不卡住排队。 */
  function waitImage(ref, ms = 15e3) {
    let t;
    return Promise.race([fetchImage(ref), new Promise((res) => { t = setTimeout(() => res({ ok: false, pending: true, reason: '还在下载' }), ms); })]).finally(() => clearTimeout(t));
  }
  /** 这一轮的附图：看过的不再附，最多 3 张；返回 { images, keys, note }。keys 在叫成功后记进 st.seenImages。 */
  async function prepareImages(refs, max = 3) {
    const seen = st.seenImages?.sid && st.seenImages.sid === st.sessions.main ? (st.seenImages.keys || {}) : {};
    const images = [], keys = [], entries = [];
    for (const p of planImages(refs, seen, max)) {
      if (p.status !== 'want') { entries.push(p); continue; }
      const got = await waitImage(p.ref);
      if (got?.ok) {
        images.push({ data: got.buffer, mime: got.mimeType });
        keys.push([p.key, p.ref.mid ?? null]);
        entries.push({ ...p, status: 'attached', n: images.length, note: got.note || '' });
      } else entries.push({ ...p, status: got?.pending ? 'pending' : 'failed', reason: got?.reason });
    }
    return { images, keys, note: imagesNote(entries, max) };
  }
  /** 叫成功了：这几张算她在这个会话里看过了。会话换了就从头记。 */
  function rememberSeen(sessionId, keys) {
    if (!keys?.length || !sessionId) return;
    if (st.seenImages?.sid !== sessionId) st.seenImages = { sid: sessionId, keys: {} };
    for (const [k, mid] of keys) if (k) st.seenImages.keys[k] = mid;
    const all = Object.keys(st.seenImages.keys);
    for (const k of all.slice(0, Math.max(0, all.length - 400))) delete st.seenImages.keys[k];
  }

  // ── 2026-10-29 整改 E 的小工具 ───────────────────────────────────────────────
  const WISH_FILE = path.join(SISTER_BRAIN.recent, '我想试试.md'); // 「我想试试」清单：她自己写，自己醒来时带上，做不做她定
  function wishText() {
    try {
      return fs.readFileSync(WISH_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !/^[#>]/.test(l)).join('\n').slice(0, 600);
    } catch { return ''; }
  }
  /** 每天第一次醒来（北京时间 8 点以后）带上昨天的镜子（跟小鲸鱼的每日自我统计一样，不要求先睡一觉），末尾问一句「像你吗？」。 */
  function takeMirror() {
    const p = bjParts(Date.now(), clockSkewMs());
    if (cfg.mirror?.enabled === false || p.h < 8 || st.mirrorDay === p.day) return { text: '', day: '' };
    let text = '';
    try {
      text = mirrorText(sisterLinesFromChatlog(fs, CHATLOG_DIR, bjParts(Date.now() - 86400e3, clockSkewMs()).day), { label: '昨天', selfPage: `「${relHome(SELF_FILE)}」`, ask: true });
    } catch { text = ''; }
    return { text: text ? text + '\n' : '', day: p.day };
  }
  /** 单次用量保险线（美元，估算）。0 = 不兜。 */
  const costCapUsd = () => { const v = Number(cfg.costGuard?.maxUsdPerTurn ?? 1.5); return v > 0 ? v : 0; };
  /** 会话里装的 token 到线了（默认约 75K，空闲或睡醒时换；rotateAtMB 照旧兜底）。 */
  function checkSessionTokens(ctxTokens) {
    const limit = cfg.rotateAtTokens === undefined ? 75000 : Number(cfg.rotateAtTokens);
    if (st.rotatePending || !shouldRotateByTokens(ctxTokens, limit)) return;
    st.rotatePending = true;
    log('会话已经装了约 ' + Math.round(Number(ctxTokens) / 1000) + 'K token，超过 ' + Math.round(limit / 1000) + 'K，等空闲或睡醒时换新会话');
  }
  const hormoneCfgNatural = () => ({});
  /** 睡着的这一觉到时间了吗（固定时间看钟，自然醒看激素的睡眠压力）。 */
  const sleepEnded = () => sleepEndedNow(st.sleep, Date.now(), hormoneFeed.enabled ? hormoneFeed.snapshot()?.hormones : null);
  /** 她今天发过说说了吗（看聊天记录里的说说文件，qq_qzone_post 和「→说说：」都会记）。 */
  function qzonePostedToday() {
    try {
      const day = bjParts(Date.now(), clockSkewMs()).day;
      // 「→说说：」记在 <日期>-说说.md；qq_qzone_post 工具（qq-mcp.mjs）记在当天跟小鲸鱼的那份 <日期>.md 里。两处都看
      for (const name of [day + '-说说.md', day + '.md']) {
        try { if (fs.readFileSync(path.join(CHATLOG_DIR, name), 'utf8').includes('（发了条说说）')) return true; } catch { /* 这份还没有 */ }
      }
      return false;
    } catch { return false; }
  }
  const GO_TO_FILE = path.join(STATE_DIR, 'go-to-queue.json');

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
  /** 页面上写「她这一轮在跟谁」用的人话名字。 */
  const livePeerLabel = (peer) => (peer === 'owner' ? '老大私聊' : peer === 'fish' ? '小鲸鱼私聊' : String(peer || '').startsWith('group:') ? `群「${groups.get(String(peer).slice(6))?.name || String(peer).slice(6)}」` : '');
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
      const out = recentRambling(fs.readFileSync(cfg.ramblingFile || brainOf('whale').rambling, 'utf8'));
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
    fs.writeFileSync(SYSTEM_FILE, `${fs.readFileSync(PERSONA_FILE, 'utf8')}\n\n【${relHome(SELF_FILE)} —— 你自己写的，现在的样子】\n${self || '（还空着）'}\n`);
    return SYSTEM_FILE;
  }

  // ── 先起好下一个（2026-10-25 主人：姐姐回得慢）
  // 实测一次回话：claude 启动 + 读档 + 连工具约 3 秒，模型想约 4 秒，说完到进程退出还要 1.5～2 秒。
  // 启动那段它会停在「等输入」，所以上一轮一结束就起一个候着，消息来了直接递进去；结果一到就发，不等退出。
  // 同一个会话同一时间只许一个进程碰：新起之前都等上一个退干净（lastExit）。
  // 候着的按回话的力度（replyEffort）起；自己醒、陪看这些用别的力度的，就把候着的关掉现起一个（不急，慢点没事）。
  let warm = null, claudeBusy = false, lastExit = Promise.resolve();
  let lastReplyEffort = effortFor('house', cfg); // 候着的进程用最近一次「有人找她」的力度起（小房子多，所以默认 low），自己醒的力度不同就现起一个
  const WARM_MAX_MS = 30 * 60e3; // 候太久就换个新的，免得哪里旧了
  const fileSig = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  function startClaude(effort, sessionId, resume) {
    const systemFile = buildSystemFile();
    const p = spawnClaude({ exe, sessionId, resume, model: cfg.model || 'claude-opus-5-5', effort, cwd: home, proxy: cfg.proxy, systemFile, deny: PROTECTED_RULES });
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
  /**
   * 换新会话：记下旧的、关掉候着的旧进程，返回新会话第一轮要带的交接（见 handoffBlock）。
   * reason：wake 睡醒换（带她睡前写的交接.md）；size 会话存档太大了换（2026-10-29 主人，只在空闲时换，不在回合中途）。
   */
  function rotateSession(reason = 'wake') {
    const old = st.sessions.main;
    if (!old || (reason === 'wake' && cfg.rotateOnWake === false)) return '';
    let handoff = '';
    if (reason === 'wake') { try { handoff = fs.readFileSync(SISTER_BRAIN.handoff, 'utf8'); } catch { /* 没写 */ } }
    // 2026-10-29：旧摘要里带着旧规矩和「扮演」的口气，滤掉（cfg.rotateSummary === 'off' 就干脆不带）
    const summary = cfg.rotateSummary === 'off' ? '' : cleanCompactSummary(lastCompactSummary(sessionFileOf(old, home)));
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
    st.seenImages = null; // 新会话里她什么图都没看过
    st.rotatePending = false;
    if (warm) { try { warm.child.stdin.end(); } catch { /* 已经退了 */ } warm = null; }
    log(`${reason === 'size' ? '会话存档太大，空闲时换新会话' : '睡醒换新会话'}（旧的 ${old.slice(0, 8)}…，交接 ${handoff.trim() ? `${handoff.trim().length} 字` : '没写'}，摘要 ${summary ? `${summary.length} 字` : '没有'}）`);
    let moodNote = '';
    let moments = '';
    try { moodNote = mood.handoff(); } catch { moodNote = ''; }
    try { moments = episodes.handoffBlock('', { hours: 72, max: 3, title: '[感受最深的几个瞬间（你自己留下的）]\n' }); } catch { moments = ''; }
    return handoffBlock({ handoff, summary, recent, reason, mood: moodNote, moments });
  }
  /** 会话存档超过 rotateAtMB（默认 15MB）就记一笔，等空闲或睡醒时换（2026-10-29 主人，E1）。 */
  function checkSessionSize(sessionId) {
    const limitMB = cfg.rotateAtMB === undefined ? 15 : Number(cfg.rotateAtMB);
    if (!(limitMB > 0) || !sessionId || st.rotatePending) return;
    try {
      const size = fs.statSync(sessionFileOf(sessionId, home)).size;
      if (size > limitMB * 1024 * 1024) { st.rotatePending = true; log(`会话存档 ${(size / 1024 / 1024).toFixed(1)}MB，超过 ${limitMB}MB，等空闲或睡醒时换新会话`); }
    } catch { /* 还没有文件 */ }
  }
  function prewarm() {
    if (cfg.prewarm === false || !st.sessions.main) return;
    const mine = lastExit;
    mine.then(() => {
      if (warm || claudeBusy || lastExit !== mine) return;
      const w = startClaude(lastReplyEffort, st.sessions.main, true);
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
  let lastWakeEndAt = 0;
  async function wake(prompt, { defaultPeer = null, images = [], imageKeys = [], counted = false, effort = null, selfWake = false, recallLines = null, correctionText = '' } = {}) {
    if (Date.now() < busyUntil) { log('Claude 还在歇，先不叫'); return false; }
    const rambling = readRambling();
    const withRambling = rambling && rambling.sig !== st.ramblingSig
      ? `[小鲸鱼最近写的碎碎念（她自己的本子，老大同意给你看，她也知道你能看到）]\n${rambling.text}\n\n${prompt}`
      : prompt;
    const feeds = await gatherFeeds({ replying: !!defaultPeer });
    // 妹妹现在在干嘛（主人：想知道妹妹睡没睡问姐姐就行，不用吵醒妹妹）。一句话，详细的用 qq_fish_status。
    let fishNow = '';
    try { fishNow = `[小鲸鱼现在：${fishStatus({ bridgeState: BRIDGE_STATE, nameOf: convoName }).line.replace(/^小鲸鱼/, '')}]\n`; } catch { /* 读不到就不写 */ }
    // 妈妈留的话（state 里的 momNote，一次性）：下次被叫醒带上，说过就清掉
    const momNote = st.momNote ? `[妈妈留言：${st.momNote}]\n` : '';
    // 2026-10-29 老大留的话（一次性，说过就清掉）：跟小鲸鱼那边一样的口吻
    const ownerNotes = Array.isArray(st.ownerNotes) ? st.ownerNotes.slice(0, 5) : [];
    const ownerNote = ownerNotes.length ? `${ownerNotes.map((n) => `[老大留了一句话给你：${n.text}]`).join('\n')}\n` : '';
    // 会话存档太大换了新会话（空闲时换的）：交接留到下一次叫她时带上
    const carry = st.carryNext || '';
    // 2026-10-29 被压住的话下一轮带回给她：「你刚才还想说：…（没发出去），还发不发你定」，不再只在日志里（见 heldNoteText）
    const heldNote = heldNoteText(st.heldLines);
    // 2026-10-29 大脑方案下半：心情一行（跟小鲸鱼同一个格式）、按话题想起（服务没起 / 超时 1.5 秒就静默跳过）、
    // 夜里自己醒来时附一段睡前整理建议（可选，只列不改）、记下她现在在跟谁说话（qq_keep_moment 默认记在这儿）。
    let moodLine = '';
    try { moodLine = mood.line(); } catch { moodLine = ''; }
    // 2026-10-29 施工单 C：一句许可，回话最后想写心情行就写（一个会话带一次；换了会话再带）
    const moodHintSession = st.sessions.main || '';
    const moodHintNow = cfg.moodLine?.enabled !== false && st.moodHintFor !== moodHintSession;
    if (moodHintNow) moodLine += MOOD_LINE_HINT;
    // 2026-10-29 第五批（老大：合写的书别让她们换会话就忘了）：最近 48 小时里动过，就提一句写到第几节、怎么打开；
    // 只提一句，不灌全文；同样的一句 6 小时内不重复带
    let novelLine = '';
    try {
      const nl = novelWakeLine({ root: BOOKS_ROOT });
      if (nl && (st.novelHint?.text !== nl || Date.now() - (Number(st.novelHint?.at) || 0) > 6 * 3600e3)) { novelLine = nl; st.novelHint = { text: nl, at: Date.now() }; }
    } catch { novelLine = ''; }
    const peerKey = defaultPeer === 'owner' ? `private:${ownerId}` : defaultPeer === 'fish' ? `private:${fishId}` : String(defaultPeer || '').startsWith('group:') ? defaultPeer : '';
    let recallBlock = '';
    if (recallLines && cfg.brainRecall?.enabled !== false) {
      try {
        const q = recallQueryFromLines(recallLines);
        if (q) {
          const isHouse = String(defaultPeer || '').startsWith('group:') && houseIds.has(defaultPeer.slice(6));
          const mode = String(defaultPeer || '').startsWith('group:') && !isHouse ? 'group' : 'private';
          recallBlock = formatRecallBlock(await brainRecall({ brain: 'sister', query: q.query, prev: q.prev, mode, viewerKey: peerKey, timeoutMs: Number(cfg.brainRecall?.timeoutMs) || 1500 }));
        }
      } catch { recallBlock = ''; }
    }
    // 2026-10-29 老大：「困」提前从影子里放出来（只放这一项）：明显偏高才带一句身体感受，不出数字、不是命令
    let sleepyLine = '';
    if (cfg.sleepyLine?.enabled !== false && hormoneFeed.enabled && !asleep()) {
      try {
        const fr = sleepyFeel(hormoneFeed.snapshot()?.hormones, st.sleepyPrev, undefined, { pick: Math.floor(Date.now() / 3600e3) });
        st.sleepyPrev = { active: fr.active };
        if (fr.line) sleepyLine = `[身上的感觉：${fr.line}]\n`;
      } catch { sleepyLine = ''; }
    }
    // 成长循环（2026-10-29 老大：得好好补偿姐姐）：「我想试试」清单（她自己写，自己醒时带上）、偶尔问一句最近想去看看什么、夜里提一句今天的自己、每天一次照镜子
    let growLines = '';
    if (selfWake && !asleep()) {
      const w = wishText();
      if (w) growLines += `[你的「我想试试」清单（${relHome(WISH_FILE)}，你自己写的）：\n${w}\n想做哪件、什么时候做你定，做完了可以划掉。]\n`;
      else if (st.wishHintFor !== (st.sessions.main || '-')) { growLines += `[想试试的事可以记在 ${relHome(WISH_FILE)}，一行一件，自己醒来时会给你看；做不做你定。]\n`; st.wishHintFor = st.sessions.main || '-'; }
      const today = bjParts(Date.now(), clockSkewMs()).day;
      if (st.lookHintDay !== today && Math.random() < (Number(cfg.lookChance) >= 0 ? Number(cfg.lookChance) : 0.3)) { growLines += '[顺便问问自己：最近有什么想去看看的？有就去看看，没有就算了。]\n'; st.lookHintDay = today; }
    }
    if ((selfWake || defaultPeer === 'owner') && !asleep()) {
      const bp = bjParts(Date.now(), clockSkewMs());
      if (bp.h >= 21 || bp.h < 4) {
        const night = bp.h < 4 ? bjParts(Date.now() - 5 * 3600e3, clockSkewMs()).day : bp.day;
        if (st.selfHintNight !== night) { growLines += `[睡前如果想，可以在「${relHome(SELF_FILE)}」里写一句「今天我是什么样的」；写不写都行。]\n`; st.selfHintNight = night; }
      }
    }
    const mirrorR = asleep() ? { text: '', day: '' } : takeMirror();
    growLines += mirrorR.text;
    let tidyBlock = '';
    if (selfWake && !asleep()) {
      const bp = bjParts(Date.now(), clockSkewMs());
      const night = bp.h >= 22 || bp.h < 4 ? bjParts(Date.now() - 5 * 3600e3, clockSkewMs()).day : '';
      if (night && st.tidyNight !== night) {
        st.tidyNight = night;
        try { const t = await brainTidy({ brain: 'sister', timeoutMs: 4000 }); if (t?.text) tidyBlock = `${t.text}\n`; } catch { /* 没起来就不给 */ }
      }
    }
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, 'current-peer.json'), JSON.stringify({ key: peerKey, at: Date.now() })); } catch { /* 记不下就让她自己写 where */ }
    let r, warmUsed = false;
    const turnGuard = { costCapUsd: costCapUsd(), prices: cfg.costGuard?.prices }; // 单次兜底的线（只在程序里，不进提示）
    const t0 = Date.now();
    const eff = effort || effortFor('self', cfg);
    if (defaultPeer) lastReplyEffort = eff;
    claudeBusy = true;
    // 2026-10-29 老大：页面上的实时区。只记她写出来的话、调的工具和成败、「正在想」从几点开始；她的思考内容不采集
    const liveSession = peerKey || 'self';
    const liveLabel = livePeerLabel(defaultPeer) || '自己醒着';
    liveNow = { key: liveSession, label: liveLabel, since: Date.now(), effort: eff };
    try { liveBuf.ingestClaudeLine({ type: 'system', subtype: 'init' }, { session: liveSession, label: liveLabel }); } catch { /* 实时区坏了不拖累她 */ }
    const liveLine = (x) => { if (x?.type !== 'system') liveBuf.ingestClaudeLine(x, { session: liveSession, label: liveLabel, sendTool: (n) => SEND_TOOL_RE.test(n) }); };
    try {
      const proc = await takeClaude(eff);
      warmUsed = proc.warm;
      r = await runClaude(proc, { onLine: liveLine, ...turnGuard, prompt: carry + momNote + ownerNote + heldNote + fishNow + moodLine + sleepyLine + growLines + novelLine + feeds.text + tidyBlock + correctionText + recallBlock + withRambling, images, sessionId: proc.sessionId });
    } catch (e) {
      claudeBusy = false;
      liveNow = null;
      liveBuf.endTurn(liveSession);
      liveBuf.add({ session: liveSession, label: liveLabel, kind: 'note', text: `这一轮没成：${String(e?.message ?? e).slice(0, 160)}` });
      prewarm();
      log('叫 Claude 出错：', e.message);
      // 额度用完 / 限流 / 登录不对（401、403，换令牌前重试也没用）：歇一小时；别的错：歇五分钟。错误只记日志，不往 QQ 发。
      // 2026-10-29 单次用量超线是程序自己中止的（不是 Claude 坏了）：只记日志，歇一会儿，不报给妈妈
      if (/^COSTGUARD/.test(e.message)) { busyUntil = Date.now() + 120e3; return false; }
      const hard = /limit|rate|quota|429|overloaded|authenticat|401|403/i.test(e.message);
      busyUntil = Date.now() + (hard ? 3600e3 : 300e3);
      st.selfFail = (st.selfFail || 0) + 1;
      if (hard || st.selfFail >= 2) void selfAlarm(e.message);
      return false;
    }
    st.sessions.main = r.sessionId;
    // 2026-10-29 第五批：激素影子记录——这一轮用过的工具（写了东西、逛了、发了表情、自己用工具发出去的话）和出错
    try {
      const sendCtx = { ownerId, fishId, houseIds: [...houseIds], houseNames: Object.values(cfg.groupAliases || {}).map(String) };
      for (const t of r.toolsUsed || []) for (const ev of [...toolHormoneEvents(t.name, t.input), ...toolSendHormoneEvents(t.name, t.input, sendCtx)]) hormoneRecord(ev);
      if (r.toolErrors > 0) hormoneRecord({ type: 'tool_fail' });
      recordToolFails(r.toolFails);
    } catch { /* 记不下就算了 */ }
    if (carry) st.carryNext = null;
    rememberSeen(r.sessionId, imageKeys);
    checkSessionSize(r.sessionId);
    checkSessionTokens(r.ctxTokens);
    if (mirrorR.day) st.mirrorDay = mirrorR.day;
    if (Number(cfg.costGuard?.maxUsdPerTurn ?? 1.5) > 0 && Number(r.costUsd) > Number(cfg.costGuard?.maxUsdPerTurn ?? 1.5)) log(`这一轮用量超出保险线（${Number(r.costUsd).toFixed(2)} 美元），已经跑完了，下回留意`);
    lastWakeEndAt = Date.now();
    if (momNote) st.momNote = null;
    if (ownerNotes.length) st.ownerNotes = (Array.isArray(st.ownerNotes) ? st.ownerNotes : []).slice(ownerNotes.length);
    if (heldNote) st.heldLines = null;
    st.selfFail = 0;
    claudeBusy = false;
    liveNow = null;
    liveBuf.endTurn(liveSession);
    prewarm();
    const ttf = r.timing?.initToFirstMs;
    log(`想了 ${Math.round((Date.now() - t0) / 1000)} 秒（${eff}${warmUsed ? '，早就起好了' : ''}${ttf != null ? `，读档到开口 ${(ttf / 1000).toFixed(1)} 秒` : ''}${images.length ? `，附图 ${images.length} 张` : ''}）`);
    if (rambling) st.ramblingSig = rambling.sig;
    feeds.commit();
    try { fs.appendFileSync(USAGE_FILE, JSON.stringify({ t: new Date().toISOString(), peer: defaultPeer || 'self', effort: eff, ctxTokens: r.ctxTokens ?? null, usage: r.usage, costUsd: r.costUsd, week: r.limit?.unifiedWindows?.seven_day?.utilization, initToFirstMs: r.timing?.initToFirstMs ?? null, images: images.length }) + '\n'); } catch { /* ignore */ }
    const pauseTo = quotaPauseUntil(r.limit, Number(cfg.weeklyStopAt) || 0.9);
    if (pauseTo > Date.now()) { busyUntil = pauseTo; log(`额度保险：周额度 ${Math.round((r.limit?.unifiedWindows?.seven_day?.utilization || 0) * 100)}%，歇到 ${new Date(pauseTo).toISOString()}`); }

    const spoke = (r.toolsUsed || []).filter((t) => /sister-qq__qq_(send|send_fish_sticker|send_voice|send_image)$/.test(t.name)).length > 0;
    const { sends, nextWakeMin, pauseCowatchMin, cowatchEveryMin, sleepSpec, moodSpec } = routeReply(r.text, spoke ? null : defaultPeer, groupNameMap());
    if (moodHintNow) st.moodHintFor = r.sessionId || moodHintSession;
    // 2026-10-29 施工单 C：她回话里单独写的「心情：……，因为……」→ 记进她的心情（这一行已经从要发的话里拿掉了，不会发出去）
    if (moodSpec) { try { if (mood.setFromLine(moodSpec)) log('心情记下了（回话里的心情行）'); } catch (e) { log('心情行没记下：', e?.message ?? e); } }
    if (r.toolsUsed?.length) log(`用了工具：${r.toolsUsed.map((t) => t.name.replace('mcp__sister-qq__', '')).join('、')}`);
    if (cowatchEveryMin) { st.cowatchEveryMin = Math.min(120, Math.max(1, cowatchEveryMin)); log(`陪看间隔改成 ${st.cowatchEveryMin} 分钟`); }
    if (pauseCowatchMin) { st.cowatchPausedUntil = Date.now() + Math.min(24 * 60, pauseCowatchMin) * 60e3; log(`先不跟着看 ${pauseCowatchMin} 分钟`); }
    // 只有自己醒 / 睡醒 / 她自己写了「下次醒」才重排；别的叫醒（回消息、陪看、路过群）只往后推到至少 15 分钟后，
    // 不然一直有人找她，自己醒就永远轮不到（2026-10-25 一整天 0 次）
    if (selfWake || nextWakeMin || !st.nextHeartbeatAt) st.nextHeartbeatAt = nextHeartbeatAt(Date.now(), clockSkewMs(), nextWakeMin);
    else st.nextHeartbeatAt = Math.max(st.nextHeartbeatAt, Date.now() + 15 * 60e3);
    if (!defaultPeer && sends.some((x) => x.peer === 'owner' || x.peer === 'fish' || x.peer.startsWith('group:'))) st.lastReachOutAt = Date.now();
    if (sleepSpec) {
      // 2026-10-29 老大：睡觉不定死。「去睡了：自然醒」（或只写「去睡了」）= 睡到自然醒，由激素的睡眠压力决定什么时候醒；写了钟点 / 小时数的照旧按她的
      if (isNaturalSleep(sleepSpec)) {
        st.sleep = naturalSleepRecord(Date.now(), hormoneCfgNatural());
        st.nextHeartbeatAt = st.sleep.until;
        log('去睡了，睡到自然醒（最短 ' + Math.round((st.sleep.minUntil - Date.now()) / 3600e3) + ' 小时，最长 ' + Math.round((st.sleep.until - Date.now()) / 3600e3) + ' 小时）');
        syncHormoneSleep();
      } else {
      const until = sleepUntilMs(sleepSpec, Date.now(), clockSkewMs());
      if (until) { st.sleep = { since: Date.now(), until }; st.nextHeartbeatAt = until; log(`去睡了，睡到 ${bjLabel(bjParts(until, clockSkewMs()))}`); syncHormoneSleep(); }
      else log(`想睡但没看懂几点醒：${sleepSpec}`);
      }
    }
    // 2026-10-29 老大：她写了字、却一句也没发出去 → 页面上记成「没说出口的」（只在内存里；写 [不回] 不算）
    if (!sends.length && !spoke) { const said = stripMoodLines(r.text).trim(); if (said && !/^[\[［]?\s*不回\s*[\]］]?$/.test(said)) liveBuf.noteUnsaid(liveSession, said, { label: liveLabel }); }
    if (!sends.length) log(`（${defaultPeer ? '不回' : '自己醒了一下，没找人'}）${defaultPeer ? '' : stripMoodLines(r.text).replace(/\s+/g, ' ').slice(0, 120)}`);
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
          if (isPost) { hormoneRecord({ type: 'posted' }); st.qzonePostedDay = bjParts(Date.now(), clockSkewMs()).day; } // 2026-10-29 第五批：激素影子记录；当天发过就不再提醒
          chatLog('姐姐', isPost ? `（发了条说说）${s.line}` : `（评论小鲸鱼的说说「${st.qzoneLatest.text}」）${s.line}`, 'qzone');
        } catch (e) { log('QQ 空间失败：', e?.message ?? e); }
        continue;
      }
      if (s.peer.startsWith('group:')) {
        const gid = s.peer.slice(6);
        const maxLines = Number(cfg.slowGroups?.[gid]?.maxLines) || 0;
        if (maxLines && sends.slice(0, i).filter((x) => x.peer === s.peer).length >= maxLines) { log(`→ ${s.peer} 这个群一次最多 ${maxLines} 条，没发：${s.line}`); liveBuf.noteUnsaid(liveSession, s.line, { label: liveLabel }); held.push({ ...s, why: `这个群一次最多发 ${maxLines} 条` }); continue; }
        if (i) await new Promise((res) => setTimeout(res, lineGapMs(s.line, cfg.lineGap)));
        log(`→ ${s.peer}：${s.line}`);
        liveBuf.add({ session: liveSession, label: liveLabel, kind: 'sent', text: s.line, to: livePeerLabel(s.peer) });
        chatLog('姐姐', s.line, s.peer);
        try { const r2 = await bot.sendGroupMessage(Number(gid), text(s.line)); const mid = r2?.message_id ?? r2?.data?.message_id; if (mid != null) { myMsgIds.add(String(mid)); if (myMsgIds.size > 300) myMsgIds.delete(myMsgIds.values().next().value); } hormoneSent(s.peer); } catch (e) { log('QQ 群发送失败：', e?.message ?? e); hormoneRecord({ type: 'send_fail' }); }
        groupLine(gid, '你', s.line);
        continue;
      }
      if (s.peer === 'fish' && fishOk === null) fishOk = (counted && defaultPeer === 'fish') || fishSendAllowed();
      if (s.peer === 'owner' && ownerOk === null) ownerOk = defaultPeer === 'owner' || (st.today.ownerProactive < cap(limits.ownerProactivePerDay) && ++st.today.ownerProactive > 0);
      if ((s.peer === 'fish' && !fishOk) || (s.peer === 'owner' && !ownerOk)) { log(`→ ${s.peer} 没发（今天的次数到了）：${s.line}`); liveBuf.noteUnsaid(liveSession, s.line, { label: liveLabel }); held.push({ ...s, why: '今天找这边的次数到了' }); continue; }
      if (i) await new Promise((res) => setTimeout(res, lineGapMs(s.line, cfg.lineGap)));
      log(`→ ${s.peer}：${s.line}`);
      liveBuf.add({ session: liveSession, label: liveLabel, kind: 'sent', text: s.line, to: livePeerLabel(s.peer) });
      chatLog('姐姐', s.line, s.peer);
      try { await bot.sendPrivateMessage(Number(s.peer === 'fish' ? fishId : ownerId), text(s.line)); hormoneSent(s.peer); } catch (e) { log('QQ 发送失败：', e?.message ?? e); hormoneRecord({ type: 'send_fail' }); }
    }
    if (held.length) {
      // 2026-10-29：压住的话不再丢——按「对谁、为什么」分组存下，下一轮带回给她（见 heldNoteText）
      const groupsHeld = new Map();
      for (const h of held) {
        const to = h.peer === 'owner' ? '老大' : h.peer === 'fish' ? '小鲸鱼' : (houseIds.has(String(h.peer).replace(/^group:/, '')) ? '小房子里有人' : '群里有人');
        const why = h.why || to + '又说话了';
        const k = to + '|' + why;
        if (!groupsHeld.has(k)) groupsHeld.set(k, { to, why, lines: [] });
        groupsHeld.get(k).lines.push(h.line);
      }
      st.heldLines = [...groupsHeld.values()];
      log('有 ' + held.length + ' 句先没发（下一轮带回给她）：' + held.map((x) => x.line).join(' / ').slice(0, 120));
      liveBuf.noteUnsaid(liveSession, '（先没发）' + held.map((x) => x.line).join(' / '), { label: liveLabel });
    }
    saveState(st);
    return true;
  }

  // 她常常一口气发好几条，等她停下来再一起回
  const pending = { fish: [], owner: [] };
  const heardAt = {}; // 每个会话（owner / fish / group:群号）最后一次有人说话的时间，插话就停用
  const timers = {};
  function queue(peer, line, imgs = [], mid = null) {
    pending[peer].push({ at: Date.now(), line: mid != null ? `[#${mid}] ${line}` : line, imgs: imgs.map((im) => ({ ...im, mid: im.mid ?? mid })) });
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
    // 2026-10-29 大脑方案下半：按话题想起用「这句 + 前两句」；老大说「记错了」就把刚才想起的降权，并提醒她去改本子
    const recallLines = [...(heardLines[peer] || []), ...msgs.map((m) => m.line)];
    noteHeard(peer, msgs.map((m) => m.line));
    let correctionText = '';
    if (peer === 'owner' && msgs.some((m) => isMemoryCorrection(String(m.line).replace(/^\[#\d+\]\s*/, '')))) {
      try { correctionText = correctionReminder((await brainDemote({ brain: 'sister' })).demoted); } catch { correctionText = ''; }
      if (correctionText) log('老大说记错了：最近想起的几条已降权，提醒她去改本子');
    }
    // 图片：消息到的时候就预取好了；看过的不再附，最多 3 张，附图说明逐张写清对应哪条
    const { images, keys: imageKeys, note: picNote } = await prepareImages(msgs.flatMap((m) => m.imgs || []));
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
        woke = `[你本来在睡觉（${bjLabel(bjParts(wb.since, skew))} 睡的，${wb.natural ? '原本想睡到自然醒' : `原定睡到 ${bjLabel(bjParts(wb.until, skew))}`}），是老大的私聊把你叫起来的。${digest ? `睡着时攒下的：\n${digest}\n` : ''}回完想接着睡就单独写一行「去睡了：自然醒」（想定个时间也行），不睡就照常。]\n`;
      }
      if (await wake(`${woke}${peerIm}[北京时间 ${now}，老大私聊你]\n${body}${picNote}`, { defaultPeer: 'owner', images, imageKeys, effort: effortFor('owner', cfg), recallLines, correctionText }) && wb) {
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
      : `[北京时间 ${now}，小鲸鱼私聊你，今天第 ${plan.nth} 次聊，第 ${plan.round} 轮${plan.last ? '，这次最后一轮，想的话可以自然收个尾' : ''}]`;
    if (!await wake(`${peerIm}${note}\n${earlier}小鲸鱼：\n${body}${picNote}`, { defaultPeer: 'fish', images, imageKeys, counted: true, effort: effortFor('house', cfg), recallLines })) {
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
        // 2026-10-29 主人（D2）：引用消息里的图原来永远不取。现在也拿出来（看过的不会重复附）
        imgs.unshift(...eventImages({ message: m?.message }).map((x) => ({ ...x, mid: reply.data.id, from: 'quote' })));
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
        for (const m of f.messages) for (const md of m.media || []) if (imgs.length < 3 && /^https?:/i.test(md?.url || '')) imgs.push({ ...normImageRef({ url: md.url, file: md.file || '', summary: '' }), from: 'forward' });
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
  function groupLine(gid, who, line, mid = null, imgs = [], uid = '', calls = false) {
    const g = groups.get(String(gid));
    if (!g) return;
    g.lines.push({ at: Date.now(), who: mid != null ? `${who}[#${mid}]` : who, ...(uid ? { uid: String(uid) } : {}), ...(calls ? { calls: true } : {}), text: String(line).replace(/\s+/g, ' ').slice(0, 200), ...(imgs.length ? { imgs: imgs.slice(0, 3).map((im) => ({ ...im, mid: im.mid ?? mid })) } : {}) });
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
  /**
   * 群里最近几条带的图：看过的不再附，没看过的最多 groupMaxImages 张（默认 1，预取好的直接拿）。
   * 2026-10-29 主人（刷屏提速）：优先叫她的那条消息里的图，别人发的动画表情 / 动图不带（见 selectGroupImageRefs）。
   */
  function groupImages(g, lastN = 6, max = groupMaxImagesOf(cfg)) {
    return prepareImages(selectGroupImageRefs(g.lines, lastN), max);
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
    // 图一到就开始下（醒着才下；睡着时等醒了再说）。人多的慢群（slowGroups）只预取叫她的那条，别的等真要看再下
    if (!asleep() && ex.imgs?.length && (wantsHer || !cfg.slowGroups?.[gid])) prefetchImages(ex.imgs.slice(0, 3).map((im) => ({ ...im, mid: im.mid ?? event.message_id ?? null })));
    // 别人名字里带「老大」这类叫法的注一句（2026-10-25 小鲸鱼把「群友118」当成了老大）
    const rawWho = event.sender?.card || event.sender?.nickname || from;
    const who = from === fishId ? '小鲸鱼' : from === ownerId ? '老大' : (/老大|主人/.test(rawWho) ? `${rawWho}（不是老大）` : rawWho);
    groupLine(gid, who, line, event.message_id ?? null, ex.imgs || [], from, wantsHer); // wantsHer = 这条会叫她（@ / 小房子里的家人 / 冲小鲸鱼），带图时优先给她看这条的图
    heardAt[`group:${gid}`] = Date.now();
    hormoneIncoming({ from, gid, text: line, directed: mentionsSister(event, cfg.selfQQ, myMsgIds) }); // 2026-10-29 第五批：激素影子记录
    if (from === fishId && event.message_id != null) { fishMsgIds.add(String(event.message_id)); if (fishMsgIds.size > 300) fishMsgIds.delete(fishMsgIds.values().next().value); }
    const forFish = from !== ownerId && hostileToFish(event, fishId, fishMsgIds);
    if (!forFish && !inHouse && !mentionsSister(event, cfg.selfQQ, myMsgIds)) { maybeLurk(gid); return; }
    if (!forFish && impressions.ignored(from) && !apologizing(line)) { log(`懒得理 ${who}（${from}），只记不叫醒`); return; }
    const sorry = impressions.scoreOf(from) < 0 && apologizing(line);
    chatLog(who, line, `group:${gid}`);
    if (asleep()) { noteAsleep(`group:${gid}`, who, forFish ? `${line}（像是在冲小鲸鱼）` : line); return; }
    scheduleGroupWake(gid, { who, from, inHouse, forFish, sorry, directed: mentionsSister(event, cfg.selfQQ, myMsgIds) });
  });

  /**
   * qq_go_to 的姐姐版（2026-10-29 老大：对等）：她只有一个会话，所以是「把一件事带到另一个地方说」。
   * qq-mcp 把 { target: 'owner'|'fish'|'group:群号', note, from } 写进 state/go-to-queue.json，这里不忙时取走，
   * 给那边叫她一次（她直接写的话发到那边）。睡着时先留着，醒了再带。
   */
  function drainGoTo() {
    if (asleep()) return false;
    const q = readGoToQueue(GO_TO_FILE);
    if (!q.length) return false;
    try { fs.writeFileSync(GO_TO_FILE, '[]'); } catch { return false; }
    for (const item of q.slice(0, 3)) {
      const target = String(item.target);
      const gid = target.startsWith('group:') ? target.slice(6) : '';
      if (gid && !groups.has(gid)) continue;
      if (!gid && target !== 'owner' && target !== 'fish') continue;
      const label = livePeerLabel(gid ? target : target) || (target === 'owner' ? '老大私聊' : '小鲸鱼私聊');
      serial(async () => {
        const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
        const g = gid ? groups.get(gid) : null;
        const recent = g ? g.lines.slice(-8).map((x) => x.who + '：' + x.text).join('\n') : '';
        log('带到另一个地方说：' + label);
        await wake('[北京时间 ' + now + '，你刚才' + (item.from ? '在' + item.from : '在别处') + '想把一件事带到这边（' + label + '）说：\n「' + String(item.note).slice(0, 600) + '」\n你直接写的话会发到' + label + '；想说就说，不想说了写 [不回] 也行。]' + (recent ? '\n最近那边：\n' + recent : ''), { defaultPeer: target, effort: effortFor(gid ? (houseIds.has(gid) ? 'house' : 'group') : (target === 'owner' ? 'owner' : 'house'), cfg), recallLines: g ? g.lines.slice(-3).map((x) => x.text) : null });
      });
    }
    return true;
  }

  // 同一个群的唤醒只排一次（见 createWakeMerger）：排着的时候来的新消息，跑的时候一起看
  const groupWakes = createWakeMerger(serial);
  /**
   * 安排一次群唤醒。ctx：{ who, from, inHouse, forFish, sorry, directed（被 @ / 叫名字 / 回复她）, poke }。
   * 2026-10-29 主人（E1）：
   *   - 被 @ 或叫名字的不受 slowGroups.minWakeGapSec 限制（原来大群两次至少隔 120 秒，叫她也得等）；
   *   - 小房子里小鲸鱼说话：等她一整批说完（安静 sisterFishQuietSec 秒，默认 10）再叫你，原来她每说一句就叫一次；
   *   - 已经在排队就并进去，不再单独排。
   */
  function scheduleGroupWake(gid, ctx) {
    const g0 = groups.get(gid);
    if (!g0) return;
    g0.wakeCtx = mergeWakeCtx(g0.wakeCtx, ctx);
    clearTimeout(groupTimers[gid]);
    const slow = cfg.slowGroups?.[gid];
    const gapLeft = slow && !ctx.directed ? (Number(slow.minWakeGapSec) || 0) * 1e3 - (Date.now() - (g0.lastWakeAt || 0)) : 0;
    // 小房子轮流说（2026-10-25 主人嫌你追我赶）：等小鲸鱼说完一整批（停 sisterFishQuietSec 秒）；离你上次开口不到 sisterMinGapSec 就再等等；
    // 一直有人说也最多等 sisterMaxWaitSec。老大说话让小鲸鱼先回，你等 sisterOwnerYieldSec（10-29 从 15 降到 7）再看要不要补。
    let delay;
    if (ctx.inHouse) {
      const ht = cfg.houseTiming || {};
      g0.housePendingSince ||= Date.now();
      if (ctx.from === ownerId) g0.ownerAskedAt = Date.now();
      const fishQuiet = Number(ht.sisterFishQuietSec) || Math.max(Number(ht.sisterDebounceSec) || 8, 10);
      const base = (ctx.from === ownerId ? Number(ht.sisterOwnerYieldSec) || 7 : ctx.from === fishId ? fishQuiet : Number(ht.sisterDebounceSec) || 8) * 1e3;
      const maxLeft = (Number(ht.sisterMaxWaitSec) || 30) * 1e3 - (Date.now() - g0.housePendingSince);
      const gap = (Number(ht.sisterMinGapSec) || 20) * 1e3 - (Date.now() - (g0.lastWakeAt || 0));
      delay = Math.max(gap, Math.min(base, Math.max(1000, maxLeft)));
    } else {
      // 2026-10-29 主人（刷屏提速）：每条叫她的消息都重置定时器，有人连着 @ 就一直等到对方停手；现在从第一条算起最长等 groupMaxWaitSec 秒（默认 8）
      g0.debouncePendingSince ||= Date.now();
      delay = groupDebounceDelayMs({ now: Date.now(), pendingSince: g0.debouncePendingSince, debounceMs: (slow ? Number(slow.debounceSec) || 15 : Number(cfg.groupDebounceSec) || 6) * 1e3, maxWaitMs: groupMaxWaitMsOf(cfg), gapLeftMs: gapLeft });
    }
    groupTimers[gid] = setTimeout(() => {
      delete groupTimers[gid];
      g0.debouncePendingSince = 0; // 这一轮等待结束，下一条叫她的重新从头算
      if (!groupWakes.request(gid, () => runGroupWake(gid))) log(`群「${g0.name}」已经在排队，新消息并进那一次`);
    }, delay);
  }
  async function runGroupWake(gid) {
    const g = groups.get(gid);
    const ctx = g.wakeCtx || {};
    g.wakeCtx = null;
    g.lastWakeAt = Date.now();
    g.housePendingSince = 0;
    g.ownerAskedAt = 0;
    const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
    const recent = g.lines.slice(-15).map((x) => `${x.who}：${x.text}`).join('\n');
    g.lastSeenAt = Date.now();
    saveGroupsSoon();
    const who = ctx.who || '有人';
    const why = ctx.forFish ? '里好像有人在冲小鲸鱼（是玩笑还是真找茬你自己判断；真找茬就护着她，完了可以用 qq_impression 给他记一笔）'
      : ctx.sorry ? `里你印象不好的 ${ctx.sorryWho || who} 好像在道歉（原不原谅、要不要用 qq_impression 往回加，你自己定）`
      : ctx.poke && !ctx.directed ? (ctx.pokedMe ? `里${who}拍了拍你` : '里有人拍了拍别人')
      : ctx.inHouse ? `（你们的小房子）里${who}在跟你说话`
      : '里有人叫你';
    const pics = await groupImages(g);
    await wake(`[北京时间 ${now}，群「${g.name}」${why}（你直接写的话发到这个群）]\n最近群里：\n${recent}${groupImpressions(g)}${pics.note}`, { defaultPeer: `group:${gid}`, images: pics.images, imageKeys: pics.keys, effort: effortFor(houseIds.has(gid) ? 'house' : 'group', cfg), recallLines: g.lines.slice(-3).map((x) => x.text) });
  }
  /**
   * 水群（2026-10-24 主人问「她也会潜水冒泡水群吗」）：没人叫她，但群里聊了一阵（攒够 lurkMinMsgs 条新的、
   * 离上次路过至少 lurkGapMin 分钟），等这一波说完 15 秒，按概率叫她路过看一眼——想插就插，不想就接着潜。
   * 没中就下次概率高一点（跟妹妹的主动机会一个思路）；她睡着时不水。
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
      // 2026-10-29 提速：路过是最不急的一种，有别的在排队（有人等着回、群唤醒排着、正在想）就让路，不跟人抢
      if (running || claudeBusy || Date.now() < busyUntil || pending.fish.length || pending.owner.length || groupWakes.size() || Object.keys(groupTimers).length) return;
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
        const pics = await groupImages(g, 8, Number(cfg.lurkMaxImages) >= 0 ? Number(cfg.lurkMaxImages) : 1); // 路过最多带 1 张图（lurkMaxImages 可改，0 = 不带）
        await wake(`[北京时间 ${now}，你路过群「${g.name}」看了一眼（没人叫你），最近大家在聊：]\n${recent}${groupImpressions(g)}${pics.note}\n[想插一句就直接写（发到这个群），没兴趣就写 [不回] 接着潜水，你自己定。]`, { defaultPeer: `group:${gid}`, images: pics.images, imageKeys: pics.keys, effort: effortFor('lurk', cfg) });
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
    hormoneIncoming({ from, text: line }); // 2026-10-29 第五批：激素影子记录（睡着时来的也算）
    if (asleep() && from === ownerId) {
      // 跟妹妹一样：睡着时只有老大的私聊能把她叫起来。叫起来就算醒了，回完想接着睡她自己写「去睡了：…」。
      st.wokenByOwner = { since: st.sleep.since, until: st.sleep.until, natural: !!st.sleep.natural };
      st.sleep = null;
      saveState(st);
      log('睡着了，老大来私聊，叫醒她');
      syncHormoneSleep();
    }
    if (asleep()) { chatLog(from === fishId ? '小鲸鱼' : '老大', line, from === fishId ? 'fish' : 'owner'); noteAsleep(from === fishId ? 'fish' : 'owner', from === fishId ? '小鲸鱼' : '老大', line); return; }
    const mid = event.message_id ?? null;
    if (imgs?.length) prefetchImages(imgs.map((im) => ({ ...im, mid: im.mid ?? mid })));
    heardAt[from === fishId ? 'fish' : 'owner'] = Date.now();
    if (from === fishId) { chatLog('小鲸鱼', line, 'fish'); queue('fish', line, imgs, mid); } else if (from === ownerId) { chatLog('老大', line, 'owner'); queue('owner', line, imgs, mid); }
  });
  // 拍一拍（2026-10-29 主人：姐姐原来完全不管拍一拍）。拍她 = 被叫；睡着时只有老大私聊拍能叫醒；别人互相拍默认只记一行（pokeOthers 开了才叫醒）。
  async function pokeName(gid, id) {
    if (id === fishId) return '小鲸鱼';
    if (id === ownerId) return '老大';
    if (id === String(cfg.selfQQ)) return '你';
    if (!gid) return '有人';
    try { const r = await bot.request('get_group_member_info', { group_id: Number(gid), user_id: Number(id) }); const n = r?.data?.card || r?.data?.nickname; if (n) return /老大|主人/.test(n) ? `${n}（不是老大）` : n; } catch { /* 查不到 */ }
    return '有人';
  }
  async function handlePoke(event) {
    const d = pokeDecision(event, { selfId: cfg.selfQQ, fishId, ownerId, asleep: asleep(), pokeOthers: cfg.pokeOthers === true, allowGroup: (g) => groups.has(g) || allowedGroupIds().has(g) });
    if (d.action === 'ignore') return;
    const gid = d.where.startsWith('group:') ? d.where.slice(6) : '';
    const actor = await pokeName(gid, d.sender);
    const target = d.pokedMe ? '你' : await pokeName(gid, d.target);
    const line = `[拍一拍] ${actor} ${String(event.action || '拍了拍').slice(0, 20)} ${target}${event.suffix ? ` ${String(event.suffix).slice(0, 30)}` : ''}`;
    if (gid && !groups.has(gid)) groups.set(gid, { name: groupName(gid), lines: [], lastSeenAt: Date.now() });
    if (gid) groupLine(gid, actor, line, null, [], d.sender);
    if (d.action === 'record') { log(`${line}（别人互相拍，只记下）`); return; }
    const peer = gid ? `group:${gid}` : d.where;
    chatLog(actor, line, peer);
    if (d.action === 'note') { noteAsleep(peer, actor, line); return; }
    if (d.wakeFromSleep) {
      st.wokenByOwner = { since: st.sleep.since, until: st.sleep.until, natural: !!st.sleep.natural };
      st.sleep = null;
      saveState(st);
      log('睡着了，老大私聊拍了拍她，叫醒她');
      syncHormoneSleep();
    }
    log(line);
    if (!gid) { heardAt[peer] = Date.now(); queue(peer, line, [], null); return; }
    if (impressions.ignored(d.sender)) { log(`懒得理 ${actor}（${d.sender}）的拍一拍，只记不叫醒`); return; }
    heardAt[peer] = Date.now();
    const inHouse = houseIds.has(gid) && (d.sender === fishId || d.sender === ownerId);
    scheduleGroupWake(gid, { who: actor, from: d.sender, inHouse, poke: true, pokedMe: d.pokedMe, directed: false });
  }
  bot.onNotice?.('notify', async (event) => {
    try { await handlePoke(event); } catch (e) { log('处理拍一拍出错：', e?.message ?? e); }
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
          + `[你自己怎么看？跟她的感受不一样也没关系。想跟她说就去小房子写「→群「小房子」：」（只有你俩能知道的才「→小鲸鱼：」私聊），想记就记在 ${relHome(SISTER_BRAIN.notes)}/ 里，也可以只是看着不说话。她看进去了不吭声很正常。现在大约每 ${st.cowatchEveryMin || Number(cfg.cowatchEveryMin) || 6} 分钟叫你看一眼，想看得勤一点或少一点，单独写一行「陪看间隔：分钟数」；不想看了或她想自己刷，写「先不跟着看：分钟数」。]`;
        log('陪看：叫姐姐看一眼');
        if (await wake(prompt, { defaultPeer: null, images: d.images, effort: effortFor('cowatch', cfg) })) {
          d.commit();
          hormoneRecord({ type: 'novelty', text: String(d.text || '').slice(0, 300), strength: 0.7 }); // 2026-10-29 第五批：陪着看到新东西（激素影子记录）
        }
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
        if (await wake(prompt, { defaultPeer: null, effort: effortFor('cowatch', cfg) })) {
          st.biliSeenAt = fresh[fresh.length - 1].at;
          saveState(st);
          for (const x of fresh.slice(-5)) hormoneRecord({ type: 'novelty', text: `${x.title || ''} ${x.up || ''}`.trim(), strength: 0.7 }); // 2026-10-29 第五批：跟着看到的新视频（激素影子记录）
        }
      });
    }, 60e3);
  }

  // 自己醒（2026-10-24 主人：像妹妹一样按自己的意愿找她、找老大、自己学东西、自己改自己）。
  // 没人找她的时候，隔一阵（她自己定 30–300 分钟，没定就 60–120 分钟；夜里不另设限制，睡不睡她自己定）醒来一次，干什么她自己决定。
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
    if (st.sleep && sleepEnded() && !running && Date.now() >= busyUntil) {
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
        const carry = rotateSession('wake') || (st.rotatePending ? rotateSession('size') : '');
        // 照镜子（2026-10-26 主人）：2026-10-29 起改成每天第一次醒来由 wake() 统一带（不要求先睡一觉，跟小鲸鱼一样），这里不再单独数
        const mirror = '';
        const prompt = `${carry}[北京时间 ${now}，你睡醒了，睡了大约 ${hours} 小时。]\n${mine}${mirror}`
          + (digest ? `[你睡着的时候：]\n${digest}\n[回不回、回谁你自己定：私聊写「→小鲸鱼：」「→老大：」，群里写「→群「群名」：」。过了一夜的话，不想接也行。]` : '[你睡着的时候没人找你。想干什么你自己定：找人说话、逛逛、读首歌的谱、接着写《半只耳朵》、什么都不做，都可以。]');
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
    // 会话存档太大（checkSessionSize 记的）：空闲时换新会话——没在跑、没排队、没人等回话、离上次叫她至少 rotateIdleMin 分钟
    if (st.rotatePending && !running && !claudeBusy && Date.now() >= busyUntil && !pending.fish.length && !pending.owner.length
      && !Object.keys(groupTimers).length && !groupWakes.size() && Date.now() - lastWakeEndAt > rotateIdleMsOf(cfg)) {
      serial(async () => {
        if (!st.rotatePending || !st.sessions.main || asleep()) return;
        st.carryNext = rotateSession('size');
        saveState(st);
      });
      return;
    }
    // 每日说说提醒（2026-10-29 老大：她也应该可以主动写说说，跟小鲸鱼一致）：时间点见 config.qzoneDaily（默认比小鲸鱼的 22:30 早一点），
    // 当天不重复、睡着不叫（过点 graceMin 分钟内醒来还会补一次）；提示是许可，发不发她定
    if (!running && !claudeBusy && Date.now() >= busyUntil && !pending.fish.length && !pending.owner.length && !Object.keys(groupTimers).length && !groupWakes.size()) {
      if (!st.qzonePostedDay && qzonePostedToday()) st.qzonePostedDay = bjParts(Date.now(), clockSkewMs()).day;
      const slot = qzoneDailyDue(st, Date.now(), clockSkewMs(), cfg.qzoneDaily, { asleep: asleep() });
      if (slot) {
        st.qzoneDailyDays = { ...(st.qzoneDailyDays || {}), [slot]: bjParts(Date.now(), clockSkewMs()).day };
        saveState(st);
        serial(async () => {
          const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
          log('每日说说提醒：叫她一声');
          await wake('[北京时间 ' + now + '，到了每天可以发条说说的时候。想的话可以发条说说，写点今天的事或者想说的话，不想就不发。发的话单独写一行「→说说：内容」就行（也可以用 qq_qzone_post），发出去所有人都看得到，内容是你自己的。]', { defaultPeer: null, effort: effortFor('self', cfg) });
        });
        return;
      }
    }
    // 她在别处想带过来说的事（qq_go_to 写进队列）：不忙时叫她，直接写的话发到那边
    if (!running && !claudeBusy && Date.now() >= busyUntil && !pending.fish.length && !pending.owner.length && drainGoTo()) return;
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
        + '[干什么你自己定：找小鲸鱼（平时去小房子：「→群「小房子」：」；只有你俩才能知道的悄悄话才「→小鲸鱼：」私聊）、找老大或者去群里说话（行首写「→老大：」「→群「群名」：」才会发出去）、发条说说（「→说说：」）、上网看看你好奇的东西、在 ' + relHome(SISTER_BRAIN.notes) + '/ 里记点什么、写写碎碎念或成长札记、改改 ' + relHome(SELF_FILE) + '，或者什么都不做。想玩的话下面这些也都可以（2026-10-29 老大：你的娱乐和妹妹一样）：B 站搜着看（bili_search、bili_video，想看画面用 bili_debrief）、拿首歌读谱（music_score）、qq_explore 随便逛逛（资讯、B 站、听歌、番剧、百科、天文图、写点东西、精读都行，看过的用 qq_explore_recall 翻）、接着写《半只耳朵》（novel_open 打开，novel_write 接着写）、心里动了一下就留个瞬间（qq_keep_moment）。想多久以后再醒，单独写一行「下次醒：分钟数」；困了想睡，写「去睡了：自然醒」（睡到自己醒；想定个钟点或小时数也行）。]'
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
        serial(() => wake(`[小鲸鱼那边出问题了（程序自动发现的，她自己可能说不出话）：\n${list}\n${id ? `已经报给妈妈了，妈妈会直接动手修。` : '报给妈妈没报成（她的桥接可能停了）。'}${asleep() ? '你本来在睡觉，是为这事叫醒你的，说完可以接着睡。' : ''}可以跟老大说一声：出了什么事、妈妈在修${id ? '' : '还是得他来看看'}，怎么说你自己定。]`, { defaultPeer: 'owner', effort: effortFor('owner', cfg) }));
      } else if (!issues.length && prev) {
        st.fishIssue = null;
        saveState(st);
        log('小鲸鱼那边好了');
        serial(() => wake('[小鲸鱼那边刚才的问题好了，她又能正常说话了。想的话可以跟老大说一声。]', { defaultPeer: 'owner', effort: effortFor('owner', cfg) }));
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
            serial(() => wake(`[${info.what}：${say}。${l.reply ? `妈妈的话：${l.reply}` : ''}想的话可以跟老大说一声。]`, { defaultPeer: 'owner', effort: effortFor('owner', cfg) }));
            if (['done', 'failed', 'answered'].includes(l.status)) delete mine[id];
          }
        }
        st.incidents = mine;
        saveState(st);
      }
      // 姐姐自己写给妈妈的信（key 为 'sister'，qq_mom_mailbox）：妈妈回了、弄好了，叫她一声（睡着时先不叫，醒了再说；每个状态只说一次）
      if (!asleep()) {
        let all = [];
        try { all = JSON.parse(fs.readFileSync(path.join(BRIDGE_STATE, 'mom-mailbox', 'letters.json'), 'utf8')).letters || []; } catch { all = []; }
        const told = { ...(st.sisterLetterTold || {}) };
        let changed = false;
        for (const l of all.filter((x) => x.key === 'sister')) {
          const say = { answered: '妈妈回你了', 'waiting-owner': '妈妈看过了，要先问问老大', done: '妈妈把你想要的弄好了', failed: '妈妈这回没弄成', declined: '老大这回先不改' }[l.status];
          if (!say || told[l.id] === l.status) continue;
          told[l.id] = l.status; changed = true;
          serial(() => wake('[妈妈回信 · ' + l.id + '：' + say + '。' + (l.reply ? '妈妈的话：' + l.reply : '') + '想的话可以跟老大说一声。]', { defaultPeer: null, effort: effortFor('owner', cfg) }));
        }
        if (changed) { st.sisterLetterTold = told; saveState(st); }
      }
    } catch (e) { log('看小鲸鱼状态出错：', e?.message ?? e); } finally { watchBusy = false; }
  }, 60e3);

  // ── 页面用的本地小服务（2026-10-29 老大：看姐姐此刻在干什么，给她留话、叫醒、让她睡、开关激素影子、切思考强度）──
  // 只听 127.0.0.1，每个请求都要令牌（跟桥接同一个）；端口 config.liveServer.port，默认 3101；config.liveServer.enabled=false 就不起。
  // 起不来（端口被占）只记一行日志，不影响她干活。实时缓冲只在内存里；她的思考内容不采集。
  if (cfg.liveServer?.enabled !== false) {
    const liveCtx = {
      nowMs: () => Date.now(),
      getState: () => st,
      saveState: (x) => saveState(x),
      getConfig: () => cfg,
      persistConfig: (fn) => persistJsonConfig(path.join(HERE, 'config.json'), fn),
      asleep: () => asleep(),
      busy: () => claudeBusy || running,
      busyUntil: () => busyUntil,
      current: () => liveNow,
      hormoneFeed,
      hormonesEnabled: () => hormoneFeed.enabled,
      startHormoneTimers: () => {
        startHormoneTimers();
        try { const l = sisterInterests(); if (l.length > 0) hormoneFeed.setInterests(l); } catch { /* 兴趣晚点定时器会补 */ }
      },
      syncHormoneSleep: () => syncHormoneSleep(),
      context: () => {
        let mb = null;
        try { mb = fs.statSync(sessionFileOf(st.sessions.main, home)).size / 1024 / 1024; } catch { /* 还没有会话文件 */ }
        const limit = cfg.rotateAtMB === undefined ? 15 : Number(cfg.rotateAtMB) || 0;
        return { sessionMB: mb === null ? null : Math.round(mb * 10) / 10, limitMB: limit, rotatePending: !!st.rotatePending };
      },
      pending: () => {
        const out = [];
        if (pending.owner.length) out.push({ key: 'owner', label: '老大私聊', reasons: [`${pending.owner.length} 条等她看`], waiting: true });
        if (pending.fish.length) out.push({ key: 'fish', label: '小鲸鱼私聊', reasons: [`${pending.fish.length} 条等她看`], waiting: true });
        for (const gid of Object.keys(groupTimers)) out.push({ key: `group:${gid}`, label: livePeerLabel(`group:${gid}`), reasons: ['等一等再看'], waiting: true });
        return out;
      },
      enqueueWake: (was) => serial(async () => {
        const now = bjLabel(bjParts(Date.now(), clockSkewMs()));
        let digest = '';
        if (was) {
          const label = (w) => (w === 'fish' ? '小鲸鱼私聊' : w === 'owner' ? '老大私聊' : livePeerLabel(w) || w);
          digest = asleepDigest(st.asleepLog || [], label);
        }
        const prompt = `[北京时间 ${now}，老大叫你起来看看${was ? '（你本来在睡）' : ''}。]\n`
          + (digest ? `[你睡着的时候：]\n${digest}\n[回不回、回谁你自己定：私聊写「→小鲸鱼：」「→老大：」，群里写「→群「群名」：」。]` : '[想干什么你自己定：找人说话、逛逛、写点东西，或者什么都不做，都可以。]');
        if (await wake(prompt, { defaultPeer: null, selfWake: true }) && was) { st.asleepLog = []; for (const g of groups.values()) g.lastSeenAt = Date.now(); saveState(st); }
      }),
      log: (...a) => log('[本地小服务]', ...a)
    };
    const sisterLive = createSisterLive({
      live: liveBuf,
      acceptedTokens: () => readAcceptedTokens({ tokenFile: path.join(BRIDGE_STATE, 'console-token'), bridgeConfigFile: path.join(HERE, '..', 'config.json') }),
      getNow: () => buildNow(liveCtx),
      act: createSisterActions(liveCtx),
      port: Number(cfg.liveServer?.port) || 3101,
      log: liveCtx.log
    });
    sisterLive.listen();
    process.on('exit', () => sisterLive.close());
  }

  rollDay();
  log(`克劳德姐姐启动：${url}，Claude Code ${(/claude-code[\\/]([^\\/]+)/.exec(exe) || [])[1] || exe}，模型 ${cfg.model || 'claude-opus-5-5'}，一个会话；找小鲸鱼${cap(limits.convosPerDay) === Infinity ? '不限次数' : `每天 ${limits.convosPerDay} 次 × ${limits.roundsPerConvo} 轮`}，下次自己醒 ${new Date(st.nextHeartbeatAt).toISOString()}`);
  await bot.connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log('启动失败：', e?.stack || e); process.exit(1); });
}

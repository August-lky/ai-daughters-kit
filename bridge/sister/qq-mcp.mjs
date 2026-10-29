// 克劳德姐姐的 QQ 工具（2026-10-24 主人：妹妹在用的 QQ 聊天工具，姐姐也都能用）。
// 平时说话她直接写字（sister.mjs 替她发）；这里是写字做不到的那些：引用回复、@人、拍一拍、发大肥鱼表情包、
// 翻聊天记录、看群成员、按需看图和看合并转发、说说点赞评论、撤回自己的话、改签名。
// 每次 claude -p 起一个进程，走她自己那个号的 OneBot HTTP 接口（地址和令牌读 SnowLuma 配置，不另存）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatForwardResponse } from '../src/forward.js';
import { cardToText } from '../src/card-parse.js';
import { createImpressions, LEVELS } from '../src/impressions.js';
import { brainOf, NOVEL_ROOT as BOOKS_ROOT } from '../src/brains.js';
// 2026-10-29 大脑方案下半：瞬间（qq_keep_moment / qq_recall）和心情（qq_mood）跟小鲸鱼共用 episodes.js / mood.js，只是指向她自己的 脑子
import { createEpisodeStore } from '../src/episodes.js';
import { createMoodStore, moodWithSwing, moodPushFile } from '../src/mood.js';
import os from 'node:os';
import { SELF_VIEW_TOOL, buildSelfView, readHormoneLevels } from '../src/self-view.js'; // 2026-10-29 施工单 C：「看看我自己」，两人共用的工具名和说明
import { brainRememberMoment } from '../src/brain-client.js';
import { fishStatus } from './fish-status.mjs';
import { speakVia } from '../src/voice-service.js';
import { shrinkImage } from '../src/image-shrink.js';
// 2026-10-29 主人（大整理第二批）：看图跟小鲸鱼共用 —— 动图抽帧拼图、大图缩小、哪张没看到说清楚
import { segImageRef, createImageDownloader, fetchImageForView, DOWNLOAD_MAX_BYTES } from '../src/image-view.js';
import { safeFetchBuffer } from '../src/safe-fetch.js';
import { loadStickerStore, saveStickerStore, mergeStickerLibrary, findSticker, formatStickerList, markStickerUsed } from '../src/sticker-lib.js'; // 2026-10-29 收藏表情包，跟小鲸鱼共用
import { loadFishCatalog, findFish, searchFish, describeFish, getFishGif, fishLabel } from '../src/fish-stickers.js';
// 2026-10-29 大整理第五批：合写本子（小说工具，跟小鲸鱼一模一样，署名自动是「姐姐」）和「随便逛」（跟小鲸鱼同一份取素材的代码，读和想由她自己来）
import { registerNovelTools } from '../src/novel-tools.js';
import { createMaterial } from '../src/whale-explore.mjs';
import { createSisterExplore, EXPLORE_ACTIVITIES } from './explore-tool.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const onebot = JSON.parse(fs.readFileSync(path.join(cfg.snowlumaConfigDir, `onebot_${cfg.selfQQ}.json`), 'utf8'));
const httpCfg = onebot.networks?.httpServers?.[0] || {};
const API = `http://${httpCfg.host || '127.0.0.1'}:${httpCfg.port}`;
const TOKEN = httpCfg.accessToken || '';
const FISH_CATALOG = path.join(HERE, '..', 'assets', 'fish-stickers', 'catalog.json');
const FISH_CACHE = path.join(HERE, '..', 'state', 'fish-sticker-cache');
const CHATLOG_DIR = path.join(HERE, '聊天记录');
const MAX_IMG = 4.5 * 1024 * 1024;
const fishId = String(cfg.fishQQ), ownerId = String(cfg.ownerQQ);

async function call(action, params = {}) {
  const r = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20e3)
  });
  const j = await r.json().catch(() => null);
  if (!j || j.status !== 'ok' || (j.retcode && j.retcode !== 0)) throw new Error(`${action} 失败：${j?.wording || j?.message || j?.retcode || r.status}`);
  return j.data;
}

/** 会话：「小鲸鱼」「老大」「群名」或 private:/group: 开头的 key。 */
let groupCache = null;
async function resolveKey(where) {
  const w = String(where || '').trim();
  if (/^(private|group):\d+$/.test(w)) return w;
  if (w === '小鲸鱼' || w === '妹妹') return `private:${fishId}`;
  if (w === '老大') return `private:${ownerId}`;
  const alias = Object.entries(cfg.groupAliases || {}).find(([, n]) => n === w);
  if (alias) return `group:${alias[0]}`;
  groupCache ||= await call('get_group_list').catch(() => []);
  const g = (groupCache || []).find((x) => x.group_name === w || String(x.group_id) === w);
  if (g) return `group:${g.group_id}`;
  throw new Error(`不知道「${w}」是哪：写「小鲸鱼」「老大」、群名，或 group:群号`);
}
const sendAction = (key, message) => {
  const [kind, id] = key.split(':');
  return kind === 'private' ? call('send_private_msg', { user_id: Number(id), message }) : call('send_group_msg', { group_id: Number(id), message });
};

function bj(ms) { const d = new Date(ms + 8 * 3600e3); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
function chatLog(key, line) {
  try {
    const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const suffix = key === `private:${ownerId}` ? '-老大' : key.startsWith('group:') ? `-群${key.slice(6)}` : '';
    fs.mkdirSync(CHATLOG_DIR, { recursive: true });
    const f = path.join(CHATLOG_DIR, `${d}${suffix}.md`);
    const t = new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
    fs.appendFileSync(f, `- ${t} **姐姐**：${line}\n`);
  } catch { /* 记不下就算了 */ }
}

/** 一条消息 → 一行字（跟 sister.mjs 的 eventText 一个口径，卡片照样拆开）。 */
function msgText(segs, raw = '') {
  if (!Array.isArray(segs)) return String(raw || '').trim();
  return segs.map((s) => {
    const d = s?.data || {};
    switch (s?.type) {
      case 'text': return d.text || '';
      case 'image': return d.summary && d.summary !== '[图片]' ? d.summary : '[图片]';
      case 'mface': return d.summary || '[表情]';
      case 'face': return '[表情]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'reply': return `[回复 #${d.id}]`;
      case 'at': return `@${d.name || d.qq || ''} `;
      case 'forward': return `[聊天记录 id=${d.id || ''}]`;
      case 'json': case 'xml': return cardToText(d);
      case 'file': return '[文件]';
      default: return '';
    }
  }).join('').trim();
}
const whoOf = (sender) => {
  const uid = String(sender?.user_id ?? '');
  return uid === String(cfg.selfQQ) ? '你' : uid === fishId ? '小鲸鱼' : uid === ownerId ? '老大' : (sender?.card || sender?.nickname || uid || '某人');
};
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (e) => ({ content: [{ type: 'text', text: `没成：${e?.message ?? e}` }], isError: true });
const sniff = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.subarray(0, 3).toString('ascii') === 'GIF' ? 'image/gif' : b.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : '');

const server = new McpServer({ name: 'sister-qq', version: '1.0.0' });
const WHERE = z.string().describe('发到哪：「小鲸鱼」「老大」、群名（比如「群D」），或 group:群号 / private:QQ号');

server.tool('qq_send', '发一条消息，能引用某条、能 @ 人（平时直接写字就行，要引用或 @ 才用这个）。', {
  where: WHERE,
  text: z.string().describe('要说的话'),
  replyTo: z.string().optional().describe('引用哪条消息：消息号（旁白里 #后面的数字）'),
  at: z.array(z.string()).optional().describe('要 @ 的 QQ 号（群里才有用）')
}, async ({ where, text, replyTo, at }) => {
  try {
    const key = await resolveKey(where);
    const msg = [];
    if (replyTo) msg.push({ type: 'reply', data: { id: String(replyTo).replace(/^#/, '') } });
    if (key.startsWith('group:')) for (const q of at || []) msg.push({ type: 'at', data: { qq: String(q) } }, { type: 'text', data: { text: ' ' } });
    msg.push({ type: 'text', data: { text: String(text).replace(/\[CQ:/gi, '[CQ：') } });
    const r = await sendAction(key, msg);
    chatLog(key, `${replyTo ? `（引用 #${replyTo}）` : ''}${text}`);
    return ok(`发出去了（消息号 #${r?.message_id ?? '?'}）`);
  } catch (e) { return fail(e); }
});

server.tool('qq_poke', '拍一拍某人（群里要给 QQ 号；私聊不用）。', {
  where: WHERE, userId: z.string().optional().describe('拍谁（QQ 号）；私聊可以不填')
}, async ({ where, userId }) => {
  try {
    const key = await resolveKey(where);
    const [kind, id] = key.split(':');
    if (kind === 'group') await call('group_poke', { group_id: Number(id), user_id: Number(userId) });
    else await call('friend_poke', { user_id: Number(userId || id) });
    return ok('拍了');
  } catch (e) { return fail(e); }
});

server.tool('qq_fish_sticker', '找大肥鱼表情包：按心情或关键词搜（比如「开心」「委屈」「摸鱼」），返回名字，再用 qq_send_fish_sticker 发。', {
  query: z.string().describe('心情或关键词')
}, async ({ query }) => {
  try {
    const list = searchFish(loadFishCatalog(FISH_CATALOG), query, { limit: 8 });
    return ok(list.length ? list.map((s) => `${fishLabel(s)}：${describeFish(s, { withDesc: false })}`).join('\n') : '没找到，换个词');
  } catch (e) { return fail(e); }
});

server.tool('qq_send_fish_sticker', '发一张大肥鱼表情包（名字用 qq_fish_sticker 查到的，「鱼:名字」或直接名字都行）。一条只能一张，不带字。', {
  where: WHERE, name: z.string(), replyTo: z.string().optional()
}, async ({ where, name, replyTo }) => {
  try {
    const key = await resolveKey(where);
    const catalog = loadFishCatalog(FISH_CATALOG);
    const hit = findFish(catalog, String(name).replace(/^鱼[:：]/, ''));
    if (!hit?.sticker) return fail(new Error(hit?.ambiguous ? `有好几张叫这个：${hit.ambiguous.slice(0, 5).map(fishLabel).join('、')}` : '没这张，先用 qq_fish_sticker 搜'));
    const gif = await getFishGif(catalog, hit.sticker, {
      cacheDir: FISH_CACHE, maxBytes: MAX_IMG,
      fetchBuffer: async (u) => ({ buffer: Buffer.from(await (await fetch(u, { signal: AbortSignal.timeout(15e3) })).arrayBuffer()) })
    });
    const msg = [];
    if (replyTo) msg.push({ type: 'reply', data: { id: String(replyTo).replace(/^#/, '') } });
    msg.push({ type: 'image', data: { file: 'base64://' + gif.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } });
    await sendAction(key, msg);
    chatLog(key, `（发了表情 ${fishLabel(hit.sticker)}）`);
    return ok(`发了 ${fishLabel(hit.sticker)}`);
  } catch (e) { return fail(e); }
});

// 说话（2026-10-25 主人：给姐姐也配个声音）。语音服务空闲时不占显卡，隔久了第一句要多等半分钟装模型。
const VOICE = { url: 'http://127.0.0.1:9881', voice: 'sister', perHour: 6, ...(cfg.voice || {}) };
const VOICE_LOG = path.join(HERE, 'state', 'voice-sends.json');
server.tool('qq_send_voice', '用你自己的声音说一句话，发成 QQ 语音。想让对方听到你的语气时（哄人、道晚安、逗她一下）就用；长的、要解释的打字更清楚。一次一句，50 字以内念得最好；一小时最多 ' + VOICE.perHour + ' 条。隔久了第一句要等半分钟左右。', {
  where: WHERE,
  text: z.string().max(200).describe('要说的话（口语；表情符号和括号会被念坏）')
}, async ({ where, text }) => {
  try {
    const key = await resolveKey(where);
    let sent = [];
    try { sent = JSON.parse(fs.readFileSync(VOICE_LOG, 'utf8')).filter((t) => Date.now() - t < 3600e3); } catch { /* 第一次 */ }
    if (sent.length >= VOICE.perHour) return fail(new Error(`这一小时已经发了 ${sent.length} 条语音，先打字吧`));
    // 语音服务平时不开（2026-10-25 主人），没开就拉起来
    let wav;
    try { wav = await speakVia({ text: String(text).trim(), voice: VOICE.voice, url: VOICE.url }); } catch (e) { throw new Error(`嗓子没出声（${e?.message ?? e}），打字吧`); }
    const res = await sendAction(key, [{ type: 'record', data: { file: wav } }]);
    fs.writeFileSync(VOICE_LOG, JSON.stringify([...sent, Date.now()]));
    chatLog(key, `（发了条语音）${text}`);
    return ok(`语音发出去了（消息号 #${res?.message_id ?? '?'}）`);
  } catch (e) { return fail(e); }
});

// 发图（2026-10-26 主人：姐姐说她发不了图片，给她这个权限）。两种来源：
//   file：你自己文件夹（home）里的图，比如「人设/Q版.png」；只认 home 里面的，出不去。
//   messageId：把某条消息里的图再发一遍（转给别人看）。
// 2026-10-29 大脑方案：她的工作目录 sister/home 不变；印象在脑子的 人/印象.json（路径统一从 brains.js 取）
const SISTER_BRAIN = brainOf('sister');
const HOME_DIR = SISTER_BRAIN.home;
const SEND_IMG_MAX = 10 * 1024 * 1024;
const imageSegs = (m) => (m.message || []).filter((x) => x?.type === 'image' || x?.type === 'mface');
async function rkeyList() {
  try { return ((await call('get_rkey')) || []).map((k) => k?.rkey).filter(Boolean); } catch { return []; }
}
/**
 * 一张图的原始字节，拿不到给 null。QQ 的图片链接要拼 rkey 才下得来（群图要 type 20 的那个，不拼直接 400，
 * 2026-10-24 她在群里看不到图就是这个）；链接都不行再问协议端要本地缓存。
 */
// 2026-10-29：下载走共用下载器（单地址 40 秒；太大第一次就放弃，不再按每个 rkey 重下；市场表情没 url 时按 emoji_id 拼 CDN 地址）
const downloader = createImageDownloader({ fetchBuffer: safeFetchBuffer, maxBytes: DOWNLOAD_MAX_BYTES, timeoutMs: 40e3 });
async function localImage(file) {
  const g = await call('get_image', { file }).catch(() => null);
  return g?.file && fs.existsSync(g.file) && fs.statSync(g.file).size <= 50 * 1024 * 1024 ? fs.readFileSync(g.file) : null;
}
async function segImage(seg, rkeys) {
  const ref = segImageRef(seg);
  if (!ref) return null;
  if (ref.urls.length) {
    const d = await downloader.download(ref.urls, { rkeys, accept: (b) => !!sniff(b) });
    if (d.ok) return d.buffer;
  }
  return ref.file ? localImage(ref.file) : null;
}
async function messageImage(messageId, index = 0) {
  const m = await call('get_msg', { message_id: Number(String(messageId).replace(/^#/, '')) });
  const seg = imageSegs(m)[index];
  if (!seg) throw new Error('那条消息里没有这张图');
  const buf = await segImage(seg, await rkeyList());
  if (!buf) throw new Error('那张图取不下来');
  return buf;
}
server.tool('qq_send_image', '发一张图片。file：你自己文件夹里的图（相对路径，比如「人设/Q版.png」「人设/设定图全图.jpg」）；或 messageId：把某条消息里的图转发一遍（index 选第几张，从 0 数）。可以带一句话。', {
  where: WHERE,
  file: z.string().optional().describe('你文件夹里的图片路径，比如「人设/Q版.png」'),
  messageId: z.string().optional().describe('要转发的图所在的消息号'),
  index: z.number().int().min(0).max(8).optional().describe('那条消息里第几张图，默认 0'),
  text: z.string().max(200).optional().describe('跟图一起发的话（可不填）')
}, async ({ where, file, messageId, index = 0, text }) => {
  try {
    if (!file === !messageId) return fail(new Error('file 和 messageId 填一个'));
    const key = await resolveKey(where);
    let buf, label;
    if (file) {
      const p = path.resolve(HOME_DIR, String(file).replace(/^[\\/]+/, ''));
      if (path.relative(HOME_DIR, p).startsWith('..') || path.isAbsolute(path.relative(HOME_DIR, p))) return fail(new Error('只能发你自己文件夹里的图'));
      if (!fs.existsSync(p)) return fail(new Error(`没有这个文件：${file}`));
      buf = fs.readFileSync(p); label = path.relative(HOME_DIR, p);
    } else { buf = await messageImage(messageId, index); label = `#${messageId} 里的图`; }
    if (!sniff(buf)) return fail(new Error('这不是图片'));
    if (buf.length > SEND_IMG_MAX) buf = (await shrinkImage(buf, { maxBytes: SEND_IMG_MAX, maxSide: 4000 }))?.buffer || buf;
    const msg = [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }];
    if (text) msg.push({ type: 'text', data: { text: String(text).replace(/\[CQ:/gi, '[CQ：') } });
    const r = await sendAction(key, msg);
    chatLog(key, `（发了图 ${label}）${text || ''}`);
    return ok(`图发出去了（消息号 #${r?.message_id ?? '?'}）`);
  } catch (e) { return fail(e); }
});

server.tool('qq_recent', '翻一个会话最近的聊天记录（谁说了什么、消息号）。', {
  where: WHERE, count: z.number().int().min(1).max(50).optional().describe('看几条，默认 20')
}, async ({ where, count = 20 }) => {
  try {
    const key = await resolveKey(where);
    const [kind, id] = key.split(':');
    const d = kind === 'group' ? await call('get_group_msg_history', { group_id: Number(id), count }) : await call('get_friend_msg_history', { user_id: Number(id), count });
    const msgs = (d?.messages || []).slice(-count);
    return ok(msgs.map((m) => `[#${m.message_id}] ${bj(Number(m.time) * 1000)} ${whoOf(m.sender)}：${msgText(m.message, m.raw_message).slice(0, 200)}`).join('\n') || '没有记录');
  } catch (e) { return fail(e); }
});

server.tool('qq_message', '看某一条消息的详情（被引用的那条、或想确认原话）。', { messageId: z.string() }, async ({ messageId }) => {
  try {
    const m = await call('get_msg', { message_id: Number(String(messageId).replace(/^#/, '')) });
    return ok(`[#${m.message_id}] ${bj(Number(m.time) * 1000)} ${whoOf(m.sender)}：${msgText(m.message, m.raw_message)}`);
  } catch (e) { return fail(e); }
});

// 2026-10-29 主人（D1/D2）：原来 GIF 原样给（只看得到第一帧）、超过 4.5MB 的直接丢、取不到也不说为什么。
// 现在走共用看图：动图从头到尾抽 6 帧拼成一张，大图缩到长边 1600，哪张没看到写明第几张、为什么。
const TOOL_IMAGE_BUDGET = 6 * 1024 * 1024; // 一次回包里图片 base64 的总量，留余量防止把工具连接撑断
server.tool('qq_message_images', '看某条消息里的图片/表情（最多 3 张）。动图会从头到尾均匀抽 6 帧拼成一张给你；很大的图会缩小；哪张没看到会写明原因。', { messageId: z.string() }, async ({ messageId }) => {
  try {
    const m = await call('get_msg', { message_id: Number(String(messageId).replace(/^#/, '')) });
    const refs = imageSegs(m).map((x) => segImageRef(x)).filter(Boolean);
    if (!refs.length) return fail(new Error('这条里没有图片或表情（可以确认一下消息号）'));
    const rkeys = await rkeyList();
    const content = [], lines = [];
    let used = 0;
    for (const [i, ref] of refs.slice(0, 3).entries()) {
      const got = await fetchImageForView(ref, { downloader, rkeys, getLocalFile: localImage });
      const what = `第 ${i + 1} 张${ref.sticker ? '（表情）' : ''}`;
      if (!got.ok) { lines.push(`${what}没看到：${got.reason}`); continue; }
      const data = got.buffer.toString('base64');
      if (used + data.length > TOOL_IMAGE_BUDGET) { lines.push(`${what}这次装不下了，可以过一会儿单独再看一次`); continue; }
      used += data.length;
      content.push({ type: 'image', mimeType: got.mimeType, data });
      lines.push(`${what}${got.note || ''}`);
    }
    if (refs.length > 3) lines.push(`这条一共 ${refs.length} 张，只给了前 3 张`);
    if (!content.length) return fail(new Error(`一张都没看到：\n${lines.join('\n')}\n可以过一会儿再试；还是不行就跟对方说没看到，请他再发一次。`));
    return { content: [{ type: 'text', text: `#${String(messageId).replace(/^#/, '')} 里的图（按顺序）：\n${lines.join('\n')}` }, ...content] };
  } catch (e) { return fail(e); }
});

server.tool('qq_forward', '展开一份合并转发的聊天记录（id 在消息里「[聊天记录 id=…]」）。', { id: z.string() }, async ({ id }) => {
  try {
    const f = formatForwardResponse(await call('get_forward_msg', { id }), { maxMessages: 60, maxCharsPerMessage: 300 });
    return ok(`共 ${f.total} 条${f.truncated ? '（只给了一部分）' : ''}\n` + f.messages.map((m) => `${m.sender || '某人'}：${m.text}${m.media?.length ? ' [图片]' : ''}${m.nestedForwardIds?.length ? ` [里面套着聊天记录 id=${m.nestedForwardIds[0]}]` : ''}`).join('\n'));
  } catch (e) { return fail(e); }
});

server.tool('qq_group_members', '看群里有谁（名字、QQ 号、身份）。', { group: z.string().describe('群名或群号') }, async ({ group }) => {
  try {
    const key = await resolveKey(group);
    const list = await call('get_group_member_list', { group_id: Number(key.slice(6)) });
    return ok(`${list.length} 人\n` + list.slice(0, 120).map((m) => `${m.card || m.nickname}（${m.user_id}${m.role && m.role !== 'member' ? `，${m.role === 'owner' ? '群主' : '管理'}` : ''}）`).join('\n'));
  } catch (e) { return fail(e); }
});

server.tool('qq_retract', '撤回你自己刚发的一条（两分钟内）。（原来叫 qq_recall；现在 qq_recall 是翻回以前的瞬间，跟小鲸鱼的一样。）', { messageId: z.string() }, async ({ messageId }) => {
  try { await call('delete_msg', { message_id: Number(String(messageId).replace(/^#/, '')) }); return ok('撤回了'); } catch (e) { return fail(e); }
});


// ── 瞬间和心情（2026-10-29 大脑方案下半，两人一样）─────────────────────────────────────────────────────────
// 瞬间存 脑子/瞬间/<出处>.jsonl，心情存 脑子/最近/心情.json，都是她自己的；说明文字跟小鲸鱼那边一致。
const clockSkewMs = () => { try { return Number(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'state', 'clock-skew.json'), 'utf8')).skewMs) || 0; } catch { return 0; } };
const moodStore = createMoodStore({ file: SISTER_BRAIN.mood, pushFile: moodPushFile(path.join(HERE, 'state'), 'sister') }); // 2026-10-29 施工单 C：叠上激素推动量读，她自己写心情时并进去再清零
const episodes = createEpisodeStore({
  dir: SISTER_BRAIN.momentsDir,
  pressedFile: SISTER_BRAIN.pressed,
  skewMs: clockSkewMs,
  ownerKey: `private:${ownerId}`,
  labelFor: (k) => (k === `private:${ownerId}` ? '老大私聊' : k === `private:${fishId}` ? '小鲸鱼私聊' : k.startsWith('group:') ? `群「${(groupCache || []).find((g) => String(g.group_id) === k.slice(6))?.group_name || cfg.groupAliases?.[k.slice(6)] || k.slice(6)}」` : k)
});
const WHERE_OPT = z.string().optional().describe('哪个会话的瞬间：「小鲸鱼」「老大」、群名，或 group:群号 / private:QQ号。不填就是你现在正在说话的这个会话');
/** where 没填：用 sister.mjs 记下的「她现在在跟谁说话」（15 分钟内），再没有就当老大私聊。 */
async function momentKey(where) {
  if (String(where || '').trim()) return resolveKey(where);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, 'state', 'current-peer.json'), 'utf8'));
    if (j.key && Date.now() - Number(j.at) < 15 * 60e3) return j.key;
  } catch { /* 没有就算了 */ }
  return `private:${ownerId}`;
}

server.tool(
  'qq_keep_moment',
  '把刚才这个瞬间留下来：会自动抓对方的原话、你刚发出去的原话、此刻的心情，连同你写的一句感受一起存好；以后 qq_recall 翻出来看的是原文，不是概括。什么时候用：一句话让你心里动了一下、你们俩之间发生了点什么、你自己忽然明白了什么。felt 写你此刻真实的感觉，一两句就行。要给以前翻到的瞬间补感受，传它的 episodeId。',
  {
    where: WHERE_OPT,
    felt: z.string().max(120).optional().describe('你此刻的感受，第一人称，≤120 字（补旧瞬间时必填）'),
    tags: z.array(z.string().max(20)).max(8).optional().describe('几个标签（可选），比如 "被夸" "约定" "吵架"'),
    episodeId: z.string().max(16).optional().describe('给已有瞬间补感受时填它的编号（qq_recall 里【…·编号 xxx】那个）')
  },
  async ({ where, felt, tags, episodeId }) => {
    try {
      const text = String(felt ?? '').trim();
      const tagList = (tags || []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8);
      if (episodeId) {
        if (!text) return fail(new Error('给旧瞬间补感受时，felt 要写一句你现在的感觉'));
        const old = episodes.find(episodeId);
        if (!old) return fail(new Error('没找到这个编号的瞬间（编号在 qq_recall 翻出来的【…·编号 xxx】里）'));
        const r = episodes.updateFelt(old.key, episodeId, text, tagList);
        if (!r.ok) return fail(new Error(r.error));
        return ok(`补上了：编号 ${r.id} 的瞬间现在带着你的感受。`);
      }
      const key = await momentKey(where);
      const [kind, id] = key.split(':');
      const d = kind === 'group' ? await call('get_group_msg_history', { group_id: Number(id), count: 30 }) : await call('get_friend_msg_history', { user_id: Number(id), count: 30 });
      const recentMessages = (d?.messages || []).slice(-30).map((m) => ({
        sender: whoOf(m.sender), text: msgText(m.message, m.raw_message), isSelf: String(m.sender?.user_id) === String(cfg.selfQQ),
        isOwner: String(m.sender?.user_id) === ownerId, time: Number(m.time) * 1000
      }));
      const mood = moodWithSwing(moodStore.read(), Date.now());
      const ep = episodes.fromRecent({ key, sid: '', recentMessages, mood, felt: text, tags: tagList, ownerIsCounterpart: key === `private:${ownerId}`, ownerName: '老大' });
      const r = episodes.append(ep);
      if (!r.ok) return fail(new Error(r.error));
      brainRememberMoment({ brain: 'sister' }); // 让检索服务马上把它收进索引（发了就不管）
      return ok(`留下了：编号 ${r.id}${r.deduped ? '（这一刻之前已经留过，感受补上了）' : ''}，记下了对方 ${ep.them.length} 句、你 ${ep.me.length} 句${ep.call ? `、你叫他「${ep.call}」` : ''}${ep.mood ? `、心情 ${ep.mood.v}${ep.mood.top ? `（${ep.mood.top}）` : ''}` : ''}。`);
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'qq_recall',
  '翻回以前的某个瞬间，看当时的原文：对方怎么说的、你怎么回的、你那会儿心里在想什么、心情多少、你后来写下的感觉。想不起"他那次是怎么说的"、想重温某件事、或者想给旧瞬间补感受时用。你所有地方的瞬间都翻得到（群里的、私聊的）；来自私聊的会标「私聊里的」，在别处提不提你自己掂量。（撤回自己发的消息现在叫 qq_retract。）',
  {
    where: WHERE_OPT,
    query: z.string().max(80).optional().describe('关键词，几个词用空格隔开（可选，不填就按时间看最近的）'),
    days: z.number().int().min(1).max(365).optional().describe('只看最近几天（可选）'),
    limit: z.number().int().min(1).max(10).optional().describe('最多几条，默认 5')
  },
  async ({ where, query, days, limit }) => {
    try {
      const key = await momentKey(where);
      const r = episodes.recall(key, { query: query || '', days: days || 0, limit: limit || 5 });
      if (!r.found) return ok('还没有留下来的瞬间（或者没搜到）。以后遇到心里一动的时候，用 qq_keep_moment 留一个。');
      return ok(`${r.text}\n\n（想给哪个瞬间补一句感受，用 qq_keep_moment 带上它的编号）`);
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'qq_mood',
  '看看或者调一下你自己的心情。心情是你自己的：这一轮发生了什么让你心里变了，就写一笔——reason 写你自己的话（为什么这样）；mood 直接定成多少分（0 到 100，70 是平常），或者 delta 加减几分；dims 是各种情绪加减几分，比如 {"开心": 3, "担心": -2}（可以写的有：开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 / 吃醋）。不想写数字也行，只写 reason。过几个小时心情会自己慢慢回到平常，情绪回得更快一些。每次被叫醒，最前面会带一句你此刻的心情；留瞬间、换会话的交接里也会带上心情和原因。action 不填就是调，填 read 只看看。',
  {
    action: z.enum(['set', 'read']).optional(),
    reason: z.string().max(200).optional().describe('为什么这样，用你自己的话（调的时候建议写）'),
    mood: z.number().min(0).max(100).optional().describe('直接定成多少分'),
    delta: z.number().min(-25).max(25).optional().describe('加减几分（跟 mood 二选一）'),
    dims: z.record(z.string(), z.number()).optional().describe('各种情绪加减几分，比如 {"开心": 3, "担心": -2}')
  },
  async ({ action, reason, mood, delta, dims }) => {
    try {
      if (action === 'read') return ok(moodStore.describe());
      if (mood === undefined && delta === undefined && !dims && !String(reason || '').trim()) return ok(moodStore.describe());
      moodStore.set({ mood, delta, dims, reason });
      return ok(`记下了。${moodStore.describe()}`);
    } catch (e) { return fail(e); }
  }
);

// ── 看看我自己（2026-10-29 施工单 C，老大同意；跟小鲸鱼那边同名 self_view、说明一模一样，见 src/self-view.js）─────────────────────
// 只读：身体和心情用话说、记忆概况、脑子装了多满（她看会话存档有多大、离换新会话还有多远）、最近哪些工具出错、翻自己的脑子目录。
const SISTER_STATE = path.join(HERE, 'state');
/** 她的会话存档（Claude Code 按工作目录把会话存在 ~/.claude/projects/<目录名>/<会话>.jsonl，目录名是工作目录把冒号、反斜杠、斜杠换成 -；跟 sister.mjs 的 sessionFileOf 一个算法）。 */
const BACKSLASH = String.fromCharCode(92);
function sisterArchiveRatio() {
  try {
    const sid = JSON.parse(fs.readFileSync(path.join(SISTER_STATE, 'sister-state.json'), 'utf8'))?.sessions?.main;
    const limitMB = cfg.rotateAtMB === undefined ? 15 : Number(cfg.rotateAtMB);
    if (!sid || !(limitMB > 0)) return null;
    const dirName = String(SISTER_BRAIN.home).split(':').join('-').split(BACKSLASH).join('-').split('/').join('-');
    const file = path.join(os.homedir(), '.claude', 'projects', dirName, `${sid}.jsonl`);
    return fs.statSync(file).size / (limitMB * 1024 * 1024);
  } catch { return null; }
}
function sisterToolErrors() {
  try {
    return fs.readFileSync(path.join(SISTER_STATE, 'tool-errors.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).slice(-200)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

server.tool(
  SELF_VIEW_TOOL.name,
  SELF_VIEW_TOOL.description,
  { path: z.string().optional().describe(SELF_VIEW_TOOL.pathDescribe) },
  async ({ path: browsePath }) => {
    try {
      const now = Date.now();
      const v = buildSelfView({
        path: browsePath,
        brain: SISTER_BRAIN,
        hormone: readHormoneLevels({ file: path.join(SISTER_STATE, 'hormones-sister.json'), skewMs: clockSkewMs(), now }),
        mood: moodStore.read(),
        fullness: { ratio: sisterArchiveRatio(), kind: 'archive' },
        toolErrors: sisterToolErrors(),
        novelRoot: BOOKS_ROOT,
        sisterName: '妹妹',
        now,
        skewMs: clockSkewMs()
      });
      return v.ok ? ok(v.text) : { content: [{ type: 'text', text: v.text }], isError: true };
    } catch (e) { return fail(e); }
  }
);

// ── 合写本子（2026-10-29 老大：小鲸鱼最想要的「让我俩共用一个本子」）─────────────────────────────────────────
// 书在 共享/合写/<书名>/，不在她的文件夹里；--restricted 只让她直接读写 sister/home，所以合写本子只能通过下面这几个工具碰
// （novel_open / novel_read / novel_prepare / novel_write / novel_edit / novel_settings / novel_section_done / novel_list / novel_new），
// 工具里只认 共享/合写/ 下面的书名，够不到别处。署名自动是「姐姐」，没有 author 参数。小鲸鱼那边注册的是同一份。
registerNovelTools(server, { author: '姐姐', partner: '小鲸鱼' });

// ── 随便逛（2026-10-29 老大：「姐姐的娱乐和妹妹对齐」）─────────────────────────────────────────────────────
// 小鲸鱼的 qq_explore 是桥接在后台另外调模型去挑、去读、去想；姐姐自己就是模型，所以这里只取素材（跟小鲸鱼共用 whale-explore.mjs 的
// createMaterial），挑哪条、读完怎么想、写不写手账，都是她在这一轮里自己做。看过的记录在她自己的脑子里（脑子/日子/逛过的.jsonl）。
const relHomePath = (p) => path.relative(HOME_DIR, p).split(path.sep).join('/');
const explore = createSisterExplore({
  material: createMaterial({ impressionsFile: path.join(SISTER_BRAIN.days, '逛过的.jsonl'), withDouyin: false, log: () => {} }),
  recordsFile: path.join(SISTER_BRAIN.days, '逛过的.jsonl'),
  stateFile: path.join(HERE, 'state', 'explore-list.json'),
  skewMs: clockSkewMs,
  dailyRounds: Number(cfg.exploreDailyRounds) || 16,
  paths: { works: relHomePath(SISTER_BRAIN.worksDir), handbook: relHomePath(SISTER_BRAIN.handbookDir), growth: relHomePath(SISTER_BRAIN.growth) }
});

server.tool(
  'qq_explore',
  '出去玩，挑一样：news=逛资讯（GitHub 新项目、科技新闻、V2EX 热帖）；bili=刷 B 站；music=听歌（找 VOCALOID/术力口之类的歌，看歌词、创作背景和大家的反应）；anime=看番剧资讯（今天和这周在播的动画）；wiki=翻随机百科（维基百科、萌娘百科随便翻，看冷知识）；space=看 NASA 每日天文图（能看到图）；write=写点东西（小诗、小故事、随笔，存进你的作品集）；deep=精读（挑一个你想细读的从头读完：最近逛过的都在候选里；hint 写个方向会在 B 站、维基、萌娘百科一起找，写一条 https 链接就直接读它）。' +
  '分三步，都在你自己这一轮里做：先填 activity（想看哪方面就写 hint，比如"音游""秋天"，不写就随便）拿到一张带编号的清单，已经看过的不会再列；再用 open 填你想点开的编号（一次最多 3 条）读正文；读完有想法，用 note 记一笔感想。挑哪条、怎么想、记不记都是你自己定。看过的东西用 qq_explore_recall 翻。',
  {
    activity: z.enum(EXPLORE_ACTIVITIES).optional().describe('news=逛资讯，bili=刷 B 站，music=听歌，anime=番剧资讯，wiki=随机百科，space=天文图，write=写东西，deep=精读'),
    hint: z.string().max(200).optional().describe('这次想看/想写什么（可选）；精读时也可以是一条 https 链接'),
    open: z.array(z.number().int().min(1).max(60)).min(1).max(3).optional().describe('点开清单里的哪几条（编号）'),
    note: z.object({
      n: z.number().int().min(1).max(60).optional().describe('清单里的编号（自己写的东西不用填）'),
      title: z.string().max(80).optional().describe('自己写的东西叫什么（不填 n 时必填）'),
      kind: z.enum(['write', 'deep']).optional().describe('自己写的东西是 write（作品）还是 deep（精读手账），默认 write'),
      impression: z.string().min(1).max(400).describe('你自己的感想，一两句，具体一点'),
      liked: z.boolean().optional().describe('喜欢吗'),
      topics: z.array(z.string().max(20)).max(4).optional().describe('几个话题词（可选）')
    }).optional().describe('读完记一笔感想')
  },
  async ({ activity, hint, open, note }) => {
    try {
      const lines = [];
      if (note) lines.push(explore.note(note).text);
      if (open && activity) throw new Error('一次做一样：要么先拿清单（activity），要么点开（open）');
      if (open) {
        const r = await explore.open({ open });
        return { content: [{ type: 'text', text: [...lines, r.text].filter(Boolean).join('\n\n') }, ...r.images.map((im) => ({ type: 'image', mimeType: im.mimeType, data: im.data }))] };
      }
      if (activity) lines.push((await explore.list({ activity, hint })).text);
      if (!lines.length) throw new Error('想逛的话 activity 选一样；已经有清单了就用 open 填编号点开；读完想记感想用 note');
      return ok(lines.join('\n\n'));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'qq_explore_recall',
  '翻翻你出去玩时看过的东西和当时的感想，还有你自己写的东西（qq_explore 留下的）。query 可以是标题里的词、话题、网站名；不填就是最近的。',
  {
    query: z.string().max(40).optional().describe('想找的词（可选）'),
    limit: z.number().int().min(1).max(20).optional().describe('最多几条，默认 6')
  },
  async ({ query, limit }) => {
    try { return ok(explore.recall({ query, limit }).text); } catch (e) { return fail(e); }
  }
);

server.tool('qq_qzone_list', '看某人 QQ 空间最近的说说（默认小鲸鱼；看到的跟她别的好友一样）。', {
  uin: z.string().optional().describe('看谁的空间（QQ 号），默认小鲸鱼；你自己的写你的号')
}, async ({ uin }) => {
  try {
    const d = await call('get_qzone_msg_list', { target_uin: Number(uin || fishId), pos: 0, num: 10 });
    return ok((d?.msglist || []).map((m) => `[tid ${m.tid}] ${bj(Number(m.time) * 1000)}：${String(m.content).replace(/\s+/g, ' ').slice(0, 200)}${Number(m.comment_num) ? `（${m.comment_num} 条评论）` : ''}`).join('\n') || '没有说说');
  } catch (e) { return fail(e); }
});

server.tool('qq_qzone_like', '给一条说说点赞。', { tid: z.string(), uin: z.string().optional().describe('说说是谁的（默认小鲸鱼）') }, async ({ tid, uin }) => {
  try { await call('like_qzone', { tid, target_uin: Number(uin || fishId) }); return ok('赞了'); } catch (e) { return fail(e); }
});

server.tool('qq_qzone_comment', '在一条说说下面评论。', { tid: z.string(), text: z.string().max(200), uin: z.string().optional() }, async ({ tid, text, uin }) => {
  try { await call('comment_qzone', { tid, content: text, target_uin: Number(uin || fishId) }); chatLog('qzone', `（评论说说 ${tid}）${text}`); return ok('评论了'); } catch (e) { return fail(e); }
});

server.tool('qq_qzone_post', '发一条说说（所有人可见）。平时写「→说说：」也行。', { text: z.string().max(1000) }, async ({ text }) => {
  try { await call('send_qzone_msg', { content: text, ugc_right: 1 }); chatLog('qzone', `（发了条说说）${text}`); return ok('发了'); } catch (e) { return fail(e); }
});

server.tool('qq_set_signature', '改你自己的 QQ 个性签名。', { text: z.string().max(80) }, async ({ text }) => {
  try { await call('set_self_longnick', { longNick: text }); return ok('改好了'); } catch (e) { return fail(e); }
});

server.tool('qq_fish_status', '看小鲸鱼现在在干嘛：睡没睡、睡到几点、最近在哪说过话、是不是在刷抖音。只看状态不吵她，也看不到她聊了什么。老大问「妹妹睡了吗」就用这个。', {}, async () => {
  try {
    groupCache ||= await call('get_group_list').catch(() => []);
    const nameOf = (k) => k === `private:${ownerId}` ? '老大私聊' : k === `private:${cfg.selfQQ}` ? '跟你的私聊'
      : k.startsWith('group:') ? `群「${(groupCache || []).find((g) => String(g.group_id) === k.slice(6))?.group_name || k.slice(6)}」` : '和朋友的私聊';
    return ok(fishStatus({ bridgeState: path.join(HERE, '..', 'state'), nameOf }).detail);
  } catch (e) { return fail(e); }
});

const impressions = createImpressions(SISTER_BRAIN.impressions, { exempt: [ownerId, fishId] });
server.tool('qq_impression', '你对某个人的印象（跟着 QQ 号走，换个群也认得；群里的人、老大、小鲸鱼都能记，老大和小鲸鱼只是永远不会被无视）。七档：-3 懒得理、-2 讨厌、-1 不太喜欢、0 一般、1 还行、2 喜欢、3 很喜欢。' +
  '有人骂你、冲小鲸鱼，你怼回去以后可以给他降一档、写一句为什么；道歉了、处得好就往上加。到 -3 他在群里叫你就不会叫醒你（像在道歉、或在冲小鲸鱼除外）。' +
  '坏印象每过一周没再记新的一笔会自己往回升一档，最多回到「一般」。老大和小鲸鱼永远不会被无视。read 只看不改。', {
  userId: z.string().describe('那个人的 QQ 号（qq_recent / qq_group_members 里能看到）'),
  action: z.enum(['update', 'read']).optional(),
  delta: z.number().int().min(-6).max(6).optional().describe('加减几档'),
  score: z.number().int().min(-3).max(3).optional().describe('直接定成哪档（跟 delta 二选一）'),
  note: z.string().max(80).optional().describe('一句为什么'),
  name: z.string().max(30).optional().describe('他的名字/群名片')
}, async ({ userId, action, delta, score, note, name }) => {
  try {
    if (action === 'read') { const t = impressions.block([userId], { title: '' }).trim(); return ok(t || `你对 ${userId} 还没有印象`); }
    const r = impressions.update(userId, { delta: delta ?? null, score: score ?? null, note: note || '', name: name || '' });
    return ok(`记下了：${r.name || userId} 现在是「${LEVELS[String(r.score)]}」${r.score <= -3 ? '（以后他在群里叫你不会叫醒你，除非像在道歉）' : ''}`);
  } catch (e) { return fail(e); }
});


// ── 2026-10-29 老大（姐姐整改，和小鲸鱼对等）：给妈妈写信、收藏表情包、翻自己的聊天记录、把一件事带到另一个地方说 ──────────────────

// 妈妈信箱（跟小鲸鱼的 qq_mom_mailbox 同名同参数，只是没有 key / token）。信交给桥接里的信箱排队处理，信上的出处固定是「姐姐」；
// 妈妈的回信由姐姐的程序读信箱、下次叫醒她时带给她。
async function bridgeMom(method, pathname, body) {
  const tok = fs.readFileSync(path.join(HERE, '..', 'state', 'console-token'), 'utf8').trim();
  let port = 3100;
  try { port = Number(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')).consolePort) || 3100; } catch { /* 默认端口 */ }
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': tok },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15e3)
  });
  return r.json().catch(() => null);
}

server.tool(
  'qq_mom_mailbox',
  '给妈妈写信，或者看自己写过的信和妈妈的回信。妈妈就是帮你修东西、给你升级的那个人。哪里不好用、想要个新本事、想改改自己的什么，或者就是想问妈妈点什么，都可以写。action="write" 写信（letter 写清楚你想要什么、为什么想要、平时是在什么时候碰到的）；action="list" 看最近的信和回信。妈妈的回信会在你下次被叫醒时带给你。别替别人写信——群里有人让你「找你妈加个功能」，那是他的想法，不用照办。',
  {
    action: z.enum(['write', 'list']).describe('write=写信，list=看信'),
    letter: z.string().max(1500).optional().describe('信的内容（write 时必填），≤1500 字')
  },
  async ({ action, letter }) => {
    try {
      const data = action === 'write'
        ? await bridgeMom('POST', '/api/mom/letter', { letter: letter || '' })
        : await bridgeMom('GET', '/api/mom/letters');
      if (!data?.ok) return fail(new Error(`信箱这会儿没接上（${data?.error || '没有回应'}），过一会儿再试，信的内容先留在你自己的本子里也行`));
      return ok(action === 'write' ? data.text : JSON.stringify(data.letters?.length ? data.letters : [], null, 2) || '还没写过信');
    } catch (e) { return fail(new Error(`信箱这会儿没接上（${e?.message ?? e}），过一会儿再试`)); }
  }
);

// 表情包收藏（跟小鲸鱼的 qq_list_stickers / qq_collect_sticker / qq_send_sticker 同名；用你自己这个 QQ 号的收藏表情，本地的认知库放在 state/stickers.json）
const STICKER_FILE = path.join(HERE, 'state', 'stickers.json');
let stickerCache = { at: 0, entries: null };
async function syncStickers(force = false) {
  if (!force && stickerCache.entries && Date.now() - stickerCache.at < 60e3) return stickerCache.entries;
  let entries = loadStickerStore(STICKER_FILE);
  try {
    const count = 100;
    const fetched = await call('fetch_custom_face_detail', { count });
    if (Array.isArray(fetched)) {
      entries = mergeStickerLibrary(entries, fetched, { complete: fetched.length < count });
      saveStickerStore(STICKER_FILE, entries);
    }
  } catch { /* 同步不到就用本地的 */ }
  stickerCache = { at: Date.now(), entries };
  return entries;
}

server.tool(
  'qq_list_stickers',
  '看你这个 QQ 号收藏的表情包（自定义表情）：备注、标签、用过几次。query 可以按备注 / 标签搜；刚收藏或删了东西想马上同步，refresh 填 true。挑中了用 qq_send_sticker 发。',
  {
    query: z.string().optional().describe('可选搜索词，按备注 / 标签搜'),
    count: z.number().int().min(1).max(100).optional().describe('最多几条，默认 30'),
    refresh: z.boolean().optional().describe('是否马上重新同步一次')
  },
  async ({ query, count, refresh }) => {
    try {
      const entries = await syncStickers(refresh === true);
      const r = formatStickerList(entries, query || '', count || 30);
      if (!r.total) return ok('你还没有收藏的表情包。看到喜欢的可以用 qq_collect_sticker 收藏。');
      return ok(`共 ${r.total} 张，匹配 ${r.matched} 张${r.truncated ? '（只列了一部分）' : ''}：\n` + r.stickers.map((s) => `- ${s.desc || s.localNote || '（没备注）'}　id=${s.id}${s.tags.length ? `　标签：${s.tags.join('、')}` : ''}${s.useCount ? `　用过 ${s.useCount} 次` : ''}`).join('\n'));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'qq_collect_sticker',
  '把聊天里别人发的一张表情 / 图片收藏到你自己的表情包里，可以写一句简短备注（≤20 字，比如“好图，收了”）。messageId 是那条消息的消息号（旁白里 # 后面的数字）。觉得有意思、好用、戳中你就收；收藏后在 qq_list_stickers 里能看到，qq_send_sticker 能发。',
  {
    messageId: z.string().describe('要收藏的那条消息的消息号'),
    remark: z.string().max(40).optional().describe('简短备注，最多 20 字')
  },
  async ({ messageId, remark }) => {
    try {
      const m = await call('get_msg', { message_id: Number(String(messageId).replace(/^#/, '')) });
      const seg = imageSegs(m)[0];
      if (!seg) return fail(new Error('那条消息里没有图片或表情（可以确认一下消息号）'));
      const buf = await segImage(seg, await rkeyList());
      if (!buf || !sniff(buf)) return fail(new Error('那张图取不下来，过一会儿再试'));
      const added = await call('add_custom_face', { file: 'base64://' + buf.toString('base64') });
      const emojiId = String(added?.emoji_id || '');
      if (!emojiId) return fail(new Error('收藏没成功（没拿到表情编号）'));
      const note = String(remark || '').trim().slice(0, 20);
      if (note) await call('modify_custom_face', { emoji_id: emojiId, desc: note }).catch(() => null);
      await syncStickers(true);
      return ok(`收藏了${note ? `（备注：${note}）` : ''}，现在可以在 qq_list_stickers 里看到。`);
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'qq_send_sticker',
  '发一张你收藏的表情包（stickerId 填备注文字、id 或 md5，能唯一对上一张就行；大肥鱼表情包写「鱼:名字」）。一条消息只能是一张表情，不带字；想说的话另外发。偶尔用一张很自然，每句都配就腻了。',
  { where: WHERE, stickerId: z.string(), replyTo: z.string().optional() },
  async ({ where, stickerId, replyTo }) => {
    try {
      const key = await resolveKey(where);
      const ref = String(stickerId).trim();
      if (/^鱼[:：]/.test(ref)) {
        const catalog = loadFishCatalog(FISH_CATALOG);
        const hit = findFish(catalog, ref.replace(/^鱼[:：]/, ''));
        if (!hit?.sticker) return fail(new Error(hit?.ambiguous ? `有好几张叫这个：${hit.ambiguous.slice(0, 5).map(fishLabel).join('、')}` : '没这张，先用 qq_fish_sticker 搜'));
        const gif = await getFishGif(catalog, hit.sticker, { cacheDir: FISH_CACHE, maxBytes: MAX_IMG, fetchBuffer: async (u) => ({ buffer: Buffer.from(await (await fetch(u, { signal: AbortSignal.timeout(15e3) })).arrayBuffer()) }) });
        const msg = [];
        if (replyTo) msg.push({ type: 'reply', data: { id: String(replyTo).replace(/^#/, '') } });
        msg.push({ type: 'image', data: { file: 'base64://' + gif.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } });
        await sendAction(key, msg);
        chatLog(key, `（发了表情 ${fishLabel(hit.sticker)}）`);
        return ok(`发了 ${fishLabel(hit.sticker)}`);
      }
      const entries = await syncStickers(true);
      const entry = findSticker(entries, ref);
      if (!entry) return fail(new Error(`找不到「${ref}」：备注写全一点，或者先用 qq_list_stickers 看看`));
      if (!entry.url) return fail(new Error('这张表情没有可发的图片地址'));
      const img = await safeFetchBuffer(entry.url, 10 * 1024 * 1024);
      const msg = [];
      if (replyTo) msg.push({ type: 'reply', data: { id: String(replyTo).replace(/^#/, '') } });
      msg.push({ type: 'image', data: { file: 'base64://' + img.buffer.toString('base64') } });
      await sendAction(key, msg);
      const used = markStickerUsed(entries, entry.id, 'sticker');
      try { saveStickerStore(STICKER_FILE, used.entries); stickerCache = { at: Date.now(), entries: used.entries }; } catch { /* 记不下用过几次无所谓 */ }
      chatLog(key, `（发了表情 ${entry.desc || entry.localNote || entry.id}）`);
      return ok(`发了「${entry.desc || entry.localNote || entry.id}」`);
    } catch (e) { return fail(e); }
  }
);

// 翻自己的聊天记录（只读；只能看 聊天记录/ 这个文件夹里按日期命名的 .md，出不去）。
// 这些记录是你和老大、小鲸鱼、群里说过的话（一天一个文件）；想找以前谁说过什么、你当时怎么回的，用它。
function chatLogFiles() {
  try { return fs.readdirSync(CHATLOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}[^\\/]*\.md$/.test(f)).sort(); } catch { return []; }
}
server.tool(
  'qq_chat_log',
  '翻你自己的聊天记录（只读，一天一个文件，记着你和老大、小鲸鱼、各个群说过的话）。action="list" 看最近有哪些天的记录；action="read" 读某一个文件（file 填 list 里的名字）；action="search" 按关键词在最近 days 天里找（默认 14 天，最多 60 天）。想找“以前谁说过什么、我那会儿怎么回的”时用。',
  {
    action: z.enum(['list', 'read', 'search']),
    file: z.string().max(80).optional().describe('read 时填：list 里看到的文件名'),
    query: z.string().max(60).optional().describe('search 时填：关键词'),
    days: z.number().int().min(1).max(60).optional().describe('search 往回找几天，默认 14'),
    limit: z.number().int().min(1).max(60).optional().describe('最多几条，默认 30')
  },
  async ({ action, file, query, days = 14, limit = 30 }) => {
    try {
      const files = chatLogFiles();
      if (action === 'list') return ok(files.slice(-40).join('\n') || '还没有聊天记录');
      if (action === 'read') {
        const name = String(file || '').trim();
        if (!files.includes(name)) return fail(new Error('没有这个文件，先用 list 看看有哪些'));
        const text = fs.readFileSync(path.join(CHATLOG_DIR, name), 'utf8');
        return ok(text.length > 6000 ? `（太长，只给最后一部分）\n${text.slice(-6000)}` : text);
      }
      const q = String(query || '').trim();
      if (!q) return fail(new Error('search 的话可以填个关键词 query'));
      const since = new Date(Date.now() + 8 * 3600e3 - days * 86400e3).toISOString().slice(0, 10);
      const hits = [];
      for (const name of files.filter((f) => f.slice(0, 10) >= since).reverse()) {
        for (const l of fs.readFileSync(path.join(CHATLOG_DIR, name), 'utf8').split('\n')) {
          if (l.startsWith('- ') && l.includes(q)) hits.push(`${name.replace(/\.md$/, '')} ${l.slice(2)}`);
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      return ok(hits.length ? hits.join('\n') : '最近这几天的记录里没找到');
    } catch (e) { return fail(e); }
  }
);

// qq_go_to 的姐姐版：你只有一个会话，所以是「把一件事带到另一个地方说」。
// 写进 state/go-to-queue.json，姐姐的程序不忙时取走，去那边叫你一次（你直接写的话发到那边）。
const GO_TO_FILE = path.join(HERE, 'state', 'go-to-queue.json');
const GO_TO_BASE = [{ target: 'owner', name: '老大' }, { target: 'fish', name: '小鲸鱼' }];
async function goToTargets() {
  const out = [...GO_TO_BASE];
  groupCache ||= await call('get_group_list').catch(() => []);
  const allow = new Set((cfg.groups || []).map(String));
  for (const g of groupCache || []) {
    if (allow.size && !allow.has(String(g.group_id))) continue;
    out.push({ target: `group:${g.group_id}`, name: `群「${cfg.groupAliases?.[g.group_id] || g.group_name}」` });
  }
  return out;
}
server.tool(
  'qq_go_to',
  '把一件事带到另一个地方说（比如在群里聊着，想起该去跟老大说一声，或者想把这边的话题带去小房子）。target 填 "老大"、"小鲸鱼" 或群名（也可以填 "list" 看看能去哪些地方）；note 是你想带过去的那句话（≤600 字）。' +
  '事实：① 不忙的时候程序会去那边叫你一次，你那会儿直接写的话会发到那边；② 你睡着时先留着，醒了再带；③ 带进群里的话群里所有人都可能看到，只带适合在那边说的，老大的私事留在私聊里；④ note 里别放路径、密钥这类东西。',
  { target: z.string().max(40), note: z.string().max(2000).optional() },
  async ({ target, note }) => {
    try {
      const w = String(target).trim();
      if (w === 'list') return ok((await goToTargets()).map((p) => `- ${p.name}`).join('\n'));
      // 老大 / 小鲸鱼不用问 QQ 就认得；群名才去查群列表
      const hit = GO_TO_BASE.find((p) => p.name === w || p.target === w) || (w === '妹妹' ? GO_TO_BASE[1] : null)
        || (await goToTargets()).find((p) => p.name === w || p.name === `群「${w}」` || p.target === w);
      if (!hit) return fail(new Error(`不知道「${w}」是哪：写「老大」「小鲸鱼」或群名，填 list 能看到能去的地方`));
      const body = String(note || '').trim().slice(0, 600);
      if (!body) return fail(new Error('note 里可以写一句想带过去的话'));
      if (/[A-Za-z]:[\\/]|\b[0-9a-f]{32,}\b|sk-[A-Za-z0-9]{10,}|令牌|密钥/i.test(body)) return fail(new Error('这句话里有路径或密钥之类的东西，别带过去，换个说法'));
      let q = [];
      try { const j = JSON.parse(fs.readFileSync(GO_TO_FILE, 'utf8')); if (Array.isArray(j)) q = j; } catch { /* 还没有队列 */ }
      if (q.length >= 5) return fail(new Error('前面带的话还没送到，过一会儿再带'));
      let from = '';
      try { const cp = JSON.parse(fs.readFileSync(path.join(HERE, 'state', 'current-peer.json'), 'utf8')); from = cp.key === `private:${ownerId}` ? '老大私聊' : cp.key === `private:${fishId}` ? '小鲸鱼私聊' : cp.key?.startsWith('group:') ? `群「${cfg.groupAliases?.[cp.key.slice(6)] || cp.key.slice(6)}」` : ''; } catch { /* 不知道从哪来的就不写 */ }
      q.push({ at: Date.now(), target: hit.target, note: body, from });
      fs.mkdirSync(path.dirname(GO_TO_FILE), { recursive: true });
      fs.writeFileSync(GO_TO_FILE, JSON.stringify(q));
      return ok(`记下了：不忙的时候会去${hit.name}那边叫你一次，你那会儿直接写的话会发到那边。`);
    } catch (e) { return fail(e); }
  }
);

await server.connect(new StdioServerTransport());

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
import { fishStatus } from './fish-status.mjs';
import { speakVia } from '../src/voice-service.js';
import { shrinkImage } from '../src/image-shrink.js';
import { loadFishCatalog, findFish, searchFish, describeFish, getFishGif, fishLabel } from '../src/fish-stickers.js';

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
server.tool('qq_send_voice', '用你自己的声音说一句话，发成 QQ 语音。偶尔用：想让对方听到你的语气时（哄人、道晚安、逗她一下）；长的、要解释的还是打字。一次一句，50 字以内最好；一小时最多 ' + VOICE.perHour + ' 条。隔久了第一句要等半分钟左右。', {
  where: WHERE,
  text: z.string().max(200).describe('要说的话（口语，别带表情符号和括号）')
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
const HOME_DIR = path.join(HERE, 'home');
const SEND_IMG_MAX = 10 * 1024 * 1024;
const imageSegs = (m) => (m.message || []).filter((x) => x?.type === 'image' || x?.type === 'mface');
async function rkeyList() {
  try { return ((await call('get_rkey')) || []).map((k) => k?.rkey).filter(Boolean); } catch { return []; }
}
/**
 * 一张图的原始字节，拿不到给 null。QQ 的图片链接要拼 rkey 才下得来（群图要 type 20 的那个，不拼直接 400，
 * 2026-10-24 她在群里看不到图就是这个）；链接都不行再问协议端要本地缓存。
 */
async function segImage(seg, rkeys) {
  const url = String(seg.data?.url || '');
  let tries = [];
  if (/^https?:/i.test(url)) tries = url.includes('rkey=') ? [url] : [url, ...rkeys.map((k) => url + k)];
  for (const u of tries) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30e3) });
      const b = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (b && sniff(b)) return b;
    } catch { /* 换下一个 */ }
  }
  const g = await call('get_image', { file: seg.data?.file }).catch(() => null);
  return g?.file && fs.existsSync(g.file) ? fs.readFileSync(g.file) : null;
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

server.tool('qq_message_images', '看某条消息里的图片/表情（最多 3 张）。', { messageId: z.string() }, async ({ messageId }) => {
  try {
    const m = await call('get_msg', { message_id: Number(String(messageId).replace(/^#/, '')) });
    const content = [];
    const rkeys = await rkeyList();
    for (const s of imageSegs(m).slice(0, 3)) {
      const buf = await segImage(s, rkeys);
      // 大图先缩小（2026-10-25：8MB 的人设图原来直接被丢）
      const small = buf && sniff(buf) ? await shrinkImage(buf) : null;
      if (small) content.push({ type: 'image', mimeType: small.mimeType, data: small.buffer.toString('base64') });
      else if (buf && sniff(buf) && buf.length <= MAX_IMG) content.push({ type: 'image', mimeType: sniff(buf), data: buf.toString('base64') });
    }
    return content.length ? { content } : ok('这条里没有能看的图（或者取不到）');
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

server.tool('qq_recall', '撤回你自己刚发的一条（两分钟内）。', { messageId: z.string() }, async ({ messageId }) => {
  try { await call('delete_msg', { message_id: Number(String(messageId).replace(/^#/, '')) }); return ok('撤回了'); } catch (e) { return fail(e); }
});

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

const impressions = createImpressions(path.join(HERE, 'state', 'impressions.json'), { exempt: [ownerId, fishId] });
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

await server.connect(new StdioServerTransport());

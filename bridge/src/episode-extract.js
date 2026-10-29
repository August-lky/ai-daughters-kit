// 从旧会话的记录（~/.dsh/sessions/<cwd>/session-*/session.v4.jsonl.zstd）里抽"瞬间"。
//
// 会话搬家之后旧记录没人再读：她发过的原话、对方的原话、当时的推理（reasoning）
// 都还躺在里面。这个模块把它们按"一次交流"重新拼起来，只留有分量的那些，
// 写进脑子的 瞬间/（见 episodes.js、brains.js）。
//
// 一次交流 = 她的一串连续发言（同一个 key、间隔 ≤90 秒）+ 发言前 10 分钟内对方的话
//           + 发出第一句话的那条 assistant 消息里的 reasoning 节选。
// 什么算"有分量"（够一条就留）：
//   ① 前后 5 分钟内她调过 remember / qq_memory_append / rambling_append / qq_growth_note；
//   ② 心情时间线（feiyu-mood state.json 的 timeline）在 [前 5 分钟, 后 10 分钟] 里有 |delta| ≥ 3 的一行；
//   ③ 主人私聊里，主人 3 分钟内连发 ≥2 句而她回了；
//   ④ 对话或推理里带明显的情绪词（STRONG_RE）。
// 去重交给仓库（同 key、同一句开头、±2 分钟）。增量：瞬间/extracted.json 记着
// 每个 sid 处理时的文件字节数，没变就不再处理。
//
// 隐私：工具参数（arguments）整体不进记录；令牌、userId、QQ 号不进记录。只取消息正文、
// 对方的称谓（主人 / 群友昵称 / 抖音朋友名字）、时间戳、她自己的推理节选。
// 任何出现过的令牌字符串在写出前都会被抹掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createEpisodeStore, detectCall, formatEpisode, moodSnapshot, normalizeEpisode } from './episodes.js';
import { createBrains } from './brains.js';
import { rowsSwing } from './mood.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const DEFAULT_SESSIONS_DIR = process.env.EPISODE_SESSIONS_DIR
  || path.join(os.homedir(), '.dsh', 'sessions', '--E-qq-bridge-state-agents--');
const DOUYIN_STATE_DIR = process.env.EPISODE_DOUYIN_STATE_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state');
const MOOD_STATE_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'feiyu-mood', 'state.json');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const KEY_RE = /^(?:group|private):\d+$/;
// ④ 的情绪词。故意短：宁可漏，不要把每句"哈哈"都当瞬间。
export const STRONG_RE = /想你|喜欢你|爱你|委屈|难过|哭了|抱抱|贴贴|生气|对不起|害怕|心疼|好想|亲亲|呜呜|不开心|吃醋|眼泪|感动|想哭|骄傲|舍不得/;
const ANCHOR_TOOLS = /(?:^|__)(?:remember|qq_memory_append|rambling_append|qq_growth_note)$/;
const INCOMING_TOOLS = /(?:^|__)(?:qq_wait_for_messages|qq_get_unread_messages|qq_get_recent_messages)$/;
const SEND_TOOLS = /(?:^|__)(?:qq_send_message|qq_reply|qq_send_burst|qq_send_private_message|qq_send_group_message)$/;
const WINDOW = Object.freeze({ themBeforeMs: 10 * 60e3, clusterGapMs: 90e3, anchorMs: 5 * 60e3, moodBeforeMs: 5 * 60e3, moodAfterMs: 10 * 60e3, moodNearMs: 15 * 60e3, ownerBurstMs: 3 * 60e3, reasoningBackMs: 3 * 60e3 });

/** 把拼接的 zstd 帧逐个解开（坏帧跳过），返回 JSONL 行。 */
export function readTranscriptLines(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let p = 0;
  while ((p = buf.indexOf(ZSTD_MAGIC, p)) !== -1) { starts.push(p); p += 4; }
  let text = '';
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'); } catch { /* 坏帧跳过 */ }
  }
  return text.split('\n').filter((l) => l.trim());
}

function sessionFile(sid, sessionsDir) {
  if (fs.existsSync(sid) && fs.statSync(sid).isFile()) return sid;
  const name = String(sid).startsWith('session-') ? String(sid) : `session-${sid}`;
  const direct = path.join(sessionsDir, name, 'session.v4.jsonl.zstd');
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(sessionsDir)) {
    const hit = fs.readdirSync(sessionsDir).find((d) => d.includes(String(sid)));
    if (hit) return path.join(sessionsDir, hit, 'session.v4.jsonl.zstd');
  }
  return direct;
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function contentText(content) {
  return (Array.isArray(content) ? content : []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? ''));
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) { const j = parseJsonLoose(s); if (Array.isArray(j)) return j.map((x) => String(x ?? '')); }
  return s ? [s] : [];
}

function placeholderSender(s) {
  return !s || ['我', '私聊', '群', '对方', '系统'].includes(String(s));
}

/** 抹掉令牌：见过的令牌原文 + 任何 40 位以上的十六进制串；7 位以上的数字串（QQ 号、消息 id、手机号）一律抹成「…」。 */
function makeScrubber(tokens) {
  const list = [...tokens].filter((t) => t && t.length >= 12);
  return (s) => {
    let out = String(s ?? '');
    for (const t of list) out = out.split(t).join('［令牌］');
    out = out.replace(/\b[a-f0-9]{40,}\b/gi, '［令牌］');
    return out.replace(/\d{7,}/g, '…');
  };
}

/**
 * 抽一个会话。返回 { sid, key, episodes:[...], appended, deduped, skipped }。
 * 传 store 就顺手写进仓库；不传只返回。
 */
export function extractSessionEpisodes(sid, {
  sessionsDir = DEFAULT_SESSIONS_DIR, ownerQQ = '', moodTimeline = [], douyinAllowlist = [],
  store = null, indexFile = '', force = false, now = Date.now()
} = {}) {
  const file = sessionFile(sid, sessionsDir);
  if (!fs.existsSync(file)) return { sid, error: '找不到会话记录', episodes: [], appended: 0, deduped: 0 };
  const bytes = fs.statSync(file).size;
  const realSid = path.basename(path.dirname(file));
  let index = { version: 1, sids: {} };
  if (indexFile) {
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = { version: 1, sids: {} }; }
    index.sids = index.sids && typeof index.sids === 'object' ? index.sids : {};
    if (!force && index.sids[realSid]?.bytes === bytes) return { sid: realSid, skipped: true, episodes: [], appended: 0, deduped: 0 };
  }

  const lines = readTranscriptLines(file);
  const ownerKey = ownerQQ ? `private:${ownerQQ}` : '';
  const tokens = new Set();
  const calls = new Map(); // callId -> { name, args, at, seq }
  const assistants = []; // { seq, at, reasoning, callIds }
  const incoming = []; // { key, at, line, isOwner, seq }
  const seenIncoming = new Set();
  const sends = []; // { key, at, text, callId, seq }
  const anchors = []; // ms
  const keyCount = new Map();
  const douyinNames = new Map(); // conv id -> 显示名（从 douyin_chat_read 结果里学）

  const douyinKey = (convId) => {
    const item = (Array.isArray(douyinAllowlist) ? douyinAllowlist : []).find((a) => a && a.id === convId);
    const legacyOwner = Array.isArray(douyinAllowlist) && douyinAllowlist.length === 1 && !douyinAllowlist.some((a) => a?.role) && item;
    if (item?.role === 'owner' || legacyOwner) return { key: 'douyin:dm', who: '主人', isOwner: true };
    const name = String(item?.name || douyinNames.get(convId) || '').trim();
    return name ? { key: `douyin:friend:${name}`, who: name, isOwner: false } : null;
  };

  const addIncoming = (key, m, fallbackAt) => {
    const text = String(m?.text ?? m?.plain ?? '').trim();
    if (!key || !text || m?.isSelf) return;
    const id = `${key}#${m.seq ?? m.id ?? `${fallbackAt}:${text.slice(0, 20)}`}`;
    if (seenIncoming.has(id)) return;
    seenIncoming.add(id);
    const who = m.isOwner ? '主人' : (placeholderSender(m.sender) ? (key === ownerKey ? '主人' : '对方') : String(m.sender));
    incoming.push({ key, at: Number(m.time ?? m.at) || fallbackAt, line: `${who}：${text}`, isOwner: Boolean(m.isOwner) || who === '主人', seq: m.seq });
  };

  for (const line of lines) {
    const j = parseJsonLoose(line);
    if (!j || typeof j !== 'object') continue;
    const at = Number(j.time) || 0;
    if (j.type === 'user/message') {
      const text = contentText(j.data?.content);
      for (const m of text.matchAll(/【会话令牌】\s*([\w-]{12,})/g)) tokens.add(m[1]);
      const snap = /【本次消息快照】\n(\{.*\})/.exec(text);
      if (snap) {
        const packet = parseJsonLoose(snap[1]);
        // 快照没写 key，它属于这个会话自己的 key（下面按工具参数里最常见的那个定）。先存起来，最后再补 key。
        if (packet) for (const m of [...(packet.messages || []), ...(packet.recent || [])]) incoming.push({ key: null, at: Number(m.time) || at, raw: m });
      }
      continue;
    }
    if (j.type === 'tool/call') {
      const name = String(j.data?.name ?? '');
      const args = parseJsonLoose(j.data?.arguments ?? '') || {};
      if (typeof args.token === 'string' && args.token) tokens.add(args.token);
      if (typeof args.key === 'string' && KEY_RE.test(args.key)) keyCount.set(args.key, (keyCount.get(args.key) || 0) + 1);
      calls.set(j.data?.callId, { name, args, at, seq: j.seq });
      if (ANCHOR_TOOLS.test(name)) anchors.push(at);
      continue;
    }
    if (j.type === 'assistant/message') {
      const content = Array.isArray(j.data?.message?.content) ? j.data.message.content : [];
      const reasoning = content.filter((c) => c?.type === 'reasoning' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
      const callIds = content.filter((c) => c?.type === 'tool-call' && c.id).map((c) => c.id);
      assistants.push({ seq: j.seq, at, reasoning, callIds });
      continue;
    }
    if (j.type === 'tool/result') {
      const callId = j.data?.message?.toolCallId;
      const call = calls.get(callId);
      if (!call) continue;
      const text = contentText(j.data?.message?.content);
      const failed = Boolean(j.data?.message?.isError) || /^Error\b/.test(text) || text.startsWith('没发出去');
      if (INCOMING_TOOLS.test(call.name)) {
        const data = parseJsonLoose(text);
        const key = (typeof data?.key === 'string' && KEY_RE.test(data.key) && data.key) || (KEY_RE.test(call.args.key || '') ? call.args.key : '');
        for (const m of [...(data?.newMessages || []), ...(data?.messages || [])]) addIncoming(key, m, at);
      } else if (/(?:^|__)douyin_chat_(?:read|observe)$/.test(call.name)) {
        const data = parseJsonLoose(text);
        for (const c of [...(data?.contacts || []), data?.contact, data?.conversation]) if (c?.id && (c.displayName || c.name)) douyinNames.set(c.id, c.displayName || c.name);
        const convId = data?.conversation?.id || data?.contact?.id;
        const route = convId ? douyinKey(convId) : null;
        if (route) {
          for (const m of data?.messages || []) {
            if (m?.direction !== 'incoming' || !m.text) continue;
            if (/old|history/.test(String(m.arrivalClassification || ''))) continue; // 旧消息的时间读不准，不收
            addIncoming(route.key, { id: m.id, sender: route.who, text: m.text, isOwner: route.isOwner }, at);
          }
        }
      } else if (SEND_TOOLS.test(call.name)) {
        if (failed) continue;
        const a = call.args;
        let key = '';
        if (KEY_RE.test(a.key || '')) key = a.key;
        else if (a.groupId !== undefined && a.groupId !== null) key = `group:${a.groupId}`;
        else if (a.userId !== undefined && a.userId !== null) key = `private:${a.userId}`;
        if (!key) continue;
        for (const t of toList(a.messages ?? a.message)) if (t.trim()) sends.push({ key, at: call.at || at, text: t.trim(), callId, seq: call.seq });
      } else if (/(?:^|__)douyin_chat_send$/.test(call.name)) {
        if (failed) continue;
        const route = douyinKey(String(call.args.recipientId || ''));
        const t = String(call.args.message ?? '').trim();
        if (route && t) sends.push({ key: route.key, at: call.at || at, text: t, callId, seq: call.seq });
      }
    }
  }

  // 快照里的消息补上这个会话自己的 key。
  const sessionKey = [...keyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const pending = incoming.filter((m) => m.key === null);
  for (const m of pending) { incoming.splice(incoming.indexOf(m), 1); if (sessionKey) addIncoming(sessionKey, m.raw, m.at); }
  incoming.sort((a, b) => a.at - b.at);
  sends.sort((a, b) => a.at - b.at || a.seq - b.seq);

  const scrub = makeScrubber(tokens);
  const assistantByCall = new Map();
  for (const a of assistants) for (const id of a.callIds) assistantByCall.set(id, a);
  const timeline = (Array.isArray(moodTimeline) ? moodTimeline : []).filter((r) => r && Number.isFinite(Number(r.at))).sort((a, b) => a.at - b.at);

  const reasoningFor = (send) => {
    const own = assistantByCall.get(send.callId);
    if (own?.reasoning) return own.reasoning;
    // 发消息那条没写推理：往前找 3 分钟内最近一条有推理的。
    let best = null;
    for (const a of assistants) {
      if (a.at > send.at || send.at - a.at > WINDOW.reasoningBackMs || !a.reasoning) continue;
      if (!best || a.at > best.at) best = a;
    }
    return best?.reasoning || '';
  };

  // 把她的发言按 key + 间隔聚成"一次交流"。
  // 中间有对方插话就断开：一来一回算两次交流，不让一整晚的对话糊成一条。
  const clusters = [];
  const spokenBetween = (key, fromMs, toMs) => incoming.some((m) => m.key === key && m.at > fromMs && m.at <= toMs);
  for (const s of sends) {
    const last = clusters[clusters.length - 1];
    if (last && last.key === s.key && s.at - last.end <= WINDOW.clusterGapMs && !spokenBetween(s.key, last.end, s.at)) { last.items.push(s); last.end = s.at; }
    else clusters.push({ key: s.key, start: s.at, end: s.at, items: [s] });
  }

  const consumed = new Set();
  const episodes = [];
  for (const c of clusters) {
    const them = [];
    for (let i = 0; i < incoming.length; i += 1) {
      const m = incoming[i];
      if (m.key !== c.key || consumed.has(i) || m.at > c.start || c.start - m.at > WINDOW.themBeforeMs) continue;
      them.push({ i, m });
    }
    for (const t of them) consumed.add(t.i);
    const themRows = them.slice(-6).map((t) => t.m);
    const me = c.items.map((s) => s.text).slice(0, 6);
    const inner = reasoningFor(c.items[0]);

    // ① 记忆锚点
    const anchored = anchors.some((t) => Math.abs(t - c.start) <= WINDOW.anchorMs || Math.abs(t - c.end) <= WINDOW.anchorMs);
    // ② 心情波动
    const moodRows = timeline.filter((r) => r.at >= c.start - WINDOW.moodBeforeMs && r.at <= c.end + WINDOW.moodAfterMs);
    const moodDelta = moodRows.reduce((m, r) => Math.max(m, Math.abs(Number(r.delta) || 0)), 0);
    // 2026-10-29 大脑方案下半：心情分一次最多只动 1，真正的起伏在某种情绪的变动上（实测 99% 的单次变动 ≤4），一并看；
    // 超过 mood.js 的阈值的瞬间同时会记进 压着.json。
    const dimDelta = rowsSwing(moodRows).dd;
    // ③ 主人连发
    const ownerLines = themRows.filter((m) => m.isOwner);
    const ownerBurst = c.key === ownerKey && ownerLines.length >= 2 && (ownerLines[ownerLines.length - 1].at - ownerLines[0].at) <= WINDOW.ownerBurstMs;
    // ④ 情绪词
    const strong = STRONG_RE.test([...themRows.map((m) => m.line), ...me, inner].join('\n'));
    if (!(anchored || moodDelta >= 3 || dimDelta >= 4 || ownerBurst || strong)) continue;

    let mood = null;
    const near = timeline.map((r) => ({ r, d: Math.abs(r.at - c.start) })).filter((x) => x.d <= WINDOW.moodNearMs).sort((a, b) => a.d - b.d)[0]?.r;
    if (near) {
      const snap = moodSnapshot({ mood: near.mood, dims: near.dims, updatedAt: near.at }, near.at);
      if (snap) mood = { ...snap, ...(moodDelta ? { d: moodDelta } : {}), ...(dimDelta ? { dd: dimDelta } : {}) };
    }
    const isOwnerChat = c.key === ownerKey || c.key === 'douyin:dm';
    const ep = {
      at: c.start,
      key: c.key,
      sid: realSid,
      who: isOwnerChat ? '主人' : (c.key.startsWith('douyin:friend:') ? c.key.slice(14) : (c.key.startsWith('group:') ? '群友' : '对方')),
      them: themRows.map((m) => scrub(m.line)),
      me: me.map((t) => scrub(t)),
      inner: scrub(inner).replace(/\s+/g, ' ').slice(0, 150),
      mood,
      call: isOwnerChat ? detectCall(me) : '',
      felt: '',
      tags: [anchored ? '记过' : '', moodDelta >= 3 || dimDelta >= 4 ? '心情波动' : '', ownerBurst ? '主人连说' : '', strong ? '有情绪' : ''].filter(Boolean),
      source: 'extract'
    };
    episodes.push(normalizeEpisode(ep));
  }

  let appended = 0;
  let deduped = 0;
  if (store) {
    for (const ep of episodes) {
      const r = store.append(ep);
      if (r.ok && r.deduped) deduped += 1;
      else if (r.ok) appended += 1;
    }
  }
  if (indexFile) {
    index.sids[realSid] = { bytes, at: now, key: sessionKey, episodes: episodes.length, appended, deduped };
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  }
  return { sid: realSid, key: sessionKey, episodes, appended, deduped, skipped: false };
}

/** 读 bridge 真实环境里的配置（ownerQQ、时钟偏差、心情时间线、抖音通讯录），给 CLI / 搬家时用。 */
export function loadExtractEnv(root = ROOT) {
  const readJson = (f) => {
    try {
      let t = fs.readFileSync(f, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      return JSON.parse(t);
    } catch { return null; }
  };
  const cfg = readJson(path.join(root, 'config.json')) || {};
  const skew = Number(readJson(path.join(root, 'state', 'clock-skew.json'))?.skewMs) || 0;
  const mood = readJson(MOOD_STATE_FILE);
  const policy = readJson(path.join(DOUYIN_STATE_DIR, 'chat-policy.json'));
  return {
    ownerQQ: cfg.ownerQQ === undefined || cfg.ownerQQ === null ? '' : String(cfg.ownerQQ),
    skewMs: skew,
    moodTimeline: Array.isArray(mood?.timeline) ? mood.timeline : [],
    douyinAllowlist: Array.isArray(policy?.allowlist) ? policy.allowlist : [],
    // 2026-10-29 大脑方案：瞬间在小鲸鱼脑子的 瞬间/ 里（路径统一从 brains.js 取）
    episodesDir: createBrains(root).brainOf('whale').momentsDir,
    pressedFile: createBrains(root).brainOf('whale').pressed,
    indexFile: createBrains(root).brainOf('whale').extracted
  };
}

// CLI：node src/episode-extract.js <sid> [--force] [--dry] [--print]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sid = args.find((a) => !a.startsWith('--'));
  if (!sid) { console.error('用法：node src/episode-extract.js <sid> [--force] [--dry] [--print]'); process.exit(2); }
  const env = loadExtractEnv();
  const dry = args.includes('--dry');
  const store = dry ? null : createEpisodeStore({ dir: env.episodesDir, pressedFile: env.pressedFile, skewMs: env.skewMs, ownerKey: env.ownerQQ ? `private:${env.ownerQQ}` : '' });
  const r = extractSessionEpisodes(sid, { ...env, store, indexFile: dry ? '' : env.indexFile, force: args.includes('--force') });
  const perKey = {};
  for (const e of r.episodes) perKey[e.key] = (perKey[e.key] || 0) + 1;
  console.log(JSON.stringify({ sid: r.sid, skipped: Boolean(r.skipped), error: r.error, episodes: r.episodes.length, appended: r.appended, deduped: r.deduped, perKey }, null, 2));
  if (args.includes('--print')) for (const e of r.episodes) console.log('\n' + formatEpisode(e, { skewMs: env.skewMs, ownerKey: env.ownerQQ ? `private:${env.ownerQQ}` : '' }));
}

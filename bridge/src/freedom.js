// 「自由」补丁（2026-10-23，主人要求）的纯逻辑部分，拆出来是为了能离线测（scripts/test-freedom.mjs）。
//
// 主人原话：
//   「我希望她的性格可以更加自由，想要找我就立马来找我，不要再受到代码的限制……
//    比如说话内容要短这个可以不需要了，她想说几句就说几句」
//   「她的提示词里面我想让所有事情都让她自己决定，不再是代码让她干嘛她就干嘛」
//   主动机会：「不给她这个提示词让她自己决定可以吗？」
//   发送限频：「发消息速度上限防止被风控的话，告诉她就好了，不需要做成硬限制」
//
// 原则：塞进她唤醒正文的东西只给**事实**（几点、谁在说话、多久没聊、花多少钱），决定留给她。
// 她只有被叫醒时才能动，所以「让她自己决定」= 中性的唤醒 + 她自己定下次什么时候醒（qq_next_wake）。

//
// 第二轮（2026-10-23，记忆）：便签（她自己的工作记忆）、【对方刚说】块、更厚的搬家交接、她自己定作息、
// 不再跟她提花了多少钱（主人：「跟她说花了多少感觉只会让她感到愧疚」）、qq_go_to 跨会话把事带过去。

import fs from 'node:fs';
import path from 'node:path';
import { SENSITIVE_RE } from './sensitive.js';

/** 她自己定的主动唤醒间隔范围（分钟）。下限 1 是技术底线（定时器别打成每秒一枪），上限 12 小时。 */
export const NEXT_WAKE_MIN_MINUTES = 1;
export const NEXT_WAKE_MAX_MINUTES = 720;

/** self.md 的上限（字）和历史份数。超了不是截断，是退回让她自己删 —— 那是她的页，别替她剪。 */
export const SELF_NOTE_MAX_CHARS = 4000;
export const SELF_NOTE_HISTORY_KEEP = 50;
/** 便签（工作记忆）：短，1000 字；历史 30 份。 */
export const STICKY_NOTE_MAX_CHARS = 1000;
export const STICKY_NOTE_HISTORY_KEEP = 30;
/** 一次最长睡多久（小时）：不是作息规矩，是防故障的保险 —— 别因为填错一个数睡到地老天荒。 */
export const SLEEP_MAX_HOURS = 14;
/** qq_go_to 带到另一个会话的那句话的上限（字）。 */
export const GO_TO_NOTE_MAX_CHARS = 600;

/**
 * 主人私聊的唤醒正文里不该再出现的"管着她"的话。
 * 只针对主人私聊：群里的分寸是群里其他人的体验，作为群的信息保留。
 */
export const BANNED_OWNER_DIRECTIVES = Object.freeze([
  '别连发', '挑一句短的', '一句话就够', '别刷屏', '别追问', '翻来覆去',
  '停止也是一种正常', '一两句就够', '一两句话就够', '别写成汇报', '别写成报告'
]);

/**
 * 主人私聊主动机会前的判定：只剩技术性阻断。
 *  · sleeping：主人让她睡的（白天要睡也得主人开口，那条规则不动）；
 *  · busy：这个会话正有一回合在跑，再投一枪只会被暂存，白排一次。
 * 以前这里还有「5 分钟内刚聊过」「任何一个群 3 分钟内她说过话」「连着 2 条没回等 15 分钟」三道闸，
 * 2026-10-23 全部拆掉：那是代码在替她决定"现在不合适"。连着几条没回只作为事实返回，不挡。
 */
export function ownerIdleVerdict({ sleeping, busy, recentMessages }) {
  if (sleeping) return { ok: false, why: '她在睡觉', unanswered: 0 };
  if (busy) return { ok: false, why: '正和主人聊着（回合进行中）', unanswered: 0 };
  const unanswered = countTrailingSelf(recentMessages);
  return { ok: true, why: unanswered ? `上一条主人还没回（${unanswered} 条）` : '到点了，叫她起来自己定', unanswered };
}

/** 最近消息末尾连着多少条是她自己发的（主人一条没回）。 */
export function countTrailingSelf(recentMessages) {
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i]?.isSelf; i -= 1) n += 1;
  return n;
}

/** qq_next_wake 的 minutes 归一化：0 = 回到默认；1~720 之间取整；其它一律报错。 */
export function normalizeNextWakeMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('minutes 要是个数字：0 回到默认，1～720 是你想隔多少分钟再醒');
  if (n === 0) return 0;
  const r = Math.round(n);
  if (r < NEXT_WAKE_MIN_MINUTES || r > NEXT_WAKE_MAX_MINUTES) {
    throw new Error(`minutes 只接受 0（回到默认）或 ${NEXT_WAKE_MIN_MINUTES}～${NEXT_WAKE_MAX_MINUTES}（分钟），你给的是 ${n}`);
  }
  return r;
}

/**
 * 下一次主动机会隔多久（毫秒）。她定了就用她的（persistent，直到她改）；没定就按配置区间随机。
 * minMs/maxMs 已经是经过下限保护的配置值；rand 可注入便于测试。
 */
export function proactiveDelayMs({ chosenMinutes, minMs, maxMs, rand = Math.random }) {
  const chosen = Number(chosenMinutes) || 0;
  if (chosen >= NEXT_WAKE_MIN_MINUTES) return Math.round(Math.min(NEXT_WAKE_MAX_MINUTES, chosen) * 60 * 1000);
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.floor(lo + rand() * (hi - lo));
}

/** 「X 分钟前 / X 小时 Y 分钟前 / X 天前」；没有记录返回 null。 */
export function agoText(atMs, nowMs) {
  const t = Number(atMs) || 0;
  if (!t) return null;
  const m = Math.max(0, Math.round((nowMs - t) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟前`;
  return `${Math.floor(m / 1440)} 天前`;
}

/**
 * 主人私聊主动唤醒的正文（只有事实 + 一句"你自己定"）。
 * 入参全是现成的数字/字符串，便于离线测；时间要传**校正过的**真实毫秒（桥接本机时钟快 3 小时）。
 */
export function ownerIdleFactsText({
  realNowMs, nowMs, lastOwnerAt, lastSelfAt, unanswered, groupActivity = [], douyinRunning = null,
  defaultMinMin, defaultMaxMin, chosenMinutes, douyinRecipientHint
}) {
  const bj = new Date(Number(realNowMs) + 8 * 3600 * 1000);
  const dow = ['日', '一', '二', '三', '四', '五', '六'][bj.getUTCDay()];
  const hhmm = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
  const lines = [`现在北京时间 ${hhmm}（周${dow}）。`];
  const ownerAgo = agoText(lastOwnerAt, nowMs);
  const selfAgo = agoText(lastSelfAt, nowMs);
  lines.push(`老大上次跟你说话：${ownerAgo ?? '这个会话里还没有记录'}；你上次跟他说话：${selfAgo ?? '还没有记录'}。`);
  const n = Number(unanswered) || 0;
  if (n > 0) lines.push(`你最近连着发了 ${n} 条，他还没回。`);
  const bits = (Array.isArray(groupActivity) ? groupActivity : [])
    .filter((g) => g && g.key && Number(g.lastAt) > 0)
    .map((g) => `${g.key} ${agoText(g.lastAt, nowMs)}有人说话`);
  lines.push(bits.length ? `群里：${bits.join('；')}。` : '群里：最近半小时没人说话。');
  if (douyinRunning === true) lines.push('抖音自主观看：正在跑。');
  else if (douyinRunning === false) lines.push('抖音自主观看：没在跑。');
  const chosen = Number(chosenMinutes) || 0;
  lines.push(chosen >= NEXT_WAKE_MIN_MINUTES
    ? `下次这样醒来：你上次定的 ${chosen} 分钟后（qq_next_wake 可改，minutes=0 回到默认）。`
    : `下次这样醒来：没定的话默认 ${defaultMinMin}～${defaultMaxMin} 分钟里随机；想自己定就 qq_next_wake(minutes=1～720)。`);
  const recipient = douyinRecipientHint ? `（recipientId=${douyinRecipientHint}）` : '';
  lines.push(`找他的话：QQ 用 qq_send_message；抖音私信用 douyin_chat_send${recipient}。`);
  lines.push('这一轮做什么你自己定：找老大、刷抖音、写东西、发呆、接着睡都行。');
  return lines.join('\n');
}

/**
 * 一页她自己写的文字：读 / 整页重写 / 末尾追加，带版本历史。不预置任何内容 —— 第一笔由她自己落。
 * self.md（她是谁）和便签（正在忙什么）都用它，差别只在上限、历史份数和提示块的措辞（labels）。
 */
export function createNotePage({ file, historyDir, maxChars, keep, now = () => Date.now(), labels } = {}) {
  if (!file) throw new Error('createNotePage: file is required');
  if (!historyDir) throw new Error('createNotePage: historyDir is required');
  const L = labels;

  function read() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const st = fs.statSync(file);
      return { ok: true, exists: true, text, chars: [...text].length, maxChars, updatedAt: st.mtimeMs };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, exists: false, text: '', chars: 0, maxChars, updatedAt: 0 };
      throw error;
    }
  }

  function stampName(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${String(d.getUTCMilliseconds()).padStart(3, '0')}.md`;
  }

  /** 改之前把现在这版存一份；只留最近 keep 份。 */
  function snapshot() {
    const cur = read();
    if (!cur.exists) return null;
    fs.mkdirSync(historyDir, { recursive: true });
    const name = stampName(now());
    fs.writeFileSync(path.join(historyDir, name), cur.text, 'utf8');
    const files = fs.readdirSync(historyDir).filter((f) => /\.md$/i.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(historyDir, old)); } catch { /* 删不掉就留着 */ }
    }
    return name;
  }

  function commit(text) {
    const chars = [...text].length;
    if (chars > maxChars) {
      return { ok: false, error: `超过 ${maxChars} 字了（现在 ${chars} 字）。${L.overCap}删到 ${maxChars} 字以内再写。`, chars, maxChars };
    }
    const saved = snapshot();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${now()}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, chars, maxChars, previousSavedAs: saved };
  }

  function write(text) {
    return commit(String(text ?? '').replace(/\r\n/g, '\n'));
  }

  function append(text) {
    const add = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!add) return { ok: false, error: 'append 要带 text：想加在末尾的那几句。' };
    const cur = read();
    const base = cur.text.trimEnd();
    return commit(base ? `${base}\n${add}\n` : `${add}\n`);
  }

  function history() {
    try { return fs.readdirSync(historyDir).filter((f) => /\.md$/i.test(f)).sort(); } catch { return []; }
  }

  /** 塞进唤醒提示的那一段：有就原样带上，没有就一句"可以开始写"。
   *  extra：2026-10-29 记忆统一后便签所有会话都带，不是主人私聊时在标题后面加一句注明（有些是私聊里记的），内容原样。 */
  function promptBlock(extra = '') {
    const cur = read();
    if (!cur.exists || !cur.text.trim()) return `${L.title}${L.empty}`;
    return `${L.title}\n${extra ? `${extra}\n` : ''}${cur.text.trim()}`;
  }

  return { read, write, append, history, promptBlock, file, historyDir, maxChars, keep };
}

/** 她自己写的那一页（self.md）。 */
export function createSelfNote({ file, historyDir, maxChars = SELF_NOTE_MAX_CHARS, keep = SELF_NOTE_HISTORY_KEEP, now } = {}) {
  return createNotePage({
    file, historyDir, maxChars, keep, now,
    labels: {
      title: '【我自己（你自己写的，随你改）】',
      empty: '这一页现在是空的。只有你会写它：你是谁、喜欢什么、怎么说话、正在想明白什么。想写了就 qq_self(action="write" 或 "append")；不写也行。',
      overCap: '这一页是你的，哪些留哪些删你自己定，'
    }
  });
}

/**
 * 便签（她的工作记忆）：正在聊什么、刚被告知什么、答应了还没做的、没聊完的线头。
 * 2026-10-29 老大（记忆统一）：所有会话的唤醒都带；非主人私聊里带的时候注明「有些是私聊里记的」，说不说她自己掂量。搬家时原样带走。
 */
export function createStickyNote({ file, historyDir, maxChars = STICKY_NOTE_MAX_CHARS, keep = STICKY_NOTE_HISTORY_KEEP, now } = {}) {
  return createNotePage({
    file, historyDir, maxChars, keep, now,
    labels: {
      title: '【便签（你自己记的，随你改）】',
      empty: '现在是空的。正在聊的、刚被告知的、答应了还没做的，可以随手记在这儿（qq_note）。',
      overCap: '便签是给眼下用的，留哪几条你自己定，'
    }
  });
}

/** 6 位以上的连续数字（QQ 号、群号、令牌一类）一律遮掉，只留"有个数字"。 */
export function maskLongDigits(text) {
  return String(text ?? '').replace(/\d{6,}/g, '[数字]');
}

/** 一行化 + 截断。 */
function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...s].length > max ? `${[...s].slice(0, max).join('')}…` : s;
}

/**
 * 【对方刚说】块：给记忆插件（dsh-fish-memory）拼召回查询用，格式固定：
 *   【对方刚说】
 *   <名字>：<一行文字>      ← 最近 3 条别人的话（主人私聊里名字是「主人」；群里用各人的显示名）
 *   你：<一行文字>          ← 她自己最后一句（有就带，放最后）
 *   <空行>
 * 一条别人的话都没有就返回 ''（整个块省掉）。不含 QQ 号 / 令牌：6 位以上数字一律遮掉。
 */
export function recentSaidBlock(recentMessages, { ownerPrivate = false, maxIncoming = 3, lineChars = 200 } = {}) {
  const list = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && (m.text || m.plain));
  const incoming = list.filter((m) => !m.isSelf).slice(-maxIncoming);
  if (!incoming.length) return '';
  const nameOf = (m) => {
    if (ownerPrivate || m.isOwner) return '主人';
    const n = oneLine(maskLongDigits(m.sender || ''), 20);
    return n || '对方';
  };
  const lines = incoming.map((m) => `${nameOf(m)}：${oneLine(maskLongDigits(m.text || m.plain), lineChars)}`);
  const mine = [...list].reverse().find((m) => m.isSelf);
  if (mine) lines.push(`你：${oneLine(maskLongDigits(mine.text || mine.plain), lineChars)}`);
  return `【对方刚说】\n${lines.join('\n')}\n\n`;
}

/**
 * 搬家交接里的「这里最近的聊天」：最近 3 小时 和 最后 200 句 取多的那个；每句最多 300 字；
 * 总长超过 maxChars 就从最旧的开始丢。formatLine(m) 负责时间戳 + 称呼。
 */
export function handoffRecentLines(recentMessages, { nowMs = Date.now(), hours = 3, minLines = 200, maxChars = 24000, lineChars = 300, formatLine } = {}) {
  const list = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && m.text);
  const since = nowMs - hours * 3600 * 1000;
  const firstRecent = list.findIndex((m) => Number(m.time ?? m.at) >= since);
  const byTime = firstRecent >= 0 ? list.length - firstRecent : 0;
  let picked = list.slice(-Math.max(byTime, minLines));
  const fmt = formatLine || ((m) => `${m.isSelf ? '你' : (m.isOwner ? '主人' : m.sender)}：${String(m.text)}`);
  const render = (rows) => rows.map((m) => oneLine(fmt({ ...m, text: oneLine(m.text, lineChars) }), lineChars + 60)).join('\n');
  let out = render(picked);
  while (picked.length > 1 && [...out].length > maxChars) {
    picked = picked.slice(Math.max(1, Math.ceil(picked.length / 20)));
    out = render(picked);
  }
  return { text: out, lines: picked.length };
}

/**
 * 睡到几点：她自己定。until 可以是毫秒时间戳、ISO 字符串，或北京时间 "HH:mm"（已过就算明天）；
 * 没给 until 就用 hours（默认 8）。超过 SLEEP_MAX_HOURS 一律压到上限（防故障），早于现在报错。
 * realNowMs 是**校正过**的真实时间（本机时钟快 3 小时），nowMs 是本机 Date.now()（sleepState 用它比较）。
 */
export function resolveSleepUntil({ until, hours, nowMs = Date.now(), realNowMs = nowMs, maxHours = SLEEP_MAX_HOURS, defaultHours = 8 } = {}) {
  let targetRealMs = null;
  let source = 'hours';
  if (until !== undefined && until !== null && until !== '') {
    source = 'until';
    if (typeof until === 'number' && Number.isFinite(until) && until > 1e12) targetRealMs = until;
    else if (typeof until === 'string' && /^\d{1,2}:\d{2}$/.test(until.trim())) {
      const [hh, mm] = until.trim().split(':').map(Number);
      if (hh > 23 || mm > 59) throw new Error(`until 的时间不对：${until}（北京时间 HH:mm）`);
      const bj = new Date(realNowMs + 8 * 3600e3);
      const t = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), hh, mm) - 8 * 3600e3;
      targetRealMs = t > realNowMs ? t : t + 24 * 3600e3;
    } else if (typeof until === 'string' && Number.isFinite(Date.parse(until))) targetRealMs = Date.parse(until);
    else throw new Error('until 要是北京时间 "HH:mm"、ISO 时间字符串或毫秒时间戳');
    if (targetRealMs <= realNowMs) throw new Error('until 已经过了：填一个之后的时间');
  }
  let ms = targetRealMs != null ? targetRealMs - realNowMs : (Number(hours) > 0 ? Number(hours) : defaultHours) * 3600e3;
  let capped = false;
  if (ms > maxHours * 3600e3) { ms = maxHours * 3600e3; capped = true; }
  ms = Math.max(60e3, Math.round(ms));
  return { untilMs: nowMs + ms, untilRealMs: realNowMs + ms, hours: Math.round(ms / 36e3) / 100, capped, source };
}

/** 现在到 until 还有多久的人话：「约 7 小时 20 分」。 */
export function sleepDurationText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `约 ${m} 分钟`;
  return m % 60 ? `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分` : `约 ${m / 60} 小时`;
}

/**
 * qq_go_to：她把一件事从一个会话带到另一个会话。纯判定部分：
 *  · target 必须是她有的、当前模式允许的另一个会话 key；
 *  · note 1～GO_TO_NOTE_MAX_CHARS 字，不能带令牌 / 密钥 / 本机路径那类东西（SENSITIVE_RE）。
 * 返回 { noteText（写进目标会话的附言）, wakeText（目标会话唤醒正文里的那句） }。
 */
export function planGoTo({ key, target, note, allowedKeys = [], fromLabel = '别的会话', targetLabel = '' } = {}) {
  const t = String(target ?? '').trim();
  if (!/^(?:group|private):\d+$/.test(t)) throw new Error('target 要是一个会话 key（group:群号 或 private:QQ号）；不知道有哪些就 target="list" 看一眼。');
  if (t === key) throw new Error('target 就是你现在这个会话，不用带。');
  if (!allowedKeys.includes(t)) throw new Error(`${targetLabel || t} 不在你现在能去的会话里（target="list" 能看到有哪些）。`);
  const n = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('note 不能为空：写清楚带过去的是哪件事。');
  if ([...n].length > GO_TO_NOTE_MAX_CHARS) throw new Error(`note 太长了（${[...n].length} 字，上限 ${GO_TO_NOTE_MAX_CHARS}）。细节到那边再说，这里写要紧的。`);
  if (SENSITIVE_RE.test(n)) throw new Error('note 里有像令牌 / 密钥 / 本机路径的东西，这些不能带着走。');
  return {
    target: t,
    note: n,
    noteText: `【你自己从${fromLabel}带过来的】${n}`,
    wakeText: `这件事是你刚才${fromLabel}自己带过来的：${n}。这边做什么、怎么做你自己定。`
  };
}

/** qq_go_to target="list"：她现在能去的会话（key + 标题），没有标题就只给 key。 */
export function goToListText(items, { currentKey = '' } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((it) => it && it.key && it.key !== currentKey);
  if (!rows.length) return '现在没有别的会话可去。';
  return `你现在能去的会话：\n${rows.map((it) => `- ${it.key}${it.title ? `（${it.title}）` : ''}${it.sleeping ? '（你在睡觉：只会把话留在那边）' : ''}`).join('\n')}`;
}

/**
 * 睡到自然醒（2026-10-29 老大：「睡觉也不定死了，根据激素走」）：qq_sleep 不填时间（until、hours 都没有）、until 填 "natural" / "自然醒"、或 natural:true，就是睡到自然醒。
 * 睡多久由激素的睡眠压力决定（src/hormones.js naturalWakeDue），这里只管：要不要自然醒、最短 / 最长睡多久。
 * 她自己填了具体钟点或小时数的，照旧按她的（resolveSleepUntil）。
 */
export function wantsNaturalSleep({ until, hours, natural } = {}) {
  if (natural === true) return true;
  const u = String(until ?? '').trim().toLowerCase();
  if (u === 'natural' || u === '自然醒') return true;
  return (until === undefined || until === null || u === '') && (hours === undefined || hours === null || hours === '');
}

/** 自然醒这一觉的窗口：最短 minH 小时之前不醒，最长 maxH 小时一定醒（防故障，默认 14）。 */
export function naturalSleepWindow(nowMs, { minH = 1, maxH = SLEEP_MAX_HOURS } = {}) {
  return { untilMs: nowMs + maxH * 3600e3, minUntilMs: nowMs + minH * 3600e3, natural: true };
}

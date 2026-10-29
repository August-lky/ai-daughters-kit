// 实时区的内存环形缓冲（2026-10-29 老大：想在网页里看到她们此刻在干什么，包括思考原文）。
//
// 这个文件**故意不引入 fs**：思考、说出口的话、没说出口的话、工具参数都只放在内存里，
// 进程一重启就没了，绝不落盘（控制台施工单 A.1：「思考原文不落盘」）。测试里有源码断言，这个文件里不许出现 fs。
//
// 用法（小鲸鱼的 bridge.js 和姐姐的 sister.mjs 共用）：
//   const live = createLiveBuffer({ who: 'fish' });
//   live.ingestSessionEvent(key, sessionId, event)   // DSH 事件流里的一条 session/event
//   live.ingestClaudeLine(obj, ctx)                  // claude -p 的 stream-json 里的一行
//   live.add({ kind: 'sent', ... }) / live.serve(req, res)   // 直接加一条 / 开一条 SSE 给浏览器
//
// 条目（entry）：{ id, t, kind, session, label?, text?, name?, args?, ok?, callId?, turn?, step?, open? }
//   kind：turn-start 开始一轮 / think 思考（只有小鲸鱼；DeepSeek 公开返回的 reasoning）/ thinking 「正在想」记号（只有姐姐，没有内容，只有起止时间）/
//         text 她写的字 / tool-call 调工具 / tool-result 工具结果 /
//         turn-end 一轮结束 / sent 刚发出去的话 / unsaid 写了但没发出去的 / note 别的提示
// 往浏览器推的消息（SSE 的 event 名）：snapshot（刚连上，给全部）/ add（新条目）/ delta（某条目后面追加字）/ update（某条目的字段变了）。
//
// 日志式的安全：工具参数里像令牌、密码、Cookie 的字段一律打码（maskArgs），再截短。

const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_TEXT = 8000;
const SECRET_KEY_RE = /token|secret|passw|cookie|authorization|api[-_]?key|credential/i;

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 工具参数 → 一句摘要（打码、截短）。入参可以是对象，也可以是 JSON 字符串。 */
export function maskArgs(raw, max = 240) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return clip(raw.replace(/(token|secret|password|cookie)["':= ]+[^"',\s}]{4,}/gi, '$1=***'), max); }
  }
  const mask = (v, depth = 0) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return v.length > 160 ? `${v.slice(0, 159)}…` : v;
    if (typeof v !== 'object') return v;
    if (depth > 3) return '…';
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => mask(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '***' : mask(x, depth + 1);
    return out;
  };
  try { return clip(JSON.stringify(mask(obj)), max); } catch { return ''; }
}

/** SSE 一条消息。 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {object} o
 * @param {string} o.who 'fish' | 'sister'
 * @param {number} [o.maxEntries] 环形缓冲最多留多少条（旧的挤掉）
 * @param {number} [o.maxText] 单条文字最多多少字（超了留最后这么多）
 * @param {number} [o.maxClients] 同时最多几个浏览器连着
 * @param {() => number} [o.now]
 */
export function createLiveBuffer({ who = 'fish', maxEntries = DEFAULT_MAX_ENTRIES, maxText = DEFAULT_MAX_TEXT, maxClients = 8, now = Date.now, heartbeatMs = 15000 } = {}) {
  let seq = 0;
  /** @type {any[]} */
  let entries = [];
  const subs = new Set();
  const openByKey = new Map(); // 正在往后接字的条目：`${session}|${turn}|${step}|${index}|${kind}` → entry
  const calls = new Map(); // callId → 对应的 tool-call 条目（结果回来时标成败）
  const seenSteps = new Set(); // 已经收到过分块的 (session, turn, step, kind)，assistant/message 整条回来时不再重复加
  const stats = { added: 0, deltas: 0, dropped: 0 };

  const emit = (event, data) => { for (const fn of subs) { try { fn(event, data); } catch { /* 一个浏览器断了不影响别的 */ } } };

  function trim() {
    if (entries.length <= maxEntries) return;
    const cut = entries.length - maxEntries;
    const gone = entries.splice(0, cut);
    stats.dropped += gone.length;
    for (const g of gone) {
      for (const [k, v] of openByKey) if (v === g) openByKey.delete(k);
      for (const [k, v] of thinkMarks) if (v === g) thinkMarks.delete(k);
      if (g.callId !== undefined) calls.delete(String(g.callId));
    }
    if (seenSteps.size > 2000) seenSteps.clear();
  }

  /** 加一条。返回这一条（可以之后 update）。 */
  function add(entry) {
    const e = { id: ++seq, t: now(), ...entry };
    if (typeof e.text === 'string' && e.text.length > maxText) e.text = `…${e.text.slice(-maxText)}`;
    entries.push(e);
    stats.added += 1;
    trim();
    emit('add', e);
    return e;
  }

  /** 往一条正在写的条目后面接字（思考、文字的流式分块）。 */
  function appendDelta(openKey, base, text) {
    if (!text) return null;
    let e = openByKey.get(openKey);
    if (!e) {
      e = add({ ...base, text: '', open: true });
      openByKey.set(openKey, e);
    }
    let next = e.text + text;
    if (next.length > maxText) next = `…${next.slice(-maxText)}`;
    e.text = next;
    stats.deltas += 1;
    emit('delta', { id: e.id, text, full: next.length >= maxText ? next : undefined });
    return e;
  }

  function update(e, patch) {
    Object.assign(e, patch);
    emit('update', { id: e.id, ...patch });
  }

  function closeOpen(session) {
    for (const [k, e] of [...openByKey]) {
      if (!session || e.session === session) {
        openByKey.delete(k);
        if (e.open) update(e, { open: false });
      }
    }
  }

  /**
   * DSH 事件流里的一条 session/event（桥接 pumpMux 里调）。
   * label：会话的人话名字（可选）；永远不抛错。
   */
  function ingestSessionEvent(key, sessionId, event, { label = '', sendTool = () => false } = {}) {
    try {
      const type = event?.type;
      const d = event?.data ?? {};
      const base = { session: key, ...(label ? { label } : {}) };
      if (type === 'turn/start') {
        closeOpen(key);
        add({ ...base, kind: 'turn-start', turn: d.turn });
        return;
      }
      if (type === 'assistant/chunk') {
        const c = d.chunk ?? {};
        if (c.type === 'reasoning-delta' && c.text) {
          seenSteps.add(`${key}|${d.turn}|${d.step}|think`);
          appendDelta(`${key}|${d.turn}|${d.step}|${c.index}|think`, { ...base, kind: 'think', turn: d.turn, step: d.step }, c.text);
        } else if (c.type === 'text-delta' && c.text) {
          seenSteps.add(`${key}|${d.turn}|${d.step}|text`);
          appendDelta(`${key}|${d.turn}|${d.step}|${c.index}|text`, { ...base, kind: 'text', turn: d.turn, step: d.step }, c.text);
        }
        return;
      }
      if (type === 'assistant/message') {
        // 分块已经推过的就不再重复；没收到分块（重连、只给整条）时从整条消息里补
        const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
        for (const b of blocks) {
          if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text && !seenSteps.has(`${key}|${d.turn}|${d.step}|think`)) {
            add({ ...base, kind: 'think', turn: d.turn, step: d.step, text: b.text });
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text && !seenSteps.has(`${key}|${d.turn}|${d.step}|text`)) {
            add({ ...base, kind: 'text', turn: d.turn, step: d.step, text: b.text });
          }
        }
        closeOpen(key);
        return;
      }
      if (type === 'tool/call') {
        const name = String(d.name ?? '');
        const e = add({ ...base, kind: 'tool-call', name: name.replace(/^mcp__.+?__/, ''), fullName: name, args: maskArgs(d.arguments ?? d.input ?? ''), callId: d.callId, send: !!sendTool(name), turn: d.turn });
        if (d.callId !== undefined && d.callId !== null) calls.set(String(d.callId), { entry: e, raw: d.arguments ?? d.input ?? '' });
        return;
      }
      if (type === 'tool/result') {
        const msg = d.message ?? {};
        const callId = msg.source?.callId ?? msg.toolCallId;
        const block = Array.isArray(msg.content) ? msg.content[0] : null;
        const isError = msg.isError === true || block?.isError === true;
        const text = String(block?.text ?? block?.error ?? msg.error ?? '');
        const hit = callId !== undefined && callId !== null ? calls.get(String(callId)) : null;
        add({ ...base, kind: 'tool-result', name: hit?.entry?.name ?? '', callId, ok: !isError, text: clip(isError ? text : text.replace(/\s+/g, ' '), 400) });
        if (hit) {
          update(hit.entry, { ok: !isError, done: true });
          calls.delete(String(callId));
          // 发消息的工具成功了：记一条「刚发出去的」（正文从参数里取）
          if (!isError && hit.entry.send) {
            const said = sentTextOf(hit.raw);
            if (said) add({ ...base, kind: 'sent', text: said });
          }
        }
        return;
      }
      if (type === 'turn/end') {
        closeOpen(key);
        add({ ...base, kind: 'turn-end', turn: d.turn, text: String(d.reason?.kind ?? d.reason ?? '') });
      }
    } catch { /* 实时区坏了不能拖累她说话 */ }
  }

  /** 一轮结束时：她写了字、却没有调发送工具 → 记一条「没说出口的」。 */
  function noteUnsaid(key, text, { label = '' } = {}) {
    try {
      const t = String(text ?? '').trim();
      if (!t) return null;
      return add({ session: key, ...(label ? { label } : {}), kind: 'unsaid', text: t });
    } catch { return null; }
  }

  // ── 「正在想」记号（只给姐姐用）──
  // 2026-10-29 妈妈决定：姐姐的思考内容一个字都不采集（这一项触发了 Anthropic 的安全审核，按规矩去掉）。
  // 所以这里只记「她从什么时候开始想」：一条没有文字的 thinking 条目，开着的时候页面显示「正在想…（已 N 秒）」，
  // 她的下一步（说话 / 调工具）一到，就把它合上并记下想了几秒。thinking 块、thinking_delta 里的内容读都不读。
  const thinkMarks = new Map(); // session → 开着的 thinking 条目
  function beginThinking(base) {
    if (thinkMarks.has(base.session)) return;
    thinkMarks.set(base.session, add({ ...base, kind: 'thinking', open: true }));
  }
  function endThinking(session) {
    const m = thinkMarks.get(session);
    if (!m) return;
    thinkMarks.delete(session);
    update(m, { open: false, secs: Math.max(0, Math.round((now() - m.t) / 1000)) });
  }

  /**
   * claude -p（stream-json）里的一行（姐姐 sister.mjs 的 runClaude 里调）。
   * 只认：text（她写出来的话）、tool_use（调了什么）、tool_result（成败，成功的内容不留）、以及「正在想」的起止。
   * 整条 assistant 消息一次来一个步骤；如果以后开了 --include-partial-messages，text_delta 也认，thinking_delta 一律不读。
   */
  function ingestClaudeLine(x, { session = 'main', label = '', sendTool = () => false } = {}) {
    try {
      const base = { session, ...(label ? { label } : {}) };
      if (!x || typeof x !== 'object') return;
      if (x.type === 'system' && x.subtype === 'init') { closeOpen(session); add({ ...base, kind: 'turn-start' }); beginThinking(base); return; }
      if (x.type === 'stream_event') {
        const ev = x.event ?? {};
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') beginThinking(base);
        else if (ev.type === 'content_block_delta') {
          const dl = ev.delta ?? {};
          if (dl.type === 'text_delta' && dl.text) { endThinking(session); appendDelta(`${session}|${ev.index}|text`, { ...base, kind: 'text' }, dl.text); }
        }
        return;
      }
      if (x.type === 'assistant') {
        endThinking(session);
        const blocks = Array.isArray(x.message?.content) ? x.message.content : [];
        for (const c of blocks) {
          if (c?.type === 'text' && c.text) add({ ...base, kind: 'text', text: String(c.text) });
          else if (c?.type === 'tool_use') {
            const name = String(c.name ?? '');
            const e = add({ ...base, kind: 'tool-call', name: name.replace(/^mcp__.+?__/, ''), fullName: name, args: maskArgs(c.input ?? ''), callId: c.id, send: !!sendTool(name) });
            if (c.id) calls.set(String(c.id), { entry: e, raw: c.input ?? '' });
          }
          // thinking / redacted_thinking：不看、不记
        }
        closeOpen(session);
        return;
      }
      if (x.type === 'user' && Array.isArray(x.message?.content)) {
        let gotResult = false;
        for (const c of x.message.content) {
          if (c?.type !== 'tool_result') continue;
          gotResult = true;
          const hit = c.tool_use_id ? calls.get(String(c.tool_use_id)) : null;
          const ok = !c.is_error;
          // 姐姐这一栏只要「成败」：成功的返回内容不留；失败的留一小段，好知道为什么
          let why = '';
          if (!ok) {
            const body = Array.isArray(c.content) ? c.content.map((p) => p?.text ?? '').join('') : String(c.content ?? '');
            why = clip(body.replace(/\s+/g, ' '), 160);
          }
          add({ ...base, kind: 'tool-result', name: hit?.entry?.name ?? '', callId: c.tool_use_id, ok, ...(why ? { text: why } : {}) });
          if (hit) {
            update(hit.entry, { ok, done: true });
            calls.delete(String(c.tool_use_id));
            if (ok && hit.entry.send) { const said = sentTextOf(hit.raw); if (said) add({ ...base, kind: 'sent', text: said }); }
          }
        }
        if (gotResult) beginThinking(base); // 工具结果递回去了，她在想下一步
        return;
      }
      if (x.type === 'result') {
        endThinking(session);
        closeOpen(session);
        add({ ...base, kind: 'turn-end', text: x.is_error ? '出错' : 'completed' });
      }
    } catch { /* 同上 */ }
  }

  /** 一轮不管怎么结束（超时、被杀、出错）都调一下，把还开着的「正在想」合上。 */
  function endTurn(session) {
    try { endThinking(session); closeOpen(session); } catch { /* 同上 */ }
  }

  /** 开一条 SSE。replay：刚连上时先把现有的给他。 */
  function serve(req, res, { replay = true, extra = null } = {}) {
    if (subs.size >= maxClients) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: '同时看的页面太多了，关掉几个再试' }));
      return false;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(`retry: 3000\n\n`);
    if (replay) res.write(sseFrame('snapshot', { who, entries, ...(extra ? extra() : {}) }));
    const fn = (event, data) => { res.write(sseFrame(event, data)); };
    subs.add(fn);
    const beat = setInterval(() => { try { res.write(`: ${now()}\n\n`); } catch { /* 断了 */ } }, heartbeatMs);
    beat.unref?.();
    const done = () => { clearInterval(beat); subs.delete(fn); };
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    return true;
  }

  return {
    who,
    add,
    update,
    appendDelta,
    closeOpen,
    ingestSessionEvent,
    ingestClaudeLine,
    endTurn,
    noteUnsaid,
    serve,
    /** 最近的条目（新的在后）。kinds 不传 = 全部。 */
    recent(limit = 100, kinds = null) {
      const list = kinds ? entries.filter((e) => kinds.includes(e.kind)) : entries;
      return list.slice(-Math.max(1, limit)).map((e) => ({ ...e }));
    },
    clear() { entries = []; openByKey.clear(); calls.clear(); seenSteps.clear(); thinkMarks.clear(); },
    stats() { return { ...stats, size: entries.length, clients: subs.size, max: maxEntries }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  };
}

/** 发消息工具的参数里取出她说的话（messages 数组、message、text 都认）。 */
export function sentTextOf(raw) {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { return ''; } }
  if (!obj || typeof obj !== 'object') return '';
  const m = obj.messages ?? obj.message ?? obj.text ?? obj.content;
  const list = Array.isArray(m) ? m : [m];
  return list.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).filter(Boolean).join(' / ').slice(0, 600);
}

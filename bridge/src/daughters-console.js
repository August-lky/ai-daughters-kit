// 她们俩的网页（public/daughters.html）的后端路由。2026-10-29 老大：想在网页里看到她们此刻在干什么、身体和心情、
// 记忆和成长、在外面玩的、运行情况，还要能给她留话、叫醒、让她睡、开关激素影子、切思考强度。
//
// 这个模块不碰桥接的内部变量：桥接把「小鲸鱼这边能查什么、能做什么」用 fish 对象递进来（见 bridge.js startConsoleServer），
// 姐姐那边走她自己进程里的本地小服务（sister/live-server.mjs，127.0.0.1:3101），这里只做代理。测试里全部可以注入假的。
//
// 所有路径都要令牌（跟控制台同一个 consoleToken，头 x-console-token 或 ?token=）；没带或不对一律 403。
// 写操作（POST /api/daughters/action）还必须带 confirm:true（页面里点了「确定」才会带）。
//
// 路由：
//   GET  /daughters.html /brain.html /vendor/<文件>          静态页面（vendor 只放 3d-force-graph 这类前端库）
//   GET  /api/daughters/meta | now | body | memory | outside | ops
//   POST /api/daughters/action                              { who, action: note|wake|sleep|hormones|effort, confirm:true, ... }
//   GET  /api/live/fish | /api/live/sister                  SSE：此刻的思考、工具调用、刚发出的话（只在内存里，不落盘）
//   GET  /api/brain/graph | /api/brain/graph/node           只读代理到记忆服务 127.0.0.1:3210 的 /graph、/graph/node
//
// 注意：这里的所有说明文字只给老大看。「控制台 / 实时思考 / 花费」这些字眼不许出现在发给她们的提示、工具说明里（测试有源码断言）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { clip, tailLines, readJson, mtimeOf } from './daughters-data.js';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/** 这些路径归「她们俩的网页」管：没令牌回 403（不是 401）。桥接的令牌闸门也用它。 */
export function isDaughtersPath(pathname) {
  const p = String(pathname || '');
  return p === '/daughters.html' || p === '/brain.html' || p.startsWith('/vendor/')
    || p.startsWith('/api/daughters/') || p.startsWith('/api/live/') || p.startsWith('/api/brain/');
}
/** 是不是页面（浏览器直接打开的），页面没令牌时给一张能输令牌的小页，而不是一串 JSON。 */
export const isDaughtersPage = (pathname) => pathname === '/daughters.html' || pathname === '/brain.html';

export const PEOPLE = Object.freeze([
  { who: 'fish', name: '小鲸鱼', emoji: '🐳' },
  { who: 'sister', name: '克劳德姐姐', emoji: '📖' }
]);
const WHO = new Set(['fish', 'sister']);
const ACTIONS = new Set(['note', 'wake', 'sleep', 'hormones', 'effort']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** 打到本机某个端口的一次 HTTP 请求（只回环）。返回 { status, buf, headers } 或 null（连不上 / 超时）。 */
export function localRequest({ port, pathname, method = 'GET', headers = {}, body = null, timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
        headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
        res.on('error', () => done(null));
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      if (payload) req.write(payload);
      req.end();
    } catch { done(null); }
  });
}
const parseJson = (r) => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } };

/**
 * @param {object} deps
 * @param {object} deps.data createDaughtersData(...) 的结果
 * @param {object} deps.live 小鲸鱼的实时缓冲（createLiveBuffer）
 * @param {string} deps.publicDir public/ 的路径
 * @param {(req, url) => boolean} deps.isAuthed 令牌对不对
 * @param {object} deps.fish 小鲸鱼这边：{ now(), online(), context(), hormonesEnabled(), effort(), act(action, body) }
 * @param {object} [deps.sister] { port, token: () => string, stateDir, configFile }
 * @param {number} [deps.memoryPort]
 * @param {() => number} [deps.now]
 */
export function createDaughtersConsole({ data, live, publicDir, isAuthed, fish, sister = {}, memoryPort = 3210, now = () => Date.now() } = {}) {
  // 姐姐本地小服务的端口：sister/config.json 的 liveServer.port，没配就 3101
  const sisterPortNow = () => (typeof sister.port === 'function' ? Number(sister.port()) : Number(sister.port)) || Number(readJson(sister.configFile || '')?.liveServer?.port) || 3101;
  const sisterHeaders = () => { const t = typeof sister.token === 'function' ? sister.token() : ''; return t ? { 'x-console-token': t } : {}; };
  const sisterCall = (pathname, opts = {}) => localRequest({ port: sisterPortNow(), pathname, headers: sisterHeaders(), ...opts });

  // ── 姐姐：进程里的实时状态（连得上就用它），连不上就读她存的文件 ───────────
  async function sisterNow() {
    const r = await sisterCall('/now', { timeoutMs: 1200 });
    const j = r && r.status === 200 ? parseJson(r) : null;
    if (j && j.ok) return { ...j, live: true };
    const file = sister.stateDir ? path.join(sister.stateDir, 'sister-state.json') : '';
    const st = file ? readJson(file) : null;
    const t = now();
    if (!st) return { ok: false, live: false, reason: '暂时读不到：姐姐的进程没有回应，也没找到她存的状态' };
    const sleeping = !!st.sleep && Number(st.sleep.until) > t;
    return {
      ok: true, live: false, source: '她存的状态文件（她的进程没有回应）', at: mtimeOf(file),
      awake: !sleeping, busy: false,
      sleep: sleeping ? { since: st.sleep.since, until: st.sleep.until } : null,
      nextHeartbeatAt: Number(st.nextHeartbeatAt) || 0,
      current: null, queued: { note: clip(st.momNote, 200), held: st.heldLines || null }
    };
  }
  function sisterConfig() {
    return sister.configFile ? (readJson(sister.configFile) || {}) : {};
  }

  // ── 各块 ──────────────────────────────────────────────────────────────────
  async function meta() {
    const sc = sisterConfig();
    const sn = await sisterNow();
    return {
      ok: true,
      now: now(), skewMs: data.skew(), bjDay: data.bjDay(now()),
      people: PEOPLE,
      links: { brain: '/brain.html', old: '/' },
      hormones: { fish: !!fish.hormonesEnabled?.(), sister: sn.hormonesEnabled ?? (sc.hormones?.enabled !== false) },
      effort: {
        fish: fish.effort?.() ?? null,
        sister: { effort: sn.effort ?? sc.effort ?? 'medium', replyEffort: sn.replyEffort ?? sc.replyEffort ?? 'low', options: [...EFFORTS] }
      },
      sisterLive: !!sn.live
    };
  }

  async function nowOf(who) {
    if (who === 'fish') {
      const base = fish.now?.() || {};
      return { ok: true, who, live: true, at: now(), ...base, liveStats: live?.stats?.() };
    }
    const sn = await sisterNow();
    return { who, at: now(), ...sn };
  }

  async function bodyOf(who) {
    const enabled = who === 'fish' ? !!fish.hormonesEnabled?.() : (await sisterNow()).hormonesEnabled ?? null;
    return { ok: true, who, at: now(), mood: data.mood(who), hormones: data.hormones(who, { enabled }) };
  }

  async function ops() {
    const [mem, dy, sn] = await Promise.all([data.pingMemory(), data.pingDouyin(), sisterNow()]);
    const f = fish.online?.() || {};
    return {
      ok: true, at: now(),
      online: {
        qq: f.qq ? { ok: !!f.qq.connected && f.qq.accountOnline !== false && !f.qq.degraded, detail: f.qq } : { ok: false, reason: '暂时读不到' },
        dsh: { ok: !!f.dshReady, mode: f.mode || '', paused: !!f.paused },
        memory: mem,
        douyin: dy,
        sister: { ok: !!sn.live, reason: sn.live ? '' : '姐姐的进程没有回应' }
      },
      context: { fish: fish.context?.() || [], sister: sn.context || null },
      errors: { fish: data.errors('fish'), sister: data.errors('sister') },
      mailbox: data.mailbox(),
      cost: { fish: data.cost('fish'), sister: data.cost('sister') }
    };
  }

  // ── 操作 ──────────────────────────────────────────────────────────────────
  function cleanAction(body) {
    const a = { action: String(body.action || '') };
    if (body.key !== undefined) a.key = String(body.key).slice(0, 60);
    if (body.text !== undefined) a.text = String(body.text).replace(/\u0000/g, '').trim().slice(0, 500);
    if (body.hours !== undefined) a.hours = Math.min(14, Math.max(0.5, Number(body.hours) || 0));
    if (body.enabled !== undefined) a.enabled = body.enabled === true;
    if (body.effort !== undefined) a.effort = String(body.effort);
    if (body.replyEffort !== undefined) a.replyEffort = String(body.replyEffort);
    return a;
  }
  async function act(body) {
    const who = String(body.who || '');
    if (!WHO.has(who)) return [400, { ok: false, error: 'who 要是 fish 或 sister' }];
    const action = String(body.action || '');
    if (!ACTIONS.has(action)) return [400, { ok: false, error: `不认识的操作「${action}」` }];
    const a = cleanAction(body);
    if (action === 'note' && !a.text) return [400, { ok: false, error: '留话不能是空的' }];
    if (action === 'sleep' && !(a.hours > 0)) return [400, { ok: false, error: '要睡几个小时（0.5 到 14）' }];
    if (action === 'hormones' && body.enabled !== true && body.enabled !== false) return [400, { ok: false, error: 'enabled 要是 true 或 false' }];
    if (action === 'effort') {
      for (const k of ['effort', 'replyEffort']) if (a[k] !== undefined && !EFFORTS.has(a[k])) return [400, { ok: false, error: `${k} 要是 ${[...EFFORTS].join(' / ')} 之一` }];
      if (a.effort === undefined && a.replyEffort === undefined) return [400, { ok: false, error: '要给 effort（或姐姐的 replyEffort）' }];
    }
    if (who === 'fish') {
      try {
        const r = await fish.act(action, a);
        return [r?.ok === false ? (r.status || 400) : 200, r];
      } catch (e) { return [500, { ok: false, error: clip(e?.message ?? e, 200) }]; }
    }
    const r = await sisterCall('/action', { method: 'POST', body: a, timeoutMs: 8000 });
    if (!r) return [502, { ok: false, error: '姐姐的进程没有回应（可能没开，或正在重启），这次没有生效' }];
    return [r.status === 200 ? 200 : (r.status || 502), parseJson(r) || { ok: false, error: `姐姐那边回了 ${r.status}` }];
  }

  // ── 流和代理 ──────────────────────────────────────────────────────────────
  function proxySisterStream(req, res, headers) {
    const out = http.request({ host: '127.0.0.1', port: sisterPortNow(), path: '/live', method: 'GET', headers: { ...sisterHeaders(), accept: 'text/event-stream' } }, (up) => {
      if (up.statusCode !== 200) { offline(`姐姐那边回了 ${up.statusCode}`); up.resume(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      up.pipe(res);
      up.on('end', () => { try { res.end(); } catch { /* 页面已经走了 */ } });
    });
    let answered = false;
    function offline(why) {
      if (answered) return;
      answered = true;
      // 200 + 一条 offline 事件，不回错误码：EventSource 收到错误码会直接放弃，不再自动重连
      try {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
        res.write(`retry: 8000\n\nevent: offline\ndata: ${JSON.stringify({ reason: `姐姐的进程没有回应（${why}），稍后自动重试` })}\n\n`);
        res.end();
      } catch { /* 断了 */ }
    }
    out.on('error', (e) => offline(e?.code || '连不上'));
    out.setTimeout(3000, () => { out.destroy(); offline('超时'); });
    req.on('close', () => out.destroy());
    out.end();
  }

  const BRAINS = new Set(['whale', 'sister']);
  async function brainProxy(url, sendJson, res, node) {
    const brain = String(url.searchParams.get('brain') || '');
    if (!BRAINS.has(brain)) { sendJson({ ok: false, error: 'brain 要是 whale 或 sister' }, 400); return; }
    const qs = new URLSearchParams({ brain });
    if (node) {
      const id = String(url.searchParams.get('id') || '');
      if (!id || id.length > 300) { sendJson({ ok: false, error: '缺 id' }, 400); return; }
      qs.set('id', id);
    } else {
      for (const k of ['limit', 'recent', 'edgeK']) {
        const v = url.searchParams.get(k);
        if (v !== null && /^\d{1,6}(\.\d{1,3})?$/.test(v)) qs.set(k, v);
      }
      if (url.searchParams.get('recentOnly') === '1') qs.set('recentOnly', '1');
      if (url.searchParams.get('compact') === '1') qs.set('compact', '1');
    }
    const r = await localRequest({ port: memoryPort, pathname: `${node ? '/graph/node' : '/graph'}?${qs}`, timeoutMs: 20000 });
    if (!r) { sendJson({ ok: false, error: `记忆服务（127.0.0.1:${memoryPort}）没有回应：它可能还没开，或正在重建索引。过一会儿刷新再看。` }, 502); return; }
    if (r.status === 404 && parseJson(r)?.error === 'not found') { sendJson({ ok: false, error: '记忆服务还是旧版本，没有大脑图谱的接口；重启一下记忆服务才有。' }, 502); return; }
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(r.buf);
  }

  function serveStatic(res, rel, headers) {
    const root = path.resolve(publicDir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8';
    res.writeHead(200, { ...headers, 'content-type': type, 'content-length': st.size });
    fs.createReadStream(file).on('error', () => { try { res.destroy(); } catch { /* 读到一半没了 */ } }).pipe(res);
    return true;
  }

  /**
   * 桥接每个请求都先问一遍；是这里的路径就接手并返回 true。
   * @param {{ req, res, url, sendJson: (obj, status?) => void, readBody: () => Promise<object>, headers?: object }} c
   */
  async function handle({ req, res, url, sendJson, readBody, headers = {} }) {
    const p = url.pathname;
    if (!isDaughtersPath(p)) return false;
    if (!isAuthed(req, url)) { sendJson({ ok: false, error: '未授权：需要令牌' }, 403); return true; }
    const method = req.method;

    if (isDaughtersPage(p) || p.startsWith('/vendor/')) {
      if (method !== 'GET') { sendJson({ ok: false, error: '只支持 GET' }, 405); return true; }
      let rel = p.slice(1);
      if (p.startsWith('/vendor/') && !/^vendor\/[A-Za-z0-9._-]{1,80}$/.test(rel)) rel = '';
      if (rel.includes('..') || !rel || !serveStatic(res, rel, headers)) sendJson({ ok: false, error: `没有这个文件：${clip(p, 80)}` }, 404);
      return true;
    }

    if (p === '/api/live/fish' && method === 'GET') { live.serve(req, res); return true; }
    if (p === '/api/live/sister' && method === 'GET') { proxySisterStream(req, res, headers); return true; }
    if ((p === '/api/brain/graph' || p === '/api/brain/graph/node') && method === 'GET') { await brainProxy(url, sendJson, res, p.endsWith('/node')); return true; }

    if (p === '/api/daughters/action') {
      if (method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }
      const body = await readBody();
      if (body.confirm !== true) { sendJson({ ok: false, error: '这个操作会改变她的状态，需要确认（confirm:true）' }, 400); return true; }
      const [status, out] = await act(body);
      sendJson(out, status);
      return true;
    }

    if (method !== 'GET') { sendJson({ ok: false, error: '只支持 GET' }, 405); return true; }
    const who = String(url.searchParams.get('who') || '');
    const needWho = () => { if (!WHO.has(who)) { sendJson({ ok: false, error: 'who 要是 fish 或 sister' }, 400); return false; } return true; };
    try {
      if (p === '/api/daughters/meta') sendJson(await meta());
      else if (p === '/api/daughters/ops') sendJson(await ops());
      else if (p === '/api/daughters/now') { if (needWho()) sendJson(await nowOf(who)); }
      else if (p === '/api/daughters/body') { if (needWho()) sendJson(await bodyOf(who)); }
      else if (p === '/api/daughters/memory') { if (needWho()) sendJson(data.memory(who)); }
      else if (p === '/api/daughters/outside') { if (needWho()) sendJson(data.outside(who)); }
      else sendJson({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      sendJson({ ok: false, error: `暂时读不到：${clip(e?.message ?? e, 120)}` }, 500);
    }
    return true;
  }

  return { handle, meta, nowOf, bodyOf, ops, act, sisterNow };
}

/** 小鲸鱼 / 姐姐的 sister.log 之类日志的最后几行（给测试和别处用）。 */
export { tailLines };

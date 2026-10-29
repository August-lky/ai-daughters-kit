// 姐姐进程里的本地小服务（2026-10-29 老大：想在页面里看姐姐此刻在干什么，还能给她留话、叫醒、让她睡）。
//
// 为什么放在姐姐自己的进程里：姐姐的状态（睡着没、候着的进程、排队的留话）都在 sister.mjs 的内存里，
// 外面直接改 sister-state.json 会被她下一次 saveState 覆盖。所以桥接上的页面接口只做代理，真正的读写在这里。
//
// 只监听 127.0.0.1（端口 sister/config.json 的 liveServer.port，默认 3101）；每个请求都要令牌（跟桥接同一个，
// 头 x-console-token 或 ?token=），没带或不对一律 403；Host 头不是本机的也拒（防 DNS 重绑定）。
//   GET  /now      此刻的状态（醒着没、睡到几点、下次自己醒、正在跟谁说话、排队的留话、思考强度……）
//   GET  /live     SSE：她说出口的话、调的工具和成败、「正在想（已 N 秒）」、没说出口的（只在内存里，不落盘）
//   POST /action   { action: note|wake|sleep|hormones|effort, ... }，桥接那一头已经验过 confirm:true
//
// 注意：她的思考内容不采集（见 src/live-buffer.js 的 ingestClaudeLine）；这里的所有说明文字只给老大看，
// 「控制台 / 实时思考 / 网页」这些字眼不许出现在发给她的提示里（测试有源码断言）。
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 16 * 1024;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** 令牌：桥接 state/console-token，或 config.json 里写了合法的 consoleToken（跟桥接取令牌的规则一致）。 */
export function readAcceptedTokens({ tokenFile, bridgeConfigFile } = {}) {
  const out = [];
  try {
    const c = String(JSON.parse(fs.readFileSync(bridgeConfigFile, 'utf8')).consoleToken ?? '').trim();
    if (c.length >= 16 && c.length <= 128 && /^[A-Za-z0-9_-]+$/.test(c)) out.push(c);
  } catch { /* 没配 */ }
  try { const f = fs.readFileSync(tokenFile, 'utf8').trim(); if (f) out.push(f); } catch { /* 没有 */ }
  return out;
}
function tokenMatches(supplied, accepted) {
  const a = Buffer.from(String(supplied ?? ''), 'utf8');
  return accepted.some((t) => {
    const b = Buffer.from(String(t), 'utf8');
    return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/**
 * @param {object} o
 * @param {object} o.live createLiveBuffer({ who: 'sister' })
 * @param {() => string[]} o.acceptedTokens 现在认哪些令牌
 * @param {() => object} o.getNow 此刻的状态（见 buildNow）
 * @param {(action: string, a: object) => Promise<object>} o.act 动手的函数（见 createSisterActions）
 * @param {number} [o.port]
 * @param {(...a) => void} [o.log]
 */
export function createSisterLive({ live, acceptedTokens, getNow, act, port = 3101, log = () => {} } = {}) {
  const sendJson = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(obj));
  };
  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); resolve(null); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  async function handle(req, res) {
    try {
      if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) { sendJson(res, 403, { ok: false, error: '只接受本机来的请求' }); return; }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const supplied = req.headers['x-console-token'] ?? url.searchParams.get('token') ?? '';
      let tokens = [];
      try { tokens = acceptedTokens(); } catch { tokens = []; }
      if (!tokenMatches(Array.isArray(supplied) ? supplied[0] : supplied, tokens)) { sendJson(res, 403, { ok: false, error: '未授权：需要令牌' }); return; }
      if (req.method === 'GET' && url.pathname === '/now') { sendJson(res, 200, { ok: true, ...getNow() }); return; }
      if (req.method === 'GET' && url.pathname === '/live') { live.serve(req, res); return; }
      if (req.method === 'POST' && url.pathname === '/action') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: '请求内容不对' }); return; }
        const out = await act(String(body.action || ''), body);
        sendJson(res, out?.ok === false ? (out.status || 400) : 200, out);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      try { sendJson(res, 500, { ok: false, error: clip(e?.message ?? e, 160) }); } catch { /* 连接已断 */ }
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on('error', (e) => log(`本地小服务没起来（${e?.code || e?.message}），页面上看不到姐姐的实时状态；不影响她干活`));
  return {
    server, handle,
    listen() { server.listen(port, '127.0.0.1', () => log(`本地小服务监听 127.0.0.1:${port}`)); return server; },
    close() { try { server.close(); } catch { /* 已经关了 */ } }
  };
}

/** 此刻的状态：纯函数，ctx 全是取值函数，测试里可以塞假的。 */
export function buildNow(ctx) {
  const t = ctx.nowMs();
  const st = ctx.getState();
  const sleeping = !!st.sleep && t < Number(st.sleep.until);
  const cfg = ctx.getConfig();
  const cur = ctx.current?.() || null;
  return {
    source: '姐姐进程里的实时状态',
    live: true, at: t,
    awake: !sleeping,
    sleep: sleeping ? { since: st.sleep.since, until: st.sleep.until, ...(st.sleep.natural ? { natural: true } : {}) } : null,
    nextHeartbeatAt: Number(st.nextHeartbeatAt) || 0,
    nextOwnerWakeAt: Number(st.nextHeartbeatAt) || 0,
    busy: !!(ctx.busy?.()),
    resting: Number(ctx.busyUntil?.()) > t ? { until: Number(ctx.busyUntil()) } : null,
    current: cur ? { key: cur.key, label: cur.label, since: cur.since, effort: cur.effort, busy: true } : null,
    sessions: [],
    hormonesEnabled: !!ctx.hormonesEnabled?.(),
    effort: cfg.effort || 'medium',
    replyEffort: cfg.replyEffort || 'low',
    context: ctx.context?.() || null,
    queued: {
      wakeNotes: (Array.isArray(st.ownerNotes) ? st.ownerNotes : []).slice(-5).map((n) => ({ text: clip(n.text, 200), at: Number(n.at) || 0 })),
      pendingWakes: ctx.pending?.() || [],
      held: st.heldLines?.lines?.length ? { to: st.heldLines.to, lines: st.heldLines.lines.map((l) => clip(l, 120)) } : null
    }
  };
}

/**
 * 动手的函数（note / wake / sleep / hormones / effort）。ctx 里是 sister.mjs 的真东西，测试里换假的：
 *   getState() saveState() getConfig() persistConfig(patchFn) nowMs() asleep() busy() busyUntil()
 *   hormoneFeed { setEnabled } startHormoneTimers() syncHormoneSleep() wakeUp(prompt) enqueueWake(fn) log()
 * 写配置只通过 persistConfig（测试里指向临时文件，绝不碰活的 config.json）。
 */
export function createSisterActions(ctx) {
  const hoursOf = (a) => Math.min(14, Math.max(0.5, Number(a.hours) || 0));
  return async function act(action, a) {
    const st = ctx.getState();
    const t = ctx.nowMs();
    if (action === 'note') {
      const text = String(a.text ?? '').replace(/\u0000/g, '').trim().slice(0, 500);
      if (!text) return { ok: false, error: '留话不能是空的' };
      st.ownerNotes = [...(Array.isArray(st.ownerNotes) ? st.ownerNotes : []), { text, at: t }].slice(-5);
      ctx.saveState(st);
      ctx.log(`老大留了一句话（${text.length} 字）`);
      return { ok: true, message: '记下了：她下一次醒来（或下一次被叫起来）会看到' };
    }
    if (action === 'sleep') {
      const h = hoursOf(a);
      if (!(h > 0)) return { ok: false, error: '要睡几个小时（0.5 到 14）' };
      const until = t + h * 3600e3;
      st.sleep = { since: t, until };
      st.nextHeartbeatAt = until;
      ctx.saveState(st);
      try { ctx.syncHormoneSleep?.(); } catch { /* 记不下就算了 */ }
      ctx.log(`老大说该睡了：睡 ${h} 小时`);
      return { ok: true, until, hours: h, message: `让她睡了（大约 ${h} 小时）；她正在说话的这一轮说完才会躺下` };
    }
    if (action === 'wake') {
      if (ctx.busy?.()) return { ok: false, error: '她正在忙一轮（想着或说着），等这一轮说完再叫' };
      if (Number(ctx.busyUntil?.()) > t) return { ok: false, error: '她那边刚出过错，正在歇着，过一会儿再叫' };
      const was = ctx.asleep();
      if (was) { st.sleep = null; ctx.saveState(st); try { ctx.syncHormoneSleep?.(); } catch { /* 同上 */ } }
      ctx.enqueueWake(was);
      ctx.log(`老大叫她起来看看${was ? '（她本来在睡）' : ''}`);
      return { ok: true, wasSleeping: !!was, message: was ? '叫醒了' : '叫她出来看看了' };
    }
    if (action === 'hormones') {
      const on = ctx.hormoneFeed.setEnabled(a.enabled === true, { asleepNow: ctx.asleep() });
      if (on) { try { ctx.startHormoneTimers(); } catch { /* 同上 */ } }
      try { const c = ctx.getConfig(); c.hormones = { ...(c.hormones ?? {}), enabled: a.enabled === true }; } catch { /* 同上 */ }
      try { ctx.persistConfig((c) => ({ ...c, hormones: { ...(c.hormones ?? {}), enabled: a.enabled === true } })); }
      catch (e) { ctx.log(`激素开关写进配置失败（这次热切换有效，重启后会回到旧值）：${e?.message ?? e}`); }
      ctx.log(`激素影子记录${on ? '开' : '关'}`);
      return { ok: true, enabled: on, message: on ? '影子记录开了（只记录，不影响她做事）' : '影子记录关了（已经记下的留着）' };
    }
    if (action === 'effort') {
      const patch = {};
      for (const k of ['effort', 'replyEffort']) {
        if (a[k] === undefined) continue;
        if (!EFFORTS.has(String(a[k]))) return { ok: false, error: `${k} 要是 ${[...EFFORTS].join(' / ')} 之一` };
        patch[k] = String(a[k]);
      }
      if (!Object.keys(patch).length) return { ok: false, error: '要给 effort 或 replyEffort' };
      Object.assign(ctx.getConfig(), patch);
      try { ctx.persistConfig((c) => ({ ...c, ...patch })); }
      catch (e) { ctx.log(`思考强度写进配置失败（这次有效，重启后会回到旧值）：${e?.message ?? e}`); }
      ctx.log(`思考强度改成 ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join('、')}`);
      return { ok: true, ...patch, message: `改好了（${Object.entries(patch).map(([k, v]) => `${k === 'effort' ? '自己醒时' : '回话时'} ${v}`).join('，')}），下一次起新进程时生效` };
    }
    return { ok: false, error: `不认识的操作：${action}` };
  };
}

/** 读—改—原子写一个 JSON 配置（保持缩进 2）。测试里给临时文件。 */
export function persistJsonConfig(file, patchFn) {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const next = patchFn(cur);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

// 抖音页面看门（2026-10-25 主人同意）。
// 她刷视频、收私信共用抖音插件那个 Edge 里的「精选」页。这一页从来不刷新，刷一整天会攒出上千万个元素
// （10-25 实测 1200 万个、JS 堆 2.4GB、进程 12GB 内存）。页面卡死以后截图超时、私信会话列表等不出来，
// 联系人被插件自动暂停。这里每隔一阵通过 Edge 的调试端口看一眼每个抖音页面，元素或内存超线、
// 并且她这会儿没在刷视频、也没在跑回合，就把那一页重新加载一下（等于按 F5）。只读指标和重新加载，不点不填。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DOUYIN_WATCHDOG = {
  enabled: true,
  port: 9227,
  everyMin: 30,
  settingsUrl: 'http://127.0.0.1:3080/api/douyin-browser/state',
  maxNodes: 1_000_000,
  maxHeapMB: 1500,
  // 专用 Edge 总内存到了这个数就整个重开（刷新不还内存）
  maxEdgeGB: 5,
  // 2026-10-26 主人：「到 5GB 就应该完全终止抖音专用 Edge 全部进程然后重启」。原来 30 分钟才看一次、她一忙就一直往后推，
  // 10-26 早上涨到 10.78GB 还在「先不动」。内存改成每 memEveryMin 分钟看一次；她在忙最多等 maxBusyDeferMin 分钟，过了照样重开。
  memEveryMin: 2,
  // 10-26 下午：等的这 3 分钟里截图就开始超时了（13:43，5.1GB），改成 1 分钟：只够手上那条私信发完
  maxBusyDeferMin: 1,
  // 插件的自主观看锁：在就说明她正在刷，不动
  watchLock: path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state', 'watch-loop.lock')
};

/** 一页该不该刷新：返回原因字符串，或 null。 */
export function reloadReason({ nodes, heapMB }, { maxNodes, maxHeapMB }) {
  if (Number(nodes) > maxNodes) return `页面元素 ${Math.round(nodes / 1e4)} 万个`;
  if (Number(heapMB) > maxHeapMB) return `JS 内存 ${Math.round(heapMB)} MB`;
  return null;
}

function cdpSession(wsUrl, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连不上页面调试口'));
    setTimeout(() => reject(new Error('连页面调试口超时')), timeoutMs);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n;
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(`${method} 超时`)); }, timeoutMs);
    function on(ev) {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', on);
      if (m.error) reject(new Error(m.error.message || method)); else resolve(m.result);
    }
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { opened, call, close: () => { try { ws.close(); } catch { /* 已经关了 */ } } };
}

/** 插件这会儿在生成 / 发私信回复（state.chat.busy）就别刷新。读不到当作不忙。 */
async function chatBusy(cfg, fetchImpl) {
  try {
    const j = await (await fetchImpl(cfg.settingsUrl, { signal: AbortSignal.timeout(5000) })).json();
    return Boolean(j?.chat?.busy || j?.chat?.starting);
  } catch { return false; }
}

/**
 * 私信开着就先停、做完 fn 再开（2026-10-26 18:49）：私信服务一直在这几页上轮询，直接刷新正好撞上它找会话，
 * 「没有找到抖音消息入口」「指定联系人已变化」，两个联系人都被插件暂停。停 / 开走插件设置页同样的接口，
 * 开的时候插件重新建基线，不会重发旧消息。读不到状态就当私信没开，照做 fn。
 */
export async function withChatPaused({ cfg = DEFAULT_DOUYIN_WATCHDOG, fetchImpl = fetch, wait = sleep } = {}, fn) {
  const base = cfg.settingsUrl.replace(/\/state$/, '');
  const state = async () => (await fetchImpl(`${base}/state`, { signal: AbortSignal.timeout(10000) })).json();
  let s0 = null;
  try { s0 = await state(); } catch { /* 插件没开 */ }
  if (!s0?.chat?.running) return fn();
  const post = async (p) => (await fetchImpl(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-douyin-settings-token': s0.token }, body: '{}', signal: AbortSignal.timeout(60000) })).ok;
  for (let i = 0; i < 30 && (await state()).chat?.busy; i++) await wait(2000);
  await post('/chat/stop');
  try { return await fn(); } finally {
    await wait(5000); // 等页面重新加载出来
    for (let i = 0; i < 3; i++) {
      await post('/chat/start');
      if ((await state()).chat?.running) break;
      await wait(3000);
    }
  }
}

/**
 * 看一轮。isBusy()：她这会儿在跑回合就返回 true（不打断她手上的抖音操作）。
 * 返回 [{ id, title, nodes, heapMB, reloaded, reason }]，调试口连不上返回 []。
 */
export async function checkDouyinPages({ cfg = DEFAULT_DOUYIN_WATCHDOG, isBusy = () => false, log = () => {}, fetchImpl = fetch } = {}) {
  let list;
  try {
    list = await (await fetchImpl(`http://127.0.0.1:${cfg.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  } catch { return []; } // 抖音浏览器没开
  const out = [];
  for (const t of list.filter((x) => x.type === 'page' && /douyin\.com/.test(String(x.url)))) {
    const s = cdpSession(t.webSocketDebuggerUrl);
    try {
      await s.opened;
      await s.call('Performance.enable');
      const { metrics = [] } = await s.call('Performance.getMetrics');
      const get = (name) => Number(metrics.find((m) => m.name === name)?.value) || 0;
      const row = { id: t.id, title: String(t.title || '').slice(0, 30), nodes: get('Nodes'), heapMB: get('JSHeapUsedSize') / 2 ** 20, reloaded: false, reason: reloadReason({ nodes: get('Nodes'), heapMB: get('JSHeapUsedSize') / 2 ** 20 }, cfg) };
      if (row.reason) {
        if (fs.existsSync(cfg.watchLock)) row.skipped = '她正在刷视频';
        else if (await isBusy()) row.skipped = '她正在忙';
        else if (await chatBusy(cfg, fetchImpl)) row.skipped = '私信正在回';
        else { await withChatPaused({ cfg, fetchImpl }, () => s.call('Page.reload', {})); row.reloaded = true; }
        log(`[douyin-watchdog] 「${row.title}」${row.reason}，${row.reloaded ? '刷新了一下' : `先不动（${row.skipped}）`}`);
      }
      out.push(row);
    } catch (error) {
      log(`[douyin-watchdog] 看「${String(t.title || '').slice(0, 20)}」没看成：${error?.message ?? error}`);
    } finally { s.close(); }
  }
  return out;
}

// ── 整个重开（2026-10-25）：页面刷新不还内存——10-25 晚刷新后页面只剩 200MB，渲染进程还攥着 10GB，
// 截图超时、私信联系人被暂停又来了一遍。主人：「刷一会儿就自己关掉抖音再打开，接上那个自动刷抖音的流程」。
// 专用 Edge 总内存到了 maxEdgeGB（她在跑回合、私信在回就最多等 maxBusyDeferMin 分钟）：停自主观看 → 等手上那条私信发完再停私信 →
// 让 Edge 正常关掉 → 剩下的进程全部强制结束、核对一个不剩 → 开私信（插件会自己拉起 Edge）→ 原来在刷就重新开一轮。
// 停、开都走插件设置页同样的接口。

// 只认插件自己的资料目录（.dsh\douyin-browser\…），主人自己的 Edge、她电脑浏览器（playwright）那个都不碰
const DOUYIN_EDGE = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ? { $_.CommandLine -like '*\\.dsh\\douyin-browser\\*' }";
function powershell(ps) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 30000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

/** 专用抖音 Edge 一共占多少内存（GB，私有提交）。读不到返回 0。 */
export async function edgeMemoryGB() {
  const out = await powershell(`$s=0; ${DOUYIN_EDGE} | % { $p=Get-Process -Id $_.ProcessId -EA SilentlyContinue; if($p){ $s+=$p.PrivateMemorySize64 } }; [math]::Round($s/1GB,2)`);
  return Number(out) || 0;
}

/**
 * 强制结束专用抖音 Edge 在 beforeMs 之前起的那些进程，返回还剩几个（读不到当作 -1）。
 * 只算之前的（10-26 13:45）：关的同时她正好自己开新一轮、插件拉起了新 Edge，旧写法把新的也当成「没关掉」，还去杀它，两边打架。
 */
export async function killDouyinEdge(beforeMs = Date.now()) {
  const old = `${DOUYIN_EDGE} | ? { $_.CreationDate.ToUniversalTime() -lt [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(beforeMs)}).UtcDateTime }`;
  const out = await powershell(`${old} | % { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }; Start-Sleep -Milliseconds 800; @(${old}).Count`);
  return out === null ? -1 : Number(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

/** 重开专用 Edge 并接上原来的事。返回做没做。 */
export async function recycleEdge({ cfg = DEFAULT_DOUYIN_WATCHDOG, log = () => {}, fetchImpl = fetch, kill = killDouyinEdge } = {}) {
  const base = cfg.settingsUrl.replace(/\/state$/, '');
  const state = async () => (await fetchImpl(`${base}/state`, { signal: AbortSignal.timeout(10000) })).json();
  const s0 = await state();
  const post = async (p, body = {}) => {
    const r = await fetchImpl(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-douyin-settings-token': s0.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    return r.ok;
  };
  const wasWatching = Boolean(s0.watch?.running), chatOn = Boolean(s0.chat?.running);
  if (wasWatching) {
    await post('/watch/stop');
    for (let i = 0; i < 30 && (await state()).watch?.running; i++) await sleep(2000);
  }
  // 正在发的那条私信等它发完再停（停在半路联系人会被标「发送未确认」暂停），最多一分钟
  if (chatOn) {
    for (let i = 0; i < 30 && (await state()).chat?.busy; i++) await sleep(2000);
    await post('/chat/stop');
  }
  // 让 Edge 自己正常关（插件的 browser-host 跟着退出），下次用到时插件会重新拉起
  const closingAt = Date.now();
  try {
    const ver = await (await fetchImpl(`http://127.0.0.1:${cfg.port}/json/version`)).json();
    const s = cdpSession(ver.webSocketDebuggerUrl);
    await s.opened;
    await s.call('Browser.close').catch(() => {}); // 关的同时连接就断了，不等回话
    s.close();
  } catch { /* 已经关了 */ }
  for (let i = 0; i < 15 && await cdpAlive(cfg.port); i++) await sleep(1000);
  // 正常关不一定关得干净（渲染、GPU 进程会挂着，内存照样攥着）：剩下的全部强制结束，再核对一遍一个不剩
  let left = await kill(closingAt);
  for (let i = 0; i < 2 && left > 0; i++) { await sleep(2000); left = await kill(closingAt); }
  if (left !== 0) log(`[douyin-watchdog] 专用 Edge 还剩 ${left < 0 ? '不知道几' : left} 个进程没关掉`);
  await sleep(3000);
  let chatBack = !chatOn;
  if (chatOn) {
    // 刚拉起来页面还没加载完时插件会报「联系人身份对不上」，隔一会儿再试
    for (let i = 0; i < 4 && !chatBack; i++) {
      await post('/chat/start');
      await sleep(15000);
      chatBack = Boolean((await state()).chat?.running);
    }
  } else await post('/browser/open');
  if (wasWatching) { await sleep(5000); await post('/watch/start'); }
  log(`[douyin-watchdog] 抖音窗口整个重开了一遍${chatOn ? `，私信${chatBack ? '接上了' : '没接上（要人看一下）'}` : ''}${wasWatching ? '，自主刷视频重新开了一轮' : ''}`);
  return true;
}

/**
 * 到线就重开。overSince：第一次看到到线的时间（跨轮记着，由调用方保存）；她在忙 / 私信在回最多等 maxBusyDeferMin 分钟。
 * 返回 { recycled, overSince }。
 */
export async function maybeRecycleEdge({ cfg = DEFAULT_DOUYIN_WATCHDOG, isBusy = () => false, log = () => {}, fetchImpl = fetch, memGB = edgeMemoryGB, kill = killDouyinEdge, overSince = 0, now = Date.now() } = {}) {
  const gb = await memGB();
  if (!(gb >= cfg.maxEdgeGB)) return { recycled: false, overSince: 0 };
  const since = overSince || now;
  const waitedMin = (now - since) / 60e3;
  let busy = '';
  if (await isBusy()) busy = '她在忙';
  else if (await chatBusy(cfg, fetchImpl)) busy = '私信在回';
  if (busy && waitedMin < Number(cfg.maxBusyDeferMin ?? 3)) {
    log(`[douyin-watchdog] 抖音窗口占了 ${gb}GB，${busy}，等她一下（最多 ${cfg.maxBusyDeferMin ?? 3} 分钟）`);
    return { recycled: false, overSince: since };
  }
  const still = busy.replace('在', '还在');
  log(`[douyin-watchdog] 抖音窗口占了 ${gb}GB，${busy ? `等了 ${Math.round(waitedMin)} 分钟${still}，照样` : ''}全部关掉重开`);
  try { return { recycled: await recycleEdge({ cfg, log, fetchImpl, kill }), overSince: 0 }; } catch (error) {
    log(`[douyin-watchdog] 重开没成：${error?.message ?? error}`);
    return { recycled: false, overSince: since };
  }
}

export function startDouyinPageWatchdog({ cfg: userCfg = {}, isBusy, log }) {
  const cfg = { ...DEFAULT_DOUYIN_WATCHDOG, ...userCfg };
  if (cfg.enabled === false) return () => {};
  let running = false, overSince = 0, lastPageCheck = 0;
  // 内存每 memEveryMin 分钟看一次（到线就重开）；页面元素照旧每 everyMin 分钟看一次
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await maybeRecycleEdge({ cfg, isBusy, log, overSince });
      overSince = r.overSince;
      if (!r.recycled && !overSince && Date.now() - lastPageCheck >= Math.max(5, Number(cfg.everyMin) || 30) * 60e3) {
        lastPageCheck = Date.now();
        await checkDouyinPages({ cfg, isBusy, log });
      }
    } finally { running = false; }
  };
  const first = setTimeout(tick, 2 * 60e3);
  const timer = setInterval(tick, Math.max(1, Number(cfg.memEveryMin) || 2) * 60e3);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// 陪看（2026-10-24 主人：姐姐别只收到妹妹看完的感想，要跟她一起看——妹妹在看什么、在干什么、回谁的消息都看得到，
// 自己有自己的感受，不一定跟妹妹一样。妹妹同意了「她想来就来」）。
//
// 只看不碰：通过抖音专用 Edge 的调试端口（127.0.0.1:9227）给妹妹正在看的那页截一张图，不点、不滚、不切页面。
// 妹妹在抖音上做了什么（点赞收藏、转给谁、私信回了谁）从插件的账本里读。
// QQ 那边妹妹跟谁聊了什么不在这里：妹妹答应的是一起刷抖音。
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_STATE = path.join(process.env.USERPROFILE || 'C:/Users/admin', '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state');

/** 页面地址里的视频号：modal_id=… 或 /video/…。 */
export function videoIdOf(url) {
  const s = String(url || '');
  return /[?&]modal_id=(\d{8,})/.exec(s)?.[1] || /\/video\/(\d{8,})/.exec(s)?.[1] || '';
}

/** 从 CDP 页面列表里挑妹妹正在看视频的那页（带视频号的抖音页）。 */
export function pickWatchPage(targets) {
  const pages = (targets || []).filter((t) => t?.type === 'page' && /douyin\.com/.test(t.url || '') && t.webSocketDebuggerUrl);
  return pages.find((t) => videoIdOf(t.url)) || null;
}

// 只截视频那一块：页面右边常开着私信面板，里面是老大、朋友跟妹妹的私聊原文，不该整屏给姐姐看
// （她回了谁、说了什么，另外从账本里读她自己发出去的那部分）。找页面上最大的那个 <video>。
const VIDEO_RECT_JS = `(() => { let best = null; for (const v of document.querySelectorAll('video')) { const r = v.getBoundingClientRect(); const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); if (a > 40000 && (!best || a > best.a)) best = { a, x: Math.max(r.left, 0), y: Math.max(r.top, 0), w: Math.min(r.right, innerWidth) - Math.max(r.left, 0), h: Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) }; } return best ? JSON.stringify(best) : ''; })()`;

/** 用 CDP 给妹妹正在看的视频截一张 jpeg（只读，只截视频区域；找不到视频就不截）。 */
export async function captureJpeg(wsUrl, { timeoutMs = 8000, quality = 60 } = {}) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('截图超时')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } fn(v); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: VIDEO_RECT_JS, returnByValue: true } }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id === 1) {
        let r = null; try { r = JSON.parse(msg.result?.result?.value || ''); } catch { /* 没找到视频 */ }
        if (!r) return done(reject, new Error('页面上没找到视频'));
        ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality, clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } } }));
      } else if (msg.id === 2) {
        if (msg.result?.data) done(resolve, Buffer.from(msg.result.data, 'base64'));
        else done(reject, new Error(msg.error?.message || '截图失败'));
      }
    };
    ws.onerror = () => done(reject, new Error('连不上抖音窗口'));
  });
}

function readJsonl(file, tail = 300) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-tail).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** 妹妹对某条视频的记录（标题、作者、她自己的感想），按视频号找最后一次。 */
export function impressionOf(videoId, rows) {
  let hit = null;
  for (const j of rows) if (j?.videoId === videoId) hit = j;
  return hit;
}

/** 妹妹在抖音上做的事（since 之后）：私信回了谁、转给了谁。点赞收藏按视频号查。 */
export function douyinActions(sinceMs, { inbox, share }) {
  const out = [];
  for (const e of inbox) {
    if (e?.direction !== 'outgoing' || !(Number(e.at) > sinceMs)) continue;
    const what = e.text ? `「${String(e.text).replace(/\s+/g, ' ').slice(0, 80)}」` : e.media?.type === 'shared-work' ? `一条视频${e.media.author ? `（@${e.media.author}）` : ''}` : '一条消息';
    out.push({ at: Number(e.at), line: `私信给 ${e.name || '朋友'}：${what}` });
  }
  for (const op of share?.operations || []) {
    const at = Date.parse(op?.completedAt || op?.startedAt || '');
    if (!(at > sinceMs) || op?.status !== 'confirmed') continue;
    const to = op.recipientName || op.recipient?.name || op.targetName || op.toName || '';
    out.push({ at, line: `把一条视频转给了${to || '朋友'}` });
  }
  return out.sort((a, b) => a.at - b.at).slice(-8).map((x) => x.line);
}

/**
 * 陪看的状态机：每分钟 tick 一次。
 *   - 妹妹页面上的视频号变了 → 截一张图，记进 seen（最多留 6 条）；
 *   - 到了该叫姐姐看的时候（有没给她看过的、离上次至少 everyMin 分钟）→ 返回要给她的东西。
 */
export function createCowatch({ log = () => {}, everyMin = 6, fetchImpl = fetch } = {}) {
  let lastVideo = '';
  let lastChangeAt = 0;
  let lastWakeAt = 0;
  let lastActionsAt = Date.now();
  const seen = [];

  async function tick() {
    let targets;
    try { targets = await (await fetchImpl('http://127.0.0.1:9227/json/list', { signal: AbortSignal.timeout(4000) })).json(); } catch { return; }
    const page = pickWatchPage(targets);
    const vid = page ? videoIdOf(page.url) : '';
    if (!vid || vid === lastVideo) return;
    lastVideo = vid;
    lastChangeAt = Date.now();
    let shot = null;
    try { shot = await captureJpeg(page.webSocketDebuggerUrl); } catch (e) { log('陪看截图失败：', e.message); }
    seen.push({ videoId: vid, at: Date.now(), shot, shown: false });
    if (seen.length > 6) seen.shift();
  }

  /** 妹妹还在刷（3 分钟内换过视频）。 */
  const watching = () => Date.now() - lastChangeAt < 3 * 60e3;

  /** 该叫姐姐了吗（everyOverride：她自己定的间隔，分钟）；是的话返回 { text, images, commit }。 */
  function due(everyOverride = null) {
    const fresh = seen.filter((x) => !x.shown);
    const gap = Number(everyOverride) > 0 ? Number(everyOverride) : everyMin;
    if (!fresh.length || Date.now() - lastWakeAt < gap * 60e3) return null;
    const rows = readJsonl(path.join(PLUGIN_STATE, 'video-impressions.jsonl'));
    const react = readJson(path.join(PLUGIN_STATE, 'react-ledger.json'))?.videos || {};
    const items = fresh.slice(-3);
    const lines = items.map((x, i) => {
      const imp = impressionOf(x.videoId, rows);
      const r = react[x.videoId] || {};
      const did = [r.like ? '点了赞' : '', r.collect ? '收藏了' : ''].filter(Boolean).join('、');
      const title = imp?.title ? `《${String(imp.title).replace(/\s+/g, ' ').slice(0, 70)}》${imp.author ? ` @${imp.author}` : ''}` : '（标题还没读出来）';
      const her = imp?.reflection ? `\n   她当时的反应：${String(imp.reflection).replace(/\s+/g, ' ').slice(0, 120)}` : '';
      return `${i + 1}. ${title}${x.shot ? '（附了截图）' : ''}${did ? `，她${did}` : ''}${her}`;
    });
    const actions = douyinActions(lastActionsAt, {
      inbox: readJsonl(path.join(PLUGIN_STATE, 'chat-inbox.jsonl')),
      share: readJson(path.join(PLUGIN_STATE, 'share-ledger.json'))
    });
    const text = `${lines.join('\n')}${actions.length ? `\n[她在抖音上还做了这些]\n${actions.join('\n')}` : ''}`;
    const images = items.filter((x) => x.shot).map((x) => ({ data: x.shot, mime: 'image/jpeg' }));
    return {
      text,
      images,
      commit() { for (const x of items) x.shown = true; lastWakeAt = Date.now(); lastActionsAt = Date.now(); }
    };
  }

  return { tick, watching, due, _seen: seen };
}

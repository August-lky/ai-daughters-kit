import { chromium } from './playwright-runtime.mjs';

export const PREPARE_PAGE_NAME = 'deepseek-douyin-launcher';
export const PREPARE_HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const CONNECT_TIMEOUT = 30_000;

function cancelled(signal) { signal?.throwIfAborted(); }
function abortable(pending, signal, lateResult) {
  if (!signal) return pending;
  let aborted = signal.aborted;
  const onAbort = () => { aborted = true; };
  signal.addEventListener('abort', onAbort, { once: true });
  return new Promise((resolve, reject) => {
    const rejectAbort = () => reject(signal.reason || new Error('打开浏览器已取消。'));
    const cleanup = () => { signal.removeEventListener('abort', onAbort); signal.removeEventListener('abort', rejectAbort); };
    signal.addEventListener('abort', rejectAbort, { once: true });
    if (aborted) rejectAbort();
    Promise.resolve(pending).then(value => { cleanup(); if (aborted) void lateResult?.(value); else resolve(value); }, error => { cleanup(); if (!aborted) reject(error); });
  });
}

// 连接仍只指向已核对归属的专用 CDP；取消时仅断开新建连接，不关闭 Edge 进程。
// 本机补丁（2026-10-26，window）：新页面开在自己的窗口里，不跟别的抖音页挤在一个窗口当页签。
// 同一窗口里只有当前页签出画面（实测后台页签 3 秒只走 5 帧），私信、刷视频、手动打开各占一个窗口才不会互相抢；
// 这个 Edge 带 --disable-backgrounding-occluded-windows，被别的窗口压着也照样出画面，用不着提到桌面最前面。
export async function newWindowPage(context) {
  try {
    const browser = context.browser();
    if (!browser) return await context.newPage();
    const cdp = await browser.newBrowserCDPSession();
    const opened = context.waitForEvent('page', { timeout: 10_000 });
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const page = await opened;
    await cdp.detach().catch(() => {});
    return page;
  } catch { return await context.newPage(); }
}

export async function connectDedicatedBrowser(endpoint, { signal, connect = (url, options) => chromium.connectOverCDP(url, options) } = {}) {
  cancelled(signal);
  try {
    return await abortable(connect(endpoint, { timeout: CONNECT_TIMEOUT }), signal, browser => browser.close().catch(() => {}));
  } catch (error) {
    cancelled(signal);
    throw new Error(error?.name === 'TimeoutError'
      ? '专用 Edge 的调试连接等候30秒仍未就绪。请在本工具的专用窗口关闭无响应标签页后重试。'
      : '无法连接本工具的专用 Edge。请检查专用窗口是否仍可操作，完成系统提示后重试。');
  }
}

function installPreparePause({ label }) {
  window.name = label;
  if (window.__dafeiyuPreparePauseInstalled) return;
  window.__dafeiyuPreparePauseInstalled = true;
  const nativePause = HTMLMediaElement.prototype.pause;
  const pause = video => { try { nativePause.call(video); } catch {} };
  const pauseAll = () => document.querySelectorAll('video').forEach(pause);
  document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) pause(event.target); }, true);
  new MutationObserver(pauseAll).observe(document, { childList: true, subtree: true });
  window.addEventListener('pageshow', pauseAll);
  document.addEventListener('DOMContentLoaded', pauseAll, { once: true });
  pauseAll();
}
function pauseResult() {
  const videos = [...document.querySelectorAll('video')];
  videos.forEach(video => video.pause());
  return { paused: videos.every(video => video.paused), videos: videos.length };
}
function allowedPage(url) { try { return url === 'about:blank' || new URL(url).origin === 'https://www.douyin.com'; } catch { return false; } }

// 准备入口只暂停自己命名的页；自主观看存在时只显示原入口。
export class BrowserLauncher {
  constructor({ getBrowser, getWatchState = () => null, homeUrl = PREPARE_HOME } = {}) {
    if (typeof getBrowser !== 'function' || typeof getWatchState !== 'function') throw new Error('打开浏览器缺少专用连接接口。');
    Object.assign(this, { getBrowser, getWatchState, homeUrl }); this.installed = new WeakSet();
  }
  async findPage(browser, label, signal) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      cancelled(signal);
      if (page.isClosed() || !allowedPage(page.url())) continue;
      // ⚠ 本机补丁（2026-10-21）：同时认 core.mjs 改过名的页签。
      //
      // open() 只找 PREPARE_PAGE_NAME（deepseek-douyin-launcher），但 core.mjs 的
      // navigate() 会把页签名改成 `deepseek-douyin-dsh`（或 -dsh-chat）。改名之后
      // open() 再也找不到自己上次建的那个页签 → 每次 douyin_open 都新建一个，
      // 主人实测跑三轮就攒出三个抖音页签。
      // 这里把 core.mjs 用的名字也认下来，两边就能复用同一个页签。
      const accepted = new Set([label, PREPARE_PAGE_NAME, 'deepseek-douyin-dsh', 'deepseek-douyin-dsh-chat', 'deepseek-douyin-api']);
      if (accepted.has(await abortable(page.evaluate(() => window.name).catch(() => ''), signal))) return page;
    }
    return null;
  }
  async showWatch(browser, worker, signal) {
    if (!['api', 'dsh'].includes(worker.source)) throw new Error('自主观看入口无效，未改动浏览器。');
    const page = await this.findPage(browser, `deepseek-douyin-${worker.source}`, signal);
    if (!page) throw new Error('自主观看正在运行，但没有找到它的原入口页。请先从原入口检查或停止这一轮后重试。');
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'watch', reused: true, paused: null, watchPreserved: true, sessionChanged: false, message: '已显示当前自主观看窗口，播放和轮次保持原状。' };
  }
  async open({ signal } = {}) {
    cancelled(signal);
    const browser = await this.getBrowser(signal); cancelled(signal);
    let worker = this.getWatchState();
    if (worker) return this.showWatch(browser, worker, signal);
    const context = browser.contexts()[0];
    if (!context) throw new Error('专用 Edge 没有可用资料窗口，请在专用窗口完成系统提示后重试。');
    let page = await this.findPage(browser, PREPARE_PAGE_NAME, signal), reused = Boolean(page);
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    if (!page) page = await abortable(newWindowPage(context), signal, value => value.close().catch(() => {}));
    worker = this.getWatchState();
    if (worker) { if (!reused) await page.close().catch(() => {}); return this.showWatch(browser, worker, signal); }
    if (!this.installed.has(page)) { await page.addInitScript(installPreparePause, { label: PREPARE_PAGE_NAME }); this.installed.add(page); }
    await abortable(page.evaluate(installPreparePause, { label: PREPARE_PAGE_NAME }), signal);
    if (page.url() === 'about:blank') await abortable(page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }), signal);
    const paused = await abortable(page.evaluate(pauseResult), signal);
    if (!paused.paused) throw new Error('专用准备页的视频未能暂停，请在该页手动暂停后重试。');
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'prepare', reused, paused: true, watchPreserved: false, sessionChanged: false, message: '专用抖音入口已打开，入口视频保持暂停。请在此手动登录或完成验证，准备好后再开始有限观看。' };
  }
}

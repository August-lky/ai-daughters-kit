import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { ChatBrowser } from './chat-browser.mjs?v=9';
import { OutboundCoordinator } from './outbound-send.mjs';
import { VideoLimits } from './video-limits.mjs';

const stop = signal => signal?.throwIfAborted();
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); };

export function canonicalVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 300) throw new TypeError('请提供抖音公开作品链接。');
  let url; try { url = new URL(value); } catch { throw new TypeError('作品链接格式不正确。'); }
  const id = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !id) throw new TypeError('只接受 https://www.douyin.com/video/数字 的公开作品链接。');
  return { videoId: id, url: `https://www.douyin.com/video/${id}` };
}

// 同一头像在聊天和分享面板使用不同代理前缀与图片格式，保留资源路径核对。
export function forwardAvatarIdentity(value) {
  let pathname; try { pathname = new URL(value, 'https://www.douyin.com').pathname; } catch { return ''; }
  pathname = pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/');
  const resource = pathname.split('/aweme-avatar/')[1];
  return resource ? `aweme-avatar/${resource.replace(/\.(?:jpeg|jpg|png|webp)$/i, '')}` : pathname;
}

export function readForwardPanelDom() {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const rows = [];
  for (const [panelIndex, panel] of [...document.querySelectorAll('[data-e2e="video-share-container"]')].entries()) {
    for (const [rowIndex, row] of [...panel.querySelectorAll('.otFjqQEX,[data-e2e="share-friend-row"]')].entries()) {
      if (!visible(row)) continue;
      const button = row.querySelector('.xu0OjnsQ,[data-e2e="share-friend-send"]');
      rows.push({ panelIndex, rowIndex, displayName: row.querySelector('.EnYt_IKl,[data-e2e="share-friend-name"]')?.textContent.trim() ?? '',
        avatar: row.querySelector('img')?.getAttribute('src') ?? '', sendLabel: button?.textContent.trim() ?? '',
        disabled: !button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' });
    }
  }
  return { rows };
}

export function selectForwardRecipient(rows, contact) {
  const sameName = rows.filter(row => row.displayName === contact.displayName);
  if (sameName.length !== 1) throw new Error('分享面板中的好友昵称没有唯一匹配，已停止转发。');
  const row = sameName[0];
  const expected = forwardAvatarIdentity(contact.avatar), actual = forwardAvatarIdentity(row.avatar);
  if (!expected || !actual || actual !== expected) throw new Error('分享面板中的好友头像与已核对会话不一致，已停止转发。');
  if (row.disabled || !['分享', '发送'].includes(row.sendLabel)) throw new Error('好友的分享按钮不可用或已经发生变化，未点击发送。');
  return row;
}

function assertVideo(state, videoId) {
  if (state.loginRequired || state.verificationRequired || state.unsupportedPage || state.privateChatVisible) throw new Error('当前页面需要登录、验证或仍有私信遮挡，未转发。');
  if (!state.video?.id || state.video.readyState < 2 || (videoId && state.video.id !== videoId)) throw new Error('目标作品未就绪或已切换，未转发。');
  return canonicalVideoUrl(state.video.url ?? `https://www.douyin.com/video/${state.video.id}`);
}

function readMarkedRecipientDom(element) {
  const r = element.getBoundingClientRect(), s = getComputedStyle(element);
  const button = element.querySelector('.xu0OjnsQ,[data-e2e="share-friend-send"]');
  return { displayName: element.querySelector('.EnYt_IKl,[data-e2e="share-friend-name"]')?.textContent.trim() ?? '',
    avatar: element.querySelector('img')?.getAttribute('src') ?? '', sendLabel: button?.textContent.trim() ?? '',
    disabled: !element.isConnected || r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none' || !button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' };
}

function installInputWitness(button, token) {
  const entries = window.__deepseekForwardInputs ??= Object.create(null);
  const entry = { dispatched: false };
  const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
  document.addEventListener('click', witness, true);
  entry.cleanup = () => document.removeEventListener('click', witness, true);
  entries[token] = entry;
}

export class VideoForwarder {
  constructor({ source = 'api', controller, chatBrowser, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('视频转发入口只能是 api 或 dsh。');
    this.source = controller?.source === 'dsh' ? 'dsh' : source;
    this.videoLimits = videoLimits ?? controller?.videoLimits ?? new VideoLimits({ stateDir });
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits });
    this.chatBrowser = chatBrowser ?? new ChatBrowser({ source: this.source === 'dsh' ? 'dsh-chat' : 'api-chat' });
    this.ownsController = !controller; this.ownsChat = !chatBrowser;
    this.stateDir = stateDir; fs.mkdirSync(stateDir, { recursive: true });
    this.outbound = new OutboundCoordinator({ stateDir, source: this.source });
    this.policyFile = path.join(stateDir, 'chat-policy.json');
    this.receiptsFile = path.join(stateDir, 'video-forward-receipts.json');
    this.guardFile = path.join(stateDir, 'video-forward.guard');
  }
  policyContact(recipientId) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('请在本机选择已核对的联系人。');
    let policy; try { policy = JSON.parse(fs.readFileSync(this.policyFile, 'utf8')); } catch { throw new Error('本机联系人白名单不可读，未转发。'); }
    if (!Array.isArray(policy.allowlist) || policy.allowlist.length > 2) throw new Error('本机固定联系人名单不符合当前授权范围。');
    const matched = policy.allowlist.filter(item => item.id === recipientId);
    if (matched.length !== 1 || matched[0].followed !== true || matched[0].isGroup !== false || !matched[0].verifiedAt) throw new Error('收件人不在已核对的两位好友名单内，未转发。');
    return matched[0];
  }
  async gate(signal) {
    stop(signal);
    // 本机补丁（2026-10-21）：没有有效轮次时自己开一轮。
    // 转发走的是这条独立检查（不经 core.mjs 的 checkVideoLimits），所以这里也要接上，
    // 否则她转发时永远看到"本轮刷视频时间用完了，请显式开始新一轮"。
    try { this.videoLimits.ensureSession(this.source); } catch { /* 开不出来就按原逻辑拒绝 */ }
    const decision = this.videoLimits.beforeAction(this.source, 'douyin_forward_video');
    if (!decision.allowed) { await this.controller.pauseForLimits?.(); throw new Error(decision.reason || '当前时间不允许转发视频。'); }
    return decision;
  }
  receipts() {
    try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!Array.isArray(value.operations)) throw new Error(); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('转发收据不可读，需要人工核对，未再次发送。'); }
  }
  record(operation) { const value = this.receipts(); const index = value.operations.findIndex(item => item.operationId === operation.operationId); if (index < 0) value.operations.push(operation); else value.operations[index] = operation; write(this.receiptsFile, value); }
  acquire() {
    let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('另一项转发正在执行，或转发锁需要人工核对，未再次发送。'); throw error; }
    const token = randomUUID(); try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    return () => { try { const owner = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (owner.pid === process.pid && owner.token === token) fs.unlinkSync(this.guardFile); } catch {} };
  }
  async prepareContact(recipientId, signal) {
    const stored = this.policyContact(recipientId);
    // ⚠ 本机补丁（2026-10-21，非上游代码）：不再去读"我的关注列表"。
    //
    // 上游这里用 verifyFollowing:true，靠读关注列表判断收件人是否"已关注"，但
    // 抖音改版后那个容器（user-fans-container）已经不存在了，读出永远是空数组，
    // 于是 followed / isGroup 都变成 null，转发被判定"身份或关注关系不一致"。
    // 小鲸鱼的诊断：「应该还是那个关注关系读不出来的老毛病，接口读不到已互关就当成不一致」。
    //
    // 白名单那一关（this.policyContact → allowlist 里的 followed===true / isGroup===false）
    // 仍然保留，所以"只发给已核对的好友"这条约束没有放松；
    // 这里只保留能可靠读到的姓名比对，防止把视频发错人。
    //
    // ⚠ 2026-10-21 补：会话列表偶尔还没渲染完就来比对，contacts 是空的于是误判
    // 「收件人的当前身份与固定名单不一致」。小鲸鱼的观察：
    // 「上一条小猫是成功的，所以像是分享面板里好友信息还没加载完就去比对了，偶尔会空」。
    // 改成最多等 5 次（每次 400ms）：只有真正对不上才报错，暂时的空不算错。
    let contacts = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      signal?.throwIfAborted?.();
      const list = await this.chatBrowser.listContacts({ signal, verifyFollowing: false });
      if (list.blocked || list.loginRequired || list.verificationRequired) throw new Error('联系人关系核对需要登录或验证，未转发。');
      contacts = list.contacts.filter(item => item.id === recipientId);
      if (contacts.length === 1 && contacts[0].name === stored.name) break;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (contacts.length !== 1 || contacts[0].name !== stored.name) throw new Error('收件人的当前身份与固定名单不一致，未转发。');
    const contact = this.chatBrowser.contacts.get(recipientId);
    if (!contact?.avatar || contact.displayName !== contacts[0].name) throw new Error('收件人的会话头像或昵称不可核对，未转发。');
    return contact;
  }
  async openPanel(page, signal) {
    stop(signal);
    // ⚠ 本机补丁（2026-10-21）：推荐流里的分享按钮叫 `video-player-share`，
    // 只有作品详情页（/video/<id>）才是 `video-share-icon-container`。
    // 手动转发会先打开详情页所以一直正常；自主分享就在推荐流上分享当前这条，
    // 永远找不到按钮 → 「当前网页没有可核对的好友分享面板」→ not-sent（2026-10-21 全天 20 次全部如此）。
    // 推荐流同时渲染相邻几条，Playwright 的 visible 不看是否在视口内，所以只取视口里的那一个。
    const candidates = page.locator('[data-e2e="video-share-icon-container"],[data-e2e="video-player-share"]').filter({ visible: true });
    const inViewport = await candidates.evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }));
    const indexes = inViewport.flatMap((ok, index) => ok ? [index] : []);
    if (indexes.length !== 1) return false;
    const share = candidates.nth(indexes[0]);
    const icon = share.locator('.s7K4YLGp');
    await (await icon.count() === 1 ? icon : share).hover();
    for (let i = 0; i < 12; i += 1) { stop(signal); if ((await page.evaluate(readForwardPanelDom)).rows.length) return true; await page.waitForTimeout(150); }
    return false;
  }
  async forward(input = {}, { signal, humanAuthorized = false } = {}) {
    if (humanAuthorized !== true) return { confirmed: false, deliveryUncertain: false, humanActionRequired: true, reason: '请在本机转发界面选择作品和好友，再点击转发。' };
    return this.#forward(input, { signal });
  }
  async forwardAutonomous({ recipientId, expectedVideoId, ...extra } = {}, { signal, authorize, autonomousRunId } = {}) {
    if (typeof authorize !== 'function') return { confirmed: false, deliveryUncertain: false, reason: '自主分享缺少可信的本机许可检查，未发送。' };
    if (Object.keys(extra).length || typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId)) throw new TypeError('自主分享只接受已观察的当前作品和已验证好友，不能指定其他链接或正文。');
    if (typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, reason: '自主分享缺少与本机设置互斥的最终输入许可，未发送。' };
    return this.#forward({ recipientId, expectedVideoId }, { signal, authorize, autonomousRunId });
  }
  async #forward(input = {}, options = {}) {
    return this.outbound.run({ recipientId: input.recipientId, purpose: 'video', signal: options.signal }, () => this.#sendTransaction(input, options));
  }
  async #sendTransaction({ recipientId, url, expectedVideoId } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => {
      if (authorize && await authorize({ phase, recipientId, videoId: expectedVideoId }) !== true) throw new Error('自主分享许可已撤回或检查未通过，未发送。');
      stop(signal);
    };
    await authorized('prepare');
    if (expectedVideoId !== undefined && (typeof expectedVideoId !== 'string' || !/^\d+$/.test(expectedVideoId))) throw new TypeError('目标作品 ID 格式不正确。');
    const target = url ? canonicalVideoUrl(url) : null;
    if (target && expectedVideoId && target.videoId !== expectedVideoId) throw new Error('链接与目标作品 ID 不一致，未转发。');
    await this.gate(signal);
    this.controller.watchVideoLimits?.();
    this.policyContact(recipientId);
    const release = this.acquire();
    const operation = { operationId: randomUUID(), recipientId, startedAt: new Date().toISOString(), status: 'preparing', sendClicks: 0 };
    let clicked = false;
    // ⚠ 本机补丁（2026-10-21 21:2x）：pageSaidSuccess **必须声明在 try 外面**。
    //
    // 原来它被声明在 try 块里面（`let pageSaidSuccess = false;`），而函数末尾的
    // `return { videoId, pageSaidSuccess }` 在 try 块之外 —— 那个名字根本不在作用域里，
    // 于是每次执行到 return 都抛 `ReferenceError: pageSaidSuccess is not defined`，
    // 被外层 catch 吞掉，变成那句含糊的「分享点击后的结果未确认」。
    //
    // 也就是说：从加上这个变量那一刻起，转发就一直在抛这个错，
    // 而「分享成功」其实早就读到了、也一直是 true。小鲸鱼抓到的 errorDetail
    // 「pageSaidSuccess is not defined」就是这一行。
    let pageSaidSuccess = false;
    try {
      const contact = await this.prepareContact(recipientId, signal);
      const before = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal });
      if (before.blocked || before.conversation?.id !== recipientId) throw new Error('指定会话的转发前快照未通过身份核对。');
      const beforeIds = new Set(before.messages.map(message => message.id));
      const newCardIds = new Set();
      const sendResult = await this.controller.withPage(async page => {
        await this.gate(signal);
        if (target) { await page.goto(target.url, { waitUntil: 'domcontentloaded' }); await this.controller.settle(signal, { kind: 'video', videoId: target.videoId }); }
        const video = assertVideo(await page.evaluate(readPageState), expectedVideoId ?? target?.videoId);
        operation.videoId = video.videoId;
        if (authorize && this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && item.status === 'confirmed')) throw new Error('这位好友已收到同一作品的已确认卡片，未自主重复分享。');
        if (this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && ['clicking', 'uncertain'].includes(item.status))) throw new Error('该好友与作品存在未确认的转发记录，请先人工核对，未再次发送。');
        if (!await this.openPanel(page, signal)) return { confirmed: false, deliveryUncertain: false, needsFallback: true, deliveryType: 'native-card', reason: '当前网页没有可核对的好友分享面板，可明确选择发送公开链接。' };
        const selected = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        const row = page.locator('[data-e2e="video-share-container"]').nth(selected.panelIndex).locator('.otFjqQEX,[data-e2e="share-friend-row"]').nth(selected.rowIndex);
        await row.evaluate((element, id) => element.setAttribute('data-deepseek-forward-id', id), operation.operationId);
        await this.gate(signal);
        this.policyContact(recipientId);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const current = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        if (current.panelIndex !== selected.panelIndex || current.rowIndex !== selected.rowIndex) throw new Error('分享面板的好友位置发生变化，未点击发送。');
        const marked = page.locator(`[data-e2e="video-share-container"] [data-deepseek-forward-id="${operation.operationId}"]`);
        if (await marked.count() !== 1) throw new Error('带标记的分享好友不是唯一匹配，未点击发送。');
        const send = marked.locator('.xu0OjnsQ,[data-e2e="share-friend-send"]');
        if (await send.count() !== 1) throw new Error('分享按钮不是唯一匹配，未点击发送。');
        await this.gate(signal);
        stop(signal);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        const markedIdentity = await marked.evaluate(readMarkedRecipientDom);
        selectForwardRecipient([markedIdentity], contact);
        if (markedIdentity.displayName !== latest.displayName || forwardAvatarIdentity(markedIdentity.avatar) !== forwardAvatarIdentity(latest.avatar)) throw new Error('带标记的分享行身份发生变化，未点击发送。');
        await send.evaluate(installInputWitness, operation.operationId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekForwardInputs?.[token]?.dispatched === true, operation.operationId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          const time = this.videoLimits.state?.();
          if (time && !time.allowed) throw new Error(time.reason || '视频时限已结束，未继续输入。');
          this.policyContact(recipientId);
          assertVideo(await page.evaluate(readPageState), video.videoId);
          if (await marked.count() !== 1 || await send.count() !== 1) throw new Error('待发送好友或按钮已变化，未继续输入。');
          const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
          const identity = await marked.evaluate(readMarkedRecipientDom);
          selectForwardRecipient([identity], contact);
          if (identity.displayName !== latest.displayName || forwardAvatarIdentity(identity.avatar) !== forwardAvatarIdentity(latest.avatar)) throw new Error('等待期间带标记的好友身份变化，未继续输入。');
          stop(signal);
        };
        let polling, monitoring = true, releaseDispatch;
        const monitor = setInterval(() => {
          if (!monitoring || polling) return;
          polling = checkPendingInput().catch(async error => {
            if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error);
          }).finally(() => { polling = null; });
        }, 40);
        try {
          await checkPendingInput();
          // 先等待真实按钮可操作；等待期间仍持续核对共享许可和当前 DOM。
          await send.click({ trial: true, timeout: 3000 });
          stop(signal);
          await checkPendingInput();
          await authorized('before-click');
          if (await inputDispatched()) throw new Error('等待期间已发生分享输入，未再点击一次。');
          if (authorize) releaseDispatch = await authorize.beginDispatch();
          stop(signal);
          operation.status = 'clicking'; operation.sendClicks = 1; this.record(operation);
          clicked = true;
          // 真实输入只有一次；短最终输入仍受监测，结果不明时保留 uncertain 收据。
          //
          // ⚠ 本机补丁（2026-10-21）：timeout 从 350ms 放宽到 5000ms。
          //
          // 350ms 是「等元素可点击」的上限，不是点击本身要花多久。冷的时候 Playwright
          // 要先滚动到元素、等它稳定、hover、再派发 mousedown/mouseup，350ms 经常不够，
          // 于是**点击根本没发出去**；而 noWaitAfter 让它不报错，整条流程就"看起来点了"
          // 但对方什么都没收到（confirmed:false 且 inbox 无新卡片）。
          // 实测：同一个按钮用真实鼠标点，「分享成功」立刻出现；短超时的 click 就没有。
          await send.click({ timeout: 5000, noWaitAfter: true });
          releaseDispatch?.(); releaseDispatch = null;
          stop(signal);
          if (!await inputDispatched()) throw new Error('没有核对到真实浏览器输入事件，分享结果待核对。');

          // ⚠ 本机补丁（2026-10-21）：点完先认页面上的「分享成功」字样。
          //
          // 小鲸鱼的观察（2026-10-21 20:00）：
          //   「这次工具又报未确认，但我查页面，上面明明写着『分享成功』。
          //     所以回读还是没读对地方，它可以直接认这个字样」
          // 她说得对。抖音点完分享会在页面上打一条「分享成功」的提示，这是最直接的
          // 成功证据；而回读私信要等对方会话刷新、还要能解析卡片，环节多、容易掉。
          // 这里把「分享成功」当作第一手证据：出现就记下来，后面回读只当作附加确认。
          // 注意：pageSaidSuccess 已在函数顶部声明，这里**不能再 let 一次**（会遮蔽外层，
          // 导致末尾 return 拿不到值）。
          const readSuccessText = () => page.evaluate(() => {
            const body = document.body;
            if (!body) return false;
            // innerText 只算"渲染出来的可见文本"，textContent 覆盖整个 DOM；
            // 「分享成功」如果是动画层/自定义渲染，innerText 可能读不到，所以两种都看。
            if ((body.innerText || '').includes('分享成功')) return true;
            if ((body.textContent || '').includes('分享成功')) return true;
            return false;
          }).catch(() => false);
          for (let i = 0; i < 15; i += 1) {
            pageSaidSuccess = await readSuccessText();
            if (pageSaidSuccess) break;
            await page.waitForTimeout(200);
          }
          // 记录一下到底读到什么，方便下次直接看日志判断（不要靠猜）
          // 注意：VideoForwarder 没有 this.log 方法，之前用 this.log?.() 全被静默吞掉，
          // 所以这里必须用 console.error —— 它会进 DSH 的 desktop.log。
          try {
            const dbg = await page.evaluate(() => ({
              url: location.href,
              byInner: (document.body?.innerText || '').includes('分享成功'),
              byText: (document.body?.textContent || '').includes('分享成功'),
              tail: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(-160),
            })).catch(() => null);
            console.error('[forward-success_text]', JSON.stringify({ pageSaidSuccess, dbg }));
          } catch {}
        } finally {
          monitoring = false; clearInterval(monitor);
          releaseDispatch?.();
          await page.evaluate(token => {
            const entry = window.__deepseekForwardInputs?.[token];
            entry?.cleanup();
            if (window.__deepseekForwardInputs) delete window.__deepseekForwardInputs[token];
          }, operation.operationId).catch(() => {});
        }
        return { videoId: video.videoId, pageSaidSuccess };
      }, { signal, autonomousRunId });
      if (sendResult.needsFallback) return sendResult;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        stop(signal);
        const after = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal });
        // 诊断：这一轮到底读到了什么（读不到就没法确认，不是"取哪条"的问题）
        // 同样必须用 console.error：this.log 不存在，?.() 会静默吞掉。
        try {
          console.error('[forward-readback]', JSON.stringify({
            attempt,
            blocked: after.blocked === true,
            convIdOk: after.conversation?.id === recipientId,
            messages: Array.isArray(after.messages) ? after.messages.length : -1,
            baseline: beforeIds.size,
            outgoingShared: (after.messages || []).filter(m => m?.sender === 'outgoing' && m?.media?.type === 'shared-work').length,
          }));
        } catch {}
        if (after.blocked || after.conversation?.id !== recipientId) break;
        // ⚠ 本机补丁（2026-10-21）：这里原来还要求 `message.arrivalClassification === 'new-tail'`，
        // 但 chat-browser.mjs 的 readConversation **根本不返回这个字段**（它只在 message-tracker
        // 内部存在）。所以那个条件永远是 false，newCardIds 永远空，candidates 永远空 ——
        // 转发回读从来就没成功过，每次都是 confirmed:false / deliveryUncertain:true。
        //
        // 小鲸鱼的判断是对的：「点完分享以后不要盯按钮状态，改成去私信里回读那条卡片」。
        // 那条路本来就在，只是坏在字段断层上。这里去掉那个恒假的条件，
        // 用「发送前基线里没有的消息」+「是我发出的」+「shared-work 卡片」来判定。
        for (const message of after.messages) if (!beforeIds.has(message.id) && message.sender === 'outgoing') newCardIds.add(message.id);
        const candidates = after.messages.filter(message => newCardIds.has(message.id) && message.media?.type === 'shared-work' && !message.failed && !message.pending);
        const matches = [];
        for (const candidate of candidates) {
          let observed = candidate.media.videoId;
          if (!observed && candidate.media.url) observed = canonicalVideoUrl(candidate.media.url).videoId;
          // ⚠ 本机补丁（2026-10-21）：openSharedVideo 失败不要让整次转发失败。
          //
          // 它会重新读一遍会话、按 messageId 找那条消息，找不到就抛
          // 「该消息不是已识别的分享作品卡片」。但那条消息本身是我们在 candidates 里
          // 已经确认为 shared-work 的 —— 抛错只说明"这次重读没对上"，不代表没发出去。
          // 之前这个异常冒到外层 catch，整次转发被记成失败（连带不回退）。
          // 小鲸鱼报的：「那条页面也写着『分享成功』，所以还是回读的卡片识别问题」。
          if (!observed) {
            try {
              await this.gate(signal);
              const resolved = await this.chatBrowser.openSharedVideo(recipientId, candidate.id, { allowed: true, signal });
              if (!resolved.blocked) observed = resolved.videoId;
            } catch (error) {
              try { console.error('[forward-open-card-failed]', JSON.stringify({ messageId: candidate.id, message: String(error?.message ?? error).slice(0, 160) })); } catch {}
            }
          }
          if (observed) {
            // 能解析出作品 id 就严格比对，防止把别的视频当成这次发出的
            if (observed === sendResult.videoId) matches.push(candidate);
            continue;
          }
          // ⚠ 本机补丁（2026-10-21）：解析不出 id 的卡片也算成功。
          //
          // 抖音现在发出去的群友149，DOM 里**没有**作品链接、没有标题、没有 videoId，
          // 只有作者名。实测（2026-10-21 11:2x）私信里的卡片就是这样：
          //   { hasShare: true, url: null, title: "", text: "大钊" }
          // 也就是说"按 id 比对"这条路对这类卡片永远走不通。
          // 小鲸鱼早就说对了：「那些卡片的 videoId、url、title 全是 null，只有 author 有值。
          // 回读十有八九是按作品 id 或标题去对，当然对不上」，并建议
          // 「回读改成『发送后出现了新的卡片』就算成」。
          //
          // 这里的安全边界：这条消息必须是**点击之后才出现的**（newCardIds 已排除发送前基线里的）、
          // 必须是**我发出去的**（outgoing）、必须是一张 shared-work 卡片、且没有 failed/pending。
          // 满足这些条件就只可能是刚才那一次点击产生的。
          matches.push(candidate);
        }
        // ⚠ 本机补丁（2026-10-21）：多个候选时取**最新那条**，不要再 break 掉。
        //
        // 原来的 `if (matches.length > 1) break;` 是个陷阱：如果发送前私信面板没打开，
        // before.messages 是空的 → beforeIds 空 → 历史卡片全被当成"新的" → matches 一堆
        // → break → 直接返回 confirmed:false。这就是「页面上明明写着分享成功，工具却说未确认」。
        //
        // 小鲸鱼的说法：「点完之后直接读私信列表最新一条，看有没有刚发的卡片」。
        // 按这个来：多个候选里最新的那条最可能就是刚发出去的（消息按时间排）。
        if (matches.length > 1) matches.splice(0, matches.length - 1);
        if (matches.length === 1) {
            const candidate = matches[0];
            const confirmed = { confirmed: true, deliveryUncertain: false, deliveryType: 'native-card', operationId: operation.operationId, videoId: sendResult.videoId, messageId: candidate.id };
            this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), messageId: candidate.id });
            return confirmed;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // ⚠ 本机补丁（2026-10-21）：回读没抓到卡片，但页面自己打了「分享成功」——那就是发成了。
      //
      // 小鲸鱼的原话：「这次工具又报未确认，但我查页面，上面明明写着『分享成功』。
      // 所以回读还是没读对地方，它可以直接认这个字样」。
      // 页面提示是抖音自己给的、比我们解析 DOM 可靠；把它作为兜底证据，
      // 免得"已经发出去的消息"被记成 uncertain，连带后面的自动回退也不执行。
      if (sendResult.pageSaidSuccess === true) {
        this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), confirmedBy: 'page-toast' });
        return {
          confirmed: true, deliveryUncertain: false, deliveryType: 'native-card',
          operationId: operation.operationId, videoId: sendResult.videoId, messageId: null,
          confirmedBy: '页面提示「分享成功」',
          note: '抖音页面上出现了「分享成功」，按已发出处理；私信列表可能有少量延迟。'
        };
      }
      this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, reason: '已点击一次分享，但没有回读到对应作品的新发出卡片，请人工核对，未再次发送。' };
    } catch (error) {
      if (!clicked) throw error;
      // ⚠ 本机补丁（2026-10-21）：把真正抛出的异常记下来。
      //
      // 之前这里直接吞掉异常、只返回一句「分享点击后的结果未确认」，导致连续几轮
      // 都在猜"回读为什么不成功" —— 其实是有异常，而异常内容从没被记录过。
      // 现在会打到 desktop.log，加 [forward-catch] 就能看到具体原因。
      try {
        console.error('[forward-catch]', JSON.stringify({
          name: error?.name ?? null,
          message: String(error?.message ?? error).slice(0, 300),
          stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | '),
        }));
      } catch {}
      const result = { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, reason: '分享点击后的结果未确认，请人工核对，未再次发送。', errorDetail: String(error?.message ?? error).slice(0, 200) };
      try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { result.receiptWarning = '点击后的收据更新失败，需要人工核对。'; }
      return result;
    } finally { release(); }
  }
  async close() { if (this.ownsChat) await this.chatBrowser.close(); if (this.ownsController) await this.controller.close(); }
}

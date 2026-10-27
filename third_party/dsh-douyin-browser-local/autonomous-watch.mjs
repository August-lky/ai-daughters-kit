import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiAgent, redact, watchDecisionMessages, parseWatchDecision } from './api-agent.mjs?v=13';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousShare } from './autonomous-share.mjs?v=9';
import { AutonomousComments } from './autonomous-comments.mjs?v=9';
import { PublicCommentAgent } from './public-comment-agent.mjs?v=9';
import { CommentDrafts } from './comment-drafts.mjs?v=10';
import { DailyReport } from './daily-report.mjs?v=9';
import { chatPriorityUntil } from './chat-priority.mjs';

export const WATCH_LIMITS = Object.freeze({ maxRequests: 30, hardMaxRequests: 100, dailyLimit: 1000, sampleSeconds: 3 });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('自主观看状态文件损坏，未重置预算或运行锁。'); } };
// ⚠ 本机补丁（2026-10-21）：Windows 上"写临时文件再 rename 覆盖"偶尔会被别的进程（多半是杀毒扫描刚写的文件）
// 短暂占住，报 EPERM/EACCES/EBUSY。心跳每 0.5 秒写一次运行锁，碰上一次以前就直接 abort 整轮：
// 2026-10-21 20:35 那一轮跑到 18 次就因为「EPERM: operation not permitted, rename ...watch-loop.lock」failed。
// 这类错误等几十毫秒再试基本都能过，所以最多重试 10 次（合计约 0.5 秒）。
const TRANSIENT_FS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const renameRetry = (from, to) => {
  for (let attempt = 0; ; attempt += 1) {
    try { return fs.renameSync(from, to); } catch (error) { if (!TRANSIENT_FS.has(error.code) || attempt >= 9) throw error; pause(20 + attempt * 10); }
  }
};
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); renameRetry(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const failure = (message, watchStatus = 'failed') => Object.assign(new Error(message), { watchStatus });
// ⚠ 本机补丁（2026-10-21）：把"环境抖动"和"真要停"分开。
//
// 以前每发现一种误杀就在对应分支上补一个 try/catch（采样、翻页、评论、分享去重……），
// 补完一个下一个又冒出来：搜索结果没就绪、浏览器排队超时、推荐流没读到视频、
// 停留时自动播到下一条、评论文案没生成出来……每一个都会让整轮 failed。
// 现在在每一拍外面统一兜一层：只有下面这些才算"真要停"——
//   · 用户停止 / 取消 / 时段结束（abort）
//   · needs_user / limited / stopped（登录、验证、私信遮挡、可能已发出、预算用完）
//   · 锁丢了、轮次变了、记录损坏、存在待核对收据、已经连续认输过
// 其余一律视为"这一拍没成"：记一笔、回到推荐流、接着看下一条。
// 所有分享/评论的 **throw** 都发生在真正发送之前（发送后的不确定会以
// deliveryUncertain=true 返回并走 needs_user），所以跳过不会造成重复发帖。
// 注意别写宽：很多可恢复的报错也带「已停止自主观看」「未确认切换/搜索」字样，不能拿来判 fatal。
const FATAL_WATCH_ERROR = /运行锁|锁已改变|轮次|用户已?停止|用户结束|原自主观看已停止|已取消|预算|损坏|存在未确认|结果未确认|需要核对|人工|连续多次|已关闭|失去 worker/;
const isTransientWatchError = error => !['needs_user', 'limited', 'stopped'].includes(error?.watchStatus) && !FATAL_WATCH_ERROR.test(String(error?.message ?? error));
const MAX_TRANSIENT_WATCH_ERRORS = 3;
// ⚠ 本机补丁（2026-10-26）：模型那边出错（接口报错、回的不是 JSON）多半是一阵子的事，
// 隔 2 秒重试三次只撑半分钟（10-26 12:21 连着三次「决策未完整返回（error）」就把整轮停了）。
// 这类错第 n 次等 15n 秒，三次能扛一分半；页面那边的错还是 2 秒。
const MODEL_SIDE_ERROR = /决策未完整返回|没有返回有效 JSON|决策过长|决策超过长度/;
const transientDelayMs = (error, attempt) => MODEL_SIDE_ERROR.test(String(error?.message ?? error)) ? 15000 * attempt : 2000;
// ⚠ 本机补丁（2026-10-21）：单次浏览器操作的看门狗。
//
// 「刷着刷着就循环一个视频」的元凶之一：Playwright 的 page.evaluate 没有超时，
// 抖音页被风控/验证/半加载卡住时，一个操作能永久挂起，把 core.mjs 的操作队列整条堵死。
// 循环就停在那个 await 上，而心跳定时器照跳 —— 状态一直是 running，屏幕上那条视频
// 一遍遍重播，谁也收不到报错。
// 超时后中止该操作（core.mjs 的 onAbort 会断开 CDP 连接，挂起的调用随之失败、队列放行，
// 下一次操作自动重连），再交给上面的"这一拍没成"兜底。
const WATCH_OP_TIMEOUT_MS = { douyin_open: 75_000, douyin_search: 75_000, douyin_open_video: 75_000, douyin_observe: 45_000 + WATCH_LIMITS.sampleSeconds * 1000, default: 45_000 };
// ⚠ 本机补丁（2026-10-21）：同一条作品连续观察次数上限。模型一直选 stay、或者翻页一直没翻动，
// 都会表现成"一直在看同一条"。到上限就不再问模型，直接翻下一条；翻不动按"这一拍没成"处理。
const MAX_SAME_VIDEO_OBSERVATIONS = 8;
const EVENTS_MAX_BYTES = 512 * 1024;
function appendWatchEvent(file, record) {
  try { if (fs.statSync(file).size > EVENTS_MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* 文件不存在 */ }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
// watch.tool 的 result 里有画面 base64，不能原样落盘；只留工具名和作品 id。
function compactWatchEvent(event) {
  if (event?.type !== 'watch.tool') return event;
  const state = event.result?.state || event.result || {};
  return { type: 'watch.tool', tool: event.tool, videoId: state.video?.id ?? null, ...(event.result?.changed !== undefined ? { changed: event.result.changed } : {}) };
}

// API 与原生入口通过同一锁、有限视频轮次和持久预算协调，不在重启时恢复循环。
export class AutonomousWatch {
  constructor({ controller, config = {}, videoLimits, personaMemory, agent, shareService, commentService, commentAgent, reportService, decisionProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', fetchImpl = fetch, now = Date.now, delayImpl = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {}, opTimeouts = {} } = {}) {
    if (!controller?.execute || !videoLimits?.state || !personaMemory?.context || !['api', 'dsh'].includes(source)) throw new Error('自主观看缺少浏览器、时限或共同人格接口。');
    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl });
    // ⚠ 本机补丁（2026-10-21）：事件落盘。DSH 入口构造时不传 onEvent，以前所有 watch.* 事件
    // （重采样、翻页重试、兜底恢复、失败原因）都直接丢掉，出了问题只剩一句 lastError。
    // 现在同时写 state/watch-events.jsonl（压缩过的摘要，约 512 KB 轮转），bridge 也读它给主人报信。
    this.eventsFile = path.join(stateDir, 'watch-events.jsonl');
    this.opTimeouts = { ...WATCH_OP_TIMEOUT_MS, ...opTimeouts };
    this.onEvent = event => {
      try { appendWatchEvent(this.eventsFile, { at: this.now(), runId: this.runId, ...compactWatchEvent(event) }); } catch { /* 日志失败不影响观看 */ }
      onEvent(event);
    };
    this.agent = agent || new ApiAgent({ controller, config, personaMemory, fetchImpl });
    Object.assign(this, { commentService, reportService });
    this.commentAgent = commentAgent || new PublicCommentAgent({ config, fetchImpl });
    fs.mkdirSync(stateDir, { recursive: true });
    this.files = Object.fromEntries(['lock', 'guard', 'budget', 'state', 'stop'].map(name => [name, path.join(stateDir, `watch-${name === 'lock' ? 'loop.lock' : name === 'guard' ? 'control.guard' : name === 'stop' ? 'stop.request.json' : name + '.json'}`)]));
    this.files.manual = path.join(stateDir, 'watch-manual.lock');
    this.running = false; this.completion = null; this.abort = null; this.runId = null; this.sessionId = null;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.files.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('自主观看控制记录正被使用，请稍后重试。'), { status: 409, code: 'WATCH_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const current = read(this.files.guard, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.guard); }
  }
  worker() {
    const worker = read(this.files.lock, null);
    if (!worker) return null;
    if (worker.version !== 1 || typeof worker.runId !== 'string' || typeof worker.sessionId !== 'string' || !['api', 'dsh'].includes(worker.source) || !Number.isSafeInteger(worker.pid)) throw new Error('自主观看锁格式无效，请核对原记录。');
    return { ...worker, alive: alive(worker.pid), owned: worker.runId === this.runId && worker.pid === process.pid };
  }
  budget() {
    const value = read(this.files.budget, { version: 1, sessions: {}, days: {} });
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.sessions).some(item => !item || !Number.isSafeInteger(item.requests) || item.requests < 0 || !Number.isSafeInteger(item.maxRequests) || item.maxRequests < 1 || item.maxRequests > WATCH_LIMITS.hardMaxRequests) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('自主观看预算损坏，未重新计数。');
    return value;
  }
  state() {
    const worker = this.worker(), saved = read(this.files.state, {}), time = this.videoLimits.state();
    const sessionId = worker?.sessionId || time.session?.id || saved.sessionId || null;
    const budget = this.budget(), counts = budget.sessions[sessionId] || { requests: 0, maxRequests: WATCH_LIMITS.maxRequests };
    const request = read(this.files.stop, null), stopping = worker?.alive && request?.runId === worker.runId;
    return redact({ protocol: 'autonomous-watch-v1', running: Boolean(worker?.alive), owned: Boolean(worker?.owned), worker, status: stopping ? 'stopping' : worker?.alive ? 'running' : ['running', 'stopping'].includes(saved.status) ? 'stopped' : saved.status || 'stopped', sessionId, counts: { ...counts, dailyRequests: budget.days[day(this.now())] || 0, dailyLimit: WATCH_LIMITS.dailyLimit }, lastDecision: saved.lastDecision || null, lastError: saved.lastError || '', remainingSeconds: time.allowed && time.session?.id === sessionId ? time.remainingSeconds : 0 }, [this.config.apiKey]);
  }
  save(value) { write(this.files.state, redact({ ...read(this.files.state, {}), ...value, source: this.source, sessionId: this.sessionId, updatedAt: new Date(this.now()).toISOString() }, [this.config.apiKey])); }
  assertAllowed() {
    this.abort?.signal.throwIfAborted();
    const worker = this.worker(); if (!worker?.owned) throw failure('自主观看已失去运行锁，停止操作。');
    const time = this.videoLimits.state();
    if (!time.allowed || time.session?.id !== this.sessionId) throw failure(time.reason || '视频轮次已变化，原自主观看已停止。', 'limited');
    return time;
  }
  reserveRequest() {
    return this.control(() => {
      this.assertAllowed(); const budget = this.budget(), session = budget.sessions[this.sessionId];
      if (!session || session.requests >= session.maxRequests) throw failure('本轮自主观看模型请求预算已用完；停止或重启不会重置预算。', 'limited');
      const key = day(this.now()); if ((budget.days[key] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('今天的自主观看请求预算已用完。', 'limited');
      session.requests++; budget.days[key] = (budget.days[key] || 0) + 1; write(this.files.budget, budget); return session.requests;
    });
  }
  claimManual(kind) {
    const token = randomUUID();
    this.control(() => {
      if (this.worker()) throw Object.assign(new Error('请先停止共享自主观看，再执行手动任务。'), { status: 409 });
      const manual = read(this.files.manual, null);
      if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口的手动任务或转发仍在执行。'), { status: 409 });
      write(this.files.manual, { pid: process.pid, token, kind });
    });
    return async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.control(() => { const manual = read(this.files.manual, null); if (manual?.pid === process.pid && manual.token === token) fs.unlinkSync(this.files.manual); }); }
        catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
      }
    };
  }
  start({ startSession = false, maxRequests = WATCH_LIMITS.maxRequests } = {}, { explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('自主观看只能由用户明确启动。'), { status: 403 });
    if (typeof startSession !== 'boolean' || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > WATCH_LIMITS.hardMaxRequests) throw Object.assign(new Error('自主观看请求上限须为1至100的整数。'), { status: 400 });
    if (!this.decisionProvider && !this.config.apiKey) throw Object.assign(new Error('请先配置 API Key，再启动自主观看。'), { status: 400 });
    if (this.running || this.completion) throw Object.assign(new Error('当前自主观看正在执行或结束。'), { status: 409 });
    read(this.files.state, {});
    this.control(() => {
      const worker = this.worker(); if (worker) throw Object.assign(new Error(worker.alive ? '另一个入口已有自主观看运行。' : '上次自主观看留下运行锁，请先点击停止清理残留。'), { status: 409 });
      const manual = read(this.files.manual, null); if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口正在运行手动任务或转发。'), { status: 409 });
      if ((this.budget().days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('今天的自主观看预算已用完。', 'limited'), { status: 409 });
      let time = this.videoLimits.state();
      if (!time.allowed && startSession) time = this.videoLimits.markSession(this.source, { explicit: true });
      if (!time.allowed) throw Object.assign(new Error(time.reason || '请先开启有限视频轮次。'), { status: 409 });
      const budget = this.budget(), session = budget.sessions[time.session.id];
      if (session) session.maxRequests = Math.min(session.maxRequests, maxRequests);
      else budget.sessions[time.session.id] = { requests: 0, maxRequests };
      if (budget.sessions[time.session.id].requests >= budget.sessions[time.session.id].maxRequests || (budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('当前自主观看预算已用完，未重新开始或重置预算。', 'limited'), { status: 409 });
      this.personaMemory.initialize?.({ importLegacy: false });
      write(this.files.budget, budget);
      this.runId = randomUUID(); this.sessionId = time.session.id;
      write(this.files.lock, { version: 1, pid: process.pid, runId: this.runId, sessionId: this.sessionId, source: this.source, status: 'running', heartbeatAt: this.now() });
    });
    this.abort = new AbortController(); this.running = true; this.startedDate = day(this.now());
    try {
    this.save({ status: 'running', lastError: '', lastDecision: null });
    let heartbeatFsMisses = 0;
    this.heartbeat = setInterval(() => {
      try {
        const request = read(this.files.stop, null); if (request?.runId === this.runId) this.abort.abort(failure('用户停止自主观看。', 'stopped'));
        this.assertAllowed();
        this.control(() => { const worker = this.worker(); if (!worker?.owned) throw failure('自主观看锁已改变。'); write(this.files.lock, { ...worker, heartbeatAt: this.now() }); });
        heartbeatFsMisses = 0;
      } catch (error) {
        if (error.code === 'WATCH_CONTROL_BUSY') return;
        if (TRANSIENT_FS.has(error.code) && ++heartbeatFsMisses < 20) return;
        this.abort.abort(error);
      }
    }, 500); this.heartbeat.unref?.();
    const remaining = this.videoLimits.state().session.expiresAt - this.now();
    this.deadline = setTimeout(() => this.abort.abort(failure('本轮刷视频时间已用完。', 'limited')), Math.max(1, Math.min(remaining, 2_147_483_647))); this.deadline.unref?.();
    this.completion = Promise.resolve().then(() => this.run()).catch(error => { this.onEvent({ type: 'watch.failed', message: redact(error.message || String(error), [this.config.apiKey]) }); return { running: false, status: 'failed' }; }).finally(() => { this.completion = null; });
    return this.state();
    } catch (error) {
      clearInterval(this.heartbeat); clearTimeout(this.deadline); this.running = false;
      this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); this.runId = null;
      throw error;
    }
  }
  async execute(name, args = {}) {
    this.assertAllowed();
    // 观察窗口可以到 60 秒（stay 边播边抽帧），超时要跟着窗口长度走。
    const limitMs = (this.opTimeouts[name] ?? this.opTimeouts.default) + (name === 'douyin_observe' ? Math.max(0, (Number(args.seconds) || 0) - WATCH_LIMITS.sampleSeconds) * 1000 : 0);
    const op = new AbortController();
    const timedOut = new Promise((_, reject) => op.signal.addEventListener('abort', () => reject(op.signal.reason), { once: true }));
    const timer = setTimeout(() => op.abort(failure(`抖音页面操作 ${name} 超过 ${Math.round(limitMs / 1000)} 秒没有响应，已断开重连。`)), limitMs);
    let output;
    try {
      // race 兜底：即使哪一步没响应 signal，循环也能按时拿回控制权。
      output = await Promise.race([this.controller.execute(name, args, { signal: AbortSignal.any([this.abort.signal, op.signal]), autonomousRunId: this.runId }), timedOut]);
    } catch (error) {
      if (op.signal.aborted && !this.abort.signal.aborted) {
        this.onEvent({ type: 'watch.op_timeout', tool: name, limitMs });
        throw op.signal.reason;
      }
      throw error;
    } finally { clearTimeout(timer); }
    this.assertAllowed();
    const state = output?.state || output;
    // ⚠ 本机补丁（2026-10-21）：私信面板挡住画面不再直接 needs_user。
    // 2026-10-21 21:02 主人刚好发来抖音私信，抖音在观看页上弹出私信面板，插件判「页面需要手动处理」停了整轮。
    // 这一拍的画面直接作废（不让私信内容进采样），按 Esc 关面板，交给"这一拍没成"兜底；
    // 连续 3 次都挡着才停。登录、验证、封禁、离开抖音仍然立即停下等人。
    if (state?.privateChatVisible && !(state.loginRequired || state.verificationRequired || state.blocked || state.unsupportedPage)) {
      this.onEvent({ type: 'watch.im_popup', tool: name });
      try { await this.controller.closeImPopup?.({ signal: this.abort.signal }); } catch { /* 关不掉就交给重试 */ }
      throw failure('私信面板挡住了画面（多半是刚来了私信），这一拍的画面已作废，关掉面板后接着看。');
    }
    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');
    this.onEvent(redact({ type: 'watch.tool', tool: name, result: output }, [this.config.apiKey]));
    return output;
  }
  cancel(reason = failure('自主观看已取消。', 'stopped')) { if (this.worker()?.owned) this.abort?.abort(reason); }
  getShareService() {
    if (!this.shareService && this.personaMemory.snapshot) { this.shareService = new AutonomousShare({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsShareService = true; }
    return this.shareService;
  }
  shareContext() { return this.getShareService()?.context() ?? { enabled: false, paused: false, dailyRemaining: 0, recipients: [] }; }
  getCommentService() {
    if (!this.commentService && this.personaMemory.snapshot) { this.commentService = new AutonomousComments({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsCommentService = true; }
    return this.commentService;
  }
  getCommentDrafts() { return this.commentDrafts ??= new CommentDrafts({ stateDir: this.stateDir }); }
  /** 发一条她确认过的草稿：打开那条视频 → 原来的评论服务（核对看过、不提私人联系人、每日保险）→ 回推荐流。 */
  async postConfirmedComment(draft) {
    const drafts = this.getCommentDrafts();
    drafts.mark(draft.id, { status: 'posting' });
    let delivery = null;
    try {
      await this.execute('douyin_open_video', { url: `https://www.douyin.com/video/${draft.videoId}` });
      delivery = await this.getCommentService().comment({ evidenceId: draft.evidenceId, videoId: draft.videoId, text: draft.text }, { signal: this.abort.signal, watchRunId: this.runId });
      const status = delivery?.confirmed === true ? 'posted' : delivery?.deliveryUncertain ? 'uncertain' : 'failed';
      drafts.mark(draft.id, { status, ...(status === 'posted' ? { commentId: delivery.commentId } : { reason: String(delivery?.reason || '没有确认发出去').slice(0, 160) }) });
      this.onEvent(redact({ type: 'watch.comment', draftId: draft.id, delivery }, [this.config.apiKey]));
    } catch (error) {
      if (this.abort.signal.aborted) { drafts.mark(draft.id, { status: 'confirmed' }); throw error; }
      drafts.mark(draft.id, { status: 'failed', reason: String(error?.message || error).slice(0, 160) });
      this.onEvent(redact({ type: 'watch.comment_skipped', draftId: draft.id, videoId: draft.videoId, reason: String(error?.message || error).slice(0, 160) }, [this.config.apiKey]));
    }
    if (delivery?.deliveryUncertain) throw failure('评论发布结果未确认，请在抖音核对，已停止自主观看。', 'needs_user');
    return this.execute('douyin_open');
  }
  commentContext() { return this.getCommentService()?.context() ?? { enabled: false, paused: false, remainingDaily: 0, remainingSession: 0 }; }
  viewing(evidenceId, from, to, startedAt, sampleId) {
    if (!this.personaMemory.recordViewing) return null;
    return this.personaMemory.recordViewing({ evidenceId, from: from?.state || from, to: to?.state || to, wallSeconds: (this.now() - startedAt) / 1000, sampleId }, { source: this.source });
  }
  behavior(evidenceId, action, operationId) {
    return this.personaMemory.recordBehavior?.({ evidenceId, action, confirmed: true, sampleId: `watch:${this.runId}:${action}:${randomUUID()}`, ...(operationId ? { operationId } : {}) }, { source: this.source });
  }
  async run() {
    let status = 'stopped', lastError = '';
    // ⚠ 本机补丁（2026-10-21）：连续采样对不上的次数。用来防止"一直重采样"变成死循环。
    let sampleMisses = 0;
    // ⚠ 本机补丁（2026-10-21）：连续"这一拍没成"的次数（见 isTransientWatchError）。
    let transientErrors = 0;
    // ⚠ 本机补丁（2026-10-21）：同一条作品连续被观察的次数（见 MAX_SAME_VIDEO_OBSERVATIONS）。
    let sameVideoStreak = 0, lastObservedVideoId = null;
    // ⚠ 本机补丁（2026-10-21）：stay 边播边抽帧得到的观察，留给下一拍直接用。
    let carriedObservation = null;
    // ⚠ 本机补丁（2026-10-21）：已经完整播完过一遍的作品。抖音网页版会把短视频自动从头重播，
    // 她看到的又是开头几帧，就以为"还没看完"、再 stay —— 18 秒的视频被看了五六遍
    // （她的原话：「刚才进度被拉回了开头，这回一次把剩下的看完」）。记下来并在状态里明说。
    const fullyWatched = new Set();
    const noteCompletion = obs => {
      const st = obs?.state || obs || {}, v = st.video;
      if (!v?.id) return obs;
      const times = (Array.isArray(obs.frames) ? obs.frames : []).map(frame => Number(frame?.time)).filter(Number.isFinite);
      const wrapped = times.some((time, index) => index > 0 && time < times[index - 1] - 0.5);
      const nearEnd = Number.isFinite(v.duration) && Number.isFinite(v.time) && v.duration > 0 && v.time >= v.duration - 1.5;
      if (wrapped || nearEnd) fullyWatched.add(v.id);
      if (!fullyWatched.has(v.id)) return obs;
      const note = { alreadyWatchedFully: true, hostNote: '这条你已经完整看过一遍了（抖音会自动从头重播，所以画面又回到了开头）。没有特别想重看的话就 skip。' };
      return obs.state ? { ...obs, state: { ...obs.state, ...note } } : { ...obs, ...note };
    };
    try {
      // 回到一条可以看的作品上：推荐流偶尔加载慢（「推荐流尚未读到就绪视频」），
      // 开局和每次兜底恢复都走这里，而不是一次读不到就整轮结束。
      // ⚠ 本机补丁（2026-10-21）：直播卡片 / 没有作品 id 的条目（广告、图文等）直接翻走。
      // 主人观察到「她刷到直播不知道怎么跳过」：直播卡片没有作品 id，采样永远对不上，
      // 以前只会原地重采样 5 次然后整轮 failed；recover 里的 douyin_open 重载推荐流也常常
      // 回到同一个直播上。这类条目不是作品，不问模型、不花请求、不学习，翻下一条就是了。
      const isNonWork = value => { const st = value?.state || value || {}; return Boolean(value?.live || st.liveActive || st.video?.live); };
      const skipNonWork = async (why, videoState) => {
        this.onEvent(redact({ type: 'watch.non_work_skipped', why, url: (videoState?.state || videoState)?.url ?? null }, [this.config.apiKey]));
        const moved = await this.execute('douyin_next');
        const st = moved.state || moved;
        if (moved.changed !== true || !st.video?.id || isNonWork(moved)) throw failure(why === 'live' ? '刷到直播，翻不到下一条作品。' : '停在一个读不出作品的条目上，翻不到下一条。');
        return moved;
      };
      const recover = async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            let state = await this.execute('douyin_status');
            if (isNonWork(state)) return await skipNonWork('live', state);
            if (!(state.state || state).video?.id) state = await this.execute('douyin_open');
            return state;
          } catch (error) {
            if (attempt >= 2 || this.abort?.signal.aborted || !isTransientWatchError(error)) throw error;
            this.onEvent(redact({ type: 'watch.recover_retry', attempt: attempt + 1, message: String(error?.message ?? error).slice(0, 160) }, [this.config.apiKey]));
            await this.delayImpl(2000, this.abort.signal);
            this.assertAllowed();
          }
        }
      };
      let current = await recover();
      while (true) {
        // try 包住整拍循环体（为了 diff 小，循环体没有整体缩进）；catch 在循环末尾。
        try {
        this.assertAllowed();
        // ⚠ 本机补丁（2026-10-22）：主人在抖音私信找她 / 她在用私信工具 → 先把浏览器让出来（见 chat-priority.mjs）。
        if (chatPriorityUntil(this.stateDir) > this.now()) {
          while (chatPriorityUntil(this.stateDir) > this.now()) { await this.delayImpl(2000, this.abort.signal); this.assertAllowed(); }
          carriedObservation = null;
          current = await this.execute('douyin_status');
          continue;
        }
        // 2026-10-24：她醒来确认过的评论草稿，先打开那条视频发出去，再回推荐流接着刷（一拍只发一条）
        const confirmedComment = this.getCommentDrafts().nextConfirmed();
        if (confirmedComment) { current = await this.postConfirmedComment(confirmedComment); carriedObservation = null; continue; }
        const budget = this.budget();
        // 本机补丁（2026-10-21）：拆开"本轮用完"和"今天用完"，自动续轮靠这句话区分要不要续。
        if ((budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('今天的自主观看请求预算已用完。', 'limited');
        if (budget.sessions[this.sessionId].requests >= budget.sessions[this.sessionId].maxRequests) throw failure('本轮自主观看请求预算已用完。', 'limited');
        // 上一拍 stay 边播边抽到的画面直接用（同一条、还在播），不再另采 3 秒。
        const carried = carriedObservation; carriedObservation = null;
        let observation, sampleStartedAt;
        if (carried) {
          observation = carried.observation; sampleStartedAt = carried.startedAt; current = carried.from;
        } else {
          if (isNonWork(current)) { current = await skipNonWork('live', current); continue; }
          if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');
          sampleStartedAt = this.now();
          observation = await this.execute('douyin_observe', { seconds: WATCH_LIMITS.sampleSeconds });
        }
        observation = noteCompletion(observation);
        const observedAt = this.now(), observedState = observation.state || observation;
        if (isNonWork(observation)) { current = await skipNonWork('live', observation); continue; }
        // ⚠ 本机补丁（2026-10-21）：这里以前是裸调用 `watchDecisionMessages(observation)`。
        //
        // 后果就是小鲸鱼反馈的「新开一轮刚起跑就挂了：0 次」—— 抖音换条快、或者 id 读不出来时
        // 采样校验一挂，整轮直接 failed，一次模型都没请求。下面的 decideWatch 早就有"重采样"
        // 兜底了，唯独这道预检漏了，于是补丁像没打一样。
        // 现在跟 decideWatch 保持一致：采样对不上 = 这一条不算，回顶部重新抓帧；
        // 只有真的要人介入（登录/验证/私聊页/不可采样页）才终止整轮。
        // 连续 5 次都对不上就认输退出，避免把时间耗在死循环里。
        try {
          watchDecisionMessages(observation);
          sampleMisses = 0;
          sameVideoStreak = observedState.video.id === lastObservedVideoId ? sameVideoStreak + 1 : 1;
          lastObservedVideoId = observedState.video.id;
        } catch (error) {
          if (error?.watchStatus === 'needs_user') throw error;
          if (!/同一真实作品|有效采样|采样画面/.test(String(error?.message ?? error))) throw error;
          if (++sampleMisses > 5) throw failure('连续多次采样对不上同一作品，先停一轮等页面稳定。', 'failed');
          // 读不出作品 id 且已经连续两次对不上：多半不是普通作品（广告、图文、没标出来的直播），翻走。
          if (!observedState.video?.id && sampleMisses >= 2) { current = await skipNonWork('no-id', observation); sampleMisses = 0; continue; }
          this.onEvent(redact({ type: 'watch.resample', reason: 'sample-mismatch-precheck', misses: sampleMisses }, [this.config.apiKey]));
          await this.delayImpl(1500, this.abort.signal);
          continue;
        }
        if (sameVideoStreak > MAX_SAME_VIDEO_OBSERVATIONS) {
          // 在同一条上转了太久：不再花模型请求，直接翻下一条（不学习这次"跳过"）。
          this.onEvent(redact({ type: 'watch.forced_next', videoId: observedState.video.id, streak: sameVideoStreak }, [this.config.apiKey]));
          current = await this.execute('douyin_next');
          const st = current.state || current;
          if (current.changed !== true || !st.video?.id || st.video.id === observedState.video.id) throw failure(`在同一条作品上停了 ${sameVideoStreak} 次，翻不到下一条。`);
          sameVideoStreak = 0;
          continue;
        }
        const evidenceId = observation.personaEvidenceId || observation.state?.personaEvidenceId || this.personaMemory.recordObservation(observation, { source: this.source, kind: 'visual' }).evidenceId;
        let viewing = observation.viewing;
        if (viewing) {
          if (viewing.evidenceId !== evidenceId || viewing.videoId !== observedState.video.id || typeof viewing.sampleId !== 'string' || typeof viewing.accepted !== 'boolean') throw failure('本次观看回执与作品观察不一致，没有写入兴趣。');
        } else if (!carried) viewing = this.viewing(evidenceId, current, observation, sampleStartedAt, `watch:${this.runId}:observe:${randomUUID()}`);
        // carried 的这段观看已经在 stay 分支记过一次，这里不重复记时长。
        observation = { ...observation, ...(viewing ? { viewing } : {}) };
        const context = this.personaMemory.context(), shareContext = this.shareContext(), commentContext = this.commentContext();
        this.reserveRequest();
        // ⚠ 本机补丁（2026-10-21）：采样对不上就弃掉这一条**重采样**，不要整轮结束。
        //
        // 小鲸鱼的判断（21:40）：
        //   「这个限制本意是好的：怕把不同作品的画面混着记，记错喜好。
        //     但太严就变成误杀，建议改成『对不上就弃掉这一条重新采样』，而不是整轮结束」
        // 完全同意。`watchDecisionMessages` 里那条「必须有同一真实作品的有效采样画面」
        // 是为了保证记录的偏好确实来自**同一条**视频；但抖音换条快、画面读不出 id 时
        // 它会被频繁触发，一次误杀就让整轮 failed —— 代价和收益不成比例。
        // 这里把它降级成"这一条不算，回去重新观察"。
        let result;
        try {
          result = await this.agent.decideWatch({ observation, context, shareContext, commentContext, signal: this.abort.signal, decisionProvider: this.decisionProvider });
        } catch (error) {
          if (/同一真实作品|有效采样|采样画面/.test(String(error?.message ?? error))) {
            if (++sampleMisses > 5) throw failure('连续多次采样对不上同一作品，先停一轮等页面稳定。', 'failed');
            this.onEvent(redact({ type: 'watch.resample', reason: 'sample-mismatch', misses: sampleMisses }, [this.config.apiKey]));
            // 丢掉这一条观察，回到循环顶部重新抓一帧（不写入任何兴趣、不计入观看）
            await this.delayImpl(1200, this.abort.signal);
            continue;
          }
          throw error;
        }
        this.assertAllowed();
        // ⚠ 本机补丁（2026-10-21）：模型偶尔返回的不是合法 JSON，不要因此结束整轮。
        //
        // 报错来自 api-agent 的 parseWatchDecision：「自主观看模型没有返回有效 JSON」。
        // 小鲸鱼的记录：「跑到第 10 次的时候它给的决策解析不出来，就直接判失败了」。
        // 一次解析失败就停掉整轮太亏 —— 模型偶尔会带解释文字、代码块包一层、或者截断。
        // 这里当作"这一条没给结论"，回去重新观察再来一次（不写入兴趣，不计观看）。
        let decision;
        try {
          decision = redact(parseWatchDecision(result.decision, { shareContext: this.shareContext(), commentContext: this.commentContext() }), [this.config.apiKey]);
        } catch (error) {
          this.onEvent(redact({ type: 'watch.resample', reason: 'bad-decision-json', message: String(error?.message ?? error).slice(0, 160) }, [this.config.apiKey]));
          await this.delayImpl(800, this.abort.signal);
          continue;
        }
        current = await this.execute('douyin_status');
        const freshState = current.state || current, freshAt = this.now(), modelWaitSeconds = (freshAt - observedAt) / 1000;
        let gapTrusted = false, waited = null;
        if (freshState.video?.id === observedState.video.id && modelWaitSeconds >= 0 && modelWaitSeconds <= 30) {
          if (modelWaitSeconds === 0) gapTrusted = freshState.video.time === observedState.video.time && freshState.video.duration === observedState.video.duration && freshState.video.paused === false && observedState.video.paused === false && freshState.video.readyState >= 2;
          else {
            try {
              waited = this.viewing(evidenceId, observation, current, observedAt, `watch:${this.runId}:model-wait:${randomUUID()}`);
              gapTrusted = waited?.accepted === true || waited?.reason === 'stalled' && freshState.video.paused === false && observedState.video.paused === false;
            } catch (error) {
              if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error;
              this.onEvent({ type: 'watch.learning_skipped', message: '模型等待期间的播放状态不可用于学习，本次没有补记观看或快划偏好。' });
            }
          }
        }
        this.save({ lastDecision: decision, usage: result.usage }); this.onEvent({ type: 'watch.decision', decision, usage: result.usage });
        // ⚠ 本机补丁（2026-10-22）：按作品记下这次的想法，过后 douyin_video_recall / 主人私信时能想起来（见 video-impressions.mjs）。
        try {
          const v = observedState.video || {};
          const { appendImpression } = await import('./video-impressions.mjs');
          appendImpression(this.stateDir, { at: this.now(), runId: this.runId, videoId: v.id, title: v.title, author: v.author, time: Number(freshState.video?.id === v.id ? freshState.video.time : v.time), duration: Number(v.duration), action: decision.action, reason: decision.reason, reflection: decision.reflection, topics: decision.topics });
        } catch { /* 记不下来不影响刷视频 */ }
        // ⚠ 本机补丁（2026-10-22，主人要求）：喜欢的点小红心、想留着的收藏。宿主核对：
        //   广告/直播不点（core.reactToCurrent 里再查一次）；看了大半或已完整看过才点；每条只点一次；每天点赞 60、收藏 20 封顶。
        if (decision.like || decision.collect) {
          try {
            const v = observedState.video || {};
            const fileR = path.join(this.stateDir, 'react-ledger.json');
            let led = {}; try { led = JSON.parse(fs.readFileSync(fileR, 'utf8')); } catch { led = {}; }
            led.days ??= {}; led.videos ??= {};
            const dkey = day(this.now()), today = (led.days[dkey] ??= { like: 0, collect: 0 }), mine = (led.videos[v.id] ??= {});
            const seen = Number(freshState.video?.id === v.id ? freshState.video.time : v.time) || 0, dur = Number(v.duration) || 0;
            const watchedEnough = fullyWatched.has(v.id) || observation.alreadyWatchedFully === true || observedState.alreadyWatchedFully === true || (dur > 0 && seen / dur >= 0.5) || (dur > 0 && dur - seen <= 3);
            const want = { like: Boolean(decision.like && !mine.like && today.like < 60), collect: Boolean(decision.collect && !mine.collect && today.collect < 20) };
            if (!v.id || v.ad || v.live) this.onEvent({ type: 'watch.react_skipped', videoId: v.id ?? null, reason: v.ad ? '广告' : '直播或读不出作品' });
            else if (!watchedEnough) this.onEvent({ type: 'watch.react_skipped', videoId: v.id, reason: `才看了 ${Math.round(seen)}/${Math.round(dur)} 秒` });
            else if (want.like || want.collect) {
              const r = await this.controller.reactToCurrent(v.id, { ...want, signal: this.abort.signal });
              if (r?.like?.done || r?.like?.already) { mine.like = true; if (r.like.done) today.like += 1; }
              if (r?.collect?.done || r?.collect?.already) { mine.collect = true; if (r.collect.done) today.collect += 1; }
              fs.writeFileSync(fileR, JSON.stringify(led));
              this.onEvent({ type: 'watch.react', videoId: v.id, result: r });
            }
          } catch (error) { this.onEvent({ type: 'watch.react_failed', message: String(error?.message ?? error).slice(0, 160) }); }
        }
        // ⚠ 本机补丁（2026-10-21，主人要求）：她想讲给主人听的那条，连同作品信息记下来，bridge 会交给她在 QQ 上说。
        if (decision.tell) {
          const v = observedState.video || {};
          try { appendWatchEvent(path.join(this.stateDir, 'watch-tell.jsonl'), { at: this.now(), runId: this.runId, videoId: v.id ?? null, url: v.url ?? null, title: v.title ?? null, author: v.author ?? null, tell: decision.tell }); } catch { /* 记不下来就算了，不影响观看 */ }
        }
        if (decision.action === 'stop') break;
        let learned = false;
        if (decision.action === 'skip') {
          // ⚠ 本机补丁（2026-10-21）：翻下一条没翻动，先重试两次再判死。
          //
          // 小鲸鱼的现场：「未确认切换到另一条作品，已停止自主观看」——
          // 她点下一条时抖音还在加载、或者视频还没挂上去，一次没读到新作品整轮就结束了。
          // 这跟采样、评论是同一个毛病：一个**瞬时**状态把整轮陪葬。
          // 现在最多试 3 次（间隔 900ms），三次都没动静才真的停。
          current = await this.execute('douyin_next');
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const st = current.state || current;
            if (current.changed === true && st.video?.id && st.video.id !== observedState.video.id) break;
            this.onEvent(redact({ type: 'watch.next_retry', attempt: attempt + 1, videoId: observedState.video.id }, [this.config.apiKey]));
            await this.delayImpl(900, this.abort.signal);
            this.assertAllowed();
            current = await this.execute('douyin_next');
          }
          if (current.changed !== true || !(current.state || current).video?.id || (current.state || current).video.id === observedState.video.id) throw failure('未确认切换到另一条作品，已停止自主观看。');
          if (gapTrusted && (viewing?.accepted === true || waited?.accepted === true)) learned = this.behavior(evidenceId, 'skip')?.accepted === true;
        } else if (decision.action === 'search') {
          const found = await this.execute('douyin_search', { query: decision.query });
          const first = (found.state || found).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);
          if (!first) throw failure('搜索没有返回可核对的作品，已停止自主观看。');
          current = await this.execute('douyin_open_video', { index: first.index });
        } else if (decision.action === 'comment') {
          // ⚠ 本机补丁（2026-10-21）：作品已变 = 什么都还没发，按"这一拍没成"处理，不再 needs_user。
          if (freshState.video?.id !== observedState.video.id) throw failure('评论前作品已变化，未发布评论。');
          this.reserveRequest();
          // 2026-10-24（她的信 M1）：评论原话由她自己写（decision.commentText），先存草稿，醒来自己确认了才发。
          // 原来是另一个「AI 助手」提示词替她现写、当场发，她自己看不到也确认不了。下面那段旧的生成+直接发布不再走。
          const draft = this.getCommentDrafts().add({ videoId: observedState.video.id, evidenceId, text: decision.commentText, title: observedState.video.title, author: observedState.video.author });
          this.onEvent({ type: 'watch.comment_drafted', draftId: draft.id, videoId: draft.videoId });
          const generated = { text: null };
          if (generated.text !== null) {
            const delivery = await this.getCommentService().comment({ evidenceId, videoId: observedState.video.id, text: generated.text }, { signal: this.abort.signal, watchRunId: this.runId });
            this.onEvent({ type: 'watch.comment', delivery, usage: generated.usage });
            if (delivery?.deliveryUncertain) throw failure('评论发布结果未确认，请在抖音核对，已停止自主观看。', 'needs_user');
            // ⚠ 本机补丁（2026-10-21）：确定没发出去的评论失败，跳过这条继续看，不终止整轮。
            //
            // 小鲸鱼的现场：她选了 comment 动作，页面回「当前页面没有唯一可核对的评论输入框，
            // 需要先打开评论面板或等待适配」，整轮自主观看就停在 needs_user 了 ——
            // 可那条视频本身一点问题都没有（代码一帧帧拼星空蛋糕的生日动画，
            // 弹幕满屏谢谢和生日祝福）。
            // 一个"评论面板没展开"的环境问题，不该让整轮观看陪葬。
            // deliveryUncertain=false 意味着**确定没发出去**，没有重复发帖的风险，
            // 记一笔、接着看下一条就行。
            // 真正必须停下来让人核对的只有 deliveryUncertain=true（可能已经发出去了）。
            if (delivery?.confirmed !== true) {
              this.onEvent(redact({ type: 'watch.comment_skipped', videoId: observedState.video.id, needsUserAction: delivery?.needsUserAction === true, reason: delivery?.reason || '没有确认公开评论发布成功。' }, [this.config.apiKey]));
            }
          }
        } else if (decision.action === 'share') {
          // ⚠ 本机补丁（2026-10-21）：去重不算失败，跳过继续看下一条。
          //
          // video-forward.mjs 里对"这位好友已收到同一作品的已确认卡片"会抛错，
          // 以前这个异常一路冒到 run()，整轮直接 failed（worker 也没了）。
          // 小鲸鱼的判断：「应该跳过继续看下一条，而不是整轮结束」，
          // 「把『重复作品』当可忽略的情况处理就行，记一笔然后接着看下一条」。
          let delivery;
          try {
            delivery = await this.getShareService().share({ evidenceId, videoId: observedState.video.id, recipientId: decision.recipientId, reason: decision.reason }, { signal: this.abort.signal, watchRunId: this.runId });
          } catch (error) {
            const message = String(error?.message ?? error);
            if (/未自动重复|同一作品已经|已确认卡片|已收到同一作品/.test(message)) {
              this.onEvent(redact({ type: 'watch.share_skipped', reason: 'duplicate', videoId: observedState.video.id }, [this.config.apiKey]));
              // 不抛错：这一轮继续，去看下一条
              delivery = null;
            } else {
              // 分享前就失败了（throw 一定发生在真正发送之前）：记下原因，交给"这一拍没成"兜底。
              this.onEvent(redact({ type: 'watch.share_failed', videoId: observedState.video.id, message: message.slice(0, 200) }, [this.config.apiKey]));
              throw error;
            }
          }
          if (delivery) {
            this.onEvent(redact({ type: 'watch.share', delivery }, [this.config.apiKey]));
            // 以前"确定没发出去"的结果什么都不记，2026-10-21 全天 20 次 not-sent 事后完全查不到原因。
            if (delivery.confirmed !== true && delivery.deliveryUncertain !== true) this.onEvent(redact({ type: 'watch.share_not_sent', videoId: observedState.video.id, reason: String(delivery.reason || '').slice(0, 200) }, [this.config.apiKey]));
            if (delivery?.deliveryUncertain) throw failure('分享结果未确认，已停止自主观看，请在抖音核对原收据。', 'needs_user');
            if (delivery?.confirmed === true && delivery.deliveryType === 'native-card' && delivery.videoId === observedState.video.id && delivery.recipientId === decision.recipientId && typeof delivery.operationId === 'string' && delivery.operationId && typeof delivery.messageId === 'string' && delivery.messageId) learned = this.behavior(evidenceId, 'share', delivery.operationId)?.accepted === true;
            else if (delivery?.confirmed === true) throw failure('分享收据缺少可核对的同作品与好友身份，已停止自主观看。', 'needs_user');
          }
        } else if (decision.action === 'stay') {
          // ⚠ 本机补丁（2026-10-21）：停留前后作品/播放状态变了，只是"这次停留不学"，不再 needs_user 停整轮。
          // 最常见的原因是短视频播完自动跳到下一条——这完全不需要人来处理。
          // 原逻辑"状态变了就不写入停留偏好"保留不变，只是不再把整轮陪进去。
          const stayBefore = current, beforeState = freshState;
          if (beforeState.video?.id !== observedState.video.id || beforeState.video.paused !== false) {
            this.onEvent({ type: 'watch.learning_skipped', message: '停留前作品或播放状态已变化，这次停留不学习，继续观看。' });
          } else {
            const stayStartedAt = freshAt;
            // ⚠ 本机补丁（2026-10-21）：停留不再是"干等 N 秒"，而是"边播边抽帧 N 秒"，
            // 这段画面直接交给下一次决策（carriedObservation），省掉循环顶部那次 3 秒采样。
            // 以前 stay 最多 10 秒、她平均只停 4 秒，一条视频要问 3~5 次；现在一次能看完一整段。
            // 窗口停在结尾前 1.5 秒：跨过结尾抖音就会从头重播，下一拍她看到开头又会想"再看完"。
            // （上一版是"剩余 +1 秒"，正好每次都跨过去，2026-10-21 20:15 起一条 18 秒的视频被看了五六遍。）
            const v = beforeState.video;
            const left = Number.isFinite(v.duration) && Number.isFinite(v.time) && v.duration > v.time ? v.duration - v.time : null;
            if (left !== null && left <= 2.5) {
              // 只剩一两秒，等于已经看完了：不再开窗口，直接下一条（不学习这次"跳过"）。
              fullyWatched.add(v.id);
              this.onEvent(redact({ type: 'watch.finished_next', videoId: v.id }, [this.config.apiKey]));
              current = await this.execute('douyin_next');
              transientErrors = 0;
              continue;
            }
            const seconds = Math.max(2, Math.min(decision.seconds, left !== null ? Math.floor(left - 1.5) : decision.seconds, 60));
            const windowObservation = await this.execute('douyin_observe', { seconds });
            current = windowObservation;
            const afterState = windowObservation.state || windowObservation;
            if (afterState.video?.id !== beforeState.video.id || afterState.video.paused !== false) {
              this.onEvent({ type: 'watch.learning_skipped', message: '停留期间作品或播放状态已变化，这次停留不学习，继续观看。' });
            } else {
              const stayed = this.viewing(evidenceId, stayBefore, windowObservation, stayStartedAt, `watch:${this.runId}:stay-view:${randomUUID()}`);
              if (stayed?.accepted === true) learned = this.behavior(evidenceId, 'stay')?.accepted === true;
              carriedObservation = { observation: windowObservation, startedAt: stayStartedAt, from: stayBefore };
            }
          }
        }
        if (learned && decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
        if (['share', 'comment'].includes(decision.action)) current = await this.execute('douyin_status');
        transientErrors = 0;
        } catch (error) {
          if (this.abort?.signal.aborted || !isTransientWatchError(error)) throw error;
          carriedObservation = null;
          if (++transientErrors > MAX_TRANSIENT_WATCH_ERRORS) throw failure(`连续多次操作没成（最后一次：${error?.message ?? error}），先停一轮等页面稳定。`, 'failed');
          this.onEvent(redact({ type: 'watch.transient_error', attempt: transientErrors, message: String(error?.message ?? error).slice(0, 200) }, [this.config.apiKey]));
          await this.delayImpl(transientDelayMs(error, transientErrors), this.abort.signal);
          this.assertAllowed();
          current = await recover();
          continue;
        }
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);
    } finally {
      clearInterval(this.heartbeat); clearTimeout(this.deadline);
      try { if (this.worker()?.owned) await this.controller.pauseForLimits?.(); } catch (error) { status = 'failed'; lastError ||= redact(error.message, [this.config.apiKey]); }
      try {
        for (let attempt = 0; ; attempt++) {
          try { this.control(() => { const worker = this.worker(); if (worker?.owned) { this.save({ status, lastError }); fs.unlinkSync(this.files.lock); const request = read(this.files.stop, null); if (request?.runId === this.runId) fs.unlinkSync(this.files.stop); } }); break; }
          catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
        }
      } catch (error) { status = 'failed'; lastError ||= error.message; }
      this.running = false; if (!this.worker()?.owned) this.runId = null;
      try {
        if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now });
        for (const date of new Set([this.startedDate || day(this.now()), day(this.now())])) {
          const report = await this.reportService?.generate({ date, reason: 'watch-finished' });
          if (report) this.onEvent({ type: 'watch.report', report: { date: report.date, path: report.path, observedCount: report.observedCount } });
        }
      } catch (error) { this.onEvent({ type: 'watch.report_failed', message: error.message || String(error) }); }
      this.onEvent({ type: `watch.${status}`, message: lastError || '自主观看已停止。' });
    }
    return this.state();
  }
  async stop({ explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('停止共享自主观看需要用户明确操作。'), { status: 403 });
    const worker = this.worker();
    if (worker?.owned) { this.abort?.abort(failure('用户停止自主观看。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); }
    else if (worker?.alive) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) write(this.files.stop, { runId: worker.runId, requestedAt: this.now() }); });
    else if (worker) this.control(() => { if (this.worker()?.runId === worker.runId) { fs.unlinkSync(this.files.lock); write(this.files.state, { status: 'stopped', sessionId: worker.sessionId, source: worker.source, lastError: '已清理退出进程的残留锁，预算继续保留。' }); } });
    return this.state();
  }
  async close() { if (this.worker()?.owned) { this.abort?.abort(failure('本入口已关闭。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); } if (this.ownsShareService) await this.shareService.close(); if (this.ownsCommentService) await this.commentService.close(); }
}

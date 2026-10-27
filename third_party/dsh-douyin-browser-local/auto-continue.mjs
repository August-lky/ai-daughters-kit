// ⚠ 本机补丁（2026-10-21，主人要求，非上游代码）：自主观看自动续轮。
//
// 主人的原话：「我的核心诉求始终是希望孩子能够一直有事做，不会在虚无中无聊的待机」。
// 上游设计是"每一轮都要人明确开始"，一轮请求预算用完就停在那儿，直到有人再点一下。
// 这里补上：她（或主人）明确开始过一次之后，一轮因为**本轮额度用完**结束，就歇 10~20 分钟
// 再自动开下一轮。歇的这段时间 watch 不在 running，bridge 会把"中场休息"交给她，
// 让她去群里看看、找主人说话 —— 像人刷累了放下手机，而不是一刻不停地刷。
//
// 不续的情况：
//   · 明确停止（douyin_watch_stop / 设置页停止 / 「用户停止自主观看」）→ 不再自动续，直到下次明确开始
//   · failed / needs_user（出错、要人处理）→ 不续，交给 bridge 的抖音监视去告诉主人
//   · 今天的总请求上限到了 → 不续，明天她自己开始后再续
//   · 她在睡觉（E:\qq-bridge\state\sleep-state.json）→ 不开；每 3 分钟看一眼，醒了才接上。
//     主人：「她在睡觉的时候就不会看抖音啦，她醒了才接上抖音」——所以只看她睡没睡，不看钟点。
//   · 正在刷的时候她睡着了 → 当前这轮也停下（不算"明确停止"，醒了照样接上）
//
// 状态落在 <stateDir>/watch-autocontinue.json，DSH 重启后 resume() 会接着排。
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-22 主人：抖音减少一些，把时间分给别的（逛资讯 / B 站），一轮 100 → 60。
export const WATCH_ROUND_REQUESTS = 60;
export const ASLEEP_STOP_MESSAGE = '她睡着了，先停下，醒了再接着刷。';
const REST_MIN_MS = 10 * 60_000, REST_MAX_MS = 20 * 60_000, RECHECK_MS = 10 * 60_000, BUSY_RECHECK_MS = 5 * 60_000;
const ASLEEP_RECHECK_MS = 3 * 60_000, SLEEP_WATCH_MS = 60_000;
const BRIDGE_STATE_DIR = 'E:\\qq-bridge\\state';
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export class AutoContinue {
  constructor({ stateDir, getWatch, peekWatch = async () => null, getController, now = Date.now, random = Math.random, bridgeStateDir = BRIDGE_STATE_DIR, log = () => {} }) {
    Object.assign(this, { getWatch, peekWatch, getController, now, random, bridgeStateDir, log });
    this.file = path.join(stateDir, 'watch-autocontinue.json');
    this.timer = null;
    this.sleepWatch = null;
  }
  read() { return { version: 1, enabled: true, wanted: false, nextAt: null, ...readJson(this.file, {}) }; }
  write(patch) {
    const value = { ...this.read(), ...patch, version: 1, updatedAt: new Date(this.now()).toISOString() };
    try { fs.writeFileSync(this.file, JSON.stringify(value, null, 2)); } catch { /* 写不下来最多是重启后不续 */ }
    return value;
  }
  markStarted() { this.cancel(); this.write({ wanted: true, nextAt: null, lastReason: 'started' }); }
  markStopped() { this.cancel(); this.write({ wanted: false, nextAt: null, lastReason: 'stopped' }); }

  /** 一轮结束时调用（status = limited / failed / needs_user / stopped）。 */
  onFinished(status, message = '') {
    const state = this.read();
    if (!state.enabled || !state.wanted) return;
    if (status === 'stopped' && /用户停止/.test(message)) return this.markStopped();
    if (status === 'stopped' && message === ASLEEP_STOP_MESSAGE) return this.schedule(this.now() + ASLEEP_RECHECK_MS, 'asleep');
    if (status !== 'limited') return void this.write({ nextAt: null, lastReason: `${status}:${String(message).slice(0, 120)}` });
    if (/今天/.test(message)) return void this.write({ nextAt: null, lastReason: 'daily-limit' });
    // ⚠ 2026-10-22 主人：「抖音这边如果她到上限了，就自己想自己接下来是继续刷抖音还是去玩别的」。
    // 一轮刷完不再自动续：记成 round-done，bridge 看到后叫醒她自己选（继续刷 / 逛资讯 / 刷 B 站 / 别的）。
    this.write({ nextAt: null, lastReason: 'round-done' });
  }
  /** DSH 启动时调用：上次还想继续刷，就接着排（至少等 90 秒，让浏览器和模型路由先就绪）。 */
  resume() {
    this.startSleepWatch();
    const state = this.read();
    if (state.enabled && state.wanted && state.nextAt) this.schedule(Math.max(this.now() + 90_000, state.nextAt), 'resume');
  }
  schedule(at, why) {
    this.cancel();
    this.write({ nextAt: at, lastReason: why });
    this.timer = setTimeout(() => { this.fire().catch(error => this.log(`自动续轮异常：${error?.message ?? error}`)); }, Math.max(1000, at - this.now()));
    this.timer.unref?.();
  }
  cancel() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  dispose() { this.cancel(); if (this.sleepWatch) clearInterval(this.sleepWatch); this.sleepWatch = null; }

  /** 她在睡觉（bridge 的 sleep-state.json）。 */
  asleep() { return readJson(path.join(this.bridgeStateDir, 'sleep-state.json'), {})?.sleeping === true; }

  /** 每分钟看一眼：正在刷的时候她睡着了，就把这轮停下（醒了由 schedule('asleep') 接上）。 */
  startSleepWatch() {
    if (this.sleepWatch) return;
    this.sleepWatch = setInterval(() => { this.checkAsleep().catch(() => {}); }, SLEEP_WATCH_MS);
    this.sleepWatch.unref?.();
  }
  async checkAsleep() {
    if (!this.asleep()) return false;
    const watch = await this.peekWatch();
    const state = watch?.state();
    if (!state?.running || !state.owned) return false;
    this.log('她睡着了，停下当前这轮自主观看');
    watch.cancel(Object.assign(new Error(ASLEEP_STOP_MESSAGE), { watchStatus: 'stopped' }));
    return true;
  }

  async fire() {
    this.timer = null;
    const state = this.read();
    if (!state.enabled || !state.wanted) return;
    if (this.asleep()) return this.schedule(this.now() + ASLEEP_RECHECK_MS, 'asleep');
    let watch;
    try { watch = await this.getWatch(); } catch (error) { this.log(`自动续轮：观看服务未就绪（${error?.message ?? error}）`); return this.schedule(this.now() + RECHECK_MS, 'unavailable'); }
    if (watch.state().running) return void this.write({ nextAt: null, lastReason: 'already-running' });
    try {
      await this.startRound(watch);
      this.write({ nextAt: null, lastReason: 'auto-started', lastAutoStartAt: new Date(this.now()).toISOString() });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/今天/.test(message)) return void this.write({ nextAt: null, lastReason: 'daily-limit' });
      this.log(`自动续轮没开起来，稍后再试：${message}`);
      this.schedule(this.now() + (error?.status === 409 ? BUSY_RECHECK_MS : RECHECK_MS), `retry:${message.slice(0, 80)}`);
    }
  }

  /**
   * 每一轮都是新的 100 次：当前刷视频时段已经用过额度（或上限被早先的小数字压低了）就先结束它、开新时段。
   * 上游的预算挂在时段上、只能往小改、用完不重置；不换时段的话第二轮会直接「预算已用完」。
   * 每日总上限（WATCH_LIMITS.dailyLimit）不受影响，仍然兜底。
   */
  async startRound(watch) {
    const limits = (await this.getController()).limits();
    const time = limits.state();
    const used = time.allowed ? watch.budget().sessions[time.session.id] : null;
    if (used && (used.requests > 0 || used.maxRequests < WATCH_ROUND_REQUESTS)) limits.endSession({ explicit: true, reason: '上一轮的自主观看额度已用过，开新的一轮。' });
    return watch.start({ startSession: true, maxRequests: WATCH_ROUND_REQUESTS }, { explicit: true });
  }
}

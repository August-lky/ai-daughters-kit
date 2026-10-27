// 小鲸鱼的"反射层"——音游的手眼同步（2026-10-22 主人要求）
//
// 主人：「她每一次操作都需要截图，然而节奏游戏屏幕内容瞬息万变……有没有工具可以让女儿的眼睛和手同步？」
// 截图 → 模型想 → 再按键，一圈要好几秒；音符的判定窗口只有几十毫秒（这个游戏 Perfect ±70ms），
// 所以"看到就按"不能经过模型，得在页面里跑一个本地小循环：每帧读判定线和音符的位置，到线就按键。
// 她（模型）当大脑：决定玩不玩、玩哪首、调准度，打完看成绩；快动作交给这里。
//
// 由 @playwright/mcp 的 --init-script 预装进她浏览器的每个页面（含 iframe）。只在
// 「节奏术力口」(bilibilitoy.com/toy/rhythm-vocaloid) 的下落模式页里干活，别的页面什么都不做。
// 游戏是嵌在 bilibili.com 里的跨域 iframe，外层页面碰不到里面：所以外层只放一个开关
// window.__whaleReflex.start()/stop()/status()，用 postMessage 传给游戏那一层。
//
// 不碰排行榜：一开就打开游戏自带的「预览模式」标记（window.__RV_PREVIEW_BUILD__），游戏在每次提交成绩
// /云存档前都会检查它，预览时一律不写（见游戏 js/toy-sdk.js 的 isToyPreview）。代价是这一局的解锁和存档也不记。
(() => {
  'use strict';
  if (window.__whaleReflexInstalled) return;
  window.__whaleReflexInstalled = true;

  const MSG = '__whaleReflex';
  const ARM_KEY = '__whaleReflexArmed';
  // 2026-10-24：引擎和收消息的监听装进这个游戏的所有页面（game.html、演出、跑酷……），不再只认地址里带 falling-mode 的页；
  // 收到 start/status 时再看这一层像不像下落模式（looksFalling），不像就只回一句「我在哪」，外层不拿它当正式回话。
  // 注：iframe 元素的 src 属性一直是最初的 game.html，框架里面跳到别的页它也不变；要看真实地址得看 location。
  const IS_GAME = /bilibilitoy\.com$/.test(location.hostname) && /\/rhythm-vocaloid\//.test(location.pathname);
  const looksFalling = () => /falling-mode/.test(location.pathname) || !!document.querySelector('.lane-field .lane') || !!window.__rvFallingVisual;
  // 只在下落页开预览不够：游戏主页会拿本机最高分重算「术力总榜」再补交（rank-submit-outbox 的 home-total-repair），
  // 反射打出来的本机成绩会从那条路漏上榜。她这个浏览器里，这个游戏的所有页面都一直开着预览。
  if (IS_GAME) window.__RV_PREVIEW_BUILD__ = true;

  // ── 游戏那一层：真正看和按 ──────────────────────────────────────────────────
  function createEngine() {
    const KEYS_2K = [{ code: 'KeyF', key: 'f' }, { code: 'KeyJ', key: 'j' }];
    const KEYS_4K = [{ code: 'KeyD', key: 'd' }, { code: 'KeyF', key: 'f' }, { code: 'KeyJ', key: 'j' }, { code: 'KeyK', key: 'k' }];
    let running = false;
    let raf = 0;
    let opts = {};
    let stats = {};
    const seen = new Map();      // noteId -> { y, t } 上一帧位置，用来估下落速度
    const handled = new Set();   // 已经安排过按键的音符
    const holds = new Map();     // noteId -> { el, key } 正在按住的长条
    let rollTimer = 0;
    let rollFlip = 0;

    // ── 手感是练出来的（2026-10-24 主人：「希望她可以像真人一样自己成长自己慢慢玩」）──────────────
    // 以前准度由她传参决定，默认就几乎满分。现在准度只看练了多少：总共打过几局（整体手感）+ 这首歌这个难度打过几遍（熟悉度）。
    // 记在这个游戏自己的 localStorage 里（她的浏览器是固定 profile，关了再开也在）。刚开始手会抖、会漏、漏了会慌，
    // 越练越稳，但永远不是机器。她能调的只有 offsetMs（整体早一点晚一点，就像真人调延迟），准度本身调不了。
    const PRACTICE_KEY = '__whalePractice';
    const DIFF_LOAD = { ez: 0, nm: 0.15, hd: 0.3, ex: 0.45 };
    // 以前打的也算练过（2026-10-25 主人）：练习是 10-24 下午才开始记的，之前她真打过的那些局——处刑鼓掌、天行健 S，
    // 求与影、随之任之 100%，World is Mine 99.78%，加上最早漏三成的那几次——一局都没算，第二天一开局就成了新手（随之任之 64.85%）。
    // 这里当作「记本子之前就练过」加在记下来的局数上，不改本子本身。songs 按歌名（URL 的 song）算，不分难度。
    const PRIOR = { total: 12, songs: { manimani: 1 } };
    let shaken = 0;       // 刚漏了一个，接下来几下会慌
    let counted = true;   // 这一局的成绩记过了没
    const practiceKey = () => {
      const q = new URLSearchParams(location.search);
      return `${q.get('song') || '?'}|${q.get('difficulty') || '?'}|${q.get('keyCount') || document.querySelectorAll('.lane-field .lane').length || '?'}k`;
    };
    const loadPractice = () => { try { return JSON.parse(localStorage.getItem(PRACTICE_KEY) || '{}') || {}; } catch { return {}; } };
    const savePractice = (p) => { try { localStorage.setItem(PRACTICE_KEY, JSON.stringify(p)); } catch { /* 存不了就这局不记 */ } };
    function feel() {
      const p = loadPractice();
      const key = practiceKey();
      const total = (Number(p.total) || 0) + PRIOR.total;
      const song = { ...((p.songs || {})[key] || {}) };
      song.plays = (Number(song.plays) || 0) + (PRIOR.songs[key.split('|')[0]] || 0);
      const experience = 1 - Math.exp(-total / 30);      // 整体：几十局后上手
      const familiar = 1 - Math.exp(-(song.plays || 0) / 8); // 这首歌：七八遍后熟
      const skill = 0.55 * experience + 0.45 * familiar;
      const q = new URLSearchParams(location.search);
      const lanes = Number(q.get('keyCount')) || document.querySelectorAll('.lane-field .lane').length || 2;
      const load = 1 + (DIFF_LOAD[q.get('difficulty')] ?? 0.15) + (lanes >= 4 ? 0.25 : 0);
      return {
        song: key, skill: Math.round(skill * 100) / 100, totalPlays: total, songPlays: song.plays || 0,
        best: song.best ?? null, last: song.last ?? null,
        jitterMs: Math.round((65 - 45 * skill) * load),
        missRate: Math.round(Math.min(0.35, (0.15 - 0.125 * skill) * load) * 1000) / 1000,
        rollIntervalMs: Math.round(55 + 45 * (1 - skill)),
      };
    }
    /** 结算界面出来、这一局真打过，就记一笔：总局数、这首几遍、最好和最近一次的准确率。 */
    function maybeRecord() {
      if (counted || stats.presses + stats.skipped < 20) return;
      const result = readResult();
      if (!result) return;
      counted = true;
      const acc = Number(String(result.accuracy || result.text || '').match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
      const p = loadPractice();
      const key = practiceKey();
      p.total = (Number(p.total) || 0) + 1;
      p.songs = p.songs || {};
      const s = p.songs[key] || { plays: 0 };
      s.plays = (s.plays || 0) + 1;
      if (Number.isFinite(acc)) { s.last = acc; s.best = Math.max(Number(s.best) || 0, acc); }
      s.lastAt = new Date().toISOString();
      p.songs[key] = s;
      savePractice(p);
    }

    const send = (type, k) => window.dispatchEvent(new KeyboardEvent(type, { code: k.code, key: k.key, bubbles: true, cancelable: true }));
    const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const centerY = (r) => (r.top + r.bottom) / 2;

    function keysFor(count) { return count >= 4 ? KEYS_4K : KEYS_2K; }

    /**
     * 排一次按键。hold：null = 单点；{ untilMs } = 按住到这么多毫秒后松手（时间轴模式，知道长条多长）；
     * { el, receptor } = 看接收器的「按住中」标记松手（看画面模式，3D 画法下看不到长条尾巴）。
     */
    function press(id, key, ms, hold) {
      handled.add(id);
      // 漏了一个会慌：接下来几下更容易手抖、也更容易再漏（越熟练慌得越轻）
      const rattled = shaken > 0 ? 1.6 : 1;
      if (shaken > 0) shaken -= 1;
      if (Math.random() < opts.missRate * rattled) { stats.skipped += 1; shaken = 1 + Math.floor(Math.random() * 3); return; }
      const delay = Math.max(0, ms + gauss() * opts.jitterMs * rattled + opts.offsetMs);
      setTimeout(() => {
        if (!running) return;
        send('keydown', key);
        stats.presses += 1;
        if (!hold) { setTimeout(() => send('keyup', key), 45); return; }
        const at = performance.now();
        holds.set(id, { ...hold, key, at, until: hold.untilMs != null ? at + hold.untilMs : null });
      }, delay);
    }

    function releaseFinishedHolds() {
      const now = performance.now();
      for (const [id, h] of holds) {
        let done = now - h.at > 15000;
        if (h.until != null) done = done || now >= h.until;
        else {
          const charging = h.receptor && h.receptor.classList.contains('is-charging');
          const gone = !h.el.isConnected || h.el.classList.contains('is-missed');
          done = done || gone || (now - h.at > 150 && !charging); // 刚按下时游戏还没来得及挂标记，先等一下
        }
        if (done) { send('keyup', h.key); holds.delete(id); stats.holds += 1; }
      }
    }

    function setRoll(active, keys) {
      if (active && !rollTimer) {
        rollTimer = setInterval(() => {
          const k = keys[(rollFlip += 1) % keys.length];
          send('keydown', k); setTimeout(() => send('keyup', k), 20);
          stats.rollHits += 1;
        }, opts.rollIntervalMs);
      } else if (!active && rollTimer) { clearInterval(rollTimer); rollTimer = 0; }
    }

    // ── 眼睛 A（优先）：旁听游戏的画面层 ─────────────────────────────────────────
    // 游戏每帧把「场上的音符 + 当前歌曲时间」交给 window.__rvFallingVisual.render 去画（3D 画法）。
    // 在那儿旁听，每个音符准确的到线时刻（note.time）直接可得；不用从像素位置反推速度——
    // 像素那条路在掉帧、省电 30fps 档、透视加速下都会估错，她第一次实战漏了三成就是这么来的。
    let feedAt = 0;
    let hookedVisual = null;
    // 提前量放宽到 0.4 秒：她边玩边截图/抓快照时浏览器会卡到每秒只画几帧，只要到线前 0.4 秒内旁听到一次，
    // 就能用计时器准点按下去（游戏收到按键时会现算歌曲时间来判定，不依赖画面有没有跟上）。
    const LOOKAHEAD_S = 0.4;
    let rafTs = 0; // 本帧 rAF 时间戳：游戏的 songTime 是按它算的，排按键时扣掉这一帧已经过去的时间

    function hookVisual() {
      const vis = window.__rvFallingVisual;
      if (!vis || vis === hookedVisual || typeof vis.render !== 'function') return;
      const original = vis.render;
      vis.render = function whaleReflexRender(activeNotes, songTime, ...rest) {
        try { if (running) onFeed(activeNotes, songTime); } catch { /* 旁听出错不能拖垮游戏 */ }
        return original.call(this, activeNotes, songTime, ...rest);
      };
      hookedVisual = vis;
    }

    function onFeed(notes, songTime) {
      if (!notes || !Number.isFinite(songTime)) return;
      feedAt = performance.now();
      const laneEls = [...document.querySelectorAll('.lane-field .lane')];
      const keys = keysFor(laneEls.length);
      const laneIndex = new Map(laneEls.map((lane, i) => [lane.dataset.lane, i]));
      const sinceFrame = rafTs ? Math.min(30, Math.max(0, feedAt - rafTs)) : 0;
      let rollOn = false;
      for (const note of notes) {
        if (note.state !== 'active') continue;
        if (note.isRoll) { if (songTime >= note.time - 0.03 && songTime <= note.endTime) rollOn = true; continue; }
        const id = String(note.id);
        if (handled.has(id)) continue;
        const dt = note.time - songTime;
        if (dt > LOOKAHEAD_S) continue;
        const i = laneIndex.get(String(note.lane));
        if (i === undefined) continue;
        // 长条按到尾巴过后一点再松（游戏在歌曲时间走过尾巴时自动收尾）
        stats.feedPresses += 1;
        press(id, keys[i], dt * 1000 - sinceFrame, note.isHold ? { untilMs: Math.max(0, (note.endTime - note.time) * 1000) + 60 } : null);
      }
      setRoll(rollOn, keys);
    }

    // ── 眼睛 B（兜底）：看画面上的位置 ─────────────────────────────────────────────
    /** 这个音符多少毫秒后到线（用上一帧位置估速度；还没估出来就按"已经到线附近"处理）。 */
    function msUntilLine(id, headY, judgeY, now) {
      const prev = seen.get(id);
      seen.set(id, { y: headY, t: now });
      if (!prev || now <= prev.t || headY <= prev.y) return headY >= judgeY - 6 ? 0 : null;
      const pxPerMs = (headY - prev.y) / (now - prev.t);
      const ms = (judgeY - headY) / pxPerMs;
      return ms <= 40 ? Math.max(0, ms) : null; // 只给马上就要到线的音符排按键，远的下一帧再算
    }

    function rollOnLine(judgeY) {
      return [...document.querySelectorAll('.note-roll')].some((el) => { const r = el.getBoundingClientRect(); return r.bottom >= judgeY - 4 && r.top < judgeY; });
    }

    // 诊断：漏掉的音符是"根本没按"还是"按了但没判上"，长条有没有断，帧间最大间隔
    const missCounted = new Set();
    let lastFrameAt = 0;
    function countMiss(id) {
      if (missCounted.has(id)) return;
      missCounted.add(id);
      if (handled.has(id)) stats.missPressed += 1; else stats.missUnpressed += 1;
    }

    function frame(ts) {
      if (!running) return;
      rafTs = ts || performance.now();
      raf = requestAnimationFrame(frame);
      hookVisual();
      const laneEls = [...document.querySelectorAll('.lane-field .lane')];
      if (laneEls.length === 0) return;
      const keys = keysFor(laneEls.length);
      const now = performance.now();
      if (lastFrameAt) stats.maxFrameGapMs = Math.max(stats.maxFrameGapMs, Math.round(now - lastFrameAt));
      lastFrameAt = now;
      const viaFeed = now - feedAt < 300;
      const judgeYs = laneEls.map((lane) => { const rc = lane.querySelector('.receptor'); return rc ? centerY(rc.getBoundingClientRect()) : NaN; });
      laneEls.forEach((lane, i) => {
        for (const el of lane.querySelectorAll('.note-tap, .note-hold:not(.note-roll)')) {
          const id = el.dataset.noteId;
          if (!id) continue;
          if (el.classList.contains('is-missed')) countMiss(id);
          if (el.classList.contains('is-broken') && !missCounted.has(`b${id}`)) { missCounted.add(`b${id}`); stats.holdBroken += 1; }
          if (viaFeed || !Number.isFinite(judgeYs[i]) || handled.has(id) || el.classList.contains('is-hit') || el.classList.contains('is-missed')) continue;
          const isHold = el.classList.contains('note-hold');
          // 长条的外框撑满整条轨道，位置要看它的"头"（.hold-head）
          const head = isHold ? el.querySelector('.hold-head') : el;
          if (!head) continue;
          const ms = msUntilLine(id, centerY(head.getBoundingClientRect()), judgeYs[i], now);
          if (ms !== null) press(id, keys[i], ms, isHold ? { el, receptor: lane.querySelector('.receptor') } : null);
        }
      });
      releaseFinishedHolds();
      if (!viaFeed) setRoll(Number.isFinite(judgeYs[0]) && rollOnLine(judgeYs[0]), keys);
      if (seen.size > 400) { for (const id of [...seen.keys()].slice(0, 200)) seen.delete(id); }
      if (handled.size > 2000) { for (const id of [...handled].slice(0, 1000)) handled.delete(id); }
      if (missCounted.size > 2000) missCounted.clear();
      if (!counted && (frameTick = (frameTick + 1) % 60) === 0) maybeRecord(); // 约每秒看一眼结算出来没，出来了记一笔
    }
    let frameTick = 0;

    /** 结算界面出来了就读成绩（游戏自己的判定），没出来返回 null。 */
    function readResult() {
      const box = document.getElementById('resultOverlay');
      if (!box || box.hidden || getComputedStyle(box).display === 'none' || getComputedStyle(box).visibility === 'hidden') return null;
      const v = (id) => (document.getElementById(id)?.textContent || '').trim();
      const fields = { grade: v('resultGrade'), score: v('resultScore'), accuracy: v('resultAccuracy'), perfect: v('resultPerfect'), great: v('resultGreat'), good: v('resultGood'), miss: v('resultMiss'), maxCombo: v('resultCombo') };
      if (Object.values(fields).some(Boolean)) return fields;
      // 新版结算界面（exp-rs-root）会重画，原来那几个格子是空的：直接读整块文字
      return { text: box.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) };
    }

    return {
      start(o = {}) {
        // 准度（早晚误差、漏按、连打速度）只看练习量，见上面 feel()；她传的 jitterMs / missRate / rollIntervalMs 不再生效
        const f = feel();
        opts = {
          jitterMs: f.jitterMs,                                                  // 早晚误差（标准差，毫秒）
          missRate: f.missRate,                                                  // 漏按的概率
          offsetMs: Math.min(100, Math.max(-100, Number(o.offsetMs ?? 0))),   // 整体提前(-)/推迟(+)：她自己调
          rollIntervalMs: f.rollIntervalMs,
        };
        shaken = 0;
        counted = false;
        window.__RV_PREVIEW_BUILD__ = true; // 游戏自带的预览模式：不交排行榜成绩、不写云存档
        // 点「开始」后游戏这一层会重新加载一次：记在本标签页里，重载后自动接着开（stop 才清掉）
        try { sessionStorage.setItem(ARM_KEY, JSON.stringify(opts)); } catch { /* 存不了就只管这一页 */ }
        stats = { startedAt: Date.now(), presses: 0, holds: 0, rollHits: 0, skipped: 0, missPressed: 0, missUnpressed: 0, holdBroken: 0, maxFrameGapMs: 0, feedPresses: 0 };
        seen.clear(); handled.clear(); holds.clear(); missCounted.clear(); lastFrameAt = 0;
        if (!running) { running = true; raf = requestAnimationFrame(frame); }
        return this.status();
      },
      stop() {
        try { sessionStorage.removeItem(ARM_KEY); } catch { /* ignore */ }
        running = false;
        cancelAnimationFrame(raf);
        if (rollTimer) { clearInterval(rollTimer); rollTimer = 0; }
        for (const [, h] of holds) send('keyup', h.key);
        holds.clear();
        return this.status();
      },
      async waitResult(ms = 20000) {
        const until = Date.now() + Math.min(25000, Math.max(1000, Number(ms) || 20000));
        while (!readResult() && running && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
        return this.status();
      },
      status() {
        maybeRecord();
        const f = feel();
        const practice = { song: f.song, totalPlays: f.totalPlays, songPlays: f.songPlays, best: f.best, last: f.last, skill: f.skill,
          note: '手感是练出来的：打得越多越稳，这首歌越熟越准。准度调不了，只能调 offsetMs（整体早一点或晚一点）。' };
        return { running, page: 'falling-mode', lanes: document.querySelectorAll('.lane-field .lane').length, opts, stats, practice, result: readResult(), scoreUpload: window.__RV_PREVIEW_BUILD__ === true ? '已关（预览模式）' : '开' };
      },
    };
  }

  // ── 收发：游戏层回应命令，外层收集回报 ─────────────────────────────────────
  if (IS_GAME) {
    const engine = createEngine();
    window.__whaleReflex = engine; // 直接打开游戏页（不在 B 站外壳里）时也能用
    let armed = null;
    try { armed = JSON.parse(sessionStorage.getItem(ARM_KEY) || 'null'); } catch { armed = null; }
    if (armed) {
      // 2026-10-24：上次开着就接着开——下落页照旧一加载就接上；别的页每 0.5 秒看一次像不像下落模式，最多等 20 秒，不像就不动
      let tries = 0;
      const resume = () => {
        if (looksFalling()) engine.start(armed);
        else if ((tries += 1) < 40) setTimeout(resume, 500);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume, { once: true });
      else resume();
    }
    const answered = new Map(); // 命令 id -> 回过的结果
    window.addEventListener('message', (e) => {
      const m = e.data && e.data[MSG];
      if (!m || typeof m.cmd !== 'string' || !['start', 'stop', 'status'].includes(m.cmd)) return;
      // 2026-10-24：不像下落模式就不开、不报状态，只回一句「我在哪」；外层优先收下落页的回话，没有才把这些拼进报错
      // （她那次是准备页默认选中的「演出模式」，点「开始演奏」就跳去了 performance-xxx 页）。stop 谁收到都停，无害。
      // 外层会每 0.5 秒重发同一条（id 不变）：同一条只执行一次，重发时把上次的结果再回一遍；
      // 「我在哪」不记，下次重发时这一层可能已经像下落模式了
      let result = answered.get(m.id);
      if (!result && m.cmd !== 'stop' && !looksFalling()) {
        const where = (location.pathname + location.search).slice(0, 160);
        result = { running: false, notFalling: true, where, error: `我在 ${where}，不是下落模式` };
      } else if (!result) {
        result = m.cmd === 'start' ? engine.start(m.opts) : engine[m.cmd]();
        answered.set(m.id, result);
        if (answered.size > 50) answered.delete(answered.keys().next().value);
      }
      try { (e.source || window.top).postMessage({ [MSG + 'Reply']: { id: m.id, result } }, '*'); } catch { /* 外层走了就算了 */ }
    });
    return;
  }

  if (window !== window.top) return; // 其它 iframe 不需要开关
  const pending = new Map();
  window.addEventListener('message', (e) => {
    const r = e.data && e.data[MSG + 'Reply'];
    if (r && pending.has(r.id)) pending.get(r.id)(r.result); // 收不收、什么时候删由 call 里的回调定
  });
  const allFrames = (w, out = []) => { for (let i = 0; i < w.frames.length; i += 1) { out.push(w.frames[i]); try { allFrames(w.frames[i], out); } catch { /* 跨域子框架数不了，就到这层 */ } } return out; };
  const call = (cmd, o) => new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const notes = []; // 2026-10-24：不像下落模式的框架报回来的「我在哪」，先攒着，下落页的回话一到就用它的
    pending.set(id, (r) => {
      if (r && r.notFalling) { if (r.where && !notes.includes(r.where)) notes.push(r.where); return; }
      pending.delete(id);
      resolve(r);
    });
    const broadcast = () => { for (const f of allFrames(window)) { try { f.postMessage({ [MSG]: { id, cmd, opts: o } }, '*'); } catch { /* ignore */ } } };
    broadcast();
    // 2026-10-24：等 1.5 秒放宽到 3 秒，其间每 0.5 秒重发一次——点「开始演奏」后游戏那一层可能正在重新加载，
    // 发给旧页面的那条会丢，光等久一点没用；游戏层按 id 去重，不会重复执行
    const resend = setInterval(() => { if (pending.has(id)) broadcast(); else clearInterval(resend); }, 500);
    setTimeout(() => {
      clearInterval(resend);
      if (!pending.has(id)) return;
      pending.delete(id);
      const seen = notes.length ? `。游戏那层说：我在 ${notes.join('；我在 ')}` : '';
      resolve({ running: false, error: `这个页面里没找到节奏术力口的下落模式（先进到选好歌、能开始打的那一页；演出/跑酷/太鼓模式用不了，要在准备页先点「下落模式」那个标签再点开始演奏）${seen}`, notFalling: notes });
    }, 3000);
  });
  // 等到结算出来（或到时间）再回状态：她不用自己拿 setTimeout 包 status()——包进对象里的 Promise 会被序列化成 {}
  const waitResult = async (ms = 20000) => {
    const until = Date.now() + Math.min(25000, Math.max(1000, Number(ms) || 20000));
    let st = await call('status');
    while (!st.result && st.running !== false && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await call('status');
    }
    return st;
  };
  window.__whaleReflex = {
    start: (o) => call('start', o),
    stop: () => call('stop'),
    status: () => call('status'),
    waitResult,
  };
})();

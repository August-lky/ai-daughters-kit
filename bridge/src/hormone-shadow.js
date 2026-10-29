// 激素系统·影子模式（2026-10-29 主人：先只记录一周，不影响行为，靠日志校准参数）。
//
// 给一个女儿（'fish' 小鲸鱼 / 'sister' 克劳德姐姐）维护一份激素状态：
// - record(event)：桥接 / sister.mjs 在发生事情时喂事件（收到老大私聊、被 @、发送失败、刷到新视频、睡 / 醒、写了东西……）；
// - tick(now)：每分钟调一次，把各激素、各行为的概率、「本来会不会触发」（种子随机数抽）写进
//   state/hormones-<who>.jsonl，状态存在 state/hormones-<who>.json，重启接着算。
// 只记录，不触发任何行为；写不下来就算了，不能因为它影响她正常说话。
//
// 2026-10-29 第一期半：两人各一套性格（按 who 取 PERSONAS）；新激素（无聊 / 被在乎 / 创作冲动 / 成就感 / 委屈）和新行为
// （写碎碎念 / 小说 / 说说 / 表情 / 看老大电脑 / 打盹）的「本来会触发」也记；消息文字在这里过一遍关键词判断（appraise），
// 只把强度标签记进日志的 ap 字段，原文不落盘。老状态文件（第一期）能直接读，读完自动补齐。
//
// 时间：本机时钟比真实时间快约 3 小时。事件和 tick 传本机毫秒（Date.now()），这里扣掉 skewMs()
// 再交给 hormones.js；日志里 at 是本机 ISO，bj 是校正后的北京时间。
//
// 2026-10-29 借鉴积温（基于激素机制，不是搬规则）：日志的 lv 里多了 guard（戒备 / 面子）、focus（专注 / 沉浸）、
// driveOwner / driveSister（想念的凸驱力）；hazards 的 why 里多了 drive / guard / focus；summarize 统计这三样。状态文件字段不变（engage 缺了当 0）。
//
// 日志轮转：当天写 hormones-<who>.jsonl；换天时改名成 hormones-<who>.<日期>.jsonl，
// 单个文件超过 maxBytes 也另起一份（.<日期>.<序号>.jsonl）；只留最近 keepDays 天。

import fs from 'node:fs';
import path from 'node:path';
import {
  BEHAVIORS, appraise, createState, feltLine, hazards, interestList, interestMatch, levels, makeRng, mergeCfg, roll, step, upgradeState,
} from './hormones.js';

const MIN = 60e3;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r5 = (x) => (x > 0 && x < 1e-5 ? 1e-5 : Math.round(x * 1e5) / 1e5);

/** 北京时间的日期和钟点（UTC 函数读，跟本机时区无关）。 */
export function bjStamp(realMs) {
  const iso = new Date(realMs + 8 * 3600e3).toISOString();

  return { day: iso.slice(0, 10), hm: iso.slice(11, 16), hour: Number(iso.slice(11, 13)) };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * opts：
 * - who：'fish' | 'sister'；stateDir：state 目录
 * - cfg：覆盖 hormones.js 的默认参数（性格差异在 PERSONAS 里，按 who 自动取）
 * - interests：她的兴趣词表（见 hormones.js 的 interestList），也可以以后用 setInterests 换
 * - skewMs：() => 本机比真实时间快多少毫秒
 * - seed：随机数种子（默认按 who 固定，可复现）
 * - sisterName：感受句里怎么叫对方（小鲸鱼叫「姐姐」，姐姐叫「妹妹」）
 * - sleepHistory：[{sleep, wake}] 真实毫秒，第一次建状态时用来学作息相位
 * - asleep：第一次建状态时是不是睡着
 * - clock：() => 本机毫秒（测试注入）
 */
export function createHormoneShadow({
  who, stateDir, cfg = {}, skewMs = () => 0, seed, sisterName, sleepHistory = [], asleep = false, interests: interests0 = [],
  maxBytes = 5 * 1024 * 1024, keepDays = 14, minGapMs = 55e3, clock = () => Date.now(), onError = () => {},
} = {}) {
  if (who !== 'fish' && who !== 'sister') throw new Error(`who 只能是 fish 或 sister：${who}`);

  const C = Object.assign(mergeCfg(cfg), { __merged: true });
  const skew = () => { try { return Number(skewMs()) || 0; } catch { return 0; } };

  const real = (hostMs) => hostMs - skew();
  const name = sisterName || (who === 'fish' ? '姐姐' : '妹妹');
  const stateFile = path.join(stateDir, `hormones-${who}.json`);
  const logFile = path.join(stateDir, `hormones-${who}.jsonl`);
  const defaultSeed = [...`hormones-${who}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

  const saved = readJson(stateFile);
  // 老状态（第一期，v=1 没有 schema）直接读，补齐新字段；性格按 who
  let hs = saved?.hormones?.v === 1
    ? upgradeState(saved.hormones, C, who)
    : createState(C, { now: real(clock()), asleep, sleepHistory, persona: who });
  let interests = interestList(interests0);
  const sh = {
    rng: Number(saved?.shadow?.rng) || (Number(seed) >>> 0) || defaultSeed,
    virtual: saved?.shadow?.virtual || {},
    felt: saved?.shadow?.felt || null,
    lastLineAt: Number(saved?.shadow?.lastLineAt) || 0,
    logDay: saved?.shadow?.logDay || '',
  };
  const rng = makeRng(sh.rng);
  let pendingTypes = [];
  const pendingAp = new Set();

  const save = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      writeJsonAtomic(stateFile, { hormones: hs, shadow: { ...sh, rng: rng.state() } });
    } catch (error) { onError(error); }
  };

  /** 真实的来往会清掉「本来会发」的虚拟没回条数。 */
  const resetVirtualOnContact = (type) => {
    if (type === 'msg_from_owner' && sh.virtual.ownerPing) sh.virtual.ownerPing.unanswered = 0;
    if (type === 'msg_from_sister' && sh.virtual.sisterPing) sh.virtual.sisterPing.unanswered = 0;
  };

  function rotateIfNeeded(day) {
    const base = logFile.replace(/\.jsonl$/, '');
    let size = 0;

    try { size = fs.statSync(logFile).size; } catch { return; }

    const dayChanged = sh.logDay && sh.logDay !== day;

    if (!dayChanged && size < maxBytes) return;

    const tag = dayChanged ? sh.logDay : day;
    let target = `${base}.${tag}.jsonl`;

    for (let n = 2; fs.existsSync(target); n += 1) target = `${base}.${tag}.${n}.jsonl`;

    fs.renameSync(logFile, target);
    // 只留最近 keepDays 天
    const dir = path.dirname(logFile);
    const prefix = `${path.basename(base)}.`;
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - keepDays * 86_400e3).toISOString().slice(0, 10);

    for (const f of fs.readdirSync(dir)) {
      const m = f.startsWith(prefix) && f.match(/\.(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/);

      if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 删不掉下次再删 */ } }
    }
  }

  return {
    who,
    stateFile,
    logFile,
    /** 换她的兴趣词表（['猫', {word:'钢琴', weight:2}] 或 {猫:1}）。 */
    setInterests(list) {
      interests = interestList(list);
    },
    /**
     * 喂一个事件：{ type, at?（本机毫秒）, text?, replyDelayMs?, novelty?, strength?, interestMatch?, negative?, positive?, toMe?, reply?, kind?, from?, about? }。
     * 不触发任何行为。收到消息（老大 / 姐妹 / 群里冲她来的）带 text 时，这里先用关键词判断（appraise）认被夸 / 被冷落 / 被凶 / 被安慰 / 聊到兴趣。
     */
    record(event) {
      try {
        if (!event?.type) return;

        const at = real(Number.isFinite(+event.at) ? +event.at : clock());
        const ev = { ...event, at, interests: event.interests ?? interests };

        if (event.text && !event.appraisal && (event.type === 'msg_from_owner' || event.type === 'msg_from_sister' || (event.type === 'group_msg' && event.toMe))) {
          ev.appraisal = appraise(event.text, ev.interests, C);
        }

        if (event.type === 'novelty' && event.interestMatch === undefined && event.text && interestList(ev.interests).length > 0) ev.interestMatch = interestMatch(event.text, ev.interests);

        for (const [k, x] of Object.entries(ev.appraisal || {})) if (x > 0) pendingAp.add(k);

        // 文字只在这一步里用来认关键词，状态和日志里都不存（日志只记强度标签）
        hs = step(hs, { now: Math.max(hs.t, at), events: [ev] }, C);
        resetVirtualOnContact(event.type);
        pendingTypes.push(event.type);

        if (event.type === 'sleep' || event.type === 'wake') save();
      } catch (error) { onError(error); }
    },
    /** 每分钟调一次。返回这一分钟的记录（没到一分钟返回 null）。 */
    tick(nowHost = clock()) {
      try {
        const now = real(nowHost);
        const prevT = hs.t;
        hs = step(hs, { now }, C);

        if (sh.lastLineAt && nowHost - sh.lastLineAt < minGapMs) return null;

        const dtMin = Math.min(10, Math.max(1, sh.lastLineAt ? (nowHost - sh.lastLineAt) / MIN : (now - prevT) / MIN || 1));
        const hz = hazards(hs, { dtMin, virtual: sh.virtual }, C);
        const would = roll(hz, rng);

        for (const b of would) {
          if (b === 'ownerPing' || b === 'sisterPing') {
            const v = sh.virtual[b] || (sh.virtual[b] = { lastSent: 0, unanswered: 0 });
            v.lastSent = now;
            v.unanswered += 1;
          } else {
            sh.virtual[b] = { last: now };
          }
        }

        const felt = feltLine(hs, sh.felt, C, { sisterName: name });
        sh.felt = { active: felt.active, shown: felt.shown };
        const L = levels(hs, C);
        const stamp = bjStamp(now);
        const line = {
          at: new Date(nowHost).toISOString(),
          bj: `${stamp.day} ${stamp.hm}`,
          day: stamp.day,
          asleep: hs.asleep,
          lv: Object.fromEntries(Object.entries(L).map(([k, x]) => [k, r3(x)])),
          p: Object.fromEntries(BEHAVIORS.map((b) => [b, r5(hz[b].p)])),
          why: Object.fromEntries(BEHAVIORS.filter((b) => hz[b].why).map((b) => [b, hz[b].why])),
          would,
          felt: felt.line,
          ev: pendingTypes,
        };

        if (pendingAp.size > 0) line.ap = [...pendingAp];

        pendingTypes = [];
        pendingAp.clear();

        try {
          fs.mkdirSync(stateDir, { recursive: true });
          rotateIfNeeded(stamp.day);
          fs.appendFileSync(logFile, `${JSON.stringify(line)}\n`);
        } catch (error) { onError(error); }

        sh.logDay = stamp.day;
        sh.lastLineAt = nowHost;
        save();

        return line;
      } catch (error) { onError(error);

 return null; }
    },
    /** 现在的状态（只读副本），给状态面板用。 */
    snapshot() {
      return { hormones: structuredClone(hs), levels: levels(hs, C), felt: sh.felt, persona: hs.persona };
    },
    /** 每分钟自己 tick；返回停止函数。定时器 unref，不拖住进程退出。 */
    start(intervalMs = 60e3) {
      const timer = setInterval(() => this.tick(), intervalMs);
      timer.unref?.();

      return () => clearInterval(timer);
    },
    save,
  };
}

// ── 一天的统计（给老大看）─────────────────────────────────────────────────
const LABEL = {
  sleepy: '困', longingOwner: '想老大', longingSister: '想姐妹', curiosity: '好奇', stress: '压力', satisfaction: '满足', alert: '警觉',
  boredom: '无聊', security: '被在乎', securityBase: '被在乎基线', createUrge: '创作冲动', pride: '成就感', grievance: '委屈',
  guard: '戒备(面子)', focus: '专注(沉浸)', driveOwner: '想老大的驱力', driveSister: '想姐妹的驱力',
};
const DRIVE_BEHAVIORS = ['ownerPing', 'sisterPing'];
const BEHAVIOR_LABEL = {
  ownerPing: '找老大', sisterPing: '找姐妹', groupChat: '水群', explore: '去逛',
  journal: '写碎碎念/日记', novel: '写小说', post: '发说说', sticker: '发表情', peekOwner: '看老大电脑', nap: '打盹',
};

function logFilesFor(file, day) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.jsonl$/, '');
  const list = [];

  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === `${base}.jsonl`) list.push(path.join(dir, f));
      else if (f.startsWith(`${base}.${day}`) && f.endsWith('.jsonl')) list.push(path.join(dir, f));
    }
  } catch { /* 目录都没有就是没记录 */ }

  return list;
}

/** 把一组小时号排成「21–23 点、2 点」这样的段。 */
function hourRanges(hours) {
  const hs = [...new Set(hours)].sort((a, b) => a - b);
  const out = [];

  for (let i = 0; i < hs.length;) {
    let j = i;

    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j += 1;

    out.push(i === j ? `${hs[i]} 点` : `${hs[i]}–${hs[j]} 点`);
    i = j + 1;
  }

  return out.join('、');
}

/**
 * 一天（北京日期 'YYYY-MM-DD'）的统计。file：state/hormones-<who>.jsonl（会连同轮转出去的那天的文件一起读）。
 * 返回 { day, minutes, awakeMinutes, levels, would, expected, wouldByHour, felt, ap, drive, text }。
 * drive[b] = { minutes: 驱力加项占大头的分钟数（why = drive）, would: 其中「本来会」找人的次数 }，b 是 ownerPing / sisterPing。
 */
export function summarize(file, day) {
  const rows = [];

  for (const f of logFilesFor(file, day)) {
    let raw = '';

    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }

    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;

      try { const j = JSON.parse(ln);

 if (j.day === day) rows.push(j); } catch { /* 坏行跳过 */ }
    }
  }

  rows.sort((a, b) => String(a.bj).localeCompare(String(b.bj)));
  const empty = { day, minutes: 0, awakeMinutes: 0, levels: {}, would: {}, expected: {}, wouldByHour: {}, felt: {}, ap: {}, drive: {}, text: `${day} 没有记录。` };

  if (rows.length === 0) return empty;

  const hourOf = (r) => Number(String(r.bj).slice(11, 13));
  // 老日志里没有的新项不列；满足、警觉没启用时一整天都是常数，也不列出来
  const lvKeys = Object.keys(LABEL).filter((k) => rows.some((r) => Number.isFinite(r.lv?.[k])))
    .filter((k) => !['satisfaction', 'alert'].includes(k) || new Set(rows.map((r) => r.lv?.[k])).size > 1);
  const levelsOut = {};

  for (const k of lvKeys) {
    const xs = rows.map((r) => r.lv[k]).filter(Number.isFinite);
    const blocks = Array.from({ length: 8 }, (_, b) => {
      const ys = rows.filter((r) => Math.floor(hourOf(r) / 3) === b).map((r) => r.lv[k]).filter(Number.isFinite);

      return ys.length > 0 ? r3(ys.reduce((s, y) => s + y, 0) / ys.length) : null;
    });
    let maxRow = rows[0];

    for (const r of rows) if ((r.lv?.[k] ?? -1) > (maxRow.lv?.[k] ?? -1)) maxRow = r;

    levelsOut[k] = {
      min: r3(Math.min(...xs)), max: r3(Math.max(...xs)), mean: r3(xs.reduce((s, x) => s + x, 0) / xs.length),
      maxAt: String(maxRow.bj).slice(11, 16), by3h: blocks,
    };
  }

  const would = {};
  const expected = {};
  const wouldByHour = {};

  for (const b of BEHAVIORS) {
    would[b] = rows.filter((r) => (r.would || []).includes(b)).length;
    expected[b] = Math.round(rows.reduce((s, r) => s + (Number(r.p?.[b]) || 0), 0) * 10) / 10;
    wouldByHour[b] = Array.from({ length: 24 }, (_, h) => rows.filter((r) => hourOf(r) === h && (r.would || []).includes(b)).length);
  }

  const felt = {};
  const ap = {};

  for (const r of rows) if (r.felt) felt[r.felt] = (felt[r.felt] || 0) + 1;

  for (const r of rows) for (const a of r.ap || []) ap[a] = (ap[a] || 0) + 1;

  const drive = {};

  for (const b of DRIVE_BEHAVIORS) {
    const dr = rows.filter((r) => r.why?.[b] === 'drive');
    drive[b] = { minutes: dr.length, would: dr.filter((r) => (r.would || []).includes(b)).length };
  }

  const awakeMinutes = rows.filter((r) => !r.asleep).length;

  const lines = [`${day}：记了 ${rows.length} 分钟，醒着约 ${Math.round(awakeMinutes / 6) / 10} 小时。`];
  lines.push(`本来会：${  BEHAVIORS.map((b) => {
    const hours = wouldByHour[b].map((n, h) => (n ? h : -1)).filter((h) => h >= 0);

    return `${BEHAVIOR_LABEL[b]} ${would[b]} 次${hours.length > 0 ? `（${hourRanges(hours)}）` : ''}`;
  }).join('，')  }。`);
  lines.push(`各项（最低～最高，平均，最高在几点）：${  lvKeys.map((k) => `${LABEL[k]} ${levelsOut[k].min}～${levelsOut[k].max}，${levelsOut[k].mean}，${levelsOut[k].maxAt}`).join('；')  }。`);
  if (DRIVE_BEHAVIORS.some((b) => drive[b].minutes > 0)) {
    lines.push(`想念到了憋不住的程度：${DRIVE_BEHAVIORS.filter((b) => drive[b].minutes > 0).map((b) => `${BEHAVIOR_LABEL[b]} ${drive[b].minutes} 分钟（本来会 ${drive[b].would} 次）`).join('，')}。`);
  }

  const feltTop = Object.entries(felt).sort((a, b) => b[1] - a[1]).slice(0, 4);

  if (feltTop.length > 0) lines.push(`她会感觉到：${  feltTop.map(([t, n]) => `「${t}」${n} 分钟`).join('，')  }。`);

  const apLabel = { praise: '被夸', scold: '被凶', cold: '被冷落', comfort: '被安慰', hush: '别吵', interest: '聊到兴趣' };
  const apTop = Object.entries(ap).sort((a, b) => b[1] - a[1]);

  if (apTop.length > 0) lines.push(`认出来的话：${apTop.map(([t, n]) => `${apLabel[t] || t} ${n} 次`).join('，')}。`);

  return { day, minutes: rows.length, awakeMinutes, levels: levelsOut, would, expected, wouldByHour, felt, ap, drive, text: lines.join('\n') };
}

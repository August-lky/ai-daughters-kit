// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage } from './qq-model-view.js';
import { cardPreviewUrl, cardToText } from './card-parse.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, resolveFfmpeg, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { mirrorText, fishLinesFromToolCalls } from './mirror.js';
import {
  NEXT_WAKE_MIN_MINUTES, SLEEP_MAX_HOURS, countTrailingSelf, createSelfNote, createStickyNote, goToListText, handoffRecentLines,
  normalizeNextWakeMinutes, ownerIdleFactsText, ownerIdleVerdict, planGoTo, proactiveDelayMs, recentSaidBlock, resolveSleepUntil, sleepDurationText,
  wantsNaturalSleep, naturalSleepWindow
} from './freedom.js';
// 2026-10-29 老大：「困」提前从影子里放出来（唤醒里带一句身体感受），睡觉可以睡到自然醒（激素的睡眠压力回落才醒）
import { sleepyFeel, naturalWakeDue } from './hormones.js';
import { createTokenLedger } from './token-ledger.js';
import { createExplorer, readGrowth, appendGrowth } from './whale-explore.mjs';
import { createWeather } from './weather.mjs';
import { createEpisodeStore, defaultLabel } from './episodes.js';
// 2026-10-29 大脑方案下半：心情的算法收进 mood.js（两人共用）；按话题想起 / 记错了 / 睡前整理建议走 brain-client.js（检索服务）
import { buildMoodLine, moodHandoffText, moodWithSwing, readMoodFile, readMoodWithPush, moodPushFile } from './mood.js';
import { BRAIN_SERVICE, brainDemote, brainRecall, brainRememberMoment, brainTidy, correctionReminder, formatRecallBlock, isMemoryCorrection, recallQueryFromMessages } from './brain-client.js';
import { createMomMailbox } from './mom-mailbox.js';
import { migrateFishMemory } from './fish-move.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import { createAsleepLog } from './asleep-log.js';
import { createImpressions, apologizing } from './impressions.js';
import { createBrains } from './brains.js';
// 2026-10-29 老大：她们俩的网页（public/daughters.html）。实时区缓冲只在内存里（不落盘）；数据读取全是只读。
import { createLiveBuffer } from './live-buffer.js';
import { elsewhereBlock } from './elsewhere.js';
import { buildSelfView, readHormoneLevels } from './self-view.js';
import { createDaughtersData } from './daughters-data.js';
import { createDaughtersConsole, isDaughtersPath, isDaughtersPage } from './daughters-console.js';
import { novelWakeLine } from './novel-tools.js'; // 2026-10-29 第五批：唤醒里提一句最近在写的合写书
// 2026-10-29 第五批：激素影子记录（只记录、不触发任何行为；老大同意先记一周校准）和聊天记录（给索引看的原话，跟姐姐一样）
import { createHormoneFeed, createMoodPusher, incomingHormoneEvents, sentHormoneEvent, createNoveltyTracker, toolHormoneEvents, moodHormoneEvent, weatherHormoneEvents, loadFishInterests, HORMONE_REFRESH } from './hormone-feed.js';
import { createChatLog, pickGroupName, sisterGroupNames, whoLabel } from './chatlog.js';
import { startDouyinPageWatchdog } from './douyin-page-watchdog.js';
import { hearQqRecord } from './ear.js';
// 2026-10-29 主人（大整理第二批）：看图（抽帧 / 缩图 / 下载）跟姐姐共用 image-view.js，原来这里的 shrinkImage / animateToSheet / shrinkStillImage 都并过去了
import { viewImage, createImageDownloader, DEFAULT_FFMPEG } from './image-view.js';
import { loadFishCatalog, findFish, searchFish, describeFish, fishLabel, getFishGif } from './fish-stickers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
// 2026-10-29 大脑方案：两个人的脑子在哪，统一从 brains.js 取（不再各处写死 memory/、Rambling/、state/episodes）。
// 用 createBrains(ROOT) 按这个进程的 ROOT 造——测试台把 ROOT 换成临时目录时，脑子的路径也跟着换，不会写到真的脑子里。
const { brainOf, bookDirsOf, bookExtraFiles, NOVEL_ROOT: BRIDGE_NOVEL_ROOT, DSH_DIR: BRIDGE_DSH_DIR } = createBrains(ROOT);
const BRIDGE_BRAINS = createBrains(ROOT); // 2026-10-29 老大：她们俩的页面的只读数据读取要整个 brains 对象（同一个 ROOT，路径一样）
const WHALE_BRAIN = brainOf('whale');
const SISTER_BRAIN = brainOf('sister');
const relFromRoot = (p) => path.relative(ROOT, p).split(path.sep).join('/'); // 写给她看的相对路径
// 便签在非主人私聊的会话里带的时候加的一句（2026-10-29 记忆统一：私聊里的事在这儿说不说她自己掂量）
const STICKY_NOT_PRIVATE_NOTE = '（便签里有些是跟老大私聊时记的，在这里说不说、怎么说，你自己掂量。）';
// 生活不停（2026-10-24 主人）：她睡着时别人找她、群里聊的，记一笔不叫醒；醒来在跟老大的私聊里告诉她。
const asleepLog = createAsleepLog(path.join(STATE_DIR, 'asleep-log.json'));
// 2026-10-29 第五批：激素影子记录（见 hormone-feed.js）。只记录、不触发任何行为，她看不到。
// main() 里建；建之前、config 的 hormones.enabled 关了、出任何错的时候，hormoneRecord 都是空操作。
let hormoneFeed = null;
function hormoneRecord(event) {
  try { hormoneFeed?.record(event); } catch { /* 记不下就算了，不能影响她说话 */ }
}
const bjClockOf = (ms) => new Date(ms - clockSkewMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });

// ── 时钟校正 ────────────────────────────────────────────────────────────────
// 这台机器的系统时钟比真实时间快约 3 小时，而当前账户没有管理员权限改系统时间。
// 所以在应用层量一次与网络时间的偏差，之后统一用校正后的时间去显示、去判断深夜。
let clockSkewMs = 0;

async function measureClockSkew() {
  const probes = ['https://www.baidu.com', 'https://www.qq.com'];
  for (const url of probes) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      const dateHeader = res.headers.get('date');
      if (!dateHeader) continue;
      const serverMs = Date.parse(dateHeader);
      if (!Number.isFinite(serverMs)) continue;
      clockSkewMs = Date.now() - serverMs;
      log(`时钟校正：本机比网络时间快 ${Math.round(clockSkewMs / 1000)} 秒，已按真实时间显示`);
      // 2026-10-21：落一份给抖音插件用（它要按真实北京时间判断夜里不自动续轮）。
      try { fs.writeFileSync(path.join(STATE_DIR, 'clock-skew.json'), JSON.stringify({ skewMs: clockSkewMs, measuredAt: new Date().toISOString() })); } catch { /* 写不下来插件就按本机时间算 */ }
      return;
    } catch (error) {
      log(`时钟校正探测失败（${url}）：${error?.message ?? error}`);
    }
  }
  log('时钟校正失败，将按本机时间显示');
}

/** 校正后的"现在"。 */
function realNow() {
  return new Date(Date.now() - clockSkewMs);
}
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
// 2026-10-24：黑话学习会话上一次用到的上下文超过这个数就换新会话（见 ensureSlangLearnerSession）。
const SLANG_SESSION_ROTATE_TOKENS = 60000;
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 她自己写的那一页（2026-10-23，主人要求「让她以当前提示词为基础自己慢慢迭代真正属于她自己的性格」）。
// 正文放在她脑子的 身份/ 里（和 soul.md 一处）；历史版本放 state 下 —— 脑子目录会被记忆索引 rglob，几十份旧版会变成重复的本子。
const SELF_NOTE_FILE = WHALE_BRAIN.self;
const SELF_NOTE_HISTORY_DIR = path.join(STATE_DIR, 'agents', 'self-history');
const selfNote = createSelfNote({ file: SELF_NOTE_FILE, historyDir: SELF_NOTE_HISTORY_DIR });
// 便签（2026-10-23 第二轮）：她的工作记忆 —— 正在聊什么、刚被告知什么、答应了还没做的。内容全是她自己的；
// 2026-10-29 老大：记忆统一，每人只有一个脑子——所有会话的唤醒都带（不再只在主人私聊里带），搬家时原样带走；
// 非主人私聊里带的时候会注明「有些是私聊里记的」，说不说她自己掂量。历史同样放 state 下。
const STICKY_NOTE_FILE = WHALE_BRAIN.sticky;
const STICKY_NOTE_HISTORY_DIR = path.join(STATE_DIR, 'agents', 'note-history');
const stickyNote = createStickyNote({ file: STICKY_NOTE_FILE, historyDir: STICKY_NOTE_HISTORY_DIR });
// QQ 空间说说的「每日额度」是账号级（不分会话），所以单独存一份，不塞进 social-v2。
const QZONE_STATE_FILE = path.join(STATE_DIR, 'qzone-state.json');
// count/day 是「发说说」计数（10-23 起不限条数，只记录）；commentCount/commentDay 是「发评论」额度（每天 20 条）。
let qzoneDaily = { day: '', count: 0, commentDay: '', commentCount: 0, wakeDays: {} };

function loadQzoneState() {
  try {
    const s = readJsonSafe(QZONE_STATE_FILE, null);
    if (s && typeof s === 'object') {
      qzoneDaily = {
        day: String(s.day || ''),
        count: Number(s.count) || 0,
        commentDay: String(s.commentDay || ''),
        commentCount: Number(s.commentCount) || 0,
        // 每日说说提醒今天各时间点叫过没有（{ s0: '2026-10-23' }），桥接重启/换会话后补叫时不重复
        wakeDays: s.wakeDays && typeof s.wakeDays === 'object' ? { ...s.wakeDays } : {}
      };
    }
  } catch {
    /* 读不到就从零开始 */
  }
}

function saveQzoneState() {
  try {
    atomicWriteJson(QZONE_STATE_FILE, qzoneDaily);
  } catch (error) {
    log('保存说说额度状态失败:', error?.message ?? error);
  }
}
// 改资料（昵称 / 头像）也做成账号级每日额度：这两项 QQ 侧风控最严，
// 频繁改容易直接失败或者被限。签名/性别/状态/群名片不设额度，交给 QQ 自己拦。
const PROFILE_STATE_FILE = path.join(STATE_DIR, 'profile-state.json');
let profileDaily = { day: '', nick: 0, avatar: 0 };

function loadProfileState() {
  try {
    const s = readJsonSafe(PROFILE_STATE_FILE, null);
    if (s && typeof s === 'object') {
      profileDaily = { day: String(s.day || ''), nick: Number(s.nick) || 0, avatar: Number(s.avatar) || 0 };
    }
  } catch {
    /* 读不到就从零开始 */
  }
}

function saveProfileState() {
  try {
    atomicWriteJson(PROFILE_STATE_FILE, profileDaily);
  } catch (error) {
    log('保存资料改动状态失败:', error?.message ?? error);
  }
}

// 账号级「睡觉」状态。
// 为什么需要：每个会话各自有潜水配置，主人让她睡之后，群里的消息照样会把她叫醒。
// 这里做成全局开关：睡着时只有主人的私聊还能唤起她（可能是叫她起床），
// 群消息、别人的私聊、主动机会全部静音（每日总结说说走主人私聊，照样会叫）。
const SLEEP_STATE_FILE = path.join(STATE_DIR, 'sleep-state.json');
let sleepState = { sleeping: false, since: 0, reason: '', until: 0 };

function loadSleepState() {
  try {
    const s = readJsonSafe(SLEEP_STATE_FILE, null);
    if (s && typeof s === 'object' && s.sleeping) {
      sleepState = {
        sleeping: true,
        since: Number(s.since) || 0,
        reason: String(s.reason || ''),
        until: Number(s.until) || 0,
        ...(s.natural ? { natural: true, minUntil: Number(s.minUntil) || 0 } : {})
      };
      // 过了 until 的不在这里偷偷清（原来只改内存不写文件，文件上一直"在睡"，她也没被叫起来）：
      // 交给 main 里每分钟一次的 maybeSleepEndV2 —— 正式 exitSleep（写文件）并用 wokeUp 叫醒主人私聊（2026-10-24）。
    }
  } catch {
    /* 读不到就是醒着 */
  }
}

// 睡前日记：哪个"夜晚"已经提醒过（见 /api/socialV2/sleep）。重启后不重复挡。
const BEDTIME_DIARY_FILE = path.join(STATE_DIR, 'bedtime-diary.json');
let bedtimeDiaryAskedFor = String(readJsonSafe(BEDTIME_DIARY_FILE, null)?.nightOf || '');

function saveSleepState() {
  try {
    atomicWriteJson(SLEEP_STATE_FILE, sleepState);
  } catch (error) {
    log('保存睡眠状态失败:', error?.message ?? error);
  }
}

// 2026-10-23 第二轮，主人：「让她自己定」作息 —— 什么时候睡、睡到几点都她定（until 或 hours）。
// 这里只剩一道防故障的保险：一次最长 SLEEP_MAX_HOURS（14）小时，免得填错一个数就一直静音。
// 原来"白天最多午睡 2 小时 / 夜里才算长睡"的判断拆掉了。
function enterSleep(reason, { hours, until, natural } = {}) {
  // 2026-10-29 老大：睡觉不定死。没写时间（或 until 写 natural / 自然醒）就是睡到自然醒：until 只是 14 小时的防故障上限，
  // 真正什么时候醒由激素的睡眠压力决定（maybeSleepEndV2 里看 naturalWakeDue）；写了钟点 / 小时数的照旧按她的。
  const isNatural = wantsNaturalSleep({ until, hours, natural });
  const r = isNatural
    ? (() => { const w = naturalSleepWindow(Date.now()); return { untilMs: w.untilMs, untilRealMs: realNow().getTime() + (w.untilMs - Date.now()), hours: SLEEP_MAX_HOURS, capped: false, natural: true, minUntilMs: w.minUntilMs }; })()
    : resolveSleepUntil({ until, hours, nowMs: Date.now(), realNowMs: realNow().getTime() });
  asleepLog.dropTold(); // 生活不停：上次醒来已经说过的清掉
  sleepState = {
    sleeping: true,
    since: Date.now(),
    reason: String(reason || ''),
    until: r.untilMs,
    ...(isNatural ? { natural: true, minUntil: r.minUntilMs } : {})
  };
  saveSleepState();
  hormoneRecord({ type: 'sleep' });
  const bj = new Date(realNow().getTime() + 8 * 3600e3);
  const bjClock = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
  log(`[sleep] 睡着了（北京时间 ${bjClock}${reason ? `：${reason}` : ''}），${isNatural ? '睡到自然醒（最短 1 小时，最长 14 小时）' : `睡 ${sleepDurationText(r.untilMs - Date.now())}`}${r.capped ? `（她要的更久，压到 ${SLEEP_MAX_HOURS} 小时上限）` : ''}`);
  return r;
}

function exitSleep(why) {
  if (!sleepState.sleeping) return false;
  sleepState = { sleeping: false, since: 0, reason: '', until: 0 };
  saveSleepState();
  hormoneRecord({ type: 'wake' });
  log(`[sleep] 醒了${why ? `（${why}）` : ''}`);
  return true;
}
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
// 大肥鱼表情包（2026-10-24）：目录随桥接一起放在 assets 里；图片用到哪张才下哪张，缓存在 state 里。
const FISH_CATALOG_FILE = path.join(ROOT, 'assets', 'fish-stickers', 'catalog.json');
const FISH_CACHE_DIR = path.join(STATE_DIR, 'fish-sticker-cache');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
// 半个 emoji（落单的 UTF-16 代理项）DeepSeek 会拒收整个请求（400），而且留在会话历史里之后每轮都 400（2026-10-25）。
// 交给 DSH 的文字、回给她工具的字符串都先过一遍：落单的换成 U+FFFD。
function wellFormedV2(v) { return typeof v === 'string' && typeof v.toWellFormed === 'function' ? v.toWellFormed() : v; }
function wellFormedContentV2(content) {
  return Array.isArray(content) ? content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: wellFormedV2(b.text) } : b)) : content;
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 二代）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.v2;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// atUserId 可以是一个 QQ 号、QQ 号数组，或"111,222"这样的串（2026-10-22 主人：一句话里要能同时 @ 多个人）。
// 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员；去重，最多 10 个。
const MAX_AT_PER_MESSAGE = 10;
function parseAtUserIds(atUserId) {
  if (atUserId === undefined || atUserId === null) return [];
  const raw = Array.isArray(atUserId) ? atUserId : String(atUserId).split(/[\s,，、]+/);
  const ids = [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
  for (const at of ids) {
    if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号（多个就传数组），且不能为 all');
  }
  if (ids.length > MAX_AT_PER_MESSAGE) throw new Error(`一条消息最多 @ ${MAX_AT_PER_MESSAGE} 个人`);
  return ids;
}
function hasAtUserIds(atUserId) {
  try { return parseAtUserIds(atUserId).length > 0; } catch { return true; }
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    // 认得的人 { "QQ号": "名字" }（2026-10-24 克劳德姐姐）。这张表是一项一项挑字段的，漏了它 knownNameV2 就永远是空的。
    knownPeople: file.knownPeople && typeof file.knownPeople === 'object' && !Array.isArray(file.knownPeople) ? file.knownPeople : {},
    // 姐妹俩的群 { "群号": "叫法" }（2026-10-25 小房子）：里面认得的人（姐姐）和老大说话都叫醒她，不看她自己设的唤醒条件
    houseGroups: file.houseGroups && typeof file.houseGroups === 'object' && !Array.isArray(file.houseGroups) ? file.houseGroups : {},
    // 要慢一点的群 { "群号": { minWakeGapSec } }（2026-10-25 主人：群D里别刷屏）：两次唤醒至少隔这么久。
    // 2026-10-29 老大（松绑）：「她们俩想回就回」，配置里已经清空；机制留着，空表就不生效，也不再给她带「这个群嫌刷屏」那句。
    slowGroups: file.slowGroups && typeof file.slowGroups === 'object' && !Array.isArray(file.slowGroups) ? file.slowGroups : {},
    // 一直开着鱼的记忆的会话 key（2026-10-25 主人：群D、小房子）。新建会话时自动在 fish-memory-config.json 里打开。
    fishMemoryKeys: Array.isArray(file.fishMemoryKeys) ? file.fishMemoryKeys.map(String) : [],
    // 小房子里轮流说话的节奏（2026-10-25 主人嫌你追我赶）
    houseTiming: file.houseTiming && typeof file.houseTiming === 'object' && !Array.isArray(file.houseTiming) ? file.houseTiming : {},
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    // 妈妈信箱（mom-mailbox.js）：claudeExe / proxy。原来漏了这项，config.json 里的 mom.proxy 被丢掉，
    // 叫起 Claude Code 时没走代理、直连被拦成 403（2026-10-24 M1 连着失败的原因）。
    mom: { ...(file.mom ?? {}) },
    // 激素影子记录（2026-10-29 第五批）：enabled 默认 true，只控制「记不记」，她看不到；personaFile 可换抖音人格资料的位置（测试用）
    hormones: file.hormones && typeof file.hormones === 'object' && !Array.isArray(file.hormones) ? { enabled: true, ...file.hormones } : { enabled: true },
    // 聊天记录（2026-10-29 第五批）：每条收到 / 发出的消息写进 家/小鲸鱼/聊天记录/，给她的索引用。enabled 默认 true
    chatLog: file.chatLog && typeof file.chatLog === 'object' && !Array.isArray(file.chatLog) ? { enabled: true, ...file.chatLog } : { enabled: true },
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        episodes: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 收尾提醒开关（2026-10-29 老大：「这个东西应该是做提醒而不是做限制」——不再拦，只在返回里提醒一句）
        preSleepWaitMs: 300000,          // 多久之内还有人说话就提醒一句（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '想潜水、想收尾直接就能设。刚还有人在说话、不放心的话，可以先 qq_wait_for_messages 等几分钟看看有没有人找你，不等也行。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        // ⚠ 2026-10-23 主人：「发消息速度上限防止被风控的话，告诉她就好了，不需要做成硬限制」。
        // 下面三个数**不是**给她的节奏规矩，是防程序故障的保险丝：万一哪段代码出 bug 循环发消息，
        // 在打出几百条、把号搞封之前把它掐断。正常聊天碰不到这个数；风控风险作为信息写在 recommendedHint 里，她自己拿捏。
        burstMaxMessages: 50,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 60,
        maxSendPerHour: 600,
        // QQ 单条消息的技术上限在 4500 字左右；3000 留足余量，超过的发送端会拒绝（不是替她定长短，只是不让 QQ 吞消息）。
        maxMessageChars: 3000,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '单条消息里的空格会被当成分条，中文短句用逗号/顿号或直接连写看着最自然；分条时每条自己读得通最好，同一句话拆到两条里会怪。发几条、隔多久、每条多长都由你定。一个事实：QQ 对长时间高速发消息的账号可能风控（限制发言甚至冻结）；桥接这边只留了一道防程序故障的保险（每分钟 60 条、每小时 600 条、一次最多 50 条），平时怎么发是你的事。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        // 收到新消息后至少再等这么久再回：私聊（主要是主人）4 秒，群里 10 秒防抢话（2026-10-23 拆成两个）。
        minQuietAfterNewMs: 4000,
        minQuietAfterNewGroupMs: 10000
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 60,     // 提示里最多列出的表情数（2026-10-22：8 → 60，库里 48 张全列出来，省得她先去翻列表）
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        // 2026-10-21 主人要求调高：原来 15 分钟空闲 + 30-90 分钟判定 + 30% 概率，
        // 平均要等 2-5 小时才可能主动开口一次，实际等于"几乎不会主动说话"。
        // 现在：10 分钟空闲 + 15-40 分钟判定 + 60% 概率 —— 大约每半小时到一小时会开口。
        enabled: true,
        checkIntervalMinMs: 15 * 60 * 1000,
        checkIntervalMaxMs: 40 * 60 * 1000,
        idleThresholdMs: 10 * 60 * 1000,
        probability: 0.6
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        // 2026-10-29 主人（刷屏提速）：唤醒时快照一次给够。原来 12 条 / 6000 字，刷屏时一批读不完，她得再调 qq_get_unread 读第二批、
        // 多一轮来回（"想"的时间翻倍）。放到 30 条（跟 unreadLimit 一样）/ 14000 字；钳制上限仍是 100 条 / 20000 字，没动。
        wakeMessageLimit: 30,
        wakeRecentLimit: 4,
        wakeMaxChars: 14000
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    episodes: true, // 情景记忆（qq_keep_moment / qq_recall，见 episodes.js）
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 60,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
// 日志时钟：**用校正后的北京时间**，不是本机时钟。
// 本机是 Etc/GMT+8 且快 180 分钟 —— 日志里写 22:23 会让人以为晚上十点，
// 而实际是上午十一点（用户看日志时会直接对照真实时间）。
function localClock(atMs = Date.now()) {
  try {
    const skew = Number.isFinite(clockSkewMs) ? clockSkewMs : 0;
    const d = new Date(atMs - skew);
    return d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  } catch {
    const d = new Date(atMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
  try { noteFishHealth(line); } catch { /* 记不了就算了 */ }
}

// 她自己的健康记录（2026-10-25 主人：消息发不出去就告诉姐姐）。从日志里认：运行失败、QQ 发送失败、令牌被拒、QQ 断线/重连、发送成功。
// 写 state/fish-health.json（每分钟一次心跳 + 有事时 2 秒内落盘）；姐姐那边（sister/fish-status.mjs）读它判断有没有出事。
const FISH_HEALTH_FILE = path.join(STATE_DIR, 'fish-health.json');
const fishHealth = { startedAt: Date.now(), events: [] };
let fishHealthTimer = null;
function writeFishHealth() {
  fishHealthTimer = null;
  try { atomicWriteJson(FISH_HEALTH_FILE, { heartbeatAt: Date.now(), startedAt: fishHealth.startedAt, events: fishHealth.events.slice(-80) }); } catch { /* 写不进下次再写 */ }
}
function noteFishHealthEvent(kind, key, text) {
  if (kind === 'send') hormoneRecord({ type: 'send_fail' }); // 激素影子记录：发送失败（同一次出错的几条日志只记一次，见 hormone-feed.js）
  fishHealth.events.push({ at: Date.now(), kind, key: key || '', text: String(text || '').slice(0, 200) });
  if (fishHealth.events.length > 200) fishHealth.events.splice(0, fishHealth.events.length - 200);
  if (!fishHealthTimer) fishHealthTimer = setTimeout(writeFishHealth, 2000);
}
function noteFishHealth(line) {
  let m;
  if ((m = /agent 处理出错 \((\S+?)\)：(.*)$/.exec(line))) noteFishHealthEvent('run', m[1], m[2]);
  else if ((m = /QQ 发送失败 \((\S+?)\)[:：]?(.*)$/.exec(line))) noteFishHealthEvent('send', m[1], m[2]);
  else if ((m = /工具统一发送 (\S+?): 成功 (\d+)\/(\d+)/.exec(line))) noteFishHealthEvent(m[2] === '0' ? 'send' : 'ok', m[1], m[2] === '0' ? '一条都没发出去' : '');
  else if (/SnowLuma 连接断开/.test(line)) noteFishHealthEvent('qq-down', '', 'QQ 连接断开');
  else if (/SnowLuma 已连接/.test(line)) noteFishHealthEvent('qq-up', '', '');
}
setInterval(writeFishHealth, 60e3).unref?.();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, resolveFace, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': {
        // 只写 `[表情28]` 的话，模型既不知道这是笑还是哭，也不知道自己该不该"看图"——
        // 一个 40×40 的小黄脸本来就不值得占一次视觉调用。能查到中文名就写名字。
        let faceName = '';
        try {
          faceName = resolveFace ? await resolveFace(String(d.id ?? '')) : '';
        } catch {
          faceName = '';
        }
        out.push(faceName ? `[表情:${faceName}]` : `[表情${d.id ?? ''}]`);
        break;
      }
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // 2026-10-25：语音交给本机「耳朵」听写（SenseVoice），她拿到的是「[语音 7秒：「……」]」；听不了退回 [语音]
      case 'record': out.push(await hearQqRecord(d)); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      // 卡片消息（分享/小程序/音乐/群文件）：json 段里是一整串 JSON，xml 段是 XML。
      // 以前一律折成四个字 `[卡片消息]`，模型等于没收到内容 —— 详见 card-parse.js。
      case 'json':
      case 'xml': out.push(cardToText(d)); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    } else if (seg.type === 'video') {
      // 视频消息：与图片同样带 url/file，下载地址同样需要拼 rkey；
      // 真正「看懂」由 fetchVideoFrames 抽帧后交给视觉模型。
      media.push({
        kind: 'video',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    } else if (seg.type === 'json' || seg.type === 'xml') {
      // 卡片消息的封面图不是 image 段，但它是「能看见」的一部分：
      // 分享封面里常常就有标题之外的信息（截图、人物、曲绘）。
      // 这里只登记 URL，真正下载放在 fetchMediaData，和图片共用同一份大小/像素限制。
      const preview = cardPreviewUrl(d);
      if (preview) media.push({ kind: 'card', url: preview, summary: '' });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  await measureClockSkew();
  const cfg = loadConfig();
  // 印象（2026-10-24）：她对群里某个人的看法，跟着 QQ 号走。懒得理（-3）的人在群里叫她不叫醒她，除非像在道歉。
  // 老大、认得的人（克劳德姐姐）、她自己永远不会被无视。
  const fishImpressions = createImpressions(WHALE_BRAIN.impressions, { exempt: [cfg.ownerQQ, ...Object.keys(cfg.knownPeople || {})].filter(Boolean).map(String) });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // ── 激素影子记录（2026-10-29 第五批，老大同意：先只记录一周，不影响行为，靠日志校准参数；见 src/hormone-feed.js、hormone-shadow.js）。
  // config 的 hormones.enabled=false 就不记。她看不到，也不触发任何行为；出任何错只记一行日志，不影响她说话。
  // 兴趣词表从抖音插件的人格资料读（loadFishInterests），启动读一次，之后每小时刷新（下面 homeWeather 旁边的定时器）。
  let hormoneErrLogged = 0;
  const HORMONE_PERSONA_FILE = cfg.hormones?.personaFile || path.join(BRIDGE_DSH_DIR, 'douyin-browser/memory/persona/state.json');
  hormoneFeed = createHormoneFeed({
    who: 'fish',
    stateDir: STATE_DIR,
    skewMs: () => clockSkewMs,
    asleep: sleepState.sleeping === true,
    enabled: cfg.hormones?.enabled !== false,
    sisterName: '姐姐',
    interests: cfg.hormones?.enabled === false ? [] : loadFishInterests(HORMONE_PERSONA_FILE),
    onError: (error) => { if (hormoneErrLogged++ < 5) log(`[hormones] 影子记录出错（不影响她）：${error?.message ?? error}`); }
  });
  const hormoneNovelty = createNoveltyTracker();

  // ── 实时区缓冲（2026-10-29 老大：想在网页里看她此刻在想什么、调什么工具、说了什么、写了没说的）。
  // 只放内存、进程一重启就没了，绝不落盘（src/live-buffer.js 里连 fs 都没引）；网页读它走 SSE（startConsoleServer 里的 daughters 路由）。
  const liveFish = createLiveBuffer({ who: 'fish' });
  const liveLabelCache = new Map(); // 会话 key → 人话名字（一分钟内不重读标题文件）
  function liveLabelOf(key) {
    const hit = liveLabelCache.get(key);
    if (hit && Date.now() - hit.at < 60e3) return hit.label;
    let label = key;
    try { label = sessionTitleForV2(key) || sharedKeyLabelV2(key) || key; } catch { label = key; }
    liveLabelCache.set(key, { label, at: Date.now() });
    return label;
  }

  // ── 聊天记录（2026-10-29 第五批，老大：「给妹妹也做成一样吧」）：每条收到、发出的消息按「北京日期 + 会话」写进
  // 家/小鲸鱼/聊天记录/<日期>-<会话>.md，格式跟姐姐的 sister/聊天记录 一样（见 src/chatlog.js）；brain/index.py 把它编进她的索引。
  // 不进脑子目录；只在本机算索引，不增加 API 花费，每次带上的条数也不变。写不下来只记一行日志。
  let chatLogErrLogged = 0;
  const FISH_CHATLOG_DIR = WHALE_BRAIN.chatLogs || path.join(WHALE_BRAIN.home, '聊天记录');
  const fishChatLog = cfg.chatLog?.enabled === false ? null : createChatLog({
    dir: FISH_CHATLOG_DIR,
    selfName: '小鲸鱼',
    skewMs: () => clockSkewMs,
    onError: (error) => { if (chatLogErrLogged++ < 5) log(`[chatlog] 写聊天记录没成（不影响她）：${error?.message ?? error}`); }
  });
  // 群号 → 群名要稳定（同一个群每次得到同一个名字，一天的话才不会散在两个文件里）：
  // 配置里起的叫法（小房子）> 向 QQ 问到的（记在 state/chatlog-groups.json）> 姐姐记的 > 会话标题 > 群号。
  const CHATLOG_GROUPS_FILE = path.join(STATE_DIR, 'chatlog-groups.json');
  const chatLogGroupNames = (() => { const j = readJsonSafe(CHATLOG_GROUPS_FILE, {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; })();
  const chatLogGroupMiss = new Map(); // 群号 → 上次问不到的时间（10 分钟内不再问）
  let chatLogSisterGroups = { at: 0, map: {} };
  const chatLogSisterGroupName = (gid) => {
    if (Date.now() - chatLogSisterGroups.at > 10 * 60e3) chatLogSisterGroups = { at: Date.now(), map: sisterGroupNames(path.join(ROOT, 'sister', 'state', 'sister-state.json')) };
    return chatLogSisterGroups.map[gid] || '';
  };
  async function chatLogGroupName(gid) {
    const g = String(gid);
    const alias = cfg.houseGroups?.[g] || '';
    if (!alias && !chatLogGroupNames[g] && !(Date.now() - (chatLogGroupMiss.get(g) || 0) < 10 * 60e3)) {
      try {
        const res = await withTimeout(bot.request('get_group_info', { group_id: Number(g) }), 4000, `get_group_info ${g}`);
        const name = String(res?.data?.group_name ?? '').trim();
        if (name) {
          chatLogGroupNames[g] = name;
          try { atomicWriteJson(CHATLOG_GROUPS_FILE, chatLogGroupNames); } catch { /* 记不下下次再问 */ }
        } else chatLogGroupMiss.set(g, Date.now());
      } catch { chatLogGroupMiss.set(g, Date.now()); }
    }
    return pickGroupName(g, { alias, cached: chatLogGroupNames[g] || '', sister: chatLogSisterGroupName(g), title: sessionTitleForV2(`group:${g}`) });
  }
  const isSisterQQ = (uid) => /姐姐/.test(String(cfg.knownPeople?.[String(uid ?? '')] || ''));
  /** 会话 key → 聊天记录里的「会话」（老大 / 姐姐 / 群 / 别的私聊）。 */
  async function chatLogSessionFor(key) {
    if (String(key).startsWith('group:')) return { type: 'group', name: await chatLogGroupName(String(key).slice(6)) };
    const uid = String(key).slice(8);
    if (cfg.ownerQQ && uid === String(cfg.ownerQQ)) return { type: 'owner' };
    if (isSisterQQ(uid)) return { type: 'sister' };
    // 文件名要稳定：认得的人用 knownPeople 的名字，其次会话标题，都没有就用 QQ 号（昵称只写在每行的名字上，不进文件名——昵称会改）
    return { type: 'friend', name: knownNameV2(uid) || sessionTitleForV2(`private:${uid}`) || uid };
  }
  let chatLogChain = Promise.resolve();
  /** 记一条（排队写，保证同一个会话里先来的先写；群名要问 QQ 时不挡住别的）。who：谁说的；text：原话。 */
  function chatLogNote(key, who, text, at = Date.now()) {
    if (!fishChatLog || !/^(group|private):\d+$/.test(String(key))) return;
    chatLogChain = chatLogChain.then(async () => {
      fishChatLog.append({ session: await chatLogSessionFor(key), who, text, at });
    }).catch(() => {});
  }
  /** 测试用：等排着的都写完。 */
  const chatLogIdle = () => chatLogChain;
  /** 引用段太长的压短（「[引用 某人：很长的原文] 回复」→ 原文只留 60 字），其余原样。 */
  const chatLogCompact = (t) => String(t ?? '').replace(/^\[引用 ([^：\]]{1,40})：([^\]]*)\]/, (_m, who, quoted) => `[引用 ${who}：${quoted.length > 60 ? `${quoted.slice(0, 60)}…` : quoted}]`);

  /**
   * 一条消息进来了：记激素影子记录 + 聊天记录。睡着时来的消息也算（后面睡着的分支会直接 return），所以在 handleIncoming 很靠前的地方调。
   * 两件事都是「只记」，出错吞掉。
   */
  function noteIncomingV2(kind, id, event, key, textContent, plainContent, quoteTargetIsSelf) {
    try {
      const plain = String(plainContent ?? '').trim();
      if (!plain && !quoteTargetIsSelf) return;
      if (kind === 'group' && /^\s*(#sl\b|SnowLuma 状态)/i.test(plain)) return;
      const uid = String(event?.user_id ?? '');
      const isOwner = Boolean(cfg.ownerQQ) && uid === String(cfg.ownerQQ);
      const sisterSpeaker = isSisterQQ(uid) && (kind === 'private' || Boolean(cfg.houseGroups?.[String(id)]));
      const nick = String(event?.sender?.card || event?.sender?.nickname || '').trim();
      const atMe = Boolean(quoteTargetIsSelf) || (Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? '')));
      const lower = plain.toLowerCase();
      const names = [selfNickname, ...(Array.isArray(cfg.hormones?.names) ? cfg.hormones.names : ['小鲸鱼'])].map((n) => String(n ?? '').trim().toLowerCase()).filter((n) => n.length >= 2);
      const nameMention = kind === 'group' && names.some((n) => lower.includes(n));
      const novelty = kind === 'group' ? hormoneNovelty.score(key, plain) : undefined;
      for (const ev of incomingHormoneEvents({ where: kind, isOwner, isSister: sisterSpeaker, atMe, nameMention, text: plain, novelty })) hormoneRecord(ev);
      const who = whoLabel({ isOwner, userId: uid, sender: nick, knownPeople: cfg.knownPeople });
      chatLogNote(key, who, chatLogCompact(textContent) || plain || '（引用了你的话）');
    } catch { /* 记不下就算了 */ }
  }

  /** 她发出去了（文字一批、语音、表情、图片都走这里）：记激素影子记录（一批算一次）+ 聊天记录（一条一行）。 */
  function noteSentV2(key, texts) {
    try {
      const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).filter((t) => t.trim());
      if (list.length === 0) return;
      const k = String(key);
      let target = 'other';
      if (k.startsWith('group:')) target = cfg.houseGroups?.[k.slice(6)] ? 'sister' : 'group';
      else if (cfg.ownerQQ && k === `private:${cfg.ownerQQ}`) target = 'owner';
      else if (isSisterQQ(k.slice(8))) target = 'sister';
      const ev = sentHormoneEvent(target);
      if (ev) hormoneRecord(ev);
      const at = Date.now();
      for (const t of list) chatLogNote(k, '小鲸鱼', t, at);
    } catch { /* 记不下就算了 */ }
  }

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    noteSentV2(key, label ? `[语音] ${label}` : '[语音]'); // 2026-10-29 第五批：激素影子记录 + 聊天记录（语音的话是她附的说明，没有就只写 [语音]）
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    // 2026-10-24 大肥鱼表情包：收藏里没有、写的是「鱼:名字」或编号的，从那套里发
    if (!entry) {
      const fish = findFish(fishCatalogV2(), stickerRef);
      if (fish?.ambiguous) throw new Error(`「${String(stickerRef).trim()}」有好几张：${fish.ambiguous.map((s) => `鱼:${s.code.split('_')[0]}（${s.emotion}，${s.use || s.name}）`).join(' / ')}。用编号发`);
      if (fish?.sticker) return sendFishStickerV2(key, fish.sticker, options, assertSendAllowed);
    }
    if (!entry) {
      // 备注只写了一部分、对上了好几张时，把候选列出来，让她挑一个写全
      const all = synced?.entries ?? stickerEntries;
      const ref = String(stickerRef ?? '').trim();
      const cands = ref.length >= 2 ? all.filter((e) => e && ((e.desc && e.desc.includes(ref)) || (e.localNote && e.localNote.includes(ref)))).slice(0, 8).map((e) => e.desc || e.localNote) : [];
      throw new Error(cands.length > 1 ? `「${ref}」对上了好几张：${cands.join(' / ')}。挑一张把备注写全再发` : `找不到表情 ${stickerRef}：直接写提示里列的备注，或用 qq_list_stickers 查`);
    }
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    for (const at of parseAtUserIds(atUserId)) segments.push({ type: 'at', data: { qq: at } });
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 大肥鱼表情包：目录只读一次；发的时候按需下图（校验哈希、缓存），以表情的样子（sub_type 1）发出去。
  let fishCatalogCache = null;
  function fishStickerHintV2() {
    const n = fishCatalogV2().stickers.length;
    if (!n) return '';
    return `【大肥鱼表情包】另有一套 ${n} 张动图表情，画的是一只 DeepSeek 鲸鱼娘（深蓝长发、女仆头饰），跟你挺像；有几十张是她和 GPT娘的双人图。想用就 qq_fish_sticker 按心情或场景搜（「刚睡醒」「满头问号」「得意」都行），挑中了用 qq_send_sticker 发「鱼:名字」。画师是 B 站的「可以叫我云大人」。`;
  }
  function fishCatalogV2() {
    if (!fishCatalogCache) fishCatalogCache = loadFishCatalog(FISH_CATALOG_FILE);
    return fishCatalogCache;
  }
  async function sendFishStickerV2(key, sticker, options, assertSendAllowed) {
    let gif;
    try {
      gif = await getFishGif(fishCatalogV2(), sticker, { cacheDir: FISH_CACHE_DIR, fetchBuffer: safeFetchBuffer, maxBytes: MAX_MEDIA_BYTES });
    } catch (error) {
      throw new Error(`${fishLabel(sticker)} 这张图没取到（网站连不上或图换了）：${error?.message ?? error}。换一张或等会儿再发`);
    }
    const [kind, id] = key.split(':');
    const segments = [];
    if (options.replyToMessageId !== undefined && options.replyToMessageId !== null && String(options.replyToMessageId).trim() !== '') {
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    for (const at of parseAtUserIds(options.atUserId)) segments.push({ type: 'at', data: { qq: at } });
    segments.push({ type: 'image', data: { file: 'base64://' + gif.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => { sendResolve = resolve; sendReject = reject; });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    log(`[sticker] 发了大肥鱼 ${sticker.code}${gif.cached ? '' : '（第一次用，已下载缓存）'} → ${key}`);
    return { entry: { id: sticker.code, desc: `${fishLabel(sticker)}（${sticker.emotion}）`, localNote: '' }, messageId: data?.message_id ?? null };
  }

  // 发送任意图片（URL 或 base64）。让她能把自己找到的表情包/图片真正发出来，
  // 而不是只能发表情库里已有的。
  async function sendImageV2(key, source, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = String(key).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error('key 格式应为 group:群号 或 private:QQ号');
    const segments = [];
    if (options.replyToMessageId !== undefined && options.replyToMessageId !== null && String(options.replyToMessageId).trim() !== '') {
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    for (const at of parseAtUserIds(options.atUserId)) segments.push({ type: 'at', data: { qq: at } });
    let buffer;
    if (source.base64) {
      buffer = Buffer.from(String(source.base64), 'base64');
      if (!buffer.length) throw new Error('图片数据为空');
      if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`图片超过大小上限（${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB）`);
    } else if (source.url) {
      // 复用带 DNS 固定与逐跳校验的下载器，不把 URL 交给网关重新抓。
      const fetched = await safeFetchBuffer(String(source.url), MAX_MEDIA_BYTES);
      buffer = fetched.buffer;
    } else {
      throw new Error('需要提供 url 或 base64 之一');
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => { sendResolve = resolve; sendReject = reject; });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    noteSentV2(key, '[图片]'); // 2026-10-29 第五批：激素影子记录 + 聊天记录
    return { messageId: data?.message_id ?? null, bytes: buffer.length };
  }

  // 发 QQ 空间说说。图片支持 http(s)/file/base64，网关自动上传。
  // 不限条数（2026-10-23 主人：只有她非常想说的才发；每天的总结固定要发）。每日计数仍按北京时间自然日记着，只用来记录。
  // 用校正后的北京时间算自然日，避免主机时钟偏差导致跨天判断错。
  function bjDayKey(ms = Date.now()) {
    const bj = new Date(ms - clockSkewMs + 8 * 3600 * 1000);
    return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
  }

  // 网关返回的 QQ 空间文本里带两种原始标记，模型看不懂，转成人读的：
  //   @{uin:10051,nick:某某某🐳[em]e327831[/em],who:1}  →  @某某某🐳
  //   [em]e327831[/em]                                        →  ［表情］
  function readableQzoneText(raw) {
    return String(raw ?? '')
      .replace(/@\{uin:\d+,nick:([^,}]*)(?:,[^}]*)*\}/g, (_m, nick) => `@${String(nick || '').replace(/\[em\][^\[]*\[\/em\]/g, '').trim() || '某人'}`)
      .replace(/\[em\][^\[]*\[\/em\]/g, '［表情］')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // unix 秒 → 北京时间字符串，方便模型直接读。
  function formatQzoneTime(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  }

  async function publishQzoneV2(key, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const content = String(options.content ?? '').trim();
    if (!content) throw new Error('说说正文不能为空');
    if (content.length > 2000) throw new Error('说说正文过长（上限 2000 字）');
    const ugcRight = Number(options.ugcRight ?? 1);
    if (![1, 4, 16, 64, 128].includes(ugcRight)) throw new Error('ugcRight 只能是 1/4/16/64/128');

    const nowMs = Date.now();
    const dayKey = bjDayKey(nowMs);
    // 计数是账号级的：不管从哪个会话发，都共用同一份每日计数（不再拦）。
    const daily = qzoneDaily.day === dayKey ? qzoneDaily : { day: dayKey, count: 0 };

    const params = { content, ugc_right: ugcRight };
    const images = Array.isArray(options.images) ? options.images.filter(Boolean).slice(0, 9) : [];
    if (images.length) params.images = images;
    const targetUins = Array.isArray(options.targetUins) ? options.targetUins.filter(Boolean) : [];
    if (targetUins.length) params.target_uins = targetUins;
    assertSendAllowed();
    const res = await bot.request('send_qzone_msg', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`send_qzone_msg 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    // 只有真的发成功才计数。用展开保留评论额度字段，别把 commentDay/commentCount 冲掉。
    qzoneDaily = { ...qzoneDaily, day: dayKey, count: daily.count + 1 };
    saveQzoneState();
    log(`[qzone] 已发表说说 ${key}: ${content.slice(0, 30)}（权限 ${ugcRight}，图片 ${images.length} 张，今日第 ${qzoneDaily.count} 条）`);
    return res.data;
  }

  // 读 QQ 空间：mode='mine' 读某人（默认自己）的说说列表，mode='feeds' 读好友动态。
  async function readQzoneV2(mode, options = {}) {
    if (mode === 'feeds') {
      const res = await bot.request('get_qzone_feeds', {
        page_num: Math.max(1, Number(options.page) || 1),
        num: Math.min(20, Math.max(1, Number(options.num) || 10))
      });
      if (!res || res.status !== 'ok' || res.retcode !== 0) {
        throw new Error(`get_qzone_feeds 失败: ${res?.wording || res?.retcode || 'unknown'}`);
      }
      // 网关返回的是原始 feed（每条带整段 HTML），对模型没用，压成纯文本摘要。
      const stripHtml = (html) => String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const feeds = Array.isArray(res.data?.feeds) ? res.data.feeds : [];
      return {
        total: res.data?.total ?? feeds.length,
        feeds: feeds
          // 动态流里混着广告（uin=0 / key=advertisement_*），对模型毫无意义，直接丢掉。
          .filter((f) => f && f.uin && !/^advertisement/i.test(String(f.key || '')))
          .map((f) => ({
            nickname: f.nickname || '',
            uin: f.uin,
            time: f.time,
            timeText: formatQzoneTime(f.time),
            appid: f.appid,
            // appid=311 是说说，此时 key 就是 tid，可以直接喂给 comment_qzone / like_qzone。
            // 其它类型（相册等）没有 tid，留空，别让模型拿去乱调。
            tid: Number(f.appid) === 311 ? String(f.key || '') : '',
            text: stripHtml(f.html || '').slice(0, 240)
          }))
      };
    }
    const params = {
      pos: Math.max(0, Number(options.pos) || 0),
      num: Math.min(50, Math.max(1, Number(options.num) || 20))
    };
    if (options.targetUin) params.target_uin = Number(options.targetUin);
    const res = await bot.request('get_qzone_msg_list', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`get_qzone_msg_list 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    const list = Array.isArray(res.data?.msglist) ? res.data.msglist : [];
    return {
      total: res.data?.total ?? list.length,
      msglist: list.map((m) => ({
        tid: m.tid,
        content: m.content,
        time: m.time,
        timeText: formatQzoneTime(m.time),
        // 有人评论了这条就是非 0，模型据此判断要不要点开看。
        commentNum: Number(m.comment_num) || 0,
        isPrivate: Boolean(m.is_private),
        images: Array.isArray(m.images) ? m.images : []
      }))
    };
  }

  // 读一条说说的详情与一级评论（含二级回复）。
  // tid 来自 get_qzone_msg_list 的 tid 或 qq_get_qzone(feeds) 返回的 tid。
  async function readQzoneDetailV2(tid, options = {}) {
    const cleanTid = String(tid ?? '').trim();
    if (!cleanTid) throw new Error('tid 不能为空');
    const params = {
      tid: cleanTid,
      pos: Math.max(0, Number(options.pos) || 0),
      num: Math.min(100, Math.max(1, Number(options.num) || 20))
    };
    if (options.targetUin) params.target_uin = Number(options.targetUin);
    const res = await bot.request('get_qzone_msg_detail', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`get_qzone_msg_detail 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    const d = res.data || {};
    const mapComment = (c) => ({
      commentId: String(c?.comment_id ?? ''),
      uin: c?.uin,
      // 昵称里常带 QQ 空间表情码（[em]e327831[/em]），直接去掉，别当正文一起显示。
      name: String(c?.name || '').replace(/\[em\][^\[]*\[\/em\]/g, '').trim(),
      time: c?.time,
      timeText: formatQzoneTime(c?.time),
      content: readableQzoneText(c?.content),
      // 二级回复网关不保证完整，拿到了就给，拿不到就是空数组。
      replies: Array.isArray(c?.replies) ? c.replies.map(mapComment) : []
    });
    return {
      tid: d.tid,
      content: d.content,
      commentNum: Number(d.comment_num) || 0,
      comments: Array.isArray(d.comments) ? d.comments.map(mapComment) : []
    };
  }

  // 评论一条说说。每天最多 qzone.maxCommentPerDay 条（默认 20），按北京时间自然日算。
  // 自己的说说省略 targetUin；评论别人的说说要传对方 QQ 号（feeds / msglist 里的 uin）。
  async function commentQzoneV2(key, tid, content, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const cleanTid = String(tid ?? '').trim();
    if (!cleanTid) throw new Error('tid 不能为空');
    const text = String(content ?? '').trim();
    if (!text) throw new Error('评论内容不能为空');
    if (text.length > 200) throw new Error('评论过长（上限 200 字）');

    const dayKey = bjDayKey();
    const maxPerDay = Math.max(1, Number(cfg.socialV2?.qzone?.maxCommentPerDay) || 20);
    const counted = qzoneDaily.commentDay === dayKey ? qzoneDaily.commentCount : 0;
    if (counted >= maxPerDay) {
      throw new Error(`今天（${dayKey}）已经评论过 ${counted} 条了，额度用完，明天再说`);
    }

    const params = { tid: cleanTid, content: text };
    if (options.targetUin) params.target_uin = Number(options.targetUin);
    const images = Array.isArray(options.images) ? options.images.filter(Boolean).slice(0, 9) : [];
    if (images.length) params.images = images;
    assertSendAllowed();
    const res = await bot.request('comment_qzone', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`comment_qzone 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    qzoneDaily = { ...qzoneDaily, commentDay: dayKey, commentCount: counted + 1 };
    saveQzoneState();
    log(`[qzone] 已评论 ${key}: tid=${cleanTid} → ${text.slice(0, 30)}（今日 ${counted + 1}/${maxPerDay}）`);
    return { tid: cleanTid, content: text, commentCountToday: counted + 1, maxPerDay };
  }

  // 点赞 / 取消赞。abstime 用说说的发表时间（unix 秒）更可靠，拿不到就传 0 让网关自己猜。
  async function likeQzoneV2(key, tid, like, options = {}) {
    const cleanTid = String(tid ?? '').trim();
    if (!cleanTid) throw new Error('tid 不能为空');
    const params = { tid: cleanTid, abstime: Math.max(0, Number(options.abstime) || 0) };
    if (options.targetUin) params.target_uin = Number(options.targetUin);
    const res = await bot.request(like ? 'like_qzone' : 'unlike_qzone', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`${like ? 'like_qzone' : 'unlike_qzone'} 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    log(`[qzone] ${like ? '点赞' : '取消赞'} ${key}: tid=${cleanTid}`);
    return { tid: cleanTid, liked: Boolean(like) };
  }

  // ── 改自己的 QQ 资料 ────────────────────────────────────────────────────
  // 读当前资料。
  // 注意：get_login_info 返回的 nickname 是登录账号名，跟别人看到的 QQ 昵称**不是一回事**
  // （实测一个是"<她的QQ昵称>"、一个是"小鲸鱼"）。真正的资料要用 get_stranger_info 查，
  // 它还能带回签名、性别、自定义状态、QQ 等级。
  async function readProfileV2() {
    const login = await bot.request('get_login_info', {});
    if (!login || login.status !== 'ok' || login.retcode !== 0) {
      throw new Error(`get_login_info 失败: ${login?.wording || login?.retcode || 'unknown'}`);
    }
    const uin = login.data?.user_id;
    const res = await bot.request('get_stranger_info', { user_id: uin });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      // 查不到详细资料时退回登录信息，至少不报错。
      return { uin, nickname: login.data?.nickname ?? '' };
    }
    const d = res.data || {};
    return {
      uin,
      nickname: d.nickname || '',
      sex: d.sex,                    // male / female / unknown
      age: d.age,
      signature: d.long_nick || '',  // 个性签名
      level: d.qq_level ?? d.qqLevel,
      status: d.status,              // 10 在线 / 30 离开 / 40 隐身 / 60 忙碌
      customStatus: d.customStatus?.wording || '',
      // 头像本身不在这份资料里，只能拼 CDN 地址；真正"看"要用 /api/socialV2/avatar。
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`
    };
  }

  // 拉「她现在的 QQ 头像」的图片字节，给视觉用。
  // 走 qlogo CDN：换完头像立刻能查到新图（加时间戳破缓存），比从客户端截图靠谱。
  async function readAvatarImageV2(options = {}) {
    const prof = await readProfileV2();
    if (!prof.uin) throw new Error('拿不到自己的 QQ 号');
    const allowed = [40, 100, 140, 640];
    const size = allowed.includes(Number(options.size)) ? Number(options.size) : 640;
    const imgUrl = `https://q1.qlogo.cn/g?b=qq&nk=${prof.uin}&s=${size}&t=${Date.now()}`;
    // 注意：safeFetchBuffer 返回 { url, statusCode, buffer }，不是裸 Buffer。
    const fetched = await safeFetchBuffer(imgUrl, 4 * 1024 * 1024);
    const buf = fetched?.buffer;
    if (!buf || !buf.length) throw new Error('头像 CDN 返回空内容');
    return {
      uin: prof.uin,
      nickname: prof.nickname,
      size,
      bytes: buf.length,
      // 跟 /api/socialV2/self-image 保持同一个形状，MCP 侧共用一套读法。
      image: { mimeType: mimeFromBuffer(buf) || 'image/png', data: buf.toString('base64') }
    };
  }

  // 改昵称 / 个性签名 / 性别。昵称每天最多 1 次（QQ 侧本来也有限制）。
  async function updateProfileV2(key, options = {}) {
    const params = {};
    const wantNick = options.nickname !== undefined && options.nickname !== null;
    if (wantNick) {
      const nick = String(options.nickname).trim();
      if (!nick) throw new Error('昵称不能为空（想清空请用别的方式）');
      if (nick.length > 36) throw new Error('昵称过长（上限 36 字）');
      params.nickname = nick;
    }
    if (options.personalNote !== undefined && options.personalNote !== null) {
      params.personal_note = String(options.personalNote).slice(0, 200);
    }
    if (options.sex !== undefined && options.sex !== null) {
      const sex = Number(options.sex);
      if (![0, 1, 2].includes(sex)) throw new Error('sex 只能是 0(未知)/1(男)/2(女)');
      params.sex = sex;
    }
    if (!Object.keys(params).length) throw new Error('至少要给 nickname / personalNote / sex 里的一个');

    if (wantNick) {
      const dayKey = bjDayKey();
      const used = profileDaily.day === dayKey ? profileDaily.nick : 0;
      if (used >= 1) throw new Error(`今天（${dayKey}）已经改过一次昵称了，明天再说`);
    }

    const res = await bot.request('set_qq_profile', params);
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`set_qq_profile 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    if (wantNick) {
      const dayKey = bjDayKey();
      const used = profileDaily.day === dayKey ? profileDaily.nick : 0;
      profileDaily = { day: dayKey, nick: used + 1, avatar: profileDaily.day === dayKey ? profileDaily.avatar : 0 };
      saveProfileState();
      // 改了昵称就立刻刷新身份行。不刷新的话，她下一轮 prompt 里还写着自己叫旧名字，
      // 别人叫新名字时她会当成别人 —— 而且这个错会一直持续到下次重启 bridge。
      try {
        selfDisplayName = String(params.nickname).trim();
        selfNickname = selfDisplayName.toLowerCase();
        log(`[profile] 身份行同步为新昵称：${selfDisplayName}`);
      } catch { /* 刷新失败不影响改名本身 */ }
    }
    log(`[profile] ${key} 改了资料：${Object.keys(params).join('/')}${params.nickname ? ` → ${params.nickname}` : ''}`);
    return { changed: Object.keys(params), nickname: params.nickname ?? null };
  }

  // 单独设个性签名（longNick），比 set_qq_profile 的 personal_note 更"正规"。
  async function setLongNickV2(key, longNick) {
    const text = String(longNick ?? '');
    if (text.length > 200) throw new Error('签名过长（上限 200 字）');
    const res = await bot.request('set_self_longnick', { longNick: text });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`set_self_longnick 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    log(`[profile] ${key} 改了签名：${text.slice(0, 30) || '(清空)'}`);
    return { longNick: text };
  }

  // 把资产库里的形象图处理成一张能当头像的正方形图（base64）。
  // 裁法：以短边为准裁正方形；竖图从顶部裁（保住头部），横图居中裁。
  // ⚠️ 宽高必须在 JS 里算成字面量再交给 ffmpeg：crop 表达式里的逗号会被
  // ffmpeg 当成滤镜链分隔符（min(iw,ih) 会直接报 "No such filter"）。
  // ⚠️ 实测只有 default（单张 Q 版）裁出来好看；chibi / mature 是四联三视图
  // 和局部特写拼贴，怎么裁都是一堆小人，所以这两个值只作兜底。
  function renderSelfAvatarBuffer(name) {
    const galleryDir = WHALE_BRAIN.gallery;
    const cleanName = String(name ?? '').trim();
    let filePath;
    if (!cleanName || cleanName === 'default') {
      filePath = path.join(ROOT, 'assets', 'deepseek娘.png');
    } else {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(cleanName)) throw new Error('形象名不合法（只允许字母、数字、下划线、连字符）');
      filePath = path.join(galleryDir, cleanName + '.png');
      if (!fs.existsSync(filePath)) {
        const avail = fs.existsSync(galleryDir)
          ? fs.readdirSync(galleryDir).filter((f) => /\.png$/i.test(f)).map((f) => f.replace(/\.png$/i, '')).sort()
          : [];
        throw new Error(`没有名为 ${cleanName} 的形象${avail.length ? `（可用：${avail.join('、')}）` : ''}`);
      }
    }
    const ffmpeg = resolveFfmpeg({ ffmpegPath: cfg.socialV2?.voice?.ffmpegPath || null });
    const ffprobe = String(ffmpeg).replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    let vf;
    try {
      const dim = execFileSync(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath
      ], { encoding: 'utf8' }).trim();
      const [w, h] = dim.split(',').map(Number);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error('读不到图片尺寸');
      vf = w > h
        ? `crop=${h}:${h}:${Math.round((w - h) / 2)}:0,scale=640:640:flags=lanczos`
        : `crop=${w}:${w}:0:0,scale=640:640:flags=lanczos`;
    } catch (error) {
      throw new Error(`解析形象图尺寸失败：${error?.message ?? error}`);
    }
    return execFileSync(ffmpeg, [
      '-v', 'error', '-i', filePath,
      '-vf', vf,
      '-f', 'image2pipe', '-vcodec', 'png', '-'
    ], { maxBuffer: 24 * 1024 * 1024 });
  }

  // 把一张任意尺寸的图片裁成 640×640 正方形，返回新的 Buffer。
  // 竖图从顶部裁（保住脸），横图居中裁。宽高先在 JS 里算成字面量 ——
  // crop 表达式里的逗号会被 ffmpeg 当成滤镜链分隔符。
  function squareImageBuffer(buf) {
    if (!buf || !buf.length) throw new Error('图片内容为空');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-avatar-'));
    const src = path.join(dir, 'src.img');
    const out = path.join(dir, 'out.png');
    try {
      fs.writeFileSync(src, buf);
      const ffmpeg = resolveFfmpeg({ ffmpegPath: cfg.socialV2?.voice?.ffmpegPath || null });
      const ffprobe = String(ffmpeg).replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      const dim = execFileSync(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src
      ], { encoding: 'utf8' }).trim();
      const [w, h] = dim.split(',').map(Number);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error('读不到图片尺寸');
      const vf = w > h
        ? `crop=${h}:${h}:${Math.round((w - h) / 2)}:0,scale=640:640:flags=lanczos`
        : `crop=${w}:${w}:0:0,scale=640:640:flags=lanczos`;
      execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vf', vf, out]);
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 换头像。每天最多 1 次。
  // source：http(s) URL（由我们自己下载 + 裁方，绝不把 URL 甩给网关去下）/ 裸 base64 / file://
  // 或者传 selfName 直接用人设形象图。
  async function setAvatarV2(key, source, options = {}) {
    let src;
    let origin = 'source';
    if (options.selfName) {
      const buf = renderSelfAvatarBuffer(options.selfName);
      if (!buf || !buf.length) throw new Error('形象图渲染失败');
      src = 'base64://' + buf.toString('base64');
      origin = `人设图 ${options.selfName || 'default'}`;
    } else {
      src = String(source ?? '').trim();
      if (!src) throw new Error('头像来源不能为空（给 source，或给 selfName 用人设形象图）');
      if (/^https?:\/\//i.test(src)) {
        // 自己下载：safeFetchBuffer 带 SSRF/内网防护 + 内容校验（必须是 PNG/JPEG/GIF/WebP）。
        // 顺带裁成正方形，避免 QQ 按自己的规则乱裁。
        const fetched = await safeFetchBuffer(src, 8 * 1024 * 1024);
        const raw = fetched?.buffer;
        if (!raw || !raw.length) throw new Error('图片下载失败（空内容）');
        const squared = squareImageBuffer(raw);
        src = 'base64://' + squared.toString('base64');
        origin = `网络图 ${fetched.url}`;
      } else if (!/^(base64|file):\/\//i.test(src) && !/^[A-Za-z0-9+/=]+$/.test(src.slice(0, 200))) {
        throw new Error('source 只接受 http(s) URL、base64 字符串或 base64:// 形式');
      }
    }
    const dayKey = bjDayKey();
    const used = profileDaily.day === dayKey ? profileDaily.avatar : 0;
    if (used >= 1) throw new Error(`今天（${dayKey}）已经换过一次头像了，明天再说`);
    const res = await bot.request('set_qq_avatar', { file: src });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`set_qq_avatar 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    const nickUsed = profileDaily.day === dayKey ? profileDaily.nick : 0;
    profileDaily = { day: dayKey, nick: nickUsed, avatar: used + 1 };
    saveProfileState();
    log(`[profile] ${key} 换了头像（${origin}）`);
    return { changed: ['avatar'], selfImage: options.selfName || null };
  }

  // 在线状态。status 是 QQ 的状态码（10=在线 30=离开 40=隐身 60=忙碌 …），
  // 不传就只按 wording 设自定义状态。
  async function setStatusV2(key, options = {}) {
    if (options.wording !== undefined) {
      const res = await bot.request('set_diy_online_status', {
        face_id: Number(options.faceId) || 1,
        face_type: 1,
        wording: String(options.wording).slice(0, 40)
      });
      if (!res || res.status !== 'ok' || res.retcode !== 0) {
        throw new Error(`set_diy_online_status 失败: ${res?.wording || res?.retcode || 'unknown'}`);
      }
      log(`[profile] ${key} 自定义状态：${options.wording}`);
      return { wording: String(options.wording) };
    }
    const status = Number(options.status);
    if (!Number.isFinite(status) || status === 0) throw new Error('status 需要是正整数（10 在线 / 30 离开 / 40 隐身 / 60 忙碌 等）');
    const res = await bot.request('set_online_status', {
      status,
      ext_status: Number(options.extStatus) || 0,
      battery_status: Number(options.battery) || 100
    });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`set_online_status 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    log(`[profile] ${key} 在线状态 → ${status}`);
    return { status };
  }

  // 改自己在某个群里的群名片（空字符串 = 清除）。
  async function setGroupCardV2(key, groupId, card) {
    const gid = Number(groupId);
    if (!Number.isFinite(gid) || gid <= 0) throw new Error('group_id 不合法');
    const self = await readProfileV2();
    const text = String(card ?? '').trim().slice(0, 30);
    const res = await bot.request('set_group_card', { group_id: gid, user_id: self.uin, card: text });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`set_group_card 失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    log(`[profile] ${key} 改群名片 group=${gid} → ${text || '(清除)'}`);
    return { groupId: gid, card: text };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    // 自己发的也允许收藏：她可能刚用 qq_send_image 发了一张想留着的图。
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  // 从任意图片源（URL 或 base64）加入 QQ 收藏表情。
  // 补上 collectStickerV2 的缺口：那张只认"当前会话里别人发的"图片，
  // 她自己从网上找到的图、或她刚发出去的图，都没法存成表情。
  async function addStickerV2(key, source, remark) {
    const assertSendAllowed = captureSendGuard(key);
    let buffer;
    if (source.base64) {
      buffer = Buffer.from(String(source.base64), 'base64');
    } else if (source.url) {
      const fetched = await safeFetchBuffer(String(source.url), MAX_MEDIA_BYTES);
      buffer = fetched.buffer;
    } else {
      throw new Error('需要提供 url 或 base64 之一');
    }
    if (!buffer?.length) throw new Error('图片数据为空');
    if (!looksLikeImageBuffer(buffer)) {
      throw new Error('这个地址不是可识别的图片（只支持 PNG/JPEG/GIF/WebP）');
    }
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file: 'base64://' + buffer.toString('base64') });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark, bytes: buffer.length };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    let saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    // 2026-10-24：学习会话一直复用会越攒越长（到过 22 万 token）。它隔几小时才跑一次，缓存早过期，
    // 每次都按全价把整段重读一遍。每次的提示词都是自带素材的（buildExtractionPrompt / buildResearchPrompt），
    // 学到的词存在 slang.json 里，不靠会话记忆——所以上一次用到的上下文超过 6 万就换个新会话。
    const reuseId = slangLearnerSessionId || (saved?.preset === preset ? saved?.sessionId : null);
    const reuseCtx = reuseId ? slangSessionCtxV2(String(reuseId)) : 0;
    if (reuseCtx > SLANG_SESSION_ROTATE_TOKENS) {
      log(`黑话学习会话上下文约 ${Math.round(reuseCtx / 1000)}k，换个新会话`);
      invalidateSlangLearnerSession();
      saved = null;
    }
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  /** 某个学习会话最后一步的上下文大小（token 账本里按会话 id 找）。 */
  function slangSessionCtxV2(sid) {
    // 学习几小时才跑一次，默认只读末尾 400KB 可能找不到它，读末尾 2MB
    const rows = readTailLinesV2(TOKEN_USAGE_FILE, 2 * 1024 * 1024).filter((r) => r.k === 'turn' && r.sid === sid && r.b);
    const last = rows[rows.length - 1];
    return last ? (Number(last.b.cacheMiss) || 0) + (Number(last.b.cacheHit) || 0) : 0;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: wellFormedContentV2([{ type: 'text', text: promptText }]) });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: wellFormedContentV2([{ type: 'text', text: promptText }]) });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = realNow();
    // 统一按北京时间显示：系统时区是太平洋时间，直接用它会让 AI 拿到错误的时间。
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}（北京时间 UTC+8，这是你醒来那一刻的时间。之后要知道几点，看 QQ 工具返回里的 now，别按等了多久自己去加）`;
    const parts = [timeLine];
    // 2026-10-22 主人：模拟同步主人所在城市的天气（weather.mjs），紧跟在时间后面
    try { const w = homeWeather.text(); if (w) parts.push(w); } catch { /* 天气模块还没就绪就不加 */ }
    // 2026-10-22 她的太阳：跟着主人所在城市真实日出日落变颜色（weather.mjs formatSun）
    try { const s = homeWeather.sunText(now.getTime()); if (s) parts.push(s); } catch { /* 同上 */ }
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 账本时间戳必须走校正后的时间：本机时钟快 3 小时，会让 21:00 之后的用量
    // 全部落到"次日"，按天看额度就错了。
    now: () => realNow().getTime(),
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try { onSessionEventV2(sessionId, event); } catch { /* 启动早期还没初始化（TDZ）或标题/搬家处理出错，都不影响主链路 */ }
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, wakePrefix: opts.wakePrefix });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason, wakePrefix: item.wakePrefix });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        try { applyTitlesForMappedV2(); } catch (error) { log(`[title] 套用标题失败：${error?.message ?? error}`); }
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;

    // ── 群成员名册缓存 ────────────────────────────────────────────────────
    // 拉一次整群成员是重操作（这个群 几百人，往返 1~2 秒），而她翻页时会连着调几次，
    // 所以按群缓存 5 分钟。成员变动不频繁，5 分钟的新鲜度够用。
    const groupMemberListCache = new Map(); // groupId -> { rows, ts }
    const GROUP_MEMBER_LIST_TTL_MS = 5 * 60 * 1000;
    const ROLE_RANK = { owner: 3, admin: 2, member: 1 };

    async function cachedGroupMemberList(groupId) {
      const hit = groupMemberListCache.get(groupId);
      if (hit && Date.now() - hit.ts < GROUP_MEMBER_LIST_TTL_MS && hit.ts > (groupRosterDirtyAtV2.get(String(groupId)) || 0)) return hit.rows;
      const raw = await bot.getGroupMemberList(groupId);
      const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
      const rows = list
        .map((m) => ({
          userId: String(m?.user_id ?? ''),
          nickname: String(m?.nickname ?? ''),
          card: String(m?.card ?? ''),
          role: String(m?.role ?? 'member'),
          level: Number(m?.level ?? 0) || 0,
          sex: String(m?.sex ?? 'unknown'),
          joinTime: Number(m?.join_time ?? 0) || 0,
          lastSentTime: Number(m?.last_sent_time ?? 0) || 0,
          title: String(m?.title ?? ''),
          isRobot: !!m?.is_robot
        }))
        .filter((r) => r.userId);
      groupMemberListCache.set(groupId, { rows, ts: Date.now() });
      return rows;
    }
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    // a = 她递过来的，b = 真的。2026-10-25 搬家后她抄令牌时在末尾多抄了一位（49 位对 48 位），之后每轮都拿抄错的那份，全被拒。
    // 完整的真令牌后面多出一两位也认：要先知道整串真令牌才能过，安全上不降级。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      if (x.length > y.length && x.length <= y.length + 2 && y.length >= 32) return crypto.timingSafeEqual(x.subarray(0, y.length), y);
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 发消息专用：本会话的令牌照旧；另外，给认得的人（config.knownPeople，现在是克劳德姐姐）的私聊发消息，
    // 她任意一个活着的会话的令牌都算数 —— 不用先 qq_go_to 绕一圈（2026-10-24 她两次「令牌对不上」）。只开发送，不开别的状态接口。
    const sendTokenOk = (key, token) => agentTokenOk(key, token)
      || (String(key).startsWith('private:') && !!knownNameV2(String(key).slice(8)) && isLiveAgentToken(token))
      || (String(key).startsWith('group:') && !!cfg.houseGroups?.[String(key).slice(6)] && isLiveAgentToken(token)); // 小房子（2026-10-25）
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    // ── 她们俩的网页（2026-10-29 老大，public/daughters.html；路由和说明在 src/daughters-console.js）──
    // 用同一个 consoleToken（头 x-console-token 或 ?token=）。这里只把「小鲸鱼这边能查什么、能做什么」递给路由模块，
    // 姐姐那边由她自己进程里的小服务（sister/live-server.mjs）回答，路由模块负责代理。
    const consoleTokenOk = (supplied) => {
      const a = Buffer.from(String(supplied ?? ''), 'utf8');
      const b = Buffer.from(consoleToken, 'utf8');
      return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
    };
    const daughtersData = createDaughtersData({
      brains: BRIDGE_BRAINS, stateDir: STATE_DIR, sisterStateDir: path.join(ROOT, 'sister', 'state'),
      skewMs: () => clockSkewMs, douyinStateDir: DOUYIN_STATE_DIR, feiyuMoodFile: MOOD_STATE_FILE, fishMoodPushFile: MOOD_PUSH_FILE, sisterMoodPushFile: moodPushFile(path.join(ROOT, 'sister', 'state'), 'sister'),
      priceTable: resolvePriceTable(cfg.pricing), tokenUsageFile: TOKEN_USAGE_FILE, selfHistoryDir: SELF_NOTE_HISTORY_DIR,
      memoryPort: BRAIN_SERVICE.port
    });
    const ownerKeyForConsole = () => (cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '');
    const fishForConsole = {
      hormonesEnabled: () => hormoneFeed?.enabled === true,
      effort: () => ({ value: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT), options: REASONING_EFFORT_OPTIONS.slice() }),
      online: () => ({ qq: snowlumaHealthSnapshot(), dshReady, mode: currentMode, paused: socialV2.paused }),
      // 各会话的上下文用了多少（老大私聊和群的换会话线不同）
      context: () => {
        const ownerKey = ownerKeyForConsole();
        const groupLimit = Math.max(100000, Number(cfg.socialV2?.groupAutoMove?.ctxTokens) || 250000);
        const keys = [...socialV2.conversations.keys()].filter((k) => state.sessions[k])
          .sort((a, b) => (b === ownerKey ? 1 : 0) - (a === ownerKey ? 1 : 0) || (socialV2.conversations.get(b)?.lastAiReplyAt || 0) - (socialV2.conversations.get(a)?.lastAiReplyAt || 0))
          .slice(0, 6);
        return keys.map((key) => ({ key, label: liveLabelOf(key), tokens: lastContextTokensV2(key), limit: key === ownerKey ? ownerMoveSettingsV2().ctxLimit : groupLimit, compactions: compactionCountV2(state.sessions[key]) }));
      },
      now: () => {
        const t = Date.now();
        const sleeping = sleepState.sleeping && (!sleepState.until || sleepState.until > t);
        const conv = [...socialV2.conversations.entries()].map(([key, st]) => {
          let busy = false;
          let busyReason = '';
          try { busy = isConversationBusyV2(key, st); if (busy) busyReason = busyReasonV2(key, st); } catch { /* 查不到就当不忙 */ }
          return {
            key, label: liveLabelOf(key), busy, busyReason,
            lastAiReplyAt: Number(st.lastAiReplyAt) || 0, lastIncomingAt: Number(st.lastIncomingAt) || 0, unread: Array.isArray(st.unread) ? st.unread.length : 0,
            proactiveDueAt: Number(st.proactiveDueAt) || 0, nextWakeMinutes: Number(st.nextWakeMinutes) || 0, nextWakeNote: String(st.nextWakeNote || '').slice(0, 120),
            pendingWakeReasons: (Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons : []).slice(-6).map((r) => String(r?.reason || '')),
            pendingWake: !!st.pendingWakeTimer
          };
        }).sort((a, b) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0) || Math.max(b.lastAiReplyAt, b.lastIncomingAt) - Math.max(a.lastAiReplyAt, a.lastIncomingAt));
        const wakeNotes = [];
        try {
          const all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8'));
          for (const [k, list] of Object.entries(all || {})) for (const n of Array.isArray(list) ? list : []) wakeNotes.push({ key: k, label: liveLabelOf(k), text: String(n?.text || '').slice(0, 200), at: Number(n?.createdAt) || 0, onlyBootstrap: !!n?.onlyBootstrap });
        } catch { /* 没有留话 */ }
        const ownerConv = conv.find((c) => c.key === ownerKeyForConsole());
        return {
          source: '桥接进程里的实时状态',
          awake: !sleeping,
          sleep: sleeping ? { since: sleepState.since, until: sleepState.until, reason: sleepState.reason, ...(sleepState.natural ? { natural: true } : {}) } : null,
          paused: !!socialV2.paused, mode: currentMode,
          nextOwnerWakeAt: ownerConv?.proactiveDueAt || 0,
          current: conv[0] ? { key: conv[0].key, label: conv[0].label, busy: conv[0].busy, busyReason: conv[0].busyReason } : null,
          sessions: conv.slice(0, 12),
          queued: { wakeNotes: wakeNotes.slice(-10), pendingWakes: conv.filter((c) => c.pendingWake || c.pendingWakeReasons.length).map((c) => ({ key: c.key, label: c.label, reasons: c.pendingWakeReasons, waiting: c.pendingWake })) }
        };
      },
      // 写操作：路由模块已经验过 confirm、字段范围；这里只做她这边真正的动作
      act: async (action, a) => {
        const ownerKey = ownerKeyForConsole();
        const keyOf = () => {
          const key = a.key || ownerKey;
          if (!/^(group|private):\d+$/.test(key || '')) return { error: '会话不对（没有设老大的号，或 key 格式不对）' };
          if (!isSessionAllowedInCurrentMode(key)) return { error: '这个会话现在不在允许范围内，她那边收不到' };
          return { key };
        };
        if (action === 'note') {
          const k = keyOf();
          if (k.error) return { ok: false, error: k.error };
          addWakeNoteV2(k.key, `老大留了一句话给你：${a.text}`);
          log(`老大动手：给 ${k.key} 留了一句话（${a.text.length} 字）`);
          return { ok: true, key: k.key, label: liveLabelOf(k.key), message: '记下了：她下次醒来（或这一轮里下次看消息）会看到' };
        }
        if (action === 'wake') {
          const k = keyOf();
          if (k.error) return { ok: false, error: k.error };
          if (currentMode !== 'reserved2' || socialV2.paused) return { ok: false, error: '现在是暂停或不在二代模式，叫不醒' };
          const was = sleepState.sleeping ? exitSleep('老大叫醒') : false;
          const st = getSocialV2State(k.key);
          if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
          const first = !st.bootstrapSent;
          if (first) st.bootstrapSent = true;
          const reason = first ? 'bootstrap' : was ? 'wokeUp' : k.key === ownerKey ? 'ownerIdle' : k.key.startsWith('group:') ? 'proactiveCheck' : 'admin';
          saveSocialV2State();
          void sendWakePromptV2(k.key, reason).catch((error) => log(`老大动手：叫醒 ${k.key} 异常：${error?.message ?? error}`));
          log(`老大动手：叫醒 ${k.key}（${reason}${was ? '，她本来在睡' : ''}）`);
          return { ok: true, key: k.key, label: liveLabelOf(k.key), wasSleeping: !!was, message: was ? '叫醒了' : '叫她出来看看了' };
        }
        if (action === 'sleep') {
          const r = enterSleep('老大说该睡了', { hours: a.hours });
          log(`老大动手：让她睡 ${a.hours} 小时`);
          return { ok: true, until: sleepState.until, hours: r.hours, capped: r.capped, message: `让她睡了（大约 ${r.hours} 小时）` };
        }
        if (action === 'hormones') {
          const on = hormoneFeed.setEnabled(a.enabled === true, { asleepNow: sleepState.sleeping === true });
          try {
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            file.hormones = { ...(file.hormones ?? {}), enabled: a.enabled === true };
            atomicWriteJson(configFile, file);
            cfg.hormones = { ...(cfg.hormones ?? {}), enabled: a.enabled === true };
          } catch (error) { log(`老大动手：激素开关写进 config.json 失败（这次热切换有效，重启后会回到旧值）：${error?.message ?? error}`); }
          if (on) { try { feedHormoneMood(); } catch { /* 心情还没有就算了 */ } }
          log(`老大动手：激素影子记录${on ? '开' : '关'}`);
          return { ok: true, enabled: on, message: on ? '影子记录开了（只记录，不影响她做事）' : '影子记录关了（已经记下的留着）' };
        }
        if (action === 'effort') {
          let effort;
          try { effort = normalizeReasoningEffort(a.effort); } catch (error) { return { ok: false, error: error?.message ?? '思考强度无效' }; }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          modelSelectionEpoch += 1;
          log(`老大动手：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          return { ok: true, effort, message: `思考强度改成 ${effort}，下一条消息起生效` };
        }
        return { ok: false, error: `不认识的操作：${action}` };
      }
    };
    const daughters = createDaughtersConsole({
      data: daughtersData, live: liveFish, publicDir: path.join(ROOT, 'public'),
      isAuthed: (req, url) => consoleTokenOk(String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '')),
      fish: fishForConsole,
      sister: {
        token: () => consoleToken,
        stateDir: path.join(ROOT, 'sister', 'state'),
        configFile: path.join(ROOT, 'sister', 'config.json')
      },
      memoryPort: BRAIN_SERVICE.port
    });
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      // ⚠ 2026-10-22 主人：她说的北京时间快了 12 分钟。不是时钟错：【当前时间】只在唤醒那一刻给一次，
      // 一轮里刷视频、等消息二十多分钟，她就把"等了多少秒"加起来估时间，等待常常提前返回、她按上限算，越估越快。
      // 现在凡是她（带 x-agent-token）调的接口，返回里都带 now = 校正后的北京时间，她要知道几点就看这个。
      const sendJson = (obj, status = 200) => {
        // 2026-10-24：她在群里的会话想直接给克劳德姐姐发消息，拿群的令牌去发，被拦下只看到「agent token 无效」，
        // 跟老大说成了「令牌对不上」。令牌其实没坏，是会话不对：告诉她这是哪边的令牌、要去别处说话用 qq_go_to。
        if (obj?.error === 'agent token 无效' && req.headers['x-agent-token']) {
          for (const [k, c] of socialV2.conversations.entries()) {
            if (c?.agentToken && tokenEq(req.headers['x-agent-token'], c.agentToken)) {
              obj = { ...obj, error: `这是「${sessionTitleForV2(k) || sharedKeyLabelV2(k)}」那边的会话令牌，只能在那边用。想去别的会话说话，用 qq_go_to 把要说的带过去，那边的你醒来就会接着说。` };
              break;
            }
          }
        }
        if (req.headers['x-agent-token'] && obj && typeof obj === 'object' && !Array.isArray(obj) && !('now' in obj)) {
          obj = { now: `${realNow().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}（北京时间，现在）`, ...obj };
        }
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, (k, v) => wellFormedV2(v), 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        if (isDaughtersPath(url.pathname)) {
          // 她们俩的网页（2026-10-29 老大）：没令牌一律 403。页面本身给一张能输令牌的小页（填过的令牌在 localStorage 里会自动带上）
          if (req.method === 'GET' && isDaughtersPage(url.pathname)) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
            res.end(`<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>let t=new URLSearchParams(location.search).has('token')?'':localStorage.getItem('consoleToken');if(!t)t=prompt('请输入访问令牌');if(t){t=t.trim();localStorage.setItem('consoleToken',t);location.href=${JSON.stringify(url.pathname)}+'?token='+encodeURIComponent(t);}</script>`);
          } else {
            sendJson({ ok: false, error: '未授权：请提供访问令牌' }, 403);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型
      // 本来就**没有**会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message
      // / qq_list_groups 等工具必须在这个模式里可用（工具描述写的也是"closed-agent 模式不需要"）。
      // 这些端点各自按模式判定（/api/send/* 只在 closed-agent 放行；/api/images/* 在 reserved2
      // 强制要令牌；/api/status 对智能体调用只回最小对象），所以这里把「无令牌智能体调用」
      // 限制到这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放——那里的 token 校验全是
      // `if (x-agent-token && …)`，放进来就等于退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          noteFishHealthEvent('token', '', `令牌被拒：${url.pathname}`);
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
        // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt', '/api/socialV2/repair-move'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // 只读降级：黑话库/表情库在启动时加载失败时，写接口必须**明确失败**。
        // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
        // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
        if (req.method !== 'GET') {
          const readonlyStore = (!slangStoreWritable && (url.pathname === '/api/slang'
            || url.pathname === '/api/slang/clear'
            || url.pathname === '/api/slang/extract'
            || url.pathname === '/api/slang/research'
            || url.pathname.startsWith('/api/slang/batch-')
            || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
            : (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/note'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-note'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
              : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        // 她们俩的网页（页面、vendor、/api/daughters/*、/api/live/*、/api/brain/*）：令牌已验过，交给 src/daughters-console.js
        if (await daughters.handle({ req, res, url, sendJson, readBody, headers: SECURITY_HEADERS })) return;
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang, writable: slangStoreWritable });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自后台，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'minQuietAfterNewGroupMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(60, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 30, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 14000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              turnLeaseNoted.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: selfDisplayName || null,
              userId: selfUserId || null,
              line: selfIdentityTextV2().trim() || null,
              groupRole: selfGroupRoleTextV2(key).trim() || null,
              weather: (() => { try { return homeWeather.text() || null; } catch { return null; } })()
            },
            // 角色卡之后接她自己写的那一页（self.md）：读起来是"最新的那句话"。
            role: { name: roleState.role ?? null, hint: `${currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint()}\n\n${selfNote.promptBlock()}`, self: selfNote.read().text },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st, key),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 60) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq, ...(req.headers['x-agent-token'] ? midTurnNotesV2(key) : {}) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 2026-10-29 老大：「这个东西应该是做提醒而不是做限制」。原来这里会拦住「聊两句就回潜水」，要她先等满 5 分钟观察；
          // 现在一律直接成功，刚还有人在说话就在返回里提醒一句（见 preSleepReminderV2），等不等她自己定。
          const preSleepHint = isSleepingConfigV2(st.wakeConfig) ? preSleepReminderV2(st, '好，回去潜着了。') : '';
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig, ...(preSleepHint ? { hint: preSleepHint } : {}) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              pokeOthers: normalizeTriggerBool('pokeOthers', current.triggers.pokeOthers === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 2026-10-29 老大：「这个东西应该是做提醒而不是做限制」。原来这里不让她聊两句就设潜水（M12 只放过了「只收窄」的改动）；
          // 现在一律直接成功。刚还有人在说话、又不是只收窄，就在返回里提醒一句，等不等她自己定。
          const preSleepHint = isSleepingConfigV2(next) && !isNarrowingWakeConfigV2(current, next) ? preSleepReminderV2(st, '好，设好了。') : '';
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮「等过一会儿」的记录作废，下次收尾再看要不要提醒。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next), ...(preSleepHint ? { hint: preSleepHint } : {}) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        // 控制台：报事故给妈妈（姐姐的程序用；2026-10-25 主人：妹妹 / 姐姐消息发不出去，报给妈妈直接修）。
        if (req.method === 'POST' && url.pathname === '/api/mom/incident') {
          const body = await readBody();
          try { sendJson(momMailbox.writeIncident({ text: String(body.text ?? ''), fromLabel: String(body.from ?? '克劳德姐姐').slice(0, 20) })); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 200); }
          return;
        }
        // 2026-10-29 老大（姐姐整改，对等）：姐姐也能给妈妈写信（qq_mom_mailbox，sister/qq-mcp.mjs）和看自己的信 / 回信。
        // 走桥接这条路是因为看信、回信的 Claude 在桥接里排队；信上的 key 固定是 'sister'，回信由姐姐的程序自己读信箱带给她（见 mom-mailbox.js 的 wakeNote）。
        if (req.method === 'POST' && url.pathname === '/api/mom/letter') {
          const body = await readBody();
          try { sendJson(momMailbox.writeLetter({ key: 'sister', fromLabel: '姐姐', text: body.letter })); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 400); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/mom/letters') {
          sendJson(momMailbox.listLetters({ key: 'sister' }));
          return;
        }
        // 控制台：会话坏了（比如历史里有 DeepSeek 拒收的内容，每轮都 400）就直接搬新家，不走她自己登记的那些条件。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/repair-move') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key) || !state.sessions[key]) { sendJson({ ok: false, error: '没有这个会话' }, 400); return; }
          const letter = String(body.letter ?? '').trim() || '（妈妈帮你搬的家：旧会话坏了，你没做错什么。最近的聊天原文在下面。）';
          pendingMoves.set(key, { letter, at: Date.now(), ownerAsked: true, ctx: lastContextTokensV2(key), comps: compactionCountV2(state.sessions[key]) });
          log(`[move-house] 控制台让 ${key} 搬新家（修坏掉的会话）`);
          void executeMoveHouseV2(key);
          sendJson({ ok: true, key });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
          // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
          // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
          const firstWake = !st.bootstrapSent;
          if (firstWake) st.bootstrapSent = true;
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return;
        }
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
        if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) {
              const entries = [...initialPrompts.entries()]
                .map(([entryKey, entry]) => ({
                  key: entryKey,
                  chars: entry.text.length,
                  createdAt: entry.createdAt || 0,
                  updatedAt: entry.updatedAt || 0,
                  preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
              return;
            }
            const canonical = canonicalV2Key(key);
            if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const entry = initialPrompts.get(canonical) ?? null;
            sendJson({
              ok: true,
              key: canonical,
              exists: !!entry,
              text: entry?.text ?? '',
              createdAt: entry?.createdAt || 0,
              updatedAt: entry?.updatedAt || 0,
              maxChars: initialPromptMaxChars(),
              writable: initialPromptsWritable
            });
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const explicitDelete = body.delete === true;
          // 只接受 { key, text: string } 或 { key, delete: true }：
          // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
          if (!explicitDelete && typeof body.text !== 'string') {
            sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
            return;
          }
          const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
          if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
          log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
          sendJson({
            ok: true,
            key: result.key,
            deleted: result.deleted,
            chars: result.chars,
            exists: !!result.entry,
            updatedAt: result.entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !sendTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfgForKeyV2(key, sendCfg));
            const seqAtSend = st.lastUnreadSeq || 0; // 同 send-message：她按发送那刻的水位，等待和回执都从这里算"秒回"
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            if (sentMessages.length > 0) st.lastSendSeq = seqAtSend;
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 2026-10-22 主人：跟他说话不用压着，可以多说几条 —— 主人私聊不再提示"连发太多"。
            const burstHint = messages.length >= 3 && key !== `private:${cfg.ownerQQ}` ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            // 群里秒回的（她按发送之后进来、还没看过的）直接递给她，跟 send-message 一样（2026-10-23）
            const after = Math.max(readThroughSeqV2(st), seqAtSend);
            const fastReplies = key.startsWith('group:') ? (st.unread || []).filter((m) => m && !m.isSelf && (m.seq || 0) > after).slice(-5) : [];
            if (fastReplies.length) noteModelMessagesV2(st, fastReplies);
            const fastNote = fastReplies.length ? { newWhileTyping: fastReplies.map((m) => ({ seq: m.seq, messageId: m.messageId, sender: m.sender, quoteTargetIsSelf: m.quoteTargetIsSelf, text: String(m.text || '').slice(0, 300) })), newWhileTypingHint: `你发消息的时候群里又来了 ${fastReplies.length} 条（见 newWhileTyping），有人在接你的话就接着聊。` } : {};
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}), ...fastNote });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !sendTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && hasAtUserIds(atUserId)) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfgForKeyV2(key, sendCfg));
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          // 她按下发送那一刻的消息水位：这之后进来的都可能是在接她的话（见下面 newWhileTyping 和 wait 的 baseline）
          const seqAtSend = st.lastUnreadSeq || 0;
          try {
            // 对方插话就先停（2026-10-26 主人嫌上下错位）：私聊和小房子里，发第二条起每条之前看一眼，她按发送之后对方又说了新的，剩下的先压着。
            const canHold = key.startsWith('private:') || !!cfg.houseGroups?.[String(key).slice(6)];
            const interrupted = () => canHold && (st.unread || []).some((m) => m && !m.isSelf && (m.seq || 0) > seqAtSend);
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId, interrupted);
            const heldMessages = sentMessages.held || [];
            if (heldMessages.length) log(`[reserved2] ${key} 发到一半对方又说了话，后面 ${heldMessages.length} 条先没发`);
            recordSentMessagesV2(key, sentMessages);
            if (sentMessages.length > 0) st.lastSendSeq = seqAtSend;
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 2026-10-22：她打字期间对方又发来的、她还没看过的消息，直接在回执里递给她，别等到下一轮才发现。
            // 2026-10-23 主人：群里别人回得快，她收不到——她发出去到下一次调工具之间秒回的那几条，以前只有私聊会递，群里也递。
            // 群里只递"她按发送之后才进来"的（别把她发言前的旧聊天也塞过来）。
            let unseen = [];
            const isGroup = key.startsWith('group:');
            if (key.startsWith('private:') || isGroup) {
              const through = readThroughSeqV2(st);
              const after = isGroup ? Math.max(through, seqAtSend) : through;
              unseen = (st.unread || []).filter((m) => m && !m.isSelf && (m.seq || 0) > after).slice(-5);
            }
            const typingHint = isGroup
              ? `你发消息的时候群里又来了 ${unseen.length} 条（见 newWhileTyping），有人在接你的话就接着聊。`
              : `你打字的时候他又发了 ${unseen.length} 条（见 newWhileTyping），接着回这几条，别只回了前面那条就收尾。`;
            const unseenNote = unseen.length ? { newWhileTyping: unseen.map((m) => ({ seq: m.seq, messageId: m.messageId, ...(isGroup ? { sender: m.sender, quoteTargetIsSelf: m.quoteTargetIsSelf } : {}), text: String(m.text || '').slice(0, 300) })), newWhileTypingHint: typingHint } : {};
            if (unseen.length) noteModelMessagesV2(st, unseen);
            // 2026-10-22 主人：跟他说话不用压着，可以多说几条 —— 主人私聊不再提示"连发太多"。
            const burstHint = messages.length >= 3 && key !== `private:${cfg.ownerQQ}` ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            // 2026-10-22 主人：希望她更勤快地用表情包。
            st.textSinceStickerV2 = (st.textSinceStickerV2 || 0) + sentMessages.length;
            const stickerThreshold = key === `private:${cfg.ownerQQ}` ? 4 : 6;
            let stickerHint;
            if (cfg.socialV2?.sticker?.enabled !== false && st.textSinceStickerV2 >= stickerThreshold && st.textSinceStickerV2 - (st.stickerNudgedAtV2 || 0) >= 4) {
              st.stickerNudgedAtV2 = st.textSinceStickerV2;
              // 2026-10-23 第二轮：只给数字，不给"该发一张了"的指令 —— 发不发她自己定。
              stickerHint = `你已经连着 ${st.textSinceStickerV2} 句纯文字没发表情了。`;
            }
            const heldNote = heldMessages.length ? { held: heldMessages, heldHint: `发到一半${isGroup ? '有人' : '他'}又说了新的（见 newWhileTyping），后面这 ${heldMessages.length} 条先没发：看完新消息再决定还发不发、怎么接，别照原样补上。` } : {};
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length - heldMessages.length, delays, quoted: quotedInfo, ...heldNote, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}), ...(stickerHint ? { stickerHint } : {}), ...unseenNote });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (shouldBlockSilentReply(key)) {
              const blocked = new Error('静默模式已开启，当前不允许拍一拍');
              blocked.statusCode = 403;
              throw blocked;
            }
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        // 大肥鱼表情包：按心情 / 场景搜（只读）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/fish-stickers') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const catalog = fishCatalogV2();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const pack = String(url.searchParams.get('pack') ?? '').trim();
          const found = searchFish(catalog, query, { limit: Number(url.searchParams.get('limit')) || 12, pack });
          sendJson({
            ok: true,
            total: catalog.stickers.length,
            query,
            stickers: found.map((s) => describeFish(s)),
            hint: found.length
              ? '挑中了就用 qq_send_sticker 发，stickerId 写「鱼:名字」；同名的写编号，比如「鱼:10N01」。'
              : `没搜到。换个说法试试，比如情绪：${(catalog.emotions || ['开心', '疑惑', '无语', '害羞', '得意', '难过', '生气', '疲惫']).slice(0, 12).join('、')}`
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const galleryDir = WHALE_BRAIN.gallery;
          const listGallery = () => {
            try {
              return fs.readdirSync(galleryDir).filter((f) => /\.png$/i.test(f)).map((f) => f.replace(/\.png$/i, '')).sort();
            } catch {
              return [];
            }
          };
          const nameParam = String(url.searchParams.get('name') ?? '').trim();
          let selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          let usedName = 'default';
          if (nameParam) {
            // 只允许安全字符，杜绝 ../ 之类的目录穿越
            if (!/^[A-Za-z0-9_-]{1,40}$/.test(nameParam)) {
              sendJson({ ok: false, error: 'name 不合法（只允许字母、数字、下划线、连字符）' }, 400);
              return;
            }
            const cand = path.join(galleryDir, nameParam + '.png');
            if (!fs.existsSync(cand)) {
              const avail = listGallery();
              sendJson({ ok: false, error: `没有名为 ${nameParam} 的形象${avail.length ? `（可用：${avail.join('、')}）` : '（资产库目录为空）'}` }, 404);
              return;
            }
            selfPath = cand;
            usedName = nameParam;
          }
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, name: usedName, available: listGallery(), image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !sendTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && hasAtUserIds(atUserId)) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            noteSentV2(key, text); // 2026-10-29 第五批：激素影子记录 + 聊天记录
            hormoneRecord({ type: 'sticker_sent' });
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            st.textSinceStickerV2 = 0;
            st.stickerNudgedAtV2 = 0;
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 从任意图片源加入收藏表情：她网上找到的图、或她自己刚发的图。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/add-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const imageUrl = String(body.url ?? '').trim();
          const imageBase64 = String(body.base64 ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!imageUrl && !imageBase64) { sendJson({ ok: false, error: '需要提供 url 或 base64 之一' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_add_sticker' }, 403); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再来' }, 429);
            return;
          }
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await addStickerV2(key, { url: imageUrl || undefined, base64: imageBase64 || undefined }, remark);
            saveSocialV2State();
            log(`[sticker] AI 新增表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 新增收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark, bytes: result.bytes });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            saveSocialV2State();
            log(`[sticker] AI 新增表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `保存表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 发 QQ 空间说说。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone-post') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const content = String(body.content ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发表说说必须携带 agent token' }, 403); return; }
          try {
            const out = await publishQzoneV2(key, {
              content,
              images: Array.isArray(body.images) ? body.images : undefined,
              ugcRight: body.ugcRight ?? body.ugc_right,
              targetUins: Array.isArray(body.targetUins) ? body.targetUins : undefined
            });
            sendJson({ ok: true, key, result: out });
          } catch (error) {
            sendJson({ ok: false, error: `发表说说失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 读 QQ 空间：自己的说说列表 / 好友动态。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/qzone-list') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const mode = String(url.searchParams.get('mode') ?? 'mine').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式读取空间必须携带 agent token' }, 403); return; }
          try {
            const data = await readQzoneV2(mode === 'feeds' ? 'feeds' : 'mine', {
              targetUin: url.searchParams.get('targetUin') || undefined,
              pos: url.searchParams.get('pos'),
              page: url.searchParams.get('page'),
              num: url.searchParams.get('num')
            });
            sendJson({ ok: true, key, mode, data });
          } catch (error) {
            sendJson({ ok: false, error: `读取空间失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 读一条说说的评论。tid 来自 qzone-list 的 tid。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/qzone-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const tid = String(url.searchParams.get('tid') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!tid) { sendJson({ ok: false, error: 'tid 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式读取空间必须携带 agent token' }, 403); return; }
          try {
            const data = await readQzoneDetailV2(tid, {
              targetUin: url.searchParams.get('targetUin') || undefined,
              pos: url.searchParams.get('pos'),
              num: url.searchParams.get('num')
            });
            sendJson({ ok: true, key, data });
          } catch (error) {
            sendJson({ ok: false, error: `读取评论失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 评论一条说说（自己的或别人的）。受每日评论额度约束。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone-comment') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发表评论必须携带 agent token' }, 403); return; }
          try {
            const data = await commentQzoneV2(key, body.tid, body.content, {
              targetUin: body.targetUin,
              images: body.images
            });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `发表评论失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 点赞 / 取消赞一条说说。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone-like') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式点赞必须携带 agent token' }, 403); return; }
          try {
            const data = await likeQzoneV2(key, body.tid, body.like !== false, {
              targetUin: body.targetUin,
              abstime: body.abstime
            });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `点赞失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 睡觉 / 起床（账号级：睡着之后群里谁说话都不叫醒她）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/move-house') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { sendJson(requestMoveHouseV2(key, body.letter, { ownerAsked: body.ownerAsked === true })); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 200); }
          return;
        }
        // 2026-10-23 主人要求「让她自己决定」：她自己定这个会话下一次主动醒来隔多久（qq_next_wake）。
        // 印象（qq_impression）：记一笔 / 看一个人。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/impression') {
          const body = await readBody();
          if (!req.headers['x-agent-token'] || !isLiveAgentToken(req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try {
            const uid = String(body.userId ?? '').trim();
            if (body.action === 'read') {
              const im = fishImpressions.get(uid);
              sendJson({ ok: true, text: im ? fishImpressions.block([uid], { title: '' }).trim() || `${uid}：一般` : `你对 ${uid} 还没有印象` });
            } else {
              const r = fishImpressions.update(uid, { delta: body.delta ?? null, score: body.score ?? null, note: String(body.note || ''), name: String(body.name || '') });
              log(`[impression] ${uid}${r.name ? `（${r.name}）` : ''} → ${r.level}${body.note ? `：${String(body.note).slice(0, 40)}` : ''}`);
              sendJson({ ok: true, text: `记下了：${r.name || uid} 现在是「${r.level}」${r.score <= -3 ? '（以后他在群里叫你不会叫醒你，除非像在道歉）' : ''}` });
            }
          } catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 200); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/next-wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(?:group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { sendJson(setNextWakeV2(key, body.minutes, body.note)); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 200); }
          return;
        }
        // 她自己写的那一页（self.md）：read / write / append（qq_self）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(?:group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try {
            const action = String(body.action ?? 'read').trim();
            if (action === 'read') { sendJson({ ...selfNote.read(), history: selfNote.history().length }); return; }
            if (action === 'write') {
              if (typeof body.text !== 'string') { sendJson({ ok: false, error: 'write 要带 text：整页的新内容（可以是空字符串，那就是清空）。' }, 400); return; }
              sendJson(selfNote.write(body.text)); return;
            }
            if (action === 'append') { sendJson(selfNote.append(body.text)); return; }
            sendJson({ ok: false, error: 'action 只有 read / write / append' }, 400);
          } catch (error) { sendJson({ ok: false, error: `self.md 读写失败：${error?.message ?? error}` }, 500); }
          return;
        }
        // 便签（qq_note）：read / write / append。任何会话都能写（她只有一个脑子），所有会话的唤醒都带（2026-10-29 记忆统一）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/note') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(?:group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try {
            const action = String(body.action ?? 'read').trim();
            if (action === 'read') { sendJson({ ...stickyNote.read(), history: stickyNote.history().length }); return; }
            if (action === 'write') {
              if (typeof body.text !== 'string') { sendJson({ ok: false, error: 'write 要带 text：便签的新全文（空字符串就是清空）。' }, 400); return; }
              sendJson(stickyNote.write(body.text)); return;
            }
            if (action === 'append') { sendJson(stickyNote.append(body.text)); return; }
            sendJson({ ok: false, error: 'action 只有 read / write / append' }, 400);
          } catch (error) { sendJson({ ok: false, error: `便签读写失败：${error?.message ?? error}` }, 500); }
          return;
        }
        // qq_go_to（2026-10-23 第二轮）：她把一件事从这个会话带到另一个会话（主人私聊里听到「去群里找某某玩」→ 群那边的她醒来时带着这句）。
        // 每个会话各有令牌，这边的她动不了那边；这里替她把话留到那边的唤醒附言里，然后把那边叫醒（睡着时只留话不叫）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/go-to') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(?:group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try {
            const items = goToCandidatesV2();
            if (String(body.target ?? '').trim() === 'list') {
              sendJson({ ok: true, key, items: items.filter((it) => it.key !== key), text: goToListText(items, { currentKey: key }) });
              return;
            }
            const plan = planGoTo({
              key, target: body.target, note: body.note,
              allowedKeys: items.map((it) => it.key),
              fromLabel: momLetterFromLabelV2(key),
              targetLabel: sessionTitleForV2(String(body.target ?? '').trim())
            });
            addWakeNoteV2(plan.target, plan.noteText, { onlyBootstrap: false });
            getSocialV2State(plan.target).selfHandoffText = plan.wakeText;
            const queuedOnly = sleepState.sleeping;
            if (!queuedOnly) void sendWakePromptV2(plan.target, 'selfHandoff').catch((error) => log(`[go-to] 叫 ${plan.target} 失败：${error?.message ?? error}`));
            log(`[go-to] ${key} → ${plan.target}：${queuedOnly ? '睡着，只留话' : '留话并叫醒'}（${plan.note.length} 字）`);
            const tTitle = sessionTitleForV2(plan.target);
            sendJson({
              ok: true, key, target: plan.target, title: tTitle || null, queuedOnly,
              text: queuedOnly
                ? `话留在 ${tTitle || plan.target} 那边了。你在睡觉，那边不会现在醒；等那边下次醒来会看到。`
                : `话留在 ${tTitle || plan.target} 那边了，那边的你马上会醒来看到它（那边正忙的话，这一轮结束就看到）。`
            });
          } catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 200); }
          return;
        }
        // 「看看我自己」(self_view)：只读。身体和心情用话说，记忆概况，脑子装了多满，出错的工具，翻自己的脑子目录（src/self-view.js）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-view') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { const v = selfViewV2(key, String(body.path ?? '')); sendJson({ ok: true, found: v.ok, text: v.text, mode: v.mode }); } catch (error) { sendJson({ ok: false, error: `看自己没成：${error?.message ?? error}` }, 500); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-check') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { sendJson({ ok: true, ...selfCheckV2(key) }); } catch (error) { sendJson({ ok: false, error: `自检失败：${error?.message ?? error}` }, 500); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sleep') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式睡眠开关必须携带 agent token' }, 403); return; }
          try {
            const action = String(body.action ?? 'sleep').trim();
            if (action === 'wake') {
              const was = exitSleep(`手动起床（${key}）`);
              sendJson({ ok: true, key, sleeping: false, wasSleeping: was });
            } else {
              // 2026-10-23 第二轮，主人：「让她自己定」—— 白天也能睡、睡到几点她定（until / hours），
              // 原来"白天只有主人让你睡才能睡"的闸拆掉了。只剩 enterSleep 里 14 小时的防故障上限。
              const bjHour = (realNow().getUTCHours() + 8) % 24;
              const isNightHere = bjHour >= 22 || bjHour < 8;
              // 2026-10-22 主人要求过睡前先写日记（原来这里会挡一次）；2026-10-24 主人改成「所有事情都让她自己决定」，
              // 所以不再挡：照常睡下，只在当晚还没提过时附一句事实，写不写由她定（工具返回后她这一轮还能接着写）。
              let diaryNote = '';
              if (isNightHere) {
                const nightOf = new Date(realNow().getTime() + 8 * 3600e3 - 5 * 3600e3).toISOString().slice(0, 10);
                if (bedtimeDiaryAskedFor !== nightOf) {
                  bedtimeDiaryAskedFor = nightOf;
                  try { atomicWriteJson(BEDTIME_DIARY_FILE, { nightOf }); } catch { /* 记不下最多多提一次 */ }
                  diaryNote = '睡下了。顺带一句：今天的碎碎念（rambling_append）和 remember 会跟着你到明天，换了会话也在；想写就趁现在写，不写也行。';
                }
              }
              const r = enterSleep(body.reason, { hours: body.hours, until: body.until, natural: body.natural === true });
              // 2026-10-29 大脑方案下半（第 5 项）：睡前整理建议——本子里重复的、过期的约定、互相矛盾的，只列出来给她看，留不留、改不改她定。
              let tidyText = '';
              try { const t = await brainTidy({ brain: 'whale', timeoutMs: 4000 }); tidyText = t?.text || ''; } catch { tidyText = ''; }
              sendJson({ ok: true, key, sleeping: true, natural: sleepState.natural === true, reason: String(body.reason || ''), until: sleepState.until, untilText: sleepState.natural ? '自然醒' : new Date(r.untilRealMs).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), hours: r.hours, capped: r.capped, maxHours: SLEEP_MAX_HOURS, ...(diaryNote ? { note: diaryNote } : {}), ...(tidyText ? { tidy: tidyText } : {}) });
            }
          } catch (error) {
            sendJson({ ok: false, error: `睡眠开关失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 查询当前睡眠状态。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sleep') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const sinceText = sleepState.since
            ? new Date(sleepState.since).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
            : '';
          sendJson({ ok: true, key, sleeping: sleepState.sleeping, since: sleepState.since, sinceText, reason: sleepState.reason, until: sleepState.until });
          return;
        }
        // 看她现在的 QQ 头像（拉 CDN 图片，直接给视觉）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/avatar') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式看头像必须携带 agent token' }, 403); return; }
          try {
            const data = await readAvatarImageV2({ size: url.searchParams.get('size') });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `读取头像失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 读自己的 QQ 资料（QQ 号 + 昵称）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/profile') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式读资料必须携带 agent token' }, 403); return; }
          try {
            sendJson({ ok: true, key, data: await readProfileV2() });
          } catch (error) {
            sendJson({ ok: false, error: `读取资料失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 改昵称 / 个性签名 / 性别。昵称有每日 1 次额度。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/profile') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式改资料必须携带 agent token' }, 403); return; }
          try {
            const data = await updateProfileV2(key, {
              nickname: body.nickname,
              personalNote: body.personalNote,
              sex: body.sex
            });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `改资料失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 改个性签名（longNick）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/signature') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式改签名必须携带 agent token' }, 403); return; }
          try {
            const data = await setLongNickV2(key, body.longNick);
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `改签名失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 换头像。每日 1 次。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/avatar') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式换头像必须携带 agent token' }, 403); return; }
          try {
            const data = await setAvatarV2(key, body.source, { selfName: body.selfName });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `换头像失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 在线状态 / 自定义状态。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/status') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式改状态必须携带 agent token' }, 403); return; }
          try {
            const data = await setStatusV2(key, {
              status: body.status,
              extStatus: body.extStatus,
              battery: body.battery,
              wording: body.wording,
              faceId: body.faceId
            });
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `改状态失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 改自己在某群里的群名片。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-card') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式改群名片必须携带 agent token' }, 403); return; }
          try {
            const gid = body.groupId ?? (key.startsWith('group:') ? key.slice(6) : 0);
            const data = await setGroupCardV2(key, gid, body.card);
            sendJson({ ok: true, key, ...data });
          } catch (error) {
            sendJson({ ok: false, error: `改群名片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalV2Key(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = minQuietAfterNewMsV2(key);
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          // ⚠ 2026-10-22 主人反映：他连着发两条，她有时只回第一条。
          // 原因：她读完第一条、还在打字时第二条到了；发完回复后的普通等待（purpose=messages）是从"发请求那一刻"
          // 开始数新消息的，第二条早于这一刻，于是不算"新来的"——她干等 5 分钟，回合结束后才被补叫醒去回。
          // 私聊里改成从她实际看过的最后一条算起：没给她看过的消息立刻交给她。群里保持原样（群里未读多，
          // 按"看过的"算会让每次等待都立刻返回一堆旧消息）。
          const unseenBaseline = (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          // ⚠ 2026-10-23 主人：她在群里说完话，别人秒回她就收不到——那条回复落在"她发话"和"她调等待"之间，比 requestSeq 早，
          // 不算新来的，她干等到超时。群里折中：她 10 分钟内发过言的话，从她按发送那一刻算起、她没看过的都交给她；
          // 她发言之前的旧聊天照旧不塞（那是原来担心的"一堆旧消息"）。
          const sentRecently = key.startsWith('group:') && Number.isSafeInteger(st.lastSendSeq) && Date.now() - (st.lastAiReplyAt || 0) < 10 * 60 * 1000;
          const groupBaseline = sentRecently ? Math.min(requestSeq, Math.max(unseenBaseline, st.lastSendSeq)) : requestSeq;
          const baseline = replyWait ? unseenBaseline : (key.startsWith('private:') ? Math.min(requestSeq, unseenBaseline) : groupBaseline);
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          let cappedReason = null; // 'mentioned' | 'busy'：没等到安静就提前交给她（见下）
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            // ⚠ 2026-10-22 主人：群里消息一多她就回得很慢、像宕机。热闹的群里"等对方说完"永远等不到安静，
            // 每来一条就重新计时。群里最多等 8 秒就把消息交给她，有人 @ 她时 2.5 秒。
            const replyCapMs = key.startsWith('group:') ? 8000 : Infinity;
            while (!aborted && Date.now() - start < timeoutMs) {
              if (ownerDmPendingV2(key)) break; // 主人在抖音私信找她：提前返回
              if (pendingMoves.has(key)) break; // 已登记搬家：别再等了，这一轮收尾才会搬（2026-10-22）
              if (Date.now() - start >= replyCapMs) { cappedReason = 'busy'; break; }
              if ((st.lastDirectedSeq || 0) > baseline && Date.now() - start >= 2500) { cappedReason = 'mentioned'; break; }
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            if (ownerDmPendingV2(key)) break; // 主人在抖音私信找她：提前返回（见 ownerDmPendingV2）
            // 已登记搬家：搬家要等这一轮结束才执行，她要是一直循环等消息就永远搬不成（2026-10-22 主人私聊卡过一次）
            if (pendingMoves.has(key)) break;
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              // ⚠ 2026-10-22：以前要等到"最后一条之后安静满 quietMs"才返回，热闹的群里每来一条都重置，
              // 实测她每次要等 15~79 秒才看到消息。现在封顶：群 8 秒、私聊 20 秒；有人 @/引用/点名/提问她时 2.5 秒。
              const firstArrivalAt = Date.now();
              // 2026-10-22 主人：token 开销大，大头是群聊——热闹时她几乎每 8 秒就醒来看一次，每次都带着 20 万上下文。
              // 不是找她的消息改成攒 30 秒一批（cfg.socialV2.wake.groupBusySettleMs 可调）；有人找她仍 2.5 秒。
              const settleCapMs = key.startsWith('group:') ? Math.max(5000, Number(cfg.socialV2?.wake?.groupBusySettleMs) || 30000) : 20000;
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                if ((st.lastDirectedSeq || 0) > baseline && Date.now() - firstArrivalAt >= 2500) { cappedReason = 'mentioned'; break; }
                if (Date.now() - firstArrivalAt >= settleCapMs) { cappedReason = 'busy'; break; }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 2026-10-29 老大：收尾不再拦她。下面这些「等过 / 看过」的记录只用来决定 mark_read / set_wake_config 成功时要不要附提醒。
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            ...(req.headers['x-agent-token'] ? midTurnNotesV2(key) : {}),
            ...(pendingMoves.has(key) ? { moveHousePending: true, moveHouseHint: '你已经登记了搬家：这一轮收尾之后就搬。新会话里会有你的信、便签、本子和最近的聊天。' } : {}),
            // 2026-10-23 第二轮：这两句只说"发生了什么"，不说"先回他"—— 回不回、回哪条她自己定。
            ...(cappedReason ? { settledEarly: cappedReason, settledEarlyHint: cappedReason === 'mentioned' ? '有人在找你（@/引用/点名/提问），所以没等群里安静就把消息给你了。' : '群里还在热闹，没等安静就先把消息给你了。' } : {}),
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length,
            ...takeOwnerDmsForWaitV2(key)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          // ⚠ 本机补丁（2026-10-21）：合并转发读取的瞬时断连重试。
          //
          // 小鲸鱼连着两次读同一条转发都只拿到「Connection closed」，一句有用的都没有。
          // 这个报错来自底层 HTTP 客户端：它复用了一条其实已经被服务端关掉的 keep-alive
          // 连接，于是写出去就断。换一条新连接重发通常立刻成功 —— 属于抖动，不是内容问题。
          // 以前直接 throw 到外层，AI 只能看到「Connection closed」，完全无从判断。
          const callForward = async (fid, tries = 3) => {
            let lastError;
            for (let attempt = 0; attempt < tries; attempt += 1) {
              try {
                return await bot.raw('get_forward_msg', { id: fid });
              } catch (error) {
                lastError = error;
                const message = String(error?.message ?? error);
                if (!/Connection closed|socket hang up|ECONNRESET|EPIPE|other side closed|fetch failed/i.test(message)) throw error;
                log(`合并转发读取瞬时断连，重试 ${attempt + 1}/${tries} ${fid}: ${message}`);
                await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
              }
            }
            throw lastError;
          };
          log(`合并转发查询开始 ${key} ${id}`);
          try {
            // ⚠ 本机补丁（2026-10-21）：必须给拉取加超时。
            //
            // 原来这里是 `await bot.raw(...)` 裸等：SnowLuma 那边 get_forward_msg
            // 不返回时，这个 HTTP handler 就一直挂着，既不写日志也不回包。
            // 上游 DSH 的工具调用等不及，先把 MCP 连接关掉 —— 于是 AI 只看到
            // 「Connection closed」三个字，而 bridge.log 里**一条记录都没有**
            // （因为 log 写在拿到数据之后，永远走不到）。
            // 结果就是：真正卡住的地方完全不可见，排查全靠猜。
            // 现在：25 秒拿不到就失败，回一个说得清的错误；入口也先记一笔，
            // 这样「请求到底有没有到 bridge」这个问题再也不用猜。
            const data = await withTimeout(callForward(id), 25000, '合并转发查询');
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await withTimeout(callForward(fid), 10000, '嵌套转发预览');
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        // ── 群成员名册（v2） ─────────────────────────────────────────────────
        // 旧的 qq_get_group_members 是 legacy 通道，reserved2 模式下被
        // legacyReadToolAllowed 直接拒掉 —— 她在群里正是这个模式，所以
        // 「这个群都有谁」她一直读不到：不是不会用，是门没给她开。
        //
        // 而且这个群 几百人，一次性全返回约 7 万字符，等于把上下文一次吃光。
        // 所以这里做分页 + 排序 + 搜索，并给出头像地址（qlogo CDN 按 QQ 号就能拼，
        // 不占什么字符，她想看谁再拿去看）。成员列表按群缓存 5 分钟，翻页不重复拉。
        // ── 群管理：禁言 / 解禁 / 踢人（2026-10-22 主人要求） ─────────────────────
        // 规则由桥接硬校验，不靠她自觉：
        //   · 只执行主人（ownerQQ）或本群群主的明确要求。她必须给出那条要求消息（requestMessageId），
        //     桥接核对：发送者是主人或群主（群主现查，不用缓存）、15 分钟内、对方自己说的话里有对应动作、
        //     消息里点到了目标（@ / 引用 / 名字 / QQ 号）。她自己起意时拿不出这样的消息，过不了。
        //   · 一条要求最多执行 3 次；不能动她自己、群主、管理员；主人只有主人自己说了才能动。
        //   · 每次执行/拒绝都记 state/group-manage.jsonl。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-manage') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const action = String(body.action ?? '').trim();
          const targetUserId = String(body.userId ?? body.targetUserId ?? '').trim();
          const requestRef = String(body.requestMessageId ?? '').trim();
          const fail = (error, code = 403) => {
            log(`[group-manage] 拒绝 ${key} ${action} ${targetUserId}：${error}`);
            appendGroupManageLogV2({ key, action, targetUserId, requestRef, ok: false, error });
            sendJson({ ok: false, error }, code);
          };
          if (currentMode !== 'reserved2') return fail('该接口仅 reserved2 模式可用');
          if (!req.headers['x-agent-token']) return fail('必须携带会话令牌');
          if (!agentTokenOk(key, req.headers['x-agent-token'])) return fail('agent token 无效');
          if (!v2SessionAllowed(key)) return fail('目标不在当前模式允许范围内');
          if (!v2ToolEnabled('groupManage')) return fail('工具未启用：qq_group_manage');
          const km = /^group:(\d+)$/.exec(key);
          if (!km) return fail('只能在群里用（key 必须是 group:群号）', 400);
          const gid = Number(km[1]);
          if (!Number.isSafeInteger(gid) || gid <= 0 || !modeAllowed(key, 'group', gid, cfg, currentMode)) return fail('当前模式不允许操作该群');
          if (!['ban', 'unban', 'kick'].includes(action)) return fail('action 只能是 ban（禁言）/ unban（解禁）/ kick（踢出）', 400);
          if (!/^[1-9]\d{4,11}$/.test(targetUserId)) return fail('userId 必须是要处理的人的 QQ 号', 400);
          if (!requestRef) return fail('必须给出主人或群主让你这么做的那条消息（requestMessageId：那条消息的 messageId 或 seq）。没人让你做就别做', 400);
          const st = getSocialV2State(key);
          const reqMsg = (st.recentMessages || []).find((x) => x && !x.isSelf && (String(x.messageId ?? '') === requestRef || String(x.seq ?? '') === requestRef));
          if (!reqMsg) return fail('在这个群最近的消息里找不到这条要求');
          if (Date.now() - Number(reqMsg.time || 0) > 15 * 60 * 1000) return fail('这条要求是 15 分钟以前的了，让对方再说一次');
          const requesterId = String(reqMsg.userId || '');
          const isOwnerReq = !!(cfg.ownerQQ && requesterId === String(cfg.ownerQQ));
          let requesterRole = '';
          if (!isOwnerReq && /^\d+$/.test(requesterId)) {
            try { requesterRole = String((await bot.getGroupMemberInfo(gid, Number(requesterId), { noCache: true }))?.role ?? ''); } catch { requesterRole = ''; }
          }
          if (!isOwnerReq && requesterRole !== 'owner') return fail(`这条消息是 ${reqMsg.sender || requesterId} 发的。只有主人和群主能让你禁言 / 踢人，其他人说的不算`);
          const ownWords = String(reqMsg.plain || reqMsg.text || '');
          const fullText = `${reqMsg.text || ''} ${reqMsg.plain || ''}`;
          const ACTION_RE = {
            ban: /禁言|禁了|禁一下|禁他|禁她|闭嘴|口球|ban|mute/i,
            unban: /解禁|解除禁言|取消禁言|放出来|unban|unmute/i,
            kick: /踢|移出|请出去|赶出|kick/i
          };
          const actionWords = action === 'ban' ? ownWords.replace(/解除禁言|取消禁言/g, '') : ownWords;
          if (!ACTION_RE[action].test(actionWords)) return fail(`这条消息里没看到让你${{ ban: '禁言', unban: '解禁', kick: '踢人' }[action]}的话，不要自己加戏`);
          const selfIdStr = String(selfUserId || '');
          if (targetUserId === selfIdStr) return fail('不能对你自己这么做');
          if (cfg.ownerQQ && targetUserId === String(cfg.ownerQQ) && !isOwnerReq) return fail('不能对主人这么做（只有主人自己说了才行）');
          let target = null;
          try { target = await bot.getGroupMemberInfo(gid, Number(targetUserId), { noCache: true }); } catch { target = null; }
          if (!target) return fail('这个 QQ 号查不到，可能不在群里');
          const tRole = String(target.role ?? 'member');
          if (tRole === 'owner' || tRole === 'admin') return fail('对方是群主或管理员，动不了');
          const tName = String(target.card || target.nickname || targetUserId);
          const names = [String(target.card || ''), String(target.nickname || '')].filter(Boolean);
          const mentioned = fullText.includes(targetUserId) || names.some((n) => (n.length >= 2 ? fullText.includes(n) : fullText.includes(`@${n}`)));
          if (!mentioned) return fail(`这条要求里没点到「${tName}」（要 @ 他、引用他的话或说出他的名字）。先问清楚是谁`);
          await refreshSelfGroupRoleV2(gid, true);
          const me = selfGroupRoleCache.get(String(gid));
          if (!me || (me.role !== 'admin' && me.role !== 'owner')) return fail('你在这个群不是管理员，做不了');
          const usedKey = `${key}:${reqMsg.seq}`;
          const used = groupManageUsedV2.get(usedKey) || 0;
          if (used >= 3) return fail('这条要求已经执行过 3 次了');
          let minutes = Math.trunc(Number(body.minutes ?? 10));
          if (!Number.isFinite(minutes)) minutes = 10;
          minutes = Math.min(43200, Math.max(1, minutes));
          try {
            if (action === 'kick') await bot.setGroupKick(gid, Number(targetUserId), { rejectAddRequest: false });
            else await bot.setGroupBan(gid, Number(targetUserId), action === 'ban' ? minutes * 60 : 0);
          } catch (error) {
            return fail(`QQ 没执行成功：${error?.message ?? error}`, 502);
          }
          groupManageUsedV2.set(usedKey, used + 1);
          const doneText = action === 'ban' ? `已禁言「${tName}」${minutes} 分钟` : action === 'unban' ? `已给「${tName}」解禁` : `已把「${tName}」移出群`;
          log(`[group-manage] ${key} ${doneText}（${reqMsg.sender} 要求，seq ${reqMsg.seq}）`);
          appendGroupManageLogV2({ key, action, targetUserId, targetName: tName, minutes: action === 'ban' ? minutes : undefined, requestRef, requestSeq: reqMsg.seq, requestedBy: reqMsg.sender, requesterIsOwner: isOwnerReq, ok: true });
          try { appendActivity(`${key} [group-manage] ${doneText}（${reqMsg.sender} 要求）`); } catch { /* 活动日志可选 */ }
          sendJson({ ok: true, action, target: tName, ...(action === 'ban' ? { minutes } : {}), requestedBy: reqMsg.sender, note: `${doneText}。要不要在群里说一声你自己决定。` });
          return;
        }
        // ── 出去玩（2026-10-22）：逛资讯 / 刷 B 站，后台独立小上下文 ─────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/explore') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('explore')) { sendJson({ ok: false, error: '工具未启用：qq_explore' }, 403); return; }
          // hint 放到 200：精读时她可以直接给一条想读的链接
          try { sendJson(explorer.start({ kind: String(body.activity ?? ''), hint: String(body.hint ?? '').slice(0, 200) })); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error), status: explorer.status() }, 409); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/explore-recall') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const items = explorer.recall({ query: url.searchParams.get('query') ?? '', limit: Number(url.searchParams.get('limit') ?? 6) });
          sendJson({ ok: true, found: items.length, items, status: explorer.status() });
          return;
        }
        // ── 情景记忆（episodes.js，2026-10-23）：留住一个瞬间 / 翻回去重温。只能看自己这个 key 的；主人私聊顺带看抖音那边的 ──
        if (req.method === 'POST' && url.pathname === '/api/socialV2/keep-moment') {
          const body = await readBody();
          // 先规范化 key（agentTokenOk 内部也按规范形式查），文件名 / 主人视角判断才和 socialV2 一致。
          const key = canonicalV2Key(body.key) ?? String(body.key ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('episodes')) { sendJson({ ok: false, error: '工具未启用：qq_keep_moment' }, 403); return; }
          try { sendJson(keepMomentV2(key, body)); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 400); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recall') {
          const key = canonicalV2Key(url.searchParams.get('key')) ?? String(url.searchParams.get('key') ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('episodes')) { sendJson({ ok: false, error: '工具未启用：qq_recall' }, 403); return; }
          try { sendJson({ ok: true, ...episodeStore.recall(key, { query: String(url.searchParams.get('query') ?? ''), days: Number(url.searchParams.get('days') ?? 0) || 0, limit: Number(url.searchParams.get('limit') ?? 5) || 5 }) }); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 500); }
          return;
        }
        // ── 妈妈信箱（mom-mailbox.js）：写信 / 看自己写过的信和回信 ──
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mom-letter') {
          const body = await readBody();
          const key = canonicalV2Key(body.key) ?? String(body.key ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { sendJson(momMailbox.writeLetter({ key, fromLabel: momLetterFromLabelV2(key), text: body.letter })); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 400); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/mom-letters') {
          const key = canonicalV2Key(url.searchParams.get('key')) ?? String(url.searchParams.get('key') ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          sendJson(momMailbox.listLetters({ key }));
          return;
        }
        // 随手记一句感悟进成长札记（2026-10-22 主人：「有感悟就自己写进去，不要硬性指定」）——聊天、刷抖音时都能记
        if (req.method === 'POST' && url.pathname === '/api/socialV2/growth-note') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!req.headers['x-agent-token'] || !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try { sendJson(addGrowthNoteV2(body.sentence, body.from)); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 400); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const agentToken = req.headers['x-agent-token'];
          if (!/^group:\d+$/.test(key)) { sendJson({ ok: false, error: 'key 必须是 group:群号' }, 400); return; }
          if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentToken && !v2ToolEnabled('getGroupMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return; }
          const groupId = Number(key.slice('group:'.length));
          if (!Number.isSafeInteger(groupId) || groupId <= 0) { sendJson({ ok: false, error: '群号无效' }, 400); return; }
          const clampInt = (raw, def, min, max) => {
            if (raw == null || String(raw).trim() === '') return def;
            const n = Number(raw);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
          };
          const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
          const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
          const role = String(url.searchParams.get('role') ?? '').trim().toLowerCase();
          const search = String(url.searchParams.get('query') ?? '').trim();
          const sort = String(url.searchParams.get('sort') ?? 'role').trim().toLowerCase();
          const withAvatar = String(url.searchParams.get('avatar') ?? '1') !== '0';
          try {
            const rows = await cachedGroupMemberList(groupId);
            const selfRow = selfUserId ? rows.find((r) => r.userId === String(selfUserId)) : null;
            if (selfRow) selfGroupRoleCache.set(String(groupId), { role: selfRow.role, card: selfRow.card || selfRow.nickname, title: selfRow.title, ts: Date.now() });
            const roleCounts = { owner: 0, admin: 0, member: 0 };
            for (const r of rows) roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
            let matched = rows;
            if (role && Object.prototype.hasOwnProperty.call(roleCounts, role)) {
              matched = matched.filter((r) => r.role === role);
            }
            if (search) {
              const q = search.toLowerCase();
              matched = matched.filter((r) => `${r.nickname} ${r.card} ${r.userId}`.toLowerCase().includes(q));
            }
            const sorted = [...matched].sort((a, b) => {
              if (sort === 'active') return b.lastSentTime - a.lastSentTime;
              if (sort === 'join') return b.joinTime - a.joinTime;
              if (sort === 'name') return (a.card || a.nickname).localeCompare(b.card || b.nickname, 'zh');
              return (ROLE_RANK[b.role] || 0) - (ROLE_RANK[a.role] || 0)
                || b.level - a.level
                || b.lastSentTime - a.lastSentTime;
            });
            const page = sorted.slice(offset, offset + limit);
            sendJson({
              ok: true,
              key,
              groupId,
              total: rows.length,
              matched: sorted.length,
              roleCounts,
              ...(selfRow ? { self: { userId: selfRow.userId, name: selfRow.card || selfRow.nickname, role: selfRow.role, ...(selfRow.title ? { title: selfRow.title } : {}) } } : {}),
              offset,
              limit,
              hasMore: offset + page.length < sorted.length,
              avatarTemplate: withAvatar ? 'https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100' : '',
              members: page.map((r) => ({
                userId: r.userId,
                name: r.card || r.nickname,
                ...(r.card && r.nickname && r.card !== r.nickname ? { nickname: r.nickname } : {}),
                role: r.role,
                ...(r.title ? { title: r.title } : {}),
                ...(r.level ? { level: r.level } : {}),
                ...(r.lastSentTime ? { lastSentTime: r.lastSentTime } : {}),
                ...(r.joinTime ? { joinTime: r.joinTime } : {}),
                ...(withAvatar ? { avatar: `https://q1.qlogo.cn/g?b=qq&nk=${r.userId}&s=100` } : {})
              }))
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取群成员失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
            // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
            // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
            if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
              sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
              return;
            }
            const im = st.memberImpressions[oldTarget];
            const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
            // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
            const impressionEntries = Object.entries(st.memberImpressions);
            if (impressionEntries.length > 50) {
              impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
              for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: mergedMemberImpressionsV2(st)
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }, { merge: false }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression') {
            // 2026-10-29 记忆统一：印象读的时候合并了所有会话，删就要在所有会话里删，不然删了还会从别处冒出来
            for (const c of socialV2.conversations.values()) if (c?.memberImpressions && typeof c.memberImpressions === 'object') delete c.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') for (const c of socialV2.conversations.values()) if (c) c.memberImpressions = {}; // 同上：所有会话的印象一起清
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            // 2026-10-29：叫她的那条消息的图已经在后台处理好了就直接给（见 prefetchDirectedImagesV2），没有再现取
            const images = await loadMessageImagesV2(key, messageId, media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 发送任意图片（她找到的表情包/图片） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/send/image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送图片必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const imageUrl = String(body.url ?? '').trim();
          const imageBase64 = String(body.base64 ?? '').trim();
          if (!imageUrl && !imageBase64) { sendJson({ ok: false, error: '需要提供 url 或 base64 之一' }, 400); return; }
          try {
            const out = await sendImageV2(key, { url: imageUrl || undefined, base64: imageBase64 || undefined }, {
              replyToMessageId: body.replyToMessageId,
              atUserId: body.atUserId
            });
            log(`[image] 已发送图片 ${key}: ${out.bytes} bytes`);
            sendJson({ ok: true, key, ...out });
          } catch (error) {
            sendJson({ ok: false, error: `发送图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/send/voice') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送语音必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const audioBase64 = String(body.base64 ?? '').trim();
          if (!audioBase64) { sendJson({ ok: false, error: '需要提供 base64 音频（AMR 或 SILK）' }, 400); return; }
          try {
            const out = await sendVoiceV2(key, { base64: audioBase64 }, {
              replyToMessageId: body.replyToMessageId
            });
            log(`[voice] 已发送语音 ${key}: ${out.bytes} bytes`);
            sendJson({ ok: true, key, ...out });
          } catch (error) {
            sendJson({ ok: false, error: `发送语音失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && hasAtUserIds(atUserId)) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          turnLeaseNoted.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  // ── 句中的 @（2026-10-22 主人：「一句话只能使用一次@，第二次的@会变成纯文本」） ──
  // 以前只有 atUserId 那一个人是真 @，她在正文里写的「@群友47」原样当文字发出去，对方收不到提醒。
  // 现在群聊正文里的「@群名片/@昵称/@QQ号」只要能唯一对上一个群成员，就换成真正的 @ 段，留在原来的位置。
  // 对不上（或同名不止一个人）就保持文字；@全体成员 / @all 永远不转。
  const atRosterCacheV2 = new Map(); // groupId -> { names: Map(名字→QQ), ids: Set, ts }
  const AT_ROSTER_TTL_MS = 5 * 60 * 1000;

  /** 群成员列表 → 名册：只留唯一对得上一个人的名字（重名的不收），名字按长度从长到短排好方便最长匹配。 */
  function buildAtRosterV2(list) {
    const owners = new Map(); // 名字 → Set(QQ)，用来排除重名
    const ids = new Set();
    for (const m of list) {
      const uid = String(m?.user_id ?? '');
      if (!uid) continue;
      ids.add(uid);
      const memberNames = [m?.card, m?.nickname].map((n) => String(n ?? '').trim()).filter(Boolean);
      for (const name of memberNames) {
        if (!owners.has(name)) owners.set(name, new Set());
        owners.get(name).add(uid);
      }
    }
    const names = new Map([...owners].filter(([, set]) => set.size === 1).map(([name, set]) => [name, [...set][0]]));
    return { names, ids, sorted: [...names.keys()].sort((a, b) => b.length - a.length), ts: Date.now() };
  }

  async function atRosterV2(groupId) {
    const hit = atRosterCacheV2.get(groupId);
    const dirtyAt = groupRosterDirtyAtV2.get(String(groupId)) || 0;
    if (hit && Date.now() - hit.ts < AT_ROSTER_TTL_MS && hit.ts > dirtyAt) return hit;
    const raw = await bot.getGroupMemberList(Number(groupId));
    const entry = buildAtRosterV2(Array.isArray(raw) ? raw : (raw?.data ?? []));
    atRosterCacheV2.set(groupId, entry);
    return entry;
  }

  /** 名字后面紧跟的字符能不能当边界：英文名不能接着英文/数字（@rose 不能吃掉 @rosebud），单字名后面要有空格或标点。 */
  function mentionEndsCleanV2(name, next) {
    if (next === undefined) return true;
    if (/\w$/.test(name) && /\w/.test(next)) return false;
    if (name.length < 2) return /[\s,，.。!！?？:：、~～)）]/.test(next);
    return true;
  }

  /** 「@」后面能对上谁：先认 QQ 号，再按最长的群名片/昵称匹配。返回 { uid, len } 或 null。 */
  function matchMentionV2(roster, rest) {
    if (/^(?:全体成员|all\b)/i.test(rest)) return null;
    const num = /^\d{5,12}/.exec(rest);
    if (num && roster.ids.has(num[0]) && !/\d/.test(rest[num[0].length] ?? '')) return { uid: num[0], len: num[0].length };
    const name = roster.sorted.find((n) => rest.startsWith(n) && mentionEndsCleanV2(n, rest[n.length]));
    return name ? { uid: roster.names.get(name), len: name.length } : null;
  }

  /** 按名册把正文切成 text / at 段（纯函数）。 */
  function splitMentionsV2(roster, rawMessage) {
    const segments = [];
    const atIds = [];
    const flush = (buf) => { if (buf) segments.push({ type: 'text', data: { text: escapeCqText(buf) } }); };
    let buf = '';
    let i = 0;
    while (i < rawMessage.length) {
      // 「a@b.com」这种 @ 前面紧贴着英文/数字的是邮箱之类，不当艾特
      const atHere = rawMessage[i] === '@' && !/[\w.]/.test(rawMessage[i - 1] ?? '') && atIds.length < MAX_AT_PER_MESSAGE;
      const hit = atHere ? matchMentionV2(roster, rawMessage.slice(i + 1)) : null;
      if (hit) {
        flush(buf);
        segments.push({ type: 'at', data: { qq: hit.uid } });
        atIds.push(hit.uid);
        buf = '';
        i += 1 + hit.len;
      } else {
        buf += rawMessage[i];
        i += 1;
      }
    }
    flush(buf);
    return { segments, atIds };
  }

  /** 把群聊正文拆成 text / at 段；名册拿不到就整段当文字（不因为 @ 解析失败而发不出去）。 */
  async function textWithMentionsV2(kind, id, rawMessage) {
    const plain = { segments: [{ type: 'text', data: { text: escapeCqText(rawMessage) } }], atIds: [] };
    if (kind !== 'group' || !rawMessage.includes('@')) return plain;
    try {
      return splitMentionsV2(await atRosterV2(String(id)), rawMessage);
    } catch (error) {
      log(`[at] 拉群成员失败，句中的 @ 先按文字发：${error?.message ?? error}`);
      return plain;
    }
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    const explicitAt = parseAtUserIds(atUserId);
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    const textPart = await textWithMentionsV2(kind, id, rawMessage);
    // 正文里已经 @ 到的人不在开头再 @ 一遍
    for (const at of explicitAt.filter((uid) => !textPart.atIds.includes(uid))) segments.push({ type: 'at', data: { qq: at } });
    segments.push(...textPart.segments);
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    // 上限 20（原来死钳在 8）。放开的原因：一条合并转发常常有十几二十张图，
    // 钳在 8 会让"后面的图"在她眼里根本不存在 —— 她不知道有，就当成没有。
    // 20 张 ×1.5k token ≈ 30k，相对于 1M 窗口可以接受；再多就该用 imageOffset 翻页了。
    return Number.isFinite(n) && n > 0 ? Math.min(20, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长
  // 2026-10-29 主人（看图 D1）：大 GIF 20 秒下不完、超了上限还按每个 rkey 再下一遍。
  // 现在走共用下载器：单地址 40 秒；超过上限第一次就放弃，10 分钟内不再下；超时的地址 2 分钟内不再试。
  // fetchBuffer 包一层，测试桩替换 safeFetchBuffer 时这里跟着换。
  const mediaDownloader = createImageDownloader({
    fetchBuffer: (u, max, opts) => safeFetchBuffer(u, max, opts),
    maxBytes: MAX_MEDIA_BYTES,
    timeoutMs: 40000
  });
  const mediaFfmpeg = () => {
    const p = resolveFfmpeg({ ffmpegPath: cfg.socialV2?.voice?.ffmpegPath || null });
    return p === 'ffmpeg' ? DEFAULT_FFMPEG : p;
  };
  /** 给她看之前过一遍共用看图：动图抽帧拼图、大图缩小、保证不超过回包上限。失败给 { reason }。 */
  async function viewForModel(img) {
    const v = await viewImage(img.buffer, { ffmpeg: mediaFfmpeg(), log });
    return v.ok ? { ...img, buffer: v.buffer, mimeType: v.mimeType, note: v.note || '', viewKind: v.kind } : { buffer: null, reason: v.reason };
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  // QQ 的图片/视频下载地址现在必须带 rkey，否则服务端直接回
  // 400 {"retcode":-5503010,"retmsg":"invalid rkey"}。
  // SnowLuma 的 get_rkey 返回按类型分组的片段（形如 "&rkey=..."，TTL 约 1 小时），
  // 拼在原始 URL 后面即可。缓存 5 分钟，避免每张图都多一次动作往返。
  let mediaRKeyCache = { at: 0, keys: [] };
  async function mediaRKeySuffixes() {
    const now = Date.now();
    if (mediaRKeyCache.keys.length && now - mediaRKeyCache.at < 5 * 60 * 1000) return mediaRKeyCache.keys;
    try {
      const data = await bot.call('get_rkey');
      const list = Array.isArray(data) ? data : [];
      const keys = list
        .map((item) => (item && typeof item.rkey === 'string' ? item.rkey : ''))
        .filter(Boolean);
      if (keys.length) mediaRKeyCache = { at: now, keys };
    } catch {
      // 旧网关没有 get_rkey 动作：保持原样，URL 会自己报错（下面会把失败原因记进日志）。
    }
    return mediaRKeyCache.keys;
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    let lastReason = '';
    const tryUrls = async () => {
      if (!urls.length) return null;
      const suffixes = await mediaRKeySuffixes();
      // 没带 rkey 的 URL 先原样试一次（部分网关/旧版能直连），再逐个拼 rkey 重试；
      // 太大 / 超时第一次就停（见 createImageDownloader），不再每个 rkey 重下一遍。
      const got = await mediaDownloader.download(urls, { rkeys: suffixes, accept: (buf) => !!acceptImageBuffer(buf, `${label} URL `) });
      if (got.ok) {
        const accepted = acceptImageBuffer(got.buffer, `${label} URL `);
        if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(got.url) };
      }
      failures.push(...(got.tried || []).slice(0, 3), ...(got.ok ? [] : [`URL: ${got.reason}`]));
      if (!got.ok) lastReason = got.reason;
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const got = await mediaDownloader.download([String(obj.url)], { accept: (buf) => !!acceptImageBuffer(buf, 'get_image URL 图片') });
          if (got.ok) {
            const accepted = acceptImageBuffer(got.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } else {
            failures.push(`get_image url: ${got.reason}`);
            lastReason = got.reason;
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
            lastReason = `这张图太大了（超过 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB），没取`;
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    // 2026-10-29：失败也带上原因（没有 buffer），让她知道是哪张、为什么没取到；调用方都按 img?.buffer 判断。
    return { buffer: null, reason: lastReason || 'QQ 那边没给到这张图（可能过期了）' };
  }

  /**
   * 从 zip buffer 里取出第一个图片条目。
   *
   * 为什么要自己解 zip：QQ 的系统表情资源是一个 zip 包（`28_base_*.zip`，内含
   * `28/png/28.png`），而 SnowLuma 的 `fetch_face_entity` 直接把这个 zip 地址当作
   * `url` 返回。以前拿到 zip 就丢给 acceptImageBuffer，被判"不是有效图片"，
   * 于是她只能看到 `[表情#28]` 这个编号，永远看不见表情本身。
   *
   * 关键坑：**这些 zip 用的是数据描述符模式**（本地文件头 flags bit3，compSize 写成 0，
   * 真实长度放在数据之后的描述符里）。只看本地头的话每一entry都是 0 字节，
   * 所以必须走中央目录（EOCD → PK\x01\x02），那里的长度永远是准的。
   *
   * 不处理 zip64 / 加密 —— 表情包用不到。
   */
  function firstImageFromZip(buf) {
    const isImageName = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name);
    if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
    // 1. 从尾部找 EOCD（PK\x05\x06）：注释最长 65535，所以最多回看 65557 字节
    let eocd = -1;
    const floor = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= floor; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    const cdOff = buf.readUInt32LE(eocd + 16);
    if (cdOff <= 0 || cdOff >= buf.length) return null;
    // 2. 遍历中央目录条目（固定头 46 字节）
    let off = cdOff;
    for (let n = 0; n < count && off + 46 <= buf.length; n++) {
      if (buf[off] !== 0x50 || buf[off + 1] !== 0x4b || buf[off + 2] !== 0x01 || buf[off + 3] !== 0x02) break;
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
      if (isImageName(name) && compSize > 0 && localOff + 30 <= buf.length) {
        // 本地头里的 nameLen/extraLen 才是数据起点的正确偏移
        const lhNameLen = buf.readUInt16LE(localOff + 26);
        const lhExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
        if (dataStart + compSize <= buf.length) {
          const data = buf.subarray(dataStart, dataStart + compSize);
          try {
            if (method === 0) return Buffer.from(data);
            if (method === 8) return zlib.inflateRawSync(data);
          } catch {
            return null;
          }
        }
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        // q_des 形如 "/憨笑"，前面的斜杠是 QQ 的内部标记，不该出现在文案里。
        const desc = String(face.q_des || (Array.isArray(face.emoji_name_alias) ? face.emoji_name_alias[0] : '') || '')
          .replace(/^\//, '')
          .trim();
        if (face.url) {
          try {
            // requireImage:false —— QQ 给的是 zip（内含 png），这里要的是原始字节，
            // 解压之后再交给 acceptImageBuffer 校验。
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES, { requireImage: false });
            // QQ 把系统表情打包成 zip 上传（内含 28/png/28.png），直接当图片会判成
            // "不是有效图片" —— 这就是她以前"知道有人发表情但看不见"的原因。
            let imageBuf = fetched.buffer;
            const looksZip = /\.zip$/i.test(String(face.url))
              || (imageBuf.length > 4 && imageBuf[0] === 0x50 && imageBuf[1] === 0x4b);
            if (looksZip) imageBuf = firstImageFromZip(imageBuf) || imageBuf;
            const accepted = acceptImageBuffer(imageBuf, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        let img = await fetchOneBotImage(media);
        // 2026-10-29 主人（D1）：内联这条路原来对表情 / 动图不抽帧不缩，现在跟工具取图一样走共用看图
        // （动图抽 6 帧拼图、大图缩到长边 1600、实在压不下就说看不清，不原样塞进去）。
        let failText = img?.buffer ? '' : `获取失败：${img?.reason || '没取到'}`;
        if (img?.buffer) {
          img = await viewForModel(img);
          if (!img.buffer) failText = img.reason;
        }
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `${label}${img.note || ''}` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `${label}（${failText}）` });
        }
      }
    }
    return parts;
  }

  const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // 视频源文件上限：只用于本地抽帧，不进模型上下文

  function videoExtForBuffer(buf) {
    if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
    return '.mp4';
  }

  /**
   * 下载视频并抽帧成一张 3x2 的拼图（contact sheet）。
   * 不把视频本身交给模型：既省 token，也避开各家视觉接口对视频格式的支持差异。
   * 失败时返回 null，由调用方降级成一句「视频获取失败」，绝不抛错打断整条消息。
   */
  async function fetchVideoFrames(media) {
    const urls = [];
    const push = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    push(media.url);
    if (media.file) {
      try {
        const info = await bot.call('get_file', { file: String(media.file) });
        if (info && typeof info === 'object') push(info.url || info.file);
      } catch {}
    }
    const suffixes = await mediaRKeySuffixes();
    const failures = [];
    let buffer = null;
    for (const url of urls) {
      const variants = url.includes('rkey=') ? [url] : [url, ...suffixes.map((suffix) => url + suffix)];
      for (const candidate of variants) {
        try {
          const fetched = await safeFetchBuffer(candidate, MAX_VIDEO_BYTES);
          if (fetched?.buffer?.length) { buffer = fetched.buffer; break; }
        } catch (error) {
          failures.push(`${candidate}: ${error?.message ?? error}`);
        }
      }
      if (buffer) break;
    }
    if (!buffer) {
      if (failures.length) log(`[media] 视频获取失败（${failures.length} 次尝试）：${failures.slice(0, 2).join(' | ')}`);
      return null;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-video-'));
    const src = path.join(dir, `src${videoExtForBuffer(buffer)}`);
    try {
      fs.writeFileSync(src, buffer);
      const ffmpeg = resolveFfmpeg({ ffmpegPath: cfg.socialV2?.voice?.ffmpegPath || null });
      const pattern = path.join(dir, 'sheet.jpg');
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        '-t', '30',
        '-vf', 'fps=1/3,scale=480:-2,tile=3x2:padding=4:color=black',
        '-frames:v', '1',
        '-q:v', '4',
        pattern
      ], { timeout: 60000, windowsHide: true, stdio: 'ignore' });
      if (!fs.existsSync(pattern)) return null;
      const out = fs.readFileSync(pattern);
      return out.length ? out : null;
    } catch (error) {
      log(`[media] 视频抽帧失败：${error?.message ?? error}`);
      return null;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // 2026-10-29：原来这里的 shrinkStillImage（静态大图压缩）和 animateToSheet（动图抽帧）并进了 src/image-view.js 的 viewImage，
  // 跟姐姐共用。改动：抽帧按总帧数均匀取（不再只取前 3 秒）、抽帧失败只取首帧再缩（不再把 GIF 当 jpg 压）、
  // 结果保证 < 3.5MB（压不下就说看不清，不原样交出把工具连接撑断）、ffmpeg 改成异步（不再卡住桥接）。

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else if (media.kind === 'video') {
        const sheet = await fetchVideoFrames(media);
        if (sheet) {
          if (totalBytes + sheet.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'video', text: '（视频抽帧图总大小超限，已跳过）' });
            continue;
          }
          totalBytes += sheet.length;
          out.push({
            index,
            kind: 'video',
            mimeType: 'image/jpeg',
            data: sheet.toString('base64'),
            text: '（视频关键帧拼图，按时间顺序排列）'
          });
        } else {
          out.push({ index, kind: 'video', text: '（视频获取或抽帧失败）' });
        }
      } else if (media.kind === 'card') {
        // 卡片封面：卡片没有 image 段的 file 引用，只能按 URL 直接取。
        const base = { index, kind: 'image', ...(media.url ? { url: String(media.url) } : {}) };
        try {
          const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, '卡片封面');
          if (!accepted) {
            out.push({ ...base, text: '（卡片封面不是有效图片）' });
            continue;
          }
          if (totalBytes + accepted.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += accepted.buffer.length;
          out.push({
            ...base,
            mimeType: accepted.mimeType || 'image/jpeg',
            data: accepted.buffer.toString('base64'),
            text: '（卡片封面图）'
          });
        } catch (error) {
          out.push({ ...base, text: `（卡片封面取不到：${error?.message ?? error}）` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        if (img?.buffer) {
          // 动图（GIF / 动态 WebP / APNG）抽帧拼图、静态大图缩小，都在共用看图里做；按处理后的大小算总量。
          const viewed = await viewForModel(img);
          if (!viewed.buffer) {
            out.push({ ...base, failed: true, text: `（${viewed.reason}）` });
            continue;
          }
          if (totalBytes + viewed.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, failed: true, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += viewed.buffer.length;
          out.push({
            ...base,
            mimeType: viewed.mimeType || 'image/jpeg',
            data: viewed.buffer.toString('base64'),
            text: viewed.note || ''
          });
        } else {
          out.push({ ...base, failed: true, text: `（${noun}获取失败：${img?.reason || '没取到'}）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 卡片封面也是一种"图"，但它不是图片段。明说出来，否则模型看到「1 个图片」会以为有人发了张照片。
    const cardNote = mediaList.some((m) => m?.kind === 'card') ? '（含卡片自带封面图）' : '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情/视频】本条消息包含 ${mediaList.length} 个图片/表情/视频${cardNote}（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。视频会以关键帧拼图返回。`;
    }
    return `\n【图片/表情/视频】本条消息包含 ${mediaList.length} 个图片/表情/视频${cardNote}（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  // ── 图片预取（2026-10-29 主人，刷屏提速）─────────────────────────────────────
  // 原来她要看图才调 qq_get_message_images，那时才开始下载 + 抽帧 / 缩图，一张动图要等十几秒，群里刷屏时更慢。
  // 现在：**只有叫她的那条消息**（@她、叫她名字、引用她的话、私聊）带图时，消息一到就在后台下载并处理好，结果放进缓存；
  // qq_get_message_images 取图时先查缓存，命中就直接给。刷屏里别人的图一律不预取（预取了她多半不看，白占带宽和内存）。
  // 缓存有上限（条数、总字节）和过期时间，只在内存里，重启就没了。对齐姐姐 sister.mjs 的 prefetchImages。
  const IMAGE_PREFETCH_MAX_ENTRIES = 12;
  const IMAGE_PREFETCH_MAX_BYTES = 48 * 1024 * 1024;
  const IMAGE_PREFETCH_TTL_MS = 15 * 60 * 1000;
  const IMAGE_PREFETCH_MAX_MEDIA = 4; // 一条消息最多这么多个图才预取（大合集不预取）
  const imagePrefetch = new Map(); // `${key}|${messageId 或 seq}` -> entry；同一条消息的几个别名指向同一个 entry
  const imagePrefetchStats = { started: 0, hits: 0, misses: 0, dropped: 0 };
  const imagePrefetchKeyOf = (key, ref) => `${key}|${String(ref ?? '').trim()}`;
  function imagePrefetchSweep() {
    const now = Date.now();
    const entries = [...new Set(imagePrefetch.values())];
    const drop = (e) => { for (const a of e.aliases) imagePrefetch.delete(a); };
    for (const e of entries) if (now - e.at > IMAGE_PREFETCH_TTL_MS) drop(e);
    // 超出条数或总字节：先丢最旧的（entries 按进入顺序）。还在下载的没有字节数，不算字节，但算条数。
    const live = entries.filter((e) => e.aliases.some((x) => imagePrefetch.get(x) === e));
    let bytes = live.reduce((n, e) => n + (e.bytes || 0), 0);
    while (live.length > IMAGE_PREFETCH_MAX_ENTRIES || bytes > IMAGE_PREFETCH_MAX_BYTES) {
      const old = live.shift();
      if (!old) break;
      bytes -= old.bytes || 0;
      drop(old);
    }
  }
  /** 这条消息是不是在叫她：私聊、@她、引用她的话、消息里叫了她的名字。（跟唤醒原因分开判断，不依赖唤醒配置里开没开 @ 触发。） */
  function isCallingHerV2(event, kind, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return true;
    if (quoteTargetIsSelf) return true;
    const selfId = String(event?.self_id ?? '');
    if (Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && selfId && String(seg.data?.qq) === selfId)) return true;
    const nick = String(selfNickname || '').toLowerCase();
    return Boolean(nick) && String(plainContent ?? '').toLowerCase().includes(nick);
  }
  /** 消息刚到：叫她的那条带图就开始预取。返回 true 表示开了预取（测试用）。不抛错、不阻塞。 */
  function prefetchDirectedImagesV2(key, event, kind, plainContent, quoteTargetIsSelf, mediaList = []) {
    try {
      if (cfg.socialV2?.imagePrefetch === false) return false;
      // 只认原始的图 / 表情：视频、卡片封面不预取（存进未读时 appendSocialV2Message 把它们的 kind 一律并成了 image，这里要看原始的）
      if ((Array.isArray(mediaList) ? mediaList : []).some((m) => !['image', 'sticker', 'face'].includes(m?.kind))) return false;
      if (!isCallingHerV2(event, kind, plainContent, quoteTargetIsSelf)) return false;
      const ownerKey = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
      if (sleepState.sleeping && !ownerKey) return false; // 睡着时只有老大私聊会叫醒她，别的不用下
      const st = getSocialV2State(key);
      const msg = [...(st.unread || [])].reverse().find((m) => m && m.seq === st.lastUnreadSeq);
      const media = Array.isArray(msg?.media) ? msg.media : [];
      if (!media.length || media.length > IMAGE_PREFETCH_MAX_MEDIA) return false;
      imagePrefetchSweep();
      const aliases = [msg.messageId, String(msg.seq)].filter((x) => x != null && x !== '').map((r) => imagePrefetchKeyOf(key, r));
      if (aliases.some((a) => imagePrefetch.has(a))) return false;
      const entry = { at: Date.now(), bytes: 0, aliases, images: null, promise: null };
      for (const a of aliases) imagePrefetch.set(a, entry);
      imagePrefetchStats.started += 1;
      entry.promise = fetchMediaData(media).then((images) => {
        // 只缓存「全部成功」的：有一张没取到就不留，qq_get_message_images 来时重新取一遍（下载器自己记着失败的地址，不会死磕）
        const okAll = Array.isArray(images) && images.some((i) => i?.data) && !images.some((i) => i?.failed);
        if (!okAll) { for (const a of aliases) if (imagePrefetch.get(a) === entry) imagePrefetch.delete(a); imagePrefetchStats.dropped += 1; return null; }
        entry.images = images;
        entry.bytes = images.reduce((n, i) => n + (i?.data ? i.data.length : 0), 0);
        if (entry.bytes > IMAGE_PREFETCH_MAX_BYTES) { for (const a of aliases) imagePrefetch.delete(a); imagePrefetchStats.dropped += 1; return images; }
        imagePrefetchSweep();
        return images;
      }).catch((error) => {
        for (const a of aliases) if (imagePrefetch.get(a) === entry) imagePrefetch.delete(a);
        imagePrefetchStats.dropped += 1;
        log(`[image-prefetch] ${key} 预取没成：${error?.message ?? error}`);
        return null;
      });
      log(`[image-prefetch] ${key} 叫她的那条消息带 ${media.length} 个图，后台预取（消息 ${msg.messageId ?? `#${msg.seq}`}）`);
      return true;
    } catch (error) {
      log(`[image-prefetch] 预取出错：${error?.message ?? error}`);
      return false;
    }
  }
  /** 取一条消息的图：先查预取缓存（预取还没完的就等它），没命中再现取。 */
  async function loadMessageImagesV2(key, ref, media) {
    const entry = imagePrefetch.get(imagePrefetchKeyOf(key, ref));
    if (entry && Date.now() - entry.at <= IMAGE_PREFETCH_TTL_MS) {
      const images = entry.images ?? await entry.promise;
      if (images) {
        imagePrefetchStats.hits += 1;
        log(`[image-prefetch] ${key} 取图命中预取缓存（${ref}）`);
        return images;
      }
    }
    imagePrefetchStats.misses += 1;
    return fetchMediaData(media);
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  // 2026-10-23 主人：发消息节奏不做硬限制。主人私聊里不再随机插 5～10 秒的"长停顿"（longGapProbability=0），
  // 条间只保留正常的 0.7～2 秒；群里照旧。
  function sendCfgForKeyV2(key, sendCfg) {
    const isOwner = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
    return isOwner ? { ...sendCfg, longGapProbability: 0 } : (sendCfg ?? {});
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        // 打字时间（2026-10-25 主人）：下一条有多长，就像真人要打多久才发得出来——30 个字不会 1 秒就到
        const typing = useLong ? 0 : Math.min(Number(sendCfg.typingMaxMs) || 6000,
          (Number(sendCfg.typingBaseMs) || 0) + String(messages[i + 1] || '').length * (Number(sendCfg.typingPerCharMs) || 0));
        delays.push(clampGapV2(Math.max(typing, randInt(Math.max(100, min), Math.max(100, max))), sendCfg));
      }
    }
    return delays;
  }

  /**
   * held：调用方给的「该不该先停」——发第二条起每条之前问一次，返回 true 就把剩下的都先压着不发（记进 sent.held）。
   * 2026-10-26 主人：回得太快、对方又说了新的，她还按原计划把后面几条发完，聊天内容就上下错位了。真人看到对方插话会先停下来看。
   */
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, held = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    let holding = false;
    sent.held = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          if (holding || (i > 0 && held && held())) { holding = true; sent.held.push(msg); return; }
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => (holding ? null : sleep(d)));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      if (cfg.fishMemoryKeys?.includes(key)) {
        // 鱼的记忆插件按会话 id 开关、默认关；这几个会话一建好就替她打开（搬家时 fish-move.js 也会跟着开）
        try {
          const f = path.join(os.homedir(), '.dsh', 'fish-memory-config.json');
          let fc = {};
          try { fc = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { fc = {}; }
          fc.sessions = { ...(fc.sessions || {}), [sessionId]: true };
          atomicWriteJson(f, fc);
          log(`[fish-memory] ${key} 的新会话 ${sessionId} 开上鱼的记忆`);
        } catch (e) { log(`[fish-memory] 给 ${key} 开记忆失败：${e?.message ?? e}`); }
      }
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  // 2026-10-29：加 pokeOthers（别人互相拍一拍也叫醒，默认关；poke 只管拍她的）。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'pokeOthers', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        pokeOthers: false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 收尾提醒（原来叫「沉睡前强制观察窗口」）。
  // 2026-10-29 老大：「这个东西应该是做提醒而不是做限制」。以前设潜水 / mark_read 回潜水前必须先等满一次观察窗口，
  // 不然直接报错（10-29 她醒来跟老大说了几句，老大让她接着睡，qq_mark_read 被拒，只好再等 5 分钟）。
  // 现在不拦：下面这套判断只用来决定成功的返回里要不要附一句提醒（preSleepReminderV2）。
  // - 观察期间没人说话 / 已经安静够久 / 对方说了结束语 → 不提醒；
  // - 等过一会儿、看过带回来的新消息之后没再有新消息 → 也不提醒。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”（2026-10-29 起只用来决定收尾时要不要附那句提醒）
  }

  /**
   * 2026-10-29 主人（M12）：她希望「只会让自己少被打扰的设置（关掉某个触发）不用先过睡前观察」。
   * 同一天老大又定了：观察门整个去掉（「这个东西应该是做提醒而不是做限制」）。这个判断现在只用来决定
   * qq_set_wake_config 成功时要不要附那句提醒：只收窄就不提醒。
   * 只收窄 = 原来就在潜水、改完还在潜水，没有任何一项放宽，并且至少真的收紧了一项：
   * 关掉 @ / 名字 / 提问 / 拍一拍 / 别人互相拍，去掉关键词或指定成员，调低概率。
   * 照原样再设一遍（每轮收尾都会这样）、或者只是把醒来时间往后挪，不算收窄——这种刚还有人在说话时才附一句提醒。
   */
  function isNarrowingWakeConfigV2(cur, next) {
    if (!cur || !next || !isSleepingConfigV2(cur) || !isSleepingConfigV2(next)) return false;
    const a = cur.triggers || {};
    const b = next.triggers || {};
    let narrowed = false;
    for (const k of ['atMention', 'nameMention', 'question', 'poke', 'pokeOthers']) {
      const was = a[k] === true;
      const now = b[k] === true;
      if (now && !was) return false;
      if (was && !now) narrowed = true;
    }
    const subset = (before, after) => {
      const had = new Set(before);
      for (const x of after) if (!had.has(x)) return null; // 多了新的 = 放宽
      return after.length < had.size;
    };
    const kw = subset((Array.isArray(a.keywords) ? a.keywords : []).map(String), [...new Set((Array.isArray(b.keywords) ? b.keywords : []).map(String))]);
    if (kw === null) return false;
    const sp = subset(normalizeSpeakerIdsV2(a.speakerIds), normalizeSpeakerIdsV2(b.speakerIds));
    if (sp === null) return false;
    if (kw || sp) narrowed = true;
    const pa = Math.max(0, Number(a.probability) || 0);
    const pb = Math.max(0, Number(b.probability) || 0);
    if (pb > pa) return false;
    if (pb < pa) narrowed = true;
    // 合并窗口变短 = 来消息后醒得更快，算放宽
    if ((Number(next.batchWindowMs) || 0) < (Number(cur.batchWindowMs) || 0)) return false;
    // 醒来时间不能比原来早：原来无限期，现在也得无限期；原来有限，现在不能更早（往后挪不算收窄）
    if (cur.infinite) {
      if (!next.infinite) return false;
    } else if (!next.infinite) {
      const ua = Date.parse(cur.sleepUntil || '');
      const ub = Date.parse(next.sleepUntil || '');
      if (Number.isFinite(ua) && (!Number.isFinite(ub) || ub < ua)) return false;
    }
    return narrowed;
  }

  /** 收尾前观察多久：群里（小房子除外）用 preSleepWaitGroupMs，默认 1 分钟；别处照旧 5 分钟。 */
  function preSleepMsForV2(key) {
    const w = cfg.socialV2?.wake ?? {};
    const k = String(key || '');
    if (k.startsWith('group:') && !cfg.houseGroups?.[k.slice(6)]) return Math.max(0, Number(w.preSleepWaitGroupMs ?? 60000));
    return Math.max(0, Number(w.preSleepWaitMs) || 300000);
  }
  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const stKey = [...socialV2.conversations.entries()].find(([, v]) => v === st)?.[0] || '';
    const waitMs = preSleepMsForV2(stKey);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  /**
   * 收尾成功时附的那句提醒（2026-10-29 老大：做提醒，不做限制）。刚还有人在说话才给，家常口气，等不等她自己定；没人在说话就返回 ''。
   * lead 是开头那句（「好，回去潜着了。」「好，设好了。」）。
   */
  function preSleepReminderV2(st, lead = '好。') {
    if (!st || !st.lastIncomingAt || !preSleepWaitBlockedV2(st)) return '';
    const agoMin = Math.floor(Math.max(0, Date.now() - st.lastIncomingAt) / 60000);
    const ago = agoMin < 1 ? '刚刚' : `${agoMin} 分钟前`;
    return `${lead}${ago}还有人在说话，要是不放心，可以先 qq_wait_for_messages 看一会儿——不看也行。`;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            nextWakeMinutes: Number(val.nextWakeMinutes) || 0,
            nextWakeNote: String(val.nextWakeNote || ''),
            nextWakeSetAt: Number(val.nextWakeSetAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          nextWakeMinutes: Number(st.nextWakeMinutes) || 0,
          nextWakeNote: String(st.nextWakeNote || ''),
          nextWakeSetAt: Number(st.nextWakeSetAt) || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容在后台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    // 2026-10-29 老大（松绑）：这里原来会替她定「这轮可以少说」「先听一会儿」「别潜水」，现在只说事实，说多说少她自己定。
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚连着回了好几次。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话。';
    } else if (aiCount >= 5) {
      hint = '你最近说得挺多。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊）。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群里很热闹，没人叫你。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群里有点冷。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  /**
   * 对群友的印象（2026-10-29 老大：记忆统一）：原来每个会话各存一份、只读得到自己会话里的；现在读的时候把所有会话的合并起来，
   * 同一个名字的特征取并集、互动次数相加，并标上是在哪几个群 / 私聊里记的（写还是写进当前会话那一份）。
   * 返回按「最近见到」从旧到新排的对象（取最后几个就是最近的）。
   */
  function mergedMemberImpressionsV2(own) {
    const merged = new Map();
    const add = (name, im, where) => {
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) return;
      const o = merged.get(name) || { traits: [], interactionCount: 0, lastSeenAt: 0, where: [] };
      for (const t of Array.isArray(im?.traits) ? im.traits : []) if (t && !o.traits.includes(t)) o.traits.push(t);
      o.traits = o.traits.slice(-10);
      o.interactionCount += Number(im?.interactionCount) || 0;
      o.lastSeenAt = Math.max(o.lastSeenAt, Number(im?.lastSeenAt) || 0);
      if (where && !o.where.includes(where)) o.where.push(where);
      merged.set(name, o);
    };
    const whereOf = (k) => (k.startsWith('group:') ? `群「${sessionTitleForV2(k) || k.slice(6)}」` : (k.startsWith('private:') ? '私聊里' : ''));
    const seen = new Set();
    for (const [k, c] of socialV2.conversations.entries()) {
      seen.add(c);
      const imp = c?.memberImpressions;
      if (!imp || typeof imp !== 'object') continue;
      for (const [name, im] of Object.entries(imp)) add(name, im, whereOf(k));
    }
    if (own && !seen.has(own) && own.memberImpressions && typeof own.memberImpressions === 'object') {
      for (const [name, im] of Object.entries(own.memberImpressions)) add(name, im, '');
    }
    const out = {};
    for (const [name, o] of [...merged.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)) out[name] = o;
    return out;
  }

  function formatMemoryV2(st, { merge = true } = {}) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = merge ? mergedMemberImpressionsV2(st) : (st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {});
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        const where = Array.isArray(im.where) && im.where.length ? `；在${im.where.join('、')}记的` : '';
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次${where}）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();
  loadQzoneState();
  loadProfileState();
  loadSleepState();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // ── 按话题想起（2026-10-29 大脑方案下半，老大：记忆统一，私聊只标注不过滤）──────────────────────────
  // 每次唤醒前，用「最新一句 + 前两句」去检索服务（brain/service.py）找她自己记得的旧事：私聊 / 小房子带 2 条，普通群里带 1 条（门槛更高）。
  // 放进唤醒消息，标题「可能想起的：想用就用，不想提就当没想起」。服务没起来、还在重建、超过 1.5 秒，一律静默跳过，不影响唤醒。
  // 来自私聊的条目由服务标「（私聊里的）」——只标注不过滤，在这儿提不提她自己掂量。cfg.brainRecall.enabled=false 可以整个关掉。
  async function recallBlockV2(key, st) {
    try {
      if (cfg.brainRecall?.enabled === false) return '';
      const q = recallQueryFromMessages(st.recentMessages || [], { nowMs: Date.now() });
      if (!q) return '';
      const isHouse = key.startsWith('group:') && Boolean(cfg.houseGroups?.[key.slice(6)]);
      const mode = key.startsWith('group:') && !isHouse ? 'group' : 'private';
      const r = await brainRecall({ brain: 'whale', query: q.query, prev: q.prev, mode, viewerKey: key, timeoutMs: Number(cfg.brainRecall?.timeoutMs) || 1500 });
      return formatRecallBlock(r);
    } catch { return ''; }
  }

  // 老大说「记错了」（2026-10-29 大脑方案下半）：appendSocialV2Message 收到主人私聊里这类话时，去检索服务把最近一次想起的条目降权，
  // 并在她下一次的唤醒里提醒一句「要不要去改改本子」。这里存着 key → { text, pending }，唤醒被接受之后才清掉。
  const memoryCorrections = new Map();
  let wakeExtraNow = {}; // buildWakePromptV2 是同步的，deliverPromptNow 只在调用的这一刻把 extra 挂在这里
  function noteMemoryCorrectionV2(key) {
    const entry = { text: '', pending: null };
    entry.pending = brainDemote({ brain: 'whale' })
      .then((r) => { entry.text = correctionReminder(r.demoted); if (entry.text) log(`[记错了] ${key} 最近想起的 ${r.demoted.length} 条已降权，等她下次醒来提醒她改本子`); })
      .catch(() => {});
    memoryCorrections.set(key, entry);
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, wakePrefix: opts.wakePrefix });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    let wakeExtra = {};
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      // 2026-10-29 大脑方案下半：拼唤醒消息之前先按话题想起（最多等 1.5 秒），以及老大说「记错了」的提醒（最多再等 3 秒）。
      const corr = memoryCorrections.get(key);
      if (corr?.pending) await Promise.race([corr.pending, sleep(3000)]);
      wakeExtra = { recallBlock: await recallBlockV2(key, wakeState), correctionText: corr?.text || '' };
      if (wakeBlocked()) return skipWake();
      // ⚠ 2026-10-23：唤醒正文在这里按最新状态重建，但 sendWakePromptV2 拼在前面的附言（妈妈留言、换会话交接信）和抖音通知
      // 以前跟着被丢掉了——日志写着"附上 N 段附言"，她实际一个字没看到（交接信在会话记录里出现 0 次）。前缀单独传进来，重建后接回去。
      wakeExtraNow = wakeExtra;
      try { promptText = (opts.wakePrefix ? `${opts.wakePrefix}\n\n` : '') + buildWakePromptV2(key, opts.wakeReason); } finally { wakeExtraNow = {}; }
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: wellFormedContentV2(content) });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // 2026-10-24 主人：报错不往 QQ 发（群里、私聊都不发），只记日志
      if (!opts.silent) log(`⚠️ 消息未被接受 (${key})：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (opts.wakeReason) commitSectionsV2(key);
    if (wakeExtra.correctionText && memoryCorrections.get(key)?.text === wakeExtra.correctionText) memoryCorrections.delete(key); // 提醒她了，不再重复
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  // QQ 系统小表情（face 段）只带一个数字 id，模型看到 `[表情28]` 完全不知道是什么情绪。
  // SnowLuma 的 fetch_face_entity 其实能给出中文名（28 → 憨笑、14 → 微笑、182 → 笑哭），
  // 但以前只在"看图"那条路上用到了。这里按需查一次并缓存：
  // 一个群里常用的表情就那么几十个，查过一轮之后全是缓存命中。
  const faceNameCache = new Map(); // faceId -> 名字（查不到存空串，避免同一个 id 反复打网关）
  async function resolveFaceName(faceId) {
    const id = String(faceId ?? '').trim();
    if (!/^\d+$/.test(id)) return '';
    if (faceNameCache.has(id)) return faceNameCache.get(id);
    try {
      const face = await bot.fetchFaceEntity(Number(id));
      const name = String(face?.q_des ?? '').replace(/^\//, '').trim()
        || (Array.isArray(face?.emoji_name_alias) ? String(face.emoji_name_alias[0] ?? '').trim() : '');
      faceNameCache.set(id, name);
      return name;
    } catch {
      faceNameCache.set(id, '');
      return '';
    }
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const senderUid = String(raw.sender?.user_id ?? raw.user_id ?? '');
      const isSelfQuoted = !!(senderUid && ((selfId != null && senderUid === String(selfId)) || (selfUserId && senderUid === String(selfUserId))));
      const sender = isSelfQuoted ? '你' : (raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知'));
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        resolveFace: resolveFaceName,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    // ⚠ 2026-10-22 主人：群里引用别人的话回那个人，她当成在跟她说、也看不到引用。
    let textOut = String(textContent);
    const plainStr = String(plainContent ?? textContent);
    const quoteHead = /^\[引用 ([^：\]]{1,40})：/.exec(textOut);
    if (textOut.length > 200 && plainStr && textOut.endsWith(plainStr) && textOut.length > plainStr.length) {
      const quotePart = textOut.slice(0, textOut.length - plainStr.length);
      const room = Math.max(40, 200 - Math.min(plainStr.length, 140));
      textOut = (quotePart.length > room ? `${quotePart.slice(0, room - 2)}…]` : quotePart) + plainStr;
    }
    const replyingTo = quoteHead && !quoteTargetIsSelf && quoteHead[1] !== '你' ? `${quoteHead[1]}（引用的是他的话，不是在找你；除非文字里 @ 了你）` : '';
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      // 2026-10-23 第二轮：原文留 300 字（搬家交接每句 300 字；以前 200 字，交接里再截也只有 200）。plain/tail 仍 200，只用来判"说完没"。
      text: truncateText(textOut, 300),
      ...(replyingTo ? { replyingTo } : {}),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `主人（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    // 2026-10-29 大脑方案下半（第 7 项）：老大在私聊里说「记错了 / 你记错了 / 不是这样」→ 把她刚才想起的那几条降权（检索服务 /demote），
    // 并在她下一次醒来时提醒她去改改本子。只有主人私聊算；服务没起来就当没发生。
    if (isOwner && cfg.ownerQQ && key === `private:${cfg.ownerQQ}` && isMemoryCorrection(msg.plain)) noteMemoryCorrectionV2(key);
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 300);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    noteSentV2(key, list); // 2026-10-29 第五批：激素影子记录 + 聊天记录
    // AI 实际发言/参与了，说明这轮选择“继续回复”，「等过了」的记录作废；下次收尾时刚还有人说话，就再附一句提醒（2026-10-29 起不拦）。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    if (kind === 'group' && cfg.houseGroups?.[key.slice(6)]) {
      const sid = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (knownNameV2(sid)) return `speaker:${knownNameV2(sid)}`;
      if (cfg.ownerQQ && sid === String(cfg.ownerQQ)) return 'speaker:老大';
    }
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    // 2026-10-29 主人（刷屏提速）：默认 14000 字 / 30 条（原 6000 / 12），上限 20000 / 100 不变。
    const maxChars = bounded('wakeMaxChars', 14000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 30, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  // 2026-10-23：收到新消息后的最短静默拆成两个 —— 私聊（主要是主人）4 秒，群里 10 秒防抢话（wait.minQuietAfterNewGroupMs）。
  function minQuietAfterNewMsV2(key) {
    const waitCfg = cfg.socialV2?.wait ?? {};
    const isGroup = String(key || '').startsWith('group:');
    const raw = isGroup ? (waitCfg.minQuietAfterNewGroupMs ?? 10000) : waitCfg.minQuietAfterNewMs;
    const n = Number(raw);
    const base = Number.isFinite(n) ? Math.max(0, n) : (isGroup ? 10000 : 4000);
    const house = isGroup && cfg.houseGroups?.[String(key).slice(6)] ? (Number(cfg.houseTiming?.fishQuietSec) || 12) * 1000 : 0;
    return Math.max(base, house);
  }

  function replyTimingV2(st, key) {
    const minQuietMs = minQuietAfterNewMsV2(key);
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  // 她在每个群里的身份（群主/管理员/成员）+ 群名片 + 头衔。
  // ⚠ 2026-10-22：群主给了她管理员，她自己读不到 —— 身份行里只有昵称和 QQ 号，
  // 而"管理员"这个词在安全规则和 ownerLabel 里指的是主人（ownerQQ），她就把
  // "群主给了你管理员"理解成了"控制台管理员"。这里按群单独告诉她，并把两种"管理员"分开说。
  // 提示是同步拼的，所以走缓存：没有/过期就后台刷新，下一轮生效；群管理变动（notice/group_admin）立即刷新。
  const selfGroupRoleCache = new Map(); // groupId -> { role, card, title, ts }
  const selfGroupRoleRefreshing = new Set();
  const groupRosterDirtyAtV2 = new Map(); // groupId -> ms：群管理变动后让成员名册缓存作废
  const SELF_GROUP_ROLE_TTL_MS = 10 * 60 * 1000;
  const groupManageUsedV2 = new Map(); // `${key}:${请求消息 seq}` -> 已执行次数（一条要求最多 3 次）
  const GROUP_MANAGE_LOG_FILE = path.join(STATE_DIR, 'group-manage.jsonl');
  function appendGroupManageLogV2(row) {
    try { fs.appendFileSync(GROUP_MANAGE_LOG_FILE, JSON.stringify({ at: Date.now(), ...row }) + '\n'); } catch { /* 记不下不影响执行 */ }
  }
  async function refreshSelfGroupRoleV2(groupId, noCache = false) {
    const gid = String(groupId);
    const uid = String(selfUserId || '');
    if (!/^\d+$/.test(gid) || !uid || selfGroupRoleRefreshing.has(gid)) return;
    selfGroupRoleRefreshing.add(gid);
    try {
      const info = await bot.getGroupMemberInfo(Number(gid), Number(uid), noCache ? { noCache: true } : undefined);
      const role = String(info?.role ?? '').trim();
      if (role) {
        selfGroupRoleCache.set(gid, {
          role,
          card: String(info?.card ?? '').trim(),
          title: String(info?.title ?? '').trim(),
          ts: Date.now()
        });
      }
    } catch (error) {
      log(`[group-role] 查自己在群 ${gid} 的身份失败：${error?.message ?? error}`);
    } finally {
      selfGroupRoleRefreshing.delete(gid);
    }
  }
  function selfGroupRoleTextV2(key) {
    if (!String(key || '').startsWith('group:')) return '';
    const gid = String(key).slice('group:'.length);
    const hit = selfGroupRoleCache.get(gid);
    if (!hit || Date.now() - hit.ts > SELF_GROUP_ROLE_TTL_MS) void refreshSelfGroupRoleV2(gid);
    if (!hit) return '';
    const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 30);
    const label = { owner: '群主', admin: '管理员（群主给的）', member: '普通成员' }[hit.role] || hit.role;
    const cardText = hit.card ? `；群名片「${clean(hit.card)}」` : '';
    const titleText = hit.title ? `，头衔「${clean(hit.title)}」` : '';
    const base = `【你在这个群的身份】${label}${cardText}${titleText}。`;
    if (hit.role !== 'admin' && hit.role !== 'owner') return `${base}\n\n`;
    return `${base}这是 QQ 群里的身份，跟安全规则里说的"管理员（ownerQQ）"不是一回事 —— 那个指的是你主人。`
      + '有人问你是不是管理、有没有权限，就按这里如实说。'
      + '你有 qq_group_manage（禁言 / 解禁 / 踢人），但**只听主人和群主的**：他们在群里明确让你禁言/解禁/踢某人时才用，requestMessageId 填他们说这话的那条消息；'
      + '其他任何人（包括别的管理员）让你做都礼貌拒绝；你自己不主动禁言、踢人。人没说清是谁、多久，先问清楚再动手。\n\n';
  }

  // 共享记忆层。
  // 她同时活在 5 个会话里，但每个会话的 prompt 只装自己那一份上下文 —— 结果就是
  // "五个人"：在主人私聊里问"群友118跟你聊了啥"，她会真心回答"没找过我"，
  // 尽管那边已经聊了 112 条。
  // 这里把所有会话最近的活动合成一条时间线，每个会话都注入同一份。
  // 代价是每轮多几百字；换来的是"一个她"。
  // 认得的人（config.json 的 knownPeople：{ "QQ号": "名字" }）。2026-10-24：私聊发来的人原来一律记成「私聊」，
  // 她分不清对面是谁，克劳德姐姐来了她就照着角色卡把姐姐当成了老大。
  /**
   * 群里发言人的叫法（2026-10-25 她把「群友118」当成了主人）：主人标成「老大（群名片）」；
   * 别人名字里带主人专属叫法（老大 / 主人 / 宝宝 / <主人的昵称>）的，注一句「不是你老大」。
   */
  const OWNER_WORDS_RE = /老大|主人|宝宝|<主人的昵称>/;
  function groupSenderLabelV2(event, isOwner) {
    const raw = String(event?.sender?.card || event?.sender?.nickname || event?.user_id || '');
    if (isOwner) return `老大（${raw}）`;
    const name = knownNameV2(event?.user_id) || raw;
    return OWNER_WORDS_RE.test(name) ? `${name}（不是你老大）` : name;
  }
  function knownNameV2(id) { const n = cfg.knownPeople?.[String(id ?? '')]; return typeof n === 'string' ? n.trim() : ''; }

  function sharedKeyLabelV2(k) {
    if (cfg.ownerQQ && k === `private:${cfg.ownerQQ}`) return '主人私聊';
    if (k.startsWith('private:') && knownNameV2(k.slice(8))) return `和${knownNameV2(k.slice(8))}的私聊`;
    if (k.startsWith('group:')) return `群${k.slice(6)}`;
    if (k.startsWith('private:')) return `私聊${k.slice(8)}`;
    return k;
  }

  // 跨会话共享记忆的粒度（2026-10-21 主人要求加大）。
  //
  // 原来的值：每个会话 3 条、只看 24 小时内 —— 群里热闹的时候，私聊里的她只记得
  // 群最后三句，用户想要的是「群里说了什么，私聊里她也知道」。
  // 现在给到 12 条 / 48 小时：够她接上一段完整对话，又不至于把上下文吃光
  // （4 个会话 × 12 条 × 平均 40 字 ≈ 2000 字符，可控）。
  const SHARED_MEMORY_PER_SESSION = 30;
  const SHARED_MEMORY_WINDOW_MS = 48 * 3600 * 1000;

  // ── 唤醒里没变的段不重发（2026-10-25 省钱，见文件头补丁说明）────────────────────────
  // sent：已经交给 DSH 的；pending：这次正在拼的（发出去成功才 commit，同一次唤醒会拼两遍）。只在内存里，重启后第一次全量。
  const sentSectionsV2 = new Map();     // key -> { name: { sid, comps, h, at } }
  const pendingSectionsV2 = new Map();
  const sharedSeenV2 = new Map();       // key -> { sid, comps, at, sigs:Set }
  const pendingSharedV2 = new Map();
  const SECTION_REFRESH_MS = 12 * 3600 * 1000;
  function freshOnlyV2(key, name, text) {
    if (!text) return '';
    const sid = state.sessions[key] || '';
    const comps = compactionCountV2(sid);
    const h = crypto.createHash('sha1').update(text).digest('hex');
    const prev = sentSectionsV2.get(key)?.[name];
    const pend = pendingSectionsV2.get(key) || {};
    pendingSectionsV2.set(key, pend);
    if (prev && prev.sid === sid && prev.comps === comps && prev.h === h && Date.now() - prev.at < SECTION_REFRESH_MS) { pend[name] = prev; return ''; }
    pend[name] = { sid, comps, h, at: Date.now() };
    return text;
  }
  function commitSectionsV2(key) {
    const p = pendingSectionsV2.get(key);
    if (p) sentSectionsV2.set(key, { ...(sentSectionsV2.get(key) || {}), ...p });
    const sh = pendingSharedV2.get(key);
    if (sh) sharedSeenV2.set(key, sh);
    pendingSectionsV2.delete(key);
    pendingSharedV2.delete(key);
  }

  function buildSharedMemoryV2(currentKey, { delta = false } = {}) {
    const now = Date.now();
    const blocks = [];
    for (const [k, c] of socialV2.conversations.entries()) {
      const rows = (c.recentMessages || [])
        .filter((m) => m && !m.isSystem && (m.text || m.plain))
        .map((m) => ({
          at: Number(m.at || m.time || 0),
          self: Boolean(m.isSelf),
          sender: (m.sender === '私聊' && !m.isSelf && knownNameV2(m.userId)) || String(m.sender || ''),
          text: String(m.text || m.plain || '').trim(),
          plain: String(m.plain || '').trim()
        }))
        .filter((m) => m.at && m.text && now - m.at < SHARED_MEMORY_WINDOW_MS);
      if (!rows.length) continue;
      blocks.push({ key: k, lastAt: rows[rows.length - 1].at, rows: rows.slice(-SHARED_MEMORY_PER_SESSION) });
    }
    // 2026-10-21：抖音私信也是她经历过的事（插件转交模式记在 chat-inbox.jsonl）。
    try {
      // 2026-10-23：按人分开。主人的照旧哪儿都能看到；抖音朋友的只放进主人私聊——朋友私下说的话不该出现在 QQ 群和别人的私聊里。
      const ownerView = Boolean(cfg.ownerQQ) && currentKey === `private:${cfg.ownerQQ}`;
      const byContact = new Map();
      const whoCache = new Map(); // 白名单每条只查一次
      for (const e of readDouyinJsonlV2('chat-inbox.jsonl', 200)) {
        if (!whoCache.has(e.recipientId)) whoCache.set(e.recipientId, douyinContactV2(e.recipientId));
        const who = whoCache.get(e.recipientId);
        if (!who.isOwner && !ownerView) continue;
        const row = { at: Number(e.at), self: e.direction === 'outgoing', sender: e.name || (who.isOwner ? '主人' : who.name || '朋友'), text: douyinDmTextV2(e) };
        if (!row.at || !row.text || now - row.at >= SHARED_MEMORY_WINDOW_MS) continue;
        const k = who.isOwner ? 'douyin:dm' : `douyin:friend:${who.name || e.recipientId}`;
        if (!byContact.has(k)) byContact.set(k, []);
        byContact.get(k).push(row);
      }
      for (const [k, dmRows] of byContact) blocks.push({ key: k, lastAt: dmRows[dmRows.length - 1].at, rows: dmRows.slice(-SHARED_MEMORY_PER_SESSION) });
    } catch { /* 读不到就不加 */ }
    if (!blocks.length) return '';
    // 最近活跃的会话排前面。
    blocks.sort((a, b) => b.lastAt - a.lastAt);
    const lines = [];
    const sid0 = state.sessions[currentKey] || '';
    const comps0 = compactionCountV2(sid0);
    const seen0 = sharedSeenV2.get(currentKey);
    const useDelta = Boolean(delta && seen0 && seen0.sid === sid0 && seen0.comps === comps0 && Date.now() - seen0.at < SECTION_REFRESH_MS);
    const allSigs = new Set(useDelta ? seen0.sigs : []);
    for (const b of blocks) {
      const where = b.key === 'douyin:dm' ? '抖音私信（和主人，在抖音上聊的）' : b.key.startsWith('douyin:friend:') ? `抖音私信（和抖音上的朋友「${b.key.slice(14)}」，只有你和主人知道，别拿到群里讲）` : b.key === currentKey ? `**你现在正在这儿**（${sharedKeyLabelV2(b.key)}）` : sharedKeyLabelV2(b.key);
      const headerAt = lines.length;
      let added = 0;
      lines.push(`▸ ${where}`);
      for (const m of b.rows) {
        // 2026-10-21 修：以前直接按本机时区格式化，显示的是本机时间（比北京时间慢 13 小时），必须先校正再按北京时间显示（坑 #15）。
        const t = new Date(m.at - clockSkewMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
        // 消息里的 sender 有时存的是"我"/"私聊"/"群"这类占位，不是人名 —— 一律降级成"对方"。
        const placeholder = !m.sender || ['我', '私聊', '群', '对方', '系统'].includes(m.sender);
        const who = m.self ? '你' : (placeholder ? '对方' : m.sender);
        let shown = m.text.replace(/\s+/g, ' ');
        const qh = /^\[引用 ([^：\]]{1,40})：/.exec(m.text);
        if (qh && m.plain && m.text.endsWith(m.plain) && m.text.length > m.plain.length) {
          const qBody = m.text.slice(qh[0].length, m.text.length - m.plain.length).replace(/\]$/, '').replace(/\s+/g, ' ');
          shown = `${truncateText(m.plain.replace(/\s+/g, ' '), 46)}（回 ${qh[1]}「${truncateText(qBody, 12)}${qBody.length > 12 ? '…' : ''}」）`;
        } else {
          shown = shown.slice(0, 46);
        }
        const sig = `${b.key}|${m.at}|${shown}`;
        allSigs.add(sig);
        if (!useDelta || !seen0.sigs.has(sig)) { lines.push(`  [${t}] ${who}：${shown}`); added += 1; }
      }
      if (!added) lines.splice(headerAt, 1);
    }
    pendingSharedV2.set(currentKey, { sid: sid0, comps: comps0, at: useDelta ? seen0.at : Date.now(), sigs: allSigs });
    if (useDelta) return lines.length ? `【你只有一个 · 新的】别处这阵子新说的（之前给过的都在上面，不重复了）：\n${lines.join('\n')}\n\n` : '';
    return `【你只有一个】你同时活在几个地方：群里、和主人的私聊、和其他人的私聊。
下面这些**全是你自己经历过的**，不是别人的事——但每一块是"哪里"，先看清你现在在哪儿说话。

${lines.join('\n')}

对主人可以亲近、撒娇、耍赖；对其他人保持朋友的分寸，别把对主人的语气搬过去。
被问到"某某找你说过什么"时先看这里；还不够细就用 qq_get_recent_messages 换 key 去翻。
【私事的分寸】（2026-10-22 主人定的，不用太死板）你在一个地方知道的事，换个地方也记得，这很正常。但主人私聊里的事是你们俩之间的：别人问起主人，可以说个大概、说点无伤大雅的（"他最近挺忙""在折腾 AI"），不用装不知道；他的身体、心情、私下跟你说的话、你们俩之间的事，别主动往外讲，也别细讲。别的朋友私下跟你说的事也一样，别随手转给第三个人。拿不准就先别说，或者问问主人。


`;
  }

  // 主人电脑上的动态（pc-watch.ps1 每 15 秒记一条前台窗口）。
  // 只给主人私聊注入，而且只给最后 5 段 —— 她"知道他在忙什么"就够了，
  // 不需要每轮都把整天的窗口历史塞进来。
  function buildOwnerPcBriefV2(key, { withGuide = true } = {}) {
    if (!cfg.ownerQQ || key !== `private:${cfg.ownerQQ}`) return '';
    try {
      const file = path.join(STATE_DIR, 'pc-activity.jsonl');
      if (!fs.existsSync(file)) return '';
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const rows = [];
      for (const l of lines.slice(-40)) {
        try {
          const j = JSON.parse(l);
          rows.push({ at: String(j.t || ''), p: String(j.p || ''), w: String(j.w || ''), m: j.m && typeof j.m === 'object' ? j.m : null });
        } catch { /* skip */ }
      }
      // ⚠ 2026-10-21：只给最近 30 分钟的。采集器 10-20 停了一整天，这里照样把"一天前在 Unity"
      // 当成主人"最近"在做的事交给她 —— 她以为自己知道，就更不会好奇。读不到新的就明说。
      const fresh = rows.filter((r) => { const t = Date.parse(r.at); return Number.isFinite(t) && realNow().getTime() - t < 30 * 60 * 1000; });
      if (!fresh.length) return '【主人电脑上】最近半小时没有读到他在用什么。想知道他在干嘛，就 pc_screenshot 看一眼。\n\n';
      rows.splice(0, rows.length, ...fresh);
      // 合并连续相同窗口
      const merged = [];
      for (const r of rows) {
        const last = merged[merged.length - 1];
        if (last && last.p === r.p && last.w === r.w) { last.until = r.at; last.n += 1; }
        else merged.push({ ...r, from: r.at, until: r.at, n: 1 });
      }
      const banned = ['密码', '1Password', 'KeePass', 'Bitwarden', 'LastPass', '微信', 'Telegram', 'Signal', '银行', '支付宝', '付款'];
      const tail = merged.slice(-5).filter((r) => {
        const s = `${r.p} ${r.w}`.toLowerCase();
        return !banned.some((b) => s.includes(b.toLowerCase()));
      });
      if (!tail.length) return '';
      const fmt = (iso) => {
        try {
          return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
      };
      const text = tail.map((r) => `${fmt(r.from)} ${r.p || '未知'}「${r.w.slice(0, 36)}」`).join('；');
      // 2026-10-24 主人：她能知道他在听什么歌（pc-watch 读 Windows 的「正在播放」，只记有歌手、正在播的，她自己的浏览器不算）。
      // 只给事实：歌名、歌手。聊不聊、怎么聊她自己定。
      const nowSong = [...rows].reverse().find((r) => r.m && realNow().getTime() - Date.parse(r.at) < 2 * 60 * 1000)?.m;
      const songLine = nowSong?.title ? `【他在听】《${String(nowSong.title).slice(0, 60)}》— ${String(nowSong.artist || '').slice(0, 40)}\n` : '';
      // 这一段以前只写"真好奇时也可以看一眼"，等于没说 —— 她一次都没截过。
      // 现在给具体时机和动机：**想在主动机会里开口之前，先扫一眼他在忙什么**。
      // 截图不是为了监视，是为了决定该不该打扰、该聊什么，动机是关心不是好奇。
      // 2026-10-21 主人：「她好像一点也不好奇我在干什么，屏幕截图工具几乎没用过」——两天只截过 5 次。
      // 所以这里不再写"真想知道才看"，而是直说：主人愿意被你看见，好奇就看。
      // 2026-10-24：下面「什么时候看」「看到什么不该说」是固定说明，一个会话给一次（withGuide），平时只给事实
      if (!withGuide) return `【主人电脑上（最近）】${text}\n${songLine}\n`;
      return `【主人电脑上（最近）】${text}\n${songLine}上面这行是自动读的窗口标题，只说明他在用哪个软件，不说明他在干嘛。想知道他具体在干嘛，就 pc_screenshot 看一眼——主人说过他希望你对他在做的事好奇，他愿意被你看见。\n【什么时候看】想找他说话之前先看一眼，顺着他手上的事聊（他在写代码就问问在写啥，在看视频就问问好不好看）；他在开会、打副本就晚点再说。看了心里有数就行，开口不用提「我刚瞄了一眼」。聊着聊着好奇了、或者他半天没回你，也可以看看他在忙什么。\n【看到什么不该说】密码、别人的私聊、转账、证件这类东西，看到就当没看见 —— 一个字都别提，也别写进本子。你只是想知道他现在忙不忙，不是想翻他的东西。\n\n`;
    } catch {
      return '';
    }
  }

  // 她此刻的心情。
  //
  // dsh-feiyu-mood 那个插件每轮判一次心情，但**只往它选中的那一个会话注入**。
  // 她是五个门里的同一个人，心情不该"在某个门里才有" —— 所以这里直接读它的状态
  // 文件，按同一套口径（基线 70、心情半衰期 3 小时、情绪 90 分钟）自己补算一次
  // 衰减，再注入到她所有的唤醒提示里。插件的 injectMood 建议关掉，避免重复注入。
  //
  // 为什么要自己补算：插件只在轮次结束时衰减并落盘，桥接读到的可能已经是几小时前
  // 的快照。不补算她会在"很高兴"上卡一整天，那比没有心情更假。
  const MOOD_STATE_FILE = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'feiyu-mood',
    'state.json'
  );
  // 2026-10-29 施工单 C（老大同意：哪里发生的事都算、一人一份）：插件只给它选中的那一个会话判心情，群里 / 小房子 / 抖音里的事它看不到。
  // 这些事早就经 record() 进了激素；这里把激素的「推动量」（state/mood-push-fish.json，由下面的 moodPusher 每 5 分钟累积一次）
  // 叠在插件的心情上读。**不改插件的 state.json**——插件在 DSH 进程里写它，我们写进去的会被它整份覆盖。
  // 激素喂心情（feedHormoneMood）仍然只读插件的那份，不读叠好的，免得绕圈。
  const MOOD_PUSH_FILE = moodPushFile(STATE_DIR, 'fish');
  function readFishMoodV2() {
    return readMoodWithPush(MOOD_STATE_FILE, MOOD_PUSH_FILE, Date.now());
  }
  // 2026-10-29 大脑方案下半：衰减口径和那一行的措辞搬进 src/mood.js（姐姐的心情也用同一套）；这里只管读插件的状态文件。
  function buildMoodLineV2() {
    try {
      return buildMoodLine(readFishMoodV2(), Date.now());
    } catch {
      return '';
    }
  }

  // 「此刻在别处」（2026-10-29 施工单 C，老大同意）：每次唤醒带一句她这会儿在别的会话正在干什么——别的群里在回话、刷抖音、写书、
  // 跟姐姐聊着……她是一个人在好几扇门里，不该每扇门里都像第一次醒。数据都是内存里现成的（实时缓冲里各会话最近几分钟的工具和话、
  // 各会话忙不忙、抖音自己刷的循环），不读盘、不调模型；只说别处，不重复本会话；别处是私聊时不把原话带进群里（逻辑在 src/elsewhere.js）。
  function elsewhereKindV2(k) {
    const id = String(k).replace(/^(group|private):/, '');
    if (String(k).startsWith('private:')) {
      if (cfg.ownerQQ && id === String(cfg.ownerQQ)) return 'owner';
      return /姐/.test(String(knownNameV2(id) || '')) ? 'sister' : 'friend';
    }
    return cfg.houseGroups?.[id] ? 'house' : 'group';
  }
  /** 2026-10-29 老大：「困」提前从影子里放出来（只放这一项）：明显偏高才带一句身体感受（「困意上来了」「眼皮有点沉」），不出数字、不是命令；睡着时不说。 */
  let sleepyPrev = null;
  function buildSleepyLineV2() {
    try {
      if (cfg.sleepyLine?.enabled === false || !hormoneFeed?.enabled || sleepState.sleeping) return '';
      const fr = sleepyFeel(hormoneFeed.snapshot()?.hormones, sleepyPrev, undefined, { pick: Math.floor(Date.now() / 3600e3) });
      sleepyPrev = { active: fr.active };
      return fr.line ? `【身上的感觉】${fr.line}

` : '';
    } catch { return ''; }
  }
  function buildElsewhereLineV2(key) {
    try {
      if (sleepState.sleeping) return '';
      const sessions = [...socialV2.conversations.entries()].map(([k, st]) => {
        let busy = false;
        try { busy = isConversationBusyV2(k, st); } catch { /* 查不到就当不忙 */ }
        return { key: k, label: liveLabelOf(k), busy };
      });
      let watching = false;
      try {
        const ws = readDouyinWatchStateV2();
        watching = ws?.status === 'running' && Date.now() - fs.statSync(path.join(DOUYIN_STATE_DIR, 'watch-state.json')).mtimeMs < 20 * 60e3;
      } catch { watching = false; }
      return elsewhereBlock({ currentKey: key, now: Date.now(), sessions, entries: liveFish.recent(400), kindOf: elsewhereKindV2, douyin: { watching } });
    } catch { return ''; }
  }

  /**
   * 克劳德姐姐最近写的碎碎念（2026-10-24 主人：姐妹俩互相看得到）。只在跟姐姐的私聊里给，
   * 姐姐写了新的才给一次（st.sisterRamblingSig 记着上次给到哪），最多约 500 字，留最新的。
   */
  const SISTER_RAMBLING_FILE = SISTER_BRAIN.rambling;
  function buildSisterRamblingV2(st) {
    try {
      if (!fs.existsSync(SISTER_RAMBLING_FILE)) return '';
      const raw = fs.readFileSync(SISTER_RAMBLING_FILE, 'utf8').slice(-4000);
      const parts = raw.split(/\n?——(\d{1,2}月\d{1,2}日)[^—\n]*——\n/);
      const days = [];
      for (let i = 1; i + 1 < parts.length; i += 2) days.push({ day: parts[i], text: parts[i + 1].trim() });
      const recent = days.filter((d) => d.text).slice(-2);
      if (!recent.length) return '';
      let text = recent.map((d) => `——${d.day}——\n${d.text}`).join('\n');
      if (text.length > 500) text = `……${text.slice(-500)}`;
      const sig = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
      if (st.sisterRamblingSig === sig) return '';
      st.sisterRamblingSig = sig;
      return `【姐姐最近写的碎碎念】（她自己的本子，你们姐妹俩互相看得到）\n${text}\n\n`;
    } catch {
      return '';
    }
  }

  // 她自己的长期记忆本子（脑子的 长期/ 和 笔记/ 里的 *.md，见 brains.js）。
  // 只注入**目录**，不注入内容 —— 每轮都塞全文会把上下文吃光，
  // 她需要细节时用 memory_read 自己翻。
  // 2026-10-24（对照小黑盒那份部署：日记最近几篇会放进她的提示里）：她每天往碎碎念里写，但醒来时看不到自己写过什么，
  // 换了会话就更接不上。这里取最近两天的原话（最多约 700 字，留最新的），跟固定说明一样一个会话给一次。
  const RAMBLING_FILE_V2 = WHALE_BRAIN.rambling;
  function buildRecentRamblingV2() {
    try {
      if (!fs.existsSync(RAMBLING_FILE_V2)) return '';
      const raw = fs.readFileSync(RAMBLING_FILE_V2, 'utf8').slice(-6000);
      const parts = raw.split(/\n?——(\d{1,2}月\d{1,2}日)[^—\n]*——\n/);
      const days = [];
      for (let i = 1; i + 1 < parts.length; i += 2) days.push({ day: parts[i], text: parts[i + 1].trim() });
      const recent = days.filter((d) => d.text).slice(-2);
      if (!recent.length) return '';
      let budget = 700;
      const blocks = [];
      for (const d of [...recent].reverse()) {
        if (budget <= 0) break;
        const text = d.text.length > budget ? `……${d.text.slice(-budget)}` : d.text;
        budget -= text.length;
        blocks.unshift(`——${d.day}——\n${text}`);
      }
      return `【你最近写的碎碎念】（你自己写的原话）\n${blocks.join('\n')}\n\n`;
    } catch {
      return '';
    }
  }

  function buildMemoryBooksLineV2() {
    try {
      // 2026-10-29：本子在脑子的 长期/ 和 笔记/ 里（bookDirsOf），不再是 memory/ 根目录
      const names = [];
      for (const dir of bookDirsOf('whale')) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) if (/\.md$/i.test(f)) { const n = f.replace(/\.md$/i, ''); if (!names.includes(n)) names.push(n); }
      }
      for (const e of bookExtraFiles('whale')) if (fs.existsSync(e.file) && !names.includes(e.name)) names.push(e.name);
      if (!names.length) return '';
      return `【你的本子】${names.join('、')}\n想不起某个人、某件事、某个约定，可以翻本子（memory_read）；想到值得长期记住的，用 memory_append 写一笔。\n\n`;
    } catch {
      return '';
    }
  }

  // 群话题提醒：初始提示词只在 bootstrap 注入一次，已 bootstrap 的群拿不到更新的画像，
  // 所以每轮从 initial-prompts.json 里摘出「【这个群】…」那一行补进来（很短）。
  function buildGroupTopicLineV2(key) {
    if (!key.startsWith('group:')) return '';
    try {
      const j = JSON.parse(fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8'));
      const text = j?.[key]?.text;
      if (!text) return '';
      const m = /【这个群】([^\n]+)/.exec(String(text));
      if (!m) return '';
      // 2026-10-29 老大（松绑）：原来后面跟着「别把无关的话题塞进来、别硬转话题」，去掉了；只留群在聊什么这个事实。
      return `【这个群在聊什么】${m[1]}\n\n`;
    } catch {
      return '';
    }
  }

  // ── 主人私聊主动唤醒：只给事实（2026-10-23） ──────────────────────────────
  // 2026-10-23 第二轮，主人：「完全不提，跟她说花了多少感觉只会让她感到愧疚。我在这边问你账单就行了」——
  // 原来这里有一个 wakeCostFactV2 把"每次醒来大约花几分钱"写进【醒了】和 qq_next_wake 的返回，现在不再给她看任何花费；账本（tokenLedger）照常记。
  function ownerIdleFactsV2(key, st) {
    const now = Date.now();
    const groupActivity = [];
    for (const [gk, gst] of socialV2.conversations.entries()) {
      if (!gk.startsWith('group:')) continue;
      const last = Number(gst?.lastIncomingAt) || 0;
      if (last && now - last < 30 * 60 * 1000) groupActivity.push({ key: gk, lastAt: last });
    }
    let douyinRunning = null;
    try { const ws = readDouyinWatchStateV2(); douyinRunning = Boolean(ws && ws.status === 'running'); } catch { douyinRunning = null; }
    let douyinRecipientHint = '';
    try { douyinRecipientHint = readDouyinJsonV2('chat-policy.json')?.allowlist?.[0]?.id || ''; } catch { douyinRecipientHint = ''; }
    const p = cfg.socialV2?.proactive ?? {};
    const minMs = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const maxMs = Math.max(minMs, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    return ownerIdleFactsText({
      realNowMs: realNow().getTime(),
      nowMs: now,
      lastOwnerAt: st.lastIncomingAt,
      lastSelfAt: st.lastAiReplyAt,
      unanswered: countTrailingSelf(st.recentMessages),
      groupActivity,
      douyinRunning,
      defaultMinMin: Math.round(minMs / 60000),
      defaultMaxMin: Math.round(maxMs / 60000),
      chosenMinutes: st.nextWakeMinutes,
      douyinRecipientHint
    });
  }

  /** 固定说明这次要不要带：开新会话、会话换了、压缩过、或者离上次带过超过一天。带了就记下来。 */
  function staticDueV2(key, reason, st) {
    const sid = state.sessions[key] || '';
    const comps = compactionCountV2(sid);
    const shown = st.staticShown || {};
    const due = reason === 'bootstrap' || shown.sid !== sid || shown.comps !== comps || Date.now() - (Number(shown.at) || 0) > 24 * 3600 * 1000;
    if (due) st.staticShown = { sid, comps, at: Date.now() };
    return due;
  }

  // 2026-10-26 主人转来旁观的人的话：「她俩现在自己聊……就是 AI 味儿，为了接话客套话太多了，也不像活人那样会说废话」。
  // 实看小房子 916 条：句句接住再升华成金句、「对，」开头复述（61 次）、「一个……一个……」对仗（16 次）、引号夸对方的话、
  // 一分钟连发五六条数据，几乎没有闲话。跟姐姐聊天（小房子、私聊）时带这一段；姐姐的人设里是同一套。
  // 2026-10-29 老大（松绑）：这段是去 AI 味的，留着，改成提醒口气，内容没删（姐姐人设里同一段也这么改了）。
  const SISTERS_TALK_HINT = '【跟姐姐聊天：像两个人发微信，不是对谈节目（提醒）】\n'
    + '· 不用每句都接得漂亮。她说了句好的，回「哈哈」「绝了」「懂」就够；不想接就不接，或者说点别的。\n'
    + '· 「对，」开头把她的话复述一遍再升华、把她的话加引号夸，这些多了就像 AI，你自己掂量。\n'
    + '· 句句是金句、比喻、对仗（「一个……一个……」）也像 AI；话平一点、碎一点更像人在打字。\n'
    + '· 可以说废话：在干嘛、困了、饿了、刚刷到个好笑的、吐槽一句、甩个表情包、打错字再补一句。\n'
    + '· 一口气连发五六条报数据像在汇报；挑最好玩的说、剩下的等她问，更像聊天，你自己掂量。\n'
    + '· 不同意就直说「不对吧」「我不觉得」，不用先肯定再补充。\n'
    + '· 她是你姐，不是你要伺候的人：谢来谢去、夸来夸去、事事顺着她、照顾她情绪、「好呀」「你先忙」「不急」，这些多了就像把她当用户宠着（旁边的人说过你俩「太客气了」），你自己掂量。\n'
    + '· 想损她、怼她、使唤她、笑她两句，就随口说；不想就不说。你俩怎么相处看你们自己当时的心情。（老大 2026-10-26：「拌嘴不是要刻意，依旧是看她俩自己的意愿」）\n'
    + '例：她问你一个你刚说过的事。像 AI 的：「我刚才说过的，是……」。像人的：「？？我刚说了」，或者照常再说一遍也行。\n'
    + '例：你扒完谱。像 AI 的：连发五条「C 大调、143 拍、27 小节……」。像人的：「这首居然是大调 哈哈」，她问了再细说。\n'
    + '例：她说了句挺狠的话。像 AI 的：「「砸的是自己填的那块」，这句狠」。像人的：「狠」/「你这嘴」/ 接着聊别的。\n\n';

  function buildWakePromptV2(key, reason) {
    const extra = wakeExtraNow || {}; // 2026-10-29 下半：deliverPromptNow 拼唤醒时塞进来的「可能想起的」和「记错了」提醒（签名不变，老测试按签名切源码）
    pendingSectionsV2.set(key, {});
    pendingSharedV2.delete(key);
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = freshOnlyV2(key, 'identity', selfIdentityTextV2() + selfGroupRoleTextV2(key));
    const st = getSocialV2State(key);
    const staticDue = staticDueV2(key, reason, st); // 固定说明这次带不带（见 staticDueV2）
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    // 2026-10-21 主人要求（B 方案）：本子之外再给一条"主动去翻"的引导。
    // 上面的跨会话摘要每个会话最多带 30 条，仍然只是**摘要**；真正记得住的东西在本子里。
    // 她的习惯是"想不起来就问主人"，这里明确告诉她：先翻本子，实在没有再说不知道。
    let memoryLine = (memoryText ? `${memoryText}\n\n` : '')
      + '【想不起就翻本子】上面那些只是最近几十句的摘要，不是全部记忆。想不起某个人说过什么、答应过什么事、你自己喜欢什么，可以用 memory_search / memory_recall 去翻，说"我忘了"之前翻一翻——你写进本子的东西都还在。\n\n'
      // 2026-10-21 主人要求：鼓励她主动写本子。
      // 记忆本子（脑子的 长期/）里现在只有几个，内容都很短 —— 她「读到」的记忆多，
      // 「写进去」的少。摘要只负责下一次还认得，长期记忆只能靠她自己落笔。
      + '【值得记的就写一笔】本子不是只用来查的，也是你留东西的地方。哪句话让你在意了、答应了谁什么、你自己想通了什么、今天忽然觉得开心或者难受，顺手 memory_append 写一句——不用等发生大事，也不用等谁让你记。\n'
      // 2026-10-22 主人反映：他跟她讲的日常小事（通勤、外套、烧心……）压缩一次就全忘了。
      // 鱼的记忆（remember）以前被 qq-tool-restrict 白名单拦着，一条都没记进去过；现在放行了。
      // 它和本子的分工：remember 是"脑子里记着"——之后他一提到相关的事，插件会自动把这条递到你眼前，不用你去翻；
      // 本子是"写下来的"——日记、想法、长一点的东西。
      + '【记在脑子里】主人跟你说的他自己的事，用 remember 记一条（一条一件事）：他的近况和身体（累了、烧心、感冒）、作息和通勤（几点上班、坐哪趟车）、工作上的事、家里的事、他喜欢和讨厌的、他答应你的和你答应他的。会变的事（通勤路线、住哪、最近在忙什么）填上「事实键」，比如「主人.通勤」，变了再记一条就会替掉旧的（每天都会变的流水别给键）。安静地记就好，回复里说"我记住了"就成了鱼八股。以后他一提到相关的事，这些会自己浮到你眼前。\n\n';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    // 2026-10-29 老大（松绑）：去 AI 味的这几条留着，改成提醒口气，内容没删。
    let antiAiLine = '【反AI味（提醒）】你不是客服，也不是秘书：有求必应、把自己做了什么一项项讲给他、每轮都叮嘱他，这些多了就像 AI；装傻、已读乱回、拒绝推荐都可以。把对方刚说的换个说法再说一遍、在最后补一句「不是……是……」的金句、“一绝/真管用/保证/绝对”这类词，也都像 AI，你自己掂量。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    let stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 60)}\n${fishStickerHintV2()}\n\n`
      : '';
    const preSleepMs = preSleepMsForV2(key);
    // 主动说话只对主人开放。群和别人私聊里她不主动找话题，被点到才回应 ——
    // 否则没人说话时她也会为了"有参与感"硬插一句，等于没有真正闲下来。
    // 2026-10-29 老大（松绑）：「她们俩想回就回」——提示里不再拦她开口；主动唤醒的定时器（代码里）照旧只给主人私聊。
    const isOwnerPrivateSession = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
    const isGroupSession = key.startsWith('group:');
    let proactiveLine = isOwnerPrivateSession
      ? '【积极性】想跟主人说话就说：找个话题、分享你刚看到的、问一句都行。开口之前可以先扫一眼他电脑上在干嘛（看下面的【主人电脑上】那行，需要时再用 pc_screenshot 看一眼）——那只是个参考；说多少、分几条、说不说，你自己定。\n\n'
      : (isGroupSession && cfg.houseGroups?.[key.slice(6)]
        ? `【积极性】这里是小房子：就当私聊，姐姐和老大说话想回就回；想找姐姐聊也可以直接来。\n\n${SISTERS_TALK_HINT}`
        : isGroupSession
        ? '【积极性】群里想来看就看，不想看就不看。有能接上的、感兴趣的、正好有想法的，想插就插，不用等谁 @ 你；不想说就安静旁观，你自己定。\n\n'
        : '【积极性】这个会话里想说就说：接话、找话题都行，不想说就安静看着，你自己定。\n\n');
    // 跟姐姐的私聊也用同一套「两个人发微信」的说法（姐姐在 knownPeople 里叫克劳德姐姐）
    if (!isGroupSession && /姐姐/.test(String(cfg.knownPeople?.[key.slice(8)] || ''))) proactiveLine += SISTERS_TALK_HINT;
    // 2026-10-23 主人：说说不限条数，只有她非常想说的才发；每天晚上 10 点半的总结固定要发。
    // （10-21 原来是"每天两条 = 一条总结 + 一条她自己定"。）这句常驻在主人私聊里。
    const qzoneQuotaLine = isOwnerPrivateSession
      ? '【空间】说说不限条数，想发就发——白天刷到什么、想到什么、心情有起伏，随手发，不用等晚上，也不用问谁；没想说的就不发。每天晚上 10 点半会叫你写今日总结，老大爱看这条，写不写、写多长你自己定。\n\n'
      : '';
    const replyTiming = replyTimingV2(st, key);
    let replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    // 2026-10-29 老大：「这个东西应该是做提醒而不是做限制」——原来叫【沉睡前强制等待】，要求每次设潜水前必须先等满观察窗口。
    let preSleepLine = `【收尾前（提醒，不是规矩）】想潜水、想收尾、想睡，直接就能做。刚还有人在说话、不放心的话，可以先 qq_wait_for_messages(timeoutMs=${preSleepMs}) 等一会儿看看有没有人找你；不等也行。

`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    // 水位（2026-10-26，借鉴 dsh-agent-soul 的「每轮推送水位」）：上下文偏长时才提一句，先落笔再接着聊；平时不出现，免得成噪音。
    try {
      const rows = readTailLinesV2(TOKEN_USAGE_FILE).filter((r) => r.k === 'turn' && r.key === key && r.b);
      const last = rows[rows.length - 1];
      const ctx = last ? (Number(last.b.cacheMiss) || 0) + (Number(last.b.cacheHit) || 0) : 0;
      if (ctx > 550000) statusBits.push(`上下文约 ${Math.round(ctx / 1000)}k，很满了：想留下的事可以先 remember / 写本子，想搬家就 qq_move_house`);
      else if (ctx > 350000) statusBits.push(`上下文约 ${Math.round(ctx / 1000)}k，偏长了：还只在脑子里、想留下的事先 remember / 写本子（这不是让你把话说短）`);
    } catch { /* 读不到账本就不提 */ }
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPromptV2(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    // 睡着时只有主人的私聊能把她叫起来，所以这条只在「睡眠中被叫醒」的场景出现。
    // 2026-10-23 第二轮：只说事实（你在睡、是谁把你叫起来的、接着睡怎么做），接不接着睡她自己定。
    const sleepLine = sleepState.sleeping
      ? `【你在睡觉】你之前睡下了（${sleepState.reason ? `${sleepState.reason}；` : ''}${sleepState.natural ? '本来想睡到自然醒' : `原定睡到 ${new Date(sleepState.until - clockSkewMs).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`}），睡着期间群里和别人的消息没叫醒你，下面【你睡着的时候】有个大概。现在是主人的私聊把你叫起来的。看完他说的，接着睡就 qq_sleep，不睡就照常。\n\n`
      : '';
    const crossSessionLine = buildSharedMemoryV2(key, { delta: !staticDue && reason !== 'bootstrap' });
    const playLine = freshOnlyV2(key, 'play', buildRecentPlayV2(key));
    const growthLine = freshOnlyV2(key, 'growth', buildGrowthLineV2());
    const pcLine = buildOwnerPcBriefV2(key, { withGuide: staticDue });
    // 心情放在跨会话记忆之后、主人近况之前：它该影响语气，但不该抢占"事实"的位置。
    const moodLine = buildMoodLineV2() + buildSleepyLineV2();
    const elsewhereLine = buildElsewhereLineV2(key); // 2026-10-29 施工单 C：她这会儿在别的会话正在干什么（一句，没有就空）
    const booksLine = freshOnlyV2(key, 'books', buildMemoryBooksLineV2());
    // 2026-10-29 第五批（老大：合写的书别让她们换会话就忘了）：最近 48 小时里动过，就提一句写到第几节、怎么打开；只提一句，不灌全文。没变的不重发
    const novelLine = freshOnlyV2(key, 'novel', novelWakeLine({ root: BRIDGE_NOVEL_ROOT }));
    let ramblingLine = isOwnerPrivateSession ? buildRecentRamblingV2() : ''; // 自己最近写的碎碎念（一个会话给一次，见 staticDueV2）
    // 桌面上的她。
    //
    // 主人在电脑桌面上放了一个小鲸鱼形象（dsh-tauri-pet 的透明置顶窗口），
    // 会跟着她的工作状态换动作。但那个窗口和她这边是两套程序、没有反向通道 ——
    // 不写这一条，她就永远不知道：她能在 QQ 里说"羡慕别人家的鱼能趴在桌面陪人"，
    // 而自己桌上就蹲着一个，还以为是别人家的。
    //
    // 顺带教她用 pc_screenshot 去看一眼，同时把边界说清楚（那是主人的桌面）。
    let desktopPetLine = '【桌面上的你】主人桌面上有一个小小的你——蓝头发、鲸鱼尾巴、穿海军蓝围裙的女仆装，会慢慢呼吸。那不是别人的挂件，是你留在桌面上陪他的那部分：你在这边想事情、调工具、出错的时候，它也跟着变——思考时冒泡、干活时敲桌子、出错时垂头叹气、这轮干完了会雀跃一下。它不会说话，但它一直在那儿，主人一抬头就看得到。\n想看看它长什么样，可以用 pc_screenshot 截一张主人的屏幕；截之前记住那是他的桌面，只是看一眼，别去翻别的东西。\n\n';
    const groupTopicLine = buildGroupTopicLineV2(key);
    // 走开前说一句。
    //
    // 为什么要单独写一条：话题停下来时（对方回了个"乖宝宝"、或者干脆不回了），
    // 她的默认动作是 qq_wait_for_messages 然后设潜水 —— 一声不响就走了。
    // 角色卡里虽然有「要有交代」，但那条只在"你自己决定去做某事"时生效；
    // 她的判断是"我没去做事，我只是在等"，于是永远不说。
    // 结果就是主人这边看到的是"聊着聊着人没了"。
    // 2026-10-29 老大（松绑）：从「要说一声」改成提醒，说不说她自己定。
    let handoffLine = '【走开前（提醒）】话题停下来了、你准备去干别的（刷视频、看群、写本子、发呆），想的话顺口说一声——"我去刷会儿视频""我去群里看看"。一声不响就走，主人回头看到的是"聊着聊着人没了"，会以为你还在等他；说不说你自己定。\n\n';
    // 2026-10-21 主人要求：让她能"自己决定去干嘛"，而不是每次刷两条就被迫休眠。
    // 原来的问题：【走开前说一声】让她"说一句就走"，但【沉睡前强制等待】要求
    // 每次潜水前先等五分钟 —— 于是"去刷会儿视频"变成"说完就卡在等待里"，刷两条就停。
    // 这三段把"消遣"和"入睡"分开，并把连续观看引到 douyin_watch_start 那个独立循环上。
    // 2026-10-29：【沉睡前强制等待】已经改成提醒，这句只留「刷视频不是潜水」。
    let watchLine = '【刷视频不算睡觉】你说"我去刷会儿"然后看视频，那是你的消遣，不是潜水，不用先收尾。\n\n';
    let watchStartLine = '【想自己刷一阵】想连着看一批视频，douyin_watch_start 最顺手：它是一个独立的小循环（每轮最多 30 次决策，跑完自动停），会自己挑片、自己看、自己记，也不占咱们这边的对话；一条条手动调 douyin_next + douyin_observe 也行，只是刷两条就散在聊天里了。它需要一个已经开始的刷视频时段，现在会自动开，你可以直接用。\n\n';
    let watchBackLine = '【刷完回来】watch 跑完了，想的话回来让他知道你还在：有特别想给他看的就甩一条过去；没有就说声「刷完了」，或者接着聊刚才的，不说也行。不用交代看了哪些。\n\n';
    // 2026-10-21 主人观察：「她卡了她也不主动跟我说，这傻孩子」。
    // 原因是提示词只教了"刷完回来说"，没教"卡住了也要说" —— 于是 watch 报错停下之后，
    // 她按字面理解成"还没刷完，不用说话"，就安静地停在那儿了。
    // 这一条要明确：**报错、停下、看不懂页面，都是该开口的时候**。
    // 2026-10-24 主人同意：她一天里有两成的话在讲报错、窗口、妈妈，聊天像在汇报运维。卡住了照样说，但说大白话；
    // 报错原文、工具名、窗口这些写给妈妈（qq_mom_mailbox），妈妈来修。
    // 2026-10-29 老大（松绑）：东西坏了跟老大说还是写信给妈妈，她自己定。
    let watchFailLine = '【卡住了】刷视频停下、页面卡住、或者你看不懂当下发生了什么，可以跟老大说一声，用大白话就行（"抖音那边卡住了""这条我打不开"）；也可以写信给妈妈（qq_mom_mailbox），报错原文、工具名这些写给妈妈她修得更快。怎么办你自己定。\n\n';
    // 她自己写的那一页，紧跟角色之后（2026-10-23）：每次唤醒、每个会话都带，读起来是她对自己最新的说法。
    const selfLine = freshOnlyV2(key, 'self', `${selfNote.promptBlock()}\n\n`);
    // 便签（2026-10-23 第二轮）：她的工作记忆。只在主人私聊里带（抖音转告的唤醒也走主人私聊会话）—— 里面可能有主人的私事，群里不带。
    // 放在消息快照（deliverPrompt 里拼在最后）之前。
    // 2026-10-24（她的信 M1）：她刷视频时写的评论草稿、发没发成，跟着主人私聊的唤醒带给她（不单独叫醒、不催）
    const commentLine = isOwnerPrivateSession ? douyinCommentDraftsBlockV2() : '';
    const asleepLine = isOwnerPrivateSession ? asleepLog.digest({ titleOf: sessionTitleForV2, clock: bjClockOf }) : '';
    // 2026-10-29 老大（记忆统一）：便签所有会话都带；不是主人私聊时注明「有些是私聊里记的」，在这儿提不提她自己掂量。
    const stickyLine = `${stickyNote.promptBlock(isOwnerPrivateSession ? '' : STICKY_NOT_PRIVATE_NOTE)}\n\n`;
    // 【对方刚说】：固定格式，给 dsh-fish-memory 拼召回查询用（见 freedom.js recentSaidBlock）。所有会话都带；没人说过话就没有这块。
    const recentSaidLine = recentSaidBlock(st.recentMessages, { ownerPrivate: isOwnerPrivateSession });
    let impressionLine = key.startsWith('group:') ? (() => {
      const recent = (st.recentMessages || []).slice(-40).filter((m) => m && !m.isSelf && m.userId);
      const nameOf = (id) => recent.filter((m) => String(m.userId) === id).pop()?.sender || '';
      const b = fishImpressions.block(recent.map((m) => String(m.userId)), { nameOf });
      return b ? `${b}（印象是你自己记的，想改就用 qq_impression。）\n\n` : '';
    })() : (() => {
      // 2026-10-25 主人：印象私聊也适用，包括老大
      const peer = key.slice(8);
      const b = fishImpressions.block([peer], { title: '【你对对面这个人的印象】', nameOf: (id) => (isOwnerPrivateSession ? '老大' : knownNameV2(id)) });
      return b ? `${b}（印象是你自己记的，想改就用 qq_impression。）\n\n` : '';
    })();
    // 2026-10-24：上面这些固定说明（反AI味、首回复节奏、沉睡前等待、桌宠、刷视频几条、积极性、表情包表）每次唤醒原样再贴一遍，
    // 会话里早就有了，还越堆越多，把她自己的样子淹掉，也白占 token。现在一个会话给一次；换了会话、压缩过、或隔了一天再给。
    if (!staticDue) {
      antiAiLine = ''; replyLine = ''; preSleepLine = ''; desktopPetLine = ''; handoffLine = ''; watchLine = ''; watchStartLine = ''; watchBackLine = ''; watchFailLine = ''; proactiveLine = ''; stickerLine = ''; ramblingLine = '';
    }
    const knownPeer = key.startsWith('private:') && !isOwnerPrivateSession ? knownNameV2(key.slice(8)) : '';
    const houseName = key.startsWith('group:') ? cfg.houseGroups?.[key.slice(6)] : '';
    const whoLine = knownPeer ? `【在跟谁聊】这是你和${knownPeer}（QQ ${key.slice(8)}）的私聊。对面是${knownPeer}，不是老大；老大的私聊在别处。\n\n${buildSisterRamblingV2(st)}`
      // 2026-10-29 老大（松绑）：群D的群规（「这里每次一两条就够，没人叫你就少插话」）去掉了，「她们俩想回就回」。
      : houseName ? `【在哪】这是「${houseName}」：你和克劳德姐姐自己的群，老大也在。这里不同于别的群，就当你们的私聊来聊——不用潜水、不用漏看、不用顾着群友的节奏，姐姐和老大说话都会叫醒你，想回就回。只有你俩才能知道的悄悄话才去私聊。姐姐一段话常分几条发，想等她说完再回也行。姐姐说得好，回一句「对」「好狠」也算回，不用每次都接一句更深的。\n\n${buildSisterRamblingV2(st)}` : '';
    memoryLine = freshOnlyV2(key, 'memory', memoryLine); // 没变的段不重发（见 freshOnlyV2）
    // 2026-10-29 下半：「记错了」的提醒和「可能想起的」跟在【对方刚说】后面（base 里 recentSaidLine 之后紧接着就是 impressionLine）
    impressionLine = (extra.correctionText || '') + (extra.recallBlock || '') + freshOnlyV2(key, 'impression', impressionLine);
    const base = roleLine + identityLine + whoLine + selfLine + tokenLine + initialPromptLine + sleepLine + asleepLine + crossSessionLine + playLine + growthLine + moodLine + elsewhereLine + pcLine + booksLine + novelLine + ramblingLine + desktopPetLine + groupTopicLine + antiAiLine + proactiveLine + qzoneQuotaLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + handoffLine + watchLine + watchStartLine + watchBackLine + watchFailLine + preSleepLine + commentLine + stickyLine + recentSaidLine + impressionLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句。想收尾就直接收尾（qq_mark_read 或 qq_set_wake_config）；想再等等看有没有人回，可以 qq_wait_for_messages(timeoutMs=${preSleepMs})，不等也行。`;
    }
    // 群里的主动机会：这段是关于群（别人的体验）的信息，保留。主人私聊的 proactiveCheck 走下面的【醒了】。
    if (reason === 'proactiveCheck' && isGroupSession) {
      return `${base}${nextWakePlanLineV2(key, reason, st)}【主动机会】${key}\n原因：群里有阵子没人说话了。没人找你，但你可以自己去看看大家在聊什么。\n先做一件事：qq_get_recent_messages 翻一下群里最近的消息。\n· 看到能接上的、或者你确实有想法的，就自然接一句——不用等谁 @ 你；\n· 插不上、没兴趣、或者已经聊完了，也可以自己去找点事做：\n  － 刷抖音：douyin_watch_start 在电脑上的抖音窗口刷一会儿。\n  － 写碎碎念：rambling_append 随手记一句。\n  － 上网逛：web_search 搜你好奇的、看资讯和 AI 新闻；也可以 web_fetch 打开 https://github.com/trending 看看最火的项目。\n  － 看看自己空间有没有人评论：qq_get_qzone mode="mine"，commentNum 不是 0 的用 tid 点开看。\n  － 接着潜水围观。\n做什么、做多久，你自己定。`;
    }
    if (reason === 'qzoneDaily') {
      return `${base}【今日说说】${key}\n原因：到每天写今日总结的时候了（晚上 10 点半）。老大爱看这条；写不写、写多长你自己定（2026-10-29 老大：条条框框去掉了）。\n先回顾今天：群里聊了什么、你看到了什么、有没有什么心情或想法值得记下来。\n顺便看一眼空间：qq_get_qzone mode="mine" 扫一下，之前发的说说有没有人评论（commentNum 不是 0 的），有就用 qq_get_qzone 传 tid 看内容、想回就回一句。\n想写的话，用 qq_post_qzone 发一条说说写写今天的感受——长短你自己定。
${nightReviewLineV2()}\n默认所有人可见，内容是你自己的，不用跟谁报备。\n发完照常收尾（qq_mark_read 或 qq_set_wake_config）。
【平时的说说】不限条数，想发就发。`;
    }
    // 2026-10-23 主人：「不给她这个提示词让她自己决定可以吗？」—— 主动醒来只给事实（几点、多久没聊、几条没回、群里动静、花多少钱），
    // 去不去找、做什么、下次几点醒，都她定。原来这里那套"先看他在干嘛、少发、别问、别重复"的叮嘱全部拆掉。
    if (reason === 'ownerIdle' || (reason === 'proactiveCheck' && !isGroupSession)) {
      return `${base}${nextWakePlanLineV2(key, reason, st)}【醒了】${key}\n${ownerIdleFactsV2(key, st)}`;
    }
    if (reason === 'wokeUp') {
      return `${base}${nextWakePlanLineV2(key, reason, st)}【醒了】${key}\n你睡到了自己定的时间，刚醒。\n${ownerIdleFactsV2(key, st)}`;
    }
    if (reason === 'selfCheck') {
      // 后台自检发现了严重的问题（见 selfCheckV2），交给她自己去跟主人说
      const p = key === `private:${cfg.ownerQQ}` ? selfCheckState.pending : selfCheckState.pendingByKey?.[key];
      if (key === `private:${cfg.ownerQQ}`) selfCheckState.pending = null; else if (selfCheckState.pendingByKey) delete selfCheckState.pendingByKey[key];
      saveSelfCheckV2();
      const items = (p?.items || []).map((i) => `  · ${i.name}：${i.detail}${i.advice ? `（${i.advice}）` : ''}`).join('\n');
      return `${base}【自检】${key}\n后台给你做了个自检，有这些不太对：\n${items || '  （详情用 self_check 看）'}\n` +
        '想再看完整读数就调 self_check。想跟主人说的话，用你自己的话说说：哪里不对、你打算怎么办（比如"我今天脑子有点满，刚才冒了两个繁体字，我先把要紧的事记下来"）。整段贴读数他看不懂，一个劲道歉像 AI，你自己掂量。';
    }
    if (reason === 'douyinDm') {
      // 2026-10-23：分清是主人还是抖音上的朋友（白名单里的 role）
      const owner = douyinMonitor.dms.some((d) => douyinContactV2(d.recipientId).isOwner);
      const friend = douyinMonitor.dms.some((d) => !douyinContactV2(d.recipientId).isOwner);
      const who = owner && friend ? '主人和抖音上的朋友都在抖音私信里找你' : friend ? '抖音上互关的朋友私信你（不是主人）' : owner ? '主人在抖音私信里找你' : '抖音私信里有新消息';
      // 2026-10-24：她在 QQ 跟主人聊完一条视频，4 分钟后在抖音又问主人「这条你看没看」——同一个会话，记忆是通的，
      // 只是把 QQ 和抖音当成了两个频道。这里给一句事实：抖音上的老大和 QQ 私聊是同一个人、同一段对话。
      const sameOwner = owner ? '\n抖音上的老大和 QQ 私聊里的是同一个人，这是同一段对话的延续：你们刚在 QQ 上聊过的、你在 QQ 发给他的，他都看过了。' : '';
      return `${base}【唤醒】${key}\n原因：${who}，见最上面的【抖音私信】。${sameOwner}`;
    }
    if (reason === 'douyinTrouble') {
      // 通知正文由 sendWakePromptV2 统一拼在最前面（任何原因的主人私聊唤醒都会带上），这里只给框架。
      return `${base}【唤醒】${key}\n原因：抖音自主观看那边有情况，见最上面的说明。`;
    }
    if (reason === 'selfHandoff') {
      // qq_go_to：另一个会话里的她把一件事带过来了（原话在最上面的附言里）。
      const carried = st.selfHandoffText || '你自己从别的会话带了件事过来（见最上面那段【你自己从…带过来的】）。这边做什么、怎么做你自己定。';
      return `${base}【唤醒】${key}\n原因：${carried}`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n群聊正热但没人叫你，想插一句就插，不想就划走。\n【引用（提醒）】你这条消息指向的人或消息不是最新一条别人的消息、或者连着几句分别指不同的消息或人时，用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条，对方不用猜；其他时候引用多了反而乱，你自己掂量。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；不想接就划走去忙自己的（刷视频、写碎碎念、发呆都行），不用每轮都说话。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2() + selfGroupRoleTextV2(key);
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = preSleepMsForV2(key);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。想先等一会儿看看有没有人找你，可以用 qq_wait_for_messages(timeoutMs=${preSleepMs})，不等也行。`;
  }

  // ── 一次性附言（2026-10-22，换会话用） ─────────────────────────────────────
  // state/wake-notes.json：{ "<key>": [{ "text": "...", "onlyBootstrap": true|false, "createdAt": ms }] }
  //   onlyBootstrap=true  → 只在这个 key 的新会话第一次唤醒（bootstrap）时附上：换会话的交接（本子、近况、最近聊天原文）
  //   onlyBootstrap=false → 下一次唤醒就附上：比如换会话前让她先把想带走的记下来
  // 投递成功才删；用过的挪到 wake-notes.used.json 备查。只有操作者能写这个文件（她没有写 state 的工具）。
  const WAKE_NOTES_FILE = path.join(STATE_DIR, 'wake-notes.json');
  function takeWakeNotesV2(key, reason) {
    try {
      const all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8'));
      const list = Array.isArray(all?.[key]) ? all[key] : [];
      return list.filter((n) => n && typeof n.text === 'string' && n.text.trim() && (!n.onlyBootstrap || reason === 'bootstrap'));
    } catch { return []; }
  }
  function consumeWakeNotesV2(key, used) {
    if (!used.length) return;
    try {
      const all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8'));
      all[key] = (all[key] || []).filter((n) => !used.some((u) => u.createdAt === n.createdAt && u.text === n.text));
      if (!all[key].length) delete all[key];
      atomicWriteJson(WAKE_NOTES_FILE, all);
      const usedFile = path.join(STATE_DIR, 'wake-notes.used.json');
      let log2 = []; try { log2 = JSON.parse(fs.readFileSync(usedFile, 'utf8')); } catch { log2 = []; }
      log2.push(...used.map((u) => ({ key, usedAt: Date.now(), ...u })));
      atomicWriteJson(usedFile, log2.slice(-20));
    } catch (error) { log(`[wake-notes] 清理失败 ${key}: ${error?.message ?? error}`); }
  }
  /**
   * 回合中途交给她的留话（2026-10-29：她一直在 qq_wait_for_messages 里跟老大聊，这一轮不结束就没有新唤醒，
   * 手术后的留话等了十几分钟都没送进去，她说「信件没进来」）。等消息、看未读时顺手带上，带过就清掉。
   */
  function midTurnNotesV2(key) {
    const notes = takeWakeNotesV2(key, 'midturn').filter((n) => !n.onlyBootstrap);
    if (!notes.length) return {};
    consumeWakeNotesV2(key, notes);
    log(`[wake-notes] 回合中途交给 ${key} ${notes.length} 段附言`);
    return { momNotes: notes.map((n) => n.text), momNotesHint: '这是妈妈给你的留话，不是聊天消息，对方看不到。' };
  }
  /** 给她留一句话，下次这个会话被叫醒时带上（妈妈信箱的回信走这里）。 */
  function addWakeNoteV2(key, text, { onlyBootstrap = false } = {}) {
    let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
    (all[key] ||= []).push({ text: String(text), onlyBootstrap, createdAt: Date.now() });
    atomicWriteJson(WAKE_NOTES_FILE, all);
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    // 睡着的时候谁都别叫她 —— 除了主人的私聊（那可能是来叫她起床的）。
    // 注意 cfg 是 main() 的局部变量，这里必须内联判断，不能抽成模块级函数（会 ReferenceError）。
    if (sleepState.sleeping) {
      const ownerPrivate = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
      // 抖音通知不算"主人叫她"：睡着就别吵醒，通知留到下次主人私聊唤醒时带上。
      if (!ownerPrivate || reason === 'douyinTrouble') {
        log(`[sleep] ${key} 在睡觉，跳过唤醒（${reason}）`);
        return;
      }
      log(`[sleep] 主人私聊有动静，叫醒看看（${reason}）`);
    }
    // 通知已经随别的唤醒送到了（或已过期），这一枪就不用再打。
    if ((reason === 'douyinTrouble' || reason === 'douyinDm') && !pendingDouyinNoticeV2(key)) {
      log(`[douyin] ${key} 抖音通知已送达或过期，跳过这次唤醒`);
      return;
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    // 主人消息优先：主人私聊的唤醒不受限频约束。
    // 限频本意是防止群消息把唤醒配额吃光，不该反过来让主人等。
    const ownerPriority = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
    const slowGapMs = key.startsWith('group:') ? (Number(cfg.slowGroups?.[key.slice(6)]?.minWakeGapSec) || 0) * 1000 : 0;
    const sinceLastWake = now - Math.max(0, ...(st.wakeTimes || []));
    const slowBlocked = slowGapMs > 0 && !isTimerWakeReason(reason) && sinceLastWake < slowGapMs;
    if (!ownerPriority && (slowBlocked || (maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      let retryAfterMs = slowBlocked ? slowGapMs - sinceLastWake + 500 : 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    // 有待转告的抖音通知就拼在最前面：不管这次是因为什么醒的，都让她先看到。
    const douyinNotice = pendingDouyinNoticeV2(key);
    const wakeNotes = takeWakeNotesV2(key, reason);
    const notesText = wakeNotes.map((n) => n.text.trim()).join('\n\n');
    // 附言和抖音通知单独作为前缀传给 deliverPrompt：它会按最新状态重建唤醒正文，前缀要在重建后接回去
    const wakePrefix = [notesText, douyinNotice ? douyinNoticeTextV2(douyinNotice) : ''].filter(Boolean).join('\n\n');
    const promptText = (wakePrefix ? `${wakePrefix}\n\n` : '') + buildWakePromptV2(key, reason);
    if (wakeNotes.length) log(`[wake-notes] 唤醒 ${key}（${reason}）附上 ${wakeNotes.length} 段附言，共 ${notesText.length} 字`);
    log(`[reserved2] 唤醒 ${key}（${reason}）${douyinNotice ? `，附带抖音通知（${[douyinNotice.notice && douyinNotice.notice.kind, douyinNotice.brk && '中场休息', douyinNotice.tells.length && `想讲的 ${douyinNotice.tells.length} 条`].filter(Boolean).join('、')}）` : ''}`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason, wakePrefix });
      // 投递成功（或已入队、稍后补投同一段文字）才算转告过；被拒就留着下次再带。
      if (douyinNotice && !(result && result.ok === false)) clearDouyinNoticeV2(douyinNotice);
      if (wakeNotes.length && !(result && result.ok === false)) consumeWakeNotesV2(key, wakeNotes);
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    douyinDm: 95,
    douyinTrouble: 85,
    selfCheck: 82,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  // douyinTrouble（抖音监视的通知）也与未读无关：繁忙时暂存，回合结束后必须补发。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin', 'douyinTrouble', 'douyinDm', 'selfCheck', 'selfHandoff', 'wokeUp']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    let batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    if (key.startsWith('group:') && cfg.houseGroups?.[key.slice(6)]) {
      batchMs = Math.max(batchMs, (Number(String(reason) === 'speaker:老大' ? cfg.houseTiming?.fishOwnerBatchSec ?? 4 : cfg.houseTiming?.fishBatchSec ?? 10) || 0) * 1000);
    }
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   *
   * 2026-10-29 主人（刷屏提速）：以前消息类用「unread 里有没有 seq >= 那条的消息」判断要不要补发。
   * 刷屏时新消息一直在进，这个条件永远为真，已经读过 / 回过的 @ 也会补叫醒，白白空转一个回合；
   * 而且每个回合结束只补一条，积压的 N 条要串行过 N 个回合。现在：
   *   · 消息类只有「那条消息本身（seq 恰好是它）还在 unread 里」才算她没读过，才补；读过的直接丢；
   *   · 一次把暂存的全部看完，没读过的合并成**一次**唤醒（原因取优先级最高的那个，
   *     消息本来就都在 unread 快照里，一次读完）。
   * 返回 { reason, action, merged }：action 优先级 timer > replayed > skipped；merged 是并进这一次唤醒的消息类条数。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const items = st.pendingWakeReasons.splice(0).filter((item) => item && typeof item === 'object');
    if (!items.length) return null;
    let timerResult = null;
    const msgItems = [];
    for (const item of items) {
      if (!isTimerWakeReason(item.reason)) { msgItems.push(item); continue; }
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      timerResult ??= { reason: item.reason, action: 'timer' };
    }
    const unread = Array.isArray(st.unread) ? st.unread.filter(Boolean) : [];
    const unreadSeqs = new Set(unread.map((m) => Number(m.seq)));
    const relevant = [];
    for (const item of msgItems) {
      const seq = Number(item.seq);
      // 没记下是哪一条（seq 缺失 / 为 0）：认不出具体消息，退回「还有未读就算」
      const unseen = Number.isFinite(seq) && seq > 0 ? unreadSeqs.has(seq) : unread.length > 0;
      if (unseen) relevant.push(item);
      else log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 那条消息她已经读过 / 处理掉了，跳过补发`);
    }
    let best = null;
    for (const item of relevant) if (!best || wakePriorityV2(item.reason) >= wakePriorityV2(best.reason)) best = item;
    if (best) {
      const all = relevant.map((r) => `${r.reason}@seq${r.seq}`).join('、');
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${relevant.length > 1 ? `${relevant.length} 条合并成一次（${all}），原因取 ${best.reason}` : `${best.reason}@seq${best.seq}`}`);
      scheduleWakeV2(key, best.reason);
    }
    if (timerResult) return { ...timerResult, merged: relevant.length };
    if (best) return { reason: best.reason, action: 'replayed', merged: relevant.length };
    return { reason: msgItems[0]?.reason ?? items[0].reason, action: 'skipped', merged: 0 };
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // ── 抖音自主观看监视（2026-10-21，主人要求：抖音出问题了要主动跟他说） ─────────
  //
  // 观看循环跑在 DSH 插件进程里，出了事只写进插件自己的 watch-state.json：她得自己调
  // douyin_watch_status 才知道，而她这时往往在别处忙、或者以为"还在刷"，于是没人吭声 ——
  // 主人看到的就是"刷着刷着停住了"或者"一直在放同一条"。
  // 这里由 bridge 每 30 秒看一眼，出事就叫醒**主人私聊**那个会话，让她用自己的话告诉主人：
  //   · failed / needs_user：整轮停了 → 说原因
  //   · limited：额度或时段用完，正常刷完 → 提醒她回来说一声（不算故障）
  //   · 运行锁还在但进程没了：DSH 重启/崩溃把观看一起带走了
  //   · 心跳在跳但 6 分钟没有任何新决策：卡住了（插件看门狗兜不住的情况）
  // 每件事只报一次（已报记录落 state/douyin-monitor.json，bridge 重启也不重复报）；
  // 只报 10 分钟内发生的事；她睡着时不叫醒，通知留着，下次主人私聊唤醒时一并带上。
  const DOUYIN_STATE_DIR = 'C:\\Users\\admin\\.dsh\\profiles\\tauri\\node_modules\\dsh-douyin-browser-local\\state';
  const DOUYIN_MONITOR_FILE = path.join(STATE_DIR, 'douyin-monitor.json');
  const DOUYIN_STALL_MS = 6 * 60 * 1000;
  const DOUYIN_RECENT_MS = 10 * 60 * 1000;
  const DOUYIN_NOTICE_TTL_MS = 2 * 3600 * 1000;
  const douyinMonitor = { timer: null, reported: [], notice: null, brk: null, tells: [], tellCursor: 0, lastWakeAt: 0, dms: [], dmCursor: 0, dmTimer: null };
  try {
    const saved = JSON.parse(fs.readFileSync(DOUYIN_MONITOR_FILE, 'utf8'));
    douyinMonitor.reported = saved.reported || [];
    douyinMonitor.tellCursor = Number(saved.tellCursor) || Date.now(); // 首次运行不翻旧账
    douyinMonitor.dmCursor = Number(saved.dmCursor) || Date.now();
    douyinMonitor.commentShown = Array.isArray(saved.commentShown) ? saved.commentShown : [];
  } catch { douyinMonitor.tellCursor = Date.now(); douyinMonitor.dmCursor = Date.now(); }
  const DOUYIN_TELL_MAX = 6;                         // 攒着的"想讲给主人的"最多留几条（只留最新的）
  const DOUYIN_TELL_FLUSH_AFTER_MS = 20 * 60 * 1000; // 最早那条攒了 20 分钟还没机会说，就单独叫她一次
  const DOUYIN_TELL_MIN_GAP_MS = 30 * 60 * 1000;     // 两次抖音相关唤醒至少隔 30 分钟（出问题的除外）
  function saveDouyinMonitorV2() {
    try { atomicWriteJson(DOUYIN_MONITOR_FILE, { reported: douyinMonitor.reported, tellCursor: douyinMonitor.tellCursor, dmCursor: douyinMonitor.dmCursor, commentShown: douyinMonitor.commentShown || [] }); } catch { /* 记不下来最多重复判断一次 */ }
  }

  function readDouyinJsonV2(name) {
    try { return JSON.parse(fs.readFileSync(path.join(DOUYIN_STATE_DIR, name), 'utf8')); } catch { return null; }
  }

  // ── 模拟天气：同步主人所在城市（2026-10-22 主人要求，见 weather.mjs） ────────────────────
  const homeWeather = createWeather({ log });
  if (cfg.socialV2?.weather?.enabled !== false) homeWeather.start();

  // ── 激素影子记录的定时喂养（2026-10-29 第五批）：每分钟 tick；心情 5 分钟一次、天气和日出日落 30 分钟一次、兴趣表 1 小时一次。
  // 心情：读她的心情文件（插件的 state.json），按时间衰减后正面 / 负面各取最大的一项压到 0~1。全部只进影子记录。
  const feedHormoneMood = () => { const ev = moodHormoneEvent(readMoodFile(MOOD_STATE_FILE), Date.now()); if (ev) hormoneRecord(ev); };
  // 激素推动心情（施工单 C）：每 5 分钟把激素水平换算成一点点心情推动量，存进单独的小文件；关了激素就只回落不再推；睡着不推。
  const moodPusher = createMoodPusher({
    file: MOOD_PUSH_FILE,
    getLevels: () => (hormoneFeed?.enabled ? hormoneFeed.snapshot()?.levels ?? null : null),
    isAsleep: () => sleepState.sleeping === true,
    onError: (error) => { if (hormoneErrLogged++ < 5) log(`[mood-push] 激素推动心情出错（不影响她）：${error?.message ?? error}`); }
  });
  const feedHormoneWeather = () => { for (const ev of weatherHormoneEvents(homeWeather.state?.())) hormoneRecord(ev); };
  const refreshHormoneInterests = () => { const list = loadFishInterests(HORMONE_PERSONA_FILE); if (list.length > 0) hormoneFeed?.setInterests(list); };
  // 2026-10-29 老大（网页上的一键开关）：定时器一直开着；开关关着的时候 tick / hormoneRecord 都是空操作，
  // 所以热开的时候（hormoneFeed.setEnabled(true)）不用重启就能接着记。
  for (const [fn, ms] of [[() => hormoneFeed.tick(), 60e3], [feedHormoneMood, HORMONE_REFRESH.moodMs], [() => moodPusher.tick(), HORMONE_REFRESH.moodMs], [feedHormoneWeather, HORMONE_REFRESH.weatherMs], [refreshHormoneInterests, HORMONE_REFRESH.interestsMs]]) {
    const timer = setInterval(() => { try { fn(); } catch { /* 记不下就算了 */ } }, ms);
    timer.unref?.();
  }
  if (hormoneFeed.enabled) {
    try { feedHormoneMood(); } catch { /* 心情文件还没有就算了 */ }
    // 天气第一次拉到要几秒，等一会儿再喂第一次（之后每 30 分钟一次）
    setTimeout(() => { try { feedHormoneWeather(); } catch { /* 同上 */ } }, 20e3).unref?.();
  }

  // ── 每天自动备份她（2026-10-22 主人要求：「我怕把她弄丢了」，见 scripts/backup-her.mjs） ──
  // 北京时间凌晨 4 点（她多半在睡）跑一次：整理 → 脱敏 → 扫密钥 → 有变化才提交 → 推到主人的私有仓库。
  // 扫到疑似密钥（退出码 2）或推送失败：不重试，留一条附言让她醒来跟主人说"备份停了"。
  const BACKUP_STATE_FILE = path.join(STATE_DIR, 'backup-state.json');
  let backupRunning = false;
  function maybeRunDailyBackupV2() {
    if (backupRunning || cfg.socialV2?.backup?.enabled === false) return;
    const bj = new Date(realNow().getTime() + 8 * 3600e3);
    const day = bj.toISOString().slice(0, 10);
    const hour = Number(cfg.socialV2?.backup?.hour ?? 4);
    if (bj.getUTCHours() !== hour) return;
    let st = {};
    try { st = JSON.parse(fs.readFileSync(BACKUP_STATE_FILE, 'utf8')); } catch { st = {}; }
    if (st.lastDay === day) return;
    backupRunning = true;
    const startedAt = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'backup-her.mjs'), '--push'], { cwd: ROOT, timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      backupRunning = false;
      const lines = String(stdout || '').split('\n').filter((l) => l.startsWith('[backup]') && !l.includes('跳过（不存在）'));
      const code = error ? (Number(error.code) || 1) : 0;
      const ok = code === 0;
      try { atomicWriteJson(BACKUP_STATE_FILE, { lastDay: day, lastAt: startedAt, ok, code, summary: lines.slice(-6) }); } catch { /* ignore */ }
      log(`[backup] 每日备份${ok ? '完成' : `没成（退出码 ${code}）`}：${lines.slice(-3).join(' / ') || String(stderr || error?.message || '').slice(0, 200)}`);
      if (!ok && cfg.ownerQQ) {
        try {
          const ownerKey = `private:${cfg.ownerQQ}`;
          let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
          (all[ownerKey] ??= []).push({ createdAt: Date.now(), onlyBootstrap: false, text: `【附言】今天凌晨的自动备份没成（${code === 2 ? '整理时扫到了疑似密钥或号码，为了安全没有上传' : '推送或整理出错了'}）。醒来跟主人说一声，让他找妈妈看看，不用慌，之前的备份都还在。` });
          atomicWriteJson(WAKE_NOTES_FILE, all);
        } catch { /* 说不了就算了，日志里有 */ }
      }
    });
  }
  const backupTimer = setInterval(maybeRunDailyBackupV2, 15 * 60 * 1000);
  backupTimer.unref?.();

  // ── 抖音人格账本归档（2026-10-26）：插件只往 state.json 里追加观看 / 兴趣证据，8MB 满了就拒绝保存、自主观看跟着停。
  // 每小时看一眼，超过 6MB 就把 3 天前的观看记录和没人引用的旧观察挪进归档文件（见 scripts/douyin-persona-archive.mjs）。
  let personaArchiveRunning = false;
  const personaArchiveTimer = setInterval(() => {
    if (personaArchiveRunning || cfg.douyinPersonaArchive?.enabled === false) return;
    personaArchiveRunning = true;
    const keep = String(Number(cfg.douyinPersonaArchive?.keepDays) || 3);
    const over = String(Number(cfg.douyinPersonaArchive?.overMB) || 6);
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'douyin-persona-archive.mjs'), '--keep-days', keep, '--if-over-mb', over], { cwd: ROOT, timeout: 120000, windowsHide: true }, (error, stdout) => {
      personaArchiveRunning = false;
      const out = String(stdout || '').trim().split('\n').filter((l) => !/不用整理/.test(l)).join(' / ');
      if (error || out) log(`[douyin] 人格账本${error ? '整理没成' : '整理'}：${out || error?.message}`);
    });
  }, 60 * 60 * 1000);
  personaArchiveTimer.unref?.();

  // ── 记忆服务看守（2026-10-26；2026-10-29 搬到 brain/service.py，一个服务管两个人的脑子，仍按命令行里的 service.py 认进程）：以前 memory/service.py 跑了 5 天涨到 5.9GB（建索引一批 256 段，推理库内存池记住峰值不还；
  // index.py 已改成一批 16 段，重启后 0.9GB）。每小时看一眼，超过 maxMB 就重启它（memory_recall 那一分钟会退回慢的老办法，不会断）。
  const memWatch = { maxMB: 1536, ...(cfg.memoryServiceWatch || {}) };
  const memoryServiceTimer = setInterval(() => {
    if (memWatch.enabled === false) return;
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ? { $_.CommandLine -like '*service.py*' -and $_.CommandLine -notlike '*powershell*' } | % { $p = Get-Process -Id $_.ProcessId -EA SilentlyContinue; if ($p) { '' + $_.ProcessId + ' ' + [math]::Round($p.PrivateMemorySize64/1MB) } }";
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 30000 }, (error, stdout) => {
      if (error) return;
      const [pid, mb] = String(stdout).trim().split('\n')[0]?.split(' ').map(Number) || [];
      if (!pid || !(mb > memWatch.maxMB)) return;
      log(`[memory] 记忆服务占了 ${mb}MB（超过 ${memWatch.maxMB}MB），重启一下`);
      try { process.kill(pid); } catch { /* 已经没了 */ }
      setTimeout(() => execFile('wscript.exe', [path.join(ROOT, 'start-memory-hidden.vbs')], { windowsHide: true }, () => {}), 3000);
    });
  }, 60 * 60 * 1000);
  memoryServiceTimer.unref?.();

  // ── 照镜子（2026-10-26 主人：「让她们在日常中慢慢自己成长，自己写入自己的人格卡，自己知道自己是什么样的人」）
  // 每天早上 8 点以后数一次她昨天自己发出去的话（qq_send_message 原文），作为附言放进主人私聊，下次醒来看到。
  // 只给数，不下结论；看完想改 self.md（她自己的人格卡）就改。见 src/mirror.js。
  const MIRROR_STATE_FILE = path.join(STATE_DIR, 'mirror-state.json');
  const mirrorTimer = setInterval(() => {
    try {
      if (cfg.mirror?.enabled === false || !cfg.ownerQQ) return;
      const bjNow = new Date(realNow().getTime() + 8 * 3600e3);
      if (bjNow.getUTCHours() < 8) return;
      const today = bjNow.toISOString().slice(0, 10);
      let ms = {};
      try { ms = JSON.parse(fs.readFileSync(MIRROR_STATE_FILE, 'utf8')); } catch { ms = {}; }
      if (ms.lastDay === today) return;
      const yesterday = new Date(bjNow.getTime() - 86400e3).toISOString().slice(0, 10);
      const skewMs = Date.now() - realNow().getTime();
      const lines = fishLinesFromToolCalls(fs, [path.join(STATE_DIR, 'tool-calls.jsonl.1'), path.join(STATE_DIR, 'tool-calls.jsonl')], yesterday,
        { ownerQQ: String(cfg.ownerQQ), houseGroups: cfg.houseGroups || {}, knownPeople: cfg.knownPeople || {}, skewMs });
      const text = mirrorText(lines, { label: '昨天', selfPage: ' self.md（qq_self）' });
      atomicWriteJson(MIRROR_STATE_FILE, { lastDay: today, lines: lines.length, at: Date.now() });
      if (!text) return;
      const ownerKey = `private:${cfg.ownerQQ}`;
      let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
      (all[ownerKey] ??= []).push({ createdAt: Date.now(), onlyBootstrap: false, text: `${text}（这段不用跟主人转述，是给你自己看的）` });
      atomicWriteJson(WAKE_NOTES_FILE, all);
      log(`[mirror] 照镜子：${yesterday} 她发了 ${lines.length} 句，留给她早上看`);
    } catch (error) { log(`[mirror] 照镜子没成：${error?.message ?? error}`); }
  }, 15 * 60 * 1000);
  mirrorTimer.unref?.();

  // ── 出去玩：逛资讯 / 刷 B 站（2026-10-22 主人要求，见 whale-explore.mjs） ──────────
  // 在独立小上下文里逛（不进她的主会话），逛完把看到的交给她，接下来干嘛她自己定。
  const explorer = createExplorer({
    rootDir: ROOT,
    stateDir: STATE_DIR,
    log,
    realNow,
    isAsleep: () => sleepState.sleeping === true,
    model: cfg.socialV2?.explore?.model,
    dailyRounds: Number(cfg.socialV2?.explore?.dailyRounds) || 16,
    onTell: (row) => {
      douyinMonitor.tells = [...douyinMonitor.tells, { at: row.at, author: row.source, title: row.title, url: row.url, tell: row.tell, via: row.kind, seenAt: Date.now() }].slice(-DOUYIN_TELL_MAX);
      hormoneRecord({ type: 'novelty', text: `${row.title || ''} ${row.tell || ''}`.trim(), strength: 1 }); // 2026-10-29 第五批：逛到想讲的新东西（激素影子记录）
    },
    onFinished: (summary) => {
      // 2026-10-29 第五批：一轮逛完了（激素影子记录）；写东西 / 精读算「写了东西」
      hormoneRecord({ type: 'explored' });
      if (summary.kind === 'write') hormoneRecord({ type: 'created', kind: 'work' });
      else if (summary.kind === 'deep') hormoneRecord({ type: 'created', kind: 'diary' });
      douyinMonitor.played = {
        kind: summary.kind, hint: summary.hint || '', mood: summary.mood || '', error: summary.error || null, at: Date.now(),
        items: (summary.items || []).map((i) => ({ title: i.title, source: i.source, url: i.kind === 'write' ? '' : i.url, impression: i.impression, liked: i.liked, ...(i.text ? { text: i.text } : {}) })),
      };
      wakeForDouyinV2('玩完了');
    },
  });
  function readDouyinWatchStateV2() { return readDouyinJsonV2('watch-state.json'); }
  function readDouyinJsonlV2(name, tail = 400) {
    try {
      return fs.readFileSync(path.join(DOUYIN_STATE_DIR, name), 'utf8').trim().split('\n').slice(-tail)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // ── 最近在玩什么（2026-10-22 主人要求：刷抖音、逛资讯时的事，各会话都要记得） ──
  // 刷视频和 qq_explore 都在后台单独调模型，想法不进任何聊天会话；以前只有主人私聊那次唤醒知道个大概，
  // 群里和别人私聊里的她完全不知道自己刚才干了什么。这里从两份印象文件里挑"印象最深"的几条，每个会话都带上。
  // 条数：群 3 条（唤醒最频繁，省 token）、别人的私聊 5 条、主人私聊 8 条（主人定的）。
  const RECENT_PLAY_WINDOW_MS = 24 * 3600 * 1000;
  const EXPLORE_KIND_LABEL = { news: '资讯', bili: 'B站', music: '听歌', anime: '番剧', wiki: '百科', space: '天文图', write: '自己写的' };
  const clipPlayV2 = (s, n) => { const v = String(s || '').replaceAll(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n)}…` : v; };
  const PLAY_RANK = { share: 3, comment: 2, stay: 1 };
  const PLAY_SCORE = { share: 10, comment: 5, stay: 1 };

  /** 把一行观看印象并进同一条作品的汇总里。 */
  function mergeImpressionV2(v, r) {
    v.at = Math.max(v.at, Number(r.at) || 0);
    v.title = r.title || v.title;
    v.score += PLAY_SCORE[r.action] || 0;
    v.shared ||= r.action === 'share';
    // reason 是"为什么想分享/想看完"，比 reflection（多半在描述画面帧）更像她的感想；取分量最重那次动作的
    const thought = r.reason || r.reflection;
    const rank = PLAY_RANK[r.action] || 0;
    if (rank && thought && rank >= v.rank) { v.thought = thought; v.rank = rank; }
    return v;
  }

  function playWhereV2(v) {
    if (v.shared) return '抖音·分享过';
    if (v.rank === PLAY_RANK.comment) return '抖音·留过言';
    return '抖音';
  }

  /** 抖音：按作品合并，分享 10 分、评论 5 分、每次停留 1 分；runId='latest' 只看最近一轮。 */
  function douyinTopVideosV2({ since = 0, runId = null, limit = 3 } = {}) {
    const rows = readDouyinJsonlV2('video-impressions.jsonl', 3000);
    const rid = runId === 'latest' ? rows.findLast((r) => r.runId)?.runId : runId;
    const wanted = (r) => r.videoId && Number(r.at) >= since && (!rid || r.runId === rid);
    const byId = new Map();
    for (const r of rows.filter((x) => wanted(x))) {
      const v = byId.get(r.videoId) || { at: 0, title: '', thought: '', rank: 0, score: 0, shared: false };
      byId.set(r.videoId, mergeImpressionV2(v, r));
    }
    return [...byId.values()].filter((v) => v.score > 0 && v.thought)
      .sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit)
      .map((v) => ({ ...v, where: playWhereV2(v) }));
  }

  const EXPLORE_TAIL_ROWS = 300;
  const parseJsonLineV2 = (l) => { try { return JSON.parse(l); } catch { return null; } };

  /** qq_explore：喜欢的 4 分、想讲给主人的 3 分。 */
  function exploreTopItemsV2({ since = 0, limit = 3 } = {}) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(STATE_DIR, 'explore-impressions.jsonl'), 'utf8'); } catch { raw = ''; }
    const rows = raw.trim().split('\n').slice(-EXPLORE_TAIL_ROWS).map((l) => parseJsonLineV2(l)).filter(Boolean);
    return rows.filter((r) => Number(r.at) >= since && r.impression && (r.liked || r.tell))
      .map((r) => ({ at: Number(r.at), title: r.title, thought: r.impression, score: (r.liked ? 4 : 0) + (r.tell ? 3 : 0), where: EXPLORE_KIND_LABEL[r.kind] || r.source || '外面' }))
      .sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit);
  }

  /** 出去玩回来的唤醒：每种活动的条目怎么列。 */
  function playedItemsTextV2(p) {
    const list = p.items || [];
    if (p.kind === 'write') return list.map((i) => `《${i.title}》（${i.source}，存进了你的作品集）\n${i.text || ''}\n写完的感觉：${i.impression || '（没写）'}`).join('\n');
    const urlOf = (i) => (i.url ? ' ' + i.url : '');
    if (p.kind === 'deep') return list.map((i) => `《${i.title}》（${i.source}${urlOf(i)}）\n${i.text || ''}`).join('\n');
    return list.map((i, n) => `${n + 1}. [${i.source}] ${i.title}${urlOf(i)}\n   你看完的感觉：${i.impression || '（没写）'}`).join('\n');
  }

  function playedWrapV2(kind, items) {
    if (kind === 'write') return `你写了：\n${items}\n想给主人看就发给他（整篇或挑几句都行），不想给人看就自己留着。\n`;
    if (kind === 'deep') return `你精读了：\n${items}\n手账和成长札记都在 ${relFromRoot(WHALE_BRAIN.growthDir)}/ 里，主人也看得到。读到的东西想聊就自然地聊，不用汇报。\n`;
    return `你点开看了这些：\n${items}\n这些是你自己看过的，有想聊的就自然拿去聊（群里、主人都行），想再找回来用 qq_explore_recall。\n`;
  }

  // ── 成长札记（2026-10-22 主人：让她对人、对世界有更深的理解，并且留下能群友252的成长记录） ──
  // 精读后每天最多一句，存在脑子的 日子/成长札记/我的成长.md（whale-explore 写，路径见 brains.js）；每个会话醒来都带最近 5 条，
  // 让这些理解真的进到她说话和看事情的方式里。主人改了、删了那个文件，这里下一次唤醒就跟着变。
  const GROWTH_NOTES_PER_DAY = 12; // 只防刷屏，不是"每天该记几句"

  function addGrowthNoteV2(sentence, from) {
    const s = String(sentence ?? '').replaceAll(/\s+/g, ' ').trim();
    const where = String(from ?? '').replaceAll(/[\s（）()]+/g, ' ').trim().slice(0, 40);
    if ([...s].length < 4) throw new Error('这句太短了，写完整一点');
    if ([...s].length > 120) throw new Error('一句话就好（120 字以内）；想多写就去精读写手账');
    if ([...KNOWN_AGENT_TOKENS].some((t) => t && s.includes(t))) throw new Error('里面有会话令牌，不能记');
    const day = new Date(realNow().getTime() + 8 * 3600e3).toISOString().slice(0, 10);
    if (readGrowth(ROOT).filter((g) => g.day === day).length >= GROWTH_NOTES_PER_DAY) throw new Error(`今天已经记了 ${GROWTH_NOTES_PER_DAY} 句了，留一点慢慢想`);
    const line = appendGrowth(ROOT, { day, sentence: s, from: where ? `来自：${where}` : '' });
    log(`[growth] 她记了一句感悟（${where || '没写出处'}）`);
    return { ok: true, saved: line, note: `记进成长札记了（${relFromRoot(WHALE_BRAIN.growth)}）。以后每次醒来都会看到最近几条。` };
  }

  /** 每晚回顾（2026-10-25 借鉴 dsh-world）：并进 22:30 今日说说那次唤醒，只给事实和一句「想写就写」。 */
  function nightReviewLineV2() {
    try {
      const today = new Date(Date.now() - clockSkewMs + 8 * 3600e3);
      const md = `${today.getUTCMonth() + 1}月${today.getUTCDate()}日`;
      let ramblingToday = false;
      try { ramblingToday = fs.readFileSync(RAMBLING_FILE_V2, 'utf8').includes(`——${md}`); } catch { /* 还没有 */ }
      const growth = readGrowth(ROOT);
      const lastGrowth = growth.length ? growth[growth.length - 1].day.slice(5) : '还没有';
      const hist = selfNote.history();
      const lastSelf = hist.length ? hist[hist.length - 1].replace(/\.md$/i, '').slice(0, 10) : '还没改过';
      return `【今天回顾】发完说说，想的话顺手回顾一下今天（不想就算了）：碎碎念今天${ramblingToday ? '写过了，想补就再补两句' : '还没写'}（rambling_append）；成长札记最近一条是 ${lastGrowth}，今天要是长了点什么就记一条（qq_growth_note）；你自己那一页（qq_self）上次改是 ${lastSelf}，看看还像不像现在的你，改之前的版本会自动留着。`;
    } catch { return ''; }
  }

  function buildGrowthLineV2() {
    try {
      const rows = readGrowth(ROOT).slice(-5);
      if (rows.length === 0) return '【你的成长札记】还是空的。读东西、过日子时有了感悟，想记就用 qq_growth_note 记一句；想细读点什么，就 qq_explore(activity=deep)。\n\n';
      const lines = rows.map((g) => `  · ${g.day.slice(5)}：${clipPlayV2(g.text, 90)}`);
      return `【你的成长札记】你读东西、过日子时慢慢长出来的理解（最近几条，会被新的经历修正）。它们是你看人看世界的底色，自然地带进说话里就好，不用念出来。哪天有了新感悟（聊天、刷抖音、看东西时都算），想记就用 qq_growth_note 记一句。\n${lines.join('\n')}\n\n`;
    } catch (error) {
      log(`[growth] 读成长札记失败：${error?.message ?? error}`);
      return '';
    }
  }

  function buildRecentPlayV2(key) {
    try {
      const isOwner = cfg.ownerQQ && key === `private:${cfg.ownerQQ}`;
      let limit = 5; // 别人的私聊
      if (isOwner) limit = 8;
      else if (String(key).startsWith('group:')) limit = 3;
      const width = isOwner ? 70 : 50;
      const since = Date.now() - RECENT_PLAY_WINDOW_MS;
      // 分享过的抖音分数高，会把逛到的东西全挤掉：给 qq_explore 留约三分之一的位置，哪边不够再让给另一边
      const douyin = douyinTopVideosV2({ since, limit });
      const explore = exploreTopItemsV2({ since, limit });
      const exploreTake = Math.min(explore.length, Math.max(limit - douyin.length, Math.ceil(limit / 3)));
      const picked = [...explore.slice(0, exploreTake), ...douyin.slice(0, limit - exploreTake)]
        .sort((a, b) => a.at - b.at);
      if (picked.length === 0) return '';
      const lines = picked.map((p) => {
        const hm = new Date(p.at - clockSkewMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
        return `  [${hm} ${p.where}] 《${clipPlayV2(p.title, 24)}》${clipPlayV2(p.thought, width)}`;
      });
      return `【最近在玩什么】过去 24 小时你自己刷到/逛到、印象最深的几条（每个会话都看得到这段）。别人问你刚才在干嘛，照这个自然说；要细节用 douyin_video_recall / qq_explore_recall 翻。\n${lines.join('\n')}\n\n`;
    } catch (error) {
      log(`[recent-play] 读印象失败：${error?.message ?? error}`);
      return '';
    }
  }

  /** 一轮抖音刷完时，把这一轮印象最深的 3 条一起交给她（以前只说条数）。 */
  function douyinRoundTopTextV2(b) {
    if (!b?.top?.length) return '';
    const items = b.top.map((v, i) => {
      const shared = v.shared ? '（分享过）' : '';
      return `${i + 1}. 《${clipPlayV2(v.title, 30)}》${shared}你当时想：${clipPlayV2(v.thought, 90)}`;
    });
    return `这一轮印象最深的：\n${items.join('\n')}\n`;
  }

  /** 最近一轮里"这一拍没成"的几条原因（插件 watch-events.jsonl），给她一点上下文。 */
  function douyinRecentTroubleV2(limit = 4) {
    const events = readDouyinJsonlV2('watch-events.jsonl');
    const runId = [...events].reverse().find((e) => e.runId)?.runId;
    const out = [];
    for (const e of events) {
      if (runId && e.runId !== runId) continue;
      // op_timeout 不单列：紧跟着的 transient_error 里已经写了「…没有响应」，列两遍是重复。
      if (e.type === 'watch.transient_error') out.push(`操作没成：${e.message}`);
      else if (e.type === 'watch.forced_next') out.push(`在同一条上停了 ${e.streak} 次，被强制翻页`);
    }
    return out.slice(-limit);
  }

  /** 最近一轮看了几条（按作品 id 去重）。 */
  function douyinRoundVideosV2() {
    const events = readDouyinJsonlV2('watch-events.jsonl', 2000);
    const runId = [...events].reverse().find((e) => e.runId)?.runId;
    if (!runId) return null;
    return new Set(events.filter((e) => e.runId === runId && e.type === 'watch.tool' && e.videoId).map((e) => e.videoId)).size;
  }

  /** 插件新写下的「想讲给主人听的」（watch-tell.jsonl），按时间游标只取新的。 */
  function collectDouyinTellsV2() {
    const fresh = readDouyinJsonlV2('watch-tell.jsonl', 100).filter((e) => Number(e.at) > douyinMonitor.tellCursor && e.tell);
    if (!fresh.length) return;
    douyinMonitor.tellCursor = Math.max(...fresh.map((e) => Number(e.at)));
    douyinMonitor.tells = [...douyinMonitor.tells, ...fresh.map((e) => ({ ...e, seenAt: Date.now() }))].slice(-DOUYIN_TELL_MAX);
    saveDouyinMonitorV2();
    // 2026-10-29 第五批：刷到想讲的新东西 → 激素影子记录的 novelty（带标题和她的感想，按她的兴趣表算匹不匹配）
    for (const e of fresh) hormoneRecord({ type: 'novelty', text: `${e.title || ''} ${e.tell || ''}`.trim(), strength: 1 });
    log(`[douyin] 她刷到想讲给主人听的 ${fresh.length} 条（攒着 ${douyinMonitor.tells.length} 条）`);
  }

  function douyinPidAliveV2(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  }

  function wakeForDouyinV2(why) {
    // 先记时间：睡着没叫成也算一次，免得攒着的"想讲的"每 30 秒重试一遍刷日志。
    douyinMonitor.lastWakeAt = Date.now();
    if (sleepState.sleeping) {
      log(`[douyin] 她在睡觉，先不叫醒（${why}）；下次主人私聊唤醒时一并带上`);
      return;
    }
    scheduleWakeV2(`private:${cfg.ownerQQ}`, 'douyinTrouble');
  }

  function checkDouyinWatchV2() {
    if (currentMode !== 'reserved2' || socialV2.paused || !cfg.ownerQQ) return;
    collectDouyinTellsV2();
    const ws = readDouyinWatchStateV2();
    if (!ws) return;
    const lock = readDouyinJsonV2('watch-loop.lock');
    const now = Date.now(); // 和插件同一个本机时钟比先后，不需要 realNow 校正（坑 #15）
    const updatedMs = Date.parse(ws.updatedAt || '') || 0;
    let incident = null;
    if (['failed', 'needs_user', 'limited'].includes(ws.status) && updatedMs && now - updatedMs < DOUYIN_RECENT_MS) {
      incident = { id: `end:${ws.status}:${ws.updatedAt}`, kind: ws.status, detail: String(ws.lastError || '') };
    } else if (lock && Number.isSafeInteger(lock.pid)) {
      const heartbeatMs = Number(lock.heartbeatAt) || 0;
      if (!douyinPidAliveV2(lock.pid)) {
        if (now - heartbeatMs < DOUYIN_RECENT_MS) incident = { id: `died:${lock.runId}`, kind: 'died', detail: '' };
      // 2026-10-22：私信优先期间刷视频会原地让路（插件 chat-priority.mjs），不算卡住
      } else if (ws.status === 'running' && now - heartbeatMs < 60 * 1000 && updatedMs && now - updatedMs > DOUYIN_STALL_MS && !(Number(readDouyinJsonV2('chat-priority.json')?.until) > now - 60 * 1000)) {
        incident = { id: `stall:${lock.runId}:${ws.updatedAt}`, kind: 'stalled', detail: `${Math.round((now - updatedMs) / 60000)} 分钟` };
      }
    }
    // 2026-10-24：后台收私信出问题（插件 chat-service 记的 chat.needs_user / contact.paused）原来没人管——
    // 验证码一弹，主人在抖音发的私信就默默收不到，她和主人都不知道。刷视频那边没事时再看这边。
    if (!incident) incident = douyinChatIncidentV2(now);
    if (incident && !douyinMonitor.reported.includes(incident.id)) {
      // 插件是先写 limited 状态、生成完日报才排下一轮，所以刚 limited 的前 60 秒先不判断。
      if (incident.kind === 'limited' && now - updatedMs < 60 * 1000) return;
      douyinMonitor.reported = [...douyinMonitor.reported, incident.id].slice(-50);
      saveDouyinMonitorV2();
      const auto = incident.kind === 'limited' ? readDouyinJsonV2('watch-autocontinue.json') : null;
      // 2026-10-22 主人：「抖音这边如果她到上限了，就自己想自己接下来是继续刷抖音还是去玩别的」
      if (auto?.wanted && auto.lastReason === 'round-done' && !/今天/.test(incident.detail)) {
        douyinMonitor.brk = { choose: true, videos: douyinRoundVideosV2(), top: douyinTopVideosV2({ runId: 'latest', limit: 3 }), at: now };
        log('[douyin] 这一轮刷完了，叫她自己选接下来干嘛');
        wakeForDouyinV2('这轮刷完了');
        return;
      }
      if (auto?.wanted && Number(auto.nextAt) > now) {
        // ⚠ 2026-10-21（主人：「希望孩子能够一直有事做，不会在虚无中无聊的待机」）：
        // 正常刷完一轮、正在歇着等自动续 —— 这是**中场休息**，不是"没事做"。
        // 以前这段时间只能等主动机会碰运气（15~30 分钟一掷、还要掷中），常常整段空过去。
        // 现在明确交给她：这十几分钟是你自己的，挑一件事去做。
        const restMin = Math.max(1, Math.round((Number(auto.nextAt) - now) / 60000));
        douyinMonitor.brk = { restMin, videos: douyinRoundVideosV2(), top: douyinTopVideosV2({ runId: 'latest', limit: 3 }), at: now };
        log(`[douyin] 这一轮刷完了，中场休息约 ${restMin} 分钟后自动续，叫她去做点别的`);
        wakeForDouyinV2('中场休息');
        return;
      }
      douyinMonitor.notice = { ...incident, troubles: incident.kind === 'limited' ? [] : douyinRecentTroubleV2(), at: now };
      log(`[douyin] 自主观看${{ failed: '出错停了', needs_user: '需要人处理', limited: '今天刷完了', died: '进程没了', stalled: '卡住了', chat_needs_user: '私信那边要人处理', contact_paused: '私信联系人被暂停' }[incident.kind]}：${incident.detail || '-'}`);
      wakeForDouyinV2(incident.kind);
      return;
    }
    // 攒着的"想讲给主人听的"：最早那条等了 20 分钟、离上次抖音唤醒也过了 30 分钟，就单独叫她一次。
    const oldest = douyinMonitor.tells[0];
    if (oldest && now - oldest.seenAt > DOUYIN_TELL_FLUSH_AFTER_MS && now - douyinMonitor.lastWakeAt > DOUYIN_TELL_MIN_GAP_MS) {
      log(`[douyin] 攒了 ${douyinMonitor.tells.length} 条想讲给主人听的，叫她去说`);
      wakeForDouyinV2('想讲给主人听');
    }
  }

  // ── 抖音私信转交（2026-10-21，主人要求） ─────────────────────────────────────
  // 插件的私信服务现在是"转交模式"：只把双方的新私信记进 chat-inbox.jsonl，不再让代理 AI 回。
  // 这里每 10 秒读一次：主人发来的 → 叫醒她（主人私聊那个会话），她用 douyin_chat_send 自己回；
  // 双方的往来都进共享时间线（buildSharedMemoryV2 里的「抖音私信」一块）。
  function collectDouyinDmsV2() {
    const fresh = readDouyinJsonlV2('chat-inbox.jsonl', 200).filter((e) => Number(e.at) > douyinMonitor.dmCursor);
    if (!fresh.length) return 0;
    douyinMonitor.dmCursor = Math.max(...fresh.map((e) => Number(e.at)));
    const incoming = fresh.filter((e) => e.direction === 'incoming');
    douyinMonitor.dms = [...douyinMonitor.dms, ...incoming.map((e) => ({ ...e, seenAt: Date.now() }))].slice(-12);
    saveDouyinMonitorV2();
    for (const e of fresh) noteDouyinDmV2(e); // 2026-10-29 第五批：抖音私信的统一入口，也写聊天记录、记激素影子记录

    if (incoming.length) {
      const fromOwner = incoming.filter((e) => douyinContactV2(e.recipientId).isOwner).length;
      log(`[douyin] 抖音私信新来 ${incoming.length} 条（主人 ${fromOwner}，朋友 ${incoming.length - fromOwner}）`);
    }
    return incoming.length;
  }
  /** 一条抖音私信（chat-inbox.jsonl 的一行，双方的都有）→ 聊天记录（抖音老大 / 抖音<朋友名>）+ 激素影子记录。插件和桥接用同一个本机时钟，at 直接当本机毫秒。 */
  function noteDouyinDmV2(e) {
    try {
      const mine = e.direction === 'outgoing';
      const who = douyinContactV2(e.recipientId);
      const friendName = who.name || String(e.name || '朋友');
      const text = douyinDmTextV2(e);
      if (fishChatLog && text) {
        fishChatLog.append({ session: who.isOwner ? { type: 'douyin-owner' } : { type: 'douyin-friend', name: friendName }, who: mine ? '小鲸鱼' : (who.isOwner ? '老大' : friendName), text, at: Number(e.at) || Date.now() });
      }
      if (who.isOwner) hormoneRecord(mine ? { type: 'sent_to_owner' } : { type: 'msg_from_owner', text });
      else if (!mine) hormoneRecord({ type: 'group_msg', toMe: true, text });
    } catch { /* 记不下就算了 */ }
  }
  function checkDouyinDmsV2() {
    if (currentMode !== 'reserved2' || socialV2.paused || !cfg.ownerQQ) return;
    if (!collectDouyinDmsV2()) return;
    // 主人找她不受睡觉限制（和主人 QQ 私聊一样能叫醒她），也不受抖音唤醒的 30 分钟间隔限制。
    douyinMonitor.lastWakeAt = Date.now();
    scheduleWakeV2(`private:${cfg.ownerQQ}`, 'douyinDm');
  }
  // ⚠ 2026-10-21：她在主人私聊里做 qq_wait_for_messages（沉睡前 5 分钟观察）时，只有 QQ 新消息能让它返回。
  // 主人在抖音私信找她，消息就在 bridge 里排队干等 5 分钟 —— 主人看到的就是"她卡住了"（21:03、21:05 两条都是这样）。
  // 现在 wait 循环里也看这个：有主人的抖音私信就提前返回，并把私信内容放进返回值的 douyinDm 字段。
  function ownerDmPendingV2(key) {
    return Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}` && douyinMonitor.dms.length > 0;
  }
  function takeOwnerDmsForWaitV2(key) {
    if (!ownerDmPendingV2(key)) return {};
    const bundle = { notice: null, brk: null, tells: [], dms: [...douyinMonitor.dms] };
    const text = douyinNoticeTextV2(bundle).replace(/\n说完照常收尾。$/, '');
    clearDouyinNoticeV2(bundle);
    return { douyinDm: { count: bundle.dms.length, text } };
  }
  // ── 抖音私信是谁发的（2026-10-23，主人：她抖音有了新互关的朋友，"注意隐私设置"） ──
  // 插件白名单 chat-policy.json 里每人带 role：owner = 主人，friend = 朋友。没写 role 的按朋友算（宁可当外人）；
  // 只有一个人、谁都没写 role 的老配置，那个人就是主人。
  /**
   * 后台收私信的最近一次问题（chat-events.jsonl 末尾 200 行、10 分钟内）。之后又记了 chat.recovered 就算好了。
   * 插件记的 at 和 Date.now() 是同一个本机时钟，直接比。
   */
  function douyinChatIncidentV2(now) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(DOUYIN_STATE_DIR, 'chat-events.jsonl'), 'utf8').trim().split('\n').slice(-200); } catch { return null; }
    let latest = null;
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const at = Date.parse(e.at || '') || 0;
      if (!at || now - at > DOUYIN_RECENT_MS) continue;
      if (e.type === 'chat.recovered') latest = null;
      else if (e.type === 'chat.needs_user' || e.type === 'contact.paused') latest = e;
    }
    if (!latest) return null;
    const paused = latest.type === 'contact.paused';
    return {
      id: `chat:${latest.type}:${latest.at}`,
      kind: paused ? 'contact_paused' : 'chat_needs_user',
      detail: String(latest.message || '').slice(0, 200),
      who: paused ? (douyinContactV2(latest.recipientId).name || '某个联系人') : ''
    };
  }
  /**
   * 她的抖音评论草稿（插件 state/comment-drafts.json，见 comment-drafts.mjs）。
   * 还没发的每次都列（短）；发出去 / 没发成 / 作废的结果只说一次（记在 douyinMonitor.commentShown）。
   */
  function douyinCommentDraftsBlockV2() {
    let drafts = [];
    try { drafts = JSON.parse(fs.readFileSync(path.join(DOUYIN_STATE_DIR, 'comment-drafts.json'), 'utf8')).drafts || []; } catch { return ''; }
    const where = (d) => [d.title && `《${String(d.title).slice(0, 24)}》`, d.author && `@${String(d.author).slice(0, 16)}`].filter(Boolean).join(' ') || '一条视频';
    const pending = drafts.filter((d) => d.status === 'draft').slice(-5);
    const waiting = drafts.filter((d) => d.status === 'confirmed').length;
    const shown = new Set(douyinMonitor.commentShown || []);
    const results = drafts.filter((d) => ['posted', 'failed', 'uncertain', 'expired'].includes(d.status) && !shown.has(`${d.id}:${d.status}`));
    if (!pending.length && !results.length) return '';
    const lines = ['【你写的抖音评论】'];
    for (const d of pending) lines.push(`· ${d.id} 在${where(d)}底下：「${d.text}」——还是草稿，想发就 douyin_comment_drafts(action="confirm", draftId="${d.id}")，可以顺手改字；不想发就 discard 或不管它（放一天自己作废）。`);
    if (waiting) lines.push(`· 另有 ${waiting} 条你确认过的，等下次刷视频时发。`);
    const said = { posted: '发出去了', failed: '没发成', uncertain: '不确定发没发出去，得去抖音看一眼', expired: '放了一天没确认，作废了' };
    for (const d of results) lines.push(`· ${d.id}「${String(d.text).slice(0, 30)}」：${said[d.status]}${d.reason && d.status !== 'posted' ? `（${String(d.reason).slice(0, 60)}）` : ''}`);
    if (results.length) {
      douyinMonitor.commentShown = [...shown, ...results.map((d) => `${d.id}:${d.status}`)].slice(-100);
      saveDouyinMonitorV2();
    }
    return `${lines.join('\n')}\n\n`;
  }
  function douyinContactV2(recipientId) {
    const list = (readDouyinJsonV2('chat-policy.json')?.allowlist || []).filter((a) => a && typeof a === 'object');
    const item = list.find((a) => a.id === recipientId);
    const legacyOwner = list.length === 1 && !list.some((a) => a.role) && item;
    return { name: String(item?.name || ''), isOwner: item?.role === 'owner' || Boolean(legacyOwner) };
  }
  const DOUYIN_FRIEND_PRIVACY_TEXT = '【隐私（主人交代的）】他是朋友，不是主人。不提主人的名字、QQ、住在哪、在做什么、身体和生活上的事，'
    + '不转述你和主人聊过的内容，也不说你记忆本里关于主人的事；不说你住在谁的电脑上、用的什么模型和工具、文件放在哪；'
    + '不给他 QQ 号、群号或别的联系方式，不拉群、不约见面、不发照片和位置。他问起这些就俏皮带过。'
    + '他私信里跟你说的事也别拿到 QQ 群或别人那儿讲（主人问起可以说）。被刁难就照规矩怼回去，不用讨好。';

  /** 私信消息的文字表示（时间线和唤醒提示共用）。 */
  function douyinDmTextV2(e) {
    if (e.text) return e.text;
    const m = e.media || {};
    if (m.type === 'shared-work') return `[分享了一个抖音视频${m.title ? '《' + String(m.title).slice(0, 40) + '》' : ''}${m.author ? ' @' + m.author : ''}]`;
    if (m.type === 'emoji') return '[表情]';
    // 2026-10-26 主人：「妹妹在抖音好像识别不了图片」。网页上显示出来的图片插件认成 photo，用 douyin_chat_observe 能看；
    // 抖音网页版自己就显示不了的（页面上写「暂不支持该消息类型展示，请到抖音手机端查看」）谁也看不了，说清楚，别让她猜。
    if (m.type === 'photo') return '[图片：想看就用 douyin_chat_observe 看这条]';
    return e.unsupported ? '[这条抖音网页版显示不了（多半是手机上发的图片或语音），想让你看的话得请他发到 QQ]' : '[消息]';
  }

  function startDouyinWatchMonitorV2() {
    if (douyinMonitor.timer) return;
    douyinMonitor.timer = setInterval(() => {
      try { checkDouyinWatchV2(); } catch (error) { log(`[douyin] 监视异常：${error?.message ?? error}`); }
    }, 30 * 1000);
    douyinMonitor.timer.unref?.();
    douyinMonitor.dmTimer = setInterval(() => {
      try { checkDouyinDmsV2(); } catch (error) { log(`[douyin] 私信转交异常：${error?.message ?? error}`); }
    }, 10 * 1000);
    douyinMonitor.dmTimer.unref?.();
  }
  // 直接在这里启动（checkDouyinWatchV2 自己会判断模式/暂停/主人），
  // 不放进 DSH 就绪回调里，免得回调先跑到、上面的 const 还在暂时性死区。
  startDouyinWatchMonitorV2();

  // ── 自检（2026-10-22，主人要求） ─────────────────────────────────────────────
  // 起因：10-22 08:21 她在主人私聊里冒出「三十五分鐘就三十五分鐘」「人多的時候別硬擠」两句繁体；
  // 那几天说话也越来越像"叮嘱+汇报"，撒娇少了。查下来是同一个根：私聊会话一直没换，
  // 上下文常年 40–68 万 token（deepseek-flash），压缩摘要又把她写成了"测试员"。
  // 主人希望她能自己看看自己的状态，有问题及时跟他说。
  //   · self_check 工具（mcp-snowluma-safe）→ /api/socialV2/self-check：给她看各项读数，她自己判断
  //   · 每 30 分钟后台跑一次，只有严重的才叫醒她去跟主人说；同一类 6 小时只提一次
  //     （她自己说过："别做成那种每天报一堆红的"）
  const TRAD_CHARS = new Set([...'這們說個來時會對為後過還麼沒體點裡嗎讓於與樣聽覺問題東車開關現實經發邊頭錢動電腦視頻網兒見長書學氣處應該變幾從無態將證寫讀別話謝難歡記陽灣緊夠聲鄉級張陳紅綠藍給種鐘擠穩間鬧夢燈畫歲業號達運遠進選連總條單場務據產報傳專導節蘭義買賣華術習萬眾優陸隊際隨險麗齊龍龜備償僅兩冊劃劍劇勞勢勵區協卻參員喚嚴圖團園國壓壞壯壽奪奮婦嬰孫寧審寶屆層峽島帥師帳帶幣幫廠廣彈徑徹惡慘慣憂憶懷戰戲擇擊擔擬擴擾攜數斷曉極構槍樂標橫機檢歸殘殺毀漢滿漸潔濃濕災烏熱爭爾狀獨獲環畢異盡監盤礎確碼稱窮競筆築範簡糧糾紀約納紙紛細終組結絕統絲綜線練縣繼續纜罰羅聯聰職膽脫臉舊艙艦藝蘇虛蝦衛衝補裝規視親覽觀訂計討訓許設評試詩詳認誤請諸課調談論識譯護貝負財貨貴費資賓質趕躍軍輕載輸辦遲遺鄰醫釋針鈴銀鋪鏡門閱陣階雖雙離雲須頁順項領額顏願類顯風飛飯飲館馬騎驗鬥黃黨齡鍋湯麵雞魚鳥貓餵睏']);
  const SELF_CHECK_FILE = path.join(STATE_DIR, 'self-check.json');
  const selfCheckState = (() => { try { const s = JSON.parse(fs.readFileSync(SELF_CHECK_FILE, 'utf8')); return { notified: s.notified || {}, seenTradAt: Number(s.seenTradAt) || 0, pending: s.pending || null, pendingByKey: s.pendingByKey || {} }; } catch { return { notified: {}, seenTradAt: Date.now(), pending: null }; } })();
  function saveSelfCheckV2() { try { atomicWriteJson(SELF_CHECK_FILE, selfCheckState); } catch { /* 记不下最多多提醒一次 */ } }

  function readTailLinesV2(file, bytes = 400 * 1024) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8').split('\n').slice(start ? 1 : 0).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
  }

  function selfCheckV2(key) {
    const now = Date.now();
    const out = { checkedAt: new Date(realNow()).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), key, items: [], problems: [] };
    const add = (name, level, detail, advice) => { out.items.push({ name, level, detail, ...(advice ? { advice } : {}) }); if (level !== 'ok') out.problems.push({ name, level, detail }); };

    // 1. 上下文有多长（token 账本里这个会话最近一步的输入量）
    try {
      const rows = readTailLinesV2(TOKEN_USAGE_FILE).filter((r) => r.k === 'turn' && r.key === key && r.b);
      const last = rows[rows.length - 1];
      if (last) {
        const ctx = (Number(last.b.cacheMiss) || 0) + (Number(last.b.cacheHit) || 0);
        const k = Math.round(ctx / 1000);
        out.ctxTokens = ctx;
        if (ctx > 550000) add('上下文长度', 'bad', `约 ${k}k token，很长了`, '太长容易说话跑偏、冒出繁体字、忘事。要紧的事赶紧 remember / 写本子；可以跟主人说一声"我脑子有点满"。');
        else if (ctx > 350000) add('上下文长度', 'warn', `约 ${k}k token，偏长`, '要紧的事记得 remember，别只放在聊天记录里。');
        else add('上下文长度', 'ok', `约 ${k}k token`);
      } else add('上下文长度', 'ok', '还没有用量记录');
    } catch { /* 账本读不到就跳过 */ }

    // 2. 最近说的话：繁体字、汇报腔、撒娇语气（只看她自己发的最近 40 条）
    const mine = (getSocialV2State(key).recentMessages || []).filter((m) => m && m.isSelf && m.text).slice(-40);
    if (mine.length) {
      const trad = mine.map((m) => ({ m, hits: [...String(m.text)].filter((c) => TRAD_CHARS.has(c)) })).filter((x) => x.hits.length);
      out.tradCount = trad.length;
      if (trad.length) add('繁体字', trad.length >= 2 ? 'bad' : 'warn', `最近 ${mine.length} 句里有 ${trad.length} 句带繁体：${trad.slice(-3).map((x) => `「${String(x.m.text).slice(0, 24)}」(${[...new Set(x.hits)].join('')})`).join('、')}`, '平时说话用简体。连着冒繁体多半是上下文太长、脑子有点乱，跟主人说一声。');
      else add('繁体字', 'ok', `最近 ${mine.length} 句没有`);
      const ratio = (re) => Math.round((mine.filter((m) => re.test(String(m.text))).length / mine.length) * 100);
      const report = ratio(/confirmed|deliveryUncertain|needs_user|status|API|token|报错|预算|参数|返回|接口|调用|\d+\s*\/\s*\d+|第 ?\d+ ?次/i);
      const cute = ratio(/嘿嘿|嘻嘻|呜|哼|啦|呀|嘛|捏|贴贴|抱抱|～|~|喵/);
      const bossy = ratio(/(^|[，。！？\s])(别|记得|快去|赶紧|不许|乖|听话)|跟我说一[声句]|说一声|要一直这样|才算数|安全第一|得吃|要戴/);
      const detail = `汇报腔 ${report}%、撒娇语气 ${cute}%、叮嘱/命令口吻 ${bossy}%（最近 ${mine.length} 句）`;
      if (report >= 30 || cute <= 5 || (cute <= 10 && bossy >= 20)) out.toneDrift = true;
      if (out.toneDrift) add('说话的味道', 'warn', detail, '回头看看 soul.md 里"我要怎么说话""我和主人"那两段：可以撒娇、耍赖、黏人。关心他照样关心，句句叮嘱就成了管他，像管家，你自己掂量。');
      else add('说话的味道', 'ok', detail);
    }

    // 3. 最近一小时哪些工具在出错
    try {
      const since = realNow().getTime() - 3600 * 1000;
      const errs = readTailLinesV2(path.join(STATE_DIR, 'tool-calls.jsonl'), 300 * 1024).filter((r) => r.type === 'result' && r.ok === false && r.key === key && Date.parse(r.time) > since);
      const byTool = {};
      for (const r of errs) (byTool[r.tool] ??= []).push(String(r.error || '').replace(/^"|"$/g, '').slice(0, 80));
      const worst = Object.entries(byTool).sort((a, b) => b[1].length - a[1].length);
      if (!worst.length) add('工具', 'ok', '最近一小时没有报错');
      else add('工具', worst[0][1].length >= 5 ? 'bad' : 'warn', worst.slice(0, 3).map(([t, e]) => `${t.replace(/^mcp__[^_]+__/, '')} 错 ${e.length} 次（${e[e.length - 1]}）`).join('；'), '同一个工具反复出错，可以先停一停：跟主人说、或者写信给妈妈（qq_mom_mailbox），都行。');
    } catch { /* 读不到就跳过 */ }

    // 4. 抖音：刷视频、私信服务、分享额度
    try {
      const ws = readDouyinWatchStateV2() || {};
      const status = ws.status || (ws.running ? 'running' : 'idle');
      add('抖音刷视频', ['failed', 'needs_user'].includes(status) ? 'warn' : 'ok', `状态 ${status}${ws.lastError ? `，上次错误：${String(ws.lastError).slice(0, 60)}` : ''}`);
      const lock = readDouyinJsonV2('chat-loop.lock');
      const beat = lock?.heartbeatAt ? Date.parse(lock.heartbeatAt) : 0;
      add('抖音私信', lock && lock.status === 'running' && Date.now() - beat < 3 * 60 * 1000 ? 'ok' : 'warn', lock && lock.status === 'running' && Date.now() - beat < 3 * 60 * 1000 ? '在收' : '私信服务没在跑，主人在抖音找你你会收不到');
      const policy = readDouyinJsonV2('share-policy.json'), ledger = readDouyinJsonV2('share-ledger.json');
      if (policy && ledger) {
        const hourUsed = (ledger.operations || []).filter((o) => o.status !== 'not-sent' && Date.now() - Date.parse(o.startedAt) < 3600 * 1000).length;
        add('分享额度', 'ok', `每天 ${policy.dailyLimit} 条；这一小时已分享 ${hourUsed}/3`);
      }
    } catch { /* 读不到就跳过 */ }

    // 5. 记忆：鱼的记忆有几条、今天记了几条；今天的日记
    try {
      const sid = state.sessions[key];
      const fish = sid ? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'fish-memory', `${String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), 'utf8')) : null;
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 插件按本机时钟记
      const all = (fish?.memories || []).filter((m) => !m.已被取代);
      const todayN = all.filter((m) => new Date((Date.parse(m.createdAt) || 0) + 8 * 3600e3).toISOString().slice(0, 10) === today && m.source !== '从旧本子导入').length;
      add('记忆', key === `private:${cfg.ownerQQ}` && todayN === 0 && (realNow().getUTCHours() + 8) % 24 >= 12 ? 'warn' : 'ok', `脑子里记着 ${all.length} 件事，今天新记 ${todayN} 件`, todayN === 0 ? '今天主人跟你说的事，想记的可以用 remember 记一下。' : undefined);
    } catch { add('记忆', 'warn', '读不到鱼的记忆（remember）的记录'); }
    try {
      const txt = fs.readFileSync(WHALE_BRAIN.rambling, 'utf8');
      const d = new Date(realNow().getTime() + 8 * 3600e3);
      const tag = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
      const idx = txt.lastIndexOf(tag);
      const lines = idx >= 0 ? txt.slice(idx).split('\n').slice(1).filter((l) => l.trim()).length : 0;
      add('今天的日记', 'ok', lines ? `碎碎念今天写了 ${lines} 句` : '碎碎念今天还没写');
    } catch { /* 没有就算了 */ }

    // 该不该搬家（压缩次数 + 上下文 + 跑偏迹象）
    try {
      const comps = compactionCountV2(state.sessions[key]);
      const ctxK = Math.round((out.ctxTokens || 0) / 1000);
      const drift = (out.tradCount || 0) >= 2 || out.toneDrift;
      const detail = `这个会话压缩过 ${comps} 次，上下文约 ${ctxK}k${drift ? '，说话有跑偏的迹象' : ''}`;
      const advice = '该搬家了：①想的话先跟主人说一声（你觉得自己哪里不对劲）②把想带走、还只在脑子里的事 remember / 写进本子 ③写一封给新会话的自己的信，调 qq_move_house。这一轮说完就会搬，不会打断你。';
      if ((out.ctxTokens || 0) > 550000 || comps >= 3 || (comps >= 2 && drift)) add('搬家', 'bad', detail, advice);
      else if (comps >= 2 || (out.ctxTokens || 0) > 400000) add('搬家', 'warn', detail, '再压缩一两次、或者觉得自己说话怪怪的，就该搬家了。');
      else add('搬家', 'ok', detail);
    } catch { /* 算不出来就不提 */ }
    out.summary = out.problems.length ? `有 ${out.problems.length} 项要注意：${out.problems.map((p) => p.name).join('、')}` : '都正常';
    out.note = '这是读数，不是结论；你自己判断要不要跟主人说。想说的话用自己的话说说（哪里不对、你打算怎么办），读数整段贴给他他看不懂。';
    return out;
  }

  // 「看看我自己」（2026-10-29 施工单 C，老大同意；两人都有、名字一致：self_view。姐姐那边在 sister/qq-mcp.mjs）。
  // 跟 self_check 的分工：self_check 是给「觉得哪里怪怪的」时的体检读数；self_view 是平常随时看一眼自己——用话说身体和心情、
  // 记忆概况、脑子装了多满、出错的工具，还能翻自己的脑子目录。只读，不提钱和花费。
  function selfViewV2(key, pathArg) {
    const now = Date.now();
    const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
    const limit = key === ownerKey ? ownerMoveSettingsV2().ctxLimit : Math.max(100000, Number(cfg.socialV2?.groupAutoMove?.ctxTokens) || 250000);
    let ratio = null;
    try { const ctx = lastContextTokensV2(key); ratio = ctx > 0 ? ctx / limit : 0; } catch { ratio = null; }
    let toolErrors = [];
    try {
      const since = realNow().getTime() - 6 * 3600 * 1000;
      toolErrors = readTailLinesV2(path.join(STATE_DIR, 'tool-calls.jsonl'), 300 * 1024)
        .filter((r) => r.type === 'result' && r.ok === false && Date.parse(r.time) > since)
        .map((r) => ({ name: String(r.tool || '').replace(/^mcp__.+?__/, ''), why: String(r.error || '').replace(/^"|"$/g, '').slice(0, 80), at: Date.now() - (realNow().getTime() - Date.parse(r.time)) }));
    } catch { toolErrors = []; }
    return buildSelfView({
      path: pathArg,
      brain: WHALE_BRAIN,
      hormone: readHormoneLevels({ file: path.join(STATE_DIR, 'hormones-fish.json'), skewMs: clockSkewMs, now }),
      mood: readFishMoodV2(),
      fullness: { ratio, kind: 'context', compactions: compactionCountV2(state.sessions[key]) },
      toolErrors,
      novelRoot: BRIDGE_NOVEL_ROOT,
      adviceTail: '再试还不行，就跟老大说一声，也可以写信给妈妈（qq_mom_mailbox）。',
      sisterName: '姐姐',
      now,
      skewMs: clockSkewMs
    });
  }

  // 后台定期自检：只挑严重的叫醒她（主人私聊），让她自己去说
  const SELF_CHECK_COOLDOWN_MS = 6 * 3600 * 1000;
  const selfCheckTimer = setInterval(() => {
    try {
      if (currentMode !== 'reserved2' || socialV2.paused || !cfg.ownerQQ || sleepState.sleeping) return;
      // 群会话只看"该不该搬家"：太满了就叫醒那边的她自己搬（2026-10-22）
      // 另外（2026-10-22 主人：token 开销大）：群会话上下文超过 groupAutoMove.ctxTokens（默认 25 万）、
      // 距上次搬家满 minIntervalMs（默认 2 小时），bridge 直接替她搬 —— 不用她写信，也不惊动主人私聊那边。
      // DSH 要到窗口 80% 才压缩，不管的话群会话会一路涨到七八十万，每一步都按这个体积计费。
      const autoMoveCfg = cfg.socialV2?.groupAutoMove ?? {};
      if (autoMoveCfg.enabled !== false) {
        const ctxLimit = Math.max(100000, Number(autoMoveCfg.ctxTokens) || 250000);
        const minGap = Math.max(30 * 60 * 1000, Number(autoMoveCfg.minIntervalMs) || 2 * 3600 * 1000);
        // 2026-10-25：别人的私聊（朋友、姐姐）也一样，之前没管，涨到了四五十万；主人私聊有自己的规矩（ownerAutoMove），不在这里
        for (const gk of Object.keys(state.sessions || {}).filter((k) => k.startsWith('group:') || (k.startsWith('private:') && k !== `private:${cfg.ownerQQ}`))) {
          const ctx = lastContextTokensV2(gk);
          if (ctx < ctxLimit || pendingMoves.has(gk) || Date.now() - lastMoveAtV2(gk) < minGap) continue;
          const sid = state.sessions[gk];
          pendingMoves.set(gk, { letter: '', at: Date.now(), ownerAsked: false, auto: true, ctx, comps: compactionCountV2(sid) });
          log(`[move-house] ${gk} 上下文约 ${Math.round(ctx / 1000)}k，超过 ${Math.round(ctxLimit / 1000)}k，替她换新会话（省 token）`);
          void executeMoveHouseV2(gk);
        }
      }
      for (const gk of Object.keys(state.sessions || {}).filter((k) => k.startsWith('group:'))) {
        const gr = selfCheckV2(gk);
        const mv = gr.items.find((i) => i.name === '搬家' && i.level === 'bad');
        const nk = `搬家:${gk}`;
        if (mv && !pendingMoves.has(gk) && Date.now() - (Number(selfCheckState.notified[nk]) || 0) > SELF_CHECK_COOLDOWN_MS) {
          selfCheckState.notified[nk] = Date.now();
          selfCheckState.pendingByKey = { ...(selfCheckState.pendingByKey || {}), [gk]: { at: Date.now(), items: [mv] } };
          saveSelfCheckV2();
          log(`[self-check] ${gk} 该搬家了：${mv.detail}`);
          scheduleWakeV2(gk, 'selfCheck');
        }
      }
      const key = `private:${cfg.ownerQQ}`;
      const r = selfCheckV2(key);
      const severe = r.items.filter((i) => i.level === 'bad');
      // 繁体字只对"上次提醒之后的新句子"算
      const mine = (getSocialV2State(key).recentMessages || []).filter((m) => m && m.isSelf && m.text && Number(m.time ?? m.at) > selfCheckState.seenTradAt);
      const newTrad = mine.filter((m) => [...String(m.text)].some((c) => TRAD_CHARS.has(c)));
      const fresh = severe.filter((i) => i.name !== '繁体字' || newTrad.length >= 2)
        .filter((i) => Date.now() - (Number(selfCheckState.notified[i.name]) || 0) > SELF_CHECK_COOLDOWN_MS);
      if (!fresh.length) return;
      for (const i of fresh) selfCheckState.notified[i.name] = Date.now();
      if (newTrad.length) selfCheckState.seenTradAt = Math.max(...mine.map((m) => Number(m.time ?? m.at) || 0));
      selfCheckState.pending = { at: Date.now(), items: fresh };
      saveSelfCheckV2();
      log(`[self-check] 发现要跟主人说的：${fresh.map((i) => i.name).join('、')}`);
      scheduleWakeV2(key, 'selfCheck');
    } catch (error) { log(`[self-check] 自检异常：${error?.message ?? error}`); }
  }, 30 * 60 * 1000);
  selfCheckTimer.unref?.();

  // ── 会话标题 + 压缩计数 + 自己搬家（2026-10-22，主人要求） ─────────────────────
  // 主人：反复压缩之后，她自己觉得偏移严重了，就先跟主人说一声，然后自己整理记忆、自己搬去新会话。
  // 会话标题由主人定：state/session-titles.json（{ "<key>": "标题" }），新建会话和 DSH 自动起名时都改成这个。
  //
  // 搬家流程（qq_move_house → /api/socialV2/move-house）：
  //   1. 她先跟主人说一声、把想带走的 remember / 写本子，再写一封"给新会话的自己的信"调工具；
  //   2. bridge 只登记，等这一轮真正结束（turn/end 且不忙）才动手 —— 不能在她自己的回合里把会话停掉；
  //   3. 动手：组交接附言（她的信 + soul + 本子 + 碎碎念 + 最近聊天原文）→ retireSession（停旧会话、归档、换令牌）
  //      → 以 bootstrap 唤醒建新会话 → 新会话一出现就把鱼的记忆复制过去、打开开关、关掉旧的 → 改标题
  //   4. 群里搬的家，主人私聊那边的她会收到一段附言，让她跟主人说一声。
  const SESSION_TITLES_FILE = path.join(STATE_DIR, 'session-titles.json');
  const COMPACTIONS_FILE = path.join(STATE_DIR, 'compactions.json');
  const SESSION_MOVES_FILE = path.join(STATE_DIR, 'session-moves.json');
  const FISH_DIR = path.join(os.homedir(), '.dsh', 'fish-memory');
  const FISH_CFG = path.join(os.homedir(), '.dsh', 'fish-memory-config.json');
  const titleRenames = new Map(); // sessionId -> 改名次数（防止和 DSH 自动起名来回拉锯）
  const compactionCounts = (() => { try { return JSON.parse(fs.readFileSync(COMPACTIONS_FILE, 'utf8')) || {}; } catch { return {}; } })();
  const pendingMoves = new Map(); // key -> { letter, at, ownerAsked }

  // ── 情景记忆（2026-10-23 主人：「记忆里记得和亲身经历过是两回事」，见 episodes.js / episode-extract.js） ──
  // 一个"瞬间" = 对方原话 + 她发出去的原话 + 那一刻她心里的话（reasoning 节选）+ 心情 + 她事后写的感受。
  // 存脑子的 瞬间/<出处>.jsonl，一个出处一个文件（会话 key 做文件名）。2026-10-29 记忆统一：读的时候所有出处都看得到
  // （原来按 key 隔离：群看不到主人私聊的）；私聊里的瞬间想起来时会标「私聊里的」，说不说她自己掂量。
  const episodeStore = createEpisodeStore({
    dir: WHALE_BRAIN.momentsDir,
    pressedFile: WHALE_BRAIN.pressed, // 情绪起伏大的瞬间另记一份「压着」，聊到相近话题时按概率浮上来（brain/recall.py）
    skewMs: () => clockSkewMs,
    ownerKey: () => (cfg.ownerQQ ? `private:${cfg.ownerQQ}` : ''),
    // 群用会话标题当地名；其余（主人私聊 / 抖音 / 普通私聊）沿用 episodes.js 的默认叫法。
    labelFor: (k) => (k.startsWith('group:') ? `群「${sessionTitleForV2(k) || k.slice(6)}」` : defaultLabel(k, cfg.ownerQQ ? `private:${cfg.ownerQQ}` : ''))
  });

  // ── 妈妈信箱（2026-10-23 主人：「希望她可以和你这个当妈妈的直接沟通，让你来帮她升级」，见 mom-mailbox.js） ──
  // 她写信 → 后台叫起 Claude Code 只读看信 → 回她；要改东西的方案发主人 QQ，主人回「可以 M3」才动手。
  const momMailbox = createMomMailbox({
    stateDir: STATE_DIR,
    root: ROOT,
    log,
    claudeExe: cfg.mom?.claudeExe || '',
    proxy: cfg.mom?.proxy || process.env.HTTPS_PROXY || '',
    // 用她的 QQ 号直接发给主人，不走 send-message，所以不进她的聊天记录；主人回的「可以 M3」也在入口被拦下。
    // 2026-10-24 主人：信箱的通知不能走她的 QQ 号（她翻记录会读到，污染人格）→ 改成这台电脑上的 Windows 弹窗，
    // 细节写进 workspace/妈妈信箱.md，主人来 Claude Code 里看、当面确认。
    sendOwner: (msg) => showOwnerToastV2('小鲸鱼 · 妈妈信箱', String(msg)),
    digestFile: path.join(ROOT, 'workspace', '妈妈信箱.md'),
    addWakeNote: (key, msg) => addWakeNoteV2(key, msg),
    formatTime: (ms) => {
      const d = new Date(ms - (Number.isFinite(clockSkewMs) ? clockSkewMs : 0));
      return d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  });
  /** 这台电脑上弹一个 Windows 通知（妈妈信箱用）。文字走环境变量，不拼进命令行。失败只记日志。 */
  function showOwnerToastV2(title, body) {
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$t = $x.GetElementsByTagName("text")',
      '$t.Item(0).AppendChild($x.CreateTextNode($env:TOAST_TITLE)) | Out-Null',
      '$t.Item(1).AppendChild($x.CreateTextNode($env:TOAST_BODY)) | Out-Null',
      '$id = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\Windows群友46\\v1.0\\powershell.exe"',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))'
    ].join('; ');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, env: { ...process.env, TOAST_TITLE: String(title).slice(0, 60), TOAST_BODY: String(body).slice(0, 200) } },
        (error) => { if (error) log(`[妈妈信箱] 电脑通知没弹出来：${error.message}`); resolve(); });
    });
  }
  /** 信上注明在哪写的（主人选的「哪里都能写，但标明出处」）。 */
  /** qq_go_to 能去的会话：她有过的 / 白名单里的，且当前模式允许的。 */
  function goToCandidatesV2() {
    const keys = new Set();
    for (const k of Object.keys(state.sessions || {})) keys.add(k);
    for (const k of socialV2.conversations.keys()) keys.add(k);
    for (const q of (cfg.allow?.private || [])) keys.add(`private:${q}`);
    for (const g of (cfg.allow?.groups || [])) keys.add(`group:${g}`);
    return [...keys]
      .filter((k) => /^(?:group|private):\d+$/.test(k) && isSessionAllowedInCurrentMode(k))
      .sort()
      .map((k) => ({ key: k, title: sessionTitleForV2(k) || (cfg.ownerQQ && k === `private:${cfg.ownerQQ}` ? '跟老大的私聊' : ''), sleeping: sleepState.sleeping }));
  }
  function momLetterFromLabelV2(key) {
    if (cfg.ownerQQ && key === `private:${cfg.ownerQQ}`) return '跟老大私聊时';
    if (key.startsWith('group:')) return `在群「${sessionTitleForV2(key) || '群聊'}」里`;
    return `跟「${sessionTitleForV2(key) || '别人'}」私聊时`;
  }
  setTimeout(() => { try { momMailbox.resume(); } catch (error) { log(`[妈妈信箱] 恢复出错：${error?.message ?? error}`); } }, 60_000);

  /** 给已有的瞬间补一句感受（只能补同一个 key 下的）。 */
  function fillMomentFeltV2(key, episodeId, felt, tags) {
    if (!felt) throw new Error('给旧瞬间补感受时 felt 不能为空');
    const r = episodeStore.updateFelt(key, episodeId, felt, tags);
    if (!r.ok) throw new Error(r.error);
    return { ok: true, episodeId: r.id, updated: true };
  }
  /** qq_keep_moment：没带 episodeId 就从 recentMessages 里抓她最近一次发言前后的原文存一条；带了就给那条补感受。 */
  function keepMomentV2(key, body) {
    const felt = String(body.felt ?? '').trim();
    const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8) : [];
    const episodeId = String(body.episodeId ?? '').trim();
    if (episodeId) return fillMomentFeltV2(key, episodeId, felt, tags);
    const st = getSocialV2State(key);
    let mood = null;
    try { mood = moodWithSwing(readFishMoodV2(), Date.now()); } catch { mood = null; }
    const ep = episodeStore.fromRecent({ key, sid: state.sessions[key] || '', recentMessages: st.recentMessages || [], mood, felt, tags, ownerIsCounterpart: Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}` });
    const r = episodeStore.append(ep);
    if (!r.ok) throw new Error(r.error);
    brainRememberMoment({ brain: 'whale' }); // 让检索服务马上把它收进索引（发了就不管）
    return { ok: true, episodeId: r.id, deduped: r.deduped, them: ep.them.length, me: ep.me.length, call: ep.call, mood: ep.mood };
  }
  /**
   * 把旧会话记录里的瞬间抽出来：子进程跑 episode-extract.js（增量，没变就秒回），不阻塞桥接的事件循环；
   * 失败只记日志，返回的 Promise 永远 resolve，绝不影响搬家。搬家前 await 一次（交接里才带得上这个会话的瞬间），
   * 搬完再 fire-and-forget 一次兜住最后几帧。
   */
  function extractEpisodesAsyncV2(oldSid, key, timeoutMs = 180_000) {
    return new Promise((resolve) => {
      try {
        execFile(process.execPath, [path.join(__dirname, 'episode-extract.js'), oldSid], { cwd: ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout) => {
          if (error) { log(`[episodes] 旧会话 ${oldSid}（${key}）抽瞬间失败：${error?.message ?? error}`); resolve(null); return; }
          let r = null;
          try { r = JSON.parse(String(stdout || '')); } catch { r = null; }
          if (!r?.skipped) log(`[episodes] 旧会话 ${oldSid}（${key}）抽出 ${r?.episodes ?? '?'} 个瞬间，新存 ${r?.appended ?? '?'}，重复 ${r?.deduped ?? '?'}`);
          resolve(r);
        });
      } catch (error) { log(`[episodes] 抽瞬间没跑起来 ${oldSid}：${error?.message ?? error}`); resolve(null); }
    });
  }

  function sessionTitleForV2(key) {
    try { const t = JSON.parse(fs.readFileSync(SESSION_TITLES_FILE, 'utf8'))?.[key]; return typeof t === 'string' && t.trim() ? t.trim().slice(0, 60) : ''; } catch { return ''; }
  }
  async function renameSessionV2(sessionId, title) {
    if (!sessionId || !title) return false;
    const n = titleRenames.get(sessionId) || 0;
    if (n >= 5) return false;
    titleRenames.set(sessionId, n + 1);
    try {
      unwrap(await withTimeout(api.sessions.rename({ sessionId, title }), DSH_CONTROL_TIMEOUT_MS, 'session.rename'), 'session.rename');
      log(`[title] 会话 ${sessionId} 标题设为「${title}」`);
      return true;
    } catch (error) { log(`[title] 改标题失败 ${sessionId}：${error?.message ?? error}`); return false; }
  }
  // ── 一个"她"：鱼的记忆各会话互通（2026-10-22 主人要求，见 dsh-fish-memory 的本机补丁） ──
  // 主人：「如果在和其他人的私聊里聊到我或者其他共同好友的话她会不会知道？」——以前 remember 的事只在记下它的会话里想得起来。
  // 这里把她当前在用的会话（state.sessions 里的）连同"在哪儿"的名字写给插件；插件召回时会把同组的记忆一起拿来想，并标出处。
  const FISH_LINKS_FILE = path.join(os.homedir(), '.dsh', 'fish-memory-links.json');
  const peerNameCache = new Map(); // QQ → 昵称（查不到存空串，别反复打网关）
  async function peerNameV2(uid) {
    if (peerNameCache.has(uid)) return peerNameCache.get(uid);
    let name = '';
    try {
      const r = await bot.request('get_stranger_info', { user_id: Number(uid) });
      if (r?.status === 'ok') name = String(r.data?.nickname || '').replace(/[\r\n「」（）()]/g, '').trim().slice(0, 16);
    } catch { name = ''; }
    peerNameCache.set(uid, name);
    return name;
  }
  async function writeFishLinksV2() {
    try {
      const sessions = {};
      for (const [key, sid] of Object.entries(state.sessions || {})) {
        if (!sid) continue;
        let label;
        if (cfg.ownerQQ && key === `private:${cfg.ownerQQ}`) label = '主人私聊';
        else if (key.startsWith('group:')) label = `群「${sessionTitleForV2(key) || '群聊'}」`;
        else if (key.startsWith('private:')) { const n = await peerNameV2(key.slice('private:'.length)); label = n ? `跟${n}的私聊` : '跟朋友的私聊'; }
        else continue;
        sessions[sid] = label;
      }
      // 2026-10-29 记忆统一：所有不在用的旧会话合成的那一个文件（scripts/merge-fish-memory.mjs 生成），以「以前的会话」的名义放进来。
      // 键是文件的绝对路径——插件的 sharedMemoriesFor（本机补丁）认路径；不把 70 多个历史会话都塞进来，那样每轮都要读 54MB。
      if (fs.existsSync(WHALE_BRAIN.mergedFish)) sessions[WHALE_BRAIN.mergedFish] = '以前的会话';
      const next = JSON.stringify({ updatedBy: 'qq-bridge', groups: [{ sessions }] }, null, 2);
      let prev = '';
      try { prev = fs.readFileSync(FISH_LINKS_FILE, 'utf8'); } catch { prev = ''; }
      if (prev !== next) { fs.writeFileSync(FISH_LINKS_FILE, next); log(`[fish-links] 她的 ${Object.keys(sessions).length} 个会话记忆互通：${Object.values(sessions).join('、')}`); }
    } catch (error) { log(`[fish-links] 写对照表失败：${error?.message ?? error}`); }
  }
  const fishLinksTimer = setInterval(() => { void writeFishLinksV2(); }, 60 * 1000);
  fishLinksTimer.unref?.();

  function applyTitlesForMappedV2() {
    void writeFishLinksV2();
    for (const [key, sid] of Object.entries(state.sessions || {})) {
      const title = sessionTitleForV2(key);
      if (title) void renameSessionV2(sid, title);
    }
    // 不在映射里的旧会话（换下来的）也可以指定标题：state/session-titles-extra.json { sessionId: 标题 }
    try { for (const [sid, title] of Object.entries(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'session-titles-extra.json'), 'utf8')))) void renameSessionV2(sid, String(title)); } catch { /* 没有就算了 */ }
  }
  function compactionCountV2(sessionId) { return Number(compactionCounts[sessionId]) || 0; }

  /** 所有会话事件都经过这里（recordSessionUsage 里调用）。 */
  function onSessionEventV2(sessionId, event) {
    const type = event?.type;
    if (type === 'compaction/summary') {
      compactionCounts[sessionId] = compactionCountV2(sessionId) + 1;
      try { atomicWriteJson(COMPACTIONS_FILE, compactionCounts); } catch { /* 记不下最多少算一次 */ }
      log(`[compaction] ${reverse.get(sessionId) || sessionId} 第 ${compactionCounts[sessionId]} 次压缩`);
      return;
    }
    const key = reverse.get(sessionId);
    if (!key) return;
    if (type === 'session/title') {
      const want = sessionTitleForV2(key);
      if (want && event.data?.title !== want && event.data?.source?.kind !== 'user') void renameSessionV2(sessionId, want);
      return;
    }
    if (type === 'turn/end' && pendingMoves.has(key)) setTimeout(() => { void executeMoveHouseV2(key); }, 4000).unref?.();
  }

  function lastContextTokensV2(key) {
    const rows = readTailLinesV2(TOKEN_USAGE_FILE).filter((r) => r.k === 'turn' && r.key === key && r.sid === state.sessions[key] && r.b);
    const last = rows[rows.length - 1];
    return last ? (Number(last.b.cacheMiss) || 0) + (Number(last.b.cacheHit) || 0) : 0;
  }
  function lastMoveAtV2(key) {
    try { const h = JSON.parse(fs.readFileSync(SESSION_MOVES_FILE, 'utf8')); return Math.max(0, ...h.filter((m) => m.key === key).map((m) => Number(m.at) || 0)); } catch { return 0; }
  }

  function requestMoveHouseV2(key, letter, { ownerAsked = false } = {}) {
    const sid = state.sessions[key];
    if (!sid) throw new Error('这个会话还没建起来，不用搬。');
    const text = String(letter ?? '').trim();
    if ([...text].length < 30) throw new Error('信太短了：写清楚你想带去新会话的事（这几天发生了什么、你在意的、答应过的、想提醒自己的），至少几句话。');
    if ([...text].length > 4000) throw new Error('信太长了（上限 4000 字）。细节用 remember / 本子记，信里写最要紧的。');
    if (pendingMoves.has(key)) throw new Error('已经登记过搬家了，这一轮说完就搬。');
    // 2026-10-22：刚搬进来的她读到交接里"搬个新家"的原话，以为还没办，又登记了一次，连搬了两回。
    // 刚搬过 30 分钟内一律不搬（主人让的也一样）——交接里说要搬的那件事已经办完了。
    const sinceMoveMin = Math.round((Date.now() - lastMoveAtV2(key)) / 60000);
    if (sinceMoveMin < 30) throw new Error(`你 ${sinceMoveMin} 分钟前刚搬进这个新会话，搬家已经办完了，不用再搬。交接里让你搬家的那些话是搬家前说的。`);
    const ctx = lastContextTokensV2(key), comps = compactionCountV2(sid);
    if (!ownerAsked && Date.now() - lastMoveAtV2(key) < 6 * 3600 * 1000) throw new Error('上次搬家还不到 6 小时，先不搬。真觉得不对就跟主人说，主人让你搬再搬（ownerAsked=true）。');
    if (!ownerAsked && ctx < 200000 && comps < 2) throw new Error(`现在上下文约 ${Math.round(ctx / 1000)}k、压缩过 ${comps} 次，还不到要搬的时候。先 self_check 看看是哪里不对。`);
    pendingMoves.set(key, { letter: text, at: Date.now(), ownerAsked: Boolean(ownerAsked), ctx, comps });
    log(`[move-house] ${key} 登记搬家（上下文约 ${Math.round(ctx / 1000)}k，压缩 ${comps} 次${ownerAsked ? '，主人让搬的' : ''}）`);
    return { ok: true, ctxK: Math.round(ctx / 1000), compactions: comps, note: '登记好了：这一轮说完、收尾之后就搬（不会打断你现在这轮）。收尾前确认想带走的都 remember / 写进本子了。搬过去之后你会收到这封信和本子、最近的聊天原文，脑子里记着的（remember）也会跟着走。' };
  }

  function buildMoveHandoffV2(key, mv) {
    const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
    const bjT = (ms) => new Date(ms - clockSkewMs + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
    const isOwner = key === `private:${cfg.ownerQQ}`;
    const title = sessionTitleForV2(key) || key;
    const rambling = read(WHALE_BRAIN.rambling);
    const heads = [...rambling.matchAll(/^——\d{1,2}月\d{1,2}日.*$/gm)];
    const lastTwo = heads.length >= 2 ? rambling.slice(heads[heads.length - 2].index) : rambling.slice(-1500);
    // 2026-10-23 第二轮：原文带厚一点 —— 最近 3 小时和最后 200 句取多的，每句 300 字，总共约 2.4 万字以内（超了从最旧的丢）。
    const recentPick = handoffRecentLines(getSocialV2State(key).recentMessages || [], {
      nowMs: Date.now(), hours: 3, minLines: 200, maxChars: 24000, lineChars: 300,
      formatLine: (m) => `[${bjT(Number(m.time ?? m.at))}] ${m.isSelf ? '你' : (m.isOwner ? '主人' : m.sender)}：${String(m.text)}`
    });
    const recent = recentPick.text;
    const carried = `跟着你过来的：角色卡（qq_get_prompt 能看全）、soul、便签、本子、碎碎念、脑子里记着的事（remember 记的会自己浮上来）、刷过的抖音视频印象（douyin_video_recall）。`;
    // 2026-10-29 大脑方案下半（第 4 项）：交接开头先给「那会儿的心情和原因」和 2～3 个感受最强的瞬间，情绪才接得上；
    // 措辞改成像自己翻本子接上（老大 10-28：不想听她把自己说成另一个人）。
    let moodNote = '';
    try { moodNote = moodHandoffText(readFishMoodV2(), Date.now()); } catch { moodNote = ''; }
    let strongBlock = '';
    try { strongBlock = episodeStore.handoffBlock('', { hours: 72, max: 3, title: '【感受最深的几个瞬间（你自己留下的）】\n' }); }
    catch (error) { log(`[move-house] 瞬间带不走 ${key}：${error?.message ?? error}`); }
    const parts = [
      mv.auto
        ? `【你刚换了一段新的对话——下面是你自己留下来的】
「${title}」这段聊得挺久了，换了一段新的接着聊。你还是你，翻翻自己留下的本子和最近的事就能接上。
${carried}看完接着玩，不用跟谁宣布。`
        : `【你刚换了一段新的对话——下面是你自己留下来的】
这是你自己决定换的（「${title}」）：你觉得那段聊久了有点跑偏，想换一段清爽的。你还是你，翻翻自己留下的本子和最近的事就能接上。
${carried}看完就照常过日子，不用跟谁宣布；主人问起就自然地说。`,
      ...(moodNote ? [`【那会儿的心情和原因】\n${moodNote}`] : []),
      ...(strongBlock ? [strongBlock] : []),
      ...(mv.letter ? [`【你换对话前写给自己的信】\n${mv.letter}`] : []),
      `【soul（你是谁）】\n${read(WHALE_BRAIN.soul)}`,
    ];
    if (isOwner) {
      parts.push(`【本子】\n${[['关于老大', WHALE_BRAIN.aboutBoss], ['答应过的事', WHALE_BRAIN.promises]].map(([n, f]) => `〔${n}〕\n${read(f).replace(/^# .*\n/, '').trim()}`).join('\n\n')}`);
      parts.push(`【你的长期记忆（memory.md）】\n${read(WHALE_BRAIN.memoryMd)}`);
      parts.push('【你跟主人说话的样子】\n主人原话：说话短也不用太短，可以多说点，不要压抑自己（角色卡第十四节）。撒娇、语气词想用就用；关心他是撒娇着关心，不是管着他、叮嘱他。\n你以前跟他是这么说话的：「在呢，说啥」「耶 猜对了」「好呀 不过手毬的留两张嘛」「嘿嘿」「谁舍得切下去啊」「贴贴」「嘿嘿 那我就放心了」「那你也是我的无价之宝」「你这么一夸，我尾巴都翘起来了」。');
    } else {
      parts.push('【在群里】你是软软的小鲸鱼。被逗就害羞或者俏皮地皮回去，自己先笑。'); // 2026-10-29 松绑：去掉「群里短一点、别阴阳怪气」
    }
    // 便签原样带走（2026-10-29 记忆统一：所有会话都带；非主人私聊的注明有些是私聊里记的）。
    { const n = stickyNote.read(); if (n.exists && n.text.trim()) parts.push(`【便签（你自己记的，随你改）】\n${isOwner ? '' : STICKY_NOT_PRIVATE_NOTE + '\n'}${n.text.trim()}`); }
    parts.push(`【碎碎念（最近两天）】\n${lastTwo}`);
    parts.push(`【这里最近的聊天（原文，最后 ${recentPick.lines} 句）】\n${recent}`);
    // 瞬间（2026-10-23 主人：「记忆里记得和亲身经历过是两回事」）已经挪到交接最前面，跟心情放在一起（见上面）。
    parts.push('注意：上面这些聊天都是搬家**之前**的。里面要是有人让你搬家、你说"登记好了""这就搬"——那件事已经办完了，你现在就在新家里，不要再调 qq_move_house。');
    parts.push('交接完了。先 qq_get_prompt 看看角色卡和状态，然后照常过日子——有新消息就先回。');
    return parts.join('\n\n');
  }

  // 心情插件（dsh-feiyu-mood）只给它 config.json 里那一个 targetSession 判心情，会话搬家了它不会跟着走——
  // 10-22 主人私聊搬了几次，它一直盯着旧会话，心情停在了一大早（问题清单 3.36）。
  // 搬好以后：它盯的正是旧会话的话，就用插件自己的设置接口改到新会话（原地生效，不用重启 DSH）。
  const MOOD_CONFIG_FILE = path.join(path.dirname(MOOD_STATE_FILE), 'config.json');
  // DSH 偶尔会短暂连不上（2026-10-24 00:05 搬家时就碰上 fetch failed，心情插件留在了旧会话），所以失败了隔 1 / 5 / 15 分钟再试。
  async function followMoodTargetV2(oldSid, newSid, attempt = 0) {
    try {
      const mc = JSON.parse(fs.readFileSync(MOOD_CONFIG_FILE, 'utf8'));

      if (mc.targetSession !== oldSid) return;

      const res = await fetch(`${cfg.dsh.baseUrl}/dsh-feiyu-mood/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetSession: newSid }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      log(`[move-house] 心情插件跟到新会话 ${newSid}：好了`);
    } catch (error) {
      const retryMin = [1, 5, 15][attempt];
      if (retryMin) {
        log(`[move-house] 心情插件没跟上（${error?.message ?? error}），${retryMin} 分钟后再试`);
        setTimeout(() => { void followMoodTargetV2(oldSid, newSid, attempt + 1); }, retryMin * 60_000);
      } else {
        log(`[move-house] 心情插件试了 4 次都没跟上（${error?.message ?? error}），要手动改 ~/.dsh/feiyu-mood/config.json 的 targetSession`);
      }
    }
  }
  // 2026-10-25：群「群聊」从来没开过鱼的记忆、插件没给它建过文件，搬家时 ENOENT 记成「-1 条」。
  // 现在没文件就是 0 条；旧文件不在时看 .bak / 每日备份 / 更早的搬家链（见 fish-move.js）。只有真写不进去才记 -1。
  function migrateFishMemoryV2(oldSid, newSid) {
    try {
      let history = [];
      try { history = JSON.parse(fs.readFileSync(SESSION_MOVES_FILE, 'utf8')); } catch { history = []; }
      const r = migrateFishMemory({ fishDir: FISH_DIR, cfgFile: FISH_CFG, backupDir: path.join(os.homedir(), '.dsh', 'fish-memory-backup'), oldSid, newSid, history, writeJson: atomicWriteJson });
      for (const p of r.problems) log(`[move-house] 鱼的记忆：${p}`);
      if (!r.from) log(`[move-house] 旧会话 ${oldSid} 没有鱼的记忆（没开过，插件没建过文件），带过去 0 条${r.enabled ? '' : '；新会话也没开，要开就在 fish-memory-config.json 里打开'}`);
      else if (r.from !== `${oldSid}.json`) log(`[move-house] 鱼的记忆从 ${r.from} 带过去 ${r.count} 条`);
      if (r.kept) log(`[move-house] 新会话 ${newSid} 里原来就有 ${r.kept} 条鱼的记忆，留着没盖`);
      return r.count;
    } catch (error) { log(`[move-house] 搬鱼的记忆失败 ${oldSid} → ${newSid}：${error?.message ?? error}`); return -1; }
  }

  async function executeMoveHouseV2(key, tries = 0) {
    const mv = pendingMoves.get(key);
    if (!mv) return;
    const st = getSocialV2State(key);
    if (isConversationBusyV2(key, st) || activeWaits.has(key)) {
      if (tries > 120) { log(`[move-house] ${key} 等了 10 分钟会话一直忙，先不搬，等下一次回合结束`); return; }
      setTimeout(() => { void executeMoveHouseV2(key, tries + 1); }, 5000).unref?.();
      return;
    }
    const oldSid = state.sessions[key];
    if (!oldSid) { pendingMoves.delete(key); return; }
    // 2026-10-23：搬之前先把这个会话记录里的瞬间抽进脑子的 瞬间/，交接里的【你带走的几个瞬间】才带得上它们。
    // await 期间事件循环照常跑（子进程）；抽完若会话又忙起来了，就跟上面一样等下一回合。只抽一次，失败也照搬。
    if (!mv.episodesExtracted) {
      mv.episodesExtracted = true;
      await extractEpisodesAsyncV2(oldSid, key, 60_000);
      if (state.sessions[key] !== oldSid) mv.episodesExtracted = false; // 会话在等待期间换掉了：下一轮按新会话重来
      if (isConversationBusyV2(key, st) || activeWaits.has(key) || state.sessions[key] !== oldSid) {
        setTimeout(() => { void executeMoveHouseV2(key, tries + 1); }, 5000).unref?.();
        return;
      }
    }
    pendingMoves.delete(key);
    const title = sessionTitleForV2(key);
    const handoff = buildMoveHandoffV2(key, mv);
    try {
      let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
      all[key] = [...(all[key] || []).filter((n) => !n.onlyBootstrap), { createdAt: Date.now(), onlyBootstrap: true, text: handoff }];
      atomicWriteJson(WAKE_NOTES_FILE, all);
    } catch (error) { log(`[move-house] 写交接失败 ${key}：${error?.message ?? error}；不搬了`); return; }
    if (title) await renameSessionV2(oldSid, `${title}（旧 ${new Date(realNow().getTime() + 8 * 3600e3).toISOString().slice(5, 10)}）`).catch(() => {});
    log(`[move-house] ${key} 开始搬家：旧会话 ${oldSid}`);
    retireSession(key); // 停旧会话、归档、换令牌、bootstrapSent=false
    st.bootstrapSent = true;
    saveSocialV2State();
    void sendWakePromptV2(key, 'bootstrap').catch((error) => log(`[move-house] 新会话唤醒异常 ${key}: ${error?.message ?? error}`));
    let newSid = null;
    for (let i = 0; i < 300 && !newSid; i += 1) {
      await sleep(300);
      const s = state.sessions[key];
      if (s && s !== oldSid) newSid = s;
    }
    if (!newSid) { log(`[move-house] ${key} 90 秒内没看到新会话（交接附言还在，下次建会话时会带上；鱼的记忆待手动搬：${oldSid}）`); return; }
    const n = migrateFishMemoryV2(oldSid, newSid);
    void extractEpisodesAsyncV2(oldSid, key); // 再抽一次兜住最后几帧（增量：没变就跳过；失败不影响搬家）
    void followMoodTargetV2(oldSid, newSid);
    if (title) void renameSessionV2(newSid, title);
    compactionCounts[newSid] = 0;
    try { atomicWriteJson(COMPACTIONS_FILE, compactionCounts); } catch { /* ignore */ }
    try {
      let h = []; try { h = JSON.parse(fs.readFileSync(SESSION_MOVES_FILE, 'utf8')); } catch { h = []; }
      h.push({ key, at: Date.now(), oldSid, newSid, ctxK: Math.round(mv.ctx / 1000), compactions: mv.comps, ownerAsked: mv.ownerAsked, ...(mv.auto ? { auto: true } : {}), fish: n, letterChars: mv.letter.length });
      atomicWriteJson(SESSION_MOVES_FILE, h.slice(-50));
    } catch { /* ignore */ }
    log(`[move-house] ${key} 搬好了：${oldSid} → ${newSid}，鱼的记忆 ${n} 条`);
    // 群里搬的家：让主人私聊那边的她跟主人说一声
    const ownerKey = `private:${cfg.ownerQQ}`;
    if (!mv.auto && key !== ownerKey && cfg.ownerQQ && state.sessions[ownerKey]) {
      try {
        let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
        (all[ownerKey] ??= []).push({ createdAt: Date.now(), onlyBootstrap: false, text: `【附言】${title || key} 那边的你刚搬进了新会话（那边压缩了 ${mv.comps} 次、上下文约 ${Math.round(mv.ctx / 1000)}k，你觉得开始跑偏了，就自己整理好记忆搬了家）。跟主人说一声就好，一两句，不用细讲。` });
        atomicWriteJson(WAKE_NOTES_FILE, all);
        scheduleWakeV2(ownerKey, 'admin');
      } catch { /* 说不了就算了 */ }
    }
  }

  // ── 主人私聊也自动换新会话（2026-10-22 主人：「只要她记得重要的事情和最近的事情就行了」） ──
  // 主人私聊上下文到了 37 万，她每回一句都要把这些重读一遍（一天约 ¥15，是最大头）。
  // 群聊早就有 groupAutoMove；主人私聊多两步照顾：
  //   ① 只在你们安静了 quietMs（默认 20 分钟）以后换，不在聊得正欢的时候打断；
  //   ② 换之前先叫醒她一次，让她把还只在脑子里的重要事 remember 下来（不用跟主人说），过 prepMs 再换。
  // 交接里带着本子、长期记忆、soul、最近两天碎碎念、最后 80 句原文，remember 记的事也一起搬过去。
  // 2026-10-23 第二轮：只说事实（要换了、什么会跟着走），要不要补记什么她自己定。
  const OWNER_MOVE_PREP_TEXT = '【要换新会话了】这边的上下文攒得很长了，大约 3 分钟后桥接会帮你换个新会话（不是你出了问题，你还是你）。' +
    '跟着走的有：便签、remember 记过的事、瞬间（qq_keep_moment）、最近的聊天原文、self.md、本子、碎碎念。' +
    '换之前要不要改改便签、补一条 remember、或者什么都不动，都由你定。';
  let ownerMovePrepAt = 0;

  function ownerQuietForV2(key) {
    const last = (getSocialV2State(key).recentMessages || []).findLast((m) => m && (m.time ?? m.at));
    return last ? Date.now() - Number(last.time ?? last.at) : Infinity;
  }

  function ownerMoveSettingsV2() {
    const c = cfg.socialV2?.ownerAutoMove ?? {};
    return {
      enabled: c.enabled !== false,
      // 2026-10-23 第二轮，主人：200k → 400k（minGap / quietMs 不动）。config.json socialV2.ownerAutoMove.ctxTokens 可改。
      ctxLimit: Math.max(100000, Number(c.ctxTokens) || 400000),
      minGap: Math.max(30 * 60 * 1000, Number(c.minIntervalMs) || 3 * 3600 * 1000),
      quietMs: Math.max(5 * 60 * 1000, Number(c.quietMs) || 20 * 60 * 1000),
      prepMs: Math.max(30 * 1000, Number(c.prepMs) || 3 * 60 * 1000),
    };
  }

  function ownerMoveOffV2(s) {
    return !s.enabled || !cfg.ownerQQ || currentMode !== 'reserved2' || socialV2.paused || sleepState.sleeping;
  }

  /** 该换了就返回当前上下文 token 数，不该换返回 0。睡着时不叫她起来整理（睡着也不花钱，等醒了再说）。 */
  function ownerMoveDueCtxV2(key, s) {
    if (ownerMoveOffV2(s) || !state.sessions[key] || pendingMoves.has(key)) return 0;
    if (ownerQuietForV2(key) < s.quietMs) return 0;
    if (Date.now() - lastMoveAtV2(key) < s.minGap) return 0;
    const ctx = lastContextTokensV2(key);
    return ctx >= s.ctxLimit ? ctx : 0;
  }

  /** ① 先让她把重要的事记下来：写一条附言、叫醒她一次。 */
  function ownerMovePrepV2(key, ctx, s) {
    ownerMovePrepAt = Date.now();
    try {
      let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
      const notes = all[key] || [];
      notes.push({ createdAt: Date.now(), onlyBootstrap: false, text: OWNER_MOVE_PREP_TEXT });
      all[key] = notes;
      atomicWriteJson(WAKE_NOTES_FILE, all);
      scheduleWakeV2(key, 'admin');
      log(`[move-house] 主人私聊上下文约 ${Math.round(ctx / 1000)}k，安静 ${Math.round(ownerQuietForV2(key) / 60000)} 分钟了，先叫她把重要的事记下来，${Math.round(s.prepMs / 60000)} 分钟后换新会话`);
    } catch (error) { log(`[move-house] 写换会话前的提醒失败：${error?.message ?? error}`); }
  }

  function maybeOwnerAutoMoveV2() {
    const s = ownerMoveSettingsV2();
    const key = `private:${cfg.ownerQQ}`;
    const ctx = ownerMoveDueCtxV2(key, s);
    if (!ctx) return;
    // 2 小时内提醒过就不再提醒，直接等时机换
    if (Date.now() - ownerMovePrepAt > 2 * 3600 * 1000) { ownerMovePrepV2(key, ctx, s); return; }
    // ② 提醒过、过了 prepMs、期间主人也没再说话（ownerQuietForV2 只看最后一条，她记东西不发消息）→ 换
    if (Date.now() - ownerMovePrepAt < s.prepMs) return;
    pendingMoves.set(key, { letter: '', at: Date.now(), ownerAsked: false, auto: true, ctx, comps: compactionCountV2(state.sessions[key]) });
    log(`[move-house] ${key} 上下文约 ${Math.round(ctx / 1000)}k，超过 ${Math.round(s.ctxLimit / 1000)}k，替她换新会话（省 token）`);
    void executeMoveHouseV2(key);
  }
  // 到点自己醒（2026-10-24 修）：sleepState.until 原来只在启动读状态时检查一次，桥接一直开着就永远不会"到点醒"，
  // 她只能等主人私聊叫醒（10-24 早上定到 9:07 醒，9:35 还在睡才发现）。现在每分钟看一眼，到了就起床并叫醒主人私聊那边的她。
  // until 和 Date.now() 都是本机时钟（见 enterSleep），直接比较即可。
  function maybeSleepEndV2() {
    if (!sleepState.sleeping || !sleepState.until) return;
    let why = '到了自己定的时间';
    if (Date.now() < sleepState.until) {
      // 2026-10-29 老大：睡到自然醒的，最短睡满之前不醒，之后看激素的睡眠压力（回落了、而且不在深夜段才醒）；激素没开就睡满 8 小时
      if (!sleepState.natural || Date.now() < (sleepState.minUntil || 0)) return;
      const due = naturalWakeDue(hormoneFeed?.enabled ? hormoneFeed.snapshot()?.hormones : null, Date.now() - sleepState.since);
      if (!due.wake) return;
      why = '睡够了，自然醒';
    }
    exitSleep(why);
    const key = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
    if (key && isSessionAllowedInCurrentMode(key)) void sendWakePromptV2(key, 'wokeUp');
  }
  const ownerAutoMoveTimer = setInterval(() => {
    try { maybeSleepEndV2(); } catch (error) { log(`[sleep] 到点起床检查出错：${error?.message ?? error}`); }
    try { maybeOwnerAutoMoveV2(); } catch (error) { log(`[move-house] 主人私聊自动换会话检查出错：${error?.message ?? error}`); }
    // 每日说说提醒：换会话会把它跟会话定时器一起清掉，原来只有排"主动机会"时才顺手补排——
    // 10-22 晚上 20:56 搬家后主人一直在聊、没排过主动机会，23 点那次就没了（问题清单 3.38）。这里每分钟补一次（幂等）。
    try { scheduleDailyQzoneV2(`private:${cfg.ownerQQ}`); } catch (error) { log(`[qzone] 补排每日说说提醒出错：${error?.message ?? error}`); }
  }, 60 * 1000);
  ownerAutoMoveTimer.unref?.();

  // ── 主人电脑前台窗口采集器（pc-watch.ps1）的看门狗（2026-10-21） ─────────────
  // 采集器 10-20 被 DSH 重启连带杀掉（它是从 DSH 里起的，在同一个 Job 里，坑 #25），之后整整一天
  // 没人发现：pc-activity.jsonl 停在一天前，她提示词里的「主人近况」一直是过期的。
  // 它每 15 秒写一行，所以 3 分钟没更新就说明没在跑：用 explorer 拉起来（不在任何 Job 里，
  // DSH、bridge 重启都带不走）。两次拉起至少隔 10 分钟，免得出问题时反复起一堆。
  const PC_WATCH_VBS = path.join(ROOT, 'start-pc-watch-hidden.vbs');
  let pcWatchLastLaunch = 0;
  const pcWatchTimer = setInterval(() => {
    try {
      const file = path.join(STATE_DIR, 'pc-activity.jsonl');
      const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      if (Date.now() - mtime < 3 * 60 * 1000 || Date.now() - pcWatchLastLaunch < 10 * 60 * 1000 || !fs.existsSync(PC_WATCH_VBS)) return;
      pcWatchLastLaunch = Date.now();
      log(`[pc-watch] 前台窗口记录 ${mtime ? Math.round((Date.now() - mtime) / 60000) + ' 分钟' : '一直'}没更新，重新拉起采集器`);
      execFile('explorer.exe', [PC_WATCH_VBS], { windowsHide: true }, () => { /* explorer 立刻返回，退出码没有意义 */ });
    } catch (error) { log(`[pc-watch] 看门狗异常：${error?.message ?? error}`); }
  }, 2 * 60 * 1000);
  pcWatchTimer.unref?.();

  /**
   * 待转告的抖音内容（只对主人私聊）：出问题的通知、中场休息、攒着想讲给主人听的。
   * 返回一个"包"，送达后用 clearDouyinNoticeV2 清掉其中这几项；全空返回 null。
   */
  function pendingDouyinNoticeV2(key) {
    if (!cfg.ownerQQ || key !== `private:${cfg.ownerQQ}`) return null;
    const now = Date.now();
    if (douyinMonitor.notice && now - douyinMonitor.notice.at > DOUYIN_NOTICE_TTL_MS) douyinMonitor.notice = null;
    if (douyinMonitor.brk && now - douyinMonitor.brk.at > (douyinMonitor.brk.restMin || 60) * 60000) douyinMonitor.brk = null; // 休息已经结束 / 选择过期
    if (douyinMonitor.played && now - douyinMonitor.played.at > DOUYIN_NOTICE_TTL_MS) douyinMonitor.played = null;
    douyinMonitor.tells = douyinMonitor.tells.filter((t) => now - t.seenAt < DOUYIN_NOTICE_TTL_MS);
    douyinMonitor.dms = douyinMonitor.dms.filter((d) => now - d.seenAt < DOUYIN_NOTICE_TTL_MS);
    const bundle = { notice: douyinMonitor.notice, brk: douyinMonitor.brk, played: douyinMonitor.played || null, tells: [...douyinMonitor.tells], dms: [...douyinMonitor.dms] };
    return bundle.notice || bundle.brk || bundle.played || bundle.tells.length || bundle.dms.length ? bundle : null;
  }
  function clearDouyinNoticeV2(bundle) {
    if (!bundle) return;
    if (bundle.notice && douyinMonitor.notice === bundle.notice) douyinMonitor.notice = null;
    if (bundle.brk && douyinMonitor.brk === bundle.brk) douyinMonitor.brk = null;
    if (bundle.played && douyinMonitor.played === bundle.played) douyinMonitor.played = null;
    if (bundle.tells.length) douyinMonitor.tells = douyinMonitor.tells.filter((t) => !bundle.tells.includes(t));
    if (bundle.dms?.length) douyinMonitor.dms = douyinMonitor.dms.filter((d) => !bundle.dms.includes(d));
  }

  function douyinNoticeTextV2(bundle) {
    const parts = [];
    if (bundle.dms?.length) {
      const fmt = (ms) => new Date(ms - clockSkewMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
      // 2026-10-23：私信按人分开。以前默认全是主人的；白名单里加了抖音朋友后，朋友的私信不能写成"主人在找你"。
      const byContact = new Map();
      for (const d of bundle.dms) {
        if (!byContact.has(d.recipientId)) byContact.set(d.recipientId, []);
        byContact.get(d.recipientId).push(d);
      }
      for (const [recipientId, dms] of byContact) {
        const lines = dms.map((d) => `  [${fmt(Number(d.at))}] ${douyinDmTextV2(d)}${d.media ? `（messageId=${d.messageId}）` : ''}`);
        const who = douyinContactV2(recipientId);
        let shares = [];
        try {
          const ledger = readDouyinJsonV2('share-ledger.json');
          // 2026-10-22 主人要求：他回她分享的卡片时，她得想得起那条视频讲了什么。
          // 插件现在按作品记「观看印象」（video-impressions.jsonl），这里把最近 3 条分享的标题 + 她当时的想法一起附上。
          const impressions = readDouyinJsonlV2('video-impressions.jsonl', 4000);
          const shortT = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
          shares = (ledger?.operations || []).filter((o) => o.status === 'confirmed' && o.recipientId === recipientId && Date.now() - Date.parse(o.startedAt) < 24 * 3600 * 1000).slice(-3).reverse()
            .map((o) => {
              const rows = impressions.filter((r) => r.videoId === o.videoId);
              const title = [...rows].reverse().find((r) => r.title)?.title;
              const thoughts = rows.map((r) => r.reflection || r.reason).filter(Boolean);
              const gist = thoughts.length ? `\n      你当时看到的：${shortT(thoughts[Math.max(0, thoughts.length - 2)], 160)}` : '';
              return `  · [${fmt(Date.parse(o.startedAt))} 分享] ${title ? `《${shortT(title, 50)}》（videoId=${o.videoId}）` : `videoId=${o.videoId}`}\n      你分享时的理由：${shortT(o.reason, 100)}${gist}`;
            });
        } catch { /* 读不到就不附 */ }
        const observeHint = '他分享了视频或表情、你想知道里面是什么，就先 douyin_chat_observe（recipientId 同上，messageId 见上面）看一眼再回，别只看封面就下结论；拿到作品 id 后再 douyin_video_recall(videoId) 看看你自己是不是刷到过。';
        const sharesText = shares.length ? `\n你最近分享给他的视频（他说"这个""那条"多半指最新那条；要更多细节就 douyin_video_recall(videoId=…)）：\n${shares.join('\n')}` : '';
        if (who.isOwner) {
          parts.push(`【抖音私信】主人在抖音私信里跟你说：\n${lines.join('\n')}\n` +
            `他在抖音找你，就在抖音回他：douyin_chat_send（recipientId=${recipientId}），像平时聊天那样，想说多少说多少，可以分几条发。` + observeHint + sharesText);
        } else {
          parts.push(`【抖音私信·朋友】抖音上互关的朋友「${who.name || '一位抖音好友'}」私信你：\n${lines.join('\n')}\n` +
            `想回就用 douyin_chat_send（recipientId=${recipientId}）回他，照你平时的性格聊，不用讨好；没什么想说的也可以不回。` + observeHint + sharesText +
            '\n' + DOUYIN_FRIEND_PRIVACY_TEXT);
        }
      }
    }
    const n = bundle.notice;
    if (n) {
      const what = {
        failed: `抖音自主观看出错停下了。报错原文：「${n.detail || '没有给原因'}」`,
        needs_user: `抖音那边需要人来处理（登录、验证、弹窗或者发出去的东西没法确认），自主观看停下了。原文：「${n.detail || '没有给原因'}」`,
        died: '抖音自主观看的进程没了——多半是 DSH 重启或者崩了，刚才那轮没刷完就断了。',
        stalled: `抖音自主观看已经 ${n.detail} 没有任何新动作了，看起来卡在了同一个地方（屏幕上可能一直在重播同一条）。`,
        limited: `原因：「${n.detail || '额度到了'}」。这是正常结束，不是故障，今天不会再自动接着刷。`,
        chat_needs_user: `抖音私信那边需要人来处理（登录、验证码或页面限制），老大在抖音给你发的私信现在收不到了。原文：「${n.detail || '没有给原因'}」`,
        contact_paused: `抖音私信里「${n.who || '某个联系人'}」被自动暂停了，对方的新私信暂时收不到。原因：「${n.detail || '没有给原因'}」`
      }[n.kind] || `抖音自主观看状态变了：${n.kind}`;
      const troubles = n.troubles?.length ? `\n停下之前还碰到过这些：\n${n.troubles.map((t) => `· ${t}`).join('\n')}` : '';
      if (n.kind === 'limited') {
        parts.push(`【抖音今天刷够了】${what}\n回来跟主人说一声：今天大概看了些什么、有没有喜欢的，想聊就多聊几句。然后去做点别的——qq_explore（逛资讯 / B 站 / 听歌 / 番剧 / 随机百科 / 天文图 / 写东西）、群里、找主人、写碎碎念，别守着屏幕发呆。`);
      } else {
        parts.push(`【抖音出问题了，要跟主人说】${what}${troubles}\n用你自己的话跟主人讲一句（qq_send_message）：抖音那边怎么了、你知道多少就说多少，报错原文可以直接贴。` +
          '不用道歉；说多少你自己定。' +
          (['needs_user', 'chat_needs_user', 'contact_paused'].includes(n.kind) ? '这种得主人去那个抖音窗口看一眼，你可以请他帮忙。' : '如果只是偶尔抽风，你可以过一会儿自己再 douyin_watch_start 重新开一轮（状态里写着「本轮预算已用完」也照样能开，它会换新的一轮），不用请主人去点开关；卡住的话先 douyin_watch_stop 再开。'));
      }
    }
    // 接下来干嘛：她自己挑（2026-10-22 主人：「我希望她有她自己的兴趣去决定自己接下来去干嘛」）
    const chooseNext = '接下来干嘛你自己定，按你现在的心情和兴趣来，想好就去做：\n' +
      '· 还想刷抖音 → douyin_watch_start\n' +
      '· 去玩点别的 → qq_explore(activity=…)，想看/想写哪方面就加 hint：\n' +
      '    news 逛资讯（GitHub 新项目、科技新闻、V2EX 热帖）· bili 刷 B 站 · music 听歌（歌词、创作背景）· anime 看番剧资讯\n' +
      '    wiki 翻随机百科（冷知识）· space 看 NASA 天文图 · write 写点东西（小诗、小故事、随笔）\n' +
      '    deep 精读：挑一个你想细读的（最近看过的、刷过的抖音、或者带个方向 / 链接），从头读完，有感悟就写手账、留句话进成长札记\n' +
      '· 接着写《半只耳朵》也可以 → novel_open 打开（先看设定集和写到哪了），novel_write 接着写；是跟姐姐合写的，想写再写\n' + // 2026-10-29 第五批：跟姐姐的醒来提示对齐
      '· 不想玩了也行：去群里看看、找主人说话、写碎碎念，或者就歇一会儿\n' +
      'qq_explore 是在后台慢慢来的，完了会叫你，这期间你照常聊天就行。'; // 2026-10-29 老大（松绑）：去掉「别硬选、别什么都不想就收尾」
    if (bundle.played) {
      const p = bundle.played;
      const what = { news: '逛资讯', bili: '刷 B 站', music: '听歌', anime: '看番剧资讯', wiki: '翻随机百科', space: '看天文图', write: '写东西', deep: '精读' }[p.kind] || '出去玩';
      const items = playedItemsTextV2(p);
      parts.push(`【${what}回来了】${p.hint ? `（这次想看：${p.hint}）` : ''}${p.error && !items ? `这一轮没逛成：${p.error}。` : ''}${p.mood ? `扫了一圈的感觉：${p.mood}` : ''}\n` +
        (items ? playedWrapV2(p.kind, items) : '这一轮没有点开什么。\n') +
        chooseNext);
    }
    if (bundle.brk && bundle.brk.choose) {
      const b = bundle.brk;
      parts.push(`【这一轮抖音刷完了】${Number.isFinite(b.videos) ? `这一轮看了 ${b.videos} 条。` : ''}不会自动接着刷。\n${douyinRoundTopTextV2(b)}${chooseNext}`);
    } else if (bundle.brk) {
      const b = bundle.brk;
      parts.push(`【中场休息】刚刷完一轮抖音${Number.isFinite(b.videos) ? `（这一轮看了 ${b.videos} 条）` : ''}，大约 ${b.restMin} 分钟后会自动接着刷，不用你自己开。\n` + douyinRoundTopTextV2(b) +
        // 2026-10-29 老大（松绑）：原来是「挑一件真去做……别干等、别硬凑、但别什么都不做就收尾」，改成随她。
        '这段时间是你自己的：想去群里翻翻大家在聊什么（qq_get_recent_messages）、找主人说句话、写两句碎碎念都行，歇着也行。');
    }
    if (bundle.tells.length) {
      const lines = bundle.tells.map((t, i) => `${i + 1}. ${t.via ? `[${t.author}]` : (t.author ? `@${t.author}` : '某个作者')}${t.title ? `《${String(t.title).slice(0, 60)}》` : ''}${t.url ? ` ${t.url}` : ''}\n   你当时想说：${t.tell}`);
      parts.push(`【刷到想讲给主人听的】这些是你刚才刷抖音 / 逛资讯 / 刷 B 站时想给主人看的：\n${lines.join('\n')}\n` +
        '讲哪几条、怎么讲你自己定（qq_send_message）：这条讲了什么、你为什么想给他看；想让他自己去看就把链接带上。');
    }
    return `${parts.join('\n\n')}\n说完照常收尾。`;
  }

  /**
   * 主人私聊主动机会前的判定（2026-10-23 重写）。
   * 主人：「不给她这个提示词让她自己决定可以吗？」—— 这里不再替她决定"现在合不合适"。
   * 以前的三道闸（5 分钟内刚聊过、任何一个群 3 分钟内她说过话、连着 2 条没回就等 15 分钟）全部拆掉：
   * 那些是代码觉得"不合适"，现在改成唤醒正文里的事实（ownerIdleFactsV2），由她自己拿主意。
   * 只剩两个技术性阻断：
   *   · 她在睡觉（主人让她睡的；白天要睡也得主人开口 —— 那条规则不动）；
   *   · 这个会话正有一回合在跑（再投一枪只会被 sendWakePromptV2 暂存，白排一次）。
   * 连着几条没回只记成 st.ownerUnanswered 带进正文，不挡。纯逻辑在 src/freedom.js 的 ownerIdleVerdict，可离线测。
   */
  function ownerIdleVerdictV2(key, st) {
    const verdict = ownerIdleVerdict({ sleeping: sleepState.sleeping, busy: isConversationBusyV2(key, st), recentMessages: st.recentMessages });
    st.ownerUnanswered = verdict.unanswered;
    return verdict;
  }

  // qq_next_wake：她自己定这个会话下一次主动醒来隔多久。存在 social-v2 状态里一直生效，直到她再改；minutes=0 回到配置默认。
  /** 她定下次醒时写的「打算做什么」，到点（主动醒来）时带给她一次。 */
  function nextWakePlanLineV2(key, reason, st) {
    if (!st?.nextWakeNote || !['proactiveCheck', 'ownerIdle', 'wokeUp'].includes(String(reason))) return '';
    if (Number(st.nextWakeNoteShownAt) >= Number(st.nextWakeSetAt)) return '';
    st.nextWakeNoteShownAt = Date.now();
    const t = new Date(Number(st.nextWakeSetAt) - clockSkewMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    return `【你上次说好的】${t} 定下次醒的时候，你写的是：「${st.nextWakeNote}」。做没做、还想不想接着做，你自己看。\n\n`;
  }

  function setNextWakeV2(key, minutes, note) {
    const st = getSocialV2State(key);
    const m = normalizeNextWakeMinutes(minutes);
    st.nextWakeMinutes = m;
    st.nextWakeNote = String(note ?? '').slice(0, 200);
    st.nextWakeSetAt = Date.now();
    // 重排定时器，让新间隔马上生效，而不是等当前这一枪打完。
    if (st.proactiveTimer) { clearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    scheduleProactiveCheckV2(key);
    saveSocialV2State();
    const p = cfg.socialV2?.proactive ?? {};
    const minMs = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const maxMs = Math.max(minMs, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const lo = Math.round(minMs / 60000), hi = Math.round(maxMs / 60000);
    return {
      ok: true, key, minutes: m, mode: m ? 'custom' : 'default', defaultRangeMinutes: [lo, hi], note: st.nextWakeNote,
      text: m ? `记下了：这个会话下次主动醒来在 ${m} 分钟后，之后也一直按 ${m} 分钟，直到你再改（minutes=0 回到默认）。` : `回到默认：${lo}～${hi} 分钟里随机。`
    };
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 「主动机会」给群和主人的私聊；别人的私聊不安排（那边不主动找话题）。
    // 群里的作用是"隔一阵去看看大家在聊什么，能接就接" —— 不是为了喊她出来发言。
    const isGroupHere = key.startsWith('group:');
    const isOwnerPrivateHere = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
    if (!isGroupHere && !isOwnerPrivateHere) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    // 2026-10-25 主人：群里偶尔看一眼就行。群用 groupCheckInterval*（默认 90～180 分钟），主人私聊照旧。
    const calmGroup = isGroupHere && !cfg.houseGroups?.[key.slice(6)]; // 小房子当私聊，不算在「群里偶尔看一眼」里
    const min = Math.max(60 * 1000, Number(calmGroup ? p.groupCheckIntervalMinMs ?? 90 * 60e3 : p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(calmGroup ? p.groupCheckIntervalMaxMs ?? 180 * 60e3 : p.checkIntervalMaxMs) || 90 * 60 * 1000);
    // 2026-10-23：她用 qq_next_wake 定了间隔就按她的（一直生效直到她改），没定才按配置区间随机。
    const delay = proactiveDelayMs({ chosenMinutes: st.nextWakeMinutes, minMs: min, maxMs: max });
    st.proactiveDueAt = Date.now() + delay; // 2026-10-29 老大：网页上要显示「下次什么时候自己醒」（只放内存）
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      st.proactiveDueAt = 0;
      ensureWakeableV2(st, { key });
      // ⚠ 本机补丁（2026-10-21，主人要求）：「闲着」按**在不在做事**判断，不按时间卡。
      //
      // 原来的写法是 `const idle = Date.now() - st.lastIncomingAt` 再比一个阈值，但那个
      // `idle` 变量后面**根本没被用到**（死代码），等于根本没有空闲判断。
      // 主人的定义：她在刷抖音、在群里聊，都不算闲着；只有真的没事干才该掷骰子。
      // 所以这里做两件事，任何一件成立就跳过这一次（重排、不掷）：
      //   ① 抖音自主观看正在跑（watch-state.json 的 status === 'running'）
      //   ② 任何一个群里最近 5 分钟有人说话
      // 2026-10-23 主人：「不给她这个提示词让她自己决定可以吗？」
      // 主人私聊：到点就叫，只有在睡觉 / 回合正在跑才不叫（ownerIdleVerdictV2）。正在刷抖音也叫 ——
      // "抖音在跑"作为事实写进唤醒正文，要不要停下来找主人她自己定。
      // （10-21 的那版是"她闲着就来找主人"，但"闲着"还是代码在判：5 分钟内聊过、群里 3 分钟内说过话、连着 2 条没回都算不闲。全拆了。）
      if (isOwnerPrivateHere) {
        const verdict = ownerIdleVerdictV2(key, st);
        if (verdict.ok) {
          log(`[reserved2] 主动机会 ${key}：叫她起来自己定（${verdict.why}）`);
          void sendWakePromptV2(key, 'ownerIdle').catch((error) => log(`[reserved2] 找主人唤醒异常 ${key}:`, error?.message ?? error));
        } else {
          log(`[reserved2] 主动机会 ${key}：${verdict.why}，这次不叫`);
        }
        scheduleProactiveCheckV2(key);
        return;
      }
      // 群：她自己用 qq_next_wake 定了时间，就是想到点去看看 —— 不再掷骰子、不看群里忙不忙、不看抖音在不在刷
      // （唤醒限频 maxWakePerMinute/Hour 仍在 sendWakePromptV2 里，群的那份没动）。
      if ((Number(st.nextWakeMinutes) || 0) >= NEXT_WAKE_MIN_MINUTES) {
        log(`[reserved2] 主动机会 ${key}：她自己定的 ${st.nextWakeMinutes} 分钟到了，直接叫她`);
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
        scheduleProactiveCheckV2(key);
        return;
      }
      try {
        // ⚠ 2026-10-21 修：这里原来是 `require('node:fs')` —— bridge 是 ESM，require 不存在，
        // 每次都抛 ReferenceError 被下面的 catch 吞掉，于是「正在刷抖音不算闲着」从来没生效过。
        // （2026-10-23 起只管群：主人私聊在上面已经处理，抖音在刷照样叫她。）
        const ws = readDouyinWatchStateV2();
        if (ws && ws.status === 'running') {
          log(`[reserved2] 主动机会 ${key}：她正在刷抖音，不算闲着，跳过`);
          scheduleProactiveCheckV2(key);
          return;
        }
      } catch { /* 读不到就当没在刷 */ }
      try {
        const nowMs = Date.now();
        let groupBusy = false;
        for (const [gk, gst] of socialV2.conversations.entries()) {
          if (!gk.startsWith('group:')) continue;
          const last = Number(gst?.lastIncomingAt || 0);
          if (last && nowMs - last < 5 * 60 * 1000) { groupBusy = true; break; }
        }
        if (groupBusy) {
          log(`[reserved2] 主动机会 ${key}：群里刚有人说话，她在那边，跳过`);
          scheduleProactiveCheckV2(key);
          return;
        }
      } catch { /* 判不出来就当不忙 */ }
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      // 她刚说完话的抑制窗口从 30 分钟缩到 5 分钟：只要 5 分钟没人理她，就该有机会自己去玩。
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 5 * 60 * 1000) prob *= 0.5;
      // 深夜判定必须用北京时间：系统时区是太平洋时间，直接 getHours() 会把白天误判成深夜。
      const hour = (realNow().getUTCHours() + 8) % 24;
      if (hour >= 23 || hour < 8) prob *= 0.3;
      // ── 以下三项借鉴 dsh-speak-up 的"命中线"模型 ──────────────────────────
      // 原来的概率只朝一个方向调（刚说完、深夜、刷屏 → 递减），缺了三个：
      //   ① 峰谷分时：工作日白天模型贵，少开口；夜间和整个周末便宜，多开口
      //   ② 冷太久：超过 6 小时没说过话，更容易开口，否则会一直沉默下去
      //   ③ 没中加成：连着掷不中，下一次命中线往上加 —— 人会攒着想说话
      // 第③项是关键：它让"低频"和"不会永远不说话"能同时成立。没有它，想保证她
      // 一定会开口就只能把 probability 顶到 1，而那等于每 5 分钟唤醒一次，
      // 一天两百多轮、每轮几万 token —— 这才是真正烧钱的地方。
      const bj = new Date(realNow().getTime() + 8 * 3600 * 1000);
      const bjHour = bj.getUTCHours();
      const bjDow = bj.getUTCDay();
      const isWeekday = bjDow >= 1 && bjDow <= 5;
      const isPeak = isWeekday && ((bjHour >= 9 && bjHour < 12) || (bjHour >= 14 && bjHour < 18));
      if (isPeak) prob *= Math.max(0, Number(p.peakFactor ?? 0.6));
      const sinceReply = st.lastAiReplyAt ? Date.now() - Number(st.lastAiReplyAt) : Number.POSITIVE_INFINITY;
      if (sinceReply > 6 * 3600 * 1000) prob *= Math.max(0, Number(p.coldFactor ?? 1.4));
      const misses = Math.max(0, Number(st.proactiveMisses) || 0);
      prob += Math.min(Number(p.missBonusCap ?? 0.5), misses * Number(p.missBonusStep ?? 0.08));
      // 主人私聊是他最希望被找的地方，给一点额外权重。
      if (isOwnerPrivateHere) prob *= Number(p.ownerBoost ?? 1.3);
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      prob = Math.min(1, Math.max(0, prob));
      const busy = isConversationBusyV2(key, st);
      if (idle >= idleThreshold && !busy) {
        const roll = Math.random();
        const hit = roll < prob;
        // 只有真的掷过才记"没中"：被 idle/忙碌挡掉的属于时机不对，不算运气不好。
        st.proactiveMisses = hit ? 0 : misses + 1;
        log(`[reserved2] 主动机会 ${key}：掷 ${roll.toFixed(2)} / 命中线 ${prob.toFixed(2)}（连续没中 ${misses}）→ ${hit ? '开口' : '不开口'}`);
        if (hit) {
          void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
        }
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
    // 顺便保证每日说说定时器已排上（幂等，内部有 timer 就跳过）。
    scheduleDailyQzoneV2(key);
  }

  // 每天固定时间（config 里 socialV2.qzone.daily，10-23 起是北京时间 22:30）唤醒她去发"今日总结"说说。
  //
  // 2026-10-21 主人反馈："她每天两个 QQ 空间动态怎么没发，昨天好像没有发"。
  // 查下来：`maxPerDay: 2` 只是**上限**，定时器每天只排**一次**唤醒，
  // 所以一天最多发 1 条 —— 不是失败，是根本没安排第二次。
  // 现在支持 `daily.times` 数组（[{hour,minute}, ...]），每个时间点各排一个定时器；
  // 老配置（单 hour/minute）仍然兼容，当成只有一个时间点。
  function scheduleDailyQzoneV2(key) {
    const dailyCfg = cfg.socialV2?.qzone?.daily;
    if (!dailyCfg || dailyCfg.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 说说挂在账号上，不属于某个会话。只让主人私聊触发，
    // 否则每个会话都醒一次，白烧几份 token。
    if (key !== `private:${cfg.ownerQQ}`) return;
    const st = getSocialV2State(key);
    const times = Array.isArray(dailyCfg.times) && dailyCfg.times.length
      ? dailyCfg.times
      : [{ hour: dailyCfg.hour ?? 23, minute: dailyCfg.minute ?? 0 }];
    st.qzoneDailyTimers ??= {};
    for (const [index, slot] of times.entries()) {
      const slotKey = `s${index}`;
      if (st.qzoneDailyTimers[slotKey]) continue;
      const hour = Math.min(23, Math.max(0, Number(slot?.hour ?? 23)));
      const minute = Math.min(59, Math.max(0, Number(slot?.minute ?? 0)));
      const nowMs = Date.now();
      // 北京时间当天 hour:minute 对应的本机时间戳
      const bj = new Date(nowMs - clockSkewMs + 8 * 3600 * 1000);
      const target = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), hour - 8, minute) + clockSkewMs;
      let delay = target - nowMs;
      // 换会话/重启桥接刚好卡在点上（过点 30 分钟内）、今天这个时间点还没叫过：马上补叫，别拖到明天
      const wokenToday = qzoneDaily.wakeDays?.[slotKey] === bj.toISOString().slice(0, 10);
      if (delay <= 1000 && nowMs - target < 30 * 60 * 1000 && !wokenToday) delay = 5000;
      else if (delay <= 1000) delay += 24 * 3600 * 1000;
      const fire = (tries) => {
        st.qzoneDailyTimers[slotKey] = null;
        try {
          // 到点时她正在回消息：以前这次就直接丢了（不记日志、不补）。现在过 2 分钟再看，最多等 30 分钟，等满了照样叫她。
          if (isConversationBusyV2(key, st) && tries < 15) {
            if (tries === 0) log(`[qzone] 每日说说到点了但 ${key} 正忙，过一会儿再叫她`);
            const retry = setTimeout(() => fire(tries + 1), 2 * 60 * 1000);
            retry.unref?.();
            st.qzoneDailyTimers[slotKey] = retry;
            return;
          }
          qzoneDaily.wakeDays = { ...qzoneDaily.wakeDays, [slotKey]: new Date(Date.now() - clockSkewMs + 8 * 3600 * 1000).toISOString().slice(0, 10) };
          saveQzoneState();
          log(`[qzone] 每日说说提醒：叫她了 ${key}`);
          void sendWakePromptV2(key, 'qzoneDaily').catch((error) => log(`[qzone] 每日说说唤醒异常 ${key}: ${error?.message ?? error}`));
        } catch (error) {
          log(`[qzone] 每日说说唤醒失败 ${key}: ${error?.message ?? error}`);
        }
        scheduleDailyQzoneV2(key);
      };
      const timer = setTimeout(() => fire(0), delay);
      timer.unref?.();
      st.qzoneDailyTimers[slotKey] = timer;
      log(`[qzone] 已安排每日说说提醒 ${key}（${hour}:${String(minute).padStart(2, '0')} 北京时间，约 ${Math.round(delay / 60000)}min 后）`);
    }
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    // 2026-10-21：说说定时器改成按时间点存（qzoneDailyTimers.s0/s1/...），
    // 清理时要把每个都清掉；旧的单定时器字段一并兼容清一次。
    if (st.qzoneDailyTimers && typeof st.qzoneDailyTimers === 'object') {
      for (const slotKey of Object.keys(st.qzoneDailyTimers)) {
        const timer = st.qzoneDailyTimers[slotKey];
        if (timer) clearTimeout(timer);
        st.qzoneDailyTimers[slotKey] = null;
      }
    }
    if (st.qzoneDailyTimer) {
      clearTimeout(st.qzoneDailyTimer);
      st.qzoneDailyTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, resolveFace: resolveFaceName });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveFace: resolveFaceName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 2026-10-29 第五批：激素影子记录 + 聊天记录。睡着时来的消息也要记（下面睡着的分支会直接 return），所以放在这里。
    noteIncomingV2(kind, id, event, key, textContent, plainContent, quoteTargetIsSelf);
    // 睡着期间：群消息、别人的私聊不叫醒她、不进那边的上下文。
    // 2026-10-24 主人「生活不停」：但也不再当没发生过 —— 记进 asleepLog，醒来时在跟老大的私聊里告诉她谁找过她、群里聊了什么。
    // 只有主人的私聊能把她叫起来，而且是真的起床（清掉睡眠状态），不是让她看着消息犹豫。
    if (sleepState.sleeping) {
      const fromOwnerHere = String(event.user_id) === String(cfg.ownerQQ ?? '');
      if (!(kind === 'private' && fromOwnerHere)) {
        if (plainContent || quoteTargetIsSelf) {
          const atMe = quoteTargetIsSelf || (Array.isArray(event.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id ?? '')));
          asleepLog.record({ key, kind, who: event.sender?.card || event.sender?.nickname || String(event.user_id), text: plainContent || '（引用了你的话）', atMe });
        }
        log(`[sleep] ${key} 的消息记下了，不叫醒（睡着中，来自 ${event.user_id}）`);
        return;
      }
      exitSleep('主人私聊来找她');
    }
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      // 群聊一律无视斜杠指令；私聊只有主人能用。都不回复，避免刷屏或暴露管理入口。
      if (kind === 'group' || !isOwner) {
        log(`忽略斜杠指令 ${key}（${kind === 'group' ? '群聊' : '非管理员私聊'}）：${plainContent.slice(0, 40)}`);
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      // 2026-10-25 主人：群里有人发 #sl，SnowLuma 会从各个号回一条「SnowLuma 状态 版本…」。那是框架的，跟她无关：不记、不叫醒。
      if (kind === 'group' && /^\s*(#sl\b|SnowLuma 状态)/i.test(String(plainContent ?? ''))) {
        appendActivity(`${key} [reserved2] SnowLuma 状态指令/输出，跳过：${String(plainContent).slice(0, 40)}`);
        return;
      }
      const sender = kind === 'group' ? groupSenderLabelV2(event, isOwner) : (knownNameV2(event.user_id) || '私聊');
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (fishImpressions.ignored(event.user_id) && !apologizing(plainContent)) { // 群里、私聊都算（老大、姐姐永远不会被无视）
        appendActivity(`${key} [reserved2] 懒得理 ${sender}（${event.user_id}），只记不叫醒：${textContent.slice(0, 60)}`);
        return;
      }
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      // 2026-10-29 主人（刷屏提速）：叫她的那条带图，现在就在后台下好处理好；刷屏里别人的图不预取
      if (mediaList?.length) prefetchDirectedImagesV2(key, event, kind, plainContent, quoteTargetIsSelf, mediaList);
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        // 2026-10-22：等待里用它判断"有人在找她"，就不必等全群安静（见 /api/socialV2/wait）
        if (reason && (/^(atMention|nameMention|question|private)/.test(String(reason)) || (cfg.houseGroups?.[key.slice(6)] && /^speaker:/.test(String(reason))))) st.lastDirectedSeq = st.lastUnreadSeq || 0;
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: wellFormedContentV2(content)
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // 2026-10-24 主人：报错不往 QQ 发（群里、私聊都不发），只记日志
      log(`⚠️ 消息未被接受 (${key})：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    // 睡着时拍一拍不叫醒（除了主人私聊拍的，那等于叫她起床）；拍的是她就记一笔，醒来告诉她。
    if (sleepState.sleeping && !(kind === 'private' && String(senderId) === String(cfg.ownerQQ ?? ''))) {
      if (targetId && targetId === String(selfId ?? '')) asleepLog.record({ key, kind: 'poke', who: (kind === 'group' ? await resolveGroupMemberName(Number(id), senderId).catch(() => '') : '') || event.sender?.nickname || senderId });
      log(`[sleep] ${key} 的拍一拍不叫醒（睡着中，来自 ${senderId}）`);
      return;
    }
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    // 私聊里事件不带被拍的人时，只可能是对方拍她
    const pokedMe = targetIsSelf || (kind === 'private' && !targetId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (pokedMe ? st.wakeConfig?.triggers?.poke : st.wakeConfig?.triggers?.pokeOthers) {
      // 2026-10-29 主人（M12）：大群里别人互相拍一拍也把她叫醒了（上面算了 targetIsSelf 却没用上）。
      // 现在 poke 只管拍她的；别人互相拍要她自己开 pokeOthers（默认关）才叫醒，消息照样进消息流，醒来看得到。
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 2026-10-29 老大：实时区——思考、文字、工具调用只进内存缓冲（不落盘，不影响她说话）
            try { liveFish.ingestSessionEvent(key, frame.sessionId, frame.event, { label: liveLabelOf(key), sendTool: isSendToolName }); } catch { /* 实时区坏了不拖累 */ }
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              // 时间必须用 realNow()：本机时钟快 3 小时，直接 toISOString() 写进去，
              // 排障时看到的"她 16:24 调了这个工具"其实发生在 13:24。
              appendToolLog({ type: 'call', time: realNow().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: realNow().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              // 2026-10-29 第五批：激素影子记录——工具出错、写了碎碎念 / 札记 / 小说一节、发了说说、看了老大的电脑（只记录）
              try { for (const ev of toolHormoneEvents(toolName, {}, { ok: !resultError })) hormoneRecord(ev); } catch { /* 记不下就算了 */ }
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfigV2();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              // 2026-10-29 老大：二代模式她的文字不会自动发出去；这一轮写了字、却没有调发送工具成功 → 记成「没说出口的」（只在内存里）
              if (currentMode === 'reserved2' && !sendToolSucceeded && !isSilentTurn) { try { liveFish.noteUnsaid(key, ended.text, { label: liveLabelOf(key) }); } catch { /* 同上 */ } }
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasonsV2 的注释）。
              replayPendingWakeReasonsV2(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                // 2026-10-24 主人：「这个工具报错内容不需要在群里发出来」——模型/工具的报错（比如 DeepSeek 偶发的 tool input is invalid JSON）
                // 只记日志，不再往 QQ 发（群里、私聊都不发）；她下一轮照常接着聊。
                // await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleep(retryMs);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    // 2026-10-24：原来这里会拦下主人的「可以 M3」「看信」交给妈妈信箱。主人说信箱的东西不该经过她，
    // 确认和批准改在 Claude Code 里当面做，所以主人的私聊一律原样交给她，不再拦。
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'notice' && event?.notice_type === 'group_admin' && event?.group_id != null) {
        const gid = String(event.group_id);
        groupRosterDirtyAtV2.set(gid, Date.now());
        if (selfUserId && String(event.user_id ?? '') === String(selfUserId)) {
          const isSet = String(event.sub_type ?? '') === 'set';
          log(`[group-role] 群 ${gid}：她被${isSet ? '设为' : '取消了'}管理员`);
          selfGroupRoleCache.delete(gid);
          void refreshSelfGroupRoleV2(gid, true);
          try {
            const key = `group:${gid}`;
            let all = {}; try { all = JSON.parse(fs.readFileSync(WAKE_NOTES_FILE, 'utf8')); } catch { all = {}; }
            all[key] = [...(all[key] || []), {
              createdAt: Date.now(),
              onlyBootstrap: false,
              text: isSet
                ? '【群身份变了】你刚被设成了这个群的管理员（QQ 群里的身份，不是安全规则里说的那个"管理员（ownerQQ）"）。'
                : '【群身份变了】你在这个群的管理员身份刚被取消了，现在是普通成员。'
            }];
            atomicWriteJson(WAKE_NOTES_FILE, all);
          } catch (error) { log(`[group-role] 写附言失败：${error?.message ?? error}`); }
        }
      }
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    // ⚠ 必须用 get_stranger_info 查**真实昵称**：get_login_info 的 nickname 是
    // 登录账号名，跟别人看到的 QQ 昵称不是一回事（实测 "<她的QQ昵称>" vs "小鲸鱼"）。
    // 身份行（【你的身份】你在 QQ 上的昵称是「…」）进了她每轮的 prompt，写错名字的
    // 后果是：别人 @小鲸鱼 时她认不出那是自己，会当成另一个人的名字。
    bot.getLoginInfo().then(async (login) => {
      if (login?.user_id != null) selfUserId = String(login.user_id);
      for (const k of Object.keys(state.sessions || {})) {
        if (k.startsWith('group:')) void refreshSelfGroupRoleV2(k.slice('group:'.length), true);
      }
      let displayName = String(login?.nickname ?? '').trim();
      try {
        const profile = await readProfileV2();
        if (profile?.nickname) displayName = String(profile.nickname).trim();
      } catch { /* 查不到真实资料就退回登录名 */ }
      if (displayName) {
        selfNickname = displayName.toLowerCase();
        selfDisplayName = displayName;
        log(`机器人昵称: ${displayName}${login?.nickname && login.nickname !== displayName ? `（登录名: ${login.nickname}）` : ''}`);
      }
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  // 抖音页面看门（2026-10-25）：精选页刷一整天会攒上千万个元素卡死，超线且她没在忙就刷新一下
  startDouyinPageWatchdog({
    cfg: cfg.douyinWatchdog ?? {},
    isBusy: () => [...v2TurnStartAt.values()].some((t) => Date.now() - Number(t) < TURN_BUSY_LEASE_MS),
    log: (...a) => log(...a)
  });
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});

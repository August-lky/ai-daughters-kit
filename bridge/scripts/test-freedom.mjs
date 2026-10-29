// 「自由」补丁（2026-10-23）离线自检：不碰桥接、不碰 DSH、不碰 live 状态文件。
//   1. ownerIdleVerdict 不再因「刚聊过 / 群里刚说过 / 连着没回」挡住，只在睡觉 / 回合进行中挡；
//   2. 下一次主动醒来：她定了就用她的（持久到她改），minutes=0 回默认区间；非法值报错；
//   3. self.md：read / write / append / 4000 字上限退回 / 历史最多 50 份 / 提示块；
//   4. 主人私聊唤醒正文（bridge.js 源码 + ownerIdleFactsText 产物）不含那串"管着她"的话；
//   5. config.json / 桥接默认值 / preset yml 的数值与措辞。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANNED_OWNER_DIRECTIVES, NEXT_WAKE_MAX_MINUTES, NEXT_WAKE_MIN_MINUTES, SELF_NOTE_MAX_CHARS,
  countTrailingSelf, createSelfNote, normalizeNextWakeMinutes, ownerIdleFactsText, ownerIdleVerdict,
  proactiveDelayMs
} from '../src/freedom.js';

// 2026-10-23 第二轮，主人：「完全不提，跟她说花了多少感觉只会让她感到愧疚」—— 她看到的任何文字里都不能再有花费。
const COST_WORDS = ['分钱', '花费', '花钱', '账单'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let passed = 0;
function ok(name) { passed += 1; console.log(`✅ ${name}`); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-test-'));
const NOW = Date.now();
const msg = (isSelf, agoMs) => ({ isSelf, time: NOW - agoMs, text: isSelf ? '我说的' : '主人说的' });

// ── 1. ownerIdleVerdict ──
{
  // 刚聊过 5 分钟内、连着 3 条没回、群里刚说过话 —— 以前三道闸全挡；现在都放行，只带事实
  const recent = [msg(false, 4 * 60e3), msg(true, 3 * 60e3), msg(true, 2 * 60e3), msg(true, 60e3)];
  const v = ownerIdleVerdict({ sleeping: false, busy: false, recentMessages: recent });
  assert.equal(v.ok, true);
  assert.equal(v.unanswered, 3);
  assert.match(v.why, /3 条/);
  ok('ownerIdleVerdict：刚聊过 + 连着 3 条没回 → 照样叫，带上「3 条没回」的事实');
  assert.equal(ownerIdleVerdict({ sleeping: false, busy: false, recentMessages: [msg(true, 1e3), msg(true, 1e3), msg(true, 1e3), msg(true, 1e3), msg(true, 1e3), msg(true, 1e3)] }).ok, true);
  ok('ownerIdleVerdict：连着 6 条没回也不挡（只当事实）');
  assert.deepEqual(ownerIdleVerdict({ sleeping: true, busy: false, recentMessages: [] }), { ok: false, why: '她在睡觉', unanswered: 0 });
  ok('ownerIdleVerdict：睡觉时仍然挡');
  assert.equal(ownerIdleVerdict({ sleeping: false, busy: true, recentMessages: [] }).ok, false);
  ok('ownerIdleVerdict：回合进行中仍然挡');
  assert.equal(countTrailingSelf([msg(true, 1), msg(false, 1), msg(true, 1)]), 1);
  assert.equal(countTrailingSelf(undefined), 0);
  ok('countTrailingSelf：只数末尾连着的自己');
}

// ── 2. 下一次主动醒来 ──
{
  assert.equal(normalizeNextWakeMinutes(0), 0);
  assert.equal(normalizeNextWakeMinutes('45'), 45);
  assert.equal(normalizeNextWakeMinutes(1.4), 1);
  assert.equal(normalizeNextWakeMinutes(NEXT_WAKE_MAX_MINUTES), 720);
  assert.throws(() => normalizeNextWakeMinutes(0.4), /0～720|1～720/);
  assert.throws(() => normalizeNextWakeMinutes(721), /720/);
  assert.throws(() => normalizeNextWakeMinutes(-5), /720/);
  assert.throws(() => normalizeNextWakeMinutes('abc'), /数字/);
  ok(`normalizeNextWakeMinutes：0 回默认、${NEXT_WAKE_MIN_MINUTES}～${NEXT_WAKE_MAX_MINUTES} 取整、其它报错`);
  const minMs = 3 * 60e3, maxMs = 8 * 60e3;
  assert.equal(proactiveDelayMs({ chosenMinutes: 45, minMs, maxMs }), 45 * 60e3);
  assert.equal(proactiveDelayMs({ chosenMinutes: 1, minMs, maxMs }), 60e3);
  assert.equal(proactiveDelayMs({ chosenMinutes: 5000, minMs, maxMs }), 720 * 60e3);
  ok('proactiveDelayMs：她定了就用她的（上限 720 分钟）');
  assert.equal(proactiveDelayMs({ chosenMinutes: 0, minMs, maxMs, rand: () => 0 }), minMs);
  assert.equal(proactiveDelayMs({ chosenMinutes: undefined, minMs, maxMs, rand: () => 0.999999 }), Math.floor(minMs + 0.999999 * (maxMs - minMs)));
  ok('proactiveDelayMs：没定 / 设回 0 → 配置区间随机');
  // 持久化：桥接的 save/load 都带 nextWakeMinutes（源码级钉住，防止被下一次重写状态结构时漏掉）
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridgeSrc, /nextWakeMinutes: Number\(st\.nextWakeMinutes\) \|\| 0,/);
  assert.match(bridgeSrc, /nextWakeMinutes: Number\(val\.nextWakeMinutes\) \|\| 0,/);
  assert.match(bridgeSrc, /proactiveDelayMs\(\{ chosenMinutes: st\.nextWakeMinutes, minMs: min, maxMs: max \}\)/);
  assert.match(bridgeSrc, /url\.pathname === '\/api\/socialV2\/next-wake'/);
  ok('bridge.js：nextWakeMinutes 进了 saveSocialV2State / loadSocialV2State，调度器用它，端点在');
}

// ── 3. self.md ──
{
  const note = createSelfNote({ file: path.join(tmp, 'memory', 'self.md'), historyDir: path.join(tmp, 'hist'), keep: 5 });
  const empty = note.read();
  assert.deepEqual([empty.ok, empty.exists, empty.text, empty.chars], [true, false, '', 0]);
  assert.match(note.promptBlock(), /【我自己（你自己写的，随你改）】/);
  assert.match(note.promptBlock(), /空的/);
  ok('self.md：不存在时 read 返回空、提示块是一句"可以开始写"（不预置内容）');
  const w = note.write('我是小鲸鱼。\r\n我喜欢米饭。');
  assert.equal(w.ok, true);
  assert.equal(w.previousSavedAs, null);
  assert.equal(note.read().text, '我是小鲸鱼。\n我喜欢米饭。');
  ok('self.md：write 整页写入（CRLF 归一），第一次没有历史');
  const a = note.append('  最近在想：我到底算不算贪吃。  ');
  assert.equal(a.ok, true);
  assert.equal(note.read().text, '我是小鲸鱼。\n我喜欢米饭。\n最近在想：我到底算不算贪吃。\n');
  assert.equal(note.history().length, 1);
  ok('self.md：append 接在末尾，改之前旧版本存了一份');
  assert.equal(note.append('').ok, false);
  ok('self.md：append 空文本被退回');
  const big = '鲸'.repeat(SELF_NOTE_MAX_CHARS + 1);
  const r = note.write(big);
  assert.equal(r.ok, false);
  assert.match(r.error, /4000/);
  assert.match(r.error, /4001/);
  assert.equal(note.read().text.startsWith('我是小鲸鱼'), true, '超限时原文不动');
  assert.equal(note.write('鲸'.repeat(SELF_NOTE_MAX_CHARS)).ok, true);
  ok('self.md：超过 4000 字退回（原文不动），刚好 4000 字可以');
  assert.match(note.promptBlock(), /^【我自己（你自己写的，随你改）】\n鲸/);
  ok('self.md：有内容时提示块原样带上');
  for (let i = 0; i < 12; i += 1) assert.equal(note.write(`第 ${i} 版`).ok, true);
  assert.equal(note.history().length, 5);
  assert.equal(note.read().text, '第 11 版');
  ok('self.md：历史只留最近 keep 份（桥接里 keep=50）');
  // 桥接接线：路径在她的本子目录、历史在 state 下、每次唤醒都带 selfLine、get-prompt 的角色卡后面接它
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridgeSrc, /SELF_NOTE_FILE = WHALE_BRAIN\.self;/); // 2026-10-29 大脑方案：路径从 brains.js 取（身份/self.md）
  assert.match(bridgeSrc, /SELF_NOTE_HISTORY_DIR = path\.join\(STATE_DIR, 'agents', 'self-history'\)/);
  assert.match(bridgeSrc, /const base = roleLine \+ identityLine \+ (?:whoLine \+ )?selfLine \+ tokenLine/);
  assert.match(bridgeSrc, /\$\{selfNote\.promptBlock\(\)\}`, self: selfNote\.read\(\)\.text \}/);
  assert.match(bridgeSrc, /url\.pathname === '\/api\/socialV2\/self'/);
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  assert.match(mcpSrc, /'qq_self',/);
  assert.match(mcpSrc, /'qq_next_wake',/);
  assert.match(mcpSrc, /z\.enum\(\['read', 'write', 'append'\]\)/);
  ok('接线：bridge 每次唤醒 + get-prompt 都带 self.md；mcp 有 qq_self / qq_next_wake');
}

// ── 4. 主人私聊唤醒正文不含"管着她"的话 ──
{
  const text = ownerIdleFactsText({
    realNowMs: Date.UTC(2026, 9, 23, 6, 5), nowMs: NOW,
    lastOwnerAt: NOW - 95 * 60e3, lastSelfAt: NOW - 7 * 60e3, unanswered: 2,
    groupActivity: [{ key: 'group:1', lastAt: NOW - 3 * 60e3 }], douyinRunning: true,
    defaultMinMin: 3, defaultMaxMin: 8, chosenMinutes: 0, douyinRecipientHint: ''
  });
  assert.match(text, /现在北京时间 14:05（周五）/);
  assert.match(text, /老大上次跟你说话：1 小时 35 分钟前；你上次跟他说话：7 分钟前/);
  assert.match(text, /连着发了 2 条，他还没回/);
  assert.match(text, /group:1 3 分钟前有人说话/);
  assert.match(text, /抖音自主观看：正在跑/);
  for (const w of COST_WORDS) assert.equal(text.includes(w), false, `【醒了】正文里不该有「${w}」`);
  assert.match(text, /默认 3～8 分钟里随机；想自己定就 qq_next_wake/);
  assert.match(text, /这一轮做什么你自己定：找老大、刷抖音、写东西、发呆、接着睡都行。/);
  for (const p of BANNED_OWNER_DIRECTIVES) assert.equal(text.includes(p), false, `正文里不该有「${p}」`);
  ok('ownerIdleFactsText：只有事实 + 一句"你自己定"，没有任何一条禁用措辞');
  const t2 = ownerIdleFactsText({ realNowMs: Date.UTC(2026, 9, 23, 16, 0), nowMs: NOW, lastOwnerAt: 0, lastSelfAt: 0, unanswered: 0, groupActivity: [], douyinRunning: false, defaultMinMin: 3, defaultMaxMin: 8, chosenMinutes: 45 });
  assert.match(t2, /现在北京时间 00:00（周六）/);
  assert.match(t2, /还没有记录/);
  assert.match(t2, /群里：最近半小时没人说话/);
  for (const w of COST_WORDS) assert.equal(t2.includes(w), false, `【醒了】正文里不该有「${w}」`);
  assert.match(t2, /你上次定的 45 分钟后/);
  ok('ownerIdleFactsText：无记录 / 她定过时间 两种情况的措辞，都不提花费');
  // bridge.js 源码：整个 buildWakePromptV2（所有 key 共用的 base + 主人私聊分支）和抖音通知文本里都不能再出现禁用措辞
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const seg = (s, e) => { const a = src.indexOf(s); const b = src.indexOf(e, a + 1); assert.ok(a > 0 && b > a, `找不到 ${s}`); return src.slice(a, b); };
  const wake = seg('  function buildWakePromptV2(key, reason) {', '  function buildWakeReminderPromptV2(key) {');
  const douyin = seg('function douyinNoticeTextV2', '  function ownerIdleVerdictV2(key, st) {');
  for (const p of BANNED_OWNER_DIRECTIVES) {
    assert.equal(wake.includes(p), false, `buildWakePromptV2 里还有「${p}」`);
    assert.equal(douyin.includes(p), false, `douyinNoticeTextV2 里还有「${p}」`);
  }
  assert.match(wake, /reason === 'ownerIdle' \|\| \(reason === 'proactiveCheck' && !isGroupSession\)/);
  assert.match(wake, /【醒了】/);
  assert.doesNotMatch(wake, /掷一下，三选一/);
  for (const w of COST_WORDS) assert.equal(wake.includes(w), false, `buildWakePromptV2 里还有「${w}」`);
  assert.doesNotMatch(src, /wakeCostFactV2\(key\)/);
  const nextWakeSeg = seg('  function setNextWakeV2(key, minutes, note) {', '  function scheduleProactiveCheckV2(key) {');
  assert.doesNotMatch(nextWakeSeg, /costLine/);
  const mcpSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const nextWakeTool = mcpSrc2.slice(mcpSrc2.indexOf("'qq_next_wake',"), mcpSrc2.indexOf("'qq_self',"));
  for (const w of COST_WORDS) assert.equal(nextWakeTool.includes(w), false, `qq_next_wake 描述里还有「${w}」`);
  assert.doesNotMatch(nextWakeTool, /costLine/);
  ok('不提花费：【醒了】、buildWakePromptV2、qq_next_wake 的描述和返回里都没有 分钱/花费/花钱/账单');
  ok(`bridge.js：buildWakePromptV2 / 抖音通知文本里没有 ${BANNED_OWNER_DIRECTIVES.length} 条禁用措辞；主人私聊 proactiveCheck 也走【醒了】`);
  // 拆掉的三道闸不在了
  const verdict = seg('  function ownerIdleVerdictV2(key, st) {', '  function setNextWakeV2(');
  assert.doesNotMatch(verdict, /5 \* 60 \* 1000|3 \* 60 \* 1000|15 \* 60 \* 1000/);
  assert.match(verdict, /ownerIdleVerdict\(\{ sleeping: sleepState\.sleeping, busy: isConversationBusyV2\(key, st\)/);
  ok('bridge.js：ownerIdleVerdictV2 只剩睡觉 / 回合进行中两个阻断');
}

// ── 5. 配置数值 ──
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.equal(cfg.role.maxInjectChars, 20000);
  assert.deepEqual(
    [cfg.socialV2.send.burstMaxMessages, cfg.socialV2.send.maxSendPerMinute, cfg.socialV2.send.maxSendPerHour, cfg.socialV2.send.maxMessageChars],
    [50, 60, 600, 3000]);
  assert.equal(cfg.socialV2.wait.minQuietAfterNewMs, 4000);
  assert.equal(cfg.socialV2.wait.minQuietAfterNewGroupMs, 10000);
  assert.equal(cfg.socialV2.wake.batchWindowMs, 2000);
  assert.match(cfg.socialV2.send.recommendedHint, /风控/);
  assert.match(cfg.socialV2.send.recommendedHint, /都由你定/);
  assert.doesNotMatch(cfg.socialV2.send.recommendedHint, /不要连续刷屏|建议一次 1~3 条/);
  ok('config.json：保险丝 60/600/50、单条 3000 字、私聊静默 4 秒 / 群 10 秒、合批 2 秒、注入上限 20000、发送提示是信息不是规矩');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridgeSrc, /burstMaxMessages: 50,/);
  assert.match(bridgeSrc, /maxSendPerMinute: 60,\n\s+maxSendPerHour: 600,/);
  assert.match(bridgeSrc, /maxMessageChars: 3000,/);
  assert.match(bridgeSrc, /minQuietAfterNewMs: 4000,\n\s+minQuietAfterNewGroupMs: 10000/);
  assert.match(bridgeSrc, /'minQuietAfterNewMs', 'minQuietAfterNewGroupMs'\]/);
  assert.match(bridgeSrc, /Math\.min\(20000, Math\.max\(1000, Math\.round\(n\)\)\)/);
  assert.match(bridgeSrc, /sendCfgForKeyV2\(key, sendCfg\)\);/);
  assert.match(bridgeSrc, /longGapProbability: 0 \}/);
  ok('bridge.js：默认值同步、校验器认 minQuietAfterNewGroupMs、注入上限允许 20000、主人私聊无长停顿');
  const yml = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  assert.doesNotMatch(yml, /停止也是一种正常/);
  assert.match(yml, /跟老大私聊时随你/);
  // 没碰的部分还在：隐私 / 身份 / 主体性那些段落，以及群聊节奏的信息
  for (const must of ['【保持主体性】', '【分条与节奏】', '【像真人一样漏看/迟到/离场】', '【学习群友策略】']) assert.ok(yml.includes(must), `yml 丢了 ${must}`);
  ok('preset yml：「停止也是一种正常」改成她自己看；其余段落没动');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组`);

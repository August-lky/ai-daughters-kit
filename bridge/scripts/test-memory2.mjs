// 「记忆」第二轮（2026-10-23）离线自检：不碰桥接、不碰 DSH、不碰 live 状态文件。
//   1. 便签：read / write / append / 1000 字上限退回 / 历史 30 份 / 提示块；只在主人私聊的唤醒里带；
//   2. 搬家交接：最近 3 小时 vs 最后 200 句取多的、每句 300 字、总长上限丢最旧的；便签原样带走；瞬间块的标题；
//   3. 主人私聊自动换会话阈值 200k → 400k（群仍 250k）；
//   4. 【对方刚说】块：主人私聊 / 群 两种；没有 6 位以上数字；以空行结尾；没人说过话就省掉；
//   5. 表情包频率规矩没了（源码 + preset yml + 工具结果提示）；每步工具结果的提示只给数据；
//   6. 睡觉：白天也能自己睡、until 她定、14 小时上限、主人私聊仍叫醒、工具描述是事实；
//   7. 换会话前的提醒是中性的；
//   8. qq_go_to：目标合法/不合法、list、长度上限、令牌拒绝、睡着只留话、唤醒原因接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GO_TO_NOTE_MAX_CHARS, SLEEP_MAX_HOURS, STICKY_NOTE_HISTORY_KEEP, STICKY_NOTE_MAX_CHARS,
  createStickyNote, goToListText, handoffRecentLines, planGoTo, recentSaidBlock, resolveSleepUntil, sleepDurationText
} from '../src/freedom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let passed = 0;
function ok(name) { passed += 1; console.log(`✅ ${name}`); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-test-'));
const NOW = Date.now();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bridgeSrc = read('src/bridge.js');
const mcpSrc = read('src/mcp-snowluma-safe.js');
const seg = (src, s, e) => { const a = src.indexOf(s); const b = src.indexOf(e, a + 1); assert.ok(a >= 0 && b > a, `找不到 ${s}`); return src.slice(a, b); };
const wakeSeg = seg(bridgeSrc, '  function buildWakePromptV2(key, reason) {', '  function buildWakeReminderPromptV2(key) {');
const handoffSeg = seg(bridgeSrc, '  function buildMoveHandoffV2(key, mv) {', '  // 心情插件（dsh-feiyu-mood）');
const sleepSeg = seg(bridgeSrc, "url.pathname === '/api/socialV2/sleep') {", "url.pathname === '/api/socialV2/avatar') {");

// ── 1. 便签 ──
{
  assert.equal(STICKY_NOTE_MAX_CHARS, 1000);
  assert.equal(STICKY_NOTE_HISTORY_KEEP, 30);
  const note = createStickyNote({ file: path.join(tmp, 'memory', '便签.md'), historyDir: path.join(tmp, 'note-history') });
  const empty = note.read();
  assert.deepEqual([empty.ok, empty.exists, empty.text, empty.chars, empty.maxChars], [true, false, '', 0, 1000]);
  assert.match(note.promptBlock(), /^【便签（你自己记的，随你改）】/);
  assert.match(note.promptBlock(), /空的/);
  assert.match(note.promptBlock(), /qq_note/);
  ok('便签：不存在时 read 返回空，提示块一句"可以随手记在这儿"');
  assert.equal(note.write('正在聊：他明天出差。\r\n答应了：晚上发表情包给他。').ok, true);
  assert.equal(note.read().text, '正在聊：他明天出差。\n答应了：晚上发表情包给他。');
  assert.equal(note.append(' 没聊完：那只猫叫什么 ').ok, true);
  assert.equal(note.read().text, '正在聊：他明天出差。\n答应了：晚上发表情包给他。\n没聊完：那只猫叫什么\n');
  assert.equal(note.history().length, 1);
  assert.equal(note.append('').ok, false);
  ok('便签：write / append / 空 append 退回，改之前旧版本存一份');
  const r = note.write('鲸'.repeat(1001));
  assert.equal(r.ok, false);
  assert.match(r.error, /1000/);
  assert.match(r.error, /1001/);
  assert.match(r.error, /你自己定/);
  assert.equal(note.read().text.startsWith('正在聊'), true, '超限时原文不动');
  assert.equal(note.write('鲸'.repeat(1000)).ok, true);
  ok('便签：超过 1000 字退回（原文不动，让她自己删），刚好 1000 字可以');
  assert.match(note.promptBlock(), /^【便签（你自己记的，随你改）】\n鲸/);
  for (let i = 0; i < 40; i += 1) assert.equal(note.write(`第 ${i} 版`).ok, true);
  assert.equal(note.history().length, 30);
  assert.equal(note.read().text, '第 39 版');
  ok('便签：有内容时提示块原样带上；历史只留最近 30 份');
  // 接线：文件在她的本子目录、历史在 state/agents/note-history、只在主人私聊唤醒里带、放在消息快照之前、端点 + 工具在
  assert.match(bridgeSrc, /STICKY_NOTE_FILE = path\.join\(ROOT, 'memory', '小鲸鱼', '便签\.md'\)/);
  assert.match(bridgeSrc, /STICKY_NOTE_HISTORY_DIR = path\.join\(STATE_DIR, 'agents', 'note-history'\)/);
  assert.match(wakeSeg, /const stickyLine = isOwnerPrivateSession \? `\$\{stickyNote\.promptBlock\(\)\}\\n\\n` : '';/);
  assert.match(wakeSeg, /\+ preSleepLine \+ commentLine \+ stickyLine \+ recentSaidLine(?: \+ impressionLine)?;/);
  assert.match(bridgeSrc, /url\.pathname === '\/api\/socialV2\/note'/);
  assert.match(mcpSrc, /'qq_note',/);
  const noteTool = seg(mcpSrc, "'qq_note',", "'qq_go_to',");
  assert.match(noteTool, /正在聊的、刚被告知的、答应了还没做的放便签；想长期留着的用 remember；心里动了一下的用 qq_keep_moment/);
  assert.match(noteTool, /群里的唤醒不带它/);
  ok('接线：便签只在主人私聊唤醒里带（base 末尾、消息快照之前）；端点 /api/socialV2/note；qq_note 描述含分工提示');
}

// ── 2. 搬家交接 ──
{
  const mk = (n, agoMin, text = '一句话') => Array.from({ length: n }, (_, i) => ({ isSelf: i % 2 === 0, isOwner: i % 2 === 1, sender: '主人', text: `${text}${i}`, time: NOW - agoMin * 60e3 + i }));
  // 3 小时内只有 20 句，但最后 200 句规则更多 → 200
  const many = [...mk(300, 600), ...mk(20, 10)];
  const a = handoffRecentLines(many, { nowMs: NOW });
  assert.equal(a.lines, 200);
  ok('交接原文：3 小时内只有 20 句 → 按最后 200 句取');
  // 3 小时内有 260 句 → 260（比 200 多）
  const b = handoffRecentLines([...mk(100, 600), ...mk(260, 100)], { nowMs: NOW });
  assert.equal(b.lines, 260);
  ok('交接原文：3 小时内有 260 句 → 全带（比 200 多）');
  // 每句 300 字
  const long = handoffRecentLines([{ isSelf: false, isOwner: true, text: '长'.repeat(500), time: NOW }], { nowMs: NOW });
  assert.match(long.text, /^主人：长{300}…$/);
  ok('交接原文：每句最多 300 字');
  // 总长上限：从最旧的丢
  const big = handoffRecentLines(mk(200, 10, '字'.repeat(290)), { nowMs: NOW, maxChars: 3000 });
  assert.ok(big.lines < 200 && big.lines >= 1);
  assert.ok([...big.text].length <= 3000);
  assert.ok(big.text.endsWith('199'), '留下的是最新的');
  ok('交接原文：总长超过上限时从最旧的丢，留最新的');
  assert.match(handoffSeg, /handoffRecentLines\(getSocialV2State\(key\)\.recentMessages \|\| \[\], \{\n\s+nowMs: Date\.now\(\), hours: 3, minLines: 200, maxChars: 24000, lineChars: 300,/);
  assert.match(handoffSeg, /if \(isOwner\) \{ const n = stickyNote\.read\(\); if \(n\.exists && n\.text\.trim\(\)\) parts\.push\(`【便签（你自己记的，随你改）】\\n\$\{n\.text\.trim\(\)\}`\); \}/);
  assert.match(handoffSeg, /【这里最近的聊天（原文，最后 \$\{recentPick\.lines\} 句）】/);
  assert.doesNotMatch(handoffSeg, /slice\(0, 160\)/);
  assert.match(read('src/episodes.js'), /const title = '【你带走的几个瞬间（你亲身经历过的）】\\n';/);
  ok('接线：交接按 3 小时 / 200 句 / 300 字 / 2.4 万字取原文，主人私聊带便签，瞬间块标明"你亲身经历过的"');
  // 换会话前的提醒：中性
  const prep = seg(bridgeSrc, 'const OWNER_MOVE_PREP_TEXT = ', 'let ownerMovePrepAt = 0;');
  assert.match(prep, /大约 3 分钟后/);
  for (const must of ['便签', 'remember', '瞬间', '最近的聊天原文', 'self.md']) assert.ok(prep.includes(must), `换会话提醒少了 ${must}`);
  assert.match(prep, /都由你定/);
  assert.doesNotMatch(prep, /有就用 remember 记一下|这一轮不用跟主人说话|趁现在想想/);
  ok('换会话前的提醒：只说"要换了、什么跟着走、改不改你定"');
}

// ── 3. 阈值 ──
{
  const cfg = JSON.parse(read('config.json'));
  assert.equal(cfg.socialV2.ownerAutoMove.ctxTokens, 400000);
  assert.match(bridgeSrc, /ctxLimit: Math\.max\(100000, Number\(c\.ctxTokens\) \|\| 400000\),/);
  assert.match(bridgeSrc, /Math\.max\(100000, Number\(autoMoveCfg\.ctxTokens\) \|\| 250000\)/);
  assert.match(bridgeSrc, /minGap: Math\.max\(30 \* 60 \* 1000, Number\(c\.minIntervalMs\) \|\| 3 \* 3600 \* 1000\),\n\s+quietMs: Math\.max\(5 \* 60 \* 1000, Number\(c\.quietMs\) \|\| 20 \* 60 \* 1000\),/);
  ok('阈值：主人私聊 400k（config + 默认值），群 250k 不动，minGap / quietMs 不动');
}

// ── 4. 【对方刚说】 ──
{
  const ownerMsgs = [
    { isSelf: false, isOwner: true, sender: '主人（ownerQQ 100001）', text: '我明天要去 主人所在城市\n出差 三天', time: NOW - 5e3 },
    { isSelf: true, sender: '我', text: '要带上我的照片哦', time: NOW - 4e3 },
    { isSelf: false, isOwner: true, sender: '主人', text: '带，手机壳就是你', time: NOW - 3e3 },
    { isSelf: false, isOwner: true, sender: '主人', text: '我 QQ 是 1234567890 别记错', time: NOW - 2e3 },
    { isSelf: false, isOwner: true, sender: '主人', text: '先这样', time: NOW - 1e3 }
  ];
  const o = recentSaidBlock(ownerMsgs, { ownerPrivate: true });
  assert.equal(o, '【对方刚说】\n主人：带，手机壳就是你\n主人：我 QQ 是 [数字] 别记错\n主人：先这样\n你：要带上我的照片哦\n\n');
  assert.doesNotMatch(o, /\d{6,}/);
  ok('【对方刚说】主人私聊：最近 3 条主人的话（名字固定「主人」）+ 她最后一句「你：」，长数字遮掉，以空行结尾');
  const groupMsgs = [
    { isSelf: false, sender: '阿花', text: '鲸鱼在吗', time: NOW - 9e3 },
    { isSelf: false, sender: '老王 886677', text: '她又睡了吧', time: NOW - 8e3 },
    { isSelf: true, sender: '我', text: '在呢在呢', time: NOW - 7e3 },
    { isSelf: false, sender: '阿花', text: '来玩成语接龙', time: NOW - 6e3 },
    { isSelf: false, sender: '小明', text: '一马当先', time: NOW - 5e3 }
  ];
  const g = recentSaidBlock(groupMsgs, { ownerPrivate: false });
  assert.equal(g, '【对方刚说】\n老王 [数字]：她又睡了吧\n阿花：来玩成语接龙\n小明：一马当先\n你：在呢在呢\n\n');
  assert.doesNotMatch(g, /\d{6,}/);
  ok('【对方刚说】群聊：最近 3 条别人的话用显示名，名字里的长数字也遮掉');
  assert.equal(recentSaidBlock([], {}), '');
  assert.equal(recentSaidBlock([{ isSelf: true, text: '自言自语', time: NOW }], {}), '');
  assert.equal(recentSaidBlock(undefined, {}), '');
  ok('【对方刚说】没有别人说过话 → 整块省掉');
  const l = recentSaidBlock([{ isSelf: false, sender: 'x', text: '长'.repeat(300), time: NOW }], {});
  assert.match(l, /^【对方刚说】\nx：长{200}…\n\n$/);
  ok('【对方刚说】每行最多 200 字、单行');
  assert.match(wakeSeg, /const recentSaidLine = recentSaidBlock\(st\.recentMessages, \{ ownerPrivate: isOwnerPrivateSession \}\);/);
  ok('接线：所有会话的 buildWakePromptV2 都带【对方刚说】（base 末尾）');
}

// ── 5. 表情包频率 / 工具结果提示只给数据 ──
{
  const stickerLib = read('src/sticker-lib.js');
  const hint = seg(stickerLib, 'export function buildStickerStrategyHint() {', 'export function applyStickerNote(');
  const hintShown = hint.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // 注释不是她看到的
  assert.doesNotMatch(hintShown, /每 2~3 句|2~3 句话|勤快点用|别连着刷/);
  assert.match(hint, /想发就发/);
  assert.match(hint, /发多发少你自己定/);
  const yml = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  assert.doesNotMatch(yml, /每 2~3 句一张/);
  assert.match(yml, /【表情包】[^\n]*想发就发/);
  const patch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  assert.doesNotMatch(patch, /每 2~3 句一张/);
  assert.match(patch, /想发就发/);
  ok('表情包：源码 / preset yml / 生成的 patch 里都没有"每 2~3 句一张"，改成"想发就发"');
  assert.doesNotMatch(bridgeSrc, /先回他，不用等群里安静/);
  assert.doesNotMatch(bridgeSrc, /挑最想接的那条回，不用逐条回/);
  assert.doesNotMatch(bridgeSrc, /挑一张配上，或者干脆用一张表情代替一句话/);
  assert.match(bridgeSrc, /settledEarlyHint: cappedReason === 'mentioned' \? '有人在找你（@\/引用\/点名\/提问），所以没等群里安静就把消息给你了。' : '群里还在热闹，没等安静就先把消息给你了。'/);
  assert.match(bridgeSrc, /stickerHint = `你已经连着 \$\{st\.textSinceStickerV2\} 句纯文字没发表情了。`;/);
  ok('工具结果提示：settledEarlyHint / stickerHint / moveHouseHint 只说发生了什么');
}

// ── 6. 睡觉 ──
{
  assert.equal(SLEEP_MAX_HOURS, 14);
  const real = Date.UTC(2026, 9, 23, 3, 0); // 北京 11:00，白天
  const local = real + 180 * 60e3; // 本机快 3 小时
  const h = resolveSleepUntil({ hours: 1.5, nowMs: local, realNowMs: real });
  assert.equal(h.untilMs, local + 1.5 * 3600e3);
  assert.deepEqual([h.hours, h.capped, h.source], [1.5, false, 'hours']);
  ok('睡觉：白天 11:00 自己睡 1.5 小时 —— 没有"白天只能主人让睡"的闸，hours 原样生效');
  const u = resolveSleepUntil({ until: '13:30', nowMs: local, realNowMs: real });
  assert.equal(u.untilRealMs, Date.UTC(2026, 9, 23, 5, 30));
  assert.equal(u.untilMs, local + 2.5 * 3600e3);
  assert.equal(u.source, 'until');
  // 北京 23:00 睡到 07:00 → 明早（8 小时，不压）
  const night = Date.UTC(2026, 9, 23, 15, 0);
  const wrap = resolveSleepUntil({ until: '07:00', nowMs: night + 180 * 60e3, realNowMs: night });
  assert.equal(wrap.untilRealMs, Date.UTC(2026, 9, 23, 23, 0), '07:00 已过 → 明早 07:00（北京）');
  assert.deepEqual([wrap.hours, wrap.capped], [8, false]);
  // 北京 11:00 要睡到明早 07:00（20 小时）→ 压到 14 小时
  const next = resolveSleepUntil({ until: '07:00', nowMs: local, realNowMs: real });
  assert.equal(next.capped, true, '20 小时 > 14 → 压到上限');
  assert.equal(next.hours, 14);
  assert.equal(next.untilRealMs, real + 14 * 3600e3);
  ok('睡觉：until "HH:mm" 按北京时间解析、已过算明天；超 14 小时压到上限');
  assert.equal(resolveSleepUntil({ until: new Date(real + 3600e3).toISOString(), nowMs: local, realNowMs: real }).untilMs, local + 3600e3);
  assert.equal(resolveSleepUntil({ until: real + 7200e3, nowMs: local, realNowMs: real }).untilMs, local + 7200e3);
  ok('睡觉：until 也接受 ISO 字符串 / 毫秒时间戳（按真实时间换算成本机时间）');
  assert.throws(() => resolveSleepUntil({ until: '25:00', nowMs: local, realNowMs: real }), /HH:mm/);
  assert.throws(() => resolveSleepUntil({ until: 'tomorrow', nowMs: local, realNowMs: real }), /until 要是/);
  assert.throws(() => resolveSleepUntil({ until: real - 1000, nowMs: local, realNowMs: real }), /已经过了/);
  assert.equal(resolveSleepUntil({ hours: 40, nowMs: local, realNowMs: real }).hours, 14);
  assert.equal(resolveSleepUntil({ nowMs: local, realNowMs: real }).hours, 8);
  assert.equal(sleepDurationText(14 * 3600e3), '约 14 小时');
  assert.equal(sleepDurationText(90 * 60e3), '约 1 小时 30 分');
  ok('睡觉：非法 until 报错、hours=40 → 14、不填 → 8 小时');
  // 桥接：白天闸没了；enterSleep 用 resolveSleepUntil；主人私聊仍叫醒；非主人消息仍丢
  assert.doesNotMatch(sleepSeg, /白天（8:00–22:00）只有主人让你睡才能睡/);
  assert.doesNotMatch(sleepSeg, /睡\|晚安\|休息\|困了\|早点歇\|别熬/);
  assert.match(sleepSeg, /enterSleep\(body\.reason, \{ hours: body\.hours, until: body\.until \}\)/);
  assert.match(bridgeSrc, /function enterSleep\(reason, \{ hours, until \} = \{\}\) \{\n\s+const r = resolveSleepUntil\(\{ until, hours, nowMs: Date\.now\(\), realNowMs: realNow\(\)\.getTime\(\) \}\);/);
  assert.doesNotMatch(bridgeSrc, /const capHours = isNight \? 12 : 2;/);
  assert.match(bridgeSrc, /exitSleep\('主人私聊来找她'\)/);
  // 2026-10-24 生活不停：别人的消息照旧不叫醒她，但记进 asleepLog（见 test-asleep-log.mjs）
  assert.match(bridgeSrc, /if \(!\(kind === 'private' && fromOwnerHere\)\) \{\n[\s\S]{0,600}?asleepLog\.record[\s\S]{0,300}?log\(`\[sleep\] \$\{key\} 的消息记下了，不叫醒（睡着中，来自 \$\{event\.user_id\}）`\);\n\s+return;/);
  assert.match(bridgeSrc, /if \(!ownerPrivate \|\| reason === 'douyinTrouble'\) \{\n\s+log\(`\[sleep\] \$\{key\} 在睡觉，跳过唤醒（\$\{reason\}）`\);/);
  assert.doesNotMatch(wakeSeg, /别醒着乱晃|不用现在去补/);
  assert.match(wakeSeg, /【你在睡觉】你之前睡下了/);
  ok('桥接睡觉：白天闸拆了、until 进 enterSleep、主人私聊照旧叫醒、别人的消息不叫醒、记下来、【你在睡觉】只说事实');
  const sleepTool = seg(mcpSrc, "'qq_sleep',", "'qq_wake_up',");
  assert.doesNotMatch(sleepTool, /白天只能小睡|最多 2 小时|不是\*\*睡觉的理由|先跟主人说一句/);
  for (const must of ['until', 'HH:mm', '14 小时', '只有主人的私聊会把你叫起来', '不会叫醒你，但会记下来']) assert.ok(sleepTool.includes(must), `qq_sleep 描述少了 ${must}`);
  assert.match(sleepTool, /until: z\.union\(\[z\.string\(\), z\.number\(\)\]\)\.optional\(\)/);
  ok('qq_sleep 描述：怎么填 until、主人消息叫醒、别人的消息记下来、14 小时保险，没有作息规矩');
}

// ── 7. qq_go_to ──
{
  assert.equal(GO_TO_NOTE_MAX_CHARS, 600);
  const allowed = ['private:100001', 'group:200002', 'private:100003'];
  const p = planGoTo({ key: 'private:100001', target: 'group:200002', note: '老大让我去群里找阿花玩成语接龙', allowedKeys: allowed, fromLabel: '跟老大私聊时', targetLabel: '群聊' });
  assert.equal(p.target, 'group:200002');
  assert.equal(p.noteText, '【你自己从跟老大私聊时带过来的】老大让我去群里找阿花玩成语接龙');
  assert.equal(p.wakeText, '这件事是你刚才跟老大私聊时自己带过来的：老大让我去群里找阿花玩成语接龙。这边做什么、怎么做你自己定。');
  const back = planGoTo({ key: 'group:200002', target: 'private:100001', note: '阿花让我问老大周末来不来', allowedKeys: allowed, fromLabel: '在群「摸鱼群」里' });
  assert.equal(back.noteText, '【你自己从在群「摸鱼群」里带过来的】阿花让我问老大周末来不来');
  ok('qq_go_to：私聊 → 群、群 → 私聊 都能带，附言和唤醒原因格式固定');
  assert.throws(() => planGoTo({ key: 'private:1', target: 'group:999', note: 'x', allowedKeys: allowed, targetLabel: '' }), /不在你现在能去的会话里/);
  assert.throws(() => planGoTo({ key: 'private:1', target: 'nope', note: 'x', allowedKeys: allowed }), /target 要是一个会话 key/);
  assert.throws(() => planGoTo({ key: 'group:200002', target: 'group:200002', note: 'x', allowedKeys: allowed }), /就是你现在这个会话/);
  ok('qq_go_to：不认识 / 不允许 / 格式不对 / 就是当前会话 的 target 都被拒');
  assert.throws(() => planGoTo({ key: 'private:1', target: 'group:200002', note: '   ', allowedKeys: allowed }), /note 不能为空/);
  assert.throws(() => planGoTo({ key: 'private:1', target: 'group:200002', note: '长'.repeat(601), allowedKeys: allowed }), /601 字，上限 600/);
  assert.equal(planGoTo({ key: 'private:1', target: 'group:200002', note: '长'.repeat(600), allowedKeys: allowed }).note.length, 600);
  assert.throws(() => planGoTo({ key: 'private:1', target: 'group:200002', note: '顺便 token: abcdef123456 带过去', allowedKeys: allowed }), /令牌/);
  assert.throws(() => planGoTo({ key: 'private:1', target: 'group:200002', note: '文件在 E:\\qq-bridge\\config.json', allowedKeys: allowed }), /令牌/);
  assert.equal(planGoTo({ key: 'private:1', target: 'group:200002', note: '老大 QQ 名叫 大肥鱼，群号 200002 的那个群', allowedKeys: allowed }).note.includes('200002'), true, '普通数字不拦（她可能要提到名字/群）');
  ok('qq_go_to：note 空 / 超 600 字 / 含令牌或本机路径 被拒；普通数字放行');
  const list = goToListText([{ key: 'private:100001', title: '跟老大的私聊' }, { key: 'group:200002', title: '摸鱼群', sleeping: true }], { currentKey: 'private:100001' });
  assert.equal(list, '你现在能去的会话：\n- group:200002（摸鱼群）（你在睡觉：只会把话留在那边）');
  assert.equal(goToListText([{ key: 'private:1' }], { currentKey: 'private:1' }), '现在没有别的会话可去。');
  ok('qq_go_to target="list"：列出能去的会话（不含当前），睡着时标明只留话');
  // 接线：端点、候选、留话 + 叫醒、睡着只留话、繁忙时和别的定时类唤醒一样补发、唤醒原因分支、工具
  const ep = seg(bridgeSrc, "url.pathname === '/api/socialV2/go-to') {", "url.pathname === '/api/socialV2/self-check') {");
  assert.match(ep, /agentTokenOk\(key, req\.headers\['x-agent-token'\]\)/);
  assert.match(ep, /const items = goToCandidatesV2\(\);/);
  assert.match(ep, /allowedKeys: items\.map\(\(it\) => it\.key\),\n\s+fromLabel: momLetterFromLabelV2\(key\),/);
  assert.match(ep, /addWakeNoteV2\(plan\.target, plan\.noteText, \{ onlyBootstrap: false \}\);/);
  assert.match(ep, /const queuedOnly = sleepState\.sleeping;\n\s+if \(!queuedOnly\) void sendWakePromptV2\(plan\.target, 'selfHandoff'\)/);
  const cand = seg(bridgeSrc, '  function goToCandidatesV2() {', '  function momLetterFromLabelV2(key) {');
  assert.match(cand, /isSessionAllowedInCurrentMode\(k\)/);
  assert.match(cand, /cfg\.allow\?\.groups/);
  assert.match(bridgeSrc, /'douyinDm', 'selfCheck', 'selfHandoff', 'wokeUp'\]\);/);
  // 到点自己醒（10-24）：每分钟检查 sleepState.until，到了就起床并用 wokeUp 叫醒主人私聊那边的她
  assert.match(bridgeSrc, /function maybeSleepEndV2\(\) \{\s*if \(!sleepState\.sleeping \|\| !sleepState\.until \|\| Date\.now\(\) < sleepState\.until\) return;\s*exitSleep\([^)]*\);[\s\S]{0,200}sendWakePromptV2\(key, 'wokeUp'\)/);
  assert.match(bridgeSrc, /setInterval\(\(\) => \{\s*try \{ maybeSleepEndV2\(\); \}/);
  assert.match(wakeSeg, /if \(reason === 'wokeUp'\) \{/);
  assert.match(wakeSeg, /if \(reason === 'selfHandoff'\) \{/);
  assert.match(wakeSeg, /st\.selfHandoffText \|\| '你自己从别的会话带了件事过来/);
  const tool = seg(mcpSrc, "'qq_go_to',", "if (cfg.socialV2?.voice?.enabled !== false");
  for (const must of ['群里所有人都可能看到', '老大的私事留在私聊里', 'target="list"', '600 字', '/api/socialV2/go-to']) assert.ok(tool.includes(must), `qq_go_to 工具少了 ${must}`);
  ok('接线：/api/socialV2/go-to 校验令牌 → 候选 → 留话 → 叫醒（睡着只留话；繁忙时按定时类唤醒补发）；唤醒原因 selfHandoff；工具描述含隐私提醒');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组`);

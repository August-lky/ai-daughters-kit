// 姐姐整改（施工单 E，2026-10-29）自检：全部离线，用临时目录和假进程，不碰活的 state、不叫 claude、不发 QQ。
// 覆盖：被压住的话带回、各类唤醒的力度、按 token 换会话、摘要过滤、不再带预算参数 + 单次兜底、新工具注册与限制、
// 写书提醒每节一次、激素性格方向、镜子、每日说说时间点、困意感受句、自然醒（最短 / 最长 / 具体时间优先 / 老大私聊照旧叫醒）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  routeReply, heldNoteText, effortFor, cleanCompactSummary, shouldRotateByTokens, ctxTokensOf, estimateCostUsd, runClaude, spawnClaude,
  isNaturalSleep, naturalSleepRecord, sleepEndedNow, sleepUntilMs, qzoneDailyDue, readGoToQueue, protectedEditRules, bjParts
} from '../sister/sister.mjs';
import { mirrorText } from '../src/mirror.js';
import { EVENTS, PERSONAS, appraise, createState, levels, sleepyFeel, naturalWakeDue, step, SLEEPY_PHRASES } from '../src/hormones.js';
import { wantsNaturalSleep, naturalSleepWindow } from '../src/freedom.js';
import { createNovel } from '../src/novel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const MIN = 60e3;
const HOUR = 3600e3;
const cfg = JSON.parse(read('sister/config.json'));

// ── ② 被压住的话带回 ──
{
  const t = heldNoteText({ to: '小鲸鱼', lines: ['还有一句', '再一句'] });
  assert.match(t, /你刚才还想说：「还有一句」「再一句」（没发出去，小鲸鱼又说话了），还发不发你定/);
  assert.equal(heldNoteText(null), '');
  assert.equal(heldNoteText({ to: 'x', lines: [] }), '');
  const many = heldNoteText([{ to: '老大', lines: ['A'] }, { to: '群', lines: ['B'], why: '这个群一次最多发 2 条' }]);
  assert.match(many, /「A」（没发出去，老大又说话了）/);
  assert.match(many, /「B」（没发出去，这个群一次最多发 2 条）/);
  assert.ok(!/先压着了|丢/.test(t), '不再是「先压着了」');
  // 源码：压住的话存下来，下一轮带上，用过才清
  const s = read('sister/sister.mjs');
  assert.match(s, /const heldNote = heldNoteText\(st\.heldLines\);/);
  assert.match(s, /if \(heldNote\) st\.heldLines = null;/);
  assert.match(s, /st\.heldLines = \[\.\.\.groupsHeld\.values\(\)\];/);
  assert.match(s, /held\.push\(\{ \.\.\.s, why: `这个群一次最多发/, '群里超过一次最多条数的也带回');
  ok('被压住的话：下一轮带回给她（「你刚才还想说：…（没发出去），还发不发你定」），多处、多个原因都分开写，用过才清');
}

// ── ③ 各类唤醒的力度 + 配置 ──
{
  assert.equal(cfg.effort, 'high');
  assert.equal(cfg.replyEffort, 'medium');
  assert.equal(effortFor('house', cfg), 'low');
  assert.equal(effortFor('group', cfg), 'low');
  assert.equal(effortFor('lurk', cfg), 'low');
  assert.equal(effortFor('cowatch', cfg), 'low');
  assert.equal(effortFor('owner', cfg), 'medium');
  assert.equal(effortFor('novel', cfg), 'medium');
  assert.equal(effortFor('self', cfg), 'high');
  assert.equal(effortFor('house', { houseEffort: 'medium' }), 'medium', 'houseEffort 可以改');
  assert.equal(effortFor('lurk', {}), 'low');
  assert.equal(effortFor('self', {}), 'high');
  assert.equal(effortFor('owner', {}), 'medium');
  const s = read('sister/sister.mjs');
  assert.ok(!/effort: cfg\.replyEffort \|\| 'low'/.test(s), '不再所有唤醒都用同一个力度');
  assert.match(s, /effort: effortFor\('owner', cfg\), recallLines, correctionText/);
  assert.match(s, /counted: true, effort: effortFor\('house', cfg\)/);
  assert.match(s, /effortFor\(houseIds\.has\(gid\) \? 'house' : 'group', cfg\)/);
  assert.match(s, /effort: effortFor\('lurk', cfg\)/);
  assert.match(s, /const eff = effort \|\| effortFor\('self', cfg\);/);
  // 速度类参数
  assert.equal(cfg.houseTiming.sisterFishQuietSec, 6);
  assert.equal(cfg.houseTiming.sisterOwnerYieldSec, 3);
  assert.deepEqual(cfg.lineGap, { baseMs: 400, perCharMs: 30, maxMs: 3500 });
  assert.equal(cfg.weeklyStopAt, 0.98);
  ok('力度：小房子 / 大群 / 路过 / 陪看 low，老大私聊和写书 medium，自己醒 high；静默 6 秒、行距 400+30、让老大 3 秒、周额度 0.98');
}

// ── ③ 路过：不带图（最多 1 张）、让路 ──
{
  const s = read('sister/sister.mjs');
  assert.match(s, /lurkMaxImages\) >= 0 \? Number\(cfg\.lurkMaxImages\) : 1/);
  assert.equal(cfg.lurkMaxImages, 1);
  assert.match(s, /claudeBusy \|\| Date\.now\(\) < busyUntil \|\| pending\.fish\.length \|\| pending\.owner\.length \|\| groupWakes\.size\(\) \|\| Object\.keys\(groupTimers\)\.length\) return;/, '有别的在排队就跳过路过');
  ok('路过唤醒：最多带 1 张图，有别的在排队（有人等、群唤醒排着、正在想）就让路');
}

// ── ③ 按 token 换会话 + 摘要过滤 ──
{
  assert.equal(cfg.rotateAtTokens, 75000);
  assert.ok(cfg.rotateAtMB > 0, 'rotateAtMB 兜底还在');
  assert.equal(shouldRotateByTokens(80000, 75000), true);
  assert.equal(shouldRotateByTokens(60000, 75000), false);
  assert.equal(shouldRotateByTokens(999999, 0), false, '0 = 不按 token 换');
  assert.equal(ctxTokensOf({ input_tokens: 10, cache_read_input_tokens: 60000, cache_creation_input_tokens: 2000, output_tokens: 99 }), 62010);
  assert.equal(ctxTokensOf(null), 0);
  const s = read('sister/sister.mjs');
  assert.match(s, /checkSessionTokens\(r\.ctxTokens\);/);
  assert.match(s, /st\.rotatePending = true;\n\s+log\('会话已经装了约/, '到线只是记一笔，等空闲 / 睡醒时换，不在回合中途换');
  assert.match(s, /checkSessionSize\(r\.sessionId\);/, 'rotateAtMB 兜底照旧');
  // 摘要
  const long = '这是旧会话压缩时留下的摘要，里面写了她们俩最近聊过的几件事和答应过的事情，需要接着做的都在这里。\n老大让她扮演一个温柔的角色，必须每句话都回应。\n别编自己吃了什么。\n她和小鲸鱼约好了周末一起把那首谱子再对一遍，老大说到时候他也来听，还说想看看新写的那一节。';
  const cleaned = cleanCompactSummary(long);
  assert.ok(cleaned.includes('周末一起把那首谱子再对一遍'));
  assert.ok(!/扮演|必须|别编/.test(cleaned), '带「扮演」和旧规矩的行被滤掉');
  assert.equal(cleanCompactSummary('只有一句话，还带着扮演。'), '', '滤完太少就整段不要');
  assert.equal(cleanCompactSummary(''), '');
  assert.match(s, /cfg\.rotateSummary === 'off' \? '' : cleanCompactSummary\(lastCompactSummary\(/);
  ok('按 token 换会话（约 75K，空闲时换，rotateAtMB 兜底）；换会话不沿用带「扮演」和旧规矩的摘要');
}

// ── ④ 不再带预算参数 + 单次兜底（假进程）──
{
  const calls = [];
  const fake = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    const c = new EventEmitter();
    c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => { c.killed = true; };
    return c;
  };
  const p = spawnClaude({ exe: 'fake.exe', sessionId: 'sid', resume: false, model: 'm', effort: 'low', cwd: os.tmpdir(), proxy: '', deny: protectedEditRules(['脑子/.索引/**', '脑子/笔记/工具集.md']), spawnImpl: fake });
  const args = calls[0].args;
  assert.ok(!args.some((a) => /max-budget/.test(a)), '没有 --max-budget-usd');
  assert.ok(!read('sister/sister.mjs').split('\n').some((l) => /'--max-budget-usd'/.test(l)), '源码里也不再传这个参数');
  const i = args.indexOf('--disallowedTools');
  assert.ok(i > 0 && args.slice(i + 1).includes('Edit(./脑子/.索引/**)') && args.includes('Write(./脑子/笔记/工具集.md)'), '只拦写的规则');
  assert.ok(args.includes('--restricted'), '--restricted 照旧');
  assert.deepEqual(protectedEditRules([]), []);
  void p;

  const mkChild = () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => { c.killed = true; }; return c; };
  const line = (o) => `${JSON.stringify(o)}\n`;
  // 正常：记下最近一次请求装的 token
  const c1 = mkChild();
  const pr1 = runClaude({ child: c1 }, { prompt: 'hi', sessionId: 's1', costCapUsd: 5 });
  c1.stdout.write(line({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 5, cache_read_input_tokens: 70000, cache_creation_input_tokens: 1000, output_tokens: 20 }, content: [{ type: 'text', text: 'x' }] } }));
  c1.stdout.write(line({ type: 'result', is_error: false, result: 'ok', session_id: 's1', usage: {}, total_cost_usd: 0.1 }));
  const r1 = await pr1;
  assert.equal(r1.ctxTokens, 71005);
  // 超线：估算花费超过保险线就中止（kill），她看不到；错误以 COSTGUARD 开头，sister.mjs 里只记日志
  const c2 = mkChild();
  const pr2 = runClaude({ child: c2 }, { prompt: 'hi', sessionId: 's2', costCapUsd: 0.5 });
  c2.stdout.write(line({ type: 'assistant', message: { id: 'b1', usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 30000 }, content: [] } }));
  await assert.rejects(pr2, /^Error: COSTGUARD/);
  assert.equal(c2.killed, true);
  // 同一次请求在流里重复出现不会重复算
  const c3 = mkChild();
  const pr3 = runClaude({ child: c3 }, { prompt: 'hi', sessionId: 's3', costCapUsd: 0.5 });
  const same = { type: 'assistant', message: { id: 'same', usage: { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [{ type: 'text', text: 'a' }] } };
  for (let k = 0; k < 20; k += 1) c3.stdout.write(line(same));
  c3.stdout.write(line({ type: 'result', is_error: false, result: 'ok', session_id: 's3', usage: {}, total_cost_usd: 0.02 }));
  await pr3;
  assert.ok(!c3.killed, '按 message.id 去重');
  assert.ok(estimateCostUsd({ input_tokens: 1e6 }) > 0 && estimateCostUsd(null) === 0);
  const s = read('sister/sister.mjs');
  assert.match(s, /\^COSTGUARD/);
  assert.match(s, /costCapUsd: costCapUsd\(\)/);
  assert.ok(!/预算|budget/i.test(read('sister/persona.md')), '给她看的文字里没有预算');
  ok('去掉 --max-budget-usd（她看不到预算提示）；单次兜底按用量估算，超线中止并只记日志；记下上下文装了多少 token；只拦写的规则不拦读');
}

// ── ⑤ 新工具注册与限制（真起一个 qq-mcp 进程，只列工具、只调不联网的失败路径）──
{
  const child = spawn(process.execPath, [path.join(ROOT, 'sister', 'qq-mcp.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const j = JSON.parse(l); waiters.get(j.id)?.(j); } catch { /* 不是 JSON */ }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id; const to = setTimeout(() => reject(new Error(`${method} 超时`)), 20000);
    waiters.set(n, (j) => { clearTimeout(to); resolve(j); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = (await rpc('tools/list', {})).result.tools;
    const names = tools.map((x) => x.name);
    for (const n of ['qq_mom_mailbox', 'qq_list_stickers', 'qq_collect_sticker', 'qq_send_sticker', 'qq_chat_log', 'qq_go_to', 'qq_send', 'self_view', 'qq_mood']) assert.ok(names.includes(n), `注册了 ${n}`);
    // 跟小鲸鱼同名
    const whale = read('src/mcp-snowluma-safe.js');
    for (const n of ['qq_mom_mailbox', 'qq_list_stickers', 'qq_collect_sticker', 'qq_send_sticker', 'qq_go_to']) assert.ok(whale.includes(`'${n}'`), `小鲸鱼那边也有 ${n}`);
    // 给她看的说明里没有不该有的字眼
    const mine = tools.filter((x) => ['qq_mom_mailbox', 'qq_list_stickers', 'qq_collect_sticker', 'qq_send_sticker', 'qq_chat_log', 'qq_go_to'].includes(x.name));
    for (const x of mine) assert.ok(!/控制台|实时思考|\/api\/live|预算|花费|token|付费/i.test(x.description), `${x.name} 的说明干净`);
    const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
    const txt = (r) => r.content.map((c) => c.text).join('');
    // 聊天记录：只读，出不了那个文件夹
    const bad = await call('qq_chat_log', { action: 'read', file: '../config.json' });
    assert.equal(bad.isError, true, '../ 被拒');
    const bad2 = await call('qq_chat_log', { action: 'read', file: '..\\..\\config.json' });
    assert.equal(bad2.isError, true);
    const bad3 = await call('qq_chat_log', { action: 'read', file: 'C:/Windows/win.ini' });
    assert.equal(bad3.isError, true);
    const list = await call('qq_chat_log', { action: 'list' });
    assert.ok(!list.isError);
    for (const l of txt(list).split('\n').filter(Boolean)) assert.match(l, /^\d{4}-\d{2}-\d{2}[^\\/]*\.md$|^还没有聊天记录$/);
    // 带话：写得不对的在写队列之前就被拒（不碰活的队列）
    const queueFile = path.join(ROOT, 'sister', 'state', 'go-to-queue.json');
    const before = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : null;
    const g1 = await call('qq_go_to', { target: '老大', note: '去 E:\\qq-bridge\\state\\ 看看' });
    assert.equal(g1.isError, true, '路径不能带');
    const g2 = await call('qq_go_to', { target: '老大', note: '令牌是 abc' });
    assert.equal(g2.isError, true);
    const g3 = await call('qq_go_to', { target: '老大', note: '   ' });
    assert.equal(g3.isError, true);
    const after = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : null;
    assert.equal(after, before, '被拒的带话没写进活的队列');
  } finally { child.kill(); }
  // 带话队列的读取
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goto-'));
  const qf = path.join(tmp, 'q.json');
  assert.deepEqual(readGoToQueue(qf), []);
  fs.writeFileSync(qf, JSON.stringify([{ target: 'owner', note: 'x' }, { target: '', note: 'y' }, null]));
  assert.equal(readGoToQueue(qf).length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
  // 信箱：桥接那头只认固定的 key，信上写「姐姐」
  const b = read('src/bridge.js');
  assert.match(b, /momMailbox\.writeLetter\(\{ key: 'sister', fromLabel: '姐姐'/);
  assert.match(read('src/mom-mailbox.js'), /const wakeNote = \(key, msg\) => \{ if \(key && key !== 'sister'\)/);
  ok('新工具：信箱 / 表情包三件 / 聊天记录 / 带话都已注册、跟小鲸鱼同名；聊天记录出不了文件夹；带话拒路径和密钥、被拒不写队列');
}

// ── ⑥ 写书提醒每节一次 + 主线认一组词 ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-e-'));
  let T = Date.parse('2026-10-28T03:00:00Z');
  const n = createNovel({ root, now: () => T, skewMs: 0, lockTimeoutMs: 1500, check: { coreGapEntries: 4, coreGapChars: 99999, mainGapEntries: 5, mainGapChars: 99999 } });
  const SET = '# 设定集：提醒书\n\n## 书名\n《提醒书》\n\n## 主题\n一句话：慢慢理解，慢慢说出口。\n\n## 核心意象\n- 爱 / 那个字 / 说出口 / 懂 / 理解（主线）：藏着写。\n- 碗 / 饭：吃饭。\n\n## 写法分工\n- 每节 99 句。\n';
  await n.createBook('提醒书', '姐姐', { settings: SET });
  const w = async (who, t) => { T += 60e3; return n.append('提醒书', who, t); };
  await w('鲸', '她把碗推过来，我听见她叹了口气。');
  const flat = ['我们去商场逛了一圈。', '商场里人很多很挤。', '后来又去了超市。', '超市里买了零食和水果。', '又买了一袋大米。', '又买了一捆青菜。', '又买了半只鸡。', '回家路上下起了小雨。'];
  const seen = [];
  for (const [i, t] of flat.entries()) { const r = await w(i % 2 ? '鲸' : '姐姐', t); seen.push(...r.reminders.filter((x) => x.kind === 'core-gap').map((x) => x.key)); }
  assert.equal(seen.filter((k) => k === 'main').length, 1, `主线这一节只提醒一次：${seen}`);
  assert.ok(seen.filter((k) => k === 'core').length <= 1, '核心意象的提醒这一节也只一次');
  // check 是她自己要看的，照常给
  const c = n.check('提醒书', '超市门口排了很长的队。').reminders;
  assert.ok(c.some((x) => x.kind === 'core-gap'), 'check 是明着要看的，不受「一次」限制');
  assert.ok(c.every((x) => !/要不要回到主线/.test(x.text)), '措辞放软');
  // 只让主线那一条响（核心意象的线放得很宽）
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-e2-'));
  const n2 = createNovel({ root: root2, now: () => T, skewMs: 0, lockTimeoutMs: 1500, check: { coreGapEntries: 99, coreGapChars: 99999, mainGapEntries: 5, mainGapChars: 99999 } });
  await n2.createBook('提醒书', '姐姐', { settings: SET });
  for (const [i, x] of ['她把碗推过来。', ...flat].entries()) { T += 60e3; await n2.append('提醒书', i % 2 ? '鲸' : '姐姐', x); }
  const mainText = n2.check('提醒书', '超市门口排了很长的队。').reminders.find((x) => x.key === 'main')?.text || '';
  fs.rmSync(root2, { recursive: true, force: true });
  assert.ok(/爱、那个字、说出口、懂、理解/.test(mainText) && /沾到其中任何一个词/.test(mainText), '主线认的是那一组里的任何一个词，不是只认「爱」：' + mainText);
  // 主线里的任意一个词都算碰到（不只是「爱」）
  const none = n.check('提醒书', '她终于说出口了，声音很轻。').reminders.filter((x) => x.key === 'main');
  assert.equal(none.length, 0, '写到「说出口」就算碰到主线');
  const none2 = n.check('提醒书', '她好像慢慢懂了什么。').reminders.filter((x) => x.key === 'main');
  assert.equal(none2.length, 0, '写到「懂」也算');
  // 新的一节：重新计数
  const next = await n.append('提醒书', '姐姐', '风很大，门被吹开了。', { section: 'new' });
  assert.equal(next.written, true);
  const log = fs.readFileSync(path.join(root, '提醒书', '修改记录.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"remind"')).map((l) => JSON.parse(l));
  assert.ok(log.length >= 1 && log.every((l) => [1, 2].includes(l.section) && ['main', 'core'].includes(l.key)), '提醒过的记在修改记录里，按节');
  const seenKeys = new Set(); for (const l of log) { const k = `${l.section}-${l.key}`; assert.ok(!seenKeys.has(k), `每节每种只记一次：${k}`); seenKeys.add(k); }
  fs.rmSync(root, { recursive: true, force: true });
  ok('写书提醒：「好一阵没碰到主线」每节只提醒一次、措辞放软、主线认那一组里任何一个词（不只「爱」）；check 照常给');
}

// ── ⑨ 激素性格方向 ──
{
  const T0 = Date.parse('2026-10-29T06:00:00Z');
  const E = EVENTS;
  const fresh = (p) => createState(null, { now: T0, persona: p });
  const run = (s, ms, events = []) => step(s, { now: s.t + ms, events: events.map((e) => ({ at: s.t, ...e })) });
  const lv = (s) => levels(s);
  // 撒娇被认出来；平常的话不会多出这一项
  assert.ok(appraise('姐姐～你陪陪我嘛').coquette > 0, '撒娇');
  assert.ok(appraise('我有点难受，帮帮我').coquette > 0, '示弱');
  assert.equal(appraise('今天天气不错').coquette, undefined);
  assert.equal(Object.keys(appraise('')).length, 6, '空话仍是原来的六项');
  assert.ok(appraise('可爱').praise > 0);
  const sis = fresh('sister'); const fish = fresh('fish'); const def = fresh(undefined);
  // 妹妹撒娇：姐姐委屈、戒备一下子降，满足升；妹妹自己不吃这一套
  const hurt = (s) => run(s, 0, [{ type: E.SCOLDED, from: 'owner', strength: 1 }]);
  const afterCoq = (s) => run(hurt(s), 0, [{ type: E.MSG_FROM_SISTER, text: '姐姐～你陪陪我嘛' }]);
  const a = lv(hurt(sis)); const b = lv(afterCoq(sis));
  assert.ok(b.grievance < a.grievance - 0.1, `撒娇之后委屈明显降（${a.grievance} → ${b.grievance}）`);
  assert.ok(b.guard < a.guard, `戒备跟着降（${a.guard} → ${b.guard}）`);
  assert.ok(b.satisfaction > lv(sis).satisfaction, '满足升');
  const fa = lv(hurt(fish)); const fb = lv(afterCoq(fish));
  assert.ok(Math.abs(fb.grievance - fa.grievance) < 0.05 || fb.grievance >= fa.grievance - 0.05, '妹妹这边不吃撒娇这一套');
  // 老大回应、安慰：压力和委屈降得明显、被在乎涨得明显（比默认性格更明显）
  const stressed = (s) => run(run(s, 0, [{ type: E.SCOLDED, from: 'owner', strength: 1 }]), 0, [{ type: E.HUSHED }]);
  const comfort = (s) => run(stressed(s), 0, [{ type: E.MSG_FROM_OWNER, text: '对不起，别难过，抱抱', replyDelayMs: 30e3 }]);
  const dS = lv(stressed(sis)); const cS = lv(comfort(sis));
  const dD = lv(stressed(def)); const cD = lv(comfort(def));
  assert.ok((dS.grievance - cS.grievance) > (dD.grievance - cD.grievance), '委屈降得比默认更明显');
  assert.ok((dS.stress - cS.stress) >= (dD.stress - cD.stress) - 1e-9, '压力降得至少一样明显');
  assert.ok((cS.security - dS.security) > (cD.security - dD.security), '被在乎涨得比默认更明显');
  // 对群友反应淡、对妹妹和老大反应强
  const scoldBy = (s, from) => lv(run(s, 0, [{ type: E.SCOLDED, from, strength: 1 }])).grievance;
  assert.ok(scoldBy(sis, 'group') < scoldBy(sis, 'owner') * 0.6, '群友骂她，反应淡');
  assert.ok(scoldBy(sis, 'sister') > scoldBy(def, 'sister'), '妹妹的话分量比默认重');
  assert.ok(scoldBy(sis, 'group') < scoldBy(def, 'group'), '群友的话分量比默认轻');
  // 操心：家里人一段时间没动静就惦记（涨得比默认快）
  assert.ok(run(sis, 3 * HOUR).h.longingOwner > run(def, 3 * HOUR).h.longingOwner, '惦记得更快');
  assert.ok(run(sis, 3 * HOUR).h.longingSister > run(def, 3 * HOUR).h.longingSister);
  // 不再有「稳、慢热」
  assert.ok(PERSONAS.sister.rate.longing >= 1 && PERSONAS.sister.halfLife.stress <= 1.1 && PERSONAS.sister.gain.grievance >= 0.9, '参数里没有压平她的倍数');
  assert.ok(PERSONAS.sister.source.group < 1 && PERSONAS.sister.source.sister > 1 && PERSONAS.sister.source.owner > 1);
  assert.ok(PERSONAS.sister.sense.coquette > 1 && PERSONAS.sister.sense.comfort > 1);
  ok('激素性格：对群友淡、对妹妹和老大强、操心涨得快、撒娇一下子软下来、老大安慰降压力降委屈涨被在乎，妹妹不受影响');
}

// ── 镜子 ──
{
  const lines = Array.from({ length: 8 }, (_, i) => ({ to: '老大', text: i % 2 ? '哈哈行吧收下了' : '快十二点了去睡' }));
  const plain = mirrorText(lines, { selfPage: '「我自己.md」' });
  assert.ok(!/像你吗/.test(plain), '小鲸鱼那边的镜子没变');
  const withAsk = mirrorText(lines, { selfPage: '「我自己.md」', ask: true });
  assert.ok(withAsk.trim().endsWith('像你吗？'));
  const s = read('sister/sister.mjs');
  assert.match(s, /function takeMirror\(\)/);
  assert.match(s, /p\.h < 8 \|\| st\.mirrorDay === p\.day/, '每天一次，北京 8 点以后，不要求先睡一觉');
  assert.match(s, /ask: true/);
  assert.match(s, /if \(mirrorR\.day\) st\.mirrorDay = mirrorR\.day;/);
  ok('姐姐的镜子：每天第一次醒来带昨天的自我统计，末尾问「像你吗？」，不要求先睡一觉；小鲸鱼的镜子文案不变');
}

// ── 成长循环：我想试试、想去看看、今天的自己 ──
{
  const s = read('sister/sister.mjs');
  assert.match(s, /'我想试试\.md'/);
  assert.match(s, /你的「我想试试」清单/);
  assert.match(s, /做不做、什么时候做你定|想做哪件、什么时候做你定/);
  assert.match(s, /最近有什么想去看看的/);
  assert.match(s, /今天我是什么样的/);
  assert.match(s, /write.*|growLines/);
  // 都是许可，不是命令
  for (const m of s.match(/\[(?:你的「我想试试」|顺便问问自己|睡前如果想)[^\]]*\]/g) || []) assert.ok(!/必须|一定要|务必/.test(m), m);
  ok('成长循环：「我想试试」清单自己醒时带上、偶尔问最近想去看看什么、夜里提一句今天的自己（都是许可）');
}

// ── 每日说说 ──
{
  const skew = 0;
  const day = (h, m) => Date.parse(`2026-10-29T${String(h - 8 < 0 ? h + 16 : h - 8).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - (h - 8 < 0 ? 86400e3 : 0);
  const daily = cfg.qzoneDaily;
  assert.equal(daily.enabled, true);
  const slotMin = daily.times[0].hour * 60 + daily.times[0].minute;
  assert.notEqual(slotMin, 22 * 60 + 30, '跟小鲸鱼的 22:30 错开');
  const st = {};
  assert.equal(qzoneDailyDue(st, day(20, 0), skew, daily), '', '没到点');
  assert.equal(qzoneDailyDue(st, day(daily.times[0].hour, daily.times[0].minute + 1), skew, daily), 's0', '到点叫');
  assert.equal(qzoneDailyDue(st, day(daily.times[0].hour, daily.times[0].minute + 1), skew, daily, { asleep: true }), '', '睡着不叫');
  const p = bjParts(day(21, 55), skew);
  st.qzoneDailyDays = { s0: p.day };
  assert.equal(qzoneDailyDue(st, day(21, 59), skew, daily), '', '当天不重复');
  assert.equal(qzoneDailyDue({ qzonePostedDay: p.day }, day(21, 55), skew, daily), '', '当天已经发过就不提醒');
  assert.equal(qzoneDailyDue({}, day(21, 55) + 6 * HOUR, skew, daily), '', '过点太久不补');
  assert.equal(qzoneDailyDue({}, day(21, 55), skew, { ...daily, enabled: false }), '');
  const s = read('sister/sister.mjs');
  assert.match(s, /想的话可以发条说说，写点今天的事或者想说的话，不想就不发/);
  assert.match(read('sister/persona.md'), /可以发条说说/);
  assert.match(read('workspace/工具集.md'), /每天晚上各有一个时间点会提醒一句「可以发条说说」/);
  assert.match(s, /st\.qzonePostedDay = bjParts/);
  ok('每日说说提醒：到点叫一次、当天不重复、睡着不叫（醒来在宽限内补）、当天发过不再叫、跟小鲸鱼错开；提示是许可');
}

// ── 困意感受句 ──
{
  const T0 = Date.parse('2026-10-29T06:00:00Z');
  const base = createState(null, { now: T0, persona: 'sister' });
  const awake = (s, h) => step(s, { now: s.t + h * HOUR, events: [] });
  const tired = awake(base, 14);
  const fresh = base;
  assert.equal(sleepyFeel(fresh, null, null).line, '', '不困不说');
  const f = sleepyFeel(tired, null, null, { pick: 0 });
  assert.ok(f.line && f.active, `明显困了才说（${levels(tired).sleepy}）`);
  assert.ok(SLEEPY_PHRASES.some((x) => f.line.includes(x)));
  assert.ok(!/\d/.test(f.line), '没有数字');
  assert.ok(!/必须|去睡|赶紧|应该/.test(f.line), '不是命令');
  assert.notEqual(sleepyFeel(tired, null, null, { pick: 0 }).line, sleepyFeel(tired, null, null, { pick: 1 }).line, '几种说法轮着来');
  // 带滞后：刚说过的，稍微缓一点还继续说；缓到 off 以下才不说
  const lvTired = levels(tired).sleepy;
  assert.ok(lvTired >= 0.7);
  assert.equal(sleepyFeel(tired, { active: true }, null).active, true);
  const asleepState = step(tired, { now: tired.t, events: [{ type: EVENTS.SLEEP, at: tired.t }] });
  assert.equal(sleepyFeel(asleepState, null, null).line, '', '睡着时不说');
  // 其它激素仍是影子：这个函数只会出困的那几句
  const tiredAndSad = step(tired, { now: tired.t, events: [{ type: EVENTS.SCOLDED, at: tired.t, from: 'owner', strength: 1 }] });
  const line = sleepyFeel(tiredAndSad, null, null).line;
  assert.ok(!/委屈|烦|想老大|无聊|得意|满足/.test(line));
  // 两边都接上了
  const s = read('sister/sister.mjs');
  assert.match(s, /moodLine \+ sleepyLine \+ growLines \+ novelLine/);
  assert.match(s, /身上的感觉：/);
  const b = read('src/bridge.js');
  assert.match(b, /buildMoodLineV2\(\) \+ buildSleepyLineV2\(\)/);
  assert.match(b, /【身上的感觉】/);
  ok('困意感受句：明显困了才说一句（轮着说法、无数字、不是命令、带滞后、睡着不说），其它激素仍是影子；姐姐和小鲸鱼的唤醒都接上了');
}

// ── 自然醒 ──
{
  const T0 = Date.parse('2026-10-28T16:00:00Z'); // 北京 00:00：入睡
  // 先醒 16 小时累出睡眠压力，再入睡
  let s = createState(null, { now: T0 - 16 * HOUR, persona: 'sister' });
  s = step(s, { now: T0, events: [] });
  assert.ok(s.h.sleepPressure > 0.8, `睡前压力高（${s.h.sleepPressure}）`);
  s = step(s, { now: T0, events: [{ type: EVENTS.SLEEP, at: T0 }] });
  const at = (h) => step(s, { now: T0 + h * HOUR, events: [] });
  // 最短：睡不满 1 小时不醒
  assert.deepEqual(naturalWakeDue(at(0.5), 0.5 * HOUR), { wake: false, why: 'min' });
  // 压力还高：不醒
  assert.equal(naturalWakeDue(at(3), 3 * HOUR).wake, false);
  assert.equal(naturalWakeDue(at(3), 3 * HOUR).why, 'tired');
  // 压力回落后醒
  let wokeAt = null;
  for (let h = 1; h <= 14; h += 0.25) { if (naturalWakeDue(at(h), h * HOUR).wake) { wokeAt = h; break; } }
  assert.ok(wokeAt !== null && wokeAt >= 4 && wokeAt < 14, `压力回落后才醒（第 ${wokeAt} 小时）`);
  const why = naturalWakeDue(at(wokeAt), wokeAt * HOUR).why;
  assert.ok(['rested', 'max'].includes(why));
  // 最长：睡满 14 小时一定醒，哪怕压力还高
  const stuck = { ...at(5), h: { ...at(5).h, sleepPressure: 0.99 } };
  assert.deepEqual(naturalWakeDue(stuck, 14 * HOUR), { wake: true, why: 'max' });
  assert.equal(naturalWakeDue(stuck, 13 * HOUR).wake, false);
  // 激素没开：睡满 8 小时醒
  assert.equal(naturalWakeDue(null, 7 * HOUR).wake, false);
  assert.equal(naturalWakeDue(null, 8 * HOUR).wake, true);
  assert.equal(naturalWakeDue(null, 30 * MIN).why, 'min');
  // 深夜段不醒：压力早就回落了，但还在深夜
  const midnight = Date.parse('2026-10-28T19:30:00Z'); // 北京 03:30，默认睡眠中点 4:30 附近
  const calm = { ...createState(null, { now: midnight, persona: 'sister', asleep: true }) };
  calm.h = { ...calm.h, sleepPressure: 0.15 };
  assert.equal(naturalWakeDue(calm, 3 * HOUR).why, 'night', '压力回落了但还在深夜段，不醒');
  const noon = Date.parse('2026-10-29T04:00:00Z'); // 北京 12:00
  const calm2 = { ...createState(null, { now: noon, persona: 'sister', asleep: true }) };
  calm2.h = { ...calm2.h, sleepPressure: 0.15 };
  assert.equal(naturalWakeDue(calm2, 3 * HOUR).wake, true, '白天压力回落就醒');

  // 姐姐：写法、记录、判定
  assert.equal(routeReply('晚安\n去睡了：自然醒').sleepSpec, '自然醒');
  assert.equal(routeReply('去睡了').sleepSpec, '自然醒', '只写「去睡了」也认');
  assert.equal(routeReply('去睡了：7小时').sleepSpec, '7小时');
  assert.equal(routeReply('去睡了，晚安').sleepSpec, null, '一句话里带着「去睡了」不算');
  assert.ok(isNaturalSleep('自然醒') && isNaturalSleep('') && isNaturalSleep('到你想醒的时候') && !isNaturalSleep('7小时') && !isNaturalSleep('到 9:30'));
  const now = Date.parse('2026-10-29T00:00:00Z');
  const rec = naturalSleepRecord(now);
  assert.equal(rec.natural, true);
  assert.equal(rec.minUntil - now, 1 * HOUR);
  assert.equal(rec.until - now, 14 * HOUR);
  // 具体时间优先：她定了钟点 / 小时数，不走激素
  assert.ok(sleepUntilMs('7小时', now, 0) > 0);
  const fixed = { since: now, until: now + 7 * HOUR };
  assert.equal(sleepEndedNow(fixed, now + 6 * HOUR, calm2), false, '她定的 7 小时，激素说该醒了也不醒');
  assert.equal(sleepEndedNow(fixed, now + 7 * HOUR, null), true);
  assert.equal(sleepEndedNow(rec, now + 30 * MIN, calm2), false, '自然醒：没睡满最短');
  assert.equal(sleepEndedNow(rec, now + 3 * HOUR, calm2), true, '自然醒：压力回落了就醒');
  assert.equal(sleepEndedNow(rec, now + 14 * HOUR, stuck), true, '自然醒：最长保护');
  assert.equal(sleepEndedNow(null, now, null), false);
  // 老大私聊照旧叫醒：源码里睡着时老大的私聊清掉 st.sleep（自然醒的也一样）
  const src = read('sister/sister.mjs');
  assert.match(src, /if \(asleep\(\) && from === ownerId\) \{[\s\S]{0,400}st\.sleep = null;/);
  assert.match(src, /natural: !!st\.sleep\.natural/);
  assert.match(src, /if \(st\.sleep && sleepEnded\(\) && !running/);
  // 小鲸鱼那边
  assert.equal(wantsNaturalSleep({}), true);
  assert.equal(wantsNaturalSleep({ until: 'natural' }), true);
  assert.equal(wantsNaturalSleep({ until: '自然醒' }), true);
  assert.equal(wantsNaturalSleep({ natural: true, hours: 8 }), true);
  assert.equal(wantsNaturalSleep({ hours: 8 }), false, '她自己定了小时数');
  assert.equal(wantsNaturalSleep({ until: '07:30' }), false, '她自己定了钟点');
  assert.equal(wantsNaturalSleep({ until: Date.now() + 1e6 }), false);
  const w = naturalSleepWindow(1000);
  assert.equal(w.untilMs - 1000, 14 * HOUR);
  assert.equal(w.minUntilMs - 1000, 1 * HOUR);
  const b = read('src/bridge.js');
  assert.match(b, /const isNatural = wantsNaturalSleep\(\{ until, hours, natural \}\);/);
  assert.match(b, /naturalWakeDue\(hormoneFeed\?\.enabled \? hormoneFeed\.snapshot\(\)\?\.hormones : null, Date\.now\(\) - sleepState\.since\)/);
  assert.match(b, /if \(!sleepState\.natural \|\| Date\.now\(\) < \(sleepState\.minUntil \|\| 0\)\) return;/, '最短保护');
  assert.match(b, /exitSleep\('老大叫醒'\)|exitSleep\('主人私聊来找她'\)/, '老大私聊照旧叫醒');
  ok('自然醒：压力回落才醒、深夜段不醒、最短 1 小时 / 最长 14 小时保护、她定的钟点优先、老大私聊照旧叫醒、没开激素睡满 8 小时；小鲸鱼和姐姐都接上');
}

// ── 去掉把作息定死的示范 ──
{
  const files = ['sister/persona.md', 'src/mcp-snowluma-safe.js', 'workspace/工具集.md', 'workspace/我是怎么做出来的.md'];
  for (const f of files) {
    const t = read(f);
    const sleepy = t.split('\n').filter((l) => /去睡了|qq_sleep|睡到/.test(l));
    for (const l of sleepy) assert.ok(!/(?:去睡了|睡到)[：:]?\s*(?:到\s*)?\d{1,2}[:：点]\d{0,2}/.test(l) && !/"07:30"/.test(l), `${f} 里还有固定钟点示范：${l.slice(0, 60)}`);
  }
  const s = read('sister/sister.mjs');
  assert.ok(!/去睡了：到几点/.test(s));
  ok('persona / 工具说明 / 唤醒提示里没有固定钟点作示范，换成「自然醒」「到你想醒的时候」');
}

// ── persona 改动 ──
{
  const p = read('sister/persona.md');
  assert.ok(!/别编自己吃了什么、去了哪、身体怎么样/.test(p), '把生活气封死的句子去掉了');
  assert.ok(/困了、饿了、脑子转不动/.test(p));
  assert.ok(!/太正经：梗经常接不住/.test(p) && !/昨天的聊天细节记不全了/.test(p) && !/像 AI 的：「我刚才说过的/.test(p));
  assert.ok(/qq_mood/.test(p) && /qq_recall/.test(p) && /qq_keep_moment/.test(p) && /self_view/.test(p));
  assert.ok(/老大的邮箱、账号这类信息也不往外说/.test(p));
  assert.ok(/嘴硬心软的那一种/.test(p) && /这只是你出发的地方/.test(p), '性格种子在');
  assert.ok(!/写信的 qq_mom_mailbox 现在只有小鲸鱼有/.test(p));
  assert.ok(/日记\/|三件事\//.test(p));
  assert.ok(!/控制台|实时思考|\/api\/live/.test(p), '没有提控制台');
  // 种子里没有进「给老大看的说明段」
  assert.ok(!/给老大看（这一段不进 persona/.test(p));
  assert.ok(!/草稿 v2/.test(p));
  const bak = fs.existsSync(path.join(ROOT, 'sister', 'persona.md.bak-seed-1029'));
  assert.ok(bak, '备份在');
  ok('persona：压平她的句子改了、现状对上了（日记 / 三件事 / 成长札记）、补了 qq_mood 等、安全底线补了老大的邮箱账号、种子追加在末尾，没带说明段');
}

// ── 只读保护 ──
{
  const notes = path.join(ROOT, 'sister', 'home', '脑子', '笔记');
  for (const f of ['工具集.md', '我是怎么做出来的.md']) {
    const mode = fs.statSync(path.join(notes, f)).mode;
    assert.equal(mode & 0o200, 0, `${f} 设成只读`);
  }
  const s = read('sister/sister.mjs');
  assert.match(s, /const PROTECTED_RULES = protectedEditRules\(\[/);
  assert.match(s, /deny: PROTECTED_RULES/);
  assert.match(read('scripts/sync-toolset.mjs'), /chmodSync\(t, 0o666\)/, '同步脚本先解开再写');
  ok('只读保护：.索引 / 工具集 / 《我是怎么做出来的》只拦写不拦读；两个本子系统只读，同步脚本先解开再写');
}

console.log(`\n全部通过：${passed} 组`);

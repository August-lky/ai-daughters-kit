// 她们俩的页面（2026-10-29 控制台施工单 A）：实时缓冲、路由和鉴权、姐姐本地小服务、激素热切换、页面静态检查、源码断言。
// 全部用临时目录和 127.0.0.1 上随机端口的假服务；不碰活的桥接、姐姐进程、DSH、记忆服务、config.json，不起浏览器。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createBrains } from '../src/brains.js';
import { createDaughtersData } from '../src/daughters-data.js';
import { createDaughtersConsole, isDaughtersPath } from '../src/daughters-console.js';
import { createHormoneFeed } from '../src/hormone-feed.js';
import { createHormoneShadow } from '../src/hormone-shadow.js';
import { createLiveBuffer, maskArgs, sentTextOf } from '../src/live-buffer.js';
import { applyMoodChange, writeMoodFile } from '../src/mood.js';
import { buildNow, createSisterActions, createSisterLive, persistJsonConfig, readAcceptedTokens } from '../sister/live-server.mjs';
import { runClaude } from '../sister/sister.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const tmp = (p = 'daughters-console-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'test-token-0123456789abcdef';

/** 打一个请求，返回 { status, headers, text, json }。 */
function req(base, pathname, { method = 'GET', token = TOKEN, headerToken = false, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    if (token && !headerToken) u.searchParams.set('token', token);
    const h = { ...headers, ...(token && headerToken ? { 'x-console-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const r = http.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const line = (x) => `${JSON.stringify(x)}\n`;

// ① 实时缓冲：小鲸鱼的 DSH 事件流
{
  const live = createLiveBuffer({ who: 'fish', maxEntries: 50 });
  const key = 'private:1';
  const ev = (type, data) => live.ingestSessionEvent(key, 's1', { type, data }, { label: '老大私聊', sendTool: (n) => /qq_send/.test(n) });
  ev('turn/start', { turn: 1 });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '他在问' } });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '今天吃什么' } });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '吃面吧' } });
  ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '他在问今天吃什么' }, { type: 'text', text: '吃面吧' }] } }); // 分块已经推过的不重复
  ev('tool/call', { turn: 1, name: 'mcp__snowluma__qq_send_message', callId: 'c1', arguments: JSON.stringify({ messages: ['吃面吧', '加个蛋'], token: 'SECRET-TOKEN-VALUE', nested: { cookie: 'COOKIE-VALUE' } }) });
  ev('tool/result', { message: { source: { callId: 'c1' }, content: [{ text: 'sent' }] } });
  ev('tool/call', { turn: 1, name: 'web_search', callId: 'c2', arguments: { q: 'x' } });
  ev('tool/result', { message: { source: { callId: 'c2' }, isError: true, content: [{ text: '网络不通' }] } });
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const all = live.recent(100);
  const think = all.filter((e) => e.kind === 'think');
  assert.equal(think.length, 1, '思考分块合成一条，整条消息回来时不重复');
  assert.equal(think[0].text, '他在问今天吃什么');
  assert.equal(all.filter((e) => e.kind === 'text').length, 1);
  const call1 = all.find((e) => e.kind === 'tool-call' && e.callId === 'c1');
  assert.equal(call1.name, 'qq_send_message');
  assert.equal(call1.ok, true, '结果回来后工具调用标成功');
  assert.ok(!JSON.stringify(all).includes('SECRET-TOKEN-VALUE') && !JSON.stringify(all).includes('COOKIE-VALUE'), '参数里的令牌 / Cookie 打码');
  assert.equal(all.find((e) => e.kind === 'tool-call' && e.callId === 'c2').ok, false, '失败的标失败');
  const sent = all.filter((e) => e.kind === 'sent');
  assert.equal(sent.length, 1, '发送工具成功 → 一条「刚发出」');
  assert.equal(sent[0].text, '吃面吧 / 加个蛋');
  assert.equal(live.noteUnsaid(key, '  写了没发  ', { label: '老大私聊' }).kind, 'unsaid');
  assert.equal(live.noteUnsaid(key, '   '), null, '空的不记');
  for (let i = 0; i < 80; i += 1) live.add({ kind: 'note', text: `n${i}` });
  assert.equal(live.stats().size, 50, '环形缓冲：超过上限挤掉旧的');
  assert.equal(maskArgs({ password: 'p', ok: 'fine' }), '{"password":"***","ok":"fine"}');
  assert.equal(sentTextOf({ text: '一句' }), '一句');
  ok('小鲸鱼实时缓冲：思考 / 文字分块合并、工具成败、参数打码、发出的话、没说出口的、环形上限');
}

// ② 实时缓冲：姐姐的 claude 输出——不采集思考内容，只有「正在想」的起止
{
  let t = 1_000_000;
  const live = createLiveBuffer({ who: 'sister', now: () => t });
  const L = (x) => live.ingestClaudeLine(x, { session: 'owner', label: '老大私聊', sendTool: (n) => /qq_send$/.test(n) });
  L({ type: 'system', subtype: 'init' });
  assert.equal(live.recent(10).at(-1).kind, 'thinking', '一轮开始就进入「正在想」');
  assert.equal(live.recent(10).at(-1).open, true);
  t += 7000;
  L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'SECRET-THOUGHT-ALPHA' }, { type: 'redacted_thinking', data: 'SECRET-THOUGHT-BETA' }, { type: 'text', text: '早呀' }, { type: 'tool_use', id: 't1', name: 'mcp__sister-qq__qq_send', input: { text: '早呀老大', cookie: 'abc' } }] } });
  const mark = live.recent(10).find((e) => e.kind === 'thinking');
  assert.equal(mark.open, false);
  assert.equal(mark.secs, 7, '记下想了 7 秒');
  t += 1000;
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'SECRET-RESULT-BODY' }] } });
  assert.equal(live.recent(20).filter((e) => e.kind === 'thinking' && e.open).length, 1, '工具结果递回去后又在想下一步');
  L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__sister-qq__qq_read', input: {} }] } });
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: '读不到：没有权限' }] }] } });
  L({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET-THOUGHT-GAMMA' } } });
  L({ type: 'result', is_error: false, result: 'ok' });
  const dump = JSON.stringify(live.recent(100));
  for (const s of ['SECRET-THOUGHT-ALPHA', 'SECRET-THOUGHT-BETA', 'SECRET-THOUGHT-GAMMA']) assert.ok(!dump.includes(s), `姐姐的思考内容一个字都不采集：${s}`);
  assert.ok(!dump.includes('SECRET-RESULT-BODY'), '姐姐这一栏成功的工具只记成败，返回内容不留');
  assert.ok(!dump.includes('"cookie":"abc"'), '参数里的 Cookie 打码');
  const all = live.recent(100);
  assert.ok(all.some((e) => e.kind === 'text' && e.text === '早呀'), '她写出来的话要记');
  assert.ok(all.some((e) => e.kind === 'sent' && e.text === '早呀老大'), '发送工具成功 → 刚发出');
  assert.ok(all.some((e) => e.kind === 'tool-result' && e.ok === false && /没有权限/.test(e.text)), '失败的留一小段原因');
  assert.equal(all.filter((e) => e.kind === 'thinking' && e.open).length, 0, '一轮结束后没有还开着的「正在想」');
  assert.equal(all.some((e) => e.kind === 'think'), false, '姐姐这边根本没有 think 类条目');
  // 超时 / 被杀：endTurn 合上
  L({ type: 'system', subtype: 'init' });
  t += 3000;
  live.endTurn('owner');
  assert.equal(live.recent(100).filter((e) => e.kind === 'thinking' && e.open).length, 0);
  assert.equal(live.recent(100).filter((e) => e.kind === 'thinking').at(-1).secs, 3);
  ok('姐姐实时缓冲：只有「正在想（已 N 秒）」的起止，思考内容、成功工具的返回内容都不采集');
}

// ③ 实时区不落盘：喂数据、开 SSE 的整个过程中没有任何写文件的调用；源码里也没有引入 fs
{
  const calls = [];
  const names = ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'createWriteStream', 'openSync', 'mkdirSync', 'renameSync'];
  const orig = {};
  for (const n of names) { orig[n] = fs[n]; fs[n] = (...a) => { calls.push(n); return orig[n](...a); }; }
  try {
    const live = createLiveBuffer({ who: 'fish', heartbeatMs: 1e9 });
    live.ingestSessionEvent('private:1', 's', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '思考原文' } } });
    live.noteUnsaid('private:1', '没说出口的原文');
    const written = [];
    const res = { writeHead() {}, write: (s) => written.push(s), end() {}, on() {} };
    const rq = new EventEmitter();
    assert.equal(live.serve(rq, res), true);
    assert.ok(written.join('').includes('event: snapshot') && written.join('').includes('思考原文'), '连上先给一份快照');
    rq.emit('close');
  } finally { for (const n of names) fs[n] = orig[n]; }
  assert.deepEqual(calls, [], '实时区不写任何文件');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'live-buffer.js'), 'utf8');
  assert.ok(!/from\s+['"](node:)?fs(\/promises)?['"]|require\(\s*['"](node:)?fs/.test(src), 'live-buffer.js 里连 fs 都不引入');
  ok('SSE 不落盘原文：喂数据 + 开 SSE 全程没有写文件，live-buffer.js 不引入 fs');
}

// ④ SSE 的推送和同时连接上限
{
  const live = createLiveBuffer({ who: 'fish', maxClients: 2, heartbeatMs: 1e9 });
  const mk = () => { const out = []; const res = new EventEmitter(); Object.assign(res, { writeHead(s) { out.status = s; }, write: (s) => out.push(s), end() {} }); return { out, res, rq: new EventEmitter() }; };
  const a = mk(); const b = mk(); const c = mk();
  assert.equal(live.serve(a.rq, a.res), true);
  assert.equal(live.serve(b.rq, b.res), true);
  assert.equal(live.serve(c.rq, c.res), false, '超过上限回 429');
  assert.equal(c.out.status, 429);
  const e = live.add({ kind: 'text', text: 'hi' });
  live.update(e, { ok: true });
  assert.ok(a.out.join('').includes('event: add') && a.out.join('').includes('event: update'));
  a.rq.emit('close');
  assert.equal(live.stats().clients, 1, '断开的浏览器被清掉');
  ok('SSE：快照、add / update 推送、同时连接上限、断开清理');
}

// ⑤ 姐姐 runClaude 的 onLine：每行都喂，出错不拖累
{
  const mk = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; return c; };
  const child = mk();
  const seen = [];
  const p = runClaude({ child }, { prompt: 'x', sessionId: 's', onLine: (x) => { seen.push(x.type); throw new Error('实时区坏了'); } });
  child.stdout.emit('data', `${line({ type: 'system', subtype: 'init' })}${line({ type: 'assistant', message: { content: [{ type: 'text', text: '嗯' }] } })}${line({ type: 'result', is_error: false, result: '嗯', session_id: 's' })}`);
  const r = await p;
  assert.equal(r.text, '嗯', 'onLine 抛错也照常返回');
  assert.deepEqual(seen, ['system', 'assistant', 'result']);
  ok('runClaude 的 onLine：每行都喂一次，里面抛错不影响她说话');
}

// ⑥ 路由、鉴权、结构
const work = tmp();
const brainsRoot = path.join(work, 'qq');
fs.mkdirSync(path.join(work, 'public', 'vendor'), { recursive: true });
fs.writeFileSync(path.join(work, 'public', 'daughters.html'), '<!doctype html><title>她们俩</title>');
fs.writeFileSync(path.join(work, 'public', 'brain.html'), '<!doctype html><title>大脑</title>');
fs.writeFileSync(path.join(work, 'public', 'vendor', 'lib.min.js'), 'window.__lib=1;');
fs.writeFileSync(path.join(work, 'secret.txt'), '不该被读到');
const brains = createBrains(brainsRoot);
const sisterBrain = brains.brainOf('sister');
const stateDir = path.join(work, 'state');
const sisterState = path.join(work, 'sister-state');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(sisterState, { recursive: true });
// 姐姐的心情和激素：用真的写法造
writeMoodFile(sisterBrain.mood, applyMoodChange(null, { mood: 78, reason: '老大夸了我', dims: { 开心: 4 } }, Date.now()));
{
  let now = Date.now() - 20 * 60e3;
  const shadow = createHormoneShadow({ who: 'sister', stateDir: sisterState, clock: () => now, minGapMs: 0 });
  for (let i = 0; i < 6; i += 1) { now += 60e3; shadow.record({ type: 'msg_from_owner', text: '真棒' }); shadow.tick(); }
}
fs.mkdirSync(path.dirname(sisterBrain.recallLog), { recursive: true });
fs.writeFileSync(sisterBrain.recallLog, `${JSON.stringify({ at: Date.now(), mode: 'private', q: '早饭', picks: [{ label: '瞬间', score: 0.7, preview: '一起吃过面' }] })}\n`);
fs.mkdirSync(path.dirname(sisterBrain.sticky), { recursive: true });
fs.writeFileSync(sisterBrain.sticky, '记得问老大睡得好不好');
fs.writeFileSync(path.join(sisterState, 'sister.log'), '[2026-10-29T01:00:00.000Z] 叫 Claude 出错： 超时\n[2026-10-29T01:01:00.000Z] 自己醒了\n');
fs.writeFileSync(path.join(sisterState, 'usage.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, costUsd: 0.5, week: 0.2 })}\n`);
fs.mkdirSync(path.join(stateDir, 'mom-mailbox'), { recursive: true });
fs.writeFileSync(path.join(stateDir, 'mom-mailbox', 'letters.json'), JSON.stringify({ letters: [{ id: 'M1', at: Date.now(), fromLabel: '测试', status: 'new', text: '妈妈好' }] }));
fs.writeFileSync(path.join(stateDir, 'bridge.log'), '18:17:11 [bridge] 出错：测试\n');
const data = createDaughtersData({ brains, stateDir, sisterStateDir: sisterState, skewMs: () => 0, feiyuMoodFile: path.join(work, 'no-mood.json'), memoryPort: 1, douyinCdpPort: 1, douyinStateDir: path.join(work, 'no-douyin') });

// 假的姐姐本地小服务（用真的 createSisterLive / createSisterActions，状态是假的）
const sisterLive = createLiveBuffer({ who: 'sister', heartbeatMs: 1e9 });
const sState = { sleep: null, nextHeartbeatAt: Date.now() + 3600e3, ownerNotes: [] };
const sCfg = { effort: 'high', replyEffort: 'medium', hormones: { enabled: true } };
const sisterCfgFile = path.join(work, 'sister-config.json');
fs.writeFileSync(sisterCfgFile, JSON.stringify({ enabled: true, effort: 'high', replyEffort: 'medium', hormones: { enabled: true } }, null, 2));
let wakeCalls = 0; let hormoneOn = true; let timersStarted = 0; let busy = false;
const sctx = {
  nowMs: () => Date.now(), getState: () => sState, saveState() {}, getConfig: () => sCfg,
  persistConfig: (fn) => persistJsonConfig(sisterCfgFile, fn), // 临时文件，绝不碰活的 config.json
  asleep: () => !!sState.sleep && Date.now() < sState.sleep.until, busy: () => busy, busyUntil: () => 0, current: () => null,
  hormoneFeed: { setEnabled: (on) => { hormoneOn = on; return on; } }, hormonesEnabled: () => hormoneOn,
  startHormoneTimers: () => { timersStarted += 1; }, syncHormoneSleep() {}, context: () => ({ sessionMB: 3, limitMB: 15, rotatePending: false }),
  pending: () => [], enqueueWake: () => { wakeCalls += 1; }, log() {}
};
const sl = createSisterLive({ live: sisterLive, acceptedTokens: () => [TOKEN], getNow: () => buildNow(sctx), act: createSisterActions(sctx) });
const sisterServer = http.createServer(sl.handle);
const sisterPort = await listen(sisterServer);

// 假的记忆服务
const memCalls = [];
const memServer = http.createServer((rq, rs) => {
  memCalls.push(rq.url);
  rs.writeHead(200, { 'content-type': 'application/json' });
  rs.end(JSON.stringify(rq.url.startsWith('/graph/node') ? { ok: true, id: 'x', text: '全文' } : { nodes: [{ id: 'a' }], links: [], regions: [], generatedAt: 1 }));
});
const memPort = await listen(memServer);

const liveFish = createLiveBuffer({ who: 'fish', heartbeatMs: 1e9 });
const fishActs = [];
let fishHormones = true;
const fish = {
  hormonesEnabled: () => fishHormones, effort: () => ({ value: 'max', options: ['low', 'high', 'max'] }),
  online: () => ({ qq: { connected: true, accountOnline: true }, dshReady: true, mode: 'reserved2', paused: false }),
  context: () => [{ key: 'private:1', label: '老大私聊', tokens: 1000, limit: 200000, compactions: 0 }],
  now: () => ({ source: '测试', awake: true, sleep: null, current: null, sessions: [], queued: { wakeNotes: [], pendingWakes: [] } }),
  act: async (action, a) => { fishActs.push([action, a]); return { ok: true, message: '好' }; }
};
const consoleDeps = (memoryPort) => ({
  data, live: liveFish, publicDir: path.join(work, 'public'), fish, memoryPort,
  isAuthed: (rq, url) => String(url.searchParams.get('token') ?? rq.headers['x-console-token'] ?? '') === TOKEN,
  sister: { port: sisterPort, token: () => TOKEN, stateDir: sisterState, configFile: sisterCfgFile }
});
async function startConsole(overrides = {}) {
  const dc = createDaughtersConsole({ ...consoleDeps(memPort), ...overrides });
  const server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url, 'http://127.0.0.1');
    const sendJson = (obj, status = 200) => { rs.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); rs.end(JSON.stringify(obj)); };
    const readBody = () => new Promise((resolve) => { const c = []; rq.on('data', (d) => c.push(d)); rq.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { resolve({}); } }); });
    if (!(await dc.handle({ req: rq, res: rs, url, sendJson, readBody }))) sendJson({ ok: false, error: 'nope' }, 404);
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}
const web = await startConsole();

{
  const paths = ['/daughters.html', '/brain.html', '/vendor/lib.min.js', '/api/daughters/meta', '/api/daughters/now?who=fish', '/api/daughters/body?who=fish', '/api/daughters/memory?who=sister', '/api/daughters/outside?who=fish', '/api/daughters/ops', '/api/live/fish', '/api/live/sister', '/api/brain/graph?brain=whale', '/api/brain/graph/node?brain=whale&id=a'];
  for (const p of paths) {
    assert.equal((await req(web.base, p, { token: '' })).status, 403, `没带令牌：${p}`);
    assert.equal((await req(web.base, p, { token: 'wrong-token-wrong-token' })).status, 403, `令牌不对：${p}`);
  }
  assert.equal((await req(web.base, '/api/daughters/action', { method: 'POST', token: '', body: { who: 'fish', action: 'wake', confirm: true } })).status, 403, '写操作没带令牌');
  assert.equal(fishActs.length, 0, '没令牌的写操作一个都没动手');
  assert.ok(isDaughtersPath('/api/live/fish') && isDaughtersPath('/vendor/x.js') && isDaughtersPath('/brain.html') && !isDaughtersPath('/api/state'), '桥接闸门认得哪些路径归这里管');
  ok('鉴权：新页面和所有新接口没令牌 / 令牌不对都是 403，写操作也一样');
}

{
  const page = await req(web.base, '/daughters.html', { headerToken: true });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.ok((await req(web.base, '/brain.html')).text.includes('大脑'));
  const v = await req(web.base, '/vendor/lib.min.js');
  assert.equal(v.status, 200);
  assert.match(v.headers['content-type'], /javascript/);
  for (const bad of ['/vendor/../secret.txt', '/vendor/%2e%2e/secret.txt', '/vendor/..%2fsecret.txt', '/vendor/sub/lib.min.js', '/vendor/nope.js']) {
    const r = await req(web.base, bad);
    assert.ok(r.status === 404 && !r.text.includes('不该被读到'), `静态路由不能跳出 vendor：${bad}`);
  }
  assert.equal((await req(web.base, '/vendor/lib.min.js', { method: 'POST' })).status, 405, '静态只给 GET');
  ok('静态路由：/daughters.html、/brain.html、/vendor/* 同鉴权（头或 ?token=），路径穿越拿不到');
}

{
  const meta = (await req(web.base, '/api/daughters/meta', { headerToken: true })).json;
  assert.equal(meta.ok, true);
  assert.deepEqual(meta.people.map((p) => p.who), ['fish', 'sister']);
  assert.equal(meta.links.brain, '/brain.html');
  assert.equal(typeof meta.skewMs, 'number');
  assert.equal(meta.hormones.fish, true);
  assert.deepEqual(meta.effort.fish.options, ['low', 'high', 'max']);
  assert.equal(meta.effort.sister.effort, 'high');
  assert.equal(meta.sisterLive, true);
  const nowF = (await req(web.base, '/api/daughters/now?who=fish')).json;
  assert.equal(nowF.ok, true); assert.equal(nowF.who, 'fish'); assert.equal(nowF.awake, true);
  const nowS = (await req(web.base, '/api/daughters/now?who=sister')).json;
  assert.equal(nowS.ok, true); assert.equal(nowS.live, true); assert.equal(nowS.awake, true);
  assert.ok(nowS.nextHeartbeatAt > Date.now()); assert.equal(nowS.effort, 'high'); assert.deepEqual(nowS.queued.wakeNotes, []);
  assert.equal((await req(web.base, '/api/daughters/now?who=nobody')).status, 400);
  const body = (await req(web.base, '/api/daughters/body?who=sister')).json;
  assert.equal(body.ok, true);
  assert.equal(body.mood.ok, true); assert.equal(body.mood.score, 78); assert.ok(Array.isArray(body.mood.dims) && body.mood.dims.length >= 5); assert.ok(body.mood.curve.length >= 1);
  assert.equal(body.hormones.ok, true); assert.ok(body.hormones.keys.length >= 5 && body.hormones.points.length >= 2 && typeof body.hormones.felt === 'string' && Array.isArray(body.hormones.would));
  const bodyF = (await req(web.base, '/api/daughters/body?who=fish')).json;
  assert.equal(bodyF.ok, true);
  assert.equal(bodyF.mood.ok, false); assert.match(bodyF.mood.reason, /暂时读不到/, '读不到的块给「暂时读不到」，不报错');
  assert.equal(bodyF.hormones.ok, false); assert.match(bodyF.hormones.reason, /暂时读不到/);
  const mem = (await req(web.base, '/api/daughters/memory?who=sister')).json;
  assert.equal(mem.ok, true);
  for (const k of ['recall', 'moments', 'sticky', 'self', 'rambling', 'diary', 'growth', 'impressions', 'handoff', 'novels']) assert.ok(k in mem, `记忆块有 ${k}`);
  assert.equal(mem.recall[0].q, '早饭'); assert.equal(mem.recall[0].picks[0].label, '瞬间');
  assert.equal(mem.sticky.ok, true); assert.match(mem.sticky.text, /睡得好/);
  assert.equal(mem.self.ok, false, '没有 self 页也不抛错');
  const out = (await req(web.base, '/api/daughters/outside?who=sister')).json;
  assert.equal(out.ok, true); assert.equal(out.douyin.ok, false); assert.ok(out.explore && out.bili && out.shots);
  const ops = (await req(web.base, '/api/daughters/ops')).json;
  assert.equal(ops.ok, true);
  assert.equal(ops.online.sister.ok, true); assert.equal(ops.online.memory.ok, false, '记忆服务连不上显示不在线'); assert.equal(ops.online.dsh.ok, true);
  assert.ok(ops.context.fish.length === 1 && ops.context.sister.sessionMB === 3);
  assert.match(ops.errors.sister.lines.join('\n'), /出错/); assert.equal(ops.errors.fish.lines.length, 1);
  assert.equal(ops.mailbox.total, 1);
  assert.equal(ops.cost.sister.ok, true); assert.equal(ops.cost.sister.turns, 1); assert.equal(ops.cost.sister.tokens, 135);
  assert.equal(ops.cost.fish.ok, false);
  ok('只读接口的结构：meta / now / body / memory / outside / ops；读不到的块是「暂时读不到」');
}

{
  // 姐姐进程没开：不报错，退回读存档
  fs.writeFileSync(path.join(sisterState, 'sister-state.json'), JSON.stringify({ sleep: { since: Date.now() - 3600e3, until: Date.now() + 3600e3 }, nextHeartbeatAt: Date.now() + 7200e3, momNote: '早点睡' }));
  const lonely = await startConsole({ sister: { port: 1, token: () => TOKEN, stateDir: sisterState, configFile: sisterCfgFile } });
  const n = (await req(lonely.base, '/api/daughters/now?who=sister')).json;
  assert.equal(n.ok, true); assert.equal(n.live, false); assert.equal(n.awake, false); assert.match(n.source, /存的状态/);
  const o = (await req(lonely.base, '/api/daughters/ops')).json;
  assert.equal(o.online.sister.ok, false); assert.match(o.online.sister.reason, /没有回应/);
  const act = await req(lonely.base, '/api/daughters/action', { method: 'POST', body: { who: 'sister', action: 'wake', confirm: true } });
  assert.equal(act.status, 502); assert.match(act.json.error, /没有回应/);
  const live = await req(lonely.base, '/api/live/sister', { token: TOKEN });
  assert.equal(live.status, 200); assert.match(live.text, /event: offline/, '姐姐的进程不在：给一条 offline 事件，不回错误码（页面才会自动重连）');
  await lonely.close();
  fs.rmSync(path.join(sisterState, 'sister-state.json'));
  ok('姐姐的进程没开：now 退回存档、ops 标离线、操作回 502 友好提示、实时流给 offline 事件');
}

{
  // 写操作：必须带令牌、confirm:true，字段有范围
  const post = (body, opts = {}) => req(web.base, '/api/daughters/action', { method: 'POST', body, ...opts });
  assert.equal((await post({ who: 'fish', action: 'wake' })).status, 400, '没带 confirm');
  assert.equal((await post({ who: 'fish', action: 'wake', confirm: 'true' })).status, 400, 'confirm 必须是布尔 true');
  assert.equal((await post({ who: 'nobody', action: 'wake', confirm: true })).status, 400);
  assert.equal((await post({ who: 'fish', action: 'rm-rf', confirm: true })).status, 400);
  assert.equal((await post({ who: 'fish', action: 'note', text: '   ', confirm: true })).status, 400);
  assert.equal((await post({ who: 'fish', action: 'hormones', enabled: 'yes', confirm: true })).status, 400);
  assert.equal((await post({ who: 'sister', action: 'effort', effort: 'ultra', confirm: true })).status, 400);
  assert.equal(fishActs.length, 0, '参数不对的都没动手');
  assert.equal((await post({ who: 'fish', action: 'sleep', hours: 99, confirm: true })).json.ok, true);
  assert.equal(fishActs.at(-1)[1].hours, 14, '睡多久最多 14 小时');
  assert.equal((await post({ who: 'fish', action: 'note', text: 'x'.repeat(900), confirm: true })).json.ok, true);
  assert.equal(fishActs.at(-1)[1].text.length, 500, '留话最多 500 字');
  assert.equal((await post({ who: 'fish', action: 'hormones', enabled: false, confirm: true })).json.ok, true);
  assert.deepEqual(fishActs.at(-1), ['hormones', { action: 'hormones', enabled: false }]);
  assert.equal((await post({ who: 'fish', action: 'effort', effort: 'high', confirm: true })).json.ok, true);
  ok('写操作：必须带令牌和 confirm:true，who / action / 字段范围都会验，小鲸鱼那边收到的是清洗过的参数');
}

{
  // 姐姐的操作：真的走到她的小服务（假状态）
  const post = (body) => req(web.base, '/api/daughters/action', { method: 'POST', body: { who: 'sister', confirm: true, ...body } });
  const n1 = await post({ action: 'note', text: '记得喝水' });
  assert.equal(n1.json.ok, true);
  assert.equal(sState.ownerNotes.length, 1); assert.equal(sState.ownerNotes[0].text, '记得喝水');
  assert.equal((await req(web.base, '/api/daughters/now?who=sister')).json.queued.wakeNotes[0].text, '记得喝水');
  const sl1 = await post({ action: 'sleep', hours: 2 });
  assert.equal(sl1.json.ok, true); assert.ok(sState.sleep.until - Date.now() > 1.9 * 3600e3); assert.equal(sState.nextHeartbeatAt, sState.sleep.until);
  assert.equal((await req(web.base, '/api/daughters/now?who=sister')).json.awake, false);
  assert.equal((await post({ action: 'wake' })).json.wasSleeping, true); assert.equal(sState.sleep, null); assert.equal(wakeCalls, 1);
  busy = true;
  assert.equal((await post({ action: 'wake' })).status, 400, '她正忙一轮的时候不叫');
  busy = false;
  const hf = await post({ action: 'hormones', enabled: false });
  assert.equal(hf.json.enabled, false); assert.equal(hormoneOn, false);
  assert.equal(JSON.parse(fs.readFileSync(sisterCfgFile, 'utf8')).hormones.enabled, false, '开关写进（临时的）配置，重启后不变回去');
  assert.equal(sCfg.hormones.enabled, false);
  const ht = await post({ action: 'hormones', enabled: true });
  assert.equal(ht.json.enabled, true); assert.equal(timersStarted, 1, '热开：定时器接上');
  const ef = await post({ action: 'effort', effort: 'xhigh', replyEffort: 'low' });
  assert.equal(ef.json.ok, true); assert.equal(sCfg.effort, 'xhigh'); assert.equal(sCfg.replyEffort, 'low');
  assert.equal(JSON.parse(fs.readFileSync(sisterCfgFile, 'utf8')).effort, 'xhigh');
  // 小服务自己也要令牌、只认本机 Host
  const direct = (p, o) => req(`http://127.0.0.1:${sisterPort}`, p, o);
  assert.equal((await direct('/now', { token: '' })).status, 403);
  assert.equal((await direct('/action', { method: 'POST', token: '', body: { action: 'wake' } })).status, 403);
  assert.equal((await direct('/now', { headerToken: true })).status, 200);
  assert.equal((await direct('/now', { headers: { host: 'evil.example.com' } })).status, 403, 'Host 不是本机的拒绝');
  ok('姐姐的本地小服务：留话 / 睡 / 叫醒 / 忙时不叫 / 激素热切换并写配置 / 强度，自己也要令牌、只认本机 Host');
}

{
  // 令牌读取：config 里合法的 consoleToken 或 state/console-token
  const d = tmp('tok-');
  fs.writeFileSync(path.join(d, 'console-token'), 'file-token-abcdef0123456789\n');
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ consoleToken: 'cfg-token-abcdef0123456789' }));
  assert.deepEqual(readAcceptedTokens({ tokenFile: path.join(d, 'console-token'), bridgeConfigFile: path.join(d, 'config.json') }), ['cfg-token-abcdef0123456789', 'file-token-abcdef0123456789']);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ consoleToken: 'short' }));
  assert.deepEqual(readAcceptedTokens({ tokenFile: path.join(d, 'console-token'), bridgeConfigFile: path.join(d, 'config.json') }), ['file-token-abcdef0123456789'], '不合法的配置令牌桥接也不用，这边跟它一致');
  fs.rmSync(d, { recursive: true, force: true });
  ok('小服务认的令牌跟桥接取令牌的规则一致');
}

{
  // SSE：真的连一次小鲸鱼的流，再推一条
  const u = new URL('/api/live/fish', web.base); u.searchParams.set('token', TOKEN);
  const got = await new Promise((resolve, reject) => {
    let text = '';
    const r = http.get(u, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.on('data', (c) => {
        text += c;
        if (text.includes('event: snapshot') && !text.includes('event: add')) liveFish.add({ kind: 'text', session: 'private:1', text: '推过来的一句' });
        if (text.includes('event: add')) { r.destroy(); resolve(text); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { r.destroy(); reject(new Error('SSE 超时')); }, 4000);
  });
  assert.ok(got.includes('推过来的一句'));
  // 姐姐的流经桥接代理
  const su = new URL('/api/live/sister', web.base); su.searchParams.set('token', TOKEN);
  const gotS = await new Promise((resolve, reject) => {
    let text = '';
    const r = http.get(su, (res) => {
      res.on('data', (c) => {
        text += c;
        if (text.includes('event: snapshot') && !text.includes('代理一句')) sisterLive.add({ kind: 'sent', session: 'owner', text: '代理一句' });
        if (text.includes('代理一句')) { r.destroy(); resolve(text); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { r.destroy(); reject(new Error('姐姐 SSE 超时')); }, 4000);
  });
  assert.ok(gotS.includes('event: snapshot') && gotS.includes('代理一句'));
  ok('SSE：小鲸鱼的流直连、姐姐的流经桥接代理，都能收到快照和新条目');
}

{
  // 大脑图谱代理：只读，转发到记忆服务；连不上给友好提示
  memCalls.length = 0;
  const g = await req(web.base, '/api/brain/graph?brain=sister&limit=300&junk=1');
  assert.equal(g.status, 200); assert.equal(g.json.nodes[0].id, 'a');
  assert.equal(memCalls[0], '/graph?brain=sister&limit=300', '只转发 brain / limit / recent / recentOnly');
  const gn = await req(web.base, '/api/brain/graph/node?brain=whale&id=moment%3Aabc');
  assert.equal(gn.json.text, '全文'); assert.equal(memCalls[1], '/graph/node?brain=whale&id=moment%3Aabc');
  assert.equal((await req(web.base, '/api/brain/graph?brain=evil')).status, 400);
  assert.equal((await req(web.base, '/api/brain/graph/node?brain=whale')).status, 400, '缺 id');
  assert.equal((await req(web.base, '/api/brain/graph?brain=whale', { method: 'POST' })).status, 405, '只读：不转发 POST');
  const down = await startConsole({ memoryPort: 1 });
  const bad = await req(down.base, '/api/brain/graph?brain=whale');
  assert.equal(bad.status, 502); assert.match(bad.json.error, /没有回应/); assert.match(bad.json.error, /过一会儿/);
  await down.close();
  ok('/api/brain/graph 和 /graph/node：只读代理、只转发白名单参数、连不上给友好提示');
}

// ⑦ 激素热切换（hormone-feed 的 setEnabled）
{
  const dir = tmp('hormone-toggle-');
  let now = 1_800_000_000_000;
  const feed = createHormoneFeed({ who: 'fish', stateDir: dir, enabled: false, clock: () => now });
  assert.equal(feed.enabled, false);
  feed.record({ type: 'msg_from_owner', text: '在吗' }); feed.tick();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('hormones-')), [], '关着的时候不写任何东西');
  assert.equal(feed.setEnabled(true), true); assert.equal(feed.enabled, true);
  now += 60e3; feed.record({ type: 'msg_from_owner', text: '在吗' }); now += 60e3; feed.tick();
  assert.ok(fs.existsSync(path.join(dir, 'hormones-fish.jsonl')), '热开后接着记');
  const size = fs.statSync(path.join(dir, 'hormones-fish.jsonl')).size;
  assert.equal(feed.setEnabled(false), false); now += 120e3; feed.record({ type: 'msg_from_owner', text: '在吗' }); feed.tick();
  assert.equal(fs.statSync(path.join(dir, 'hormones-fish.jsonl')).size, size, '热关后不再写，已经记下的留着');
  assert.equal(feed.snapshot(), null);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('激素热切换：关着不写、热开接着记、热关停下且已有记录留着');
}

// ⑧ buildNow 的字段
{
  const st = { sleep: { since: 1, until: Date.now() + 1000 }, nextHeartbeatAt: 123, ownerNotes: [{ text: 'x'.repeat(300), at: 1 }], heldLines: { to: '老大', lines: ['a', 'b'] } };
  const n = buildNow({ nowMs: () => Date.now(), getState: () => st, getConfig: () => ({ effort: 'max', replyEffort: 'low' }), busy: () => true, busyUntil: () => 0, current: () => ({ key: 'owner', label: '老大私聊', since: 5, effort: 'low' }), hormonesEnabled: () => false, context: () => null, pending: () => [] });
  assert.equal(n.awake, false); assert.equal(n.current.busy, true); assert.equal(n.busy, true); assert.equal(n.nextHeartbeatAt, 123);
  assert.equal(n.queued.wakeNotes[0].text.length, 200); assert.deepEqual(n.queued.held, { to: '老大', lines: ['a', 'b'] }); assert.equal(n.hormonesEnabled, false);
  ok('姐姐「此刻」的字段：醒 / 睡、正在跟谁、留话、压着的话、强度');
}

// ⑨ 页面静态检查（真页面）
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'daughters.html'), 'utf8');
  assert.ok(html.includes('href="/brain.html"'), '页面里有去 /brain.html 的入口');
  assert.ok(!/(src|href)\s*=\s*["']https?:\/\//i.test(html) && !/@import|url\(\s*["']?https?:/.test(html), '不依赖外网');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(html), '数据一律 textContent 写进页面，不拼 HTML');
  for (const w of ['此刻在干什么', '正在想', '思考', '刚发出', '没说出口', '排队中的', '心情', '激素', '本来会', '感受句', '最近想起', '瞬间', '便签', 'self', '碎碎念', '日记', '成长札记', '印象', '交接', '半只耳朵', '抖音', 'B 站', '随便逛', '屏幕', '上下文用量', '最近报错', '妈妈信箱', '今天的花费', '留话', '叫醒', '让她睡', '影子记录', '思考强度', '暂时读不到', '来源：', '更新于']) assert.ok(html.includes(w), `页面里有「${w}」`);
  const used = new Set([...html.matchAll(/['"`](\/api\/[a-z/]+)/g)].map((m) => m[1]));
  for (const p of used) assert.ok(isDaughtersPath(p), `页面用到的接口 ${p} 归路由模块管（有令牌闸门）`);
  assert.ok(used.has('/api/daughters/action') && used.has('/api/daughters/ops') && [...used].some((p) => p.startsWith('/api/live/')), '页面确实用到了操作、运行情况、实时流');
  assert.ok(html.includes('confirm: true'), '写操作带 confirm:true');
  assert.ok(html.includes('data-theme="dark"') && html.includes('prefers-color-scheme'), '深浅色');
  assert.ok(html.includes('createElementNS'), '图是内联 SVG');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script), '页面脚本语法没问题'); // 只编译不运行
  ok('页面静态检查：入口、不依赖外网、不拼 HTML、29 项要的内容、接口都有闸门、写操作带确认、脚本语法');
}

// ⑩ 源码断言：页面的东西不许进给她们的提示和工具说明
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).map((l) => l.replace(/(^|[^:'"`])\/\/[^'"`]*$/, '$1')).join('\n');
  const FORBID = /控制台|实时思考|\/api\/live|\/api\/daughters|daughters\.html|花费|花了|token 用量|用了多少 token/;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 代码文件：去掉注释后（工具说明、提示都在字符串里）不许出现；只有桥接里给老大看的老控制台日志 / 报错可以有「控制台」，所以 bridge.js 只查新字眼
  for (const rel of ['src/mcp-snowluma-safe.js', 'src/mcp-web-search-safe.js', 'sister/qq-mcp.mjs', 'sister/explore-tool.mjs', 'sister/cowatch.mjs']) {
    const body = strip(read(rel));
    assert.ok(!FORBID.test(body), `${rel} 的工具说明 / 提示里不许有页面相关的字眼：${(FORBID.exec(body) || [])[0]}`);
  }
  for (const rel of ['src/bridge.js', 'sister/sister.mjs']) {
    const body = strip(read(rel));
    assert.ok(!/实时思考|\/api\/live|\/api\/daughters|daughters\.html|花费|花了/.test(body), `${rel} 里没有页面字眼（注释除外）：${(/实时思考|\/api\/live|\/api\/daughters|daughters\.html|花费|花了/.exec(body) || [])[0]}`);
  }
  // 递给 claude 的提示：不含实时区、花费的字段
  const sis = read('sister/sister.mjs');
  const promptLine = sis.split('\n').find((l) => l.includes('r = await runClaude(proc,'));
  assert.ok(promptLine && !/live|cost|usage|Usage/.test(promptLine.replace('onLine: liveLine', '')), '姐姐递给 claude 的提示里没有实时区和花费的字段');
  // 给她们看的文档 / 角色卡
  for (const rel of ['sister/persona.md', 'workspace/工具集.md', 'workspace/我是怎么做出来的.md', 'roles/DeepSeek小鲸鱼QQ群友主人的小女友版.md']) {
    assert.ok(!FORBID.test(read(rel)), `${rel} 里不许有页面相关的字眼：${(FORBID.exec(read(rel)) || [])[0]}`);
  }
  // 姐姐 / 小鲸鱼的「老大留话」前缀：家常话，不提页面
  assert.ok(/老大留了一句话给你/.test(sis) && /老大留了一句话给你/.test(read('src/bridge.js')));
  ok('源码断言：控制台 / 实时思考 / /api/live / 花费 都不在提示构造、工具说明、角色卡、工具集和自我说明里');
}

for (const s of [web, { close: () => closeServer(sisterServer) }, { close: () => closeServer(memServer) }]) await s.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n她们俩的页面：${passed} 项通过`);

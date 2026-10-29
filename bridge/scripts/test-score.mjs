// 读谱：和弦解析、调性、简谱记号、小节划分、八度纠错。不跑模型，直接喂数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseChord, detectKey, jianpu, renderCard, spellFor, friendlyToolError, BILI_BLOCKED_HINT } from '../src/score.js';

const BILI_WATCH = 'E:\\qq-bridge\\plugins-ext\\dsh-bili-whale\\tools\\commands\\bili-watch.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

{
  assert.deepEqual(parseChord('F:min'), { root: 5, minor: true, name: 'Fm' });
  assert.equal(parseChord('C#:maj7').name, 'C#maj7');
  assert.equal(parseChord('Bb:min7').name, 'Bbm7');
  assert.equal(parseChord('N'), null);
  assert.equal(spellFor(8)[1], 'Db', 'Ab 调用降号');
  assert.equal(spellFor(7)[6], 'F#', 'G 调用升号');
  ok('和弦名解析、升降号写法');
}

{
  // C 大调音阶的分布 → C 大调；A 小调和弦为主 → 1=C、主音 A
  const cMajor = [5, 0, 3, 0, 3, 3, 0, 4, 0, 2, 0, 2];
  const k = detectKey(cMajor);
  assert.equal(k.tonic, 0); assert.equal(k.mode, 'major'); assert.equal(k.doh, 0);
  const aMinor = [3, 0, 2, 0, 3, 2, 0, 2, 0, 6, 0, 1];
  const m = detectKey(aMinor);
  assert.equal(m.tonic, 9); assert.equal(m.mode, 'minor'); assert.equal(m.doh, 0, '小调按关系大调的 1 记');
  ok('调性：大调 / 小调，小调简谱按关系大调记');
}

{
  assert.equal(jianpu(60, 0, 60), '1');
  assert.equal(jianpu(64, 0, 60), '3');
  assert.equal(jianpu(72, 0, 60), "1'");
  assert.equal(jianpu(57, 0, 60), '6,');
  assert.equal(jianpu(70, 0, 60), 'b7');
  ok('简谱记号：高低八度、降号');
}

{
  // 120 BPM、4/4、两小节，旋律 C D E F | G - - 0；中间混一个高八度的泛音
  const beats = Array.from({ length: 9 }, (_, i) => ({ time: i * 0.5, downbeat: i % 4 === 0 }));
  const melody = [60, 62, 64, 65, 67, 67, 67, null];
  const frames = [];
  for (let t = 0; t < 4; t += 0.02) {
    const beat = Math.floor(t / 0.5);
    let m = melody[beat];
    if (m == null) continue;
    if (beat === 2 && t > 1.1 && t < 1.2) m += 12; // 泛音闪一下
    frames.push({ time_ms: Math.round(t * 1000), f0_hz: 440 * 2 ** ((m - 69) / 12), voiced_prob: 0.9 });
  }
  // 和弦 C → F → C（不确定）：调性明确是 C 大调
  const chords = [{ start_ms: 0, end_ms: 1000, chord: 'C', confidence: 0.9 }, { start_ms: 1000, end_ms: 2000, chord: 'F', confidence: 0.9 }, { start_ms: 2000, end_ms: 4000, chord: 'C', confidence: 0.4 }];
  const card = renderCard({ title: '音阶', offset: 10, duration: 4, tempo: 120, beats, chords, frames, slotsPerBeat: 1 });
  assert.match(card, /每小节 4 拍/);
  assert.match(card, /C 大调（1=C）/);
  const rows = card.split('\n').filter((l) => /^(第|弱起)/.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /0:10 \| C\(1\) F\(4\)\s+\| 1 \| 2 \| 3 \| 4$/, '第一小节 1 2 3 4，泛音被压回去');
  assert.match(rows[1], /C\(1\)\?\s+\| 5 \| - \| - \| 0$/, '第二小节 5 拖三拍、和弦不确定带 ?');
  ok('排谱：规整小节、拖音、没唱、泛音纠回、和弦级数');
}

{
  // 2026-10-29 M11：B 站回网页 / 堆栈时给她一句人话
  const raw = `file:///C:/x/bili-watch.mjs:27\nconst view = await (await fetch(u)).json()\n                                       ^\n\nSyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON\n    at JSON.parse (<anonymous>)\n    at async file:///C:/x/bili-watch.mjs:27:14\n\nNode.js v24.21.0`;
  const a = friendlyToolError(raw);
  assert.equal(a, BILI_BLOCKED_HINT);
  assert.doesNotMatch(a, /DOCTYPE|at |file:/);
  assert.equal(friendlyToolError('<!DOCTYPE html> HTTP 412'), `${BILI_BLOCKED_HINT}（HTTP 412）`, '带上状态码');
  assert.equal(friendlyToolError(`${BILI_BLOCKED_HINT}（HTTP 412）\n`), `${BILI_BLOCKED_HINT}（HTTP 412）`, '插件已经说了人话就用它那句');
  assert.match(friendlyToolError('TypeError: x is undefined\n    at foo (C:\\a\\b.mjs:3:9)'), /^这次没弄成.*可以过一会儿再试/, '别的堆栈也不原样给');
  assert.equal(friendlyToolError('前面还有一首在扒，等会儿再来'), '前面还有一首在扒，等会儿再来', '本来是人话的不动');
  ok('读谱 / B 站报错：网页和堆栈换成人话');
}

{
  // 2026-10-29 M11：插件 bili-watch.mjs 遇到 B 站回网页时不再 .json() 崩，说人话（假 fetch、假凭据、假 ffmpeg，不联网）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-watch-guard-'));
  fs.mkdirSync(path.join(tmp, '.bili-ai'));
  fs.writeFileSync(path.join(tmp, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'fixture', bili_jct: 'fixture', buvid3: 'fixture' }));
  const run = (status, type, body) => {
    const pre = path.join(tmp, `fake-fetch-${status}.mjs`);
    fs.writeFileSync(pre, `globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: ${status}, headers: { 'content-type': ${JSON.stringify(type)} } });\n`);
    return spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, BILI_WATCH, 'BV1xxxxxxxxx', '3x3', tmp],
      { encoding: 'utf8', env: { ...process.env, USERPROFILE: tmp, HOME: tmp, FFMPEG: process.execPath }, timeout: 30000, windowsHide: true });
  };
  const r = run(412, 'text/html; charset=utf-8', '<!DOCTYPE html><html>blocked</html>');
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, /B 站这会儿不让看这条（可能是风控或者需要登录），可以过一会儿再试，或者换一条（HTTP 412）/);
  assert.doesNotMatch(r.stderr, /DOCTYPE|not valid JSON|\n\s+at /);
  const r2 = run(200, 'text/html', '<!DOCTYPE html>');
  assert.equal(r2.status, 6);
  assert.match(r2.stderr, /（HTTP 200）/, '状态码 200 但回的是网页也拦住');
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('bili-watch：B 站回网页时说人话、带状态码');
}

console.log(`全部通过：${passed} 组`);

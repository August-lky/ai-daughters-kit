// 对方插话就先停（2026-10-26）：sendMessagesV2 发第二条起每条之前问一次 held()，返回 true 就把剩下的压着不发。
// 从 bridge.js 原样抽出这个函数，配上假的发送和睡眠来跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const start = src.indexOf('  function sendMessagesV2(');
const end = src.indexOf('\n  }\n', start) + 4;
assert.ok(start > 0 && end > start, '找到 sendMessagesV2');
const body = src.slice(start, end);

function build() {
  const sends = [];
  const sleeps = [];
  const make = new Function('deps', `
    let sendChain = Promise.resolve();
    const { captureSendGuard, onebotSend, sleep, log } = deps;
    ${body}
    return sendMessagesV2;`);
  const fn = make({
    captureSendGuard: () => () => {},
    onebotSend: async (kind, id, msg) => { sends.push(msg); },
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {}
  });
  return { fn, sends, sleeps };
}

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

{
  const { fn, sends, sleeps } = build();
  const sent = await fn('private:1', ['一', '二', '三'], [10, 20]);
  assert.deepEqual(sends, ['一', '二', '三']);
  assert.deepEqual(sent.held, []);
  assert.deepEqual(sleeps, [10, 20]);
  ok('没人插话：照常发完，条间照常等');
}
{
  const { fn, sends, sleeps } = build();
  let newMsg = false;
  const sent = await fn('private:1', ['一', '二', '三'], [10, 20], null, null, () => newMsg);
  assert.deepEqual(sends, ['一', '二', '三'], '没插话不受影响');
  const b = build();
  const sent2 = await b.fn('private:1', ['一', '二', '三'], [10, 20], null, null, () => { newMsg = true; return newMsg; });
  assert.deepEqual(b.sends, ['一'], '第一条总会发');
  assert.deepEqual(sent2.held, ['二', '三'], '后面的压着');
  assert.deepEqual(b.sleeps, [10], '压着以后不再空等');
  assert.deepEqual(sent.held, []);
  void sleeps;
  ok('发到一半对方插话：第一条照发，后面的压着不发、不空等');
}
{
  const b = build();
  let calls = 0;
  const sent = await b.fn('private:1', ['一', '二', '三'], [10, 20], null, null, () => ++calls >= 2);
  assert.deepEqual(b.sends, ['一', '二']);
  assert.deepEqual(sent.held, ['三']);
  ok('第二条发完才插话：只压最后一条');
}
console.log(`全部通过：${passed} 组`);

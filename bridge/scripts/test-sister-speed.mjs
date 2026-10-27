// 姐姐回得快一点（2026-10-25）：runClaude 在 result 那一行到了就返回，不等进程退出；没 result 就退出算出错。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runClaude, spawnClaude } from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.input = '';
  c.stdin = { end: (s = '') => { c.input += s; c.stdinClosed = true; } };
  c.kill = () => { c.killed = true; };
  return c;
}
const line = (x) => JSON.stringify(x) + '\n';

// ① result 一到就返回（进程还没退）；分好几块到、工具和额度都记上
{
  const child = fakeChild();
  let settled = null;
  const p = runClaude({ child }, { prompt: '你好', sessionId: 's1' }).then((r) => { settled = r; });
  assert.ok(child.input.includes('你好'));
  const all = line({ type: 'system', subtype: 'init' })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sister-qq__qq_send', input: { text: 'x' } }] } })
    + line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
    + line({ type: 'result', is_error: false, result: '好', session_id: 's1', usage: { output_tokens: 1 }, total_cost_usd: 0.01 });
  child.stdout.emit('data', all.slice(0, 37));
  child.stdout.emit('data', all.slice(37));
  await p;
  assert.equal(settled.text, '好');
  assert.equal(settled.limit.status, 'allowed');
  assert.deepEqual(settled.toolsUsed.map((t) => t.name), ['mcp__sister-qq__qq_send']);
  child.emit('close', 0); // 之后才退出也不影响
  ok('结果一到就返回，不等进程退出');
}

// ② 没给 result 就退出 → 出错；result 是错误 → 出错
{
  const child = fakeChild();
  const p = runClaude({ child }, { prompt: 'x', sessionId: 's' });
  child.stderr.emit('data', 'boom');
  child.emit('close', 1);
  await assert.rejects(p, /claude 退出 1：boom/);
  const c2 = fakeChild();
  const p2 = runClaude({ child: c2 }, { prompt: 'x', sessionId: 's' });
  c2.stdout.emit('data', line({ type: 'result', is_error: true, result: 'Request not allowed' }));
  await assert.rejects(p2, /Request not allowed/);
  ok('没结果就退出、或结果是错误，都算出错');
}

// ③ 先起好的进程：起的时候不写输入（它停在等输入）；参数带上会话
{
  let spawned = null;
  const child = fakeChild();
  const p = spawnClaude({ exe: 'claude.exe', sessionId: 'abc', resume: true, model: 'm', effort: 'low', cwd: '.', spawnImpl: (exe, args) => { spawned = args; return child; } });
  assert.equal(child.input, '');
  assert.ok(!child.stdinClosed);
  assert.ok(spawned.includes('--resume') && spawned.includes('abc') && spawned.includes('low'));
  let exited = false;
  p.exited.then(() => { exited = true; });
  child.emit('close', 0);
  await p.exited;
  assert.ok(exited);
  ok('先起好的进程不急着给输入，退出能等到');
}

console.log(`全部通过：${passed} 组`);

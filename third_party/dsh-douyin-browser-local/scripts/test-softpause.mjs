// 读私信撞上页面变化不再立刻暂停联系人（2026-10-24，softpause）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../chat-service.mjs', import.meta.url), 'utf8');
const re = src.match(/const TRANSIENT_READ_ERROR = (\/.*\/);/);
assert.ok(re, '找不到 TRANSIENT_READ_ERROR');
const TRANSIENT = new Function(`return ${re[1]};`)();
const fnStart = src.indexOf('function softRetry(mark, now = Date.now()) {');
const fnEnd = src.indexOf('}', src.indexOf('return mark.transientFails.length < 5;')) + 1;
const softRetry = new Function(`${src.slice(fnStart, fnEnd)}\nreturn softRetry;`)();

test('她报过的几种错误都算暂时性的', () => {
  for (const m of ['page.evaluate: Error: 消息窗口已经改变。', 'page.screenshot: Timeout 10000ms exceeded.', '会话标题或头像回读与联系人不一致，已停止操作。', '指定会话未成功打开，未读取正文或点击发送。', '读取前会话身份发生变化。']) {
    assert.ok(TRANSIENT.test(m), m);
  }
});

test('真问题不算：登录、验证、白名单', () => {
  for (const m of ['请在专用 Edge 完成登录或验证。', '指定联系人已变化或属于群聊，已停止操作。', '发送被中断，需要人工核对。']) {
    assert.ok(!TRANSIENT.test(m), m);
  }
});

test('10 分钟内前 4 次先不暂停，第 5 次暂停；过了 10 分钟重新计', () => {
  const mark = {};
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(softRetry(mark, t0 + i * 1000), true);
  assert.equal(softRetry(mark, t0 + 5000), false);
  const later = {};
  assert.equal(softRetry(later, t0), true);
  for (let i = 0; i < 3; i++) softRetry(later, t0 + 1000 + i);
  assert.equal(softRetry(later, t0 + 11 * 60 * 1000), true, '旧的过期了，只剩这一次');
});

test('接线：没有正在生成的回复、不是用户停止，才走软重试；之后才是原来的暂停', () => {
  assert.match(src, /else if \(!signal\.aborted && !mark\.pending && TRANSIENT_READ_ERROR\.test\(String\(error\?\.message \|\| ''\)\) && softRetry\(mark\)\) \{/);
  assert.ok(src.indexOf('softRetry(mark)) {') < src.indexOf("else { mark.status = 'paused'; mark.reason = signal.aborted ?"));
});

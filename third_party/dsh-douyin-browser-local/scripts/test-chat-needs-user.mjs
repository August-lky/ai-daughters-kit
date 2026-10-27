// 后台收私信出错不再被吞掉（2026-10-24，chatwatch）：notePollError / notePollOk 的分类和 30 分钟去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../chat-service.mjs', import.meta.url), 'utf8');
const start = src.indexOf('  notePollError(error) {');
const end = src.indexOf('  log(type, value = {}) {');
assert.ok(start > 0 && end > start, '找不到 notePollError / notePollOk');
// 把两个方法搬到一个假的类上，log 只记到数组里
const Fake = new Function(`return class { constructor() { this.logged = []; } log(type, value) { this.logged.push({ type, ...value }); }\n${src.slice(start, end)}\n};`)();

test('定时器改成记录错误，不再吞掉', () => {
  assert.match(src, /setInterval\(\(\) => void this\.poll\(\)\.then\(\(\) => this\.notePollOk\(\), \(error\) => this\.notePollError\(error\)\)/);
});

test('登录 / 验证码 / 页面限制 → chat.needs_user；其他 → chat.poll_error', () => {
  const a = new Fake();
  a.notePollError(new Error('请在专用 Edge 完成登录或验证。'));
  const b = new Fake();
  b.notePollError(new Error('socket hang up'));
  assert.equal(a.logged[0].type, 'chat.needs_user');
  assert.equal(b.logged[0].type, 'chat.poll_error');
});

test('同一种问题 30 分钟只记一次，换了种类会记', () => {
  const a = new Fake();
  a.notePollError(new Error('抖音私信页面需要手动处理。'));
  a.notePollError(new Error('抖音私信页面需要手动处理。'));
  assert.equal(a.logged.length, 1);
  a.pollIssue.at -= 31 * 60 * 1000;
  a.notePollError(new Error('抖音私信页面需要手动处理。'));
  assert.equal(a.logged.length, 2);
  a.notePollError(new Error('timeout'));
  assert.equal(a.logged.at(-1).type, 'chat.poll_error');
});

test('验证码问题恢复后记一次 chat.recovered；普通错误恢复不记', () => {
  const a = new Fake();
  a.notePollError(new Error('需要手动登录、验证或解除页面限制'));
  a.notePollOk();
  a.notePollOk();
  assert.deepEqual(a.logged.map((e) => e.type), ['chat.needs_user', 'chat.recovered']);
  const b = new Fake();
  b.notePollError(new Error('timeout'));
  b.notePollOk();
  assert.deepEqual(b.logged.map((e) => e.type), ['chat.poll_error']);
});

test('报错原文截到 200 字', () => {
  const a = new Fake();
  a.notePollError(new Error('验证'.repeat(300)));
  assert.ok(a.logged[0].message.length <= 200);
});

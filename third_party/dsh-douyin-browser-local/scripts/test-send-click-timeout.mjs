// 本机补丁（2026-10-25）：点「发送」后消息已经发出、按钮随即消失，Playwright 等按钮到 2 秒超时抛错，
// 以前一律记成「可能已经发出去了但没核对上」。现在点击抛错时先看真实发送输入有没有发生：发生了照常回读核对，没发生才失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../chat-browser.mjs', import.meta.url), 'utf8');

test('发送点击超时但已真实发出：不当失败，继续回读核对', () => {
  assert.match(src, /try \{ await send\.click\(\{ timeout: 2000, noWaitAfter: true \}\); \}\s*catch \(error\) \{ if \(!await inputDispatched\(\)\.catch\(\(\) => false\)\) throw error; \}/);
  // 之后照旧：没有真实发送输入就报需要核对；有就进回读循环，不重发
  const after = src.slice(src.indexOf('catch (error) { if (!await inputDispatched()'));
  assert.ok(after.indexOf("if (!await inputDispatched()) throw new Error('没有核对到真实发送输入") < after.indexOf('for (let attempt = 0; attempt < 20'));
  assert.equal((src.match(/await send\.click\(\{ timeout: 2000/g) || []).length, 1, '只点一次');
});

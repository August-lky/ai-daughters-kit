// 抖音截图超时（2026-10-24）：点群友149晚弹出的标签页没关 → 插件的页被压到后台 → 截图一直超时。
// 以及 softpause 补丁的漏洞：暂时性错误没暂停也写 contact.paused，桥接误报「私信被暂停」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const browser = read('chat-browser.mjs');
const core = read('core.mjs');
const service = read('chat-service.mjs');

test('私信截图前先把这一页提到前面', () => {
  const i = browser.indexOf('await page.bringToFront?.()?.catch(() => {});');
  const shot = browser.indexOf("const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });");
  assert.ok(i > 0 && shot > i && shot - i < 400);
});

test('打开群友149后：已冒出来的弹窗关掉，15 秒内晚到的也关，最后把这一页提到前面', () => {
  const fin = browser.slice(browser.indexOf('if (popup) await popup.close().catch(() => {});'), browser.indexOf('  sendMessage(recipientId, message,'));
  assert.match(fin, /const closeStray = \(stray\) => \{ if \(stray !== page && !stray\.isClosed\(\)\) stray\.close\(\{ runBeforeUnload: false \}\)/);
  assert.match(fin, /other\.opener\(\)\.catch\(\(\) => null\) === page\) closeStray\(other\)/);
  assert.match(fin, /page\.on\('popup', closeStray\);\n\s+setTimeout\(\(\) => page\.off\('popup', closeStray\), 15000\)/);
  assert.match(fin, /await page\.bringToFront\?\.\(\)\?\.catch\(\(\) => \{\}\);\n\s+\}/);
});

test('刷视频采样截图前也提到前面', () => {
  assert.match(core, /await this\.page\.bringToFront\?\.\(\)\?\.catch\(\(\)=>\{\}\);\r?\n\s+\/\/ 采样保留动画和光标/);
});

test('软重试之后直接 continue，不再写 contact.paused', () => {
  const retry = service.indexOf("this.log('contact.retry'");
  const cont = service.indexOf('continue; // 2026-10-24：没暂停就别往下走', retry);
  const paused = service.indexOf("this.log('contact.paused'", retry);
  assert.ok(retry > 0 && cont > retry && cont < paused);
});

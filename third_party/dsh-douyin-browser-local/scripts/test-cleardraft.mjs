// 私信输入框被残留卡住（2026-10-24）：半句也认作自己的；认不出来的，她可以带 clearDraft 自己清空重发
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const src = read('chat-browser.mjs');
const start = src.indexOf('const readableDraft = ');
const end = src.indexOf('async function clearEditorByKeyboard');
const body = src.slice(start, end)
  .replace(/const OWN_DRAFTS_FILE = [^\n]*\n/, '')
  .replace(/const ownDrafts = [^\n]*\n/, 'const ownDrafts = new Set(OWN);\n')
  .replace(/const rememberOwnDraft = [\s\S]*?\n\};\n/, '');
const isOwnDraft = new Function('OWN', `${body}\nreturn isOwnDraft;`)(['沐姐姐，我这会儿才回你', '你在吃饭就好好吃，吃完去刷你的视频']);

test('整句、半句都认作插件自己的', () => {
  assert.equal(isOwnDraft('沐姐姐，我这会儿才回你'), true);
  assert.equal(isOwnDraft('沐姐姐，我这会'), true, '打字打到一半被切走');
  assert.equal(isOwnDraft('你在吃饭就好好吃'), true);
});

test('不是插件写过的不算', () => {
  assert.equal(isOwnDraft('老大手打的一句别的话'), false);
  assert.equal(isOwnDraft('你'), false, '一个字太短，不靠它判断');
});

test('认不出来时报错告诉她框里是什么、怎么清；带 clearDraft 就清', () => {
  assert.match(src, /if \(!clearDraft && \(hasMedia \|\| \(leftover && !isOwnDraft\(leftover\)\)\)\) throw new Error\(`当前会话输入框里已经有东西/);
  assert.match(src, /带 clearDraft:true 再发一次，会先清空/);
  assert.match(src, /authorize, clearDraft = false \} = \{\}\) \{/);
});

test('clearDraft 一路传到底：工具 → core → chat-service → chat-browser', () => {
  assert.match(read('tool-definitions.mjs'), /clearDraft: \{ type: 'boolean'/);
  assert.match(read('core.mjs'), /chat\.sendNow\(args\.recipientId, args\.message, \{signal, clearDraft: args\.clearDraft === true\}\)/);
  const service = read('chat-service.mjs');
  assert.match(service, /async sendNow\(recipientId, text, \{ signal, clearDraft = false \} = \{\}\)/);
  assert.match(service, /this\.browser\.sendMessage\(contact\.id, clean, \{ allowed: true, signal, clearDraft: clearDraft === true \}\)/);
});

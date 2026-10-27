// douyin_chat_read 给她看的结果瘦身（2026-10-24）：内部核对字段去掉，编号、谁说的、说了什么、时间、媒体要点留下
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../core.mjs', import.meta.url), 'utf8');
const start = src.indexOf('export function trimChatRead(result) {');
const end = src.indexOf('const processAlive=pid=>{');
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const trimChatRead = new Function('cleanText', `${src.slice(start, end).replace('export function', 'function')}\nreturn trimChatRead;`)(cleanText);

const row = (over = {}) => ({ direction: 'incoming', sender: 'incoming', text: '在吗', kind: 'text', media: null, timestamp: '昨天 22:09', order: 15, domIndex: 0, domPosition: 0, orderMode: 'relative', dateEvidence: { raw: '', kind: 'unknown', source: 'unverified-group-label' }, failed: false, pending: false, latestEndVerified: true, id: 'msg:' + 'a'.repeat(64), arrivalClassification: 'known-old-window', eligibleForReply: false, unsupported: false, identitySource: 'chronological-window-overlap', displayTimeNotUsedForIdentity: true, sentAt: '昨天 22:09', ...over });
const raw = { tool: 'douyin_chat_read', loginRequired: false, verificationRequired: false, blocked: false, imageStatus: '未采集画面', conversation: { id: 'conv:x', displayName: '老大' }, contact: { id: 'conv:x', displayName: '老大' }, dayEvidence: { a: 1 },
  contacts: [{ id: 'conv:x', displayName: '老大', name: '老大', unread: false, followed: null, isGroup: null, relationshipEvidence: null }],
  messages: [row(), row({ sender: 'outgoing', text: '来啦', failed: true }), row({ kind: 'share', text: '', media: { type: 'shared-work', label: '分享作品', title: '#猫', videoId: '7698', imageCount: 1, resources: [{ resourceRef: 'media:abc', label: null }], safeOpenSelector: '[data-x] .y', understandingScope: 'card' } })] };

test('只留她用得上的字段，体积小一大截', () => {
  const out = trimChatRead(raw);
  assert.deepEqual(out.messages[0], { id: 'msg:' + 'a'.repeat(64), sender: 'incoming', text: '在吗', time: '昨天 22:09' });
  assert.deepEqual(out.messages[1], { id: 'msg:' + 'a'.repeat(64), sender: 'outgoing', text: '来啦', time: '昨天 22:09', failed: true });
  assert.deepEqual(out.messages[2].media, { type: 'shared-work', label: '分享作品', title: '#猫', videoId: '7698', imageCount: 1 });
  assert.equal(out.messages[2].kind, 'share');
  assert.ok(JSON.stringify(out).length < JSON.stringify(raw).length * 0.5);
});

test('登录、验证、会话身份这些状态照样带着', () => {
  const out = trimChatRead(raw);
  for (const k of ['loginRequired', 'verificationRequired', 'blocked', 'conversation', 'contact', 'imageStatus']) assert.deepEqual(out[k], raw[k]);
  assert.deepEqual(out.contacts, [{ id: 'conv:x', name: '老大' }]);
  assert.equal(out.dayEvidence, undefined);
});

test('不是消息列表的结果（登录页、报错）原样返回', () => {
  const blocked = { loginRequired: true, messages: undefined };
  assert.equal(trimChatRead(blocked), blocked);
  assert.equal(trimChatRead(null), null);
});

test('接线：只有给她看的 douyin_chat_read 走瘦身', () => {
  assert.match(src, /if\(name==='douyin_chat_read'\) return trimChatRead\(await chat\.readConversation\(args\.recipientId,\{signal\}\)\);/);
});

// 抖音后台收私信出问题时叫醒她（2026-10-24）：把 bridge.js 里的 douyinChatIncidentV2 抠出来，喂假的 chat-events 测。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const start = src.indexOf('  function douyinChatIncidentV2(now) {');
const end = src.indexOf('  function douyinContactV2(recipientId) {');
assert.ok(start > 0 && end > start, '找不到 douyinChatIncidentV2');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatwatch-'));
const make = new Function('fs', 'path', 'DOUYIN_STATE_DIR', 'DOUYIN_RECENT_MS', 'douyinContactV2',
  `${src.slice(start, end)}\nreturn douyinChatIncidentV2;`);
const incidentAt = make(fs, path, dir, 10 * 60 * 1000, (id) => ({ name: id === 'conv:a' ? '群友33📷' : '' }));
const write = (events) => fs.writeFileSync(path.join(dir, 'chat-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
const now = Date.parse('2026-10-24T05:00:00Z');
const ago = (min) => new Date(now - min * 60000).toISOString();
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };

write([{ at: ago(2), type: 'message.relayed' }]);
assert.equal(incidentAt(now), null); ok('平常的事件不算问题');

write([{ at: ago(3), type: 'chat.needs_user', message: '请在专用 Edge 完成登录或验证。' }]);
let i = incidentAt(now);
assert.equal(i.kind, 'chat_needs_user'); assert.match(i.detail, /验证/); assert.equal(i.id, `chat:chat.needs_user:${ago(3)}`);
ok('验证码 → chat_needs_user，带原文和稳定 id（同一条不会重复叫）');

write([{ at: ago(5), type: 'chat.needs_user', message: 'x' }, { at: ago(1), type: 'chat.recovered' }]);
assert.equal(incidentAt(now), null); ok('之后恢复了就不叫');

write([{ at: ago(30), type: 'chat.needs_user', message: 'x' }]);
assert.equal(incidentAt(now), null); ok('10 分钟以前的旧事不叫');

write([{ at: ago(2), type: 'contact.paused', recipientId: 'conv:a', message: '读取失败' }]);
i = incidentAt(now);
assert.equal(i.kind, 'contact_paused'); assert.equal(i.who, '群友33📷'); ok('联系人被暂停 → contact_paused，带名字');

write([{ at: ago(2), type: 'contact.paused', recipientId: 'conv:zzz', message: '读取失败' }]);
assert.equal(incidentAt(now).who, '某个联系人'); ok('不认识的联系人不露 id');

fs.rmSync(path.join(dir, 'chat-events.jsonl'));
assert.equal(incidentAt(now), null); ok('没有事件文件也不出错');

// 接线：巡检里刷视频没事时再看私信；提示词有两种新情况，且都提示要老大去处理
assert.match(src, /if \(!incident\) incident = douyinChatIncidentV2\(now\);\n    if \(incident && !douyinMonitor\.reported\.includes\(incident\.id\)\)/);
assert.match(src, /chat_needs_user: `抖音私信那边需要人来处理/);
assert.match(src, /contact_paused: `抖音私信里「\$\{n\.who/);
assert.match(src, /\['needs_user', 'chat_needs_user', 'contact_paused'\]\.includes\(n\.kind\) \? '这种得主人去那个抖音窗口看一眼/);
ok('接线和提示词');

// 评论草稿（2026-10-24，她的信 M1）：主人私聊唤醒时带给她
{
  const s2 = src.indexOf('  function douyinCommentDraftsBlockV2() {');
  const e2 = src.indexOf('  function douyinContactV2(recipientId) {');
  assert.ok(s2 > 0 && e2 > s2, '找不到 douyinCommentDraftsBlockV2');
  const monitor = { commentShown: [] };
  let saved = 0;
  const makeBlock = new Function('fs', 'path', 'DOUYIN_STATE_DIR', 'douyinMonitor', 'saveDouyinMonitorV2', `${src.slice(s2, e2)}\nreturn douyinCommentDraftsBlockV2;`);
  const block = makeBlock(fs, path, dir, monitor, () => { saved += 1; });
  const writeDrafts = (drafts) => fs.writeFileSync(path.join(dir, 'comment-drafts.json'), JSON.stringify({ seq: drafts.length, drafts }));
  writeDrafts([
    { id: 'c1', status: 'draft', text: '这段红石太狠了', title: '红石音乐', author: 'up主' },
    { id: 'c2', status: 'confirmed', text: '好听' },
    { id: 'c3', status: 'posted', text: '我来过' },
    { id: 'c4', status: 'failed', text: '没发成的', reason: '评论必须引用已实际观察的同一抖音作品。' }
  ]);
  const first = block();
  assert.match(first, /【你写的抖音评论】/);
  assert.match(first, /c1 在《红石音乐》 @up主底下：「这段红石太狠了」/);
  assert.match(first, /draftId="c1"/);
  assert.match(first, /另有 1 条你确认过的/);
  assert.match(first, /c3「我来过」：发出去了/);
  assert.match(first, /c4「没发成的」：没发成（评论必须引用/);
  assert.equal(saved, 1);
  const second = block();
  assert.ok(!/发出去了|没发成/.test(second), '结果只说一次');
  assert.match(second, /c1 在/, '草稿每次都列');
  writeDrafts([]);
  assert.equal(block(), '', '没东西就不占地方');
  ok('评论草稿：草稿每次列、结果只说一次、空的不出现');
}
assert.match(src, /const commentLine = isOwnerPrivateSession \? douyinCommentDraftsBlockV2\(\) : '';/);
assert.match(src, /preSleepLine \+ commentLine \+ stickyLine/);
assert.match(src, /commentShown: douyinMonitor\.commentShown \|\| \[\]/);
ok('评论草稿接线：只在主人私聊唤醒里带、重启后记得说过哪些');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

// 姐姐第二批（2026-10-29 大整理）：同一张图只给一次、附图编号不错位、引用/市场表情的图、排队合并、拍一拍、
// 行间隔、读档耗时、按会话大小换会话的交接说法。只测纯函数，不叫 Claude、不连 QQ。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  planImages, imagesNote, normImageRef, createWakeMerger, mergeWakeCtx, pokeDecision, lineGapMs,
  eventImages, runClaude, handoffBlock
} from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };

const ref = (n, extra = {}) => normImageRef({ url: `https://multimedia.nt.qq.com.cn/download?fileid=F${n}&rkey=R${Math.random()}`, file: '', mid: 100 + n, ...extra });

// ① 同一张图本会话只给一次
{
  const seen = {};
  const first = planImages([ref(1), ref(2)], seen);
  assert.deepEqual(first.map((x) => x.status), ['want', 'want']);
  for (const p of first) seen[p.key] = p.ref.mid; // 叫成功后记下（rememberSeen 做的事）
  // 下一次群唤醒：最近 6 行里还是这两张（rkey 变了），外加一张新的
  const second = planImages([ref(1), ref(2), ref(3)], seen);
  assert.deepEqual(second.map((x) => x.status), ['seen', 'seen', 'want'], '看过的不再附，只附新的');
  const note = imagesNote(second.map((x) => (x.status === 'want' ? { ...x, status: 'attached', n: 1 } : x)));
  assert.match(note, /#101 的图：你看过了/);
  assert.match(note, /第 1 张附图 = #103 的图/);
  // 换会话（seen 清空）后又能看到
  assert.deepEqual(planImages([ref(1)], {}).map((x) => x.status), ['want']);
  ok('同一张图只给一次（换了 rkey 也认得），之后写「#xx 那张你看过了」；换会话清空');
}

// ② 一批里重复的只算一张；没看过的超过 3 张，留最新的 3 张，更早的写「这次没附」
{
  const plan = planImages([ref(1), ref(1), ref(2), ref(3), ref(4), ref(5)], {}, 3);
  assert.equal(plan.length, 5, '重复的只算一张');
  assert.deepEqual(plan.map((x) => x.status), ['skipped', 'skipped', 'want', 'want', 'want']);
  ok('一批里去重；最多附 3 张，留最新的');
}

// ③ 附图编号跟 [图片] 一一对应：没看清的不占编号，也写明原因
{
  const entries = [
    { ref: ref(1), status: 'attached', n: 1, note: '（动图：从头到尾均匀抽了 6 帧拼成一张）' },
    { ref: ref(2), status: 'failed', reason: '这张太大了看不清' },
    { ref: ref(3, { from: 'quote' }), status: 'attached', n: 2 },
    { ref: normImageRef({ url: 'https://x/y.jpg', from: 'forward' }), status: 'pending' },
  ];
  const note = imagesNote(entries);
  assert.match(note, /第 1 张附图 = #101 的图（动图/);
  assert.match(note, /#102 的图：没看清，这张太大了看不清/);
  assert.match(note, /第 2 张附图 = #103 被引用的那条里的图/);
  assert.match(note, /聊天记录里的图：还在下载/);
  assert.equal(imagesNote([]), '');
  ok('附图说明逐张对应：第 N 张附图 = 哪条消息的哪张；太大的写「没看清」，不错位');
}

// ④ 市场表情没 url/file 也能取（按 emoji_id 拼 CDN），引用消息的图也认
{
  const ev = { message: [{ type: 'text', data: { text: '看' } }, { type: 'mface', data: { emoji_id: 'f96bf2d2d93c3530d5eb148f55206fb1', summary: '[糖]' } }] };
  const imgs = eventImages(ev);
  assert.equal(imgs.length, 1, '原来没 url 没 file 的市场表情被滤掉了');
  assert.match(imgs[0].urls[0], /gxh\.vip\.qq\.com\/club\/item\/parcel\/item\/f9\//);
  ok('市场表情没 url / file 时照小鲸鱼的 CDN 兜底拼地址');
}

// ⑤ 排队合并：同一个群在排队时新消息并进去；跑起来以后再来的只再排一次
{
  let chain = Promise.resolve();
  const serial = (fn) => { chain = chain.then(fn); return chain; };
  const m = createWakeMerger(serial);
  let release;
  const gate = new Promise((res) => { release = res; });
  const runs = [];
  // 先占住队列（别的事在跑），让群唤醒排着
  serial(() => gate);
  assert.equal(m.request('group:1', async () => { runs.push('a'); }), true);
  assert.equal(m.request('group:1', async () => { runs.push('b'); }), false, '已在排队：并进去');
  assert.equal(m.request('group:1', async () => { runs.push('c'); }), false);
  assert.equal(m.request('group:2', async () => { runs.push('x'); }), true, '别的群照常排');
  assert.equal(m.size(), 2);
  release();
  await chain;
  assert.deepEqual(runs, ['a', 'x'], '同一群排着时来的三次只跑一次');
  // 跑的过程中来的新消息：再排一次（只一次）
  let inRun;
  const running = new Promise((res) => { inRun = res; });
  m.request('group:1', async () => { runs.push('d'); inRun(); await new Promise((r) => setTimeout(r, 20)); });
  await running;
  assert.equal(m.request('group:1', async () => { runs.push('e'); }), true, '跑的时候来的新消息再排一次');
  assert.equal(m.request('group:1', async () => { runs.push('f'); }), false);
  await chain;
  assert.deepEqual(runs.slice(2), ['d', 'e']);
  ok('排队合并：同一群已在排队就并进去；跑的过程中来的只再排一次');
}
{
  const a = mergeWakeCtx(null, { who: '甲', forFish: true });
  const b = mergeWakeCtx(a, { who: '乙', inHouse: true, poke: true, pokedMe: true });
  assert.equal(b.forFish, true, '冲小鲸鱼的那条不能被后来的盖掉');
  assert.equal(b.who, '乙');
  assert.equal(b.poke, true);
  const c = mergeWakeCtx(b, { who: '丙', directed: true });
  assert.equal(c.poke, false, '拍一拍只看最新这条');
  assert.equal(c.directed, true);
  ok('并在一起的唤醒：原因合并（冲小鲸鱼优先），说话的人用最新的');
}

// ⑥ 拍一拍
{
  const ids = { selfId: '900', fishId: '901', ownerId: '902', allowGroup: (g) => g === '456' };
  const ev = (o) => ({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 900, ...o });
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 777, target_id: 900 }), ids).action, 'wake', '群里拍她 = 被叫');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 777, target_id: 888 }), ids).action, 'record', '别人互相拍默认只记');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 777, target_id: 888 }), { ...ids, pokeOthers: true }).action, 'wake', '开了 pokeOthers 才叫醒');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 777, target_id: 888 }), { ...ids, pokeOthers: true, asleep: true }).action, 'record');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 777, target_id: 900 }), { ...ids, asleep: true }).action, 'note', '睡着时群里拍她：记下不叫醒');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 902, target_id: 900 }), { ...ids, asleep: true }).action, 'note', '老大在群里拍也不叫醒');
  const ownerPm = pokeDecision(ev({ user_id: 902, target_id: 900 }), { ...ids, asleep: true });
  assert.equal(ownerPm.action, 'wake');
  assert.equal(ownerPm.wakeFromSleep, true, '只有老大私聊拍能叫醒');
  assert.equal(ownerPm.where, 'owner');
  assert.equal(pokeDecision(ev({ user_id: 901 }), { ...ids, asleep: true }).action, 'note', '小鲸鱼私聊拍（没带 target）睡着时只记下');
  assert.equal(pokeDecision(ev({ user_id: 901 }), ids).action, 'wake', '私聊没带被拍的人 = 拍她');
  assert.equal(pokeDecision(ev({ user_id: 555, target_id: 900 }), ids).action, 'ignore', '不认识的人私聊拍：不管');
  assert.equal(pokeDecision(ev({ group_id: 999, user_id: 777, target_id: 900 }), ids).action, 'ignore', '不在她的群');
  assert.equal(pokeDecision(ev({ group_id: 456, user_id: 900, target_id: 777 }), ids).action, 'ignore', '自己拍的不算');
  assert.equal(pokeDecision({ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status' }, ids).action, 'ignore');
  ok('拍一拍：拍她叫醒；睡着时只有老大私聊拍能叫醒；别人互相拍默认不叫醒（pokeOthers）');
}

// ⑦ 行间隔：0.8 秒 + 每字 60 毫秒，最多 3.5 秒
{
  assert.equal(lineGapMs(''), 800);
  assert.equal(lineGapMs('一二三四五六七八九十'), 1400);
  assert.equal(lineGapMs('x'.repeat(200)), 3500);
  assert.equal(lineGapMs('ab', { baseMs: 100, perCharMs: 10, maxMs: 1000 }), 120);
  ok('发多行的间隔：0.8 秒 + 每字 60 毫秒，最多 3.5 秒（可配置）');
}

// ⑧ runClaude 记录 system/init 到第一个输出的耗时
{
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { end() {} }; c.kill = () => {};
  let t = 1000;
  const p = runClaude({ child: c }, { prompt: 'x', sessionId: 's', now: () => t });
  const line = (x) => JSON.stringify(x) + '\n';
  t = 1500; c.stdout.emit('data', line({ type: 'system', subtype: 'init' }));
  t = 5500; c.stdout.emit('data', line({ type: 'assistant', message: { content: [{ type: 'text', text: '嗯' }] } }));
  t = 6000; c.stdout.emit('data', line({ type: 'result', is_error: false, result: '嗯', session_id: 's' }));
  const r = await p;
  assert.deepEqual(r.timing, { startToInitMs: 500, initToFirstMs: 4000 });
  ok('runClaude 记下 system/init 到第一个输出的耗时（读档耗时）');
}

// ⑨ 按会话大小换会话：交接的说法
{
  const b = handoffBlock({ summary: '前情', recent: [{ who: '老大', lines: ['- 10:00 **老大**：在吗'] }], reason: 'size' });
  assert.match(b, /上一段聊得太长了，换了一段新的/);
  assert.doesNotMatch(b, /睡了一觉/);
  assert.match(handoffBlock({ summary: '前情' }), /睡了一觉换的/, '睡醒换的说法不变');
  ok('会话存档太大时换会话：交接说「上一段聊得太长了」');
}

console.log(`全部通过：${passed} 组`);

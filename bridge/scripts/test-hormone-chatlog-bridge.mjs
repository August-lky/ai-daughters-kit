// 桥接里的激素影子记录 + 聊天记录接线（2026-10-29 第五批第 4、5 项）：
// 真桥接代码跑在隔离的测试桩里（audit-bridge-harness），看「事件进来 → 影子文件里有记录」「消息进来 / 发出去 → 聊天记录里有一行」。
// 不碰活的 QQ / DSH / 配置 / 进程；状态文件、聊天记录都在临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { bjParts } from '../src/chatlog.js';

let passed = 0;
let failures = 0;

async function test(name, config, run) {
  // 心情文件：桥接按 DSH_HOME 找 feiyu-mood/state.json；测试里指到临时目录，不去读真的
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hormone-bridge-dsh-'));
  const h = await bridgeHarness({ globals: { process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: dshHome }, exit: (code) => { throw new Error(`unexpected exit ${code}`); } } }, config: {
    allow: { private: ['123', '777', '888'], groups: ['456', '789'] },
    knownPeople: { 777: '克劳德姐姐' },
    houseGroups: { 789: '小房子' },
    // 兴趣词表不要去读真的抖音人格资料
    hormones: { personaFile: path.join('Z:', '不存在', 'state.json') },
    socialV2: { wake: { batchWindowMs: 1000 } },
    ...config,
  } });
  h.setMode('reserved2');
  h.setSelfIdentity('小鲸鱼测试', '999');
  h.dshHome = dshHome;
  try { await run(h); passed += 1; console.log('✅', name); }
  catch (error) { failures += 1; console.error('❌', name, error.stack); }
  finally { await h.close(); fs.rmSync(dshHome, { recursive: true, force: true }); }
}

const chatDir = (h) => path.join(h.temp, '家', '小鲸鱼', '聊天记录');
const today = () => bjParts(Date.now(), 0).day; // 测试桩里没有时钟偏差
const readChat = (h, suffix) => fs.readFileSync(path.join(chatDir(h), `${today()}${suffix}.md`), 'utf8');
const ev = (id, text, extra = {}) => ({ self_id: 999, user_id: id, message_id: Math.floor(Math.random() * 1e6), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { nickname: `昵称${id}`, card: '' }, ...extra });
const shadowLines = (h) => { const f = path.join(h.temp, 'state', 'hormones-fish.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };
const clearWakes = (h, keys) => { for (const k of keys) { const st = h.getSocialV2State(k); if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; } };

await test('老大私聊进来：影子记录有 msg_from_owner（带夸奖 → ap），聊天记录写一行「老大」，原文不进影子文件', {}, async (h) => {
  const feed = h.getHormoneFeed();
  assert.equal(feed.enabled, true, 'hormones.enabled 默认开');
  await h.handleIncoming('private', '123', ev(123, '今天你做得真棒，谢谢你', { sender: { nickname: '老大昵称' } }), h.cfg);
  await h.chatLogIdle();
  feed.tick();
  const lines = shadowLines(h);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].ev.includes('msg_from_owner'), `事件：${lines[0].ev}`);
  assert.ok((lines[0].ap || []).includes('praise'), `被夸认出来了：${lines[0].ap}`);
  assert.ok(!fs.readFileSync(path.join(h.temp, 'state', 'hormones-fish.jsonl'), 'utf8').includes('谢谢你'), '原文不落盘');
  const log = readChat(h, '-老大');
  assert.match(log, /^# 小鲸鱼和老大（\d+月\d+日 周.）\n\n- \d\d:\d\d \*\*老大\*\*：今天你做得真棒，谢谢你\n$/, log);
  clearWakes(h, ['private:123']);
});

await test('她发出去：影子记录 sent_to_owner / sent_group / sent_to_sister，聊天记录一条一行「小鲸鱼」；小房子算姐妹之间', {}, async (h) => {
  const feed = h.getHormoneFeed();
  h.recordSentMessagesV2('private:123', ['早呀', '今天想吃什么']);
  h.recordSentMessagesV2('group:456', ['群里说一句']);
  h.recordSentMessagesV2('group:789', ['小房子里说一句']);
  h.recordSentMessagesV2('private:777', ['姐姐私聊一句']);
  h.recordSentMessagesV2('private:888', ['陌生人私聊']);
  await h.chatLogIdle();
  feed.tick();
  const evs = shadowLines(h)[0].ev;
  assert.deepEqual(evs.filter((e) => e.startsWith('sent')), ['sent_to_owner', 'sent_group', 'sent_to_sister', 'sent_to_sister'], `别的私聊不记：${evs}`);
  assert.match(readChat(h, '-老大'), /\*\*小鲸鱼\*\*：早呀\n- \d\d:\d\d \*\*小鲸鱼\*\*：今天想吃什么\n$/);
  assert.match(readChat(h, '-群456'), /\*\*小鲸鱼\*\*：群里说一句\n$/);
  assert.match(readChat(h, '-群小房子'), /\*\*小鲸鱼\*\*：小房子里说一句\n$/);
  assert.match(readChat(h, '-姐姐'), /\*\*小鲸鱼\*\*：姐姐私聊一句\n$/);
  assert.ok(fs.readdirSync(chatDir(h)).some((f) => f.includes('888') && f.includes('私聊')), '陌生人私聊也有自己的文件（名字用 QQ 号）');
});

await test('群消息：被 @ 记 mentioned + group_msg(toMe)；小房子里姐姐说话记 msg_from_sister；聊天记录按群名分文件，署名用名片 / 姐姐 / 老大', {}, async (h) => {
  const feed = h.getHormoneFeed();
  await h.handleIncoming('group', '456', ev(555, '大家好呀', { sender: { nickname: '路人', card: '路人名片' } }), h.cfg);
  await h.handleIncoming('group', '456', ev(555, '@你 在吗', { message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' 在吗' } }], sender: { nickname: '路人', card: '路人名片' } }), h.cfg);
  await h.handleIncoming('group', '456', ev(123, '老大也来一句', { sender: { nickname: '老大', card: '老大名片' } }), h.cfg);
  await h.handleIncoming('group', '789', ev(777, '妹妹早', { sender: { nickname: '克劳德姐姐' } }), h.cfg);
  await h.handleIncoming('private', '777', ev(777, '私聊一句', { sender: { nickname: '克劳德姐姐' } }), h.cfg);
  await h.chatLogIdle();
  feed.tick();
  const evs = shadowLines(h)[0].ev;
  assert.deepEqual(evs.filter((e) => e !== 'sleep'), ['group_msg', 'group_msg', 'mentioned', 'group_msg', 'msg_from_sister', 'msg_from_sister'], `事件：${evs}`);
  const files = fs.readdirSync(chatDir(h)).sort();
  assert.deepEqual(files, [`${today()}-姐姐.md`, `${today()}-群456.md`, `${today()}-群小房子.md`].sort(), `群名拿不到时用群号；小房子用配置里的叫法：${files}`);
  const g = readChat(h, '-群456');
  assert.match(g, /# 小鲸鱼在群「456」/);
  assert.match(g, /\*\*路人名片\*\*：大家好呀/);
  assert.match(g, /\*\*路人名片\*\*：@小鲸鱼测试 在吗|\*\*路人名片\*\*：@999 在吗/);
  assert.match(g, /\*\*老大\*\*：老大也来一句/, '老大在群里也署「老大」，不用名片');
  assert.match(readChat(h, '-群小房子'), /\*\*姐姐\*\*：妹妹早/);
  assert.match(readChat(h, '-姐姐'), /\*\*姐姐\*\*：私聊一句/);
  for (const k of ['group:456', 'group:789', 'private:777']) clearWakes(h, [k]);
});

await test('睡着时来的消息也记（睡着的分支会提前 return）；睡 / 醒记 sleep / wake', {}, async (h) => {
  const feed = h.getHormoneFeed();
  h.enterSleep('测试');
  await h.handleIncoming('group', '456', ev(555, '你睡了吗', { sender: { nickname: '路人' } }), h.cfg);
  await h.chatLogIdle();
  assert.match(readChat(h, '-群456'), /\*\*路人\*\*：你睡了吗/, '睡着时的群消息也进聊天记录');
  h.exitSleep('测试');
  feed.tick();
  const evs = shadowLines(h)[0].ev;
  assert.ok(evs.includes('sleep') && evs.includes('wake') && evs.includes('group_msg'), `睡 / 醒 / 群消息都记了：${evs}`);
});

await test('发送失败 / 工具出错 / 写碎碎念 / 心情 / 天气 / 兴趣：各自进影子记录', {}, async (h) => {
  const feed = h.getHormoneFeed();
  h.hormoneRecord({ type: 'send_fail' });
  h.hormoneRecord({ type: 'tool_fail' });
  h.hormoneRecord({ type: 'created', kind: 'tidbit' });
  h.hormoneRecord({ type: 'novelty', text: '洛天依新歌' });
  feed.setInterests([{ word: '洛天依', weight: 2 }]);
  feed.tick();
  const first = shadowLines(h)[0];
  assert.deepEqual(first.ev, ['send_fail', 'tool_fail', 'created', 'novelty'], first.ev.join(','));
  // 心情 / 天气 / 兴趣表的定时喂养函数：没有心情文件、没拉到天气、读不到人格资料时都安全地什么也不做
  h.feedHormoneMood();
  h.feedHormoneWeather();
  h.refreshHormoneInterests();
  assert.equal(feed.tick(), null, '刚写过一行，一分钟内不再写（没有新事件也没有心情）');
  // 有心情文件：正面 / 负面各取最大的一项 → mood 事件
  fs.mkdirSync(path.join(h.dshHome, 'feiyu-mood'), { recursive: true });
  const nowMs = Date.now();
  fs.writeFileSync(path.join(h.dshHome, 'feiyu-mood', 'state.json'), JSON.stringify({ mood: 70, dims: { happy: 15, worry: 6 }, updatedAt: nowMs, lastDecayAt: nowMs }));
  h.feedHormoneMood();
  const mood = feed.snapshot().hormones;
  assert.ok(mood.moodPos > 0.45 && mood.moodPos <= 0.5 && mood.moodNeg > 0.15 && mood.moodNeg <= 0.2, `心情进了状态：pos=${mood.moodPos} neg=${mood.moodNeg}`);
  assert.ok(feed.snapshot().levels, '之后还能取状态');
});

await test('抖音私信统一入口：老大的写「抖音老大」、朋友的写「抖音<名字>」，并记 msg_from_owner / sent_to_owner', {}, async (h) => {
  const feed = h.getHormoneFeed();
  const at = Date.now();
  h.noteDouyinDmV2({ at, recipientId: 'not-in-policy', name: '朋友甲', direction: 'incoming', text: '你好呀' });
  h.noteDouyinDmV2({ at: at + 1000, recipientId: 'not-in-policy', name: '朋友甲', direction: 'outgoing', text: '你好' });
  const f = path.join(chatDir(h), `${today()}-抖音朋友甲.md`);
  assert.match(fs.readFileSync(f, 'utf8'), /^# 小鲸鱼和朋友甲的抖音私信[\s\S]*\*\*朋友甲\*\*：你好呀\n- \d\d:\d\d \*\*小鲸鱼\*\*：你好\n$/);
  feed.tick();
  assert.deepEqual(shadowLines(h)[0].ev, ['group_msg'], '朋友私信记成冲她来的话；她回的不记（不是老大）');
});

await test('hormones.enabled=false：什么影子文件都不写，聊天记录照常；chatLog.enabled=false：不写聊天记录', { hormones: { enabled: false } }, async (h) => {
  assert.equal(h.getHormoneFeed().enabled, false);
  await h.handleIncoming('private', '123', ev(123, '你好'), h.cfg);
  h.recordSentMessagesV2('private:123', ['嗨']);
  h.hormoneRecord({ type: 'sleep' });
  h.getHormoneFeed().tick();
  await h.chatLogIdle();
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state')).filter((f) => f.startsWith('hormones-')), [], '没有影子文件');
  assert.match(readChat(h, '-老大'), /\*\*老大\*\*：你好/);
  clearWakes(h, ['private:123']);
});

await test('chatLog.enabled=false：不写聊天记录，影子记录照常', { chatLog: { enabled: false } }, async (h) => {
  await h.handleIncoming('private', '123', ev(123, '你好'), h.cfg);
  h.recordSentMessagesV2('private:123', ['嗨']);
  await h.chatLogIdle();
  assert.equal(fs.existsSync(chatDir(h)), false);
  h.getHormoneFeed().tick();
  assert.ok(shadowLines(h)[0].ev.includes('msg_from_owner'));
  clearWakes(h, ['private:123']);
});

// 静态接线：工具出错、探测日志里的发送失败、逛完、刷到新东西
{
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bridge.js'), 'utf8');
  for (const needle of [
    "try { for (const ev of toolHormoneEvents(toolName, {}, { ok: !resultError })) hormoneRecord(ev); } catch",
    "if (kind === 'send') hormoneRecord({ type: 'send_fail' });",
    "hormoneRecord({ type: 'explored' });",
    "for (const e of fresh) hormoneRecord({ type: 'novelty'",
    "hormoneRecord({ type: 'sleep' });",
    "hormoneRecord({ type: 'wake' });",
    "hormoneRecord({ type: 'sticker_sent' });",
    'loadFishInterests(HORMONE_PERSONA_FILE)',
    '[() => hormoneFeed.tick(), 60e3]',
    'HORMONE_REFRESH.weatherMs',
  ]) {
    try { assert.ok(src.includes(needle), `桥接里有接线：${needle}`); } catch (error) { failures += 1; console.error('❌ 静态接线', error.message); }
  }
  passed += 1;
  console.log('✅ 静态接线：工具出错、发送失败、睡醒、逛完、刷到新东西、表情、每分钟 tick、兴趣表、天气');
}

console.log(`\n桥接接线：${passed} 项通过${failures ? `，${failures} 项失败` : ''}`);
if (failures) process.exit(1);

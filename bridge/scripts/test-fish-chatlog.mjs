// 小鲸鱼的聊天记录（2026-10-29 第五批第 5 项；老大：「给妹妹也做成一样吧」）：
// 写入格式（跟姐姐的 sister/聊天记录 一样）、北京时间（本机时钟快约 3 小时）、去重、补旧用的 zstd 分段解码、
// 补旧脚本整条链路（用造出来的会话存档，不碰真的）。全在临时目录里，不碰活的东西。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  bjParts, chatLogFileName, chatLogHeader, chatLogLine, createChatLog, parseChatLogLine, pickGroupName, safeName, sessionInfo, sisterGroupNames, whoLabel,
} from '../src/chatlog.js';
import {
  ZSTD_MAGIC, buildChatLogRows, decodeZstdFrames, decodeZstdLines, douyinRows, extractSessionChat, mergeFileMaps, mergeRows, parseChatLogFile, writeChatLogs, zstdFrameStarts,
} from '../src/chatlog-backfill.js';
import { runBackfill } from './backfill-fish-chatlog.mjs';
import { createBrains } from '../src/brains.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fish-chatlog-'));
const SKEW = 10_790_329; // 本机比真实时间快的毫秒数（state/clock-skew.json 里的量级）

// ① 北京时间：本机时钟快 3 小时，扣掉再换；跨午夜时日期跟着变
{
  // 真实北京时间 2026-10-26 23:50 周一 = UTC 15:50；本机显示快 3 小时 → 本机毫秒对应 2026-10-27 02:50 北京
  const real = Date.parse('2026-10-26T15:50:00Z');
  const p = bjParts(real + SKEW, SKEW);
  assert.deepEqual({ day: p.day, hm: p.hm, wd: p.wd, month: p.month, date: p.date }, { day: '2026-10-26', hm: '23:50', wd: '一', month: 10, date: 26 });
  assert.equal(bjParts(real + SKEW, 0).day, '2026-10-27', '不扣偏差就会算到第二天（这就是要扣的原因）');
  assert.equal(bjParts(Date.parse('2026-10-28T16:05:00Z'), 0).hm, '00:05', 'UTC 16:05 = 北京次日 00:05');
  assert.equal(bjParts(Date.parse('2026-10-25T00:00:00Z')).wd, '日', '周日');
  ok('北京时间：扣掉本机时钟偏差、跨午夜日期跟着变、星期对');
}

// ② 文件名、标题、行的格式（跟姐姐的一样）
{
  const info = (type, name) => sessionInfo({ type, name });
  assert.equal(chatLogFileName('2026-10-26', info('owner')), '2026-10-26-老大.md');
  assert.equal(chatLogFileName('2026-10-26', info('sister')), '2026-10-26-姐姐.md');
  assert.equal(chatLogFileName('2026-10-26', info('group', '小房子')), '2026-10-26-群小房子.md');
  assert.equal(chatLogFileName('2026-10-26', info('friend', '阿花')), '2026-10-26-私聊阿花.md');
  assert.equal(chatLogFileName('2026-10-26', info('douyin-owner')), '2026-10-26-抖音老大.md');
  assert.equal(chatLogFileName('2026-10-26', info('douyin-friend', '阿花')), '2026-10-26-抖音阿花.md');
  assert.equal(chatLogFileName('2026-10-26', info('group', '大/肥:鱼*乐?园')), '2026-10-26-群群D.md', '文件名里不能有的字符去掉');
  assert.ok(!chatLogFileName('2026-10-26', info('friend', '阿花')).includes('-群'), '私聊的文件名里没有「-群」（索引靠这个认私聊）');
  assert.ok(chatLogFileName('2026-10-26', info('group', '小房子')).includes('-群'), '群聊的有');
  const parts = bjParts(Date.parse('2026-10-26T02:00:00Z'));
  assert.equal(chatLogHeader(info('owner'), parts), '# 小鲸鱼和老大（10月26日 周一）\n\n');
  assert.equal(chatLogHeader(info('group', '小房子'), parts), '# 小鲸鱼在群「小房子」（10月26日 周一）\n\n');
  assert.equal(chatLogLine('07:11', '小鲸鱼', '早，姐姐。'), '- 07:11 **小鲸鱼**：早，姐姐。');
  assert.equal(chatLogLine('07:11', '老大', '第一行\n\n第二行'), '- 07:11 **老大**：第一行 第二行', '换行压成空格');
  assert.equal(chatLogLine('07:11', '老大', '   \n '), '', '空消息不写');
  assert.ok(chatLogLine('07:11', '老大', 'x'.repeat(2000)).length < 900, '太长的截断');
  assert.equal(chatLogLine('07:11', '带**星号**的人', '嗨'), '- 07:11 **带星号的人**：嗨', '名字里的星号去掉，免得破坏格式');
  assert.deepEqual(parseChatLogLine('- 07:11 **小鲸鱼**：早，姐姐。'), { hm: '07:11', who: '小鲸鱼', text: '早，姐姐。' });
  assert.equal(parseChatLogLine('# 标题'), null);
  assert.equal(safeName('  a<b>c  '), 'abc');
  // 跟姐姐实际的文件格式一样（真的读一份姐姐的文件当样子）
  const sample = '- 07:11 **小鲸鱼**：早，姐姐。册子先摆出来：被算进「四大教主」的是《求与影》';
  assert.ok(parseChatLogLine(sample), '姐姐文件里的行也读得懂');
  ok('文件名 / 标题 / 行的格式跟姐姐的一样；私聊文件名没有「-群」；换行压平、空的不写、名字去星号');
}

// ③ 署名
{
  const known = { 777: '克劳德姐姐', 888: '阿花' };
  assert.equal(whoLabel({ isSelf: true }), '小鲸鱼');
  assert.equal(whoLabel({ isOwner: true, sender: '老大（群名片）' }), '老大');
  assert.equal(whoLabel({ userId: '777', sender: '私聊', knownPeople: known }), '姐姐');
  assert.equal(whoLabel({ userId: '888', sender: '谁', knownPeople: known }), '阿花');
  assert.equal(whoLabel({ userId: '1', sender: '群友119（不是你老大）' }), '群友119', '去掉桥接加的注释');
  assert.equal(whoLabel({ userId: '1', sender: '路人甲' }), '路人甲');
  assert.equal(whoLabel({ userId: '1', sender: '私聊' }), '1', '占位名退回 QQ 号');
  assert.equal(whoLabel({ key: 'private:123', ownerQQ: '123', sender: '私聊' }), '老大', '老大私聊里不是她说的就是老大说的');
  assert.equal(pickGroupName('456', { alias: '小房子', cached: 'x' }), '小房子');
  assert.equal(pickGroupName('456', { cached: '群D', sister: 'y' }), '群D');
  assert.equal(pickGroupName('456', { title: '标题' }), '标题');
  assert.equal(pickGroupName('456', {}), '456', '都没有就用群号');
  const d = tmp();
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify({ groupState: { 111: { name: '养鱼群' }, 222: { name: '222' } } }));
  assert.deepEqual(sisterGroupNames(path.join(d, 's.json')), { 111: '养鱼群' }, '姐姐记的群名（名字等于群号的不算）');
  assert.deepEqual(sisterGroupNames(path.join(d, '没有.json')), {});
  ok('署名：自己 / 老大 / 姐姐 / 认得的人 / 昵称（去注释）/ QQ 号；群名按「叫法 > 问到的 > 姐姐记的 > 标题 > 群号」');
}

// ④ 写入：建文件加标题、按北京日期分文件、同一会话追加、跨午夜换文件
{
  const dir = tmp();
  const log = createChatLog({ dir, skewMs: () => SKEW });
  const real = Date.parse('2026-10-26T15:50:00Z'); // 北京 23:50
  assert.equal(log.append({ session: { type: 'owner' }, who: '老大', text: '晚安', at: real + SKEW }).ok, true);
  assert.equal(log.append({ session: { type: 'owner' }, who: '小鲸鱼', text: '晚安，睡吧', at: real + SKEW + 5 * 60e3 }).ok, true); // 北京 23:55
  assert.equal(log.append({ session: { type: 'owner' }, who: '老大', text: '早', at: real + SKEW + 20 * 60e3 }).ok, true); // 北京次日 00:10
  assert.equal(log.append({ session: { type: 'group', name: '小房子' }, who: '姐姐', text: '嗨', at: real + SKEW }).ok, true);
  assert.equal(log.append({ session: { type: 'owner' }, who: '老大', text: '', at: real }).ok, false, '空的不写');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-26-群小房子.md', '2026-10-26-老大.md', '2026-10-27-老大.md']);
  assert.equal(fs.readFileSync(path.join(dir, '2026-10-26-老大.md'), 'utf8'), '# 小鲸鱼和老大（10月26日 周一）\n\n- 23:50 **老大**：晚安\n- 23:55 **小鲸鱼**：晚安，睡吧\n');
  assert.equal(fs.readFileSync(path.join(dir, '2026-10-27-老大.md'), 'utf8'), '# 小鲸鱼和老大（10月27日 周二）\n\n- 00:10 **老大**：早\n', '过了零点是新的一天、新的文件、新的标题');
  const bad = createChatLog({ dir: path.join(dir, '2026-10-26-老大.md', '不能建'), skewMs: () => 0, onError: () => {} });
  assert.equal(bad.append({ session: { type: 'owner' }, who: 'a', text: 'b' }).ok, false, '写不下来返回 ok:false，不抛');
  ok('写入：标题只写一次、追加、按北京日期分文件、跨午夜换新文件、空的不写、写不下来不抛');
}

// ⑤ zstd：多段拼接按段解（zlib 自己只会解第一段）
{
  const lines = (a, b) => `${Array.from({ length: b - a }, (_, i) => JSON.stringify({ type: 'x', n: a + i })).join('\n')}\n`;
  const f1 = zlib.zstdCompressSync(Buffer.from(lines(0, 3)));
  const f2 = zlib.zstdCompressSync(Buffer.from(lines(3, 6)));
  const f3 = zlib.zstdCompressSync(Buffer.from(lines(6, 9)));
  const all = Buffer.concat([f1, f2, f3]);
  const naive = zlib.zstdDecompressSync(all).toString('utf8').split('\n').filter(Boolean);
  assert.ok(naive.length < 9, `（确认前提）zlib 一次只解开第一段：${naive.length} 行`);
  assert.equal(zstdFrameStarts(all).length, 3);
  assert.deepEqual(decodeZstdLines(all).map((l) => JSON.parse(l).n), [0, 1, 2, 3, 4, 5, 6, 7, 8], '按段切开逐段解，一行不丢');
  // 坏段：夹一段垃圾（魔数开头但不是完整的段）→ 跳过，前后的照常解
  const junk = Buffer.concat([ZSTD_MAGIC, Buffer.from('这不是一段完整的 zstd')]);
  assert.deepEqual(decodeZstdLines(Buffer.concat([f1, junk, f3])).map((l) => JSON.parse(l).n), [0, 1, 2, 6, 7, 8], '坏段跳过');
  // 魔数恰好出现在一段的数据中间（不是段头）：并起来再解，不能把好段切坏
  const withMagic = Buffer.concat([Buffer.from('{"type":"y","t":"('), Buffer.from([0xb5, 0x2f, 0xfd]), Buffer.from('"}\n')]);
  const tricky = zlib.zstdCompressSync(Buffer.concat([withMagic, Buffer.from(lines(20, 22))]), { params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } });
  const withInner = tricky.indexOf(ZSTD_MAGIC, 4) !== -1;
  const whole = Buffer.concat([f1, tricky, f3]);
  const got = decodeZstdLines(whole).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(got.some((x) => x.n === 21) && got.some((x) => x.n === 0) && got.some((x) => x.n === 8), `段里夹着魔数也不丢（${withInner ? '确实夹了' : '这次压缩没把魔数原样留下，前提不成立但结果仍对'}）`);
  assert.deepEqual(decodeZstdFrames(Buffer.alloc(0)), [], '空文件');
  assert.deepEqual(decodeZstdFrames(Buffer.from('不是 zstd')), [], '不是 zstd');
  ok('zstd 多段拼接：按段解、坏段跳过、魔数落在段中间也不切坏');
}

// ⑥ 从存档里取聊天；去重；合进已有文件
const KEY_OWNER = 'private:123';
const KEY_GROUP = 'group:456';
const T0 = Date.parse('2026-10-26T04:00:00Z') + SKEW; // 北京 12:00（本机毫秒）
const snapshotMsg = (text, t, extra = {}) => ({ seq: 1, messageId: String(1000 + Math.floor((t - T0) / 1000)), sender: '私聊', userId: '123', text, time: t, ...extra });
const userMsg = (time, packet) => JSON.stringify({ type: 'user/message', seq: 1, time, data: { content: [{ type: 'text', text: `【当前时间】x\n【本次消息快照】\n${JSON.stringify(packet)}\n以上消息已提供` }] } });
const call = (time, callId, name, args) => JSON.stringify({ type: 'tool/call', time, data: { name, callId, arguments: JSON.stringify(args) } });
const result = (time, callId, text, isError = false) => JSON.stringify({ type: 'tool/result', time, data: { message: { toolCallId: callId, content: [{ type: 'text', text }], isError } } });
{
  const lines = [
    userMsg(T0, { messages: [snapshotMsg('早啊', T0, { isOwner: true })], recent: [{ sender: '我', text: '昨晚睡得好吗', isSelf: true, time: T0 - 60e3, messageId: 'm0' }], unreadCount: 1 }),
    call(T0 + 5e3, 'c1', 'mcp__x__qq_send_message', { key: KEY_OWNER, token: 'tok', messages: ['早，睡得很好', '你呢'] }),
    result(T0 + 6e3, 'c1', '{"ok":true}'),
    call(T0 + 20e3, 'c2', 'mcp__x__qq_send_message', { key: KEY_OWNER, token: 'tok', messages: ['这条没发出去'] }),
    result(T0 + 21e3, 'c2', '没发出去：风控', true),
    // 第二次唤醒的快照里又带了一遍同样的消息（要去重）
    userMsg(T0 + 600e3, { messages: [snapshotMsg('下午有空吗', T0 + 590e3, { isOwner: true })], recent: [snapshotMsg('早啊', T0, { isOwner: true }), { sender: '我', text: '早，睡得很好', isSelf: true, time: T0 + 7e3 }] }),
    call(T0 + 610e3, 'c3', 'mcp__x__qq_wait_for_messages', { key: KEY_OWNER }),
    result(T0 + 611e3, 'c3', JSON.stringify({ key: KEY_OWNER, newMessages: [snapshotMsg('晚上吃什么', T0 + 700e3, { isOwner: true })] })),
    call(T0 + 620e3, 'c4', 'mcp__x__qq_send_message', { key: KEY_GROUP, messages: '群里说一句' }),
    result(T0 + 621e3, 'c4', '{"ok":true}'),
    '不是 JSON 的坏行',
  ];
  const r = extractSessionChat(lines);
  assert.equal(r.key, KEY_OWNER, '没给 sessionKey 就取工具参数里最常出现的');
  assert.deepEqual(r.sent.map((x) => x.text), ['早，睡得很好', '你呢', '群里说一句'], '发出去的取工具参数里的原文，失败的不要');
  assert.equal(r.sent[2].key, KEY_GROUP);
  assert.ok(r.incoming.some((m) => m.text === '晚上吃什么'), '工具返回里的新消息也取');
  assert.equal(extractSessionChat(lines, { sessionKey: KEY_GROUP }).key, KEY_GROUP, '给了 sessionKey 以它为准');

  const items = [
    ...r.incoming.map((m) => ({ ...m, source: 'session' })),
    ...r.sent.map((m) => ({ ...m, isSelf: true, source: 'send' })),
    ...r.selfSeen.map((m) => ({ ...m, isSelf: true, source: 'seen' })),
  ];
  const files = buildChatLogRows(items, { skewMs: SKEW, ownerQQ: '123', knownPeople: {}, sessionOf: (k) => (k === KEY_OWNER ? { type: 'owner' } : { type: 'group', name: '小房子' }) });
  const owner = files.get('2026-10-26-老大.md');
  const texts = owner.rows.map((x) => `${x.hm} ${x.who}：${x.text}`);
  assert.deepEqual(texts, [
    '11:59 小鲸鱼：昨晚睡得好吗',
    '12:00 老大：早啊',
    '12:00 小鲸鱼：早，睡得很好',
    '12:00 小鲸鱼：你呢',
    '12:09 老大：下午有空吗',
    '12:11 老大：晚上吃什么',
  ], `北京时间、顺序对；快照里重复的「早啊」只留一条；快照里「我」说的「早，睡得很好」跟工具参数里的原文对上了不重复：\n${texts.join('\n')}`);
  assert.deepEqual(files.get('2026-10-26-群小房子.md').rows.map((x) => x.text), ['群里说一句']);

  // 合进已有文件：已有的不重复，缺的按时间插进去，反复跑结果不变
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-10-26-老大.md'), '# 小鲸鱼和老大（10月26日 周一）\n\n- 12:00 **老大**：早啊\n- 12:10 **老大**：下午有空吗\n- 12:30 **小鲸鱼**：现场写的一句\n');
  const rep1 = writeChatLogs(files, dir, { dryRun: true });
  assert.equal(rep1.added, 5, 'dry-run 只统计（老大文件 6 行里已有 2 行 → 加 4 行；加上群文件 1 行）');
  assert.equal(fs.readFileSync(path.join(dir, '2026-10-26-老大.md'), 'utf8').split('\n').length, 6, 'dry-run 什么都没改');
  assert.ok(!fs.existsSync(path.join(dir, '2026-10-26-群小房子.md')), 'dry-run 没建新文件');
  const rep2 = writeChatLogs(files, dir, { dryRun: false });
  assert.equal(rep2.added, 5);
  const merged = fs.readFileSync(path.join(dir, '2026-10-26-老大.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(merged.map((l) => l.slice(2, 7)), ['11:59', '12:00', '12:00', '12:00', '12:10', '12:11', '12:30'], '按时间插进去');
  assert.equal(merged.filter((l) => l.includes('早啊')).length, 1, '已有的「早啊」没重复');
  assert.equal(merged.filter((l) => l.includes('下午有空吗')).length, 1, '时间差 1 分钟以内算同一条');
  assert.ok(merged.some((l) => l.includes('现场写的一句')), '已有的行原样保留');
  assert.ok(fs.readFileSync(path.join(dir, '2026-10-26-老大.md'), 'utf8').startsWith('# 小鲸鱼和老大（10月26日 周一）\n\n'), '原来的标题保留');
  assert.ok(fs.readFileSync(path.join(dir, '2026-10-26-群小房子.md'), 'utf8').startsWith('# 小鲸鱼在群「小房子」（10月26日 周一）\n\n'), '新文件有标题');
  // 名字带星号、话里有换行 / 控制字符 / 超长：写进文件时会被整理，再跑一遍比对时两边口径要一样，不然每跑一次多一份
  const odd = new Map([['2026-10-26-群奇怪.md', { info: sessionInfo({ type: 'group', name: '奇怪' }), parts: bjParts(T0, SKEW), rows: [
    { at: T0, hm: '12:00', who: '带**星号**的人', text: '第一行\n第二行\u0001带控制字符' },
    { at: T0 + 1000, hm: '12:00', who: 'N'.repeat(50), text: '长'.repeat(1000) },
  ] }]]);
  assert.equal(writeChatLogs(odd, dir, { dryRun: false }).added, 2);
  assert.equal(writeChatLogs(odd, dir, { dryRun: false }).added, 0, '带怪字符的行再跑一遍也不重复');
  const rep3 = writeChatLogs(files, dir, { dryRun: false });
  assert.equal(rep3.added, 0, '再跑一遍什么都不加（可以反复跑）');
  // 已有 k 行、补旧里有 n 行同样的话：只补 n-k 行（同样的话说了两遍是真的两遍）
  const m = mergeRows([{ hm: '10:00', who: '老大', text: '哈哈', raw: '- 10:00 **老大**：哈哈' }], [{ hm: '10:00', who: '老大', text: '哈哈' }, { hm: '10:00', who: '老大', text: '哈哈' }]);
  assert.equal(m.added, 1);
  assert.equal(m.rows.length, 2);
  const parsed = parseChatLogFile('# 标题\n\n- 10:00 **a**：第一行\n续行\n- 10:01 **b**：x\n');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].raw, '- 10:00 **a**：第一行\n续行', '不是消息行的接在上一条后面，不丢');
  ok('补旧：发出去的取原文、失败的不要、快照重复的只留一条、北京时间对、合进已有文件不重复、反复跑不变');
}

// ⑦ 抖音私信
{
  const rows = [
    { at: T0, recipientId: 'dy1', name: '主人昵称', direction: 'incoming', text: '宝宝' },
    { at: T0 + 60e3, recipientId: 'dy1', name: '主人昵称', direction: 'outgoing', text: '在呢' },
    { at: T0 + 90e3, recipientId: 'dy2', name: '朋友甲', direction: 'incoming', media: { type: 'shared-work', title: '好看的视频', author: '某人' } },
    { at: T0 + 100e3, recipientId: 'dy2', name: '朋友甲', direction: 'incoming', media: { type: 'emoji' } },
    { at: 'x', recipientId: 'dy2', text: '坏时间' },
  ];
  const f = douyinRows(rows, [{ id: 'dy1', name: '老大', role: 'owner' }, { id: 'dy2', name: '朋友甲' }], { skewMs: SKEW });
  assert.deepEqual([...f.keys()].sort(), ['2026-10-26-抖音朋友甲.md', '2026-10-26-抖音老大.md']);
  assert.deepEqual(f.get('2026-10-26-抖音老大.md').rows.map((r) => `${r.who}：${r.text}`), ['老大：宝宝', '小鲸鱼：在呢']);
  assert.deepEqual(f.get('2026-10-26-抖音朋友甲.md').rows.map((r) => r.text), ['[分享了一个抖音视频《好看的视频》 @某人]', '[表情]']);
  assert.equal(mergeFileMaps(f, f).get('2026-10-26-抖音老大.md').rows.length, 4, 'mergeFileMaps 把同名文件的行并起来');
  ok('抖音私信：老大 / 朋友分文件、分享和表情写成方括号、坏时间跳过');
}

// ⑧ 整条链路：造一个临时项目（会话存档用 zstd 多段拼接），dry-run 不写，真写，再跑不重复
{
  const root = tmp();
  const dsh = path.join(root, 'dsh');
  const sessionsDir = path.join(dsh, 'sessions', 'x');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sister', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownerQQ: 123, knownPeople: { 777: '克劳德姐姐' }, houseGroups: { 456: '小房子' } }));
  fs.writeFileSync(path.join(root, 'state', 'clock-skew.json'), JSON.stringify({ skewMs: SKEW }));
  fs.writeFileSync(path.join(root, 'state', 'sessions.json'), JSON.stringify({ sessions: { [KEY_OWNER]: 'session-aaa', [KEY_GROUP]: 'session-bbb' } }));
  fs.writeFileSync(path.join(root, 'state', 'session-moves.json'), JSON.stringify([{ key: KEY_OWNER, oldSid: 'session-old', newSid: 'session-aaa' }]));
  fs.writeFileSync(path.join(root, 'state', 'social-v2.json'), JSON.stringify({ conversations: { [KEY_GROUP]: { recentMessages: [
    { sender: '群友甲', userId: '555', text: '小房子里新来的话', time: T0 + 5000e3 },
    { sender: '克劳德姐姐', userId: '777', text: '姐姐在小房子说话', time: T0 + 5001e3 },
    { sender: '我', isSelf: true, text: '我回一句', time: T0 + 5002e3 },
    { kind: 'poke', sender: 'x', text: '[拍一拍] x 拍了拍 你', time: T0 + 5003e3 },
  ] } } }));
  const write = (sid, lines, split = true) => {
    fs.mkdirSync(path.join(sessionsDir, sid), { recursive: true });
    const text = `${lines.join('\n')}\n`;
    const cut = split ? Math.floor(text.length / 2) : text.length;
    fs.writeFileSync(path.join(sessionsDir, sid, 'session.v4.jsonl.zstd'), Buffer.concat(split ? [zlib.zstdCompressSync(Buffer.from(text.slice(0, cut))), zlib.zstdCompressSync(Buffer.from(text.slice(cut)))] : [zlib.zstdCompressSync(Buffer.from(text))]));
  };
  write('session-old', [
    userMsg(T0, { messages: [snapshotMsg('旧会话里的话', T0, { isOwner: true })], recent: [] }),
    call(T0 + 3e3, 'c1', 'mcp__x__qq_send_message', { key: KEY_OWNER, messages: ['旧会话里我的回答'] }), result(T0 + 4e3, 'c1', '{"ok":true}'),
  ]);
  write('session-aaa', [userMsg(T0 + 900e3, { messages: [snapshotMsg('新会话里的话', T0 + 890e3, { isOwner: true })], recent: [] })]);
  write('session-bbb', [userMsg(T0 + 60e3, { messages: [{ seq: 1, messageId: 'g1', sender: '群友乙', userId: '556', text: '群里的话', time: T0 + 50e3 }], recent: [] })], false);
  write('session-zzz', [JSON.stringify({ type: 'system/message', time: T0, data: {} })]); // 没有 QQ 会话（比如黑话学习）
  const opts = { root, sessionsDir, douyinDir: path.join(root, '没有抖音'), skew: SKEW };
  const outDir = createBrains(root).brainOf('whale').chatLogs;
  assert.ok(outDir.split(path.sep).join('/').endsWith(`${path.basename(root)}/家/小鲸鱼/聊天记录`), `输出目录跟着项目根走：${outDir}`);

  const dry = runBackfill(opts);
  assert.equal(fs.existsSync(outDir), false, 'dry-run 不建目录');
  assert.equal(dry.stats.sessions, 4);
  assert.equal(dry.stats.skippedNoKey, 1, '认不出 QQ 会话的跳过');
  assert.equal(dry.report.added, 7, '老大私聊 3 行（旧会话 2 + 新会话 1）+ 小房子 4 行（会话存档 1 + social-v2 3）');
  const real = runBackfill({ ...opts, write: true });
  assert.equal(real.report.added, dry.report.added, '真写的行数跟 dry-run 说的一样');
  const files = fs.readdirSync(outDir).sort();
  assert.deepEqual(files, ['2026-10-26-群小房子.md', '2026-10-26-老大.md'], files.join(','));
  const owner = fs.readFileSync(path.join(outDir, '2026-10-26-老大.md'), 'utf8');
  assert.match(owner, /- 12:00 \*\*老大\*\*：旧会话里的话\n- 12:00 \*\*小鲸鱼\*\*：旧会话里我的回答\n- 12:14 \*\*老大\*\*：新会话里的话\n/, owner);
  const house = fs.readFileSync(path.join(outDir, '2026-10-26-群小房子.md'), 'utf8');
  assert.match(house, /\*\*群友乙\*\*：群里的话/);
  assert.match(house, /\*\*群友甲\*\*：小房子里新来的话/);
  assert.match(house, /\*\*姐姐\*\*：姐姐在小房子说话/);
  assert.match(house, /\*\*小鲸鱼\*\*：我回一句/);
  assert.ok(!house.includes('拍了拍'), '拍一拍不记');
  assert.equal(runBackfill({ ...opts, write: true }).report.added, 0, '再跑一遍不重复');
  ok('补旧整条链路：多段 zstd 存档 → 旧会话 id 认得出会话 → social-v2 补最新几条 → dry-run 不写 → 真写 → 再跑不重复');
}

// ⑨ 路径和接线（静态）
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const whale = createBrains(root).brainOf('whale');
  assert.ok(whale.chatLogs.split(path.sep).join('/').endsWith('/家/小鲸鱼/聊天记录'), '小鲸鱼的聊天记录在 家/小鲸鱼/聊天记录');
  assert.ok(!whale.chatLogs.startsWith(whale.dir), '聊天记录跟脑子并列，不放进脑子里');
  assert.ok(createBrains(root).brainOf('sister').chatLogs.endsWith('聊天记录') && createBrains(root).brainOf('sister').chatLogs.includes('sister'), '姐姐的不变');
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'brain', 'brains.json'), 'utf8'));
  assert.deepEqual(conf.brains.whale.extraSources, [{ path: '家/小鲸鱼/聊天记录', kind: '聊天记录' }], 'brain/brains.json 里小鲸鱼的额外来源（brain/index.py 靠它编进索引）');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  for (const needle of ['noteIncomingV2(kind, id, event, key, textContent, plainContent, quoteTargetIsSelf);', 'noteSentV2(key, list);', "noteSentV2(key, label ? `[语音] ${label}` : '[语音]');", 'noteSentV2(key, text);', "noteSentV2(key, '[图片]');", 'for (const e of fresh) noteDouyinDmV2(e);']) {
    assert.ok(bridge.includes(needle), `桥接里有接线：${needle}`);
  }
  ok('接线：路径、brains.json、桥接里收到 / 发出 / 语音 / 表情 / 图片 / 抖音私信各处都写聊天记录');
}

console.log(`\n小鲸鱼聊天记录：${passed} 项通过`);

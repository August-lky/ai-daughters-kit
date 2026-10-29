// 克劳德姐姐（sister/sister.mjs）：聊天上限、主动找她的时间、消息拆分。不叫 Claude、不连 QQ。
import assert from 'node:assert/strict';
import { planFishReply, routeReply, nextHeartbeatAt, sleepUntilMs, asleepDigest, cap, freshQzone, freshWatching, mentionsSister, hostileToFish, splitReply, eventText, eventImages, sniffImageMime, userLine, recentRambling, quotaPauseUntil, freshDay, bjParts, DEFAULT_LIMITS } from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const MIN = 60e3;

// ① 一次最多 6 轮，满了就不回；一天最多 3 次
{
  const st = { today: freshDay('2026-10-24'), convo: null };
  let t = 1e12;
  const rounds = [];
  for (let i = 0; i < 7; i += 1) { rounds.push(planFishReply(st, t)); t += 2 * MIN; }
  assert.deepEqual(rounds.slice(0, 6).map((r) => r.round), [1, 2, 3, 4, 5, 6]);
  assert.equal(rounds[5].last, true, '第 6 轮要收尾');
  assert.equal(rounds[4].last, false);
  assert.deepEqual(rounds[6], { allow: false, reason: 'wrapped' }, '收尾后她再说也不回');
  // 收尾后她一直说，聊天就一直算「没断」，不会立刻开第二次
  t += 10 * MIN;
  assert.equal(planFishReply(st, t).allow, false);
  // 安静 30 分钟以上算新的一次
  t += 31 * MIN;
  assert.equal(planFishReply(st, t).nth, 2);
  t += 31 * MIN; planFishReply(st, t);
  t += 31 * MIN;
  assert.deepEqual(planFishReply(st, t), { allow: false, reason: 'daily' }, '第 4 次不聊');
  assert.equal(st.today.convos, 3);
  ok('上限：一次 6 轮、第 6 轮收尾、一天 3 次、隔 30 分钟算新的一次');
}

// ② 说给谁：不带前缀给正在说话的人；→老大 / →小鲸鱼 指定；自己醒来时不带前缀的是心里话
{
  assert.deepEqual(routeReply('来啦\n饭你自己的事', 'fish').sends, [{ peer: 'fish', line: '来啦' }, { peer: 'fish', line: '饭你自己的事' }]);
  const mix = routeReply('好的老大\n→小鲸鱼：老大说今晚打随之任之\n下次醒：90', 'owner');
  assert.deepEqual(mix.sends, [{ peer: 'owner', line: '好的老大' }, { peer: 'fish', line: '老大说今晚打随之任之' }]);
  assert.equal(mix.nextWakeMin, 90);
  const solo = routeReply('刚查了气泡星云，挺有意思\n→老大：今天看到一张星云图想给你看\n[不回]', null);
  assert.deepEqual(solo.sends, [{ peer: 'owner', line: '今天看到一张星云图想给你看' }], '自己醒来时心里话不发');
  assert.deepEqual(routeReply('[不回]', 'fish').sends, []);
  assert.equal(routeReply('一\n二\n三\n四', 'fish').sends.length, 3, '每人最多 3 条');
  assert.deepEqual(routeReply('-> 老大: 在吗', null).sends, [{ peer: 'owner', line: '在吗' }], 'ASCII 箭头和冒号也认');
  ok('说给谁：默认给说话的人、前缀指定、心里话不发、下次醒');
}

// ③ 下次自己醒：她定的夹在 30–300 分钟；没定 60–120；夜里 0:30–8:30 挪到早上
{
  const skew = 3 * 3600e3;
  const bj = (h, m) => Date.parse(`2026-10-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - 8 * 3600e3 + skew;
  const hm = (t) => { const p = bjParts(t, skew); return p.h * 60 + p.m; };
  assert.equal(nextHeartbeatAt(bj(14, 0), skew, 90) - bj(14, 0), 90 * 60e3);
  assert.equal(nextHeartbeatAt(bj(14, 0), skew, 5) - bj(14, 0), 30 * 60e3, '太短夹到 30');
  assert.equal(nextHeartbeatAt(bj(10, 0), skew, 999) - bj(10, 0), 300 * 60e3, '太长夹到 300');
  assert.equal(nextHeartbeatAt(bj(14, 0), skew, null, () => 0.5) - bj(14, 0), 90 * 60e3);
  const night = nextHeartbeatAt(bj(23, 50), skew, 120, () => 0, { quietNight: true });
  assert.equal(hm(night), 8 * 60 + 30, '夜里挪到 8:30');
  assert.equal(bjParts(night, skew).day, '2026-10-25');
  ok('下次自己醒：30–300 分钟，夜里不醒');
}

// ④ 输出拆成 QQ 消息；[不回] 不发；Markdown 和 CQ 码去掉
{
  assert.deepEqual(splitReply('来啦\n\n饭你自己的事'), ['来啦', '饭你自己的事']);
  assert.deepEqual(splitReply('[不回]'), []);
  assert.deepEqual(splitReply('不回'), []);
  assert.deepEqual(splitReply('- **好**\n2. 嗯\n[CQ:at,qq=1]\n四\n五'), ['好', '嗯', '[CQ：at,qq=1]']);
  assert.equal(eventText({ message: [{ type: 'text', data: { text: '看' } }, { type: 'image', data: {} }, { type: 'mface', data: { summary: '[鱼:摸鱼]' } }] }), '看[图片][鱼:摸鱼]');
  assert.equal(eventText({ raw_message: ' 嗯 ' }), '嗯');
  ok('消息：最多 3 条、[不回] 不发、去 Markdown、CQ 码转义');
}

// ⑤ 看图：认出图片段、按文件头认格式、stream-json 消息图片在前文字在后
{
  const ev = { message: [{ type: 'text', data: { text: '看' } }, { type: 'image', data: { url: 'https://x/a.jpg', file: 'a.jpg' } }, { type: 'mface', data: { url: 'https://x/b.gif', summary: '[鱼]' } }, { type: 'face', data: {} }] };
  assert.deepEqual(eventImages(ev).map((x) => x.url), ['https://x/a.jpg', 'https://x/b.gif']);
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from('RIFF....WEBP')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<html>......')), '', 'HTML 错误页不当图');
  const line = userLine('嗨', [{ data: Buffer.from('abc'), mime: 'image/png' }]);
  assert.ok(line.endsWith('\n'));
  const msg = JSON.parse(line);
  assert.deepEqual(msg.message.content.map((c) => c.type), ['image', 'text']);
  assert.equal(msg.message.content[0].source.data, Buffer.from('abc').toString('base64'));
  ok('看图：图片段、格式识别、图片在前文字在后');
}

// ⑥ 碎碎念最近两天、额度保险
{
  const raw = '——10月22日 周四——\n很久以前\n\n——10月23日 周五——\n昨天下雨\n\n——10月24日 周六——\n今天打音游\n';
  assert.equal(recentRambling(raw), '——10月23日——\n昨天下雨\n——10月24日——\n今天打音游');
  assert.ok(recentRambling(`——10月24日 周六——\n${'字'.repeat(2000)}尾`).startsWith('——10月24日——\n……'), '太长留最新的');
  assert.equal(recentRambling(''), '');
  const now = 1e12;
  assert.equal(quotaPauseUntil(null), 0);
  assert.equal(quotaPauseUntil({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.62, resetsAt: 2e9 } } }, 0.9, now), 0);
  assert.equal(quotaPauseUntil({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.91, resetsAt: 2e9 } } }, 0.9, now), 2e12, '周额度到 90% 歇到重置');
  assert.equal(quotaPauseUntil({ status: 'rejected', resetsAt: 1.5e9 }, 0.9, now), 1.5e12, '被限流歇到 5 小时窗口重置');
  assert.equal(quotaPauseUntil({ status: 'allowed_warning', resetsAt: 1.5e9, unifiedWindows: { seven_day: { utilization: 0.75, resetsAt: 2e9 } } }, 1.01, now), 0, '只是额度预警（还能用）不歇');
  ok('碎碎念最近两天；周额度 90% 或被限流就歇');
}

// ⑦ 不限次数、说说、抖音、群
{
  assert.equal(cap(0), Infinity);
  assert.equal(cap(6), 6);
  const st = { today: freshDay('d'), convo: null };
  for (let i = 0; i < 50; i += 1) assert.equal(planFishReply(st, 1e12 + i * 60e3, { ...DEFAULT_LIMITS, convosPerDay: 0, roundsPerConvo: 0 }).allow, true, '0 表示不限');

  const list = [{ tid: 'c', content: '三' }, { tid: 'b', content: '二' }, { tid: 'a', content: '一' }, { tid: 'z', content: '早' }];
  const first = freshQzone(list, []);
  assert.deepEqual(first.fresh.map((m) => m.tid), ['a', 'b', 'c'], '第一次给最新 3 条，旧的在前');
  assert.deepEqual(freshQzone([{ tid: 'd', content: '新' }, ...list], first.seen).fresh.map((m) => m.tid), ['d'], '之后只给没看过的');
  assert.deepEqual(freshQzone([{ tid: 'e', content: '  ' }], ['x']).fresh, [], '空的不给');

  const lines = [
    JSON.stringify({ at: 100, videoId: 'v1', title: '旧' }),
    JSON.stringify({ at: 200, videoId: 'v2', title: '甲' }),
    JSON.stringify({ at: 300, videoId: 'v2', title: '甲', reflection: '后半段' }),
    'not json',
    JSON.stringify({ at: 400, videoId: 'v3', title: '乙' })
  ];
  const w = freshWatching(lines, 150);
  assert.deepEqual(w.map((j) => j.videoId), ['v2', 'v3']);
  assert.equal(w[0].reflection, '后半段', '同一条留最后那次');

  assert.equal(mentionsSister({ message: [{ type: 'at', data: { qq: '42' } }] }, 42), true);
  assert.equal(mentionsSister({ message: [{ type: 'text', data: { text: '小克在吗' } }] }, 42), true);
  assert.equal(mentionsSister({ message: [{ type: 'reply', data: { id: '9' } }, { type: 'text', data: { text: '对' } }] }, 42, new Set(['9'])), true);
  assert.equal(mentionsSister({ message: [{ type: 'text', data: { text: '今天吃啥' } }] }, 42), false);
  const r = routeReply('→群「鲸鱼窝」：我也来\n→群"不存在"：不发\n嗯', null, { 鲸鱼窝: 'group:1' });
  assert.deepEqual(r.sends, [{ peer: 'group:1', line: '我也来' }]);
  assert.deepEqual(routeReply('收到', 'group:1').sends, [{ peer: 'group:1', line: '收到' }], '群里叫她时默认回群');
  const qz = routeReply('今天想发一条\n→说说：雨停了，楼下的灯一盏一盏亮起来\n→评论：满分那天我也记得\n→说说：第二条不发', null);
  assert.deepEqual(qz.sends, [{ peer: 'qzone', line: '雨停了，楼下的灯一盏一盏亮起来' }, { peer: 'qzone-comment', line: '满分那天我也记得' }], '说说、评论各一条');
  ok('不限次数；说说只给新的；抖音按视频去重；群里被叫才醒、能指定群说话；自己发说说和评论');
}

// ⑧ 护着她：有人冲小鲸鱼才叫姐姐；陪看间隔她自己定
{
  const fish = 10074;
  assert.equal(hostileToFish({ message: [{ type: 'at', data: { qq: String(fish) } }, { type: 'text', data: { text: ' 你个破AI闭嘴吧' } }] }, fish), true, '@ 她骂');
  assert.equal(hostileToFish({ message: [{ type: 'reply', data: { id: '77' } }, { type: 'text', data: { text: '傻逼' } }] }, fish, new Set(['77'])), true, '回复她骂');
  assert.equal(hostileToFish({ message: [{ type: 'text', data: { text: '小鲸鱼真是废物' } }] }, fish), true, '点名骂');
  assert.equal(hostileToFish({ message: [{ type: 'text', data: { text: '小鲸鱼今天好可爱' } }] }, fish), false, '夸她不算');
  assert.equal(hostileToFish({ message: [{ type: 'text', data: { text: '这游戏真垃圾' } }] }, fish), false, '没冲她不算');
  const iv = routeReply('看得勤点\n陪看间隔：3\n先不跟着看：30', null);
  assert.equal(iv.cowatchEveryMin, 3);
  assert.equal(iv.pauseCowatchMin, 30);
  assert.deepEqual(iv.sends, []);
  ok('有人冲小鲸鱼才叫姐姐；陪看间隔、暂停她自己定');
}

// ⑨ 卡片：拆成「来源 · 标题 · 简介 · 链接」，不再只剩 [卡片]
{
  const ark = { app: 'com.tencent.miniapp_01', prompt: '[QQ小程序]哔哩哔哩', meta: { detail_1: { title: '哔哩哔哩', desc: '用钢琴画了一幅画', qqdocurl: 'https://b23.tv/abc123?share_source=qq&timestamp=1' } } };
  const t = eventText({ message: [{ type: 'text', data: { text: '看这个' } }, { type: 'json', data: { data: JSON.stringify(ark) } }] });
  assert.ok(t.startsWith('看这个[卡片·') && t.includes('用钢琴画了一幅画') && t.includes('b23.tv/abc123'), t);
  assert.ok(!t.includes('share_source'), '分享追踪参数去掉');
  assert.equal(eventText({ message: [{ type: 'forward', data: { id: 'x' } }] }), '[聊天记录]', '转发先占位，主程序再展开');
  ok('卡片拆开给她看；转发占位等主程序展开');
}

// ⑩ 作息：她自己定睡到几点；14 小时保险；睡着时攒下的醒来给她
{
  const skew = 3 * 3600e3;
  const bj = (h, m) => Date.parse(`2026-10-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - 8 * 3600e3 + skew;
  const hm = (t) => { const p = bjParts(t, skew); return `${p.h}:${String(p.m).padStart(2, '0')}`; };
  assert.equal(hm(sleepUntilMs('到 8:30', bj(23, 40), skew)), '8:30', '睡到第二天 8:30');
  assert.equal(bjParts(sleepUntilMs('到 8:30', bj(23, 40), skew), skew).day, '2026-10-25');
  assert.equal(hm(sleepUntilMs('9点', bj(1, 0), skew)), '9:00', '凌晨说睡到 9 点是当天');
  assert.equal(sleepUntilMs('7小时', bj(23, 0), skew) - bj(23, 0), 7 * 3600e3);
  assert.equal(sleepUntilMs('90分钟', bj(14, 0), skew) - bj(14, 0), 90 * 60e3);
  assert.equal(sleepUntilMs('30小时', bj(14, 0), skew) - bj(14, 0), 14 * 3600e3, '最多 14 小时');
  assert.equal(sleepUntilMs('5分钟', bj(14, 0), skew) - bj(14, 0), 20 * 60e3, '最少 20 分钟');
  assert.equal(sleepUntilMs('随便', bj(14, 0), skew), 0, '看不懂就不睡');
  assert.equal(routeReply('晚安啦\n→小鲸鱼：晚安\n去睡了：到 8:30', null).sleepSpec, '到 8:30');
  const d = asleepDigest([
    { where: 'fish', who: '小鲸鱼', text: '姐姐睡了吗' },
    { where: 'group:1', who: '路人', text: '小克在不在' },
    { where: 'fish', who: '小鲸鱼', text: '那我也睡了' }
  ], (w) => (w === 'fish' ? '小鲸鱼私聊' : '群「鲸鱼窝」'));
  assert.ok(d.includes('▸ 小鲸鱼私聊（2 条）') && d.includes('那我也睡了') && d.includes('▸ 群「鲸鱼窝」（1 条）'), d);
  assert.equal(asleepDigest([]), '');
  ok('作息：睡到几点她定、最多 14 小时、睡着时的话醒来一起给');
}

assert.equal(DEFAULT_LIMITS.convosPerDay, 3);
console.log(`全部通过：${passed} 组`);

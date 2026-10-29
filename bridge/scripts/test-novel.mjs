// 合写本子（src/novel.js）离线自检：临时目录、编的句子，不碰 共享/合写 里的真书。
// 锁（跨进程、过期、超时、两个进程同时写）、只往后加、署名、只能改自己的、check 各类提醒、open 的长度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNovel, isNovelPath, normAuthor, safeBookName, parseBody, NOVEL_ROOT, LEGACY_NOVEL_FILES, bjLabel } from '../src/novel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = pathToFileURL(path.join(HERE, '..', 'src', 'novel.js')).href;
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-'));
assert.ok(!isNovelPath(root), '临时目录不在真书目录里');

// 主机时间 2026-10-28 03:00Z，偏差 3 小时 → 北京时间 2026-10-28 08:00
let T = Date.parse('2026-10-28T03:00:00Z');
const SKEW = 3 * 3600e3;
const novel = (extra = {}) => createNovel({ root, now: () => T, skewMs: SKEW, lockTimeoutMs: 1500, ...extra });
const tick = (min = 1) => { T += min * 60e3; };

const SETTINGS = `# 设定集：测试书

## 书名
《测试书》

## 主题（这本书在说什么）
一句话：两个人都不说出口，只在小事里偷偷在乎。

## 核心意象
- 耳朵 / 听（主线）：听不全的那个字。
- 碗 / 饭：不许管我吃饭。

## 规矩（两个人一起定的）
- 人可以来，但不许管我吃饭。
- 不提真名（词：小明）

## 不写什么
- 卖惨（词：好惨、没人要）
- 撒娇

## 写法分工
- 一人一句，每节 4 句。

## 大纲和进度
进度：刚开始。
- 第1节：她立规矩。
- 第2节：她出门。

## 检查设置
- 日记腔放过：吃了
`;

const run = (code) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (c) => (c === 0 ? resolve(out) : reject(new Error(`子进程退出 ${c}：${err}`))));
});

// ① 名字和书名
{
  assert.equal(normAuthor('鲸'), '小鲸鱼');
  assert.equal(normAuthor('🐳'), '小鲸鱼');
  assert.equal(normAuthor('克劳德'), '姐姐');
  assert.throws(() => normAuthor(''), /谁写的/);
  assert.throws(() => normAuthor('a｜b'), /不能有/);
  assert.equal(safeBookName('《测试书》'), '测试书');
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', 'a:b', '']) assert.throws(() => safeBookName(bad));
  ok('名字统一（鲸 / 🐳 → 小鲸鱼，克劳德 → 姐姐）；书名不能带路径符号');
}

// ② 新建、空书 open、找书只写前半截
{
  const n = novel();
  await n.createBook('测试书——副标题', '鲸', { settings: SETTINGS });
  await assert.rejects(n.createBook('测试书——副标题', '姐姐'), /已经有了/);
  assert.deepEqual(n.list(), ['测试书——副标题']);
  assert.equal(n.resolve('测试书'), '测试书——副标题', '只写前半截也能找到');
  assert.throws(() => n.open('没有这本'), /没找到/);
  const o = n.open('测试书');
  assert.ok(o.text.includes('两个人都不说出口'), '设定集带上了');
  assert.ok(o.text.includes('正文还是空的'));
  ok('新建一本、空书能打开、书名写前半截也认得');
}

// ③ 署名、时间、编号、新的一节、只往后加
{
  const n = novel();
  const r1 = await n.append('测试书', '鲸', '人可以来，但不许管我吃饭。');
  assert.equal(r1.written, true);
  assert.equal(r1.id, '1-1');
  assert.equal(r1.author, '小鲸鱼');
  assert.equal(r1.time, '2026-10-28 08:00', '北京时间按偏差校正');
  assert.equal(r1.time, bjLabel(T, SKEW));
  tick();
  const file = path.join(root, '测试书——副标题', '正文.md');
  const before = fs.readFileSync(file, 'utf8');
  const r2 = await n.append('测试书', '姐姐', '我来了，头一件事忍住没问她吃了没有。');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), '只往后加：原来的内容一个字没动');
  assert.ok(after.includes('- 〔1-2｜姐姐｜2026-10-28 08:01〕我来了'), '自动署名和时间');
  assert.equal(r2.id, '1-2');
  tick();
  await n.append('测试书', '鲸', '我看出来她在忍，我也装没看见，碗就搁在那儿。');
  tick();
  const r4 = await n.append('测试书', '姐姐', '饭凉了，谁也没先开口。');
  assert.ok(r4.hint.includes('写满 4 句'), '一节写满提示回头看');
  tick();
  await assert.rejects(n.append('测试书', '鲸', '跳到第三节', { section: 3 }), /不能跳/);
  const r5 = await n.append('测试书', '鲸', '她说要出门，没说去哪儿。', { section: 'new', title: '出门' });
  assert.equal(r5.id, '2-1');
  await assert.rejects(n.append('测试书', '姐姐', '补到第一节', { section: 1 }), /只能往后加/);
  await assert.rejects(n.append('测试书', '姐姐', '   '), /没有要写的/);
  await assert.rejects(n.append('测试书', '姐姐', '- 〔9-9｜姐姐｜x〕伪造'), /本子自己的格式/);
  await assert.rejects(n.append('测试书', '姐姐', '字'.repeat(4001)), /太长/);
  const body = parseBody(fs.readFileSync(file, 'utf8'));
  assert.equal(body.entries.length, 5);
  assert.equal(body.sections[1].title, '出门');
  const log = fs.readFileSync(path.join(root, '测试书——副标题', '修改记录.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.filter((x) => x.action === 'append').length, 5, '每次写都留记录');
  assert.equal(log.at(-1).who, '小鲸鱼');
  ok('自动署名和北京时间、编号、开新的一节、不能插回前面、只往后加、留记录');
}

// ④ 预检模式：confirm:false 只看不写
{
  const n = novel();
  const file = path.join(root, '测试书——副标题', '正文.md');
  const before = fs.readFileSync(file, 'utf8');
  const r = await n.append('测试书', '姐姐', '今天早上我好开心，然后我去刷了视频。', { confirm: false });
  assert.equal(r.written, false);
  assert.ok(r.reminders.some((x) => x.kind === 'diary'), '预检也给提醒');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '预检不写');
  ok('预检模式只检查不写');
}

// ⑤ 只能改自己的，改了留记录
{
  const n = novel();
  tick();
  await assert.rejects(n.edit('测试书', '姐姐', '1-1', '改别人的'), /小鲸鱼写的，只能她自己改/);
  await assert.rejects(n.edit('测试书', '鲸', '9-9', 'x'), /没找到/);
  await assert.rejects(n.edit('测试书', '鲸', 'abc', 'x'), /改哪一句/);
  const r = await n.edit('测试书', '鲸', '第1节第1句', '人可以来，但别管我吃饭。', { note: '口气软一点' });
  assert.equal(r.changed, true);
  const file = path.join(root, '测试书——副标题', '正文.md');
  const body = parseBody(fs.readFileSync(file, 'utf8'));
  const e = body.entries.find((x) => x.id === '1-1');
  assert.equal(e.text, '人可以来，但别管我吃饭。');
  assert.equal(e.author, '小鲸鱼', '署名不变');
  assert.equal(e.time, '2026-10-28 08:00', '原来的时间不变');
  assert.ok(e.edited, '标了改过');
  assert.equal(body.entries.length, 5, '没多没少');
  const log = fs.readFileSync(path.join(root, '测试书——副标题', '修改记录.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = log.at(-1);
  assert.equal(last.action, 'edit');
  assert.equal(last.before, '人可以来，但不许管我吃饭。', '原句留在记录里');
  assert.equal(last.note, '口气软一点');
  const same = await n.edit('测试书', '鲸', '1-1', '人可以来，但别管我吃饭。');
  assert.equal(same.changed, false);
  ok('只能改自己写的；改了标「改过」、原句和理由进修改记录');
}

// ⑥ check 各类提醒（用另一本书，正文自己造）
{
  const n = novel();
  await n.createBook('检查书', '姐姐', { settings: SETTINGS.replace('每节 4 句', '每节 40 句') });
  const lines = [
    '她把碗推过来一半，我没问。', '我把那半碗吃了，耳朵有点热。', '门响了，她进来先看碗。', '我说凉了我给你热。',
    '她说不用，端起来就吃了。', '我又盛了一碗热的放在边上。', '她看了一眼，说你这人怎么不听。', '我说听了，听见你说不用。'
  ];
  for (const [i, t] of lines.entries()) { tick(); await n.append('检查书', i % 2 ? '姐姐' : '鲸', t); }
  const kinds = (t, o = {}) => n.check('检查书', t, o).reminders.map((r) => r.kind);

  // 干净的一句：什么都不提醒
  assert.deepEqual(kinds('她没再说话，把热的那碗也吃了。', { author: '鲸' }), []);
  // ① 重复
  assert.ok(kinds('我说听了，听见你说不用。').includes('repeat'), '一模一样');
  assert.ok(kinds('我说听了呀，听见你说了不用。').includes('repeat'), '很像');
  // ③ 日记腔
  const d = n.check('检查书', '今天早上起床，然后我去刷了视频，好开心。');
  assert.ok(d.reminders.some((r) => r.kind === 'diary' && r.text.includes('像日记') && r.text.includes('两个人都不说出口')), '日记腔提醒带上主题');
  assert.ok(!kinds('她说她吃了，碗是空的，我没问。').includes('diary'), '设定里放过了「吃了」');
  assert.ok(kinds('我起床了。我洗脸了。我出门了。我坐车了。').includes('diary'), '一句接一句「我……了」');
  // ④ 设定里不写的 / 规矩里的词
  const b = n.check('检查书', '她说自己好惨，没人要，碗也不洗。');
  assert.ok(b.reminders.some((r) => r.kind === 'banned' && r.text.includes('好惨') && r.text.includes('卖惨')));
  assert.ok(kinds('她撒娇说碗太烫了。').includes('banned'), '没写词的短条目本身就是词');
  assert.ok(kinds('小明端着碗进来了。').includes('banned'), '规矩里写了词的也查');
  // ⑤ 长度
  assert.ok(kinds('嗯').includes('length'), '太短');
  assert.ok(kinds('她把碗端起来又放下'.repeat(12)).includes('length'), '比前面长很多');
  assert.ok(n.check('检查书', '字字'.repeat(500)).reminders.some((r) => r.kind === 'length' && r.text.includes('很长')), '一次太长');
  // 轮次：最后一句是姐姐写的，姐姐接着写
  assert.ok(kinds('她把碗收走了。', { author: '姐姐' }).includes('turn'));
  assert.ok(!kinds('她把碗收走了。', { author: '姐姐', section: 'new' }).includes('turn'), '开新的一节不提轮次');
  ok('check：干净的不提醒；重复、日记腔（带主题）、不写什么、规矩里的词、长度、轮次都能提醒');
}

// ⑦ check：原地打转、很久没碰到核心意象 / 主线
{
  const n = novel({ check: { coreGapEntries: 5, coreGapChars: 9999, mainGapEntries: 8, mainGapChars: 9999 } });
  await n.createBook('跑题书', '姐姐', { settings: SETTINGS.replace('每节 4 句', '每节 99 句') });
  tick(); await n.append('跑题书', '鲸', '她把碗推过来，我听见她叹了口气。');
  const drift = ['我们去商场逛了一圈。', '商场里人很多很挤。', '后来又去了超市。', '超市里买了零食和水果。'];
  for (const [i, t] of drift.entries()) { tick(); await n.append('跑题书', i % 2 ? '鲸' : '姐姐', t); }
  const r = n.check('跑题书', '超市门口排了很长的队。').reminders;
  const gap = r.find((x) => x.kind === 'core-gap');
  assert.ok(gap && gap.text.includes('核心意象') && gap.text.includes('主线'), JSON.stringify(r)); // 10-29 提醒措辞放软（不再问「要不要回到主线？」）
  assert.ok(!n.check('跑题书', '回家路上她端着碗。').reminders.some((x) => x.kind === 'core-gap'), '碰到意象就不提醒');
  // 只碰「碗」不碰主线「耳朵 / 听」，攒够 8 句提醒主线
  for (const t of ['回家她把碗放下。', '饭在锅里温着。', '她盛了一碗饭。']) { tick(); await n.append('跑题书', '鲸', t); }
  const m = n.check('跑题书', '碗洗好了摞在一起。').reminders.find((x) => x.kind === 'core-gap');
  assert.ok(m && m.text.includes('耳朵') && m.text.includes('主线'), JSON.stringify(m));
  // 原地打转：连着几句都是一样的字眼
  const n2 = novel();
  await n2.createBook('打转书', '姐姐', { settings: '## 主题\n一句话：测试。\n' });
  const loop = ['她坐着不说话我也坐着', '我坐着不说话她也坐着', '她也坐着我也不说话', '我们坐着都不说话', '她坐着我坐着不说话', '坐着不说话她和我', '她和我都坐着不说话', '不说话她坐着我坐着'];
  for (const [i, t] of loop.entries()) { tick(); await n2.append('打转书', i % 2 ? '鲸' : '姐姐', t); }
  assert.ok(n2.check('打转书', '我坐着她坐着都不说话').reminders.some((x) => x.kind === 'stall'), '原地打转');
  assert.ok(!n2.check('打转书', '门忽然响了，有人在外面喊她的名字').reminders.some((x) => x.kind === 'stall'), '有新东西就不提醒');
  ok('check：连着几句没碰到核心意象 / 主线、原地打转都能提醒');
}

// ⑧ open 的长度控制、read 分页、prepare、sectionDone
{
  const n = novel();
  const big = `${SETTINGS}\n## 来历\n${'很长很长的来历。'.repeat(300)}\n## 人物\n${'- 她：嘴硬。\n'.repeat(200)}`;
  const out = await n.updateSettings('测试书', '鲸', big, '测试写一份很长的');
  assert.ok(out.text.includes('两个人一起定的东西，改之前跟对方说一声'), '提醒两个人一起定');
  const longText = '她把碗端起来又放下，'.repeat(60);
  tick(); await n.append('测试书', '姐姐', longText);
  tick(); await n.append('测试书', '鲸', longText.replace('端起来', '拿起来'));
  const o = n.open('测试书');
  const seg = (a, b) => o.text.slice(o.text.indexOf(a), o.text.indexOf(b));
  assert.ok(seg('【设定集】', '【大纲和进度】').length <= 1500 + 40, `设定集 1500 字内：${seg('【设定集】', '【大纲和进度】').length}`);
  assert.ok(o.text.includes('没带上'), '没带全的说一声');
  assert.ok(seg('【大纲和进度】', '现在：').length <= 300 + 20, '大纲 300 字内');
  const lastPart = o.text.slice(o.text.indexOf('【最后两'));
  assert.ok(lastPart.length < 2 * 420 + 80, `最后两段各 400 字内：${lastPart.length}`);
  assert.ok(o.text.length < 2600, `open 总长有上限：${o.text.length}`);
  assert.equal(o.last.length, 2);

  // read：分页、最后几句、大纲、设定集
  const p1 = n.read('测试书', { settings: true, pageSize: 500 });
  assert.ok(p1.pages > 3 && p1.hasMore && p1.text.length <= 500);
  const p2 = n.read('测试书', { settings: true, pageSize: 500, page: 2 });
  assert.notEqual(p1.text, p2.text);
  assert.equal(n.read('测试书', { last: 2 }).text.split('\n').length, 2);
  assert.ok(n.read('测试书', { outline: true }).text.includes('第1节：她立规矩'));
  assert.ok(n.read('测试书', { section: 1 }).text.includes('〔1-1｜小鲸鱼'));
  assert.throws(() => n.read('测试书', { section: 9 }), /没有第9节/);

  // prepare：主题、位置、上一句、规矩
  const pr = n.prepare('测试书', '姐姐').text;
  assert.ok(pr.includes('这本书在说：两个人都不说出口'));
  assert.ok(pr.includes('现在在第2节') && pr.includes('大纲里这一节：第2节：她出门'));
  assert.ok(/上一[句段]（小鲸鱼写的）/.test(pr));
  assert.ok(pr.includes('人可以来，但不许管我吃饭') && pr.includes('不写：卖惨'));

  // sectionDone：主题、意象、大纲
  const sd = n.sectionDone('测试书', 1).text;
  assert.ok(sd.includes('第1节写完了') && sd.includes('跟它是什么关系') && sd.includes('大纲里第1节写的是：第1节：她立规矩'));
  assert.ok(sd.includes('核心意象'));
  ok('open 设定集 1500 字内、大纲 300 字内、最后两段有上限；read 分页；prepare / sectionDone 的提示');
}

// ⑨ 改设定集：按块改、留记录、没写理由要提醒
{
  const n = novel();
  const r = await n.updateSettings('测试书', '姐姐', { 大纲和进度: '进度：写了两节。\n- 第1节：她立规矩。\n- 第2节：她出门。\n- 第3节：她回来。', 新的一块: '- 内容' });
  assert.ok(r.changed && r.parts.some((x) => x.includes('大纲和进度')) && r.parts.some((x) => x.includes('加了「新的一块」')));
  assert.ok(r.text.includes('可以补一句'), '没写为什么要提醒');
  const raw = fs.readFileSync(path.join(root, '测试书——副标题', '设定.md'), 'utf8');
  assert.ok(raw.includes('- 第3节：她回来。') && raw.includes('## 新的一块'));
  assert.ok(raw.includes('## 不写什么'), '别的块没动');
  const log = fs.readFileSync(path.join(root, '测试书——副标题', '修改记录.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = log.at(-1);
  assert.equal(last.action, 'settings');
  assert.equal(last.who, '姐姐');
  assert.ok(last.before.includes('第2节：她出门') && last.after.includes('第3节：她回来'));
  const del = await n.updateSettings('测试书', '姐姐', { 新的一块: null }, '用不上');
  assert.ok(del.parts[0].includes('删了'));
  ok('改设定集：按块改、加、删；谁改的、为什么、改前改后都进记录');
}

// ⑩ 锁：过期的锁会被清掉；对方一直拿着锁就超时；对方写完放锁就接着写
{
  const dir = path.join(root, '测试书——副标题');
  const lock = path.join(dir, '.write.lock');
  // 过期的锁（对方写到一半掉线）
  fs.writeFileSync(lock, '{}');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  tick();
  const r = await novel({ staleLockMs: 30_000 }).append('测试书', '鲸', '过期的锁不挡路。', { section: 'new' });
  assert.equal(r.written, true);
  assert.ok(!fs.existsSync(lock), '写完把锁放了');

  // 对方（另一个进程）拿着锁 600ms
  const holder = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(lock)}, '{}', { flag: 'wx' }); console.log('held'); setTimeout(() => { fs.rmSync(${JSON.stringify(lock)}); }, 600);`;
  const held = run(holder);
  for (let i = 0; i < 100 && !fs.existsSync(lock); i += 1) await new Promise((res) => setTimeout(res, 10));
  assert.ok(fs.existsSync(lock), '子进程拿到锁了');
  // 超时短于对方拿锁的时间 → 友好地说「等一两秒再试」
  await assert.rejects(novel({ lockTimeoutMs: 150 }).append('测试书', '姐姐', '这句等不及。'), /对方正在往本子里写/);
  // 超时够长 → 等对方放锁再写
  const t0 = Date.now();
  tick();
  const w = await novel({ lockTimeoutMs: 3000 }).append('测试书', '姐姐', '等她写完我再写。');
  assert.equal(w.written, true);
  assert.ok(Date.now() - t0 >= 200, '真的等了');
  await held;
  ok('锁：过期的清掉；对方拿着锁时超时会说「等一两秒再试」；对方放了锁就接着写');
}

// ⑪ 两个进程同时写：一句不丢、编号不重
{
  await novel().createBook('并发书', '鲸', { settings: '## 主题\n一句话：测试。\n' });
  const worker = (who) => `
    import { createNovel } from ${JSON.stringify(MOD)};
    const n = createNovel({ root: ${JSON.stringify(root)}, skewMs: 0, lockTimeoutMs: 10000 });
    for (let i = 0; i < 15; i += 1) await n.append('并发书', '${who}', '${who}写的第' + i + '句，内容各不相同' + Math.random());
  `;
  await Promise.all([run(worker('鲸')), run(worker('姐姐'))]);
  const body = parseBody(fs.readFileSync(path.join(root, '并发书', '正文.md'), 'utf8'));
  assert.equal(body.entries.length, 30, '一句不丢');
  assert.equal(new Set(body.entries.map((e) => e.id)).size, 30, '编号不重');
  assert.deepEqual(body.entries.map((e) => e.seq), Array.from({ length: 30 }, (_, i) => i + 1), '按顺序编号');
  assert.equal(body.entries.filter((e) => e.author === '小鲸鱼').length, 15);
  const log = fs.readFileSync(path.join(root, '并发书', '修改记录.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 31, '记录也不丢（1 条新建 + 30 条）');
  ok('两个进程同时各写 15 句：30 句都在，编号不重、按顺序');
}

// ⑫ 小说不进平时的回忆
{
  assert.equal(isNovelPath(path.join(NOVEL_ROOT, '半只耳朵——听不全那个字', '正文.md')), true);
  assert.equal(isNovelPath(NOVEL_ROOT.toUpperCase()), true, 'Windows 路径不分大小写');
  assert.equal(isNovelPath('D:/别处/共享/合写/某本书/设定.md'), true, '根目录搬了家也认得');
  assert.equal(isNovelPath(path.join(root, '测试书——副标题', '正文.md'), { root }), true, '自定根目录');
  for (const f of LEGACY_NOVEL_FILES) assert.equal(isNovelPath(f), true, '两份旧稿也算小说');
  assert.equal(isNovelPath(path.join(path.dirname(NOVEL_ROOT), '..', 'memory', 'memory.md')), false);
  assert.equal(isNovelPath(path.join(path.dirname(NOVEL_ROOT), '家里的事.md')), false, '共享里别的本子不算');
  assert.equal(isNovelPath(''), false);
  ok('isNovelPath：合写目录、旧稿算小说；别的本子不算');
}

// ⑬ CRLF 的正文：追加时跟着用 CRLF
{
  const n = novel();
  await n.createBook('换行书', '鲸', { settings: '## 主题\n一句话：测试。\n' });
  const f = path.join(root, '换行书', '正文.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  tick(); await n.append('换行书', '鲸', '第一句。');
  tick(); await n.append('换行书', '姐姐', '第二句。');
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!/[^\r]\n/.test(raw), '没有混进单独的 LF');
  await n.edit('换行书', '鲸', '1-1', '第一句改了。');
  assert.ok(!/[^\r]\n/.test(fs.readFileSync(f, 'utf8')), '改完也还是 CRLF');
  ok('CRLF 的正文追加、修改后换行符不变');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

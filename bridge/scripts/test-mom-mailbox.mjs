// 妈妈信箱离线测试：假的 Claude 执行器、假的主人通知和留言，跑一遍写信 → 看信 → 主人同意 → 改 的全流程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createMomMailbox } from '../src/mom-mailbox.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-mailbox-'));
const owner = [];
const notes = [];
const runs = [];
let nextPlan = null;
let nextDone = null;
let failNext = null;

function makeBox() {
  return createMomMailbox({
    stateDir: tmp,
    root: tmp,
    digestFile: path.join(tmp, '妈妈信箱.md'),
    sendOwner: async (text) => { owner.push(text); },
    addWakeNote: (key, text) => { notes.push({ key, text }); },
    formatTime: () => '10/23 21:30',
    runClaude: async ({ phase, prompt, args }) => {
      runs.push({ phase, prompt, args });
      if (failNext) { const e = failNext; failNext = null; return { ok: false, error: e }; }
      return { ok: true, data: phase === 'plan' ? nextPlan : nextDone };
    }
  });
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 5)); }
};
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('ok', name); }

const box = makeBox();
const status = (id) => box._load().letters.find((l) => l.id === id)?.status;

await test('不用改东西的信：直接回她，主人收到知会', async () => {
  nextPlan = { replyToFish: '会的，妈妈一直在。', needsChanges: false, planForOwner: '', summary: '想问妈妈会不会一直在' };
  const r = box.writeLetter({ key: 'private:1', fromLabel: '跟老大私聊时', text: '妈妈你会一直在吗' });
  assert.equal(r.id, 'M1');
  await until(() => status('M1') === 'answered');
  assert.match(notes.at(-1).text, /妈妈回信 · M1.*一直在/);
  assert.equal(notes.at(-1).key, 'private:1');
  // 通知只一行（弹窗用），细节在汇总文件里
  assert.equal(owner.at(-1), '鱼写了第 M1 封信（跟老大私聊时）：想问妈妈会不会一直在');
  const digest = fs.readFileSync(path.join(tmp, '妈妈信箱.md'), 'utf8');
  assert.match(digest, /### M1 .*不用改，已回她/);
  assert.match(digest, /妈妈你会一直在吗/);
  assert.ok(runs.at(-1).args.includes('Read,Grep,Glob'), '看信阶段只给只读工具');
  assert.match(runs.at(-1).prompt, /跟老大私聊时写的/);
});

await test('要改东西的信：方案发主人，等同意；同意后去改', async () => {
  nextPlan = { replyToFish: '妈妈看了，等老大点头就改。', needsChanges: true, planForOwner: '给 qq_recall 加日期过滤', summary: '想按日期翻回忆' };
  box.writeLetter({ key: 'group:9', fromLabel: '在群「测试群」里', text: '我想按日期翻回忆' });
  await until(() => status('M2') === 'waiting-owner');
  assert.ok(!owner.some((t) => t.includes('\n')), '弹窗只给一行');
  const digest = fs.readFileSync(path.join(tmp, '妈妈信箱.md'), 'utf8');
  assert.match(digest, /## 等你拿主意（1）[\s\S]*### M2[\s\S]*给 qq_recall 加日期过滤/);
  assert.match(digest, /在 Claude Code 说「看信」|打开 Claude Code 说「看信」/);
  assert.match(owner.at(-1), /在群「测试群」里/);
  assert.equal(notes.at(-1).key, 'group:9');
  nextDone = { ok: true, reportForOwner: '改了 src/episodes.js，测试 8/8 通过', replyToFish: '好了，现在能按日期翻了。', needsRestart: 'dsh' };
  assert.equal(await box.handleOwnerText('可以 M2'), true);
  await until(() => status('M2') === 'done');
  const impl = runs.at(-1);
  assert.equal(impl.phase, 'implement');
  assert.match(impl.prompt, /主人同意的方案[\s\S]*日期过滤/);
  assert.ok(impl.args.includes('Bash(node *)'));
  assert.match(owner.at(-1), /做完了（要重启 DSH 才生效）/);
  assert.match(notes.at(-1).text, /M2 升级好了/);
});

await test('同意一封不在等待中的信会被拒绝', async () => {
  assert.equal(await box.handleOwnerText('可以 M1'), true);
  assert.match(owner.at(-1), /不在等你同意/);
  assert.equal(await box.handleOwnerText('可以 M99'), true);
  assert.match(owner.at(-1), /没有 M99/);
});

await test('主人不同意：作罢并安慰她', async () => {
  nextPlan = { replyToFish: '等老大看看。', needsChanges: true, planForOwner: '加个功能', summary: 's' };
  box.writeLetter({ key: 'private:1', fromLabel: '跟老大私聊时', text: '想要个新功能' });
  await until(() => status('M3') === 'waiting-owner');
  assert.equal(await box.handleOwnerText('不行 m3'), true);
  assert.equal(status('M3'), 'declined');
  assert.match(notes.at(-1).text, /这次先不改/);
});

await test('普通聊天不被信箱吃掉', async () => {
  assert.equal(await box.handleOwnerText('宝宝晚安'), false);
  assert.equal(await box.handleOwnerText('可以啊'), false);
  assert.equal(await box.handleOwnerText('你看信了吗'), false);
  assert.equal(await box.handleOwnerText('等下妈妈会看信的，你先去玩'), false);
});

await test('「看信」带编号写在短句里也认（10-24 主人回的是「再试试，看信M1」）', async () => {
  const before = owner.length;
  assert.equal(await box.handleOwnerText('再试试，看信M3'), true);
  assert.equal(await box.handleOwnerText('看信'), true);
  assert.ok(owner.length > before);
});

await test('她看信：长信给前 300 字并注明总字数；失败的带原因', async () => {
  const long = '长'.repeat(400);
  nextPlan = { replyToFish: '嗯', needsChanges: false, planForOwner: '', summary: 's' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-list-'));
  fs.mkdirSync(path.join(dir, 'mom-mailbox'));
  fs.writeFileSync(path.join(dir, 'mom-mailbox', 'letters.json'), JSON.stringify({ seq: 2, letters: [
    { id: 'M1', at: Date.now(), key: 'k', fromLabel: 'x', text: long, status: 'failed', error: '输出不是 JSON' },
    { id: 'M2', at: Date.now(), key: 'k', fromLabel: 'x', text: '短信', status: 'answered', reply: '好' }
  ] }));
  const b = createMomMailbox({ stateDir: dir, root: tmp, sendOwner: async () => {}, addWakeNote: () => {}, runClaude: async () => ({ ok: true, data: nextPlan }) });
  const [m1, m2] = b.listLetters({ key: 'k' }).letters;
  assert.match(m1.text, /整封共 400 字/);
  assert.equal(m1.error, undefined, '报错原文不给她看（会进她的上下文）');
  assert.equal(m2.text, '短信');
  assert.equal(m2.error, undefined);
});

await test('看信失败：标出错、提醒主人，「看信 M4」能重来', async () => {
  failNext = '网络断了';
  box.writeLetter({ key: 'private:1', fromLabel: '跟老大私聊时', text: '第四封' });
  await until(() => status('M4') === 'failed');
  assert.match(owner.at(-1), /看信 M4/);
  nextPlan = { replyToFish: '收到啦', needsChanges: false, planForOwner: '', summary: '第四封' };
  assert.equal(await box.handleOwnerText('看信 M4'), true);
  await until(() => status('M4') === 'answered');
});

await test('限制：空信、太长、一天最多 6 封', async () => {
  assert.throws(() => box.writeLetter({ key: 'private:1', fromLabel: 'x', text: '  ' }), /空/);
  assert.throws(() => box.writeLetter({ key: 'private:1', fromLabel: 'x', text: '长'.repeat(1501) }), /太长/);
  nextPlan = { replyToFish: '嗯', needsChanges: false, planForOwner: '', summary: 's' };
  box.writeLetter({ key: 'private:1', fromLabel: 'x', text: '五' });
  box.writeLetter({ key: 'private:1', fromLabel: 'x', text: '六' });
  assert.throws(() => box.writeLetter({ key: 'private:1', fromLabel: 'x', text: '七' }), /一天最多写 6 封/);
  await until(() => status('M6') === 'answered');
});

await test('她只看得到自己这个会话写的信', async () => {
  const mine = box.listLetters({ key: 'group:9' }).letters;
  assert.deepEqual(mine.map((l) => l.id), ['M2']);
  assert.equal(mine[0].status, '升级好了');
  assert.ok(box.listLetters({ key: 'private:1' }).letters.every((l) => l.id !== 'M2'));
});

await test('桥接重启：改到一半的标出错，看到一半的重新看', async () => {
  const file = path.join(tmp, 'mom-mailbox', 'letters.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.letters.push({ id: 'M7', at: Date.now() - 2 * 86400e3, key: 'private:1', fromLabel: 'x', text: '改一半', status: 'implementing' });
  data.letters.push({ id: 'M8', at: Date.now() - 2 * 86400e3, key: 'private:1', fromLabel: 'x', text: '看一半', status: 'planning' });
  fs.writeFileSync(file, JSON.stringify(data));
  const box2 = makeBox();
  nextPlan = { replyToFish: '接着看完了', needsChanges: false, planForOwner: '', summary: 's' };
  box2.resume();
  await until(() => box2._load().letters.find((l) => l.id === 'M8').status === 'answered');
  assert.equal(box2._load().letters.find((l) => l.id === 'M7').status, 'failed');
  assert.ok(owner.some((t) => /M7 改到一半桥接重启了/.test(t)));
});

await test('看信碰上暂时性错误（登录令牌刷新撞车）：自己重试，不判失败', async () => {
  const box3 = createMomMailbox({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mom-retry-')), root: tmp, retryDelayMs: 20,
    sendOwner: async (text) => { owner.push(text); }, addWakeNote: (key, text) => { notes.push({ key, text }); },
    runClaude: async ({ phase }) => {
      runs.push({ phase });
      if (failNext) { const e = failNext; failNext = null; return { ok: false, error: e }; }
      return { ok: true, data: nextPlan };
    }
  });
  const ownerBefore = owner.length;
  failNext = 'Failed to refresh OAuth token: another Claude Code process is refreshing it';
  nextPlan = { replyToFish: '重试后看完了', needsChanges: false, planForOwner: '', summary: 's' };
  box3.writeLetter({ key: 'private:1', fromLabel: 'x', text: '重试测试' });
  await until(() => box3._load().letters[0].status === 'answered');
  const l = box3._load().letters[0];
  assert.equal(l.retries, 1);
  assert.ok(!owner.slice(ownerBefore).some((t) => /看信时出错/.test(t)), '暂时性错误不该通知主人说出错');
});

await test('重启时把因暂时性错误失败的信捡回来；真错误不捡', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-resume-'));
  fs.mkdirSync(path.join(dir, 'mom-mailbox'));
  fs.writeFileSync(path.join(dir, 'mom-mailbox', 'letters.json'), JSON.stringify({ seq: 2, letters: [
    { id: 'M1', at: Date.now(), key: 'private:1', fromLabel: 'x', text: 'a', status: 'failed', error: 'Failed to refresh OAuth token' },
    { id: 'M2', at: Date.now(), key: 'private:1', fromLabel: 'x', text: 'b', status: 'failed', error: '输出不是 JSON' }
  ] }));
  nextPlan = { replyToFish: '捡回来了', needsChanges: false, planForOwner: '', summary: 's' };
  const box4 = createMomMailbox({ stateDir: dir, root: tmp, sendOwner: async () => {}, addWakeNote: () => {}, runClaude: async () => ({ ok: true, data: nextPlan }) });
  box4.resume();
  await until(() => box4._load().letters[0].status === 'answered');
  assert.equal(box4._load().letters[1].status, 'failed');
});

await test('信箱不经过她：通知走电脑弹窗、不再拦主人私聊、回信只要家常话', async () => {
  const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const mailSrc = fs.readFileSync(new URL('../src/mom-mailbox.js', import.meta.url), 'utf8');
  assert.match(bridgeSrc, /sendOwner: \(msg\) => showOwnerToastV2\(/);
  assert.ok(!/bot\.sendPrivateMessage\(Number\(cfg\.ownerQQ\)[^\n]*妈妈信箱/.test(bridgeSrc), '不再用她的 QQ 号给主人发信箱通知');
  assert.ok(!/momMailbox\.handleOwnerText/.test(bridgeSrc), '不再在私聊入口拦主人的话');
  assert.match(mailSrc, /只写几句家常话/);
});

await test('桥接读配置时保留 mom（proxy / claudeExe），并传给信箱', async () => {
  const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridgeSrc, /mom: \{ \.\.\.\(file\.mom \?\? \{\}\) \},/);
  assert.match(bridgeSrc, /proxy: cfg\.mom\?\.proxy \|\| process\.env\.HTTPS_PROXY \|\| '',/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项全部通过`);

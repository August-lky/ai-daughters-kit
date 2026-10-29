// 活人感这一轮（2026-10-24，对照小黑盒那份部署后主人同意的几项）：
// 固定说明一个会话给一次、自己最近写的碎碎念、他在听的歌、报错不往 QQ 发、卡住了说大白话、音游手感靠练。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const slice = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + 1); assert.ok(a > 0 && b > a, `找不到 ${from}`); return src.slice(a, b); };

// ① staticDueV2：开新会话、会话换了、压缩过、隔了一天才再给
{
  const fn = slice('  function staticDueV2(key, reason, st) {', '  function buildWakePromptV2(key, reason) {');
  const state = { sessions: { k: 'sid-1' } };
  let comps = 0;
  const due = new Function('state', 'compactionCountV2', `${fn}\nreturn staticDueV2;`)(state, () => comps);
  const st = {};
  assert.equal(due('k', 'ownerIdle', st), true, '第一次要给');
  assert.equal(due('k', 'ownerIdle', st), false, '同一个会话第二次不给');
  assert.equal(due('k', 'bootstrap', st), true, '开新会话总给');
  assert.equal(due('k', 'private', st), false);
  comps = 1;
  assert.equal(due('k', 'private', st), true, '压缩过要再给');
  assert.equal(due('k', 'private', st), false);
  state.sessions.k = 'sid-2';
  assert.equal(due('k', 'private', st), true, '换了会话要再给');
  st.staticShown.at -= 25 * 3600 * 1000;
  assert.equal(due('k', 'private', st), true, '隔了一天再给');
  ok('固定说明：一个会话给一次；换会话、压缩、隔一天再给');
}

// ② 接线：这些块不到时候就清空；电脑那块的说明跟着走
{
  const body = slice('  function buildWakePromptV2(key, reason) {', '    const base = roleLine');
  assert.match(body, /const staticDue = staticDueV2\(key, reason, st\);/);
  for (const v of ['antiAiLine', 'replyLine', 'preSleepLine', 'desktopPetLine', 'handoffLine', 'watchLine', 'watchStartLine', 'watchBackLine', 'watchFailLine', 'proactiveLine', 'stickerLine', 'ramblingLine']) {
    assert.match(body, new RegExp(`let ${v} = `), `${v} 要能清空`);
    assert.match(body, new RegExp(`${v} = ''`), `${v} 不到时候要清空`);
  }
  assert.match(body, /buildOwnerPcBriefV2\(key, \{ withGuide: staticDue \}\)/);
  assert.match(src, /\+ pcLine \+ booksLine \+ novelLine \+ ramblingLine \+ desktopPetLine/);
  ok('接线：12 块固定内容不到时候就不带；电脑那块平时只给事实');
}

// ③ 碎碎念：最近两天的原话，最多约 700 字，留最新的
{
  const fn = slice('  const RAMBLING_FILE_V2 = ', '  function buildMemoryBooksLineV2() {').replace(/const RAMBLING_FILE_V2 = [^\n]*\n/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramb-'));
  const file = path.join(dir, '碎碎念.md');
  const build = new Function('fs', 'RAMBLING_FILE_V2', `${fn}\nreturn buildRecentRamblingV2;`)(fs, file);
  assert.equal(build(), '', '没有本子就不带');
  fs.writeFileSync(file, '\n——10月22日 周四——\n很久以前的事\n\n——10月23日 周五——\n昨天下雨了\n\n——10月24日 周六——\n今天打音游输了\n还想再来一把\n');
  const out = build();
  assert.match(out, /^【你最近写的碎碎念】（你自己写的原话）\n——10月23日——\n昨天下雨了\n——10月24日——\n今天打音游输了\n还想再来一把\n\n$/);
  assert.ok(!out.includes('很久以前'), '只要最近两天');
  fs.writeFileSync(file, `——10月24日 周六——\n${'字'.repeat(3000)}结尾`);
  const long = build();
  assert.ok(long.includes('……') && long.includes('结尾') && long.length < 800, '太长只留最新的');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('碎碎念：最近两天原话、只给新的、太长截前面');
}

// ④ 他在听的歌；⑤ 报错不往 QQ 发；⑥ 卡住了说大白话
{
  assert.match(src, /m: j\.m && typeof j\.m === 'object' \? j\.m : null/);
  assert.match(src, /const songLine = nowSong\?\.title \? `【他在听】《/);
  assert.match(src, /realNow\(\)\.getTime\(\) - Date\.parse\(r\.at\) < 2 \* 60 \* 1000/);
  const ps = fs.readFileSync(new URL('../pc-watch.ps1', import.meta.url), 'utf8');
  assert.match(ps, /function Get-NowPlaying/);
  assert.match(ps, /cliprofile\|browser-profile\|playwright/, '她自己的浏览器不算');
  assert.ok(![...ps].some((c) => c.charCodeAt(0) > 127), 'pc-watch.ps1 必须全 ASCII（5.1 读 UTF-8 无 BOM 会乱）');
  ok('他在听：pc-watch 读 Windows「正在播放」，两分钟内的才算');

  assert.ok(!/^\s*await sendToQQ\(key, `⚠️ agent 处理出错/m.test(src), 'agent 报错不发 QQ');
  assert.ok(!/await sendToQQ\(key, `⚠️ 消息未被接受/.test(src), '消息未被接受不发 QQ');
  assert.equal(JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).security?.interceptNotify, false);
  // 2026-10-29 老大（松绑）：从「卡住了也要说」改成「可以跟老大说，也可以写信给妈妈」，她自己定。
  assert.match(src, /let watchFailLine = '【卡住了】[^']*可以跟老大说一声，用大白话[^']*也可以写信给妈妈（qq_mom_mailbox）[^']*怎么办你自己定/);
  ok('报错只记日志不发 QQ；卡住了可以跟老大说大白话、也可以写给妈妈，她自己定');
}

// ⑦ 音游：手感靠练，她传的准度参数不生效
{
  const reflex = fs.readFileSync(new URL('../browser/whale-reflex.js', import.meta.url), 'utf8');
  assert.match(reflex, /const f = feel\(\);\n\s+opts = \{\n\s+jitterMs: f\.jitterMs,/);
  assert.ok(!/Number\(o\.jitterMs/.test(reflex) && !/Number\(o\.missRate/.test(reflex), '她传的 jitterMs / missRate 不再生效');
  assert.match(reflex, /offsetMs: Math\.min\(100, Math\.max\(-100, Number\(o\.offsetMs \?\? 0\)\)\)/);
  const feelSrc = reflex.slice(reflex.indexOf('    function feel() {'), reflex.indexOf('    /** 结算界面出来'));
  const store = {};
  global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  global.location = { search: '?song=qiuyuying&difficulty=ez&keyCount=2' };
  global.document = { querySelectorAll: () => ({ length: 2 }) };
  // 以前打的也算练过（2026-10-25）：PRIOR 从源码里取，加在本子记的局数上
  const prior = new Function(`${reflex.match(/const PRIOR = [^;]+;/)[0]}\nreturn PRIOR;`)();
  assert.ok(prior.total > 0, '补了以前的练习');
  const feel = new Function('PRACTICE_KEY', 'DIFF_LOAD', 'PRIOR', 'practiceKey', 'loadPractice', `${feelSrc}\nreturn feel;`)(
    '__whalePractice', { ez: 0, nm: 0.15, hd: 0.3, ex: 0.45 }, { total: prior.total, songs: { qiuyuying: 2 } }, () => 'qiuyuying|ez|2k', () => JSON.parse(store.__whalePractice || '{}'));
  const beginner = feel();
  assert.equal(beginner.totalPlays, prior.total, '本子是空的也算上以前打过的局');
  assert.equal(beginner.songPlays, 2, '这首以前打过几遍也算上');
  store.__whalePractice = JSON.stringify({ total: 60, songs: { 'qiuyuying|ez|2k': { plays: 20 } } });
  const practiced = feel();
  assert.ok(beginner.jitterMs > practiced.jitterMs && beginner.missRate > practiced.missRate, '练得越多越稳');
  assert.ok(practiced.missRate > 0 && practiced.jitterMs > 0, '永远不是机器');
  ok(`音游手感：新手 ±${beginner.jitterMs}ms 漏${beginner.missRate} → 练过 ±${practiced.jitterMs}ms 漏${practiced.missRate}`);
}

console.log(`全部通过：${passed} 组`);

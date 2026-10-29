// 印象（src/impressions.js）：记一笔、无视、道歉、慢慢恢复、豁免、在场的人才显示。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImpressions, apologizing, effectiveScore } from '../src/impressions.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
const file = path.join(dir, 'impressions.json');
const T = 1_800_000_000_000;
const DAY = 86400e3;

// ① 记一笔、到底、无视、豁免
{
  const im = createImpressions(file, { exempt: ['10051'] });
  assert.throws(() => im.update('abc', { delta: -1 }), /QQ 号/);
  im.update('10035', { delta: -2, note: '骂小鲸鱼是破AI', name: '群友257', now: T });
  assert.equal(im.scoreOf('10035', T), -2);
  assert.equal(im.ignored('10035', T), false);
  im.update('10035', { delta: -5, note: '又来挑衅', now: T });
  assert.equal(im.scoreOf('10035', T), -3, '最多到 -3');
  assert.equal(im.ignored('10035', T), true, '-3 就无视');
  im.update('10051', { score: -3, now: T });
  assert.equal(im.ignored('10051', T), false, '老大永远不会被无视');
  im.update('111111111', { score: 2, note: '一起打音游', now: T });
  ok('记一笔、最多 -3、-3 无视、老大豁免');
}

// ② 慢慢恢复：坏印象每 7 天升一档到 0；好印象不掉；新记一笔从现在的档位算
{
  const im = createImpressions(file);
  assert.equal(im.scoreOf('10035', T + 6 * DAY), -3);
  assert.equal(im.scoreOf('10035', T + 7 * DAY), -2, '一周升一档');
  assert.equal(im.ignored('10035', T + 7 * DAY), false, '不再无视');
  assert.equal(im.scoreOf('10035', T + 40 * DAY), 0, '最多回到一般');
  assert.equal(im.scoreOf('111111111', T + 40 * DAY), 2, '好印象不会自己掉');
  im.update('10035', { delta: 1, note: '道歉了', now: T + 7 * DAY });
  assert.equal(im.scoreOf('10035', T + 7 * DAY), -1, '从恢复后的 -2 再 +1');
  assert.equal(effectiveScore(null), 0);
  ok('坏印象一周回一档、最多回到一般；好印象不掉；道歉加分从现在算');
}

// ③ 道歉、在场的人才显示
{
  assert.equal(apologizing('对不起啊刚才说过分了'), true);
  assert.equal(apologizing('sorry 我错了'), true);
  assert.equal(apologizing('你个破AI'), false);
  const im = createImpressions(file);
  const b = im.block(['10035', '111111111', '999999999'], { now: T + 7 * DAY });
  assert.ok(b.includes('群友257（10035）：不太喜欢') && b.includes('道歉了'), b);
  assert.ok(b.includes('（111111111）：喜欢'));
  assert.ok(!b.includes('999999999'), '没印象的人不写');
  assert.equal(im.block(['999999999']), '');
  ok('像在道歉能认出来；只显示在场、有印象的人');
}

// ④ 另一个进程改了文件，这边读得到
{
  const a = createImpressions(file);
  const b = createImpressions(file);
  a.get('111111111');
  b.update('222222222', { score: -1, note: '刷屏', now: T });
  assert.equal(a.scoreOf('222222222', T), -1, '别的进程写的能读到');
  ok('两个进程共用一个文件不打架');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

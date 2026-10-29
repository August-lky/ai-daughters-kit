// 生活不停（2026-10-24）：睡着时记一笔、醒来说一次、再睡下清掉说过的；桥接接线。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createAsleepLog } from '../src/asleep-log.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asleep-'));
const file = path.join(dir, 'asleep-log.json');
const t0 = Date.parse('2026-10-24T15:00:00Z');
const clock = (ms) => `${(ms - t0) / 60000}分`;
const titleOf = (key) => ({ 'group:1': '鲸鱼窝', 'group:2': '摸鱼群' }[key] || '');

let log = createAsleepLog(file);
assert.equal(log.digest({ titleOf, clock }), '', '没人找就没有这块');
log.record({ at: t0, key: 'group:1', kind: 'group', who: '阿猫', text: '今晚吃啥' });
log.record({ at: t0 + 60000, key: 'group:1', kind: 'group', who: '阿狗', text: '@小鲸鱼 你睡了吗', atMe: true });
log.record({ at: t0 + 120000, key: 'group:1', kind: 'group', who: '阿猫', text: '火锅！' });
log.record({ at: t0 + 180000, key: 'private:9', kind: 'private', who: '群友236', text: '在吗' });
log.record({ at: t0 + 240000, key: 'private:9', kind: 'private', who: '群友236', text: '明天一起刷视频' });
log.record({ at: t0 + 300000, key: 'group:2', kind: 'poke', who: '阿狗' });
assert.equal(log.pending(), 6);
ok('记下群消息、私聊、拍一拍');

log = createAsleepLog(file);
assert.equal(log.pending(), 6, '桥接重启也不丢');
const text = log.digest({ titleOf, clock });
assert.match(text, /^【你睡着的时候】/);
assert.match(text, /群「鲸鱼窝」：3 条，2 个人在聊（0分～2分）；有 1 条是冲你来的：阿狗「@小鲸鱼 你睡了吗」；最后聊到：阿猫「今晚吃啥」，阿猫「火锅！」/);
assert.match(text, /群友236 私聊你 2 条（3分 起）：「在吗」……最后一条「明天一起刷视频」/);
assert.match(text, /阿狗 在群「摸鱼群」拍了拍你/);
assert.match(text, /回不回、回谁、怎么回，你自己定/);
ok('醒来那段：群按人数和冲她来的、私聊首尾两句、拍一拍');

assert.equal(log.digest({ titleOf, clock }), '', '说过一次就不再说');
log.record({ at: t0 + 400000, key: 'private:9', kind: 'private', who: '群友236', text: '人呢' });
assert.match(log.digest({ titleOf, clock, markTold: false }), /群友236 私聊你 1 条/);
log.dropTold();
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 1, '再睡下时清掉说过的，没说过的留着');
ok('只说一次；再睡下清掉说过的');

log = createAsleepLog(file, { max: 5 });
for (let i = 0; i < 20; i += 1) log.record({ at: t0 + i, key: 'group:1', kind: 'group', who: `人${i}`, text: 'x'.repeat(200) });
const saved = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
assert.equal(saved.length, 5, '有上限');
assert.ok([...saved[0].text].length <= 81, '每条截短');
ok('有上限、每条截短');

fs.writeFileSync(file, '{坏的');
assert.equal(createAsleepLog(file).digest(), '', '文件坏了当空的');
ok('文件坏了不出错');
fs.rmSync(dir, { recursive: true, force: true });

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
assert.match(src, /asleepLog\.record\(\{ key, kind, who: event\.sender\?\.card/);
assert.match(src, /asleepLog\.record\(\{ key, kind: 'poke'/);
assert.match(src, /function enterSleep\(reason, \{ hours, until, natural \} = \{\}\) \{[\s\S]{0,900}?asleepLog\.dropTold\(\);/); // 2026-10-29：睡到自然醒加了 natural，dropTold 前面多了几行
assert.match(src, /const asleepLine = isOwnerPrivateSession \? asleepLog\.digest\(/);
assert.match(src, /\+ sleepLine \+ asleepLine \+ crossSessionLine \+/);
assert.ok(!/丢弃 \$\{key\} 的消息（睡着中/.test(src), '不再直接丢');
ok('接线：睡着时记、拍她的也记、再睡下清、只在跟老大的私聊里说');

console.log(`全部通过：${passed} 组`);

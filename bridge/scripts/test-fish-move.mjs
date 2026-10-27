// 搬家时带鱼的记忆（src/fish-move.js）离线自检：临时目录、合成库，不碰桥接、DSH 和 ~/.dsh。
// 起因：2026-10-25 群「群聊」搬家，旧会话从没开过鱼的记忆、没有文件 → ENOENT → 记成「-1 条」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fishEnabled, fishStorePath, migrateFishMemory } from '../src/fish-move.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-move-'));
  const fishDir = path.join(root, 'fish-memory'); const backupDir = path.join(root, 'fish-memory-backup');
  fs.mkdirSync(fishDir); fs.mkdirSync(backupDir);
  return { root, fishDir, backupDir, cfgFile: path.join(root, 'fish-memory-config.json') };
};
const mem = (id, text = `记忆${id}`) => ({ id, text, at: '2026-10-24T10:00:00Z', importance: 3 });
const store = (ids, extra = {}) => ({ version: 2, policy: {}, memories: ids.map((i) => mem(i)), traces: [{ t: 1 }], deleted: [], ...extra });
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ① 正常：旧会话有库 → 全带过去、traces 清空、新开旧关（跟原来一样）
{
  const e = fresh();
  writeJson(fishStorePath(e.fishDir, 'session-old'), store(['a', 'b', 'c']));
  writeJson(e.cfgFile, { sessions: { 'session-old': true, 'session-x': true }, userPronoun: '主人' });
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 3); assert.equal(r.from, 'session-old.json'); assert.equal(r.enabled, true);
  const out = readJson(fishStorePath(e.fishDir, 'session-new'));
  assert.deepEqual(out.memories.map((m) => m.id), ['a', 'b', 'c']); assert.deepEqual(out.traces, []);
  const cfg = readJson(e.cfgFile);
  assert.equal(cfg.sessions['session-new'], true); assert.equal(cfg.sessions['session-old'], false);
  assert.equal(cfg.sessions['session-x'], true); assert.equal(cfg.userPronoun, '主人');
  ok('旧会话有库：全带过去，traces 清空，新会话打开、旧会话关掉，别的配置不动');
}

// ② 10-25 的情况：旧会话没开过、没有文件、哪儿都没有 → 0 条（不是 -1、不抛错），新会话不擅自打开，配置不改
{
  const e = fresh();
  const before = { sessions: { 'session-other': true } };
  writeJson(e.cfgFile, before);
  const history = [{ key: 'group:9', oldSid: 'session-g0', newSid: 'session-g1' }, { key: 'group:9', oldSid: 'session-g1', newSid: 'session-old' }];
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new', history });
  assert.equal(r.count, 0); assert.equal(r.from, ''); assert.equal(r.enabled, false);
  assert.equal(fs.existsSync(fishStorePath(e.fishDir, 'session-new')), false);
  assert.deepEqual(readJson(e.cfgFile), before);
  ok('旧会话从没开过鱼的记忆（没有文件、链上也没有）：0 条，不建空文件，开关不擅自改');
}

// ③ 旧会话开着但还没写过文件 → 0 条，开关跟过去
{
  const e = fresh();
  writeJson(e.cfgFile, { sessions: { 'session-old': true } });
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 0); assert.equal(r.enabled, true);
  const cfg = readJson(e.cfgFile);
  assert.equal(cfg.sessions['session-new'], true); assert.equal(cfg.sessions['session-old'], false);
  ok('旧会话开着但没文件：0 条，新会话照样打开');
}

// ④ 旧文件没了，但 .bak / 每日备份还在 → 从备份带，不丢
{
  const e = fresh();
  writeJson(`${fishStorePath(e.fishDir, 'session-old')}.bak`, store(['k1', 'k2']));
  let r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 2); assert.equal(r.from, 'session-old.json.bak'); assert.equal(r.enabled, true);
  assert.equal(readJson(e.cfgFile).sessions['session-new'], true, '没有配置文件时新建一份');

  const e2 = fresh();
  fs.mkdirSync(path.join(e2.backupDir, '2026-10-23')); fs.mkdirSync(path.join(e2.backupDir, '2026-10-24'));
  writeJson(path.join(e2.backupDir, '2026-10-23', 'session-old.json'), store(['old']));
  writeJson(path.join(e2.backupDir, '2026-10-24', 'session-old.json'), store(['d1', 'd2', 'd3']));
  r = migrateFishMemory({ ...e2, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 3); assert.equal(r.from, '备份 2026-10-24');
  ok('旧文件不在：先找 .bak，再找最新一天的每日备份');
}

// ⑤ 上一次搬家没搬成（中间那个会话没文件）→ 顺着 session-moves 往前找到还在的那份
{
  const e = fresh();
  writeJson(fishStorePath(e.fishDir, 'session-g0'), store(['g1', 'g2']));
  writeJson(e.cfgFile, { sessions: { 'session-g0': false } });
  const history = [
    { key: 'group:9', oldSid: 'session-g0', newSid: 'session-g1', fish: -1 },
    { key: 'group:9', oldSid: 'session-g1', newSid: 'session-old', fish: -1 },
    { key: 'group:8', oldSid: 'session-zz', newSid: 'session-yy' },
  ];
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new', history });
  assert.equal(r.count, 2); assert.ok(r.from.startsWith('更早的会话 session-g0'), r.from); assert.equal(r.enabled, true);
  // 链里成环也不会死循环
  const loop = [{ oldSid: 'session-a', newSid: 'session-b' }, { oldSid: 'session-b', newSid: 'session-a' }];
  assert.equal(migrateFishMemory({ ...fresh(), oldSid: 'session-a', newSid: 'session-c', history: loop }).count, 0);
  ok('旧会话没文件：顺着搬家链往前找；链成环也能停');
}

// ⑥ 新会话里已经有记忆（她进门就 remember 了 / 插件分支继承）→ 合并、按 id 去重，不盖掉
{
  const e = fresh();
  writeJson(fishStorePath(e.fishDir, 'session-old'), store(['a', 'b']));
  writeJson(fishStorePath(e.fishDir, 'session-new'), store(['b', 'n1'], { traces: [{ t: 9 }] }));
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 1); assert.equal(r.kept, 2);
  const out = readJson(fishStorePath(e.fishDir, 'session-new'));
  assert.deepEqual(out.memories.map((m) => m.id), ['b', 'n1', 'a']); assert.deepEqual(out.traces, [{ t: 9 }]);
  ok('新会话已有记忆：合并去重，新会话自己的留着');
}

// ⑦ 旧文件坏了 → 记下原因、退到 .bak；配置文件坏了 → 抛错（调用方记 -1），不覆盖
{
  const e = fresh();
  fs.writeFileSync(fishStorePath(e.fishDir, 'session-old'), '{坏');
  writeJson(`${fishStorePath(e.fishDir, 'session-old')}.bak`, store(['x']));
  const r = migrateFishMemory({ ...e, oldSid: 'session-old', newSid: 'session-new' });
  assert.equal(r.count, 1); assert.ok(r.problems.some((p) => p.includes('坏了')), r.problems.join('|'));

  const e2 = fresh();
  writeJson(fishStorePath(e2.fishDir, 'session-old'), store(['x']));
  fs.writeFileSync(e2.cfgFile, '{坏');
  assert.throws(() => migrateFishMemory({ ...e2, oldSid: 'session-old', newSid: 'session-new' }), /不敢改/);
  assert.equal(fs.readFileSync(e2.cfgFile, 'utf8'), '{坏');
  ok('旧库坏了退到 .bak；配置坏了抛错且不覆盖');
}

// ⑧ 同一秒两个群一起搬：两次调用各改各的，开关互不覆盖（10-25 07:31 两个群同时搬）
{
  const e = fresh();
  writeJson(fishStorePath(e.fishDir, 'session-a-old'), store(Array.from({ length: 19 }, (_, i) => `a${i}`)));
  writeJson(e.cfgFile, { sessions: { 'session-a-old': true } });
  const ra = migrateFishMemory({ ...e, oldSid: 'session-a-old', newSid: 'session-a-new' });
  const rb = migrateFishMemory({ ...e, oldSid: 'session-b-old', newSid: 'session-b-new' });
  assert.equal(ra.count, 19); assert.equal(rb.count, 0);
  const cfg = readJson(e.cfgFile);
  assert.equal(cfg.sessions['session-a-new'], true); assert.equal(cfg.sessions['session-a-old'], false);
  assert.equal(fishEnabled(cfg, 'session-b-new'), false);
  ok('两个群同一秒搬：19 条 / 0 条，配置互不覆盖');
}

// ⑨ 文件名规则跟插件一致；fishEnabled 兼容旧版 enabled 名单
{
  assert.equal(path.basename(fishStorePath('d', 'session-1/../x')), 'session-1____x.json');
  assert.equal(fishEnabled({ enabled: ['s1'] }, 's1'), true);
  assert.equal(fishEnabled({ sessions: { s1: false }, enabled: ['s1'] }, 's1'), false);
  assert.equal(fishEnabled({}, 's1'), false);
  ok('文件名、开关判断跟插件同一个规则');
}

console.log(`\n${passed} 项通过`);

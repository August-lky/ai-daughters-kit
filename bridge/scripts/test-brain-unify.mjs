// 大脑搬家 + 统一记忆（2026-10-29 第四批上半）的行为测试：
//   · brains.js 别名 / 本子别名（主人 → 关于老大，给下一个我 → 交接）
//   · merge-fish-memory：旧会话合并、去重、不动原文件
//   · 社交记忆里对群友的印象：读时合并所有会话、标群名；删 / 清跨会话
//   · 便签所有会话都带：非主人私聊注明
//   · 检索服务的 Python 部分：is_novel_path 跟 novel.js 一致；索引不收 妈妈 / 作品 / 旧稿 / 瞬间 / 小说
// 不连任何活的服务（临时目录里造数据；Python 只 import 不起服务；不建向量库）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brainOf, resolveBrainId, canonicalBookName, bookExtraFileFor, bookDirsOf, BOOK_ALIASES } from '../src/brains.js';
import { isNovelPath, LEGACY_NOVEL_FILES } from '../src/novel.js';
import { createStickyNote } from '../src/freedom.js';
import { buildMerged, mergeFishMemory, inUseSessions } from './merge-fish-memory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log(`✅ ${m}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-unify-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });

// ── 1. 别名 ────────────────────────────────────────────────────────────────
{
  for (const a of ['whale', '小鲸鱼', '妹妹', '🐳', 'Whale', '', undefined]) assert.equal(resolveBrainId(a), 'whale', String(a));
  for (const a of ['sister', '姐姐', '克劳德', '📖']) assert.equal(resolveBrainId(a), 'sister', a);
  assert.equal(resolveBrainId('陌生人'), null);
  assert.throws(() => brainOf('陌生人'), /不认识的 brain/);
  assert.equal(brainOf('🐳'), brainOf('whale'));
  ok('brains.js：别名都认，不认识的报错，不悄悄用别人的脑子；没传就是小鲸鱼（兼容老调用）');
  assert.equal(canonicalBookName('主人'), '关于老大');
  assert.equal(canonicalBookName('主人.md'), '关于老大');
  assert.equal(canonicalBookName('老大'), '关于老大');
  assert.equal(canonicalBookName('日常'), '日常');
  assert.equal(BOOK_ALIASES['主人'], '关于老大');
  assert.equal(bookExtraFileFor('whale', '给下一个我'), brainOf('whale').handoff);
  assert.equal(bookExtraFileFor('whale', '交接.md'), brainOf('whale').handoff);
  assert.equal(bookExtraFileFor('whale', '日常'), '');
  const dirs = bookDirsOf('whale');
  assert.deepEqual(dirs, [brainOf('whale').longterm, brainOf('whale').notes]);
  assert.ok(fs.existsSync(path.join(brainOf('whale').longterm, '关于老大.md')), '主人.md 已改名 关于老大.md');
  assert.ok(!fs.existsSync(path.join(brainOf('whale').longterm, '主人.md')), '不再有「主人」这本（免得又新建一本）');
  ok('本子别名：主人→关于老大、给下一个我→交接；本子工具看 长期/ 和 笔记/');
}

// ── 2. 旧会话合并 ──────────────────────────────────────────────────────────
{
  const dsh = path.join(tmp, 'dsh');
  const fishDir = path.join(dsh, 'fish-memory');
  fs.mkdirSync(fishDir, { recursive: true });
  const S = (n) => `session-0000000${n}-0000-0000-0000-000000000000`;
  const mem = (id, text, key, at, extra = {}) => ({ id, text, at, createdAt: at, category: 'event', importance: 0.5, tags: [], ...(key ? { 事实键: key } : {}), ...extra });
  const put = (sid, memories) => fs.writeFileSync(path.join(fishDir, `${sid}.json`), JSON.stringify({ version: 2, policy: { threshold: 0.35 }, memories, traces: [{ x: 1 }], deleted: [] }));
  put(S(1), [mem('m1', '家在浏阳', '主人.家', '2026-10-19T00:00:00Z'), mem('m2', '喜欢初音', null, '2026-10-19T00:00:00Z')]); // 旧会话 1
  put(S(2), [mem('m1', '家在浏阳', '主人.家', '2026-10-19T00:00:00Z'), mem('m3', '家里背了债', '主人.家', '2026-10-22T00:00:00Z'), mem('m2x', '喜欢初音', null, '2026-10-20T00:00:00Z')]); // 旧会话 2：搬家带过去的复制 + 新的
  put(S(3), [mem('m4', '被取代的', null, '2026-10-20T00:00:00Z', { 已被取代: true }), mem('m5', '不用的', null, '2026-10-20T00:00:00Z', { refinedSkip: true }), mem('m6', '独有的一条', '主人.爱好', '2026-10-23T00:00:00Z')]);
  put(S(4), [mem('live1', '在用会话里的', null, '2026-10-28T00:00:00Z')]); // 在用，不合并
  fs.writeFileSync(path.join(dsh, 'fish-memory-links.json'), JSON.stringify({ groups: [{ sessions: { [S(4)]: '主人私聊', [path.join(tmp, 'x', '旧会话.json')]: '以前的会话' } }] }));
  const sessionsFile = path.join(tmp, 'sessions.json');
  fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: { 'private:1': S(4) } }));
  const before = fs.readdirSync(fishDir).map((f) => [f, fs.readFileSync(path.join(fishDir, f), 'utf8')]);

  const used = inUseSessions({ linksFile: path.join(dsh, 'fish-memory-links.json'), sessionsFile });
  assert.deepEqual([...used], [S(4)], '在用 = links 里的会话 + sessions.json 里的；路径键不算会话');
  const outFile = path.join(tmp, 'archive', 'remember-旧会话.json');
  const r1 = mergeFishMemory({ fishDir, linksFile: path.join(dsh, 'fish-memory-links.json'), sessionsFile, outFile, now: () => new Date('2026-10-29T00:00:00Z') });
  assert.equal(r1.files, 3);
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const texts = out.memories.map((m) => m.text).sort();
  assert.deepEqual(texts, ['喜欢初音', '家里背了债', '独有的一条'].sort(), `同一个事实键只留最新；被取代的 / refinedSkip 的不要；在用会话的不收。实际：${texts}`);
  assert.equal(out.memories.find((m) => m.事实键 === '主人.家').text, '家里背了债', '同键留最新（10-22 的盖住 10-19 的）');
  assert.equal(out.memories.find((m) => m.text === '喜欢初音').at, '2026-10-20T00:00:00Z', '没有事实键的同样的字也只留最新的');
  assert.ok(out.memories.every((m) => /^session-/.test(m.来自会话)), '每条记着来自哪个旧会话');
  assert.equal(out.version, 2); assert.deepEqual(out.traces, []);
  assert.deepEqual(before, fs.readdirSync(fishDir).map((f) => [f, fs.readFileSync(path.join(fishDir, f), 'utf8')]), '原文件一个字都没动');
  ok('merge-fish-memory：旧会话合并，同键留最新，去掉被取代的，在用的不收，原文件没动');

  // 再跑一次：幂等；旧会话文件以后被删了，合并档里的不丢
  const r2 = mergeFishMemory({ fishDir, linksFile: path.join(dsh, 'fish-memory-links.json'), sessionsFile, outFile });
  assert.equal(r2.after, 3);
  for (const n of [1, 2, 3]) fs.rmSync(path.join(fishDir, `${S(n)}.json`));
  const r3 = mergeFishMemory({ fishDir, linksFile: path.join(dsh, 'fish-memory-links.json'), sessionsFile, outFile });
  assert.equal(r3.after, 3, '旧会话文件没了，上一次的合并档还在，不丢');
  assert.equal(r3.files, 0);
  const dry = mergeFishMemory({ fishDir, linksFile: path.join(dsh, 'fish-memory-links.json'), sessionsFile, outFile: path.join(tmp, 'dry.json'), dry: true });
  assert.ok(!fs.existsSync(path.join(tmp, 'dry.json')) && dry.dry);
  ok('merge-fish-memory：再跑一次结果不变；旧会话文件被删了也不丢；--dry 不写盘');

  // 真数据的合并档（第 5 步已生成）：格式能被插件认
  const real = brainOf('whale').mergedFish;
  assert.ok(fs.existsSync(real), '真的旧会话合并档在 归档/ 里');
  const rj = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.ok(rj.version === 2 && Array.isArray(rj.memories) && rj.memories.length > 50 && rj.memories.length < 400);
  const keys = rj.memories.map((m) => m.事实键).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, '真的合并档里每个事实键只出现一次');
  ok(`真的合并档：${rj.memories.length} 条，每个事实键只出现一次`);
}

// ── 3. 对群友的印象：读时合并所有会话 ──────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const a = src.indexOf('  function mergedMemberImpressionsV2(own) {');
  const b = src.indexOf('  function appendMemoryV2(');
  assert.ok(a > 0 && b > a, '找得到合并印象的函数');
  const build = new Function('socialV2', 'sessionTitleForV2', `${src.slice(a, b)}\nreturn { mergedMemberImpressionsV2, formatMemoryV2 };`);
  const conv = (imp) => ({ memberImpressions: imp });
  const socialV2 = {
    conversations: new Map([
      ['group:111', conv({ 阿花: { traits: ['爱玩音游'], interactionCount: 3, lastSeenAt: 1000 }, 老王: { traits: ['话少'], interactionCount: 1, lastSeenAt: 500 } })],
      ['group:222', conv({ 阿花: { traits: ['爱玩音游', '会画画'], interactionCount: 2, lastSeenAt: 3000 } })],
      ['private:333', conv({ 老王: { traits: ['私下很温柔'], interactionCount: 4, lastSeenAt: 2000 } })]
    ])
  };
  const { mergedMemberImpressionsV2: merged, formatMemoryV2: fmt } = build(socialV2, (k) => ({ 'group:111': '群D', 'group:222': '小房子' })[k] || '');
  const m = merged(socialV2.conversations.get('group:111'));
  assert.deepEqual(m['阿花'].traits, ['爱玩音游', '会画画'], '特征取并集');
  assert.equal(m['阿花'].interactionCount, 5, '互动次数相加');
  assert.deepEqual(m['阿花'].where, ['群「群D」', '群「小房子」']);
  assert.deepEqual(m['老王'].where, ['群「群D」', '私聊里']);
  assert.deepEqual(Object.keys(m), ['老王', '阿花'], '按最近见到从旧到新排');
  const text = fmt(socialV2.conversations.get('private:333'));
  assert.match(text, /- 阿花：爱玩音游、会画画（互动 5 次；在群「群D」、群「小房子」记的）/, text);
  assert.match(text, /- 老王：话少、私下很温柔（互动 5 次；在群「群D」、私聊里记的）/, text);
  assert.equal(fmt({ memberImpressions: {} }, { merge: false }), '', 'merge:false 时不带出合并的印象');
  ok('对群友的印象：读的时候合并所有会话（特征并集、次数相加），标上是在哪几个群 / 私聊里记的');
  // 删 / 清跨会话（源码接线）
  assert.match(src, /for \(const c of socialV2\.conversations\.values\(\)\) if \(c\?\.memberImpressions[^\n]*delete c\.memberImpressions\[target\]/);
  assert.match(src, /for \(const c of socialV2\.conversations\.values\(\)\) if \(c\) c\.memberImpressions = \{\}/);
  ok('接线：删 / 清印象在所有会话里一起删（不然删了还会从别的会话冒出来）');
}

// ── 4. 便签所有会话都带 ────────────────────────────────────────────────────
{
  const note = createStickyNote({ file: path.join(tmp, 'sticky.md'), historyDir: path.join(tmp, 'hist') });
  assert.equal(note.append('明天提醒老大买药').ok, true);
  const owner = note.promptBlock();
  const group = note.promptBlock('（便签里有些是跟老大私聊时记的，在这里说不说、怎么说，你自己掂量。）');
  assert.equal(owner, '【便签（你自己记的，随你改）】\n明天提醒老大买药');
  assert.match(group, /^【便签（你自己记的，随你改）】\n（便签里有些是跟老大私聊时记的[^\n]*）\n明天提醒老大买药$/);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /const stickyLine = `\$\{stickyNote\.promptBlock\(isOwnerPrivateSession \? '' : STICKY_NOT_PRIVATE_NOTE\)\}\\n\\n`;/);
  ok('便签：所有会话的唤醒都带；不是主人私聊时标题后面注明「有些是私聊里记的」，内容原样');
}

// ── 5. Python：小说不进回忆 ────────────────────────────────────────────────
{
  const py = (code) => JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', `import sys, json\nsys.path.insert(0, r"${path.join(ROOT, 'brain')}")\nimport index\n${code}`], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  const probe = [
    path.join(ROOT, '共享', '合写', '半只耳朵——听不全那个字', '正文.md'),
    path.join(ROOT, '共享', '合写'),
    'D:/别处/共享/合写/某本书/设定.md',
    ...LEGACY_NOVEL_FILES,
    path.join(brainOf('whale').oldDrafts, '随便一份旧稿.md'),
    path.join(brainOf('whale').longterm, '日常.md'),
    path.join(brainOf('sister').rambling),
    path.join(ROOT, 'memory', 'memory.md')
  ];
  const pyRes = py(`PROBE = json.loads(${JSON.stringify(JSON.stringify(probe))})
print(json.dumps([index.is_novel_path(p) for p in PROBE]))`);
  const jsRes = probe.map((p) => isNovelPath(p));
  assert.deepEqual(pyRes, jsRes, `Python 和 novel.js 的规则不一致：\n${probe.map((p, i) => `${pyRes[i]} / ${jsRes[i]}  ${p}`).join('\n')}`);
  assert.deepEqual(jsRes.slice(0, 5), [true, true, true, true, true]);
  assert.deepEqual(jsRes.slice(5), [true, false, false, false]);
  ok('Python 的 is_novel_path 跟 novel.js 对同一批路径结论一致（合写目录、两份旧稿、旧稿目录算小说；别的本子不算）');

  const rows = py(`
out = {}
for bid, b in index.config().brains.items():
    srcs = [(k, rel) for k, p, rel in index.iter_sources(b)]
    out[bid] = {"n": len(srcs), "rels": [r for k, r in srcs], "kinds": sorted({k for k, r in srcs})}
print(json.dumps(out, ensure_ascii=False))`);
  for (const id of ['whale', 'sister']) {
    const joined = rows[id].rels.join('\n');
    assert.ok(rows[id].n > 0, `${id} 索引里应该有东西`);
    assert.ok(!/妈妈|旧稿|半只耳朵|作品|瞬间|归档|\.索引/.test(joined), `${id} 的索引不该收：${joined}`);
  }
  assert.ok(rows.whale.rels.includes('日子/碎碎念/碎碎念') && rows.whale.rels.includes('身份/soul') && rows.whale.rels.includes('长期/关于老大'));
  assert.ok(rows.sister.rels.some((r) => r.startsWith('聊天记录/')), '姐姐的索引把 sister/聊天记录 也算进去');
  assert.ok(rows.sister.rels.includes('身份/我自己'));
  // 2026-10-29 第五批（老大：「给妹妹也做成一样吧」）：小鲸鱼也有自己的聊天记录（家/小鲸鱼/聊天记录），跟姐姐的各编各的，不混
  const extras = py(`print(json.dumps({bid: [[str(p).replace(chr(92), "/"), k] for p, k in b.extra] for bid, b in index.config().brains.items()}, ensure_ascii=False))`);
  assert.equal(extras.whale.length, 1, '小鲸鱼有一个额外来源');
  assert.ok(extras.whale[0][0].endsWith('/家/小鲸鱼/聊天记录') && extras.whale[0][1] === '聊天记录', `小鲸鱼的聊天记录来源：${extras.whale[0]}`);
  assert.ok(extras.sister[0][0].endsWith('/sister/聊天记录') && extras.sister[0][1] === '聊天记录', `姐姐的聊天记录来源：${extras.sister[0]}`);
  const whaleChatDir = brainOf('whale').chatLogs;
  assert.ok(whaleChatDir.split(path.sep).join('/').endsWith('/家/小鲸鱼/聊天记录'), 'brains.js 给出小鲸鱼的聊天记录目录');
  if (fs.existsSync(whaleChatDir) && fs.readdirSync(whaleChatDir).some((f) => f.endsWith('.md'))) assert.ok(rows.whale.rels.some((r) => r.startsWith('聊天记录/')), '小鲸鱼的聊天记录目录里有东西，就该进她的索引');
  ok(`检索服务只收各自脑子里的：小鲸鱼 ${rows.whale.n} 个文件、姐姐 ${rows.sister.n} 个文件；不收 妈妈 / 作品 / 旧稿 / 瞬间 / 归档 / 小说`);

  const resolved = py(`print(json.dumps([index.get_brain(x).id for x in [None, "", "小鲸鱼", "姐姐", "sister", "Whale", "🐳", "克劳德"]]))`);
  assert.deepEqual(resolved, ['whale', 'whale', 'whale', 'sister', 'sister', 'whale', 'whale', 'sister']);
  ok('Python：brain 参数缺省 = 小鲸鱼（兼容老调用），别名都认');
}

// ── 5b. 检索服务的接口（进程内测，临时端口，只读已建好的索引） ───────────────
{
  const out = execFileSync('python', ['-X', 'utf8', path.join(ROOT, 'scripts', 'test-brain-service.py')], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 120000 });
  assert.match(out, /✅ 检索服务接口/);
  ok('检索服务接口（scripts/test-brain-service.py）：' + out.trim().replace(/^✅ /, ''));
}

// ── 6. 本子工具（只读冒烟，起一个临时的 MCP，用完就退） ─────────────────────
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], cwd: ROOT });
  const client = new Client({ name: 'brain-unify-test', version: '0' });
  try {
    await client.connect(transport);
    const text = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n');
    const list = await text('memory_list', {});
    for (const n of ['关于老大', '答应过的事', '日常', '工具集', '交接']) assert.ok(list.includes(`· ${n}（`), `memory_list 里要有「${n}」：${list}`);
    assert.ok(!list.includes('· 主人（') && !list.includes('小说'), '没有「主人」「小说」这几本');
    const byAlias = await text('memory_read', { name: '主人' });
    assert.equal(byAlias, fs.readFileSync(brainOf('whale').aboutBoss, 'utf8'), '按「主人」翻，翻到的是关于老大.md');
    assert.ok((await text('memory_read', { name: '工具集' })).includes('工具集'), '笔记/ 里的本子也翻得到');
    assert.equal(await text('memory_read', { name: '给下一个我' }), fs.readFileSync(brainOf('whale').handoff, 'utf8'), '老名字「给下一个我」翻到 最近/交接.md');
    assert.match(await text('memory_read', { name: '没有这本' }), /有的是：/);
    ok('本子工具：列出 长期/ 和 笔记/ 的本子；按「主人」翻到关于老大；老名字「给下一个我」翻到交接；不存在的会说有哪些');
  } finally {
    await client.close().catch(() => {});
  }
}

console.log('\n全部通过：大脑搬家 + 统一记忆');
process.exit(0);

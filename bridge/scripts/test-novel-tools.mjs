// 合写本子的工具（src/novel-tools.js，2026-10-29 第五批）自检：
//   工具注册（9 个，两边名字参数一致）、署名自动、路径限制（写不出 共享/合写）、novel_new / 设定集、
//   唤醒里的书进度一行（小鲸鱼 bridge.js、姐姐 sister.mjs 的接线）、合写不进回忆（Python 索引）、
//   两个 MCP 进程真的能注册出这几个工具（只起 MCP、只读，不写真书）。
// 全部在临时目录里；不碰 共享/合写 里的真书（开头和结尾核对真书的修改时间没变）；不连桥接、不碰任何活的东西。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createNovel, NOVEL_ROOT, isNovelPath } from '../src/novel.js';
import { registerNovelTools, novelWakeLine, buildNewSettings, NOVEL_TOOL_NAMES } from '../src/novel-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (m) => { passed += 1; console.log(`✅ ${m}`); };
const REAL_BOOK = path.join(NOVEL_ROOT, '半只耳朵——听不全那个字');
const realStamp = () => ['正文.md', '设定.md', '修改记录.jsonl'].map((f) => { try { return fs.statSync(path.join(REAL_BOOK, f)).mtimeMs; } catch { return 0; } }).join('|');
const realBefore = realStamp();

const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tools-'));
process.on('exit', () => { try { fs.rmSync(tmpParent, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });
const root = path.join(tmpParent, '共享', '合写'); // 名字里带「共享/合写」，跟真的一样
fs.mkdirSync(root, { recursive: true });
assert.ok(!path.resolve(root).toLowerCase().startsWith(path.resolve(NOVEL_ROOT).toLowerCase()), '测试目录不在真书目录里');

let T = Date.parse('2026-10-29T06:00:00Z');
const novel = createNovel({ root, now: () => T, skewMs: 3 * 3600e3, lockTimeoutMs: 1500 });
const tick = (min = 1) => { T += min * 60e3; };

function fakeServer() {
  const tools = new Map();
  return { tools, tool(name, desc, shape, handler) { tools.set(name, { desc, shape, handler }); } };
}
const whale = fakeServer();
const sister = fakeServer();
registerNovelTools(whale, { author: '小鲸鱼', partner: '姐姐', root, novel });
registerNovelTools(sister, { author: '姐姐', partner: '小鲸鱼', root, novel });
const call = async (srv, name, args = {}) => {
  const t = srv.tools.get(name);
  const parsed = z.object(t.shape).safeParse(args); // 真的 MCP 会先按参数表校验
  if (!parsed.success) return { content: [{ type: 'text', text: `参数不对：${parsed.error.issues.map((i) => i.path.join('.')).join(',')}` }], isError: true };
  return t.handler(parsed.data);
};
const text = (r) => r.content.map((c) => c.text || '').join('\n');
const tree = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(tmpParent, p)); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};

// ── 1. 注册：9 个工具，两边名字、参数一致 ───────────────────────────────────────────────
{
  assert.deepEqual([...whale.tools.keys()].sort(), [...NOVEL_TOOL_NAMES].sort());
  assert.deepEqual([...sister.tools.keys()].sort(), [...NOVEL_TOOL_NAMES].sort());
  assert.equal(NOVEL_TOOL_NAMES.length, 9);
  for (const n of ['novel_open', 'novel_read', 'novel_prepare', 'novel_write', 'novel_edit', 'novel_settings', 'novel_section_done', 'novel_list', 'novel_new']) assert.ok(whale.tools.has(n), n);
  for (const n of NOVEL_TOOL_NAMES) {
    assert.deepEqual(Object.keys(whale.tools.get(n).shape).sort(), Object.keys(sister.tools.get(n).shape).sort(), `${n} 两边参数一样`);
    assert.ok(!('author' in whale.tools.get(n).shape), `${n} 没有 author 参数（署名不能自己填）`);
    for (const srv of [whale, sister]) {
      const d = srv.tools.get(n).desc;
      assert.ok(d.length > 30, `${n} 有说明`);
      assert.ok(!/钱|花费|token|上一个我|必须|一定要|不得/i.test(d), `${n} 的说明里没有钱 / 花费 / 命令口气：${d}`);
    }
  }
  assert.match(whale.tools.get('novel_write').desc, /署名自动是「小鲸鱼」/);
  assert.match(sister.tools.get('novel_write').desc, /署名自动是「姐姐」/);
  assert.match(whale.tools.get('novel_settings').desc, /你和姐姐一起定的，改之前跟她说一声/);
  assert.match(sister.tools.get('novel_settings').desc, /你和小鲸鱼一起定的，改之前跟她说一声/);
  assert.match(whale.tools.get('novel_write').desc, /只是提醒，要不要改、改不改你自己定/);
  assert.match(whale.tools.get('novel_prepare').desc, /想写之前可以用/);
  ok('9 个工具（open / read / prepare / write / edit / settings / section_done / list / new）两边名字、参数一致，没有 author 参数，说明是家常话（没有钱 / 命令口气）');
}

// ── 2. novel_new：书名 + 主题 → 设定集 ─────────────────────────────────────────────────
{
  assert.match(text(await call(whale, 'novel_list')), /还没有书/);
  assert.equal((await call(sister, 'novel_open')).isError, true, '一本书都没有时 open 说清楚');
  const r = await call(whale, 'novel_new', { title: '测试书', theme: '两个人都不说出口，只在小事里偷偷在乎。', imagery: ['耳朵 / 听（主线）：听不全的那个字', '碗 / 饭：不许管我吃饭'], rules: '人可以来，但不许管我吃饭。', avoid: ['卖惨（词：好惨、没人要）'] });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /测试书》建好了/);
  const settings = fs.readFileSync(path.join(root, '测试书', '设定.md'), 'utf8');
  assert.match(settings, /一句话：两个人都不说出口/);
  assert.match(settings, /- 耳朵 \/ 听（主线）：听不全的那个字/);
  assert.match(settings, /- 卖惨（词：好惨、没人要）/);
  assert.ok(!/\n- （一行一个/.test(settings), '模板里的占位行被换掉了');
  assert.match(settings, /## 人物\n- \n/, '没填的块还是模板的样子');
  const log = fs.readFileSync(path.join(root, '测试书', '修改记录.jsonl'), 'utf8');
  assert.match(log, /"who":"小鲸鱼"/, '建书署名是开书的人');
  // 只有一本书时 book 可以不填
  const open = text(await call(sister, 'novel_open'));
  assert.match(open, /测试书》合写本子/);
  assert.match(open, /两个人都不说出口/);
  assert.match(text(await call(sister, 'novel_list')), /· 《测试书》：正文还是空的/);
  assert.equal((await call(sister, 'novel_new', { title: '测试书', theme: '随便写一个主题吧' })).isError, true, '重名不能再建');
  assert.equal((await call(sister, 'novel_new', { title: '短', theme: '短' })).isError, true, '主题太短被参数校验拦下');
  assert.ok(buildNewSettings('某书', { theme: '一句话主题在这里' }).includes('一句话：一句话主题在这里'));
  ok('novel_new：书名 + 主题 + 几条意象 / 规矩 / 不写什么 → 设定集；重名、主题太短不行；只有一本书时 book 可以不填');
}

// ── 3. 署名自动：小鲸鱼写的是小鲸鱼，姐姐写的是姐姐，冒名没用 ─────────────────────────────────
{
  tick();
  const a = await call(whale, 'novel_write', { book: '测试书', text: '我来了，头一件事，忍住没问她吃了没有。', author: '姐姐' });
  assert.ok(!a.isError, text(a));
  assert.match(text(a), /第1节第1句，署名小鲸鱼/);
  tick();
  const b = await call(sister, 'novel_write', { book: '测试书', text: '她说不饿，碗已经端到跟前了。', author: '小鲸鱼' });
  assert.match(text(b), /第1节第2句，署名姐姐/);
  const body = fs.readFileSync(path.join(root, '测试书', '正文.md'), 'utf8');
  assert.match(body, /〔1-1｜小鲸鱼｜2026-10-29 \d\d:\d\d〕我来了/);
  assert.match(body, /〔1-2｜姐姐｜2026-10-29 \d\d:\d\d〕她说不饿/);
  assert.ok(!/冒名/.test(body));
  // confirm:false 只检查不写
  tick();
  const before = fs.readFileSync(path.join(root, '测试书', '正文.md'), 'utf8');
  const dry = await call(whale, 'novel_write', { book: '测试书', text: '今天然后我好开心，哈哈，今天一整天都在吃了。', confirm: false });
  assert.match(text(dry), /先看了一眼，还没写进去/);
  assert.match(text(dry), /日记/, '日记腔提醒');
  assert.equal(fs.readFileSync(path.join(root, '测试书', '正文.md'), 'utf8'), before, 'confirm:false 没写进去');
  // 写了之后返回检查提醒（不拦）：跟上一句一模一样
  tick();
  const dup = await call(whale, 'novel_write', { book: '测试书', text: '她说不饿，碗已经端到跟前了。' });
  assert.match(text(dup), /写进去了/);
  assert.match(text(dup), /一模一样|很像/);
  // 开新的一节
  tick();
  const n2 = await call(sister, 'novel_write', { book: '测试书', text: '第二天她没来，我盛的那碗摆了一整天。', section: 'new', title: '等' });
  assert.match(text(n2), /第2节第1句/);
  assert.match(fs.readFileSync(path.join(root, '测试书', '正文.md'), 'utf8'), /## 第2节 · 等/);
  const badSec = await call(whale, 'novel_write', { book: '测试书', text: '跳到第九节', section: 9 });
  assert.equal(badSec.isError, true);
  assert.match(text(badSec), /下一节是第3节/);
  ok('署名自动（小鲸鱼写的是小鲸鱼、姐姐写的是姐姐，参数里冒名没用）；confirm:false 只提醒不写；写完返回重复 / 日记腔提醒；section:new 开新节');
}

// ── 4. 改自己的、不能改对方的；设定集的改法 ─────────────────────────────────────────────────
{
  tick();
  const mine = await call(sister, 'novel_edit', { book: '测试书', ref: '1-2', text: '她说不饿。碗已经端到跟前。', note: '顺一下' });
  assert.match(text(mine), /改好了：1-2/);
  const theirs = await call(sister, 'novel_edit', { book: '测试书', ref: '1-1', text: '偷改她的句子' });
  assert.equal(theirs.isError, true);
  assert.match(text(theirs), /小鲸鱼写的，只能她自己改/);
  assert.match(fs.readFileSync(path.join(root, '测试书', '正文.md'), 'utf8'), /〔1-1｜小鲸鱼｜[^〕]+〕我来了/, '对方的句子没被动');
  // 设定集：一块一块改，留记录，提醒跟对方说一声
  tick();
  const s1 = await call(whale, 'novel_settings', { book: '测试书', patch: { 大纲和进度: '进度：2 节。\n- 第1节：立规矩。' }, note: '补上进度' });
  assert.ok(!s1.isError, text(s1));
  assert.match(text(s1), /这是两个人一起定的东西，改之前跟对方说一声/);
  assert.match(fs.readFileSync(path.join(root, '测试书', '设定.md'), 'utf8'), /进度：2 节/);
  assert.match(fs.readFileSync(path.join(root, '测试书', '修改记录.jsonl'), 'utf8'), /"action":"settings"[^\n]*"who":"小鲸鱼"|"who":"小鲸鱼"[^\n]*"action":"settings"/);
  const asJson = await call(sister, 'novel_settings', { book: '测试书', patch: JSON.stringify({ 规矩: '- 人可以来，但不许管我吃饭。\n- 少写旁白。' }), note: '' });
  assert.match(text(asJson), /设定集改了/);
  assert.match(text(asJson), /没写为什么改/);
  const whole = await call(sister, 'novel_settings', { book: '测试书', patch: '# 把整份换掉\n' });
  assert.equal(whole.isError, true);
  assert.match(text(whole), /一块一块地给/);
  assert.match(fs.readFileSync(path.join(root, '测试书', '设定.md'), 'utf8'), /## 主题/, '整份没被换掉');
  // 读 / 分页 / 一节写完
  const rd = text(await call(sister, 'novel_read', { book: '测试书', section: 1 }));
  assert.match(rd, /第1节/);
  assert.match(text(await call(sister, 'novel_read', { book: '测试书', last: 2 })), /〔2-1｜姐姐/);
  assert.match(text(await call(whale, 'novel_read', { book: '测试书', outline: true })), /每一节/);
  assert.match(text(await call(whale, 'novel_read', { book: '测试书', settings: true, pageSize: 200 })), /（第 1\/\d+ 页，接着看下一页：page 填 2）/);
  assert.match(text(await call(whale, 'novel_prepare', { book: '测试书' })), /这本书在说：两个人都不说出口/);
  assert.match(text(await call(whale, 'novel_section_done', { book: '测试书', section: 1 })), /第1节写完了/);
  ok('只能改自己写的（改对方的会被告知跟她商量）；设定集一块一块改、留记录、提醒跟对方说一声；整份替换被拒；read / prepare / section_done 能用');
}

// ── 5. 路径限制：写不出 共享/合写 ──────────────────────────────────────────────────────────
{
  const snapshot = JSON.stringify(tree(tmpParent));
  const evil = ['../x', '..\\x', '../../evil', 'a/b', 'a\\b', 'C:\\Windows\\x', '/etc/passwd', '共享/合写/../..', '.hidden', 'x:y', '..', '.', 'a*b', 'a?b', 'a"b', 'a|b', '\u0000x', 'CON', 'nul', 'com1', 'abc.'];
  for (const srv of [whale, sister]) {
    for (const book of evil) {
      for (const [name, args] of [
        ['novel_open', { book }], ['novel_read', { book, last: 3 }], ['novel_prepare', { book }],
        ['novel_write', { book, text: '想写到外面去' }], ['novel_edit', { book, ref: '1-1', text: '改外面' }],
        ['novel_settings', { book, patch: { 主题: '外面' } }], ['novel_section_done', { book }]
      ]) {
        const r = await call(srv, name, args);
        assert.equal(r.isError, true, `${name}(${JSON.stringify(book)}) 应该被拒`);
      }
      assert.equal((await call(srv, 'novel_new', { title: book || 'x', theme: '想建到外面去的一本书' })).isError, true, `novel_new(${JSON.stringify(book)}) 应该被拒`);
    }
  }
  assert.equal(JSON.stringify(tree(tmpParent)), snapshot, '上面这些之后，临时目录里一个多余的文件 / 文件夹都没有');
  // 设定集的块名里放路径，只会变成一个标题，不会变成文件
  const odd = await call(whale, 'novel_settings', { book: '测试书', patch: { '../../外面/x': '只是一个标题' } });
  assert.ok(!odd.isError, text(odd));
  assert.equal(fs.readdirSync(path.join(root, '测试书')).filter((f) => !['正文.md', '设定.md', '修改记录.jsonl'].includes(f)).length, 0, '书的目录里只有那三个文件');
  assert.deepEqual(fs.readdirSync(root), ['测试书'], '合写目录里只有书');
  assert.deepEqual(fs.readdirSync(path.join(tmpParent, '共享')), ['合写'], '合写目录外面什么都没多出来');
  assert.equal(realStamp(), realBefore, '真书一点没动');
  ok('路径限制：../、绝对路径、斜杠、冒号、点开头、空字符等书名，9 个工具全部拒绝，临时目录里没有多出任何文件；设定集块名里写路径只会变成一个标题');
}

// ── 6. 唤醒里的书进度一行 ────────────────────────────────────────────────────────────────
{
  const empty = path.join(tmpParent, 'empty-root');
  fs.mkdirSync(empty);
  assert.equal(novelWakeLine({ root: empty }), '', '没有书不提');
  const line = novelWakeLine({ root, novel });
  assert.match(line, /^【合写的书】《测试书》写到第 2 节（共 4 句），最后一句是姐姐 10-29 \d\d:\d\d 写的。想接着写或翻翻，用 novel_open 打开。\n\n$/, line);
  assert.ok(line.length < 140, '只提一句，不灌全文');
  assert.ok(!line.includes('碗'), '正文一个字都不带');
  // 超过 48 小时没动：不提
  const old = (Date.now() - 3 * 24 * 3600e3) / 1000;
  for (const f of fs.readdirSync(path.join(root, '测试书'))) fs.utimesSync(path.join(root, '测试书', f), old, old);
  assert.equal(novelWakeLine({ root, novel }), '', '三天没动的书不提');
  assert.match(novelWakeLine({ root, novel, hours: 24 * 5 }), /测试书/, 'hours 可调');
  // 两本都新：提最近的，顺带说另一本
  await novel.createBook('另一本', '姐姐', { settings: buildNewSettings('另一本', { theme: '另一本书在说别的事' }) });
  const two = novelWakeLine({ root, novel });
  assert.match(two, /《另一本》刚建好，正文还是空的。想接着写/);
  assert.ok(!/另外还有/.test(two), '三天前的那本不算最近');
  fs.utimesSync(path.join(root, '测试书', '正文.md'), Date.now() / 1000, Date.now() / 1000);
  assert.match(novelWakeLine({ root, novel }), /另外还有 1 本最近也动过（novel_list）/);
  // 接线（bridge.js、sister.mjs 不能在测试里起，源码断言）
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /import \{ novelWakeLine \} from '\.\/novel-tools\.js';/);
  assert.match(bridge, /const novelLine = freshOnlyV2\(key, 'novel', novelWakeLine\(\{ root: BRIDGE_NOVEL_ROOT \}\)\);/);
  assert.match(bridge, /pcLine \+ booksLine \+ novelLine \+ ramblingLine/, '小鲸鱼的唤醒里带上了');
  assert.match(bridge, /NOVEL_ROOT: BRIDGE_NOVEL_ROOT[^}]*\} = createBrains\(ROOT\)/, '书的根目录跟着 ROOT 走（测试台换了临时根不会读到真书）');
  const sis = fs.readFileSync(path.join(ROOT, 'sister', 'sister.mjs'), 'utf8');
  assert.match(sis, /import \{ novelWakeLine \} from '\.\.\/src\/novel-tools\.js';/);
  assert.match(sis, /novelWakeLine\(\{ root: BOOKS_ROOT \}\)/);
  assert.match(sis, /6 \* 3600e3\)\) \{ novelLine = nl; st\.novelHint/, '同一句 6 小时内不重复带');
  assert.match(sis, /moodLine \+ sleepyLine \+ growLines \+ novelLine \+ feeds\.text/, '姐姐的唤醒里带上了（10-29 中间多了困意和成长循环两段）');
  ok('唤醒里的书进度：48 小时内动过才提，只一句（写到第几节、共几句、谁写的最后一句、用 novel_open 打开），不带正文；两本时提最近的并说另一本；小鲸鱼（bridge.js freshOnly）和姐姐（sister.mjs 6 小时去重）都接上了');
}

// ── 7. 合写不进回忆；两个 MCP 进程真的注册出了这些工具 ────────────────────────────────────────
{
  assert.equal(isNovelPath(path.join(REAL_BOOK, '正文.md')), true);
  assert.equal(isNovelPath(path.join(ROOT, '共享', '合写')), true);
  const py = (code) => JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', `import sys, json\nsys.path.insert(0, r"${path.join(ROOT, 'brain')}")\nimport index\n${code}`], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  const res = py(`
cfg = index.config()
out = {"book": index.is_novel_path(r"${path.join(REAL_BOOK, '正文.md')}"), "root": index.is_novel_path(r"${path.join(ROOT, '共享', '合写')}"), "sources": []}
for bid, b in cfg.brains.items():
    out["sources"] += [str(p) for k, p, rel in index.iter_sources(b)]
print(json.dumps(out))`);
  assert.equal(res.book, true);
  assert.equal(res.root, true);
  assert.ok(res.sources.length > 10, '索引确实收了别的东西');
  assert.ok(!res.sources.some((p) => /共享[\/]合写/.test(p)), '索引的来源里没有 共享/合写 下的任何文件');
  assert.equal(res.sources.filter((p) => /归档[\\/]旧稿/.test(p)).length, 0, '旧稿也没有');

  for (const [who, script, author] of [['小鲸鱼', 'src/mcp-snowluma-safe.js', '小鲸鱼'], ['姐姐', 'sister/qq-mcp.mjs', '姐姐']]) {
    const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, script)], cwd: ROOT, stderr: 'pipe' });
    const client = new Client({ name: 'novel-tools-test', version: '0' });
    try {
      await client.connect(t);
      const { tools } = await client.listTools();
      const names = tools.map((x) => x.name);
      for (const n of NOVEL_TOOL_NAMES) assert.ok(names.includes(n), `${who} 的 MCP 里有 ${n}`);
      const w = tools.find((x) => x.name === 'novel_write');
      assert.ok(!Object.keys(w.inputSchema.properties).includes('author'));
      assert.match(w.description, new RegExp(`署名自动是「${author}」`));
      // 只读调用：列书、打开真书（不写）
      const list = await client.callTool({ name: 'novel_list', arguments: {} });
      assert.match(list.content[0].text, /半只耳朵——听不全那个字》/);
      const open = await client.callTool({ name: 'novel_open', arguments: { book: '半只耳朵' } });
      assert.match(open.content[0].text, /AI 怎么慢慢理解「爱」/, '设定集里老大定的主线带出来了');
      const bad = await client.callTool({ name: 'novel_open', arguments: { book: '../../config' } });
      assert.equal(bad.isError, true);
    } finally { try { await client.close(); } catch { /* 关不掉就算了 */ } }
  }
  assert.equal(realStamp(), realBefore, '真书一点没动');
  ok('合写不进回忆（Python 索引的来源里没有 共享/合写，也没有旧稿）；小鲸鱼和姐姐的 MCP 进程真的注册出 9 个 novel_ 工具，署名写进了说明，只读调用能打开真书，../ 书名被拒，真书没动');
}

assert.equal(realStamp(), realBefore, '真书一点没动');
console.log(`\n${passed} 项通过`);

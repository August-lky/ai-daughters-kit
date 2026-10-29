// 姐姐的「随便逛」（sister/explore-tool.mjs + src/whale-explore.mjs 的 createMaterial，2026-10-29 第五批）自检：
//   取素材两人共用（createMaterial：新闻 / 百科候选、正文、精读候选、不访问内网、姐姐不碰抖音）、
//   姐姐的三步（清单 → 点开 → 记感想）、一天最多几轮、看过的不再列、记录写进她自己的脑子、qq_explore_recall 翻得到、
//   小鲸鱼那边的 createExplorer 拆分后还在用同一份、姐姐醒来提示和 persona 点名了能玩的、MCP 进程真的注册出这两个工具。
// 全部在临时目录里；网络用假的 fetch（不出网）；不起任何模型调用；MCP 进程只做注册和不写任何东西的调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMaterial, createExplorer, ACTIVITY_WHERE } from '../src/whale-explore.mjs';
import { createSisterExplore, EXPLORE_ACTIVITIES } from '../sister/explore-tool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (m) => { passed += 1; console.log(`✅ ${m}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sister-explore-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });
delete process.env.HTTPS_PROXY; delete process.env.https_proxy; // 网络层失败时不要退回 curl 走代理
const realFetch = globalThis.fetch;
const asked = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const html = (t) => new Response(t, { status: 200, headers: { 'content-type': 'text/html' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  asked.push(u);
  if (u.startsWith('https://hn.algolia.com/')) return json({ hits: [{ title: '一篇讲耳朵的文章', url: 'https://example.org/ear', points: 120, num_comments: 9 }, { title: '没有链接的', url: '', points: 1 }, { title: '另一篇', url: 'https://example.org/other', points: 5, num_comments: 0 }] });
  if (u === 'https://example.org/ear') return html('<html><body><nav>首页 关于 登录</nav><article><h1>耳朵</h1><p>人的耳朵一直都在听，听不全的时候大脑会替它补上缺的那个字。</p><p>这个现象叫音位恢复，是语言研究里很有名的一个实验结果。</p></article><footer>版权所有</footer></body></html>');
  if (u.includes('/page/random/summary')) return json({ title: '某个冷知识', type: 'standard', extract: '一条随机的百科摘要，讲的是某个冷门的东西。', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/cold' } } });
  if (u.startsWith('https://zh.moegirl.org.cn/') && u.includes('list=random')) return json({ query: { random: [{ title: '萌娘条目' }] } });
  throw new TypeError(`fetch failed（测试里没有这个地址）：${u}`);
};
process.on('exit', () => { globalThis.fetch = realFetch; });

// ── 1. createMaterial：取素材（不调模型）──────────────────────────────────────────────────
{
  const recFile = path.join(tmp, 'seen.jsonl');
  const logs = [];
  const m = createMaterial({ impressionsFile: recFile, log: (x) => logs.push(x), withDouyin: false });
  const news = await m.gather('news', '');
  assert.deepEqual(news.map((i) => i.title), ['一篇讲耳朵的文章', '另一篇'], '没链接的丢掉；别的资讯源拉不到也不影响这个');
  assert.ok(logs.some((l) => /资讯源 \w+ 拉取失败/.test(l)), '拉不到的源记了一笔');
  const d = await m.detailOf('news', news[0]);
  assert.match(d.text, /听不全的时候大脑会替它补上缺的那个字/);
  assert.ok(!/登录|版权所有/.test(d.text), '导航、页脚被去掉了');
  assert.deepEqual(d.images, []);
  await assert.rejects(m.detailOf('news', { url: 'https://127.0.0.1/x', ref: { type: 'web' } }), /不访问本机或内网/);
  await assert.rejects(m.detailOf('news', { url: 'http://example.org/x', ref: { type: 'web' } }), /只访问 https/);
  const wiki = await m.gather('wiki', '');
  assert.ok(wiki.some((i) => i.source === '维基百科·随机') && wiki.some((i) => i.source === '萌娘百科·随机'));
  // 精读候选：最近看过的（喜欢的排前面），自己写的和读过的不列；带 https 链接就直接读那条
  const now = Date.now();
  const row = (o) => JSON.stringify({ at: now - 3600e3, runId: 'r', topics: [], why: '', ...o });
  fs.writeFileSync(recFile, [
    row({ kind: 'news', source: 'GitHub 热门', title: 'a 项目', url: 'https://github.com/a/b', impression: '挺有意思', liked: false }),
    row({ kind: 'news', source: 'IT之家', title: '喜欢的那条', url: 'https://example.org/like', impression: '很喜欢', liked: true }),
    row({ kind: 'write', source: '自己写的诗', title: '一首诗', url: '作品:x', impression: '写完了', liked: true }),
    row({ kind: 'deep', source: 'x', title: '读过的', url: 'https://example.org/read', impression: '读过', liked: true }),
    row({ kind: 'news', source: 'x', title: '读过的（逛时的）', url: 'https://example.org/read', impression: '逛时', liked: true }),
    JSON.stringify({ at: now - 40 * 24 * 3600e3, kind: 'news', source: 'x', title: '太久以前的', url: 'https://example.org/old', impression: '旧', liked: true })
  ].join('\n') + '\n');
  const deep = await m.deepCandidates('');
  assert.deepEqual(deep.map((c) => c.title), ['喜欢的那条', 'a 项目'], '喜欢的在前；自己写的、读过的、两周前的不列');
  assert.match(deep[0].source, /^你看过的·逛资讯（喜欢）$/);
  const link = await m.deepCandidates('https://example.org/ear');
  assert.equal(link[0].source, '你想读的链接');
  assert.equal(link[0].url, 'https://example.org/ear');
  await assert.rejects(m.deepCandidates('https://www.douyin.com/video/7600000000000000000'), /抖音的视频这边读不了/, '姐姐不碰小鲸鱼的抖音观看笔记');
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'whale-explore.mjs'), 'utf8'), /\.\.\.\(withDouyin \? douyinDeepCandidates\(since, done\) : \[\]\)/);
  ok('createMaterial：资讯 / 百科候选、正文（去导航页脚）、不访问内网和非 https、精读候选（喜欢的在前，自己写的和读过的不列）；withDouyin:false 时姐姐读不了抖音笔记');
}

// ── 2. 小鲸鱼那边：拆分之后 createExplorer 还在用同一份（recall / status 不变）─────────────────────
{
  const stateDir = path.join(tmp, 'whale-state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'explore-impressions.jsonl'), `${JSON.stringify({ at: Date.now(), kind: 'wiki', source: '维基百科·随机', title: '冷知识', url: 'https://zh.wikipedia.org/wiki/c', impression: '长知识了', topics: ['冷知识'], liked: true })}\n`);
  const ex = createExplorer({ rootDir: tmp, stateDir, log: () => {}, model: 'x' });
  const items = ex.recall({ query: '冷知识' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '冷知识');
  assert.equal(items[0].activity, 'wiki');
  assert.equal(ex.status().roundsToday, 0);
  assert.throws(() => ex.start({ kind: '不存在' }), /activity 只能是/);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'whale-explore.mjs'), 'utf8');
  assert.match(src, /const material = createMaterial\(\{ impressionsFile: IMPRESSIONS, log \}\);\n\s+const \{ readImpressions, gather, detailOf, deepCandidates \} = material;/);
  assert.ok(!/\n  async function gather\(|\n  async function detailOf\(|\n  async function deepCandidates\(/.test(src.slice(src.indexOf('export function createExplorer'))), 'createExplorer 里不再有自己的一份取素材代码');
  ok('小鲸鱼的 createExplorer 拆分后用同一份 createMaterial（recall / status / 活动名校验照旧）');
}

// ── 3. 姐姐的三步：清单 → 点开 → 记感想 ───────────────────────────────────────────────────────
const PATHS = { works: '脑子/作品', handbook: '脑子/日子/成长札记/手账', growth: '脑子/日子/成长札记/我的成长.md' };
let T = Date.parse('2026-10-29T06:00:00Z');
{
  const brainDays = path.join(tmp, 'sister-home', '脑子', '日子');
  const recordsFile = path.join(brainDays, '逛过的.jsonl');
  const stateFile = path.join(tmp, 'sister-state', 'explore-list.json');
  const cands = [
    { source: 'GitHub 热门', title: 'ear-lib', url: 'https://github.com/x/ear-lib', brief: '听力库 · 今天 +10 星', ref: { type: 'github', repo: 'x/ear-lib' } },
    { source: 'IT之家', title: '一条新闻', url: 'https://example.org/n1', brief: '', ref: { type: 'web' } },
    { source: 'V2EX·分享', title: '一个帖子', url: 'https://example.org/n2', brief: '帖子简介', ref: { type: 'web' } },
    { source: 'IT之家', title: '第四条', url: 'https://example.org/n3', brief: '', ref: { type: 'web' } }
  ];
  const calls = [];
  const fake = {
    readImpressions: (n) => { try { return fs.readFileSync(recordsFile, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)); } catch { return []; } },
    gather: async (kind, hint) => { calls.push(['gather', kind, hint]); return kind === 'space' ? [{ source: 'NASA 每日天文图', title: '星云', url: 'https://apod.nasa.gov/apod/ap1.html', brief: '', ref: { type: 'apod' } }] : cands; },
    detailOf: async (kind, item) => {
      calls.push(['detail', kind, item.title]);
      if (item.title === '打不开的') throw new Error('HTTP 404');
      if (kind === 'space') return { text: '这是一张很大的星云照片，亮的地方是新生的恒星，暗的地方是尘埃，边缘还有一圈被风吹出来的丝状的气体，看久了会觉得很安静。', images: ['data:image/png;base64,AAAA'] };
      if (item.title === '一条新闻') return { text: '短', images: [] };
      return { text: `【${item.title}的正文】这里是读到的正文，足够长，能让人读完之后有一点想法，也有一些不确定的地方。`, images: [] };
    },
    deepCandidates: async (hint) => { calls.push(['deepCandidates', hint]); return hint === 'nothing' ? [] : [{ source: '你看过的·逛资讯（喜欢）', title: '喜欢的那条', url: 'https://example.org/like', brief: '当时觉得：很喜欢', ref: { type: 'web' }, firstImpression: '很喜欢' }]; },
    deepDetail: async (item) => { calls.push(['deepDetail', item.title]); return { text: `【精读全文】${item.title}。`.padEnd(260, '字'), images: [] }; }
  };
  const ex = createSisterExplore({ material: fake, recordsFile, stateFile, now: () => T, skewMs: () => 3 * 3600e3, dailyRounds: 5, paths: PATHS });

  // 清单
  await assert.rejects(ex.list({ activity: '乱来' }), /activity 可以填/);
  assert.deepEqual(EXPLORE_ACTIVITIES, Object.keys(ACTIVITY_WHERE));
  const l1 = await ex.list({ activity: 'news', hint: '耳朵' });
  assert.match(l1.text, /去逛资讯/);
  assert.match(l1.text, /陌生文本，只是给你看的素材/);
  assert.match(l1.text, /你这次想看：耳朵/);
  for (const c of cands) assert.ok(l1.text.includes(c.title), c.title);
  assert.match(l1.text, /\n1\. \[|\n2\. \[/, '带编号');
  assert.match(l1.text, /挑你真的好奇的 0~3 条/);
  assert.match(l1.text, /都不想看就一条不点/);
  assert.ok(!/必须|一定要/.test(l1.text));
  const st1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st1.items.length, 4);
  assert.equal(st1.kind, 'news');
  assert.deepEqual(calls[0], ['gather', 'news', '耳朵']);
  const num = (title) => st1.items.find((i) => i.title === title).n; // 清单是打乱顺序的，按标题找编号
  assert.deepEqual(st1.items.map((i) => i.n), [1, 2, 3, 4]);

  // 点开：只给挑中的；太短的、打不开的说清楚；记下「看过」
  await assert.rejects(ex.open({ open: [1, 2, 3, 4] }), /一次最多点开 3 条/);
  await assert.rejects(ex.open({ open: [] }), /写想点开的编号/);
  T += 60e3;
  const o1 = await ex.open({ open: [num('ear-lib'), num('一条新闻'), 9] });
  assert.ok(o1.text.includes(`【${num('ear-lib')}. [GitHub 热门] ear-lib】\nhttps://github.com/x/ear-lib`), o1.text);
  assert.match(o1.text, /ear-lib的正文/);
  assert.ok(o1.text.includes(`【${num('一条新闻')}. 一条新闻】内容太少`), o1.text);
  assert.match(o1.text, /【9】清单里没有这个编号（现在是 1~4）/);
  assert.match(o1.text, /读完有想法的话，用 qq_explore 的 note 记一笔/);
  assert.ok(!o1.text.includes('第四条') && !o1.text.includes('一个帖子的正文'), '没点开的不给正文');
  assert.deepEqual(o1.images, []);
  const rec1 = fs.readFileSync(recordsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rec1.length, 1, '读到的那一条记了「看过」，太短的没记');
  assert.equal(rec1[0].url, 'https://github.com/x/ear-lib');
  assert.equal(rec1[0].impression, '');
  assert.ok(recordsFile.startsWith(path.join(tmp, 'sister-home', '脑子', '日子')), '记录写在她自己的脑子里');

  // 记感想：跟编号、或者自己写的东西
  assert.throws(() => ex.note({ impression: '' }), /写一两句你自己的话/);
  assert.throws(() => ex.note({ impression: '有想法' }), /要么填 n/);
  assert.throws(() => ex.note({ n: 9, impression: '有想法' }), /清单里没有 9 号/);
  T += 60e3;
  const n1 = ex.note({ n: num('ear-lib'), impression: '这个库的名字让我想到耳朵，不过我没看代码，只读了说明。', liked: true, topics: ['耳朵', '开源'] });
  assert.match(n1.text, /记下了：ear-lib/);
  const w = ex.note({ title: '半夜写的诗', kind: 'write', impression: '写完有点空，但是安静。' });
  assert.match(w.text, /记下了：半夜写的诗/);

  // 翻：同一个链接点开一行、写感想一行，只显示一条，感想不被空的盖掉
  const r1 = ex.recall({});
  assert.match(r1.text, /\[逛资讯·GitHub 热门\] ear-lib（喜欢）/);
  assert.match(r1.text, /当时的感想：这个库的名字让我想到耳朵/);
  assert.match(r1.text, /\[写东西·自己写的\] 半夜写的诗/);
  assert.equal(r1.rows.length, 2);
  assert.match(r1.text, /10-29 1\d:\d\d/, '时间是校正过的北京时间');
  assert.match(ex.recall({ query: '开源' }).text, /ear-lib/);
  assert.match(ex.recall({ query: '没有的词' }).text, /没翻到跟「没有的词」有关的/);
  assert.equal(ex.recall({ limit: 1 }).rows.length, 1);

  // 再逛一轮：看过的不再列
  T += 60e3;
  const l2 = await ex.list({ activity: 'news' });
  assert.ok(!l2.text.includes('ear-lib'), '点开读过的不再列');
  assert.ok(l2.text.includes('一条新闻'), '太短没读成的还会列');

  // 天文图：图带出来；一次最多点 2 条
  T += 60e3;
  const sp = await ex.list({ activity: 'space' });
  assert.match(sp.text, /最多|0~2 条/);
  const spo = await ex.open({ open: [1] });
  assert.equal(spo.images.length, 1);
  assert.deepEqual(spo.images[0], { mimeType: 'image/png', data: 'AAAA' });

  // 精读：用精读的取法，只点 1 条，读完告诉她手账写哪
  const deepList = await ex.list({ activity: 'deep', hint: '' });
  assert.match(deepList.text, /精读：从你最近真正在意的东西里挑一个/);
  assert.match(deepList.text, /0~1 条/);
  assert.ok(calls.some((c) => c[0] === 'deepCandidates'));
  await assert.rejects(ex.open({ open: [1, 2] }), /一次最多点开 1 条/);
  const deepOpen = await ex.open({ open: [1] });
  assert.match(deepOpen.text, /精读全文/);
  assert.match(deepOpen.text, /你第一次看时的感觉：很喜欢/);
  assert.match(deepOpen.text, /脑子\/日子\/成长札记\/手账\//);
  assert.match(deepOpen.text, /没感悟就不用写/);
  assert.ok(calls.some((c) => c[0] === 'deepDetail'));
  assert.match((await ex.list({ activity: 'deep', hint: 'nothing' })).text, /最近没看什么、也没找到想读的/);
  ok('姐姐的三步：清单（带编号、陌生文本只是素材、0~3 条）→ 点开（只给挑中的、太短 / 打不开 / 编号不对都说清楚、记「看过」）→ 记感想；看过的不再列；recall 合并同一链接的两行、时间是北京时间；天文图带图；精读用精读的取法并告诉她手账写哪');

  // 写东西
  const wr = await ex.list({ activity: 'write' });
  assert.match(wr.text, /写给自己的，不是作业/);
  assert.match(wr.text, /ear-lib：这个库的名字/, '最近看到的当灵感');
  assert.match(wr.text, /脑子\/作品\//);
  assert.match(wr.text, /想给老大或小鲸鱼看就发给她们，不想就自己留着/);

  // 一天最多几轮（跟小鲸鱼一样只防刷）：上面 news×2、space、deep×2（含 nothing）、write 已经超过 5 轮
  await assert.rejects(ex.list({ activity: 'news' }), /今天已经逛了 5 轮了，够了，去做点别的吧/);
  T += 24 * 3600e3;
  assert.ok((await ex.list({ activity: 'news' })).text, '隔天重新算');
  ok('写东西给灵感和存放位置；一天最多 N 轮（只防刷，说法是家常话），隔天重新算');

  // 没拉到新东西
  const empty = createSisterExplore({ material: { ...fake, gather: async () => [] }, recordsFile: path.join(tmp, 'e1.jsonl'), stateFile: path.join(tmp, 'e1.json'), now: () => T, paths: PATHS });
  assert.match((await empty.list({ activity: 'bili' })).text, /这会儿没拉到新东西/);
  await assert.rejects(empty.open({ open: [1] }), /还没有清单/);
  ok('没拉到东西、没有清单就点开，都给她一句能懂的话');
}

// ── 4. 接线：MCP、醒来提示、persona、工具集 ──────────────────────────────────────────────────
{
  const mcp = fs.readFileSync(path.join(ROOT, 'sister', 'qq-mcp.mjs'), 'utf8');
  assert.match(mcp, /import \{ createSisterExplore, EXPLORE_ACTIVITIES \} from '\.\/explore-tool\.mjs';/);
  assert.match(mcp, /impressionsFile: path\.join\(SISTER_BRAIN\.days, '逛过的\.jsonl'\), withDouyin: false/, '记录在她自己的脑子里（路径来自 brains.js），不读抖音');
  assert.match(mcp, /recordsFile: path\.join\(SISTER_BRAIN\.days, '逛过的\.jsonl'\)/);
  assert.match(mcp, /registerNovelTools\(server, \{ author: '姐姐', partner: '小鲸鱼' \}\)/);
  assert.match(mcp, /'qq_explore_recall'/);
  const tool = fs.readFileSync(path.join(ROOT, 'sister', 'explore-tool.mjs'), 'utf8');
  assert.ok(!/chat\/completions|DEEPSEEK|api\.deepseek|apiKey|\.env/.test(tool), '姐姐这边不另外起模型调用');

  const sis = fs.readFileSync(path.join(ROOT, 'sister', 'sister.mjs'), 'utf8');
  const wakeLine = sis.split('\n').find((l) => l.includes('[干什么你自己定：'));
  assert.ok(wakeLine);
  for (const w of ['bili_search', 'bili_video', 'bili_debrief', 'music_score', 'qq_explore', 'qq_explore_recall', '《半只耳朵》', 'novel_open', 'novel_write', 'qq_keep_moment', '上网看看']) assert.ok(wakeLine.includes(w), `醒来提示里点名了 ${w}`);
  assert.match(wakeLine, /下面这些也都可以/);
  assert.ok(!/必须|一定要/.test(wakeLine));
  assert.match(sis, /想干什么你自己定：找人说话、逛逛、读首歌的谱、接着写《半只耳朵》、什么都不做，都可以。/);

  const persona = fs.readFileSync(path.join(ROOT, 'sister', 'persona.md'), 'utf8');
  for (const w of ['qq_explore', 'qq_explore_recall', 'music_score', 'bili_search', 'novel_open', 'novel_write', 'novel_prepare', 'qq_keep_moment']) assert.ok(persona.includes(w), `persona 里写了 ${w}`);
  const added = persona.split('\n').filter((l) => /^- (读谱|随便逛|合写小说|心里动了一下)/.test(l));
  assert.equal(added.length, 4);
  assert.ok(!added.some((l) => /必须|一定要|不得|禁止/.test(l)), '新加的只写许可，不写要求');
  assert.ok(added.every((l) => /可以|想.*就|不想/.test(l)), '都是「可以 / 想就…不想就…」的说法');
  assert.ok(!/你能玩的比妹妹少/.test(persona.split('【自己找乐子】')[1].split('\n')[0]), '「你能玩的比妹妹少」那句旧话换掉了');
  // 工具集（权威版 workspace/工具集.md，sync-toolset.mjs 抄到两个人的 笔记/）
  const toolset = fs.readFileSync(path.join(ROOT, 'workspace', '工具集.md'), 'utf8');
  assert.match(toolset, /\*\*随便逛\*\*（🐳📖 一样的频道）：qq_explore/);
  assert.match(toolset, /📖 在自己这一轮里分三步做/);
  for (const n of ['novel_list', 'novel_open', 'novel_read', 'novel_prepare', 'novel_write', 'novel_edit', 'novel_section_done', 'novel_settings', 'novel_new']) assert.ok(toolset.includes(n), `工具集里写了 ${n}`);
  assert.match(toolset, /\*\*合写小说\*\*（🐳📖 一样）/);
  ok('接线：qq-mcp 注册 qq_explore / qq_explore_recall（记录在她脑子的 日子/、不读抖音、不起模型）；醒来提示和 persona 点名了能玩的，都写成「可以」');
}

// ── 5. 真的起一个姐姐的 MCP 进程：注册出 qq_explore / qq_explore_recall（只做不写任何东西的调用）──────────────
{
  const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'sister', 'qq-mcp.mjs')], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'sister-explore-test', version: '0' });
  try {
    await client.connect(t);
    const { tools } = await client.listTools();
    const ex = tools.find((x) => x.name === 'qq_explore');
    const rc = tools.find((x) => x.name === 'qq_explore_recall');
    assert.ok(ex && rc);
    assert.deepEqual(Object.keys(ex.inputSchema.properties).sort(), ['activity', 'hint', 'note', 'open']);
    assert.deepEqual(ex.inputSchema.properties.activity.enum, EXPLORE_ACTIVITIES);
    assert.deepEqual(Object.keys(rc.inputSchema.properties).sort(), ['limit', 'query'], '和小鲸鱼的 qq_explore_recall 同名同参数（她那边多的 key / token 是桥接要的）');
    const nothing = await client.callTool({ name: 'qq_explore', arguments: {} });
    assert.equal(nothing.isError, true);
    assert.match(nothing.content[0].text, /想逛的话 activity 选一样/);
    const both = await client.callTool({ name: 'qq_explore', arguments: { activity: 'news', open: [1] } });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /一次做一样/);
    const rec = await client.callTool({ name: 'qq_explore_recall', arguments: { query: '一个不可能存在的词-xyzzy' } });
    assert.ok(!rec.isError);
    assert.match(rec.content[0].text, /没翻到跟「一个不可能存在的词-xyzzy」有关的|还没有逛过的记录/);
  } finally { try { await client.close(); } catch { /* 关不掉就算了 */ } }
  ok('姐姐的 MCP 进程里真的有 qq_explore（activity / hint / open / note）和 qq_explore_recall（query / limit）；空调用、两样一起做都有话说；翻一个不存在的词没有副作用');
}

console.log(`\n${passed} 项通过`);

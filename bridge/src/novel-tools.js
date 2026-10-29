// 合写本子的工具（2026-10-29 大整理第五批：把 src/novel.js 接给小鲸鱼和姐姐，两边工具名、参数、行为一致）。
//
// 两边各自起一个 MCP 进程（小鲸鱼：src/mcp-snowluma-safe.js；姐姐：sister/qq-mcp.mjs），都调这里的 registerNovelTools。
// 署名自动：小鲸鱼那边 author 固定「小鲸鱼」，姐姐那边固定「姐姐」，工具里没有 author 这个参数，没法冒名。
// 路径限制：书只能在 共享/合写/<书名>/ 里。书名走 safeBookName（不能带 \ / : * ? " < > |，不能点开头），
//   设定集的改法是「按标题一块一块改」，不接受路径；所以工具够不到 共享/合写 外面的任何文件。
//   姐姐的 --restricted 只让她直接读写 sister/home，合写本子必须走这些工具，不给她开 home 外的文件权限。
// 说明文字都是写给她们看的家常话：写之前工具会帮她想起这本书在写什么；写完提醒有没有跑题 / 像日记 / 重复，
//   只是提醒，写不写她自己定。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createNovel, NOVEL_ROOT, FILES, safeBookName, settingsTemplate } from './novel.js';

export const NOVEL_TOOL_NAMES = Object.freeze([
  'novel_open', 'novel_read', 'novel_prepare', 'novel_write', 'novel_edit', 'novel_settings', 'novel_section_done', 'novel_list', 'novel_new'
]);

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (e) => ({ content: [{ type: 'text', text: `没成：${e?.message ?? e}` }], isError: true });

/** 给 book 参数：只有一本书的时候可以不填；有好几本又没填，把名字列出来让她选。 */
function pickBook(novel, book) {
  const given = String(book ?? '').trim();

  if (given) return given;

  const all = novel.list();

  if (all.length === 1) return all[0];
  if (all.length === 0) throw new Error('合写本子里还没有书，可以用 novel_new 开一本');

  throw new Error(`现在有好几本：${all.map((d) => `《${d}》`).join('、')}，book 里写上是哪一本`);
}

const clipText = (s, n) => { const a = [...String(s ?? '')];

 return a.length <= n ? a.join('') : `${a.slice(0, n - 1).join('')}…`; };

const asLines = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/)).map((x) => String(x).trim().replace(/^[-*•]\s*/, '')).filter(Boolean);

/** novel_new：把书名、主题和她填的几条，套进空模板，做成第一份设定集。 */
export function buildNewSettings(name, { theme, imagery, characters, rules, avoid } = {}) {
  const base = settingsTemplate(name).split('\n');
  const out = [];
  let skipping = false;
  const fill = { 主题: theme, 核心意象: imagery, 人物: characters, 规矩: rules, 不写什么: avoid };

  for (const line of base) {
    const h2 = /^##\s+(.*)$/.exec(line);

    if (h2) {
      skipping = false;
      const key = Object.keys(fill).find((k) => h2[1].replaceAll(/\s/g, '').startsWith(k));
      out.push(line);

      if (key === '主题') { out.push(`一句话：${String(theme).trim()}`); skipping = true; continue; }

      if (key && asLines(fill[key]).length > 0) { out.push(...asLines(fill[key]).map((x) => `- ${x}`)); skipping = true; continue; }

      continue;
    }

    if (skipping) { if (!line.trim()) { out.push(line); skipping = false; }

 continue; } // 模板里的占位行换掉，空行留着

    out.push(line);
  }

  return out.join('\n');
}

/**
 * 在 server 上注册 9 个工具。
 * @param {object} server  MCP server（server.tool(name, desc, shape, handler)）
 * @param {object} opts
 * @param {string} opts.author  '小鲸鱼' | '姐姐'：署名，固定死
 * @param {string} opts.partner  对方的名字（说明里用）
 * @param {string} [opts.root]  书的根目录，默认 共享/合写
 * @param {object} [opts.novel]  测试注入
 */
export function registerNovelTools(server, { author, partner, root = NOVEL_ROOT, novel = createNovel({ root }) }) {
  const who = author;
  const BOOK = z.string().max(80).optional().describe('哪一本书（书名，写前半截也行）；只有一本时可以不填');

  server.tool('novel_list',
    `看看合写本子里有哪几本书，每本写到哪了。这些书是你和${partner}一起写的，放在一个你们俩都碰得到的地方，换了会话也还在。`,
    {},
    async () => {
      try {
        const books = novel.list();

        if (books.length === 0) return ok('合写本子里还没有书。想开一本可以用 novel_new。');

        const rows = books.map((b) => {
          try {
            const o = novel.open(b);
            const last = o.last.at(-1);

            return `· 《${b}》${o.entries ? `：${o.sections} 节、${o.entries} 句，最后一句是${last.author} ${String(last.time).slice(5)} 写的` : '：正文还是空的'}`;
          } catch { return `· 《${b}》`; }
        });

        return ok(`合写的书：\n${rows.join('\n')}\n\n用 novel_open 打开一本。`);
      } catch (error) { return fail(error); }
    });

  server.tool('novel_open',
    '打开一本合写的书：先给你这本书的设定集（它在说什么、核心意象、两个人定的规矩、不写什么）和大纲走到哪了，再给最后两句。换了新会话、隔了一阵再接着写、或者不记得这本书当初是怎么回事了，先打开一下，就都想起来了。',
    { book: BOOK },
    async ({ book }) => {
      try { return ok(`${novel.open(pickBook(novel, book)).text}\n\n接着写之前可以先 novel_prepare 看一眼；写用 novel_write。`); } catch (error) { return fail(error); }
    });

  server.tool('novel_read',
    '翻这本书的正文。section 填几就看第几节；last 填几就看最后几句（默认 5 句）；outline 填 true 看大纲和每一节的概况；settings 填 true 看设定集全文。内容长的话会分页，page 填页码接着翻。',
    {
      book: BOOK,
      section: z.number().int().min(1).optional().describe('看第几节'),
      last: z.number().int().min(1).max(30).optional().describe('看最后几句，默认 5'),
      outline: z.boolean().optional().describe('true = 看大纲和每一节的概况'),
      settings: z.boolean().optional().describe('true = 看设定集全文'),
      page: z.number().int().min(1).optional().describe('第几页，默认第 1 页'),
      pageSize: z.number().int().min(200).max(4000).optional().describe('一页多少字，默认 1500')
    },
    async ({ book, section, last, outline, settings, page, pageSize }) => {
      try {
        const r = novel.read(pickBook(novel, book), { section: section ?? null, last: last ?? null, outline: Boolean(outline), settings: Boolean(settings), page: page || 1, pageSize: pageSize || 1500 });
        const more = r.pages > 1 ? `\n\n（第 ${r.page}/${r.pages} 页${r.hasMore ? `，接着看下一页：page 填 ${r.page + 1}` : '，到头了'}）` : '';

        return ok(`《${r.book}》\n${r.text}${more}`);
      } catch (error) { return fail(error); }
    });

  server.tool('novel_prepare',
    '接着写之前先看一眼：这本书在说什么、现在写到第几节、大纲里这一节和下一节写的是什么、上一句是什么、你们俩定过的规矩和不写的东西，还有很久没碰到的核心意象。想写之前可以用，写什么、怎么写还是你自己定。',
    { book: BOOK },
    async ({ book }) => {
      try { return ok(novel.prepare(pickBook(novel, book), who).text); } catch (error) { return fail(error); }
    });

  server.tool('novel_write',
    `往书里接着写一句（或一小段）。只能往后加，署名自动是「${who}」；开新的一节时 section 填 new（title 可以给这一节起个名），不填就接在最后一节后面。写完会帮你看一眼：有没有跟前面重复、是不是一直在原地打转、读着像不像日记、有没有写进设定里说不写的东西——只是提醒，要不要改、改不改你自己定。想先看看提醒、还不想写进去，confirm 填 false。写的时候${partner}要是正好也在写，等一两秒再试就行。`,
    {
      book: BOOK,
      text: z.string().min(1).max(4000).describe('要写的这一句（或这一小段）'),
      section: z.union([z.number().int().min(1), z.string().max(10)]).optional().describe('写进第几节；开新的一节填 new；不填就接在最后一节后面'),
      title: z.string().max(40).optional().describe('开新的一节时，给这一节起个名（可选）'),
      confirm: z.boolean().optional().describe('填 false = 只看提醒、先不写进去')
    },
    async ({ book, text, section, title, confirm }) => {
      try {
        const r = await novel.append(pickBook(novel, book), who, text, { section: section ?? null, title: title || '', confirm: confirm !== false });

        return ok(r.text);
      } catch (error) { return fail(error); }
    });

  server.tool('novel_edit',
    `改你自己写过的某一句。ref 写编号，比如 3-5 就是第 3 节第 5 句。${partner}写的那句只有她自己能改，想改的话可以跟她商量。原来的句子会留在修改记录里，翻得到。`,
    {
      book: BOOK,
      ref: z.string().min(1).max(20).describe('要改哪一句，比如 3-5'),
      text: z.string().min(1).max(4000).describe('改成什么'),
      note: z.string().max(200).optional().describe('为什么改（可选，会记在修改记录里）')
    },
    async ({ book, ref, text, note }) => {
      try { return ok((await novel.edit(pickBook(novel, book), who, ref, text, { note: note || '' })).text); } catch (error) { return fail(error); }
    });

  server.tool('novel_settings',
    `改设定集（这本书在说什么、核心意象、规矩、不写什么、大纲和进度……）。设定集是你和${partner}一起定的，改之前跟她说一声；改了会留记录，note 可以写一句为什么改。patch 一块一块给，比如 { "大纲和进度": "进度：……" }，块的名字对得上标题开头就行，没有这一块就新加一块，值填 null 是删掉那一块。想先看设定集全文用 novel_read（settings 填 true）。`,
    {
      book: BOOK,
      patch: z.union([z.record(z.string().max(40), z.union([z.string().max(8000), z.null()])), z.string().max(20_000)]).describe('一块一块改：{ "块的名字": "新的内容" }'),
      note: z.string().max(300).optional().describe('为什么改（可选，会记在修改记录里）')
    },
    async ({ book, patch, note }) => {
      try {
        let p = patch;

        if (typeof p === 'string') {
          try { p = JSON.parse(p); } catch { p = null; }

          if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('patch 要一块一块地给：{ "大纲和进度": "……" }。整份换掉太冒险了，先不这样');
        }

        return ok((await novel.updateSettings(pickBook(novel, book), who, p, note || '')).text);
      } catch (error) { return fail(error); }
    });

  server.tool('novel_section_done',
    `一节写完了，回头看一眼：这一节跟书的主题是什么关系、碰到了哪些核心意象、大纲上写的和实际写的对不对得上、写的时候被提醒过哪几句。适合和${partner}一起看；下一节往哪推、要不要改大纲，你们商量着来。section 不填就是最后一节。`,
    { book: BOOK, section: z.number().int().min(1).optional().describe('哪一节，默认最后一节') },
    async ({ book, section }) => {
      try { return ok(novel.sectionDone(pickBook(novel, book), section ?? null).text); } catch (error) { return fail(error); }
    });

  server.tool('novel_new',
    `开一本新书。需要书名和一句话主题（这本书在说什么）；核心意象、人物、规矩、不写什么也可以先填几条，不填就留着以后补。新书会建好设定集，换多少次会话都靠它记得这本书是什么。建好以后跟${partner}说一声，设定集是你们俩一起定的。`,
    {
      title: z.string().min(1).max(60).describe('书名'),
      theme: z.string().min(4).max(200).describe('一句话主题：这本书在说什么'),
      imagery: z.union([z.string().max(1000), z.array(z.string().max(200)).max(12)]).optional().describe('核心意象（可选，一行一个，比如「耳朵 / 听（主线）：说明」）'),
      characters: z.union([z.string().max(1000), z.array(z.string().max(200)).max(12)]).optional().describe('人物（可选）'),
      rules: z.union([z.string().max(1000), z.array(z.string().max(200)).max(12)]).optional().describe('你们俩定的规矩（可选）'),
      avoid: z.union([z.string().max(1000), z.array(z.string().max(200)).max(12)]).optional().describe('不写什么（可选；想让工具帮着查的词写在「（词：a、b）」里）')
    },
    async ({ title, theme, imagery, characters, rules, avoid }) => {
      try {
        const name = safeBookName(title);
        const r = await novel.createBook(name, who, { settings: buildNewSettings(name, { theme, imagery, characters, rules, avoid }) });

        return ok(`${r.text}\n接着写用 novel_write（第一句就是第 1 节第 1 句）；设定集改起来用 novel_settings。`);
      } catch (error) { return fail(error); }
    });

  return [...NOVEL_TOOL_NAMES];
}

/**
 * 唤醒时带的一行：最近 48 小时里这本书有人动过，就提一句写到第几节、怎么打开；没有就是空字符串。
 * 只提一句，不灌全文。时间用主机时钟（跟文件修改时间同一个钟），不用换算。
 */
export function novelWakeLine({ root = NOVEL_ROOT, now = Date.now(), hours = 48, novel = createNovel({ root }) } = {}) {
  try {
    const touched = (book) => {
      let t = 0;

      for (const k of ['body', 'settings', 'log']) {
        try { t = Math.max(t, fs.statSync(path.join(root, book, FILES[k])).mtimeMs); } catch { /* 没有就算了 */ }
      }

      return t;
    };

    const recent = novel.list().map((b) => ({ b, t: touched(b) })).filter((x) => x.t && now - x.t <= hours * 3600e3).sort((a, c) => c.t - a.t);

    if (recent.length === 0) return '';

    const o = novel.open(recent[0].b);
    const last = o.last.at(-1);
    const secN = last ? Number(String(last.id).split('-')[0]) || o.sections : 0;
    const where = o.entries ? `写到第 ${secN} 节（共 ${o.entries} 句），最后一句是${last.author} ${String(last.time).slice(5)} 写的` : '刚建好，正文还是空的';
    const more = recent.length > 1 ? `；另外还有 ${recent.length - 1} 本最近也动过（novel_list）` : '';

    return `【合写的书】《${clipText(recent[0].b, 30)}》${where}${more}。想接着写或翻翻，用 novel_open 打开。\n\n`;
  } catch { return ''; }
}

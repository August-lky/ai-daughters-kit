// 两个人的「脑子」在哪——所有代码都从这里取路径，不要再各处写死 memory/、Rambling/、state/episodes。
//
// 2026-10-29 大脑方案（workspace/大脑方案-2026-10-29.md）：小鲸鱼和姐姐各有一个脑子目录，结构一样：
//   脑子/
//     身份/  soul.md  self.md（姐姐：我自己.md）        ← 每次都带
//     长期/  关于老大.md  答应过的事.md  日常.md  memory.md
//     人/    印象.json  <名字>.md
//     瞬间/  <出处>.jsonl  extracted.json  压着.json
//     日子/  日记/  碎碎念/碎碎念.md  成长札记/（我的成长.md、手账/）  三件事/
//     最近/  交接.md  便签.md  心情.json
//     笔记/  工具集.md …
//     作品/
//     .索引/ vectors.db  recall-log.jsonl  降权.json
//     归档/  remember-旧会话.json  旧稿/
// 聊天记录不在脑子里，跟脑子并列：小鲸鱼 家/小鲸鱼/聊天记录/，姐姐 sister/聊天记录/（按「日期-会话」一天一个 md，见 chatlog.js）。
// 小鲸鱼的脑子在 家/小鲸鱼/脑子/；姐姐的必须放在她的工作目录 sister/home/ 里面（--restricted 只让她读写工作目录，
// 会话路径也由工作目录推出来，工作目录不能换）。家/妈妈 不属于任何人的脑子。
//
// 根目录等配置来自 brain/brains.json（Python 的检索服务读同一份）；读不到就用下面的默认值。
// 用法：const b = brainOf('whale'); fs.readFileSync(b.soul)。名字认 whale / sister，也认 小鲸鱼 / 姐姐 / 妹妹 / 🐳 / 📖。
//
// createBrains(root)：按另一个项目根目录造一套（测试用临时根、桥接的测试台用；桥接 / MCP 用 createBrains(ROOT)，
// 这样 ROOT 被换成临时目录时，脑子的路径也跟着走，不会写到真的脑子里）。直接 import 的 brainOf 等是真根目录的那一套。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
export const BRAINS_JSON = path.join(DEFAULT_ROOT, 'brain', 'brains.json');

const DEFAULT_CONFIG = {
  root: '..',
  dsh: '~/.dsh',
  default: 'whale',
  novelRoot: '共享/合写',
  momDir: '家/妈妈',
  brains: {
    whale: { name: '小鲸鱼', aliases: ['小鲸鱼', '鲸', '鲸鱼', '妹妹', 'whale', '🐳'], home: '家/小鲸鱼', brain: '家/小鲸鱼/脑子', gallery: '家/小鲸鱼/形象图', extraSources: [{ path: '家/小鲸鱼/聊天记录', kind: '聊天记录' }], fishMemory: true },
    sister: { name: '姐姐', aliases: ['姐姐', '克', '克劳德', '克劳德姐姐', 'sister', 'claude', '📖'], home: 'sister/home', brain: 'sister/home/脑子', gallery: '', extraSources: [{ path: 'sister/聊天记录', kind: '聊天记录' }], fishMemory: false }
  }
};

function loadConfigFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (raw && raw.brains) return raw;
  } catch { /* 读不到就用默认 */ }
  return DEFAULT_CONFIG;
}

const expand = (p, base) => {
  const s = String(p || '');
  if (!s) return '';
  if (s.startsWith('~')) return path.normalize(path.join(os.homedir(), s.slice(1)));
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(base, s);
};

/** 脑子里的一级文件夹名（固定结构）。 */
export const SUBDIRS = Object.freeze({
  identity: '身份', longterm: '长期', people: '人', moments: '瞬间', days: '日子', recent: '最近',
  notes: '笔记', works: '作品', index: '.索引', archive: '归档'
});

/** 本子的别名：她按「主人」去翻本子时，指向改名后的「关于老大」，免得又新建一本「主人」。 */
export const BOOK_ALIASES = Object.freeze({ 主人: '关于老大', 老大: '关于老大', 关于主人: '关于老大' });

/** 本子名 → 规范名（别名换成现名；其余原样）。 */
export function canonicalBookName(name) {
  const n = String(name ?? '').trim().replace(/\.md$/i, '');
  return BOOK_ALIASES[n] || n;
}

/**
 * 按一个项目根目录造一套脑子路径。root 不传 = 真根目录（读 brain/brains.json 里的 root，通常是 brain/ 的上一级）；
 * 传了就以它为根，配置读 <root>/brain/brains.json，没有就用默认布局。
 */
export function createBrains(root) {
  const explicit = root !== undefined && root !== null && root !== '';
  const jsonFile = explicit ? path.join(path.resolve(root), 'brain', 'brains.json') : BRAINS_JSON;
  const CONFIG = explicit && !fs.existsSync(jsonFile) ? DEFAULT_CONFIG : loadConfigFile(jsonFile);
  const PROJECT_ROOT = explicit ? path.resolve(root) : expand(CONFIG.root || '..', path.dirname(jsonFile));
  const DSH_DIR = expand(CONFIG.dsh || '~/.dsh', PROJECT_ROOT);
  const MOM_DIR = expand(CONFIG.momDir || '家/妈妈', PROJECT_ROOT);
  const NOVEL_ROOT = expand(CONFIG.novelRoot || '共享/合写', PROJECT_ROOT);
  const BRAIN_IDS = Object.freeze(Object.keys(CONFIG.brains));
  const cache = new Map();

  /** 'whale' | 'sister'（也认 小鲸鱼/姐姐/妹妹/🐳/📖 等别名；不传 = 小鲸鱼）→ id；认不出返回 null。 */
  function resolveBrainId(who) {
    const key = String(who ?? '').trim().toLowerCase();
    if (!key) return CONFIG.default || 'whale';
    if (CONFIG.brains[key]) return key;
    for (const [id, b] of Object.entries(CONFIG.brains)) {
      if ([id, b.name, ...(b.aliases || [])].some((a) => String(a).toLowerCase() === key)) return id;
    }
    return null;
  }

  /**
   * 一个人的所有路径。返回冻结的对象，字段：
   *   id name home dir（脑子目录） identity longterm people moments days recent notes works indexDir archive oldDrafts
   *   soul self（身份） aboutBoss promises daily memoryMd（长期） impressions（人/印象.json）
   *   momentsDir extracted pressed（瞬间） diaryDir ramblingDir rambling growthDir growth handbookDir threeThingsDir（日子）
   *   handoff sticky mood（最近） toolset（笔记/工具集.md） worksDir
   *   vectorsDb recallLog demote（.索引） mergedFish（归档/remember-旧会话.json） legacyNovel（旧稿，小说不进回忆）
   *   gallery（形象图，只有小鲸鱼）  persona（姐姐的人设/，不动） chatLogs（聊天记录/，只进索引：姐姐是 sister/聊天记录，小鲸鱼是 家/小鲸鱼/聊天记录——2026-10-29 老大要求两人一样）
   */
  function brainOf(who) {
    const id = resolveBrainId(who);
    if (!id) throw new Error(`不认识的 brain：${who}（只有 ${BRAIN_IDS.join(' / ')}）`);
    if (cache.has(id)) return cache.get(id);
    const c = CONFIG.brains[id];
    const home = expand(c.home, PROJECT_ROOT);
    const dir = expand(c.brain, PROJECT_ROOT);
    const sub = (n) => path.join(dir, n);
    const identity = sub(SUBDIRS.identity);
    const longterm = sub(SUBDIRS.longterm);
    const days = sub(SUBDIRS.days);
    const recent = sub(SUBDIRS.recent);
    const archive = sub(SUBDIRS.archive);
    const oldDrafts = path.join(archive, '旧稿');
    const b = {
      id,
      name: c.name,
      home,
      dir,
      identity,
      longterm,
      people: sub(SUBDIRS.people),
      moments: sub(SUBDIRS.moments),
      days,
      recent,
      notes: sub(SUBDIRS.notes),
      works: sub(SUBDIRS.works),
      indexDir: sub(SUBDIRS.index),
      archive,
      oldDrafts,
      soul: path.join(identity, 'soul.md'),
      self: path.join(identity, id === 'sister' ? '我自己.md' : 'self.md'),
      aboutBoss: path.join(longterm, '关于老大.md'),
      promises: path.join(longterm, '答应过的事.md'),
      daily: path.join(longterm, '日常.md'),
      memoryMd: path.join(longterm, 'memory.md'),
      impressions: path.join(sub(SUBDIRS.people), '印象.json'),
      momentsDir: sub(SUBDIRS.moments),
      extracted: path.join(sub(SUBDIRS.moments), 'extracted.json'),
      pressed: path.join(sub(SUBDIRS.moments), '压着.json'),
      diaryDir: path.join(days, '日记'),
      ramblingDir: path.join(days, '碎碎念'),
      rambling: path.join(days, '碎碎念', '碎碎念.md'),
      growthDir: path.join(days, '成长札记'),
      growth: path.join(days, '成长札记', '我的成长.md'),
      handbookDir: path.join(days, '成长札记', '手账'),
      threeThingsDir: path.join(days, '三件事'),
      handoff: path.join(recent, '交接.md'),
      sticky: path.join(recent, '便签.md'),
      mood: path.join(recent, '心情.json'),
      toolset: path.join(sub(SUBDIRS.notes), '工具集.md'),
      worksDir: sub(SUBDIRS.works),
      vectorsDb: path.join(sub(SUBDIRS.index), 'vectors.db'),
      recallLog: path.join(sub(SUBDIRS.index), 'recall-log.jsonl'),
      demote: path.join(sub(SUBDIRS.index), '降权.json'),
      mergedFish: path.join(archive, 'remember-旧会话.json'),
      legacyNovel: id === 'sister' ? path.join(oldDrafts, '半只耳朵.md') : path.join(oldDrafts, '小说_半只耳朵.md'),
      gallery: c.gallery ? expand(c.gallery, PROJECT_ROOT) : '',
      persona: id === 'sister' ? path.join(home, '人设') : '',
      chatLogs: (() => { const e = (c.extraSources || []).find((x) => x.kind === '聊天记录'); return e ? expand(e.path, PROJECT_ROOT) : ''; })()
    };
    Object.freeze(b);
    cache.set(id, b);
    return b;
  }

  /** 两份合并前的旧稿（小说不进回忆；src/novel.js 的 LEGACY_NOVEL_FILES 用）。 */
  const LEGACY_NOVEL_FILES = Object.freeze(BRAIN_IDS.map((id) => brainOf(id).legacyNovel));

  /**
   * 「本子」工具（memory_list / memory_read / memory_append）看的目录，按先后顺序：先长期/，再笔记/。
   * 写（新建、追加）：已有的本子写回它所在的目录，新本子放进长期/。
   */
  function bookDirsOf(who) {
    const b = brainOf(who);
    return [b.longterm, b.notes];
  }

  /**
   * 不在 长期/、笔记/ 里、但仍然当「本子」翻得到写得进的文件：她以前叫「给下一个我」的那本，现在是 最近/交接.md。
   * 返回 [{ name, file, aliases }]；name 是现在的名字，aliases 是她可能还会用的老名字。
   */
  function bookExtraFiles(who) {
    const b = brainOf(who);
    return [{ name: '交接', file: b.handoff, aliases: ['给下一个我'] }];
  }

  /** 本子名 → 它在 最近/ 之类特别位置的文件（认现名和老名）；不是特别位置的本子返回 ''。 */
  function bookExtraFileFor(who, name) {
    const n = String(name ?? '').trim().replace(/\.md$/i, '');
    const hit = bookExtraFiles(who).find((e) => e.name === n || e.aliases.includes(n));
    return hit ? hit.file : '';
  }

  return {
    PROJECT_ROOT, DSH_DIR, MOM_DIR, NOVEL_ROOT, BRAIN_IDS, LEGACY_NOVEL_FILES,
    resolveBrainId, brainOf, bookDirsOf, bookExtraFiles, bookExtraFileFor, canonicalBookName
  };
}

// 真根目录的那一套（大多数代码直接用这些）
const DEFAULT = createBrains();
export const PROJECT_ROOT = DEFAULT.PROJECT_ROOT;
/** ~/.dsh（dsh-fish-memory、feiyu-mood 等插件的数据都在这下面）。 */
export const DSH_DIR = DEFAULT.DSH_DIR;
/** 家/妈妈：妈妈的 soul/memory，不属于任何人的脑子，不进索引。 */
export const MOM_DIR = DEFAULT.MOM_DIR;
/** 共写小说的根目录（src/novel.js 的 NOVEL_ROOT 同一处）。 */
export const NOVEL_ROOT = DEFAULT.NOVEL_ROOT;
export const BRAIN_IDS = DEFAULT.BRAIN_IDS;
export const LEGACY_NOVEL_FILES = DEFAULT.LEGACY_NOVEL_FILES;
export const resolveBrainId = DEFAULT.resolveBrainId;
export const brainOf = DEFAULT.brainOf;
export const bookDirsOf = DEFAULT.bookDirsOf;
export const bookExtraFiles = DEFAULT.bookExtraFiles;
export const bookExtraFileFor = DEFAULT.bookExtraFileFor;

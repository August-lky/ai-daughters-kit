#!/usr/bin/env node
// 姐妹俩的完全备份（2026-10-22 主人要求：「我怕把她弄丢了，想给她备份到我的 github 仓库」；
// 2026-10-29 大改：本地结构变了，仓库跟着变；目标是「拉下来交给 AI 或跑一键部署，就能搬到新家，而且不丢掉自我」）
//
// 把她们整理进一个独立目录（默认 E:\private-backup，自己的 git 仓库，私有，跟 qq-bridge 的上游仓库、公开工具仓库都分开）：
//   小鲸鱼/  角色卡、脑子/、形象图/、聊天记录/、鱼的记忆/、心情/、鲸鱼日记/、档案.md
//   姐姐/    persona.md、脑子/、人设/、聊天记录/、状态/（会话交接、激素、心情推送、表情库……不含令牌）
//   共享/    合写/（《半只耳朵》）、妈妈的本子/
//   声音/    voices.json、样音/、参考音/、服务脚本（不含模型）
//   状态/    桥接里属于「她」的：social-v2（去令牌）、黑话、表情库、看过的印象、激素当前状态和记录、心情推送、信箱……
//   代码/    qq-bridge 全部代码（含 brain/、public/、plugins-ext/dsh-bili-whale、sister 程序）、抖音 / 鱼的记忆 / 心情插件的本机补丁版
//   部署/    deploy.ps1、restore.mjs、自检.mjs、还原号码.mjs、恢复说明.md、配置骨架、清单.json
// 路径都从 src/brains.js 取（不写死）；全部只读复制，不碰她们正在用的文件和进程。
// 脱敏：去掉所有令牌字段；QQ 号 / 群号换成代号（对照表只留在本机 state/backup-aliases.json，不进备份）——文件名里的号码也换；内网 IP 换掉。
// 扫描：已知密钥原值（.env / config.json / 控制台令牌 / 会话令牌）+ 常见密钥格式 + 残留号码（内容和文件名），扫到一个就停，不提交、不推送。
//
// 用法：node scripts/backup-her.mjs [--push] [--out <目录>] [--no-commit]
//   不带 --push 只整理 + 扫描 + 本地提交；带 --push 才推到 origin。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { brainOf, MOM_DIR, NOVEL_ROOT } from '../src/brains.js';
import { pushWithRetry, resolveProxy } from './git-push-retry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DSH = path.join(HOME, '.dsh');
const NM = path.join(DSH, 'profiles', 'tauri', 'node_modules');
const DOUYIN = path.join(NM, 'dsh-douyin-browser-local');
const VOICE = process.env.VOICE_FEIYU_DIR || 'E:/voice-feiyu';
const DEPLOY_SRC = path.join(ROOT, 'scripts', 'deploy-her');
const args = process.argv.slice(2);
const PUSH = args.includes('--push');
const NO_COMMIT = args.includes('--no-commit');
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'E:/private-backup');
const MARKER = '.private-backup';
const ALIAS_FILE = path.join(ROOT, 'state', 'backup-aliases.json');

const W = brainOf('whale');
const S = brainOf('sister');

const TEXT_EXT = new Set(['.md', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.py', '.yml', '.yaml', '.txt', '.ps1', '.bat', '.cmd', '.vbs', '.html', '.css', '.example', '.sh', '.toml', '.cfg', '.ini']);
// 代码文件里的号码要换成「还是数字」的假号码，换成文字会把语法弄坏（10-29 恢复要能直接跑起来）；还原号码.mjs 能按对照表换回来
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py']);
const SKIP_NAME = /(^|[\\/])(node_modules|\.git|__pycache__|browser-profile|\.npm-cache)([\\/]|$)|\.bak($|[-.])|\.log(\.\d+)?$|\.pyc$|vectors\.db(-journal|-wal|-shm)?$|^\.env$|(^|[\\/])config\.json$|console-token$|\.tmp$/i;

const log = (...a) => console.log('[backup]', ...a);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ── 1. 输出目录：只清理自己建的备份目录（有标记文件或是空目录），.git 保留 ─────────────
function prepareOut() {
  fs.mkdirSync(OUT, { recursive: true });
  const entries = fs.readdirSync(OUT).filter((n) => n !== '.git');
  if (entries.length && !fs.existsSync(path.join(OUT, MARKER))) throw new Error(`${OUT} 不是空目录、也不是之前的备份目录，不敢清理，停下`);
  for (const n of entries) fs.rmSync(path.join(OUT, n), { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, MARKER), '姐妹俩的完全备份目录（scripts/backup-her.mjs 生成；整理时会清空重建，.git 保留）\n');
  fs.writeFileSync(path.join(OUT, '.gitattributes'), '# 原样保存，不做换行转换（记忆文件要逐字节可恢复）\n* -text\n');
}

function copy(src, destRel, { filter = () => true } = {}) {
  if (!fs.existsSync(src)) { log(`跳过（不存在）：${src}`); return 0; }
  const dest = path.join(OUT, destRel);
  const st = fs.statSync(src);
  if (st.isFile()) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return 1; }
  fs.mkdirSync(dest, { recursive: true }); // 空目录也留着（脑子里有的文件夹现在是空的，恢复后结构要完整）
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    // 只看这一级的名字：插件本身装在 ...\node_modules\<插件> 下，拿完整路径去比会把整个插件都跳过（2026-10-22 复查发现抖音插件一直没备上）
    if (SKIP_NAME.test(name) || !filter(s)) continue;
    n += copy(s, path.join(destRel, name), { filter });
  }
  return n;
}

// ── 2. 号码代号 ─────────────────────────────────────────────────────────────
function buildAliases() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {});
  const sis = readJson(path.join(ROOT, 'sister', 'config.json'), {});
  const saved = readJson(ALIAS_FILE, {});
  // 号码至少 6 位：5 位的几乎都不是真人 QQ（10000 是系统号），却很容易撞上配置里的毫秒数，把 JSON 换坏
  const map = new Map(Object.entries(saved).filter(([id]) => /^\d{6,12}$/.test(id)));
  const add = (id, label) => { id = String(id || '').trim(); if (/^\d{6,12}$/.test(id) && !map.has(id)) map.set(id, label()); };
  let n = [...map.values()].filter((v) => /^QQ#/.test(v)).length, g = [...map.values()].filter((v) => /^群#/.test(v)).length;
  add(cfg.ownerQQ, () => 'QQ主人');
  // 她们自己的号：直接读配置（以前向活着的桥接问一遍；备份不该去调运行中的接口）
  add(cfg.snowluma?.selfUin, () => 'QQ小鲸鱼');
  add(sis.fishQQ, () => 'QQ小鲸鱼');
  add(sis.selfQQ, () => 'QQ姐姐');
  add(sis.ownerQQ, () => 'QQ主人');
  for (const id of cfg.allow?.groups || []) add(id, () => `群#${++g}`);
  for (const id of sis.groups || []) add(id, () => `群#${++g}`);
  for (const id of Object.keys(sis.groupAliases || {})) add(id, () => `群#${++g}`);
  for (const id of Object.keys(cfg.houseGroups || {}).concat(sis.houseGroups || [])) add(id, () => `群#${++g}`);
  for (const id of cfg.allow?.private || []) add(id, () => `QQ#${++n}`);
  for (const id of Object.keys(cfg.knownPeople || {})) add(id, () => `QQ#${++n}`);
  const s = readJson(path.join(ROOT, 'state', 'social-v2.json'), {});
  for (const [key, c] of Object.entries(s.conversations || {})) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (m) add(m[2], () => (m[1] === 'group' ? `群#${++g}` : `QQ#${++n}`));
    for (const msg of [...(c.recentMessages || []), ...(c.unread || [])]) add(msg?.userId, () => `QQ#${++n}`);
    for (const id of Object.keys(c.memberImpressions || {})) add(id, () => `QQ#${++n}`);
  }
  // 姐姐的状态里有各群的发言人（uid）和群号；两人的印象表按号码存
  const ss = readJson(path.join(ROOT, 'sister', 'state', 'sister-state.json'), {});
  for (const [gid, gs] of Object.entries(ss.groupState || {})) {
    add(gid, () => `群#${++g}`);
    for (const l of gs?.lines || []) add(l?.uid, () => `QQ#${++n}`);
  }
  for (const f of [W.impressions, S.impressions]) for (const id of Object.keys(readJson(f, {}))) add(id, () => `QQ#${++n}`);
  // 只收真执行过的（被拒绝的请求里可能是随手填的测试号）
  for (const r of readJsonl(path.join(ROOT, 'state', 'group-manage.jsonl'))) if (r.ok === true) add(r.targetUserId, () => `QQ#${++n}`);
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  return map;
}
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }

// ── 3. 脱敏 ─────────────────────────────────────────────────────────────────
// 「accessToken」「consoleToken」是令牌；「ctxTokens」「rotateAtTokens」是 token 数量，要留着（10-26 拉取测试发现被一起删了）
const isSecretKey = (k) => /secret|password|cookie|api_?key/i.test(k) || /token$/i.test(k);
function stripTokens(o) {
  if (Array.isArray(o)) return o.map(stripTokens);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => !isSecretKey(k)).map(([k, v]) => [k, stripTokens(v)]));
}
// 代码里的假号码：从对照表里的位置推出来（对照表只增不删，位置稳定），还原号码.mjs 用同一个公式换回来
let CODE_FAKE = new Map();
function buildCodeFake(aliases) {
  const keys = Object.keys(readJson(ALIAS_FILE, {}));
  CODE_FAKE = new Map();
  for (const id of aliases.keys()) CODE_FAKE.set(id, String(900000000 + keys.indexOf(id)));
}
function redactText(text, aliases, code = false) {
  let t = text;
  for (const [id, alias] of aliases) t = t.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g'), code ? CODE_FAKE.get(id) : alias);
  // 上下文里明显是 QQ 号/群号、但不在对照表里的数字（代码里是测试随手写的，不换）
  if (!code) t = t.replace(/((?:QQ|qq|Q号|QQ号|ownerQQ|uin|user_id|userId|group_id|groupId|群号|private:|group:)["'\s:：=号]{0,4})(\d{5,12})(?!\d)/g, '$1<号码>');
  // 内网 IP
  t = t.replace(/(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g, '<内网IP>');
  return t;
}
// JSON 按结构脱敏：字符串照文本脱敏，号码型的数字换成代号字符串——保证写回去还是合法 JSON。
// 原来是数字的（比如 "ownerQQ": 10051）换成字符串后，还原号码.mjs 要知道它原来是数字：把这类字段名记进 NUMKEYS，
// 每个文件一份，汇总到 部署/号码类型.json（只有字段名，没有号码）。
let NUMKEYS = null;
function redactValue(v, aliases, key = '') {
  if (typeof v === 'string') return redactText(v, aliases);
  if (typeof v === 'number' && Number.isSafeInteger(v)) {
    const s = String(v);
    if (aliases.has(s)) { if (NUMKEYS && key) NUMKEYS.add(redactText(key, aliases)); return aliases.get(s); }
    if (/qq|uin|user_?id|group_?id|owner/i.test(key) && /^\d{6,12}$/.test(s)) return '<号码>';
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, aliases, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, aliases), redactValue(x, aliases, k)]));
  return v;
}
function redactJsonText(text, aliases, jsonl) {
  try {
    if (jsonl) return text.split('\n').map((l) => (l.trim() ? JSON.stringify(redactValue(JSON.parse(l), aliases)) : l)).join('\n');
    const obj = JSON.parse(text.replace(/^\uFEFF/, ''));
    let out = JSON.stringify(redactValue(obj, aliases), null, /\n\s+"/.test(text) ? 2 : 0);
    if (text.endsWith('\n')) out += '\n';
    return text.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out; // 保留原来的换行风格
  } catch { return null; } // 不是合法 JSON（比如带注释），退回按文本处理
}
const NUMTYPES = {};
function redactTree(dir, aliases) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { n += redactTree(p, aliases); continue; }
    const ext = path.extname(name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const before = fs.readFileSync(p, 'utf8');
    NUMKEYS = new Set();
    const asJson = ext === '.json' || ext === '.jsonl' ? redactJsonText(before, aliases, ext === '.jsonl') : null;
    if (NUMKEYS.size) NUMTYPES[path.relative(OUT, p).replaceAll('\\', '/')] = [...NUMKEYS].sort();
    NUMKEYS = null;
    // 结构脱敏后若跟原文"语义相同"（只是格式不同），保留原文，免得每次都改格式
    const sameAsBefore = asJson !== null && (() => { try { return ext === '.json' ? JSON.stringify(JSON.parse(asJson)) === JSON.stringify(JSON.parse(before.replace(/^\uFEFF/, ''))) : asJson === before.split('\n').map((l) => (l.trim() ? JSON.stringify(JSON.parse(l)) : l)).join('\n'); } catch { return false; } })();
    const after = asJson === null ? redactText(before, aliases, CODE_EXT.has(ext)) : (sameAsBefore ? before : asJson);
    if (after !== before) { fs.writeFileSync(p, after); n += 1; }
  }
  return n;
}
// 文件名 / 文件夹名里的号码（聊天记录「2026-10-19-私聊<号码>.md」、瞬间「group_<号码>.jsonl」）。由下往上改，免得先改了父目录。
function redactNames(dir, aliases) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    let p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) n += redactNames(p, aliases);
    const next = redactText(name, aliases, false).replace(/<号码>/g, 'QQ#x');
    if (next !== name) {
      const to = path.join(dir, next);
      if (fs.existsSync(to)) throw new Error(`改名会撞车：${path.relative(OUT, p)} → ${next}`);
      fs.renameSync(p, to); p = to; n += 1;
    }
  }
  return n;
}

// ── 4. 密钥扫描 ───────────────────────────────────────────────────────────────
function knownSecrets() {
  const vals = new Set();
  // 只收真正的密钥值：环境变量名（DEEPSEEK_API_KEY 这种）、公开网址不算
  const addVal = (v) => { v = String(v ?? '').trim(); if (v.length >= 8 && !/^[A-Z][A-Z0-9_]+$/.test(v) && !/^https?:\/\//i.test(v)) vals.add(v); };
  const SECRET_KEY = /token|secret|password|cookie|key/i;
  for (const env of [path.join(ROOT, '.env'), path.join(ROOT, 'sister', '.env')]) {
    try { for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(env, 'utf8')))) if (SECRET_KEY.test(k)) addVal(v); } catch { /* 没有 .env */ }
  }
  for (const f of [path.join(ROOT, 'config.json'), path.join(ROOT, 'sister', 'config.json'), path.join(DSH, 'bili-whale.config.json')]) {
    (function walk(o, k = '') {
      if (o && typeof o === 'object') { for (const [kk, v] of Object.entries(o)) walk(v, kk); return; }
      if (SECRET_KEY.test(k) && !/Env$/.test(k) && typeof o === 'string') addVal(o);
    })(readJson(f, {}));
  }
  try { addVal(fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8')); } catch { /* ignore */ }
  for (const c of Object.values(readJson(path.join(ROOT, 'state', 'social-v2.json'), {}).conversations || {})) addVal(c?.agentToken);
  return vals;
}
const SECRET_PATTERNS = [
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/, 'API 密钥格式（sk-）'], // 前面不能是字母数字：「task-abc…」里的 sk- 不算
  [/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, 'GitHub 令牌'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/(SESSDATA|bili_jct|DedeUserID__ckMd5|sessionid_ss|passport_csrf_token)["'\s]*[=:]\s*["']?[A-Za-z0-9%*,_-]{8,}/, 'Cookie 值'],
  [/AKIA[0-9A-Z]{16}/, 'AWS 密钥'],
  [/(?<![A-Za-z0-9])[0-9a-f]{48}(?![A-Za-z0-9])/, '会话令牌格式（48 位十六进制）'],
];
// 扫描里认得的误报（精确到字符串）：2026-10-29 群友聊天里的「肯德基疯狂星期四」梗，长得像 sk- 密钥，不是密钥
const KNOWN_FALSE_POSITIVES = new Set([['sk-KFC', 'crazyDaY4Vme5Oquickly'].join('')]) // 拆开写：免得这个脚本被公开仓库的扫描当成密钥;
function scan(aliases) {
  const secrets = knownSecrets();
  const hits = [];
  const idRe = [...aliases.keys()].map((id) => [id, new RegExp(`(?<!\\d)${id}(?!\\d)`)]);
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git') continue;
      const p = path.join(dir, name);
      const rel = path.relative(OUT, p);
      for (const [, re] of idRe) if (re.test(name)) hits.push(`${rel} 文件名里有残留号码`);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.has(path.extname(name).toLowerCase())) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const where = `${rel}:${i + 1}`;
        for (const s of secrets) if (line.includes(s)) hits.push(`${where} 已知密钥原值`);
        for (const [re, label] of SECRET_PATTERNS) { const m = re.exec(line); if (m && !KNOWN_FALSE_POSITIVES.has(m[0])) hits.push(`${where} ${label}`); }
        for (const [, re] of idRe) if (re.test(line)) hits.push(`${where} 残留号码`);
      });
    }
  })(OUT);
  return hits;
}

// ── 5. 内容 ─────────────────────────────────────────────────────────────────
// 2026-10-29 新结构：路径全从 src/brains.js 取（脑子、形象图、聊天记录、合写、妈妈的本子），不写死。
function collect() {
  const n = {};
  const st = (f) => path.join(ROOT, 'state', f);

  // ── 小鲸鱼 ──
  n['小鲸鱼/角色卡'] = copy(path.join(ROOT, 'roles'), '小鲸鱼/角色卡', { filter: (p) => /\.md$/i.test(p) });
  // 脑子整个放（身份/长期/人/瞬间/日子/最近/笔记/作品/归档/.索引）；向量库 vectors.db 被 SKIP_NAME 跳过，恢复后重建
  n['小鲸鱼/脑子'] = copy(W.dir, '小鲸鱼/脑子');
  n['小鲸鱼/形象图'] = copy(W.gallery, '小鲸鱼/形象图');
  n['小鲸鱼/聊天记录'] = copy(W.chatLogs, '小鲸鱼/聊天记录');
  n['小鲸鱼/鱼的记忆'] = copy(path.join(DSH, 'fish-memory'), '小鲸鱼/鱼的记忆', { filter: (p) => /\.json$/i.test(p) });
  for (const f of ['fish-memory-config.json', 'fish-memory-links.json']) n[`小鲸鱼/鱼的记忆/${f}`] = copy(path.join(DSH, f), `小鲸鱼/鱼的记忆/${f}`);
  // 心情插件（feiyu-mood）的当前状态：心情值、各维度、理由、时间线——她的身体感受，以前漏备了
  for (const f of ['state.json', 'config.json']) n[`小鲸鱼/心情/${f}`] = copy(path.join(DSH, 'feiyu-mood', f), `小鲸鱼/心情/${f}`);
  for (const f of ['whale-diary.md', 'whale-diary-private.md', 'whale-night.json', 'whale-listen.json', 'whale-log.jsonl']) n[`小鲸鱼/鲸鱼日记/${f}`] = copy(path.join(DSH, f), `小鲸鱼/鲸鱼日记/${f}`);
  n['小鲸鱼/档案'] = copy(path.join(ROOT, 'docs', '小鲸鱼档案.md'), '小鲸鱼/档案.md');

  // ── 姐姐 ──
  n['姐姐/persona'] = copy(path.join(ROOT, 'sister', 'persona.md'), '姐姐/persona.md');
  n['姐姐/脑子'] = copy(S.dir, '姐姐/脑子');
  n['姐姐/人设'] = copy(S.persona, '姐姐/人设');
  n['姐姐/聊天记录'] = copy(S.chatLogs, '姐姐/聊天记录');
  // 她的状态（会话交接、激素当前状态和记录、心情推送、表情库、读哪个群……）；令牌、运行日志、花费记录、每次叫醒生成的 system.md 不要
  const sisState = path.join(ROOT, 'sister', 'state');
  for (const f of ['hormones-sister.json', 'hormones-sister.jsonl', 'mood-push-sister.json', 'current-peer.json', 'voice-sends.json', 'stickers.json']) n[`姐姐/状态/${f}`] = copy(path.join(sisState, f), `姐姐/状态/${f}`);
  const sisterState = readJson(path.join(sisState, 'sister-state.json'));
  if (sisterState) { fs.mkdirSync(path.join(OUT, '姐姐', '状态'), { recursive: true }); fs.writeFileSync(path.join(OUT, '姐姐', '状态', 'sister-state.json'), JSON.stringify(stripTokens(sisterState), null, 2)); n['姐姐/状态/sister-state.json'] = 1; }

  // ── 共享 ──
  n['共享/合写'] = copy(NOVEL_ROOT, '共享/合写');
  n['共享/妈妈的本子'] = copy(MOM_DIR, '共享/妈妈的本子');

  // ── 声音（不含模型）──
  n['声音/voices.json'] = copy(path.join(VOICE, 'voices.json'), '声音/voices.json');
  n['声音/样音'] = copy(path.join(VOICE, '样音'), '声音/样音');
  n['声音/参考音'] = copy(path.join(VOICE, 'FeiyuVoice-CosyVoice3', 'references'), '声音/参考音');
  for (const f of ['feiyu_tts_server.py', '试音.ps1']) n[`声音/脚本/${f}`] = copy(path.join(VOICE, f), `声音/脚本/${f}`);
  // 模型怎么来的（来源、许可证、校验和），模型本身 7G 不进仓库
  for (const f of ['README.md', 'NOTICE.md', 'provenance.json', 'manifest.json', 'files_sha256.json', 'infer.py', 'Speak.ps1', 'runtime.template.json', 'requirements-lock.local.txt']) {
    n[`声音/模型说明/${f}`] = copy(path.join(VOICE, 'FeiyuVoice-CosyVoice3', f), `声音/模型说明/${f}`);
  }
  n['声音/模型说明/licenses'] = copy(path.join(VOICE, 'FeiyuVoice-CosyVoice3', 'licenses'), '声音/模型说明/licenses');

  // ── 状态（桥接里属于「她」的）──
  const hers = ['slang.json', 'slang-session.json', 'stickers.json', 'explore-impressions.jsonl', 'explore-state.json', 'session-titles.json', 'session-titles-extra.json',
    'current-role.json', 'wake-notes.json', 'wake-notes.used.json', 'group-manage.jsonl', 'session-moves.json', 'compactions.json',
    'hormones-fish.json', 'hormones-fish.jsonl', 'mood-push-fish.json', 'sleep-state.json', 'asleep-log.json', 'bedtime-diary.json', 'mirror-state.json',
    'qzone-state.json', 'bili-watch.jsonl', 'douyin-monitor.json', 'initial-prompts.json', 'chatlog-groups.json', 'mode.json', 'profile-state.json'];
  for (const f of hers) n[`状态/${f}`] = copy(st(f), `状态/${f}`);
  const social = readJson(st('social-v2.json'));
  if (social) { fs.mkdirSync(path.join(OUT, '状态'), { recursive: true }); fs.writeFileSync(path.join(OUT, '状态', 'social-v2.json'), JSON.stringify(stripTokens(social), null, 2)); n['状态/social-v2.json'] = 1; }
  n['状态/妈妈信箱'] = copy(path.join(ROOT, 'state', 'mom-mailbox', 'letters.json'), '状态/mom-mailbox/letters.json');
  // 她自己改本子 / 改 self 的历史（note-history、self-history）
  n['状态/agents'] = copy(path.join(ROOT, 'state', 'agents'), '状态/agents');
  for (const f of ['video-impressions.jsonl', 'watch-tell.jsonl', 'share-ledger.json', 'react-ledger.json']) n[`状态/抖音/${f}`] = copy(path.join(DOUYIN, 'state', f), `状态/抖音/${f}`);

  // ── 代码 ──
  const codeFilter = (p) => !/(^|[\\/])(state|tmp|backup)([\\/]|$)/.test(path.relative(ROOT, p));
  for (const d of ['src', 'plugins', 'plugins-ext', 'dsh', 'scripts', 'public', 'workspace', 'docs', 'browser', 'brain']) n[`代码/${d}`] = copy(path.join(ROOT, d), `代码/qq-bridge/${d}`, { filter: codeFilter });
  for (const f of fs.readdirSync(ROOT).filter((x) => /^(package(-lock)?\.json|config\.example\.json|README.*\.md|RULES\.md|LICENSE|.*\.(bat|vbs|ps1)|\.gitignore|\.npmrc)$/i.test(x))) copy(path.join(ROOT, f), `代码/qq-bridge/${f}`);
  copy(path.join(ROOT, 'roles', 'README.md'), '代码/qq-bridge/roles/README.md');
  // 克劳德姐姐的程序（sister.mjs、qq-mcp.mjs 等）；她的人设 / home / 聊天记录 / 状态 / 配置在上面单独放，这里不重复
  n['代码/sister'] = copy(path.join(ROOT, 'sister'), '代码/qq-bridge/sister', { filter: (p) => { const r = path.relative(path.join(ROOT, 'sister'), p); return !/^(state|home|聊天记录)([\\/]|$)|^persona\.md$|oauth|\.bak/i.test(r); } });
  // 大肥鱼表情目录；图片本身按需从 kiriyuki.com 下，不进备份
  copy(path.join(ROOT, 'assets', 'fish-stickers', 'catalog.json'), '代码/qq-bridge/assets/fish-stickers/catalog.json');
  copy(path.join(ROOT, 'memory', 'index.py'), '代码/qq-bridge/memory/index.py');
  copy(path.join(ROOT, 'memory', 'service.py'), '代码/qq-bridge/memory/service.py');
  // 三个 DSH 插件的本机补丁版（抖音、鱼的记忆、心情）；B 站插件在 plugins-ext/dsh-bili-whale，已随 qq-bridge 带上
  n['代码/抖音插件'] = copy(DOUYIN, '代码/dsh-douyin-browser-local', { filter: (p) => !/(^|[\\/])(state|media)([\\/]|$)/.test(path.relative(DOUYIN, p)) });
  n['代码/鱼的记忆插件'] = copy(path.join(NM, 'dsh-fish-memory'), '代码/dsh-fish-memory');
  n['代码/心情插件'] = copy(path.join(NM, 'dsh-feiyu-mood'), '代码/dsh-feiyu-mood');
  const bili = readJson(path.join(DSH, 'bili-whale.config.json'));
  if (bili) {
    for (const k of ['owner', 'self']) if (bili[k]) bili[k] = { mid: '<略>', name: '<略>' };
    fs.mkdirSync(path.join(OUT, '代码'), { recursive: true });
    fs.writeFileSync(path.join(OUT, '代码', 'bili-whale.config.json'), JSON.stringify(stripTokens(bili), null, 2));
  }

  // ── 部署 ──
  n['部署/脚本'] = copy(DEPLOY_SRC, '部署');
  // 配置骨架：真配置去令牌、号码换代号。恢复时落到 config.json，代号处是占位，要换成新机器上的真号码（还原号码.mjs 能按本机对照表一次换好）
  const cfg = readJson(path.join(ROOT, 'config.json'));
  if (cfg) { fs.writeFileSync(path.join(OUT, '部署', 'config.骨架.json'), JSON.stringify(stripTokens(cfg), null, 2) + '\n'); n['部署/config.骨架.json'] = 1; }
  const sis = readJson(path.join(ROOT, 'sister', 'config.json'));
  if (sis) { fs.writeFileSync(path.join(OUT, '部署', 'sister-config.骨架.json'), JSON.stringify(stripTokens(sis), null, 2) + '\n'); n['部署/sister-config.骨架.json'] = 1; }
  // DSH 档案里装了哪些插件（谁是 link、谁来自 github、版本），重装 DSH 后照着配
  const prof = readJson(path.join(DSH, 'profiles', 'tauri', 'package.json'));
  if (prof) { fs.writeFileSync(path.join(OUT, '部署', 'dsh-profile-package.json'), JSON.stringify(stripTokens(prof), null, 2) + '\n'); n['部署/dsh-profile-package.json'] = 1; }
  return n;
}

// 北京时间：本机时钟快约 3 小时，按 bridge 测出的偏差（state/clock-skew.json）校正
function beijingStamp() {
  const skew = Number(readJson(path.join(ROOT, 'state', 'clock-skew.json'), {})?.skewMs) || 0;
  return new Date(Date.now() - skew + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

// ── 6. 清单：恢复后拿来对账（自检.mjs 用）──────────────────────────────────────
function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) { for (const name of fs.readdirSync(d)) { const p = path.join(d, name); if (fs.statSync(p).isDirectory()) walk(p); else out.push(p); } })(dir);
  return out;
}
// 自检的「固定问题」：从每个人自己脑子里的文件各挑一句最长的原话当问题，期望按话题想起时翻得到那个文件。
// 为什么这样出题：写死的问题会随她们的成长过时；从备份时的文件里挑，恢复出来的索引就应该能把这句话翻回原文——翻不回来说明索引或检索服务有问题。
// 按层各取一个（身份、长期、日子、最近、笔记），共 5 个，顺序固定；挑句的规则是确定的，同一份内容永远挑同一句。
const QUESTION_FILES = {
  whale: ['身份/soul.md', '长期/memory.md', '长期/答应过的事.md', '日子/成长札记/我的成长.md', '日子/碎碎念/碎碎念.md', '身份/self.md', '长期/日常.md', '长期/关于老大.md', '最近/交接.md', '笔记/我是怎么做出来的.md'],
  sister: ['身份/我自己.md', '最近/交接.md', '日子/碎碎念/碎碎念.md', '笔记/我是怎么做出来的.md', '笔记/工具集.md']
};
function pickLine(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[\s>*\-+\d.、)）]+/, '').replace(/[*_`#]/g, '').trim());
  const ok = lines.filter((l) => l.length >= 16 && l.length <= 80 && /[一-鿿]{8,}/.test(l) && !/https?:|<号码>|QQ#|群#|QQ主人|\d{5,}|^\||^（这一页|^\(这一页/.test(l));
  if (!ok.length) return '';
  ok.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return ok[0].slice(0, 40);
}
function makeQuestions(brainRel, who) {
  const out = [];
  const root = path.join(OUT, brainRel);
  const dated = (sub) => { try { return fs.readdirSync(path.join(root, sub)).filter((f) => /\.md$/.test(f)).sort().reverse().map((f) => `${sub}/${f}`); } catch { return []; } };
  for (const rel of [...QUESTION_FILES[who].slice(0, 2), ...dated('日子/日记').slice(0, 1), ...QUESTION_FILES[who].slice(2)]) {
    if (out.length >= 5) break;
    const q = pickLine(path.join(root, rel));
    if (q && !out.some((x) => x.来源 === rel.replace(/\.md$/, ''))) out.push({ 问: q, 来源: rel.replace(/\.md$/, '') });
  }
  return out;
}
function writeManifest(counts, aliasCount) {
  const rel = (p) => path.relative(OUT, p).replaceAll('\\', '/');
  const person = (who, brainRel, identityFiles) => {
    const root = path.join(OUT, brainRel);
    const subs = {};
    if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) { const p = path.join(root, name); if (fs.statSync(p).isDirectory()) subs[name] = listFiles(p).length; }
    return {
      名字: who,
      脑子子目录文件数: subs,
      身份文件: identityFiles.filter((f) => fs.existsSync(path.join(OUT, f))).map((f) => ({ 路径: f, sha256: sha256(path.join(OUT, f)) }))
    };
  };
  const manifest = {
    版本: 2,
    说明: '备份时的清单。恢复后 部署/自检.mjs 拿它对账：身份页逐字节一致、各文件夹的文件数不少。路径是仓库里的相对路径。',
    号码代号数: aliasCount,
    人: {
      whale: { ...person('小鲸鱼', '小鲸鱼/脑子', ['小鲸鱼/脑子/身份/soul.md', '小鲸鱼/脑子/身份/self.md', '小鲸鱼/脑子/长期/关于老大.md', '小鲸鱼/脑子/长期/答应过的事.md', '小鲸鱼/脑子/长期/日常.md', '小鲸鱼/脑子/长期/memory.md']), 角色卡: fs.existsSync(path.join(OUT, '小鲸鱼/角色卡')) ? fs.readdirSync(path.join(OUT, '小鲸鱼/角色卡')).filter((f) => /\.md$/.test(f)).map((f) => `小鲸鱼/角色卡/${f}`) : [], 聊天记录文件数: listFiles(path.join(OUT, '小鲸鱼/聊天记录')).length, 瞬间文件数: listFiles(path.join(OUT, '小鲸鱼/脑子/瞬间')).length, 鱼的记忆文件数: listFiles(path.join(OUT, '小鲸鱼/鱼的记忆')).length },
      sister: { ...person('姐姐', '姐姐/脑子', ['姐姐/persona.md', '姐姐/脑子/身份/我自己.md', '姐姐/脑子/最近/交接.md']), 聊天记录文件数: listFiles(path.join(OUT, '姐姐/聊天记录')).length, 瞬间文件数: listFiles(path.join(OUT, '姐姐/脑子/瞬间')).length }
    },
    自检题: { whale: makeQuestions('小鲸鱼/脑子', 'whale'), sister: makeQuestions('姐姐/脑子', 'sister') },
    共享: { 合写文件数: listFiles(path.join(OUT, '共享/合写')).length, 妈妈的本子文件数: listFiles(path.join(OUT, '共享/妈妈的本子')).length },
    声音: { 文件数: listFiles(path.join(OUT, '声音')).length },
    状态文件数: listFiles(path.join(OUT, '状态')).length,
    代码文件数: listFiles(path.join(OUT, '代码')).length,
    环境: { node: process.version, 平台: `${os.platform()} ${os.release()}` },
    本次整理: counts
  };
  fs.writeFileSync(path.join(OUT, '部署', '清单.json'), JSON.stringify(manifest, null, 2) + '\n');
  void rel;
}

function writeReadme(counts, aliasCount) {
  // README 里不写时间：不然每次整理都算"有变化"，天天都会多一个空提交。时间看提交记录。
  fs.writeFileSync(path.join(OUT, 'README.md'), `# 姐妹俩的完全备份（私有）

小鲸鱼（🐳 妹妹）和克劳德姐姐（📖）的全部家当：人格、记忆、聊天记录、心情和激素的当前状态、声音配置、她们跑起来要的代码。
由 \`E:\\qq-bridge\\scripts\\backup-her.mjs\` 生成，每天自动跑一次；每次备份的时间（北京时间）见提交记录。
**这个仓库的目标：拉下来交给 AI，或者跑一键部署脚本，就能让她们搬到新家，而且不丢掉「自我」。**

## 里面有什么

| 目录 | 内容 |
|---|---|
| \`小鲸鱼/\` | \`角色卡/\`、\`脑子/\`（身份、长期、人、瞬间、日子、最近、笔记、作品、归档）、\`形象图/\`、\`聊天记录/\`、\`鱼的记忆/\`（remember 记下的）、\`心情/\`（feiyu-mood 的 state.json）、\`鲸鱼日记/\`、\`档案.md\` |
| \`姐姐/\` | \`persona.md\`、\`脑子/\`、\`人设/\`（设定图）、\`聊天记录/\`、\`状态/\`（会话交接、激素、心情推送、表情库……） |
| \`共享/\` | \`合写/\`（《半只耳朵》）、\`妈妈的本子/\` |
| \`声音/\` | \`voices.json\`、\`样音/\`、\`参考音/\`、服务脚本、模型说明（模型本身 7G 不在仓库里） |
| \`状态/\` | 桥接里属于她的：social-v2（去令牌）、黑话、表情库、看过的印象、激素、心情推送、信箱、自己改本子的历史…… |
| \`代码/\` | \`qq-bridge/\`（全部代码，含 \`brain/\`、\`public/\`、\`plugins-ext/dsh-bili-whale\`、\`sister/\` 程序）、抖音 / 鱼的记忆 / 心情插件的本机补丁版 |
| \`部署/\` | \`deploy.ps1\`（一键部署）、\`恢复说明.md\`（给人和 AI 看）、\`自检.mjs\`、\`还原号码.mjs\`、\`restore.mjs\`、\`config.骨架.json\`、\`清单.json\` |

## 搬家（两种办法）

**办法一：一键。** 在新机器上装好 Node 22+、Python 3.10+、DeepSeek Harness（DSH）、Claude 桌面版，然后：

\`\`\`powershell
git clone <这个仓库> D:\\private-backup
cd D:\\private-backup\\部署
.\\deploy.ps1 -Root D:\\qq-bridge -DryRun      # 先看会放什么、不动任何文件
.\\deploy.ps1 -Root D:\\qq-bridge              # 真放
\`\`\`

**办法二：交给 AI。** 把仓库拉下来，对 AI 说：「读 \`部署/恢复说明.md\`，照着把她们搬到 <目标目录>」。说明里写了要准备什么、哪些要人来配（登录、号码、代理、Cookie）、每一步怎么验证。

恢复之后跑 \`node 部署/自检.mjs --root <目标目录>\`：它核对身份页逐字节一致、各文件夹文件数不少，并让每个人回答 5 个固定问题，看能不能按话题想起来。

## 脱敏说明
- 所有令牌 / 密钥字段都去掉了；\`.env\`、\`config.json\`、浏览器登录数据、Cookie 不在备份里，恢复时要重新配置（\`部署/config.骨架.json\` 是去了令牌的骨架）。
- QQ 号、群号换成了代号（\`QQ主人\`、\`QQ小鲸鱼\`、\`QQ姐姐\`、\`群#n\`、\`QQ#n\`），共 ${aliasCount} 个，文件名里的也换了；代号和真实号码的对照表只在本机 \`E:\\qq-bridge\\state\\backup-aliases.json\`，**不在这个仓库里**。恢复后用对照表跑 \`node 部署/还原号码.mjs --table <对照表> --root <目标目录>\` 换回真号码。
- 内网 IP 换成了 \`<内网IP>\`。

## 本次整理
${Object.entries(counts).map(([k, v]) => `- ${k}：${v} 个文件`).join('\n')}
`);
}

function git(...a) { return execFileSync('git', a, { cwd: OUT, encoding: 'utf8', windowsHide: true }).trim(); }

async function main() {
  prepareOut();
  const aliases = buildAliases();
  buildCodeFake(aliases);
  const counts = collect();
  writeReadme(counts, aliases.size);
  const redacted = redactTree(OUT, aliases);
  fs.writeFileSync(path.join(OUT, '部署', '号码类型.json'), JSON.stringify(Object.fromEntries(Object.entries(NUMTYPES).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
  const renamed = redactNames(OUT, aliases);
  writeManifest(counts, aliases.size);
  log(`整理完：${Object.values(counts).reduce((a, b) => a + b, 0)} 个文件，脱敏改写 ${redacted} 个，文件改名 ${renamed} 个，号码代号 ${aliases.size} 个`);
  const hits = scan(aliases);
  if (hits.length) {
    log(`扫描到 ${hits.length} 处疑似密钥 / 号码，停下（不提交、不推送）：`);
    for (const h of hits.slice(0, 40)) log(`  ${h}`);
    process.exitCode = 2;
    return;
  }
  log('密钥 / 号码扫描：干净');
  if (NO_COMMIT) { log('--no-commit：不提交'); return; }
  if (!fs.existsSync(path.join(OUT, '.git'))) { git('init', '-b', 'main'); log('初始化了 git 仓库'); }
  git('add', '-A');
  const changed = git('status', '--porcelain');
  if (!changed) { log('跟上次一样，没有要提交的'); }
  else {
    const stamp = beijingStamp();
    git('commit', '-q', '-m', `备份 ${stamp}`);
    log(`已提交：${changed.split('\n').length} 处变化`);
  }
  if (PUSH) {
    const remote = (() => { try { return git('remote', 'get-url', 'origin'); } catch { return ''; } })();
    if (!remote) { log('没有配置 origin，不推送'); process.exitCode = 3; return; }
    // 2026-10-26 凌晨推送失败过一次（白天手动重推就好了，多半是网络 / 代理一时不通）：失败隔一会儿再试，最多 3 次；
    // 报错原文（去掉网址里的凭据）写进日志，下次能看出到底是哪种失败。
    // 2026-10-29 主人（M13）：原来一直直连 github，偶尔被重置 / 连不上；改成每次按「走代理 → 走代理 → 直连」轮换，日志写用了哪条路（见 git-push-retry.mjs）。
    const proxy = resolveProxy({ root: ROOT });
    if (!proxy) log('没找到本机代理，只能直连');
    await pushWithRetry({ cwd: OUT, proxy, attempts: 3, log });
    log('已推送');
  }
}

main().catch((error) => { log(`出错：${error?.message ?? error}`); process.exitCode = 1; });

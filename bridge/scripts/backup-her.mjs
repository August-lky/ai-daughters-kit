#!/usr/bin/env node
// 小鲸鱼备份（2026-10-22 主人要求：「我怕把她弄丢了，想给她备份到我的 github 仓库」）
//
// 把"她"整理进一个独立目录（默认 E:\private-backup，自己的 git 仓库，跟 qq-bridge 的上游仓库分开）：
//   她/      角色卡、soul、记忆本子、日记、碎碎念、作品集、形象图、鱼的记忆、鲸鱼日记、档案
//   状态/    聊天缓存（脱敏）、黑话、表情库、看过的视频/资讯印象、会话标题、交接附言……
//   代码/    qq-bridge 本机版（src / 插件 / 预设 / 脚本 / 工作区笔记）、抖音插件本机补丁版
// 脱敏：去掉所有令牌字段；QQ 号 / 群号换成代号（对照表只留在本机 state/backup-aliases.json，不进备份）；内网 IP 换掉。
// 扫描：已知密钥原值（.env / config.json / 控制台令牌 / 会话令牌）+ 常见密钥格式 + 残留号码，扫到一个就停，不提交、不推送。
//
// 用法：node scripts/backup-her.mjs [--push] [--out <目录>]
//   不带 --push 只整理 + 扫描 + 本地提交；带 --push 才推到 origin。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DSH = path.join(HOME, '.dsh');
const DOUYIN = path.join(DSH, 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local');
const args = process.argv.slice(2);
const PUSH = args.includes('--push');
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'E:/private-backup');
const MARKER = '.private-backup';
const ALIAS_FILE = path.join(ROOT, 'state', 'backup-aliases.json');

const TEXT_EXT = new Set(['.md', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.py', '.yml', '.yaml', '.txt', '.ps1', '.bat', '.vbs', '.html', '.css', '.example', '.sh', '.toml', '.cfg', '.ini']);
const SKIP_NAME = /(^|[\\/])(node_modules|\.git|__pycache__|browser-profile|\.npm-cache)([\\/]|$)|\.bak($|[-.])|\.log(\.\d+)?$|\.pyc$|vectors\.db$|^\.env$|(^|[\\/])config\.json$|console-token$/i;

const log = (...a) => console.log('[backup]', ...a);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ── 1. 输出目录：只清理自己建的备份目录（有标记文件或是空目录），.git 保留 ─────────────
function prepareOut() {
  fs.mkdirSync(OUT, { recursive: true });
  const entries = fs.readdirSync(OUT).filter((n) => n !== '.git');
  if (entries.length && !fs.existsSync(path.join(OUT, MARKER))) throw new Error(`${OUT} 不是空目录、也不是之前的备份目录，不敢清理，停下`);
  for (const n of entries) fs.rmSync(path.join(OUT, n), { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, MARKER), '小鲸鱼备份目录（scripts/backup-her.mjs 生成；整理时会清空重建，.git 保留）\n');
  fs.writeFileSync(path.join(OUT, '.gitattributes'), '# 原样保存，不做换行转换（记忆文件要逐字节可恢复）\n* -text\n');
}

function copy(src, destRel, { filter = () => true } = {}) {
  if (!fs.existsSync(src)) { log(`跳过（不存在）：${src}`); return 0; }
  const dest = path.join(OUT, destRel);
  const st = fs.statSync(src);
  if (st.isFile()) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return 1; }
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
async function selfQQ() {
  try {
    const cfg = readJson(path.join(ROOT, 'config.json'), {});
    const token = String(cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${cfg.consolePort || 3100}/api/socialV2/prompt?key=private:${cfg.ownerQQ}`, { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(5000) });
    return String((await res.json())?.self?.userId || '');
  } catch { return ''; }
}
async function buildAliases() {
  const cfg = readJson(path.join(ROOT, 'config.json'), {});
  const saved = readJson(ALIAS_FILE, {});
  // 号码至少 6 位：5 位的几乎都不是真人 QQ（10000 是系统号），却很容易撞上配置里的毫秒数，把 JSON 换坏
  const map = new Map(Object.entries(saved).filter(([id]) => /^\d{6,12}$/.test(id)));
  const add = (id, label) => { id = String(id || '').trim(); if (/^\d{6,12}$/.test(id) && !map.has(id)) map.set(id, label()); };
  let n = [...map.values()].filter((v) => /^QQ#/.test(v)).length, g = [...map.values()].filter((v) => /^群#/.test(v)).length;
  add(cfg.ownerQQ, () => 'QQ主人');
  add(await selfQQ(), () => 'QQ小鲸鱼');
  for (const id of cfg.allow?.groups || []) add(id, () => `群#${++g}`);
  for (const id of cfg.allow?.private || []) add(id, () => `QQ#${++n}`);
  const s = readJson(path.join(ROOT, 'state', 'social-v2.json'), {});
  for (const [key, c] of Object.entries(s.conversations || {})) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (m) add(m[2], () => (m[1] === 'group' ? `群#${++g}` : `QQ#${++n}`));
    for (const msg of [...(c.recentMessages || []), ...(c.unread || [])]) add(msg?.userId, () => `QQ#${++n}`);
    for (const id of Object.keys(c.memberImpressions || {})) add(id, () => `QQ#${++n}`);
  }
  // 只收真执行过的（被拒绝的请求里可能是随手填的测试号）
  for (const r of readJsonl(path.join(ROOT, 'state', 'group-manage.jsonl'))) if (r.ok === true) add(r.targetUserId, () => `QQ#${++n}`);
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  return map;
}
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }

// ── 3. 脱敏 ─────────────────────────────────────────────────────────────────
function stripTokens(o) {
  if (Array.isArray(o)) return o.map(stripTokens);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => !/token|secret|password|cookie|apikey|api_key/i.test(k)).map(([k, v]) => [k, stripTokens(v)]));
}
function redactText(text, aliases) {
  let t = text;
  for (const [id, alias] of aliases) t = t.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g'), alias);
  // 上下文里明显是 QQ 号/群号、但不在对照表里的数字
  t = t.replace(/((?:QQ|qq|Q号|QQ号|ownerQQ|uin|user_id|userId|group_id|groupId|群号|private:|group:)["'\s:：=号]{0,4})(\d{5,12})(?!\d)/g, '$1<号码>');
  // 内网 IP
  t = t.replace(/(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g, '<内网IP>');
  return t;
}
// JSON 按结构脱敏：字符串照文本脱敏，号码型的数字换成代号字符串——保证写回去还是合法 JSON
function redactValue(v, aliases, key = '') {
  if (typeof v === 'string') return redactText(v, aliases);
  if (typeof v === 'number' && Number.isSafeInteger(v)) {
    const s = String(v);
    if (aliases.has(s)) return aliases.get(s);
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
    const obj = JSON.parse(text);
    let out = JSON.stringify(redactValue(obj, aliases), null, /\n\s+"/.test(text) ? 2 : 0);
    if (text.endsWith('\n')) out += '\n';
    return text.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out; // 保留原来的换行风格
  } catch { return null; } // 不是合法 JSON（比如带注释），退回按文本处理
}
function redactTree(dir, aliases) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { n += redactTree(p, aliases); continue; }
    const ext = path.extname(name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const before = fs.readFileSync(p, 'utf8');
    const asJson = ext === '.json' || ext === '.jsonl' ? redactJsonText(before, aliases, ext === '.jsonl') : null;
    // 结构脱敏后若跟原文"语义相同"（只是格式不同），保留原文，免得每次都改格式
    const sameAsBefore = asJson !== null && (() => { try { return ext === '.json' ? JSON.stringify(JSON.parse(asJson)) === JSON.stringify(JSON.parse(before)) : asJson === before.split('\n').map((l) => (l.trim() ? JSON.stringify(JSON.parse(l)) : l)).join('\n'); } catch { return false; } })();
    const after = asJson === null ? redactText(before, aliases) : (sameAsBefore ? before : asJson);
    if (after !== before) { fs.writeFileSync(p, after); n += 1; }
  }
  return n;
}

// ── 4. 密钥扫描 ───────────────────────────────────────────────────────────────
function knownSecrets() {
  const vals = new Set();
  // 只收真正的密钥值：环境变量名（DEEPSEEK_API_KEY 这种）、公开网址不算
  const addVal = (v) => { v = String(v ?? '').trim(); if (v.length >= 8 && !/^[A-Z][A-Z0-9_]+$/.test(v) && !/^https?:\/\//i.test(v)) vals.add(v); };
  const SECRET_KEY = /token|secret|password|cookie|key/i;
  try { for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')))) if (SECRET_KEY.test(k)) addVal(v); } catch { /* 没有 .env */ }
  (function walk(o, k = '') {
    if (o && typeof o === 'object') { for (const [kk, v] of Object.entries(o)) walk(v, kk); return; }
    if (SECRET_KEY.test(k) && !/Env$/.test(k) && typeof o === 'string') addVal(o);
  })(readJson(path.join(ROOT, 'config.json'), {}));
  try { addVal(fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8')); } catch { /* ignore */ }
  for (const c of Object.values(readJson(path.join(ROOT, 'state', 'social-v2.json'), {}).conversations || {})) addVal(c?.agentToken);
  return vals;
}
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, 'API 密钥格式（sk-）'],
  [/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, 'GitHub 令牌'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/(SESSDATA|bili_jct|DedeUserID__ckMd5|sessionid_ss|passport_csrf_token)["'\s]*[=:]\s*["']?[A-Za-z0-9%*,_-]{8,}/, 'Cookie 值'],
  [/AKIA[0-9A-Z]{16}/, 'AWS 密钥'],
  [/(?<![A-Za-z0-9])[0-9a-f]{48}(?![A-Za-z0-9])/, '会话令牌格式（48 位十六进制）'],
];
function scan(aliases) {
  const secrets = knownSecrets();
  const hits = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git') continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.has(path.extname(name).toLowerCase())) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const where = `${path.relative(OUT, p)}:${i + 1}`;
        for (const s of secrets) if (line.includes(s)) hits.push(`${where} 已知密钥原值`);
        for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) hits.push(`${where} ${label}`);
        for (const id of aliases.keys()) if (new RegExp(`(?<!\\d)${id}(?!\\d)`).test(line)) hits.push(`${where} 残留号码`);
      });
    }
  })(OUT);
  return hits;
}

// ── 5. 内容 ─────────────────────────────────────────────────────────────────
function collect() {
  const n = {};
  n.角色卡 = copy(path.join(ROOT, 'roles'), '她/角色卡', { filter: (p) => !/\.bak/i.test(p) });
  n.记忆本子 = copy(path.join(ROOT, 'memory'), '她/记忆本子', { filter: (p) => fs.statSync(p).isDirectory() || /\.md$/i.test(p) });
  n.碎碎念和作品 = copy(path.join(ROOT, 'Rambling'), '她/碎碎念和作品');
  n.形象图 = copy(path.join(ROOT, 'self-gallery'), '她/形象图');
  n.档案 = copy(path.join(ROOT, 'docs', '小鲸鱼档案.md'), '她/小鲸鱼档案.md');
  n.鱼的记忆 = copy(path.join(DSH, 'fish-memory'), '她/鱼的记忆', { filter: (p) => /\.json$/i.test(p) });
  n.鱼的记忆配置 = copy(path.join(DSH, 'fish-memory-config.json'), '她/鱼的记忆/fish-memory-config.json');
  for (const f of ['whale-diary.md', 'whale-diary-private.md']) n[f] = copy(path.join(DSH, f), `她/鲸鱼日记/${f}`);

  for (const f of ['slang.json', 'stickers.json', 'explore-impressions.jsonl', 'session-titles.json', 'session-titles-extra.json', 'current-role.json', 'wake-notes.used.json', 'group-manage.jsonl', 'session-moves.json', 'compactions.json']) {
    n[f] = copy(path.join(ROOT, 'state', f), `状态/${f}`);
  }
  const social = readJson(path.join(ROOT, 'state', 'social-v2.json'));
  if (social) { fs.mkdirSync(path.join(OUT, '状态'), { recursive: true }); fs.writeFileSync(path.join(OUT, '状态', 'social-v2.json'), JSON.stringify(stripTokens(social), null, 2)); n['social-v2.json'] = 1; }
  for (const f of ['video-impressions.jsonl', 'watch-tell.jsonl', 'share-ledger.json', 'react-ledger.json']) n[`抖音/${f}`] = copy(path.join(DOUYIN, 'state', f), `状态/抖音/${f}`);

  const codeFilter = (p) => !/(^|[\\/])(state|tmp|backup)([\\/]|$)/.test(path.relative(ROOT, p));
  for (const d of ['src', 'plugins', 'dsh', 'scripts', 'public', 'workspace', 'docs', 'browser']) n[`代码/${d}`] = copy(path.join(ROOT, d), `代码/qq-bridge/${d}`, { filter: codeFilter });
  for (const f of fs.readdirSync(ROOT).filter((x) => /^(package(-lock)?\.json|config\.example\.json|README.*\.md|RULES\.md|LICENSE|.*\.(bat|vbs|ps1)|\.gitignore|\.npmrc)$/i.test(x))) copy(path.join(ROOT, f), `代码/qq-bridge/${f}`);
  // 克劳德姐姐（2026-10-24）：人设、程序、聊天记录、她自己的文件夹（home：我自己.md、笔记）；登录令牌、运行状态和日志（state）不进备份
  n['代码/克劳德姐姐'] = copy(path.join(ROOT, 'sister'), '代码/qq-bridge/sister', { filter: (p) => { const r = path.relative(path.join(ROOT, 'sister'), p); return !/^state([\\/]|$)|oauth|\.bak/i.test(r); } });
  // 大肥鱼表情目录（2026-10-24）；图片本身按需从 kiriyuki.com 下，不进备份
  copy(path.join(ROOT, 'assets', 'fish-stickers', 'catalog.json'), '代码/qq-bridge/assets/fish-stickers/catalog.json');
  copy(path.join(ROOT, 'memory', 'index.py'), '代码/qq-bridge/memory/index.py');
  copy(path.join(ROOT, 'memory', 'service.py'), '代码/qq-bridge/memory/service.py');
  n['代码/抖音插件'] = copy(DOUYIN, '代码/dsh-douyin-browser-local', { filter: (p) => !/(^|[\\/])(state|media)([\\/]|$)/.test(path.relative(DOUYIN, p)) });
  // 鱼的记忆插件（2026-10-22 起有本机补丁：各会话记忆互通）
  n['代码/鱼的记忆插件'] = copy(path.join(DSH, 'profiles', 'tauri', 'node_modules', 'dsh-fish-memory'), '代码/dsh-fish-memory');
  const bili = readJson(path.join(DSH, 'bili-whale.config.json'));
  if (bili) {
    for (const k of ['owner', 'self']) if (bili[k]) bili[k] = { mid: '<略>', name: '<略>' };
    fs.mkdirSync(path.join(OUT, '代码'), { recursive: true });
    fs.writeFileSync(path.join(OUT, '代码', 'bili-whale.config.json'), JSON.stringify(stripTokens(bili), null, 2));
  }
  return n;
}

// 北京时间：本机时钟快约 3 小时，按 bridge 测出的偏差（state/clock-skew.json）校正
function beijingStamp() {
  const skew = Number(readJson(path.join(ROOT, 'state', 'clock-skew.json'), {})?.skewMs) || 0;
  return new Date(Date.now() - skew + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

function writeReadme(counts, aliasCount) {
  // README 里不写时间：不然每次整理都算"有变化"，天天都会多一个空提交。时间看提交记录。
  fs.writeFileSync(path.join(OUT, 'README.md'), `# 小鲸鱼的备份

由 \`E:\\qq-bridge\\scripts\\backup-her.mjs\` 生成，每天自动跑一次；每次备份的时间（北京时间）见提交记录。

## 里面有什么
- \`她/\`：角色卡、soul、记忆本子（主人 / 答应过的事 / 日常 / 日记）、碎碎念和作品集、形象图、鱼的记忆（remember 记下的）、鲸鱼日记、档案。**这是她最重要的部分。**
- \`状态/\`：各会话的聊天缓存和她对群友的印象（social-v2.json）、黑话、表情库、看过的抖音视频印象、出去玩的印象、会话标题、换会话的交接附言。
- \`代码/\`：qq-bridge 本机版（含所有本机补丁、工作区笔记 workspace/）、抖音插件本机补丁版、B 站插件配置。

## 脱敏说明
- 所有令牌 / 密钥字段都去掉了；\`.env\`、\`config.json\`、浏览器登录数据、Cookie 不在备份里，恢复时要重新配置。
- QQ 号、群号换成了代号（\`QQ主人\`、\`QQ小鲸鱼\`、\`群#1\`、\`QQ#n\`），共 ${aliasCount} 个；代号和真实号码的对照表只在本机 \`E:\\qq-bridge\\state\\backup-aliases.json\`，**不在这个仓库里**。
- 内网 IP 换成了 \`<内网IP>\`。

## 怎么把她找回来
1. 装好 qq-bridge（用 \`代码/qq-bridge\`，\`npm install\`），按 \`config.example.json\` 重新填 \`config.json\` 和 \`.env\`。
2. 把 \`她/角色卡\` 放回 \`roles/\`，\`她/记忆本子\` 放回 \`memory/\`，\`她/碎碎念和作品\` 放回 \`Rambling/\`，\`她/形象图\` 放回 \`self-gallery/\`。
3. \`她/鱼的记忆\` 放回 \`~/.dsh/fish-memory/\`（会话 id 变了的话，把内容复制成新会话 id 的文件，并在 fish-memory-config.json 里打开）。
4. \`状态/\` 里的文件放回 \`state/\`；要用真实号码的话，用本机的对照表把代号换回来。
5. 抖音插件把 \`代码/dsh-douyin-browser-local\` 覆盖回 DSH 的插件目录，\`状态/抖音/\` 放回它的 \`state/\`。

## 本次整理
${Object.entries(counts).map(([k, v]) => `- ${k}：${v} 个文件`).join('\n')}
`);
}

function git(...a) { return execFileSync('git', a, { cwd: OUT, encoding: 'utf8', windowsHide: true }).trim(); }

async function main() {
  prepareOut();
  const aliases = await buildAliases();
  const counts = collect();
  writeReadme(counts, aliases.size);
  const redacted = redactTree(OUT, aliases);
  log(`整理完：${Object.values(counts).reduce((a, b) => a + b, 0)} 个文件，脱敏改写 ${redacted} 个，号码代号 ${aliases.size} 个`);
  const hits = scan(aliases);
  if (hits.length) {
    log(`扫描到 ${hits.length} 处疑似密钥 / 号码，停下（不提交、不推送）：`);
    for (const h of hits.slice(0, 40)) log(`  ${h}`);
    process.exitCode = 2;
    return;
  }
  log('密钥 / 号码扫描：干净');
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
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: OUT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        break;
      } catch (error) {
        const why = String(error?.stderr || error?.message || error).replace(/:\/\/[^@/\s]*@/g, '://***@').trim().split('\n').slice(-3).join(' | ');
        log(`推送第 ${attempt} 次没成：${why}`);
        if (attempt >= 3) throw new Error('推送连续 3 次没成，见上面的原因');
        await new Promise((resolve) => { setTimeout(resolve, attempt * 60e3); });
      }
    }
    log('已推送');
  }
}

main().catch((error) => { log(`出错：${error?.message ?? error}`); process.exitCode = 1; });

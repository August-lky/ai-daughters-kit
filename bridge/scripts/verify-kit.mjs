#!/usr/bin/env node
// 拉取测试：把公开工具包 clone 下来以后，验它「拉得下来、语法对、该有的都有、不该有的没有、离线测试能跑」。
// 2026-10-29 老大：改动大，两个仓库最后都要做拉取测试；推送前在临时目录 clone 本地仓库验一遍，推送后从 GitHub 重新 clone 再验一遍。
//
// 用法：node scripts/verify-kit.mjs --dir <clone 出来的仓库目录> [--install] [--tests] [--timeout 120] [--skip <正则>] [--json]
//   默认只做静态检查（不装依赖、不跑测试）：
//     1. 所有 .js / .mjs / .cjs 过 node --check；所有 .py 过 py_compile；所有 .json 是合法 JSON；
//     2. 必须有的文件（README / AGENTS / THIRD_PARTY / LICENSE、brain 程序、网页和 vendor 许可证、骨架……）；
//     3. 不该有的东西没有（数据库、state、config.json、角色卡、聊天记录、家/、sister/home、.env、令牌格式的字符串）。
//   --install：在 bridge/ 里 npm ci（没有 lock 就 npm install），config.ours.example.json 复制成 config.json（测试要读）。
//   --tests：跑 bridge/scripts/test-*.mjs 和 test-brain-*.py。每个测试一个子进程，HOME / APPDATA 等指到临时目录，超时就算失败；
//            会碰进程 / 页面 / 活的服务的测试默认不跑（见 SKIP_DEFAULT），跑前跑后核对 msedge 进程数没变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const DIR = path.resolve(get('--dir', '.'));
const INSTALL = args.includes('--install');
const TESTS = args.includes('--tests');
const TIMEOUT = Number(get('--timeout', 120)) * 1000;
const JSON_OUT = args.includes('--json');
// 会关进程、刷新页面、开浏览器、改活配置、连活服务的测试：拉取测试不跑
const SKIP_DEFAULT = /^test-(console|dsh-auth|dsh-session-retire|dsh-v2-wait|douyin-watchdog|douyin-chatwatch|forward|mcp-safe|onebot-connection|snowluma-upstream-health|voice-gui|voice-system)/;
const SKIP = get('--skip') ? new RegExp(get('--skip')) : SKIP_DEFAULT;

const results = [];
const add = (status, name, detail = '') => { results.push({ status, name, detail }); if (!JSON_OUT) console.log(`  [${{ ok: '通过', fail: '失败', warn: '提示', skip: '跳过' }[status]}] ${name}${detail ? `：${detail}` : ''}`); };
const exists = (p) => fs.existsSync(path.join(DIR, p));
const walk = (dir, skipDir = /(^|[\\/])(node_modules|\.git)([\\/]|$)/) => { const out = []; (function w(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (skipDir.test(p)) continue; if (fs.statSync(p).isDirectory()) w(p); else out.push(p); } })(dir); return out; };

if (!fs.existsSync(DIR)) { console.error(`目录不存在：${DIR}`); process.exit(2); }
if (!JSON_OUT) console.log(`[verify-kit] ${DIR}`);
const files = walk(DIR);
const rel = (p) => path.relative(DIR, p).replaceAll('\\', '/');

// 1. 语法
{
  const js = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const bad = [];
  for (const f of js) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) bad.push(`${rel(f)}：${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || '语法错误'}`); }
  add(bad.length ? 'fail' : 'ok', `node --check（${js.length} 个 JS）`, bad.slice(0, 5).join('；'));
  const py = files.filter((f) => f.endsWith('.py'));
  const pyBad = [];
  const pyExe = ['python', 'py'].find((x) => spawnSync(x, ['--version']).status === 0);
  if (pyExe) {
    for (const f of py) {
      const r = spawnSync(pyExe, [...(pyExe === 'py' ? ['-3'] : []), '-I', '-c', 'import sys,ast; ast.parse(open(sys.argv[1],encoding="utf-8").read())', f], { encoding: 'utf8' });
      if (r.status !== 0) pyBad.push(rel(f));
    }
    add(pyBad.length ? 'fail' : 'ok', `Python 语法（${py.length} 个 .py）`, pyBad.slice(0, 5).join('；'));
  } else add('warn', 'Python 语法', '没找到 python，没验');
  const jsons = files.filter((f) => f.endsWith('.json') && !/package-lock/.test(f));
  const jbad = [];
  for (const f of jsons) { try { JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { jbad.push(rel(f)); } }
  add(jbad.length ? 'fail' : 'ok', `JSON 合法（${jsons.length} 个）`, jbad.slice(0, 5).join('；'));
}

// 2. 必须有
{
  const must = ['README.md', 'AGENTS.md', 'THIRD_PARTY.md', 'LICENSE', 'docs/问题记录.md', 'docs/工具集.md', 'docs/我是怎么做出来的.md',
    'bridge/package.json', 'bridge/src/bridge.js', 'bridge/src/brains.js', 'bridge/src/brain-client.js', 'bridge/src/novel.js', 'bridge/src/novel-tools.js',
    'bridge/src/hormones.js', 'bridge/src/hormone-shadow.js', 'bridge/src/hormone-feed.js', 'bridge/src/mood.js', 'bridge/src/elsewhere.js', 'bridge/src/self-view.js',
    'bridge/src/chatlog.js', 'bridge/src/image-view.js', 'bridge/src/live-buffer.js', 'bridge/src/daughters-data.js', 'bridge/src/daughters-console.js',
    'bridge/brain/service.py', 'bridge/brain/index.py', 'bridge/brain/recall.py', 'bridge/brain/graph.py', 'bridge/brain/brains.json', 'bridge/brain/brains.example.json',
    'bridge/public/daughters.html', 'bridge/public/brain.html', 'bridge/public/vendor/sigma.min.js', 'bridge/public/vendor/sigma.LICENSE', 'bridge/public/vendor/graphology.umd.min.js', 'bridge/public/vendor/graphology.LICENSE',
    'bridge/plugins-ext/dsh-bili-whale/LICENSE', 'bridge/plugins-ext/dsh-bili-whale/package.json',
    'bridge/sister/sister.mjs', 'bridge/sister/qq-mcp.mjs', 'bridge/sister/live-server.mjs', 'bridge/sister/config.ours.example.json',
    'bridge/config.example.json', 'bridge/config.ours.example.json',
    'third_party/dsh-douyin-browser-local/package.json', 'third_party/dsh-fish-memory/package.json', 'third_party/dsh-feiyu-mood/package.json',
    'templates/脑子骨架/说明.md', 'templates/妹妹角色卡骨架.md', 'templates/姐姐persona骨架.md', 'voice/feiyu_tts_server.py'];
  const miss = must.filter((m) => !exists(m));
  add(miss.length ? 'fail' : 'ok', `必须有的文件（${must.length} 个）`, miss.join('、'));
  const skel = ['身份', '长期', '人', '瞬间', '日子/日记', '日子/碎碎念', '日子/成长札记', '日子/三件事', '最近', '笔记', '作品', '.索引', '归档/旧稿'].filter((d) => !exists(`templates/脑子骨架/${d}/.gitkeep`));
  add(skel.length ? 'fail' : 'ok', '脑子骨架的文件夹都在（git 拉得下来）', skel.join('、'));
  const lic = fs.existsSync(path.join(DIR, 'THIRD_PARTY.md')) ? fs.readFileSync(path.join(DIR, 'THIRD_PARTY.md'), 'utf8') : '';
  add(/sigma\.js/.test(lic) && /graphology/.test(lic) ? 'ok' : 'fail', 'THIRD_PARTY.md 写了 sigma.js 和 graphology');
}

// 3. 不该有
{
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    if (/\.(db|sqlite|sqlite3)$/i.test(r) || /(^|\/)state\//.test(r) || /(^|\/)config\.json$/.test(r) || /(^|\/)\.env$/.test(r)) bad.push(r);
    else if (/^bridge\/roles\/(?!README\.md$)/.test(r) || /^bridge\/sister\/(persona\.md|home\/|聊天记录\/)/.test(r)) bad.push(r);
    else if (/(^|\/)(家|聊天记录|脑子)\//.test(r) && !/^templates\/脑子骨架\//.test(r)) bad.push(r);
    else if (/\.(wav|mp3|ogg|silk)$/i.test(r) && !/^third_party\/dsh-whale-widget\//.test(r)) bad.push(r);
    else if (/\.bak($|[-.])|\.surgery-snapshot$/.test(r)) bad.push(r);
  }
  add(bad.length ? 'fail' : 'ok', '不该有的东西（数据库 / state / 配置 / 角色卡 / 聊天记录 / 脑子 / 语音样本 / .bak）都没有', bad.slice(0, 8).join('；'));
  const secretRe = [/(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(?<![A-Za-z0-9])[0-9a-f]{48}(?![A-Za-z0-9])/, /[A-Za-z0-9._%+-]+@(?:outlook|qq|163|gmail|foxmail|hotmail)\.com/i];
  const hits = [];
  for (const f of files) {
    if (!/\.(md|json|js|mjs|cjs|py|ps1|bat|vbs|html|txt|yml|yaml)$/i.test(f)) continue;
    if (fs.statSync(f).size > 3e6) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const re of secretRe) if (re.test(t)) { hits.push(`${rel(f)} ${re.source.slice(0, 20)}`); break; }
  }
  add(hits.length ? 'fail' : 'ok', '没有令牌 / 密钥 / 邮箱格式的字符串', hits.slice(0, 5).join('；'));
}

// 4. 安装 + 测试
const BRIDGE = path.join(DIR, 'bridge');
if (INSTALL) {
  const lock = fs.existsSync(path.join(BRIDGE, 'package-lock.json'));
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: BRIDGE, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600000 });
  add(r.status === 0 ? 'ok' : 'fail', `npm ${lock ? 'ci' : 'install'}`, r.status === 0 ? '' : (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | '));
  if (!fs.existsSync(path.join(BRIDGE, 'config.json')) && fs.existsSync(path.join(BRIDGE, 'config.ours.example.json'))) fs.copyFileSync(path.join(BRIDGE, 'config.ours.example.json'), path.join(BRIDGE, 'config.json'));
}

function edgeCount() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count; (Get-Process msedge -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).Id"], { encoding: 'utf8', timeout: 20000 }).trim().split(/\r?\n/);
    return `${out[0]}/${out[1] || ''}`;
  } catch { return 'n/a'; }
}

if (TESTS) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-verify-home-'));
  const env = { ...process.env, USERPROFILE: sandbox, HOME: sandbox, APPDATA: path.join(sandbox, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(sandbox, 'AppData', 'Local'), PYTHONIOENCODING: 'utf-8' };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY']) delete env[k];
  fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const before = edgeCount();
  const tests = fs.readdirSync(path.join(BRIDGE, 'scripts')).filter((n) => /^test-.*\.(mjs|py)$/.test(n)).sort();
  let pass = 0, fail = 0, skipped = 0;
  const failed = [];
  for (const t of tests) {
    if (SKIP.test(t)) { skipped++; continue; }
    const isPy = t.endsWith('.py');
    const r = spawnSync(isPy ? 'python' : process.execPath, isPy ? ['-I', path.join('scripts', t)] : [path.join('scripts', t)], { cwd: BRIDGE, env, encoding: 'utf8', timeout: TIMEOUT, windowsHide: true });
    if (r.status === 0) pass++; else { fail++; failed.push(`${t}${r.error?.code === 'ETIMEDOUT' ? '（超时）' : ''}`); }
  }
  const after = edgeCount();
  add(before === after ? 'ok' : 'fail', '跑测试前后 msedge 进程没变', `前 ${before}，后 ${after}`);
  add('ok', `离线测试：${tests.length - skipped} 个里 ${pass} 个通过，${fail} 个没过（${skipped} 个会碰进程 / 页面 / 活服务，没跑）`, failed.length ? `没过：${failed.join('、')}` : '');
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
}

const fails = results.filter((r) => r.status === 'fail').length;
if (JSON_OUT) console.log(JSON.stringify({ ok: fails === 0, fails, results }, null, 2));
else console.log(`[verify-kit] ${fails ? `有 ${fails} 项失败` : '没有失败项'}`);
process.exit(fails ? 1 : 0);

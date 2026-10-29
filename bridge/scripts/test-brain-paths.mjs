// 大脑搬家（2026-10-29）路径检查：
//   1. 扫描 src/ sister/ scripts/ brain/ 和根目录的启动脚本，旧路径字面量必须为零（联接期间允许的在下面 ALLOW 里逐条列出理由）；
//   2. brains.js 给出的两人路径都存在，该有的文件都在；
//   3. brain/brains.json 和 src/brains.js 说的是同一回事（Python 那边读 brains.json，Node 这边读 brains.js）；
//   4. 联接（旧路径）如果还在，指向的是新位置。
// 不连任何活的服务，不写任何东西。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brainOf, BRAIN_IDS, PROJECT_ROOT, MOM_DIR, NOVEL_ROOT, SUBDIRS } from '../src/brains.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log(`✅ ${m}`);

// ── 1. 旧路径字面量扫描 ─────────────────────────────────────────────────────
// 只看代码：整行注释和行尾 " // 注释" 不算（注释里可以说「以前在 memory/」）。
const SCAN_DIRS = ['src', 'sister', 'scripts', 'brain'];
const SCAN_EXT = /\.(js|mjs|cjs|py|ps1|vbs|bat|sh|md)$/i;
const SKIP = /(^|[\\/])(node_modules|state|聊天记录|fixtures|__pycache__|\.git)([\\/]|$)|\.bak|test-brain-paths\.mjs$|\.log$/i;

const FORBIDDEN = [
  { name: 'Rambling 目录', re: /['"`]Rambling['"`]|Rambling[\\/]/ },
  { name: 'self-gallery 目录', re: /self-gallery/ },
  { name: 'path.join(…, "memory", …)', re: /path\.(join|resolve)\([^)]*['"]memory['"]/ },
  { name: 'qq-bridge\\memory 路径串', re: /qq-bridge[\\/]+memory/ },
  { name: 'memory/ 下的本子路径', re: /memory[\\/]+(小鲸鱼|妈妈|vectors\.db|主人|工具集|日常|答应过的事|给下一个我|小说_)/ },
  { name: 'state/episodes', re: /['"]state['"]\s*,\s*['"]episodes['"]|state[\\/]+episodes/ },
  { name: '给下一个我（交接文件的老名字）', re: /给下一个我/ },
  { name: 'sister/home 下的老文件', re: /['"]home['"]\s*,\s*['"](我自己|碎碎念|交接|工具集|成长札记|笔记)(\.md)?['"]|home[\\/]+(我自己|碎碎念|交接|工具集|成长札记|笔记)/ },
  { name: 'impressions.json 直接放在 state 下', re: /['"]impressions\.json['"]|state[\\/]+impressions\.json/ },
  { name: '旧稿文件名（要从 brains.js 取）', re: /小说_半只耳朵|['"]半只耳朵\.md['"]/ }
];

// 允许的例外：[文件（相对项目根，/ 分隔）, 能匹配到的行的正则, 理由]
const ALLOW = [
  ['src/brains.js', /给下一个我|小说_半只耳朵|半只耳朵\.md/, '老名字的别名映射、旧稿文件名只在这里定义一次'],
  ['scripts/backup-her.mjs', /memory['"],\s*'(index|service)\.py'/, 'memory/ 下留着两个转发小文件（联接期间老启动方式还能用），备份要带上'],
  ['scripts/publish-kit.mjs', /memory['"],\s*f\)/, '同上：公开仓库也带上转发小文件'],
  ['scripts/test-freedom.mjs', /path\.join\(tmp,\s*'memory'/, '临时目录里的假路径'],
  ['scripts/test-memory2.mjs', /path\.join\(tmp,\s*'memory'/, '临时目录里的假路径'],
  ['scripts/test-impressions.mjs', /impressions\.json/, '测试用的临时文件名'],
  ['scripts/test-brain-unify.mjs', /给下一个我|path\.join\(ROOT, 'memory'/, '行为测试：老名字（别名映射的输入）和「旧路径不算小说」的反例']
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SKIP.test(rel)) continue;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(name)) out.push(full);
  }
  return out;
}

const codeOnly = (line) => {
  const t = line.trim();
  if (/^(\/\/|\*|\/\*|#|')/.test(t) && !/^#!/.test(t)) return '';
  return line.replace(/\s\/\/\s.*$/, '').replace(/\s#\s.*$/, '');
};

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...fs.readdirSync(ROOT).filter((f) => /\.(ps1|vbs|bat)$/i.test(f) && !/\.bak/i.test(f)).map((f) => path.join(ROOT, f))
];
const hits = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = codeOnly(raw);
    if (!line) return;
    for (const f of FORBIDDEN) {
      if (!f.re.test(line)) continue;
      if (ALLOW.some(([af, are]) => af === rel && are.test(line))) continue;
      hits.push(`${rel}:${i + 1}  [${f.name}]  ${raw.trim().slice(0, 120)}`);
    }
  });
}
assert.equal(hits.length, 0, `还有 ${hits.length} 处旧路径字面量：\n${hits.join('\n')}`);
ok(`扫描了 ${files.length} 个文件（src/ sister/ scripts/ brain/ 和根目录启动脚本）：旧路径字面量 0 处（例外 ${ALLOW.length} 条都有理由）`);

// 例外表不能越写越松：每条例外至少要真的用到过（否则删掉）
const used = new Set();
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = codeOnly(raw);
    if (!line) continue;
    for (const f of FORBIDDEN) if (f.re.test(line)) ALLOW.forEach(([af, are], idx) => { if (af === rel && are.test(line)) used.add(idx); });
  }
}
const unused = ALLOW.map((a, i) => [a, i]).filter(([, i]) => !used.has(i)).map(([a]) => a[0]);
assert.deepEqual(unused, [], `这些例外已经没用了，删掉：${unused.join('、')}`);
ok('例外表里的每一条都真的用到了');

// ── 2. brains.js 给出的路径都在 ─────────────────────────────────────────────
const must = {
  whale: ['dir', 'identity', 'longterm', 'people', 'moments', 'days', 'recent', 'notes', 'works', 'indexDir', 'archive', 'oldDrafts',
    'soul', 'self', 'aboutBoss', 'promises', 'daily', 'memoryMd', 'rambling', 'ramblingDir', 'growthDir', 'growth', 'handbookDir', 'diaryDir',
    'sticky', 'handoff', 'toolset', 'extracted', 'legacyNovel', 'mergedFish', 'gallery'],
  sister: ['dir', 'identity', 'longterm', 'people', 'moments', 'days', 'recent', 'notes', 'works', 'indexDir', 'archive', 'oldDrafts',
    'self', 'impressions', 'rambling', 'ramblingDir', 'handoff', 'toolset', 'legacyNovel', 'persona', 'chatLogs']
};
assert.deepEqual([...BRAIN_IDS].sort(), ['sister', 'whale']);
for (const id of BRAIN_IDS) {
  const b = brainOf(id);
  const missing = must[id].filter((k) => !fs.existsSync(b[k]));
  assert.deepEqual(missing, [], `${id} 的脑子里缺：${missing.map((k) => `${k}=${b[k]}`).join('；')}`);
}
ok('brains.js：两个人的脑子目录、该有的文件都存在');
assert.ok(brainOf('sister').dir.startsWith(brainOf('sister').home + path.sep), '姐姐的脑子必须放在她的工作目录 home 里面');
assert.equal(brainOf('sister').home, path.join(PROJECT_ROOT, 'sister', 'home'), '姐姐的工作目录不能换');
assert.equal(brainOf('whale').dir, path.join(PROJECT_ROOT, '家', '小鲸鱼', '脑子'));
assert.equal(MOM_DIR, path.join(PROJECT_ROOT, '家', '妈妈'));
assert.ok(fs.existsSync(MOM_DIR) && !brainOf('whale').dir.startsWith(MOM_DIR), '家/妈妈 在，且不在任何人的脑子里');
assert.ok(!path.relative(brainOf('sister').home, brainOf('sister').persona).startsWith('脑子'), '人设/ 留在 home 的最外层');
ok('姐姐的脑子在 home 里面、工作目录没换、人设/ 留在最外层、妈妈的本子在 家/妈妈');
assert.ok(NOVEL_ROOT.endsWith(path.join('共享', '合写')));
for (const id of BRAIN_IDS) assert.ok(brainOf(id).oldDrafts.endsWith(path.join('归档', '旧稿')));
for (const sd of Object.values(SUBDIRS)) assert.ok(fs.existsSync(path.join(brainOf('whale').dir, sd)), `小鲸鱼脑子里缺 ${sd}/`);
ok('两个脑子的一级文件夹结构一样（身份/长期/人/瞬间/日子/最近/笔记/作品/.索引/归档）');

// ── 3. brains.json 和 brains.js 是一回事 ────────────────────────────────────
const py = `
import json, sys
sys.path.insert(0, r"${path.join(ROOT, 'brain').replace(/\\/g, '\\\\')}")
import index
out = {}
for bid, b in index.config().brains.items():
    out[bid] = {"home": str(b.home), "dir": str(b.dir), "db": str(b.db), "merged": str(b.merged_fish)}
print(json.dumps(out, ensure_ascii=False))
`;
const pyOut = JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', py], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
for (const id of BRAIN_IDS) {
  const b = brainOf(id);
  assert.equal(path.normalize(pyOut[id].dir).toLowerCase(), path.normalize(b.dir).toLowerCase(), `${id} 脑子目录 Python 和 Node 不一致`);
  assert.equal(path.normalize(pyOut[id].home).toLowerCase(), path.normalize(b.home).toLowerCase());
  assert.equal(path.normalize(pyOut[id].db).toLowerCase(), path.normalize(b.vectorsDb).toLowerCase(), `${id} 向量库路径不一致`);
  assert.equal(path.normalize(pyOut[id].merged).toLowerCase(), path.normalize(b.mergedFish).toLowerCase());
}
ok('brain/brains.json（Python）和 src/brains.js（Node）：两人的脑子、向量库、合并档路径一致');

// ── 4. 联接（旧路径）如果还在，指向新位置 ───────────────────────────────────
const JUNCTIONS = [
  ['memory/小鲸鱼/diary', brainOf('whale').diaryDir],
  ['Rambling/碎碎念', brainOf('whale').ramblingDir],
  ['Rambling/成长札记', brainOf('whale').growthDir],
  ['Rambling/小鲸鱼的作品', brainOf('whale').worksDir],
  ['state/episodes', brainOf('whale').momentsDir],
  ['self-gallery', brainOf('whale').gallery]
];
let present = 0;
for (const [old, target] of JUNCTIONS) {
  const p = path.join(ROOT, old);
  if (!fs.existsSync(p)) continue; // 联接已经拆了，不算错
  present += 1;
  assert.equal(fs.realpathSync(p).toLowerCase(), path.resolve(target).toLowerCase(), `${old} 的联接指错了地方`);
}
ok(`旧路径联接：${present}/${JUNCTIONS.length} 个还在，都指向新位置${present === 0 ? '（联接已全拆）' : ''}`);

// vbs 只能写英文路径
const vbs = fs.readFileSync(path.join(ROOT, 'start-memory-hidden.vbs'), 'utf8');
assert.ok(!/[^\x00-\x7f]/.test(vbs), 'start-memory-hidden.vbs 只能有英文字符（vbs/bat 写中文路径会乱码）');
assert.ok(/brain\\service\.py|brain\\"?\s*$|CurrentDirectory = "E:\\qq-bridge\\brain"/m.test(vbs) && /python service\.py/.test(vbs), 'vbs 要指向 brain/service.py');
const ps1 = fs.readFileSync(path.join(ROOT, 'start-services.ps1'), 'utf8');
assert.ok(ps1.includes('start-memory-hidden.vbs') && !/memory\\service/.test(ps1.replace(/^\s*#.*$/gm, '')), 'start-services.ps1 通过 vbs 起服务，不直接指 memory\\service');
ok('start-memory-hidden.vbs 只有英文字符、指向 brain/service.py；start-services.ps1 通过它启动');

console.log('\n全部通过：大脑路径检查');

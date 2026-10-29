#!/usr/bin/env node
// 工具集（2026-10-26 主人：「整理一下姐妹俩所有的工具，放到一个工具集里，再告诉她们有什么工具去哪里用」）。
// 权威版本只有一份：workspace/工具集.md。改完跑一下这个，把它抄到两个人看得到的地方：
//   小鲸鱼：家/小鲸鱼/脑子/笔记/工具集.md（她的本子，memory_read 工具集）
//   姐姐：sister/home/脑子/笔记/工具集.md（她的文件夹，Read 脑子/笔记/工具集.md）
// （2026-10-29 大脑方案：路径统一从 src/brains.js 取）
// 用法：node scripts/sync-toolset.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brainOf } from '../src/brains.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-10-29 主人：再同步一份《我是怎么做出来的》（workspace/我是怎么做出来的.md → 两人各自的 笔记/我是怎么做出来的.md）。
// 路径照旧从 brains.js 取（笔记/ 是 brainOf(..).notes）。
const JOBS = [
  { src: path.join(ROOT, 'workspace', '工具集.md'), targets: [brainOf('whale').toolset, brainOf('sister').toolset] },
  {
    src: path.join(ROOT, 'workspace', '我是怎么做出来的.md'),
    targets: [path.join(brainOf('whale').notes, '我是怎么做出来的.md'), path.join(brainOf('sister').notes, '我是怎么做出来的.md')]
  }
];

// 2026-10-29 老大：姐姐不能改这两个本子（程序维护的）。除了 claude 那边的 Edit / Write 规则（见 sister.mjs PROTECTED_RULES），
// 这里再给她那两份设上系统只读；同步时先解开、写完再设上，所以这个脚本照常能写。小鲸鱼那边不设。
const SISTER_NOTES = brainOf('sister').notes;
const isSisterNote = (p) => path.resolve(p).startsWith(path.resolve(SISTER_NOTES) + path.sep);
for (const { src, targets } of JOBS) {
  const text = fs.readFileSync(src, 'utf8');
  for (const t of targets) {
    const same = fs.existsSync(t) && fs.readFileSync(t, 'utf8') === text;
    if (!same) {
      if (fs.existsSync(t)) fs.chmodSync(t, 0o666);
      fs.writeFileSync(t, text);
    }
    if (isSisterNote(t) && fs.existsSync(t)) fs.chmodSync(t, 0o444);
    console.log(`${same ? '没变' : '已更新'}：${path.relative(ROOT, t)}${isSisterNote(t) ? '（只读）' : ''}`);
  }
}

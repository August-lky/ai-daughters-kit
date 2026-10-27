#!/usr/bin/env node
// 工具集（2026-10-26 主人：「整理一下姐妹俩所有的工具，放到一个工具集里，再告诉她们有什么工具去哪里用」）。
// 权威版本只有一份：workspace/工具集.md。改完跑一下这个，把它抄到两个人看得到的地方：
//   小鲸鱼：memory/工具集.md（她的本子，memory_read 工具集）
//   姐姐：sister/home/工具集.md（她的文件夹，Read 工具集.md）
// 用法：node scripts/sync-toolset.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'workspace', '工具集.md');
const TARGETS = [path.join(ROOT, 'memory', '工具集.md'), path.join(ROOT, 'sister', 'home', '工具集.md')];

const text = fs.readFileSync(SRC, 'utf8');
for (const t of TARGETS) {
  const same = fs.existsSync(t) && fs.readFileSync(t, 'utf8') === text;
  if (!same) fs.writeFileSync(t, text);
  console.log(`${same ? '没变' : '已更新'}：${path.relative(ROOT, t)}`);
}

#!/usr/bin/env node
// 旧会话记忆合并（2026-10-29 大脑方案二：记忆统一，老大「记忆统一放在一起，不拆」）
//
// dsh-fish-memory 把 remember 记的事按会话分文件存（~/.dsh/fish-memory/<会话id>.json）：插件的写入、提炼、备份都是按会话设计的，
// DSH 里几个会话同时写一个文件会互相覆盖，所以文件还是按会话分。但她搬过几十次家，旧会话留下 66 个文件，里面是同一批事实的大量复制
// （搬家带过去的，实测 1765 条 → 约 140 条不重复），而且旧会话的记忆不在 links 里，现在的她想不起来。
//
// 这个脚本把「不在用的会话」合成一个文件：脑子/归档/remember-旧会话.json（格式跟会话文件一样，插件认得）。
//   · 在用 = fish-memory-links.json 里列着的会话 + 桥接 state/sessions.json 里正在用的会话；其余都算旧会话
//   · 同一个事实键只留最新的一条；没有事实键的，同一个 id 或同样的字只留最新的一条
//   · 已被取代 / refinedSkip 的不要；每条记下 来自会话 是哪个旧会话
//   · 再跑一次时，上一次合并档里的也算一个来源（旧会话文件以后被删了也不丢）
// 桥接的 writeFishLinksV2 把这个文件以「以前的会话」的名义写进 links；插件的 sharedMemoriesFor（本机补丁）认绝对路径，召回时把它们一起想；
// 检索服务（brain/index.py）也把它只读导入索引，memory_recall 能翻到。
// ~/.dsh/fish-memory 里的原文件一个字都不动。
//
// 用法：node scripts/merge-fish-memory.mjs [--dry] [--out <文件>] [--fish-dir <目录>] [--links <文件>] [--sessions <文件>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brainOf } from '../src/brains.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSION_FILE_RE = /^(session-[A-Za-z0-9_-]+)\.json$/;

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const tsOf = (m) => Math.max(Date.parse(m?.at || '') || 0, Date.parse(m?.createdAt || '') || 0);
const normText = (t) => String(t || '').replace(/\s+/g, '');

/** 正在用的会话 id 集合：links 里列着的 + 桥接 state/sessions.json 里的。 */
export function inUseSessions({ linksFile, sessionsFile }) {
  const used = new Set();
  const links = readJson(linksFile, {});
  for (const g of links?.groups || []) for (const sid of Object.keys(g?.sessions || {})) if (SESSION_FILE_RE.test(`${sid}.json`)) used.add(sid);
  const st = readJson(sessionsFile, {});
  for (const sid of Object.values(st?.sessions || {})) if (typeof sid === 'string' && sid) used.add(sid);
  return used;
}

/**
 * 合并。返回 { out, stats }，out 是要写的文件内容（对象）。不写盘。
 * sources 的先后是优先级的反面：后面的同样新就盖掉前面的（所以上一次的合并档放最前面）。
 */
export function buildMerged({ fishDir, usedSessions, previousArchive = null, now = () => new Date() }) {
  const files = fs.existsSync(fishDir) ? fs.readdirSync(fishDir).filter((f) => SESSION_FILE_RE.test(f)).sort() : [];
  const sources = [];
  if (previousArchive?.memories) sources.push({ sid: '旧会话合并档', data: previousArchive });
  const mergedFrom = [];
  let policy = previousArchive?.policy || null;
  for (const f of files) {
    const sid = f.replace(/\.json$/, '');
    if (usedSessions.has(sid)) continue;
    const data = readJson(path.join(fishDir, f));
    if (!data || !Array.isArray(data.memories)) continue;
    sources.push({ sid, data });
    mergedFrom.push(sid);
    if (!policy && data.policy) policy = data.policy;
  }
  const byId = new Map();
  let total = 0;
  for (const { sid, data } of sources) {
    for (const m of data.memories) {
      if (!m || typeof m !== 'object' || !m.text || m.refinedSkip || m.已被取代) continue;
      total += 1;
      const copy = { ...m, 来自会话: m.来自会话 && sid === '旧会话合并档' ? m.来自会话 : sid };
      const id = String(m.id || normText(m.text).slice(0, 40));
      const prev = byId.get(id);
      if (!prev || tsOf(copy) >= tsOf(prev)) byId.set(id, copy);
    }
  }
  // 同一个事实键只留最新的
  const byKey = new Map();
  const noKey = [];
  for (const m of byId.values()) {
    if (m.事实键) {
      const prev = byKey.get(m.事实键);
      if (!prev || tsOf(m) >= tsOf(prev)) byKey.set(m.事实键, m);
    } else noKey.push(m);
  }
  // 没有事实键的：同样的字只留最新的
  const byText = new Map();
  for (const m of noKey) {
    const k = normText(m.text);
    const prev = byText.get(k);
    if (!prev || tsOf(m) >= tsOf(prev)) byText.set(k, m);
  }
  const memories = [...byKey.values(), ...byText.values()].sort((a, b) => tsOf(a) - tsOf(b));
  const out = {
    version: 2,
    policy: policy || {},
    memories,
    traces: [],
    deleted: [],
    合并说明: '旧会话记忆合并档（scripts/merge-fish-memory.mjs 生成）：所有不在用的会话合在一起，同一个事实键只留最新的；原文件在 ~/.dsh/fish-memory 里没动。',
    合并自: [...new Set([...(previousArchive?.合并自 || []), ...mergedFrom])].sort(),
    合并于: now().toISOString()
  };
  return { out, stats: { files: mergedFrom.length, before: total, after: memories.length, withKey: byKey.size } };
}

export function mergeFishMemory({ fishDir, linksFile, sessionsFile, outFile, dry = false, now } = {}) {
  const used = inUseSessions({ linksFile, sessionsFile });
  const previousArchive = fs.existsSync(outFile) ? readJson(outFile) : null;
  const { out, stats } = buildMerged({ fishDir, usedSessions: used, previousArchive, now });
  if (!dry) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = `${outFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, outFile); // 先写临时文件再改名
  }
  return { ...stats, inUse: used.size, outFile, dry };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const dsh = path.join(os.homedir(), '.dsh');
  const r = mergeFishMemory({
    fishDir: arg('--fish-dir', path.join(dsh, 'fish-memory')),
    linksFile: arg('--links', path.join(dsh, 'fish-memory-links.json')),
    sessionsFile: arg('--sessions', path.join(ROOT, 'state', 'sessions.json')),
    outFile: arg('--out', brainOf('whale').mergedFish),
    dry: args.includes('--dry')
  });
  console.log(`${r.dry ? '（试跑，没写盘）' : '已写'}：${path.relative(ROOT, r.outFile)}`);
  console.log(`在用的会话 ${r.inUse} 个；合并了 ${r.files} 个旧会话；${r.before} 条 → 去重后 ${r.after} 条（有事实键的 ${r.withKey} 条）`);
}

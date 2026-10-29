// 把小鲸鱼以前的聊天补进 家/小鲸鱼/聊天记录/（2026-10-29 第五批；老大：「给妹妹也做成一样吧」）。
//
// 用法：
//   node scripts/backfill-fish-chatlog.mjs            # 先 dry-run：只统计，什么都不写
//   node scripts/backfill-fish-chatlog.mjs --write    # 真写（已经有的行不重复，可以反复跑）
// 可选：--root <项目根>  --sessions-dir <会话存档目录>  --douyin-dir <抖音插件 state 目录>  --out <输出目录>  --skew <毫秒>
//       --no-social（不用 state/social-v2.json）  --no-douyin（不补抖音私信）
//
// 原料（都只读）：DSH 会话存档（zstd 多段拼接，按段解）、state/social-v2.json 的 recentMessages、抖音插件的 chat-inbox.jsonl。
// 不启动、不重启任何东西，不碰 QQ。细节见 src/chatlog-backfill.js。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrains } from '../src/brains.js';
import { pickGroupName, sisterGroupNames } from '../src/chatlog.js';
import {
  buildChatLogRows, decodeZstdLines, douyinRows, extractSessionChat, mergeFileMaps, writeChatLogs,
} from '../src/chatlog-backfill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { write: false, social: true, douyin: true };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === '--write') out.write = true;
    else if (a === '--dry-run') out.write = false;
    else if (a === '--no-social') out.social = false;
    else if (a === '--no-douyin') out.douyin = false;
    else if (['--root', '--sessions-dir', '--douyin-dir', '--out', '--skew'].includes(a)) { out[a.slice(2).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = argv[i + 1]; i += 1; }
  }

  return out;
}

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return fallback; } };

export function runBackfill(opts = {}) {
  const root = path.resolve(opts.root || path.join(HERE, '..'));
  const stateDir = path.join(root, 'state');
  const brains = createBrains(root);
  const whale = brains.brainOf('whale');
  const outDir = path.resolve(opts.out || whale.chatLogs || path.join(whale.home, '聊天记录'));
  const sessionsDir = path.resolve(opts.sessionsDir || path.join(brains.DSH_DIR, 'sessions', '--E-qq-bridge-state-agents--'));
  const douyinDir = path.resolve(opts.douyinDir || path.join(brains.DSH_DIR, 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state'));
  const cfg = readJson(path.join(root, 'config.json'), {});
  const ownerQQ = cfg.ownerQQ ? String(cfg.ownerQQ) : '';
  const knownPeople = cfg.knownPeople && typeof cfg.knownPeople === 'object' ? cfg.knownPeople : {};
  const houseGroups = cfg.houseGroups && typeof cfg.houseGroups === 'object' ? cfg.houseGroups : {};
  const skewMs = Number.isFinite(+opts.skew) && opts.skew !== undefined ? +opts.skew : (Number(readJson(path.join(stateDir, 'clock-skew.json'), {}).skewMs) || 0);
  const titles = readJson(path.join(stateDir, 'session-titles.json'), {});
  const groupCache = readJson(path.join(stateDir, 'chatlog-groups.json'), {});
  const sisterGroups = sisterGroupNames(path.join(root, 'sister', 'state', 'sister-state.json'));
  const isSisterQQ = (uid) => /姐姐/.test(String(knownPeople[String(uid)] || ''));

  // 会话 id → 会话 key（sessions.json 现在在用的 + session-moves.json 里换下来的旧的和新的）
  const sidKey = new Map();
  for (const [key, sid] of Object.entries(readJson(path.join(stateDir, 'sessions.json'), {}).sessions || {})) sidKey.set(String(sid), key);
  for (const mv of readJson(path.join(stateDir, 'session-moves.json'), []) || []) {
    if (mv?.key && mv.oldSid && !sidKey.has(String(mv.oldSid))) sidKey.set(String(mv.oldSid), mv.key);
    if (mv?.key && mv.newSid && !sidKey.has(String(mv.newSid))) sidKey.set(String(mv.newSid), mv.key);
  }

  // 跟桥接写聊天记录时用的同一套叫法（文件名要对得上，才能跟已有的合在一起）
  const sessionOf = (key) => {
    if (key.startsWith('group:')) {
      const g = key.slice(6);
      const name = pickGroupName(g, { alias: houseGroups[g] || '', cached: groupCache[g] || '', sister: sisterGroups[g] || '', title: titles[key] || '' });

      return { type: 'group', name };
    }

    const uid = key.slice(8);

    if (ownerQQ && uid === ownerQQ) return { type: 'owner' };
    if (isSisterQQ(uid)) return { type: 'sister' };

    return { type: 'friend', name: String(knownPeople[uid] || titles[key] || uid) };
  };

  const stats = { sessionsDir, outDir, skewMs, sessions: 0, sessionsWithChat: 0, frames: 0, incoming: 0, sent: 0, selfSeen: 0, social: 0, douyin: 0, skippedNoKey: 0 };
  const items = [];

  // 1. 会话存档
  if (fs.existsSync(sessionsDir)) {
    for (const dir of fs.readdirSync(sessionsDir).sort()) {
      const file = path.join(sessionsDir, dir, 'session.v4.jsonl.zstd');

      if (!fs.existsSync(file)) continue;

      stats.sessions += 1;

      const lines = decodeZstdLines(fs.readFileSync(file));
      const r = extractSessionChat(lines, { sessionKey: sidKey.get(dir) || '' });

      if (!r.key) { stats.skippedNoKey += 1; continue; }

      if (r.incoming.length + r.sent.length + r.selfSeen.length > 0) stats.sessionsWithChat += 1;

      stats.incoming += r.incoming.length;
      stats.sent += r.sent.length;
      stats.selfSeen += r.selfSeen.length;

      for (const m of r.incoming) items.push({ ...m, source: 'session' });
      for (const m of r.sent) items.push({ ...m, isSelf: true, source: 'send' });
      for (const m of r.selfSeen) items.push({ ...m, isSelf: true, source: 'seen' });
    }
  } else console.log(`（找不到会话存档目录：${sessionsDir}）`);

  // 2. social-v2.json 里每个会话最近的消息
  if (opts.social !== false) {
    const social = readJson(path.join(stateDir, 'social-v2.json'), {});

    for (const [key, conv] of Object.entries(social.conversations || {})) {
      if (!/^(group|private):\d+$/.test(key)) continue;

      for (const m of conv?.recentMessages || []) {
        const text = String(m?.text ?? m?.plain ?? '').trim();
        const at = Number(m?.time ?? m?.at);

        if (!text || !Number.isFinite(at) || m.kind === 'poke') continue;

        stats.social += 1;
        items.push({ key, at, sender: String(m.sender ?? ''), userId: m.userId != null ? String(m.userId) : '', isOwner: Boolean(m.isOwner) && !m.isSelf, isSelf: Boolean(m.isSelf) || m.sender === '我', text, mid: m.messageId != null ? String(m.messageId) : '', source: 'social' });
      }
    }
  }

  const qqFiles = buildChatLogRows(items, { skewMs, ownerQQ, knownPeople, sessionOf, selfName: '小鲸鱼' });

  // 3. 抖音私信
  let dyFiles = new Map();

  if (opts.douyin !== false) {
    const inbox = (() => { try { return fs.readFileSync(path.join(douyinDir, 'chat-inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
    const policy = readJson(path.join(douyinDir, 'chat-policy.json'), {});

    stats.douyin = inbox.length;
    dyFiles = douyinRows(inbox, policy.allowlist, { skewMs, selfName: '小鲸鱼' });
  }

  const files = mergeFileMaps(qqFiles, dyFiles);
  const report = writeChatLogs(files, outDir, { dryRun: opts.write !== true });
  const days = [...files.keys()].map((n) => n.slice(0, 10)).sort();

  return { stats, report, days: days.length ? [days[0], days[days.length - 1]] : [], fileCount: files.size, write: opts.write === true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const r = runBackfill(opts);
  const { stats, report } = r;

  console.log(`${r.write ? '【真写】' : '【dry-run，只统计，什么都没写】'}`);
  console.log(`会话存档：${stats.sessions} 个（有聊天的 ${stats.sessionsWithChat}，认不出是哪个 QQ 会话的 ${stats.skippedNoKey}）`);
  console.log(`取到：对方的话 ${stats.incoming} 条、她用工具发的 ${stats.sent} 条、快照里她说的 ${stats.selfSeen} 条；social-v2 ${stats.social} 条；抖音私信 ${stats.douyin} 条`);
  console.log(`日期范围：${r.days.join(' ～ ') || '（没有）'}；会分到 ${r.fileCount} 个文件，输出目录 ${stats.outDir}`);
  console.log(`${r.write ? '写入' : '会写入'}：新增 ${report.added} 行，涉及 ${report.filesTouched} 个文件（其中新建 ${report.filesCreated} 个）`);

  for (const f of report.files) if (f.added > 0) console.log(`  ${f.name}：原有 ${f.existing} 行，${r.write ? '加了' : '会加'} ${f.added} 行 → ${f.total} 行`);

  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

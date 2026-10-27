// 把 ~/.dsh/sessions/--E-qq-bridge-state-agents--/ 下所有旧会话记录里的"瞬间"抽进 state/episodes/。
// 只写 state/episodes/（<key>.jsonl + extracted.json 增量索引），不碰桥接和 DSH。
// 用法：node scripts/backfill-episodes.mjs [--force] [--dry] [--dir <sessionsDir>]
import fs from 'node:fs';
import path from 'node:path';
import { createEpisodeStore } from '../src/episodes.js';
import { DEFAULT_SESSIONS_DIR, extractSessionEpisodes, loadExtractEnv } from '../src/episode-extract.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const dirIdx = args.indexOf('--dir');
const sessionsDir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : DEFAULT_SESSIONS_DIR;

const env = loadExtractEnv();
const store = dry ? null : createEpisodeStore({ dir: env.episodesDir, skewMs: env.skewMs, ownerKey: env.ownerQQ ? `private:${env.ownerQQ}` : '' });
const sids = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).filter((d) => fs.existsSync(path.join(sessionsDir, d, 'session.v4.jsonl.zstd'))).sort()
  : [];

const perKey = {};
let processed = 0;
let skipped = 0;
let appended = 0;
let deduped = 0;
for (const sid of sids) {
  let r;
  try {
    r = extractSessionEpisodes(sid, { ...env, sessionsDir, store, indexFile: dry ? '' : env.indexFile, force });
  } catch (error) {
    console.error(`${sid.slice(0, 16)}… 失败：${error?.message ?? error}`);
    continue;
  }
  if (r.skipped) { skipped += 1; continue; }
  processed += 1;
  appended += r.appended;
  deduped += r.deduped;
  for (const e of r.episodes) perKey[e.key] = (perKey[e.key] || 0) + 1;
  console.log(`${sid.slice(0, 16)}… key=${r.key || '?'} 瞬间 ${r.episodes.length}（新存 ${r.appended}，重复 ${r.deduped}）`);
}
console.log(JSON.stringify({ sessions: sids.length, processed, skipped, appended, deduped, extractedPerKey: perKey, storedPerKey: store ? store.counts() : null }, null, 2));

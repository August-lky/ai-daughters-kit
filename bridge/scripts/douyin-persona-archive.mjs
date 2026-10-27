#!/usr/bin/env node
// 抖音人格账本归档（2026-10-26）。
// 她刷抖音时每看一条、每记一次兴趣，插件都往 ~/.dsh/douyin-browser/memory/persona/state.json 里追加证据，从不清理；
// 文件上限 8MB，到了就拒绝保存（「人格证据达到文件上限，本次没有丢弃旧证据或伪造保存」），自主观看跟着停。
// 10-20 到 10-26 攒到 8.38MB：观看记录 5642 条、观察 3324 条。
//
// 这里把 keepDays 天以前的观看 / 互动记录、以及不再被任何东西引用的旧观察，原样挪进 persona/archive/ 下的归档文件
// （不删，随时能翻），兴趣本身和兴趣引用的证据全部留着——插件要求每条引用都能在 observations 里找到。
// 用插件同一把文件锁（.write.lock，wx 独占），写完用插件自己的 PersonaMemory.readFiles() 再校验一遍，校验不过就还原。
//
// 用法：node scripts/douyin-persona-archive.mjs [--keep-days 3] [--if-over-mb 6] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : d; };
const KEEP_DAYS = opt('--keep-days', 3);
const IF_OVER_MB = opt('--if-over-mb', 0);
const DRY = args.includes('--dry-run');
const PLUGIN = path.join(os.homedir(), '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local');
const DIR = path.join(os.homedir(), '.dsh', 'douyin-browser', 'memory', 'persona');
const STATE = path.join(DIR, 'state.json');
const LOCK = path.join(DIR, '.write.lock');
const log = (...a) => console.log('[persona-archive]', ...a);

/** 纯函数：给定账本和截止时间，算出留下的和归档的。兴趣引用的、留下的观看 / 互动引用的观察都留着。 */
export function splitPersona(state, cutoff) {
  const behavior = state.behavior || { version: 1, viewings: [], actions: [] };
  const keepView = behavior.viewings.filter((v) => Number(v.at) >= cutoff);
  const keepAct = behavior.actions.filter((v) => Number(v.at) >= cutoff);
  const needed = new Set([
    ...state.interests.flatMap((i) => i.evidence.map((e) => e.evidenceId)),
    ...keepView.map((v) => v.evidenceId), ...keepAct.map((v) => v.evidenceId)
  ]);
  const keepObs = state.observations.filter((o) => Number(o.observedAt || 0) >= cutoff || needed.has(o.id));
  const keptIds = new Set(keepObs.map((o) => o.id));
  const next = { ...state, generation: state.generation + 1, observations: keepObs, behavior: { ...behavior, viewings: keepView, actions: keepAct } };
  const archived = {
    observations: state.observations.filter((o) => !keptIds.has(o.id)),
    viewings: behavior.viewings.filter((v) => !(Number(v.at) >= cutoff)),
    actions: behavior.actions.filter((v) => !(Number(v.at) >= cutoff))
  };
  return { next, archived };
}

function lock() {
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx', 0o600);
      try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return () => { try { if (fs.readFileSync(LOCK, 'utf8') === owner) fs.unlinkSync(LOCK); } catch { /* 已经不是我的锁 */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error('插件一直占着人格锁，这次先不整理');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

async function main() {
  const size = fs.statSync(STATE).size;
  if (IF_OVER_MB && size < IF_OVER_MB * 1048576) { log(`账本 ${(size / 1048576).toFixed(2)}MB，没到 ${IF_OVER_MB}MB，不用整理`); return; }
  const { PersonaMemory } = await import(pathToFileURL(path.join(PLUGIN, 'persona-memory.mjs')).href);
  const memory = new PersonaMemory({ memoryDir: path.dirname(DIR) });
  const unlock = DRY ? () => {} : lock();
  try {
    const raw = fs.readFileSync(STATE, 'utf8');
    const state = JSON.parse(raw);
    const { next, archived } = splitPersona(state, Date.now() - KEEP_DAYS * 86400e3);
    const nextRaw = JSON.stringify(next, null, 2) + '\n';
    log(`${(Buffer.byteLength(raw) / 1048576).toFixed(2)}MB → ${(Buffer.byteLength(nextRaw) / 1048576).toFixed(2)}MB；归档观察 ${archived.observations.length}、观看 ${archived.viewings.length}、互动 ${archived.actions.length}（留最近 ${KEEP_DAYS} 天）`);
    if (DRY) return;
    if (!archived.observations.length && !archived.viewings.length && !archived.actions.length) { log('没有可归档的'); return; }
    fs.mkdirSync(path.join(DIR, 'archive'), { recursive: true });
    const archiveFile = path.join(DIR, 'archive', `state-archive-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(archiveFile, JSON.stringify({ archivedAt: new Date().toISOString(), keepDays: KEEP_DAYS, fromGeneration: state.generation, ...archived }));
    const backup = `${STATE}.before-archive`;
    fs.copyFileSync(STATE, backup);
    fs.writeFileSync(`${STATE}.tmp`, nextRaw);
    fs.renameSync(`${STATE}.tmp`, STATE);
    try {
      memory.readFiles(); // 插件自己的校验：引用对不上会抛错
    } catch (e) {
      fs.copyFileSync(backup, STATE);
      throw new Error(`整理后插件校验不过，已还原：${e.message}`);
    }
    log(`好了，归档在 ${path.relative(DIR, archiveFile)}`);
  } finally { unlock(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { log(`没成：${e.message}`); process.exitCode = 1; });

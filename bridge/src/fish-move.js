// 搬家时把鱼的记忆（dsh-fish-memory，~/.dsh/fish-memory/<sessionId>.json）从旧会话带到新会话。
// 2026-10-25：群「群聊」那条线从第一个会话起就没开过鱼的记忆，插件从来没给它建过文件，
// 每次搬家都 ENOENT → 记成「-1 条」，新会话的开关也没碰。这里把"没有文件"当成正常情况（0 条），
// 旧文件不在时再看插件自己的备份（.bak、fish-memory-backup/<日期>/）和更早的搬家链，哪儿有就从哪儿带。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 跟插件的 storePath 同一个规则（lib/index.js）。 */
export function fishStorePath(dir, sid) {
  return path.join(dir, `${String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

/** 跟插件的 isEnabled 同一个规则：sessions 里写了就照写的，否则看旧版 enabled 名单，默认关。 */
export function fishEnabled(cfg, sid) {
  const m = cfg?.sessions;
  if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, sid)) return Boolean(m[sid]);
  return Array.isArray(cfg?.enabled) && cfg.enabled.includes(sid);
}

function atomicWriteJsonDefault(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

/** 读一份库；文件不在返回 null，坏了（解析不了 / 不像库）也返回 null 并记下原因。 */
function readStore(file, problems) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') problems.push(`${path.basename(file)} 读不了：${error.message}`);
    return null;
  }
  try {
    const store = JSON.parse(raw);
    if (!store || typeof store !== 'object' || !Array.isArray(store.memories ?? [])) throw new Error('不是鱼的记忆库');
    return store;
  } catch (error) { problems.push(`${path.basename(file)} 坏了：${error.message}`); return null; }
}

/** 一个会话能找到的最新一份库：本体 → .bak → 每日备份（新的日期优先）。 */
function findStoreFor(sid, { fishDir, backupDir }, problems) {
  const main = fishStorePath(fishDir, sid);
  const own = readStore(main, problems);
  if (own) return { store: own, from: path.basename(main) };
  const bak = readStore(`${main}.bak`, problems);
  if (bak) return { store: bak, from: `${path.basename(main)}.bak` };
  if (backupDir) {
    let days = [];
    try { days = fs.readdirSync(backupDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch { days = []; }
    for (const d of days) {
      const b = readStore(path.join(backupDir, d, path.basename(main)), problems);
      if (b) return { store: b, from: `备份 ${d}` };
    }
  }
  return null;
}

/**
 * 旧会话 → 新会话。返回 { count, from, enabled, kept, problems }：
 *   count   带过去的记忆条数（找不到任何库就是 0，不再是 -1）
 *   from    从哪份带的（'' 表示哪儿都没有）
 *   enabled 新会话的鱼的记忆开关是否打开
 *   kept    新会话里原来就有、保留下来的条数
 * 只有真写不进去（或配置文件坏了不敢覆盖）才抛错，调用方记 -1。
 * history：state/session-moves.json 的数组；旧会话自己没文件时顺着它往前找（上一次搬家没搬成的那份还在前一个会话里）。
 */
export function migrateFishMemory({ fishDir, cfgFile, backupDir = '', oldSid, newSid, history = [], writeJson = atomicWriteJsonDefault }) {
  const problems = [];
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`fish-memory-config.json 读不了，不敢改：${error.message}`);
  }

  // 1. 找源：旧会话 → 顺着搬家链往前（防环，最多 20 步）
  let found = findStoreFor(oldSid, { fishDir, backupDir }, problems);
  const seen = new Set([oldSid, newSid]);
  for (let sid = oldSid, step = 0; !found && step < 20; step += 1) {
    const prev = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h && h.newSid === sid && h.oldSid && !seen.has(h.oldSid));
    if (!prev) break;
    sid = prev.oldSid;
    seen.add(sid);
    const r = findStoreFor(sid, { fishDir, backupDir }, problems);
    if (r) found = { ...r, from: `更早的会话 ${sid}（${r.from}）` };
  }

  // 2. 写新会话：新会话里已经有的（她刚进门就 remember 了 / 插件分支继承）不盖，按 id 合并
  const dst = fishStorePath(fishDir, newSid);
  const existing = readStore(dst, problems);
  const kept = (existing?.memories || []).length;
  let count = 0;
  if (found) {
    const src = found.store;
    const have = new Set((existing?.memories || []).map((m) => m && m.id).filter(Boolean));
    const carried = (src.memories || []).filter((m) => m && !(m.id && have.has(m.id)));
    count = carried.length;
    const out = existing
      ? { ...existing, memories: [...(existing.memories || []), ...carried] }
      : { ...src, memories: carried, traces: [] };
    fs.mkdirSync(fishDir, { recursive: true });
    writeJson(dst, out);
  }

  // 3. 开关：带到了库、或者旧会话本来就开着 → 新会话打开；都没有就照旧（插件默认关，开不开是主人定的）
  const oldOn = fishEnabled(cfg, oldSid);
  const enable = Boolean(found) || oldOn || fishEnabled(cfg, newSid);
  const sessions = { ...(cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {}) };
  let changed = false;
  if (enable && sessions[newSid] !== true) { sessions[newSid] = true; changed = true; }
  if (Object.prototype.hasOwnProperty.call(sessions, oldSid) && sessions[oldSid] !== false) { sessions[oldSid] = false; changed = true; }
  if (changed) writeJson(cfgFile, { ...cfg, sessions });

  return { count, from: found ? found.from : '', enabled: enable, kept, problems };
}

// 排查用（2026-10-25 她所有会话都报 DeepSeek 400）：在一个临时工作区里新建会话，发一句话，看这一轮成没成。
// 用法：node scripts/probe-v2-session.mjs [preset=qq-chat-v2] [effort]
// 不碰她的任何会话；临时工作区建在系统临时目录，跑完归档这个会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const preset = process.argv[2] || 'qq-chat-v2';
const effort = process.argv[3] || 'high';
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const d = cfg.dsh || {};
const api = new NodeApiClient(d.baseUrl || 'http://127.0.0.1:3080', undefined, { token: d.authToken, tokenExplicit: d.authTokenExplicit === true, header: d.authHeader, prefix: d.authPrefix });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-probe-'));
const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
const { sessionId } = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: preset }), 'session.create');
console.log('session', sessionId, 'preset', preset);
unwrap(await api.sessions.selectModel({ sessionId, provider: d.provider || 'deepseek-official', model: d.model || 'deepseek-flash', reasoningEffort: effort }), 'selectModel');
unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '（这是测试，不用调用任何工具，直接用文字回一个字：好）' }] }), 'prompt');
// 等这一轮结束：看会话日志里的 turn/end
const sessDir = path.join(os.homedir(), '.dsh', 'sessions');
const zlib = await import('node:zlib');
const findFile = () => { for (const w of fs.readdirSync(sessDir)) { const f = path.join(sessDir, w, sessionId, 'session.v4.jsonl.zstd'); if (fs.existsSync(f)) return f; } return null; };
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decode = (raw) => { const idx = []; let p = 0; while ((p = raw.indexOf(MAGIC, p)) >= 0) { idx.push(p); p += 4; } let t = ''; for (let i = 0; i < idx.length; i++) { try { t += zlib.zstdDecompressSync(raw.subarray(idx[i], idx[i + 1] ?? raw.length)).toString('utf8'); } catch { /* 半截帧 */ } } return t; };
const t0 = Date.now();
let result = 'timeout';
while (Date.now() - t0 < 90e3) {
  await new Promise((r) => setTimeout(r, 2000));
  const f = findFile();
  if (!f) continue;
  const ends = decode(fs.readFileSync(f)).split('\n').filter((l) => l.includes('"turn/end"'));
  if (ends.length) { result = ends[ends.length - 1].slice(0, 300); break; }
}
console.log('result', result, `${Math.round((Date.now() - t0) / 1000)}s`);
try { await api.workspace.archiveSession({ sessionId }); } catch { /* 归档不了就留着 */ }
process.exit(0);

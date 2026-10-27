// 黑话学习会话太长就换新的（2026-10-24）：上一次用到的上下文超过 6 万 token 就换；没超过照旧复用
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };

// 抠出 slangSessionCtxV2 + readTailLinesV2，喂假账本
const tailStart = src.indexOf('  function readTailLinesV2(file, bytes = 400 * 1024) {');
const tailEnd = src.indexOf('\n  }\n', tailStart) + 4;
const ctxStart = src.indexOf('  function slangSessionCtxV2(sid) {');
const ctxEnd = src.indexOf('  function invalidateSlangLearnerSession() {');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slangrot-'));
const ledger = path.join(dir, 'token-usage.jsonl');
const make = new Function('fs', 'TOKEN_USAGE_FILE', `${src.slice(tailStart, tailEnd)}\n${src.slice(ctxStart, ctxEnd)}\nreturn slangSessionCtxV2;`);
const ctxOf = make(fs, ledger);
fs.writeFileSync(ledger, [
  { k: 'turn', sid: 'session-a', b: { cacheMiss: 200000, cacheHit: 23000 } },
  { k: 'turn', sid: 'session-b', b: { cacheMiss: 1000, cacheHit: 20000 } },
  { k: 'base', sid: 'session-a', b: { cacheMiss: 1, cacheHit: 1 } }
].map((r) => JSON.stringify(r)).join('\n') + '\n');
assert.equal(ctxOf('session-a'), 223000);
assert.equal(ctxOf('session-b'), 21000);
assert.equal(ctxOf('session-none'), 0);
fs.rmSync(dir, { recursive: true, force: true });
ok('按会话 id 从账本里取最后一步的上下文大小');

assert.match(src, /const SLANG_SESSION_ROTATE_TOKENS = 60000;/);
const ensure = src.slice(src.indexOf('  async function ensureSlangLearnerSession() {'), src.indexOf('  /** 某个学习会话最后一步的上下文大小'));
assert.match(ensure, /let saved = readJsonSafe\(SLANG_SESSION_FILE, null\);/);
assert.match(ensure, /if \(reuseCtx > SLANG_SESSION_ROTATE_TOKENS\) \{[\s\S]*invalidateSlangLearnerSession\(\);\n\s+saved = null;/);
assert.ok(ensure.indexOf('reuseCtx > SLANG_SESSION_ROTATE_TOKENS') < ensure.indexOf('if (slangLearnerSessionId) {'), '先判断要不要换，再走复用');
ok('接线：超过 6 万先作废旧会话、清掉 saved，后面就会新建');
console.log(`全部通过：${passed} 组`);

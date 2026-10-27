// 唤醒里没变的段不重发（2026-10-25 省钱）：同一个会话、没压缩、12 小时内，没变的段不带；【你只有一个】只给新的几行；
// 发出去成功（commit）才算给过；换会话 / 压缩过就全量。从 bridge.js 源码里抠出这几个函数，配假的状态跑。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { truncateText } from '../src/md-to-plain.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const start = src.indexOf('  const sentSectionsV2 = new Map();');
const end = src.indexOf('  // 主人电脑上的动态（pc-watch.ps1');
assert.ok(start > 0 && end > start, '找到那段源码');
const body = src.slice(start, end);

const now = Date.now();
const env = {
  state: { sessions: { 'private:1': 'sid-a' } },
  comps: { 'sid-a': 0 },
  conversations: new Map([['group:9', { recentMessages: [{ at: now - 60e3, sender: '群友', text: '在吗' }, { at: now - 30e3, isSelf: true, text: '在' }] }]])
};
const make = new Function('crypto', 'state', 'compactionCountV2', 'socialV2', 'knownNameV2', 'readDouyinJsonlV2', 'douyinContactV2', 'douyinDmTextV2', 'cfg', 'clockSkewMs', 'truncateText', 'SHARED_MEMORY_WINDOW_MS', 'SHARED_MEMORY_PER_SESSION', 'sharedKeyLabelV2',
  `${body}\nreturn { freshOnlyV2, commitSectionsV2, buildSharedMemoryV2, pendingSectionsV2, pendingSharedV2 };`);
const f = make(crypto, env.state, (sid) => env.comps[sid] || 0, { conversations: env.conversations }, () => '', () => [], () => ({}), () => '', { ownerQQ: '1' }, 0, truncateText, 6 * 3600e3, 30, (k) => k);
const begin = () => { f.pendingSectionsV2.set('private:1', {}); f.pendingSharedV2.delete('private:1'); };

// ① 没变的段：第一次带，commit 后第二次不带；变了又带；没 commit（没发出去）就照带
{
  begin();
  assert.equal(f.freshOnlyV2('private:1', 'self', 'A'), 'A');
  begin();
  assert.equal(f.freshOnlyV2('private:1', 'self', 'A'), 'A', '上一次没发出去（没 commit）就照带');
  f.commitSectionsV2('private:1');
  begin();
  assert.equal(f.freshOnlyV2('private:1', 'self', 'A'), '', '发出去过、没变：不带');
  assert.equal(f.freshOnlyV2('private:1', 'self', 'B'), 'B', '变了就带');
  ok('没变的段：发出去过才不带；变了、没发出去都照带');
}
// ② 压缩过 / 换了会话：全量
{
  begin(); f.freshOnlyV2('private:1', 'x', 'X'); f.commitSectionsV2('private:1');
  env.comps['sid-a'] = 1;
  begin();
  assert.equal(f.freshOnlyV2('private:1', 'x', 'X'), 'X', '压缩过就重给');
  f.commitSectionsV2('private:1');
  env.state.sessions['private:1'] = 'sid-b';
  begin();
  assert.equal(f.freshOnlyV2('private:1', 'x', 'X'), 'X', '换了会话就重给');
  ok('压缩过、换了会话：重新给全的');
}
// ③ 【你只有一个】：第一次全量，之后只给新的；没新的就不带
{
  begin();
  const full = f.buildSharedMemoryV2('private:1', { delta: true });
  assert.ok(full.startsWith('【你只有一个】') && full.includes('在吗') && full.includes('私事的分寸'));
  f.commitSectionsV2('private:1');
  begin();
  assert.equal(f.buildSharedMemoryV2('private:1', { delta: true }), '', '没新的就不带');
  env.conversations.get('group:9').recentMessages.push({ at: now - 5e3, sender: '群友', text: '吃了吗' });
  begin();
  const d = f.buildSharedMemoryV2('private:1', { delta: true });
  assert.ok(d.startsWith('【你只有一个 · 新的】') && d.includes('吃了吗') && !d.includes('在吗'), d);
  begin();
  assert.ok(f.buildSharedMemoryV2('private:1', { delta: false }).startsWith('【你只有一个】'), 'staticDue 时全量');
  ok('【你只有一个】：第一次全的，之后只给新说的，没新的就不带');
}
console.log(`全部通过：${passed} 组`);

// 跟着看 B 站：从 bili 输出里读标题 / UP；只算妹妹看的、同一条只算一次、只要 since 之后的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBiliWatch, freshBili } from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

// biliMetaOf 在 MCP 服务文件里（导入会起服务），这里照抄它的解析规则单独测输出格式
const sample = '=== 元信息 ===\n  【官方 MV】Never Gonna Give You Up - Rick Astley\n  UP 索尼音乐中国 |  | 213s | 发布 2019/12/31 15:43:23\n  aid=80433022 cid=137649199\n';
const src = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8');
const fnSrc = src.slice(src.indexOf('export function biliMetaOf'), src.indexOf('function noteBiliWatch')).replace('export ', '');
const biliMetaOf = new Function(`${fnSrc}; return biliMetaOf;`)();
assert.deepEqual(biliMetaOf(sample), { title: '【官方 MV】Never Gonna Give You Up - Rick Astley', up: '索尼音乐中国' });
assert.deepEqual(biliMetaOf('没有元信息'), { title: '', up: '' });
ok('从 bili 输出读出标题和 UP 主');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcw-'));
  const f = path.join(dir, 'bili-watch.jsonl');
  const rows = [
    { at: 100, who: 'fish', kind: 'video', bvid: 'BV1', title: 'a' },
    { at: 200, who: 'sister', kind: 'debrief', bvid: 'BV2', title: 'b' },
    { at: 300, who: 'fish', kind: 'debrief', bvid: 'BV1', title: 'a' },
    { at: 400, who: 'fish', kind: 'video', bvid: 'BV3', title: 'c' }
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{坏行\n');
  const read = readBiliWatch(f);
  assert.equal(read.length, 4, '坏行跳过');
  assert.deepEqual(freshBili(read, 0).map((r) => [r.bvid, r.kind]), [['BV1', 'debrief'], ['BV3', 'video']], '只算妹妹的，同一条取最后一次');
  assert.deepEqual(freshBili(read, 350).map((r) => r.bvid), ['BV3'], '只要 since 之后的');
  assert.deepEqual(readBiliWatch(path.join(dir, 'nope.jsonl')), []);
  ok('只算妹妹看的、同一条算一次、文件没有就是空');
}

console.log(`全部通过：${passed} 组`);

// 姐姐看妹妹的状态（sister/fish-status.mjs）：睡没睡、睡到几点（按北京时间、扣掉本机时钟偏差）、最近在哪有动静、在不在刷抖音。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fishStatus } from '../sister/fish-status.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
const bridge = path.join(dir, 'state'); const plugin = path.join(dir, 'plugin');
fs.mkdirSync(bridge); fs.mkdirSync(plugin);
const skew = 3 * 3600e3;
const bj = (d, h, m) => Date.parse(`2026-10-${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - 8 * 3600e3 + skew;
const now = bj(25, 1, 0);
fs.writeFileSync(path.join(bridge, 'clock-skew.json'), JSON.stringify({ skewMs: skew }));
fs.writeFileSync(path.join(bridge, 'social-v2.json'), JSON.stringify({ conversations: {
  'private:1': { lastAiReplyAt: bj(24, 23, 30), lastActionAt: bj(24, 23, 35) },
  'group:9': { lastAiReplyAt: bj(24, 23, 40), lastActionAt: bj(24, 23, 41) }
} }));
const nameOf = (k) => (k === 'private:1' ? '老大私聊' : '群「鲸鱼窝」');

// ① 睡着：北京时间、睡前那句
fs.writeFileSync(path.join(bridge, 'sleep-state.json'), JSON.stringify({ sleeping: true, since: bj(24, 23, 42), until: bj(25, 7, 30), reason: '今晚不熬' }));
let r = fishStatus({ bridgeState: bridge, nameOf, now, pluginState: plugin });
assert.equal(r.line, '小鲸鱼在睡觉，打算睡到 10月25日 07:30');
assert.ok(r.detail.includes('10月24日 23:42 睡的') && r.detail.includes('今晚不熬'), r.detail);
assert.ok(r.detail.includes('最近一次说话：1 小时 20 分钟前，在「群「鲸鱼窝」」'), r.detail);
ok('睡着：睡到几点按北京时间，带睡前那句');

// ② 醒着在刷抖音；醒着没刷就说最近在哪
fs.writeFileSync(path.join(bridge, 'sleep-state.json'), JSON.stringify({ sleeping: false }));
fs.writeFileSync(path.join(plugin, 'video-impressions.jsonl'), JSON.stringify({ at: now - 2 * 60e3, title: '鲸鱼睡觉一半脑子醒着' }) + '\n');
r = fishStatus({ bridgeState: bridge, nameOf, now, pluginState: plugin });
assert.equal(r.line, '小鲸鱼醒着，正在刷抖音（2 分钟前在看《鲸鱼睡觉一半脑子醒着》）');
fs.writeFileSync(path.join(plugin, 'video-impressions.jsonl'), JSON.stringify({ at: now - 60 * 60e3, title: '旧的' }) + '\n');
r = fishStatus({ bridgeState: bridge, nameOf, now, pluginState: plugin });
assert.equal(r.line, '小鲸鱼醒着，1 小时 19 分钟前在「群「鲸鱼窝」」那边有动静');
ok('醒着：在刷抖音就说在看什么；没刷就说最近在哪有动静');

// ③ 睡到点了就算醒着
fs.writeFileSync(path.join(bridge, 'sleep-state.json'), JSON.stringify({ sleeping: true, since: bj(24, 20, 0), until: bj(24, 23, 0) }));
r = fishStatus({ bridgeState: bridge, nameOf, now, pluginState: plugin });
assert.ok(r.line.startsWith('小鲸鱼醒着'), r.line);
ok('过了打算睡到的点就不算在睡');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

// 保险（2026-10-25 主人）：妹妹消息发不出去 → 姐姐知道、告诉老大、报给妈妈；妈妈对事故直接动手修；姐姐自己说不出话也有程序替她报。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fishHealthIssues, fishStatus } from '../sister/fish-status.mjs';
import { createMomMailbox } from '../src/mom-mailbox.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
const now = Date.now();
const put = (events, heartbeatAt = now) => fs.writeFileSync(path.join(dir, 'fish-health.json'), JSON.stringify({ heartbeatAt, events }));
const nameOf = (k) => (k === 'private:1' ? '老大私聊' : k);

// ① 认得出出事，也认得出好了
{
  put([{ at: now - 120e3, kind: 'run', key: 'private:1', text: 'DeepSeek Messages request failed (400)' }, { at: now - 60e3, kind: 'run', key: 'private:1', text: 'DeepSeek Messages request failed (400)' }]);
  let is = fishHealthIssues({ bridgeState: dir, nameOf, now });
  assert.equal(is.length, 1);
  assert.equal(is[0].sig, 'run:private:1');
  assert.ok(is[0].text.includes('老大私聊') && is[0].text.includes('400'));
  assert.ok(fishStatus({ bridgeState: dir, nameOf, now, pluginState: dir }).line.includes('⚠'), '状态那行带上 ⚠');
  put([{ at: now - 120e3, kind: 'run', key: 'private:1' }, { at: now - 60e3, kind: 'run', key: 'private:1' }, { at: now - 10e3, kind: 'ok', key: 'private:1' }]);
  assert.equal(fishHealthIssues({ bridgeState: dir, nameOf, now }).length, 0, '后来又发出去了就不算');
  put([{ at: now - 60e3, kind: 'run', key: 'private:1' }]);
  assert.equal(fishHealthIssues({ bridgeState: dir, nameOf, now }).length, 0, '只错一次不算');
  ok('运行失败：连着两次、之后没发出去过才算；好了就不算');
}
// ② 令牌、发送、QQ 断线、桥接停了
{
  put([1, 2, 3].map((i) => ({ at: now - i * 30e3, kind: 'token', key: '' })));
  assert.equal(fishHealthIssues({ bridgeState: dir, now })[0].sig, 'token');
  put([{ at: now - 5 * 60e3, kind: 'qq-down' }]);
  assert.equal(fishHealthIssues({ bridgeState: dir, now })[0].sig, 'qq');
  put([{ at: now - 5 * 60e3, kind: 'qq-down' }, { at: now - 4 * 60e3, kind: 'qq-up' }]);
  assert.equal(fishHealthIssues({ bridgeState: dir, now }).length, 0);
  put([], now - 7 * 60e3);
  assert.equal(fishHealthIssues({ bridgeState: dir, now })[0].sig, 'bridge');
  // 妈妈在维护：桥接停了也不报；维护时间过了照报
  fs.writeFileSync(path.join(dir, 'maintenance.json'), JSON.stringify({ until: now + 60e3, reason: 'restart' }));
  assert.equal(fishHealthIssues({ bridgeState: dir, now }).length, 0, '维护中不报');
  assert.equal(fishHealthIssues({ bridgeState: dir, now: now + 120e3 }).length > 0, true, '维护过了照报');
  fs.rmSync(path.join(dir, 'maintenance.json'));
  ok('令牌一直被拒、QQ 断了没连上、桥接没心跳，都认得出');
}
// ③ 桥接从日志里记事件
{
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const body = src.match(/function noteFishHealth\(line\) \{[\s\S]*?\n\}/)[0];
  const got = [];
  const note = new Function('noteFishHealthEvent', `${body}\nreturn noteFishHealth;`)((kind, key, text) => got.push({ kind, key, text }));
  note('11:03:24 [bridge] ⚠️ agent 处理出错 (private:10051)：DeepSeek Messages request failed (400)');
  note('11:45:03 [bridge] [reserved2] 工具统一发送 private:10051: 成功 1/1 条');
  note('11:45:03 [bridge] QQ 发送失败 (group:1): timeout');
  note('11:09:27 [bridge] SnowLuma 连接断开（code=1006），重连中…');
  note('11:09:27 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001');
  assert.deepEqual(got.map((g) => `${g.kind}@${g.key}`), ['run@private:10051', 'ok@private:10051', 'send@group:1', 'qq-down@', 'qq-up@']);
  assert.match(src, /noteFishHealthEvent\('token'/, '令牌被拒也记');
  ok('桥接日志里的运行失败、发送成功/失败、QQ 断线重连都记进健康记录');
}
// ④ 事故信：看完要改就直接改，不等主人当面确认；回信不进她的上下文
{
  const runs = [];
  const notes = [];
  const box = createMomMailbox({
    stateDir: dir, root: dir, digestFile: path.join(dir, 'd.md'),
    sendOwner: async () => {}, addWakeNote: (k, t) => notes.push({ k, t }), formatTime: () => '10/25',
    runClaude: async ({ phase, prompt }) => {
      runs.push({ phase, prompt });
      return phase === 'plan'
        ? { ok: true, data: { replyToFish: '妈妈在修', needsChanges: true, planForOwner: '改 X', summary: '截断切坏了表情' } }
        : { ok: true, data: { ok: true, reportForOwner: '改好了', replyToFish: '修好了，要重启桥接', needsRestart: 'bridge' } };
    }
  });
  const r = box.writeIncident({ text: '小鲸鱼每次都运行失败 400', fromLabel: '姐姐' });
  const end = Date.now() + 3000;
  while (box._load().letters.find((l) => l.id === r.id)?.status !== 'done') { if (Date.now() > end) throw new Error(`没走完：${JSON.stringify(box._load().letters.find((l) => l.id === r.id))}`); await new Promise((res) => setTimeout(res, 10)); }
  assert.deepEqual(runs.map((x) => x.phase), ['plan', 'implement'], '看完直接改');
  assert.ok(runs[0].prompt.includes('事故报告') && runs[1].prompt.includes('事先授权'));
  assert.equal(notes.length, 0, '事故信的回信不进她的上下文');
  const l = box._load().letters.find((x) => x.id === r.id);
  assert.equal(l.needsRestart, 'bridge');
  assert.equal(l.reply, '修好了，要重启桥接', '姐姐拿这句跟老大说');
  ok('事故信：看完直接动手修，结果留给姐姐转告，不进小鲸鱼的上下文');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

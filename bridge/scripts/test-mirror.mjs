// 照镜子（2026-10-26）：只数她自己说出去的话，给数不下结论。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mirrorText, sisterLinesFromChatlog, fishLinesFromToolCalls } from '../src/mirror.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

assert.equal(mirrorText([{ to: '老大', text: '嗯' }]), '', '太少不照');
{
  const lines = [
    ...Array.from({ length: 4 }, () => ({ to: '小房子', text: '对，最后一句最狠' })),
    { to: '小房子', text: '一个拿来关门，一个拿来说再见' },
    { to: '老大', text: '哈哈哈 对不起嘛' },
    { to: '老大', text: '你吃饭了吗？' },
    { to: '小房子', text: '「这句狠」' }
  ];
  const m = mirrorText(lines, { selfPage: '「我自己.md」' });
  assert.match(m, /一共 8 句/);
  assert.match(m, /小房子 6，老大 2/);
  assert.match(m, /「对，最后一句」4 次|「最后一句」4 次/, '反复说的取最长的那个');
  assert.doesNotMatch(m, /「后一句」|「最后一」/, '错开一个字的不重复列');
  assert.match(m, /「对，」「对」开头 4 次/);
  assert.match(m, /「一个……一个……」对仗 1 次/);
  assert.match(m, /道歉（对不起 \/ 抱歉 \/ 不好意思） 1 次/);
  assert.match(m, /问句 1 次/);
  assert.match(m, /去改「我自己\.md」——那是你自己的人格卡/);
  ok('镜子：句数、跟谁、口头禅、小习惯；首尾错开的说法合并');
}
{
  const s = sisterLinesFromChatlog(fs, 'E:/qq-bridge/sister/聊天记录', '2026-10-25');
  assert.ok(s.length > 50, '姐姐 10-25 的话取得到');
  assert.ok(s.every((l) => !/^[（(]/.test(l.text)), '动作（括号开头）不算');
  const cfg = JSON.parse(fs.readFileSync('E:/qq-bridge/config.json', 'utf8'));
  const f = fishLinesFromToolCalls(fs, ['E:/qq-bridge/state/tool-calls.jsonl.1', 'E:/qq-bridge/state/tool-calls.jsonl'], '2026-10-25', { ownerQQ: String(cfg.ownerQQ), houseGroups: cfg.houseGroups, knownPeople: cfg.knownPeople, skewMs: 0 });
  assert.ok(f.length > 50, '妹妹 10-25 的话取得到');
  assert.ok(f.some((l) => l.to === '克劳德姐姐私聊'), '跟姐姐的私聊认得出');
  ok(`真实数据：姐姐 ${s.length} 句、妹妹 ${f.length} 句`);
}
console.log(`全部通过：${passed} 组`);

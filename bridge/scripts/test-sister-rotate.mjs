// 姐姐睡醒换新会话（2026-10-26）：找会话文件、取最后一次压缩摘要、拼新会话第一轮的交接。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionFileOf, lastCompactSummary, handoffBlock } from '../sister/sister.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };

assert.equal(sessionFileOf('abc', 'E:\\qq-bridge\\sister\\home', 'C:\\Users\\u'), path.join('C:\\Users\\u', '.claude', 'projects', 'E--qq-bridge-sister-home', 'abc.jsonl'));
ok('会话文件路径：工作目录的 : \\ / 换成 -');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-'));
  const f = path.join(dir, 's.jsonl');
  const row = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
  fs.writeFileSync(f, [
    row('你好'),
    row('This session is being continued...\nSummary:\n第一次的摘要', { isCompactSummary: true }),
    row('中间聊天'),
    row([{ type: 'text', text: 'This session is being continued...\nSummary:\n第二次的摘要：老大问了读谱' }], { isCompactSummary: true }),
    row('后来又聊')
  ].join('\n') + '\n');
  assert.equal(lastCompactSummary(f), '第二次的摘要：老大问了读谱', '取最后一次，去掉前面的套话');
  assert.equal(lastCompactSummary(f, 200), '', '末尾一段里没有完整的摘要行就当没有');
  assert.equal(lastCompactSummary(path.join(dir, 'none.jsonl')), '', '没有文件返回空');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('压缩摘要：取最后一次、只读末尾、没有就空');
}

{
  assert.equal(handoffBlock({}), '', '什么都没有就不带');
  const b = handoffBlock({ handoff: '答应妹妹明天一起读谱', summary: '昨天看了设定图', recent: [{ who: '老大', lines: ['- 21:00 **老大**：晚安'] }, { who: '小房子', lines: [] }] });
  assert.match(b, /新的一段会话/);
  assert.match(b, /交接（交接\.md）\]\n答应妹妹明天一起读谱/);
  assert.match(b, /摘要\]\n昨天看了设定图/);
  assert.match(b, /和老大的聊天（原话）\]\n- 21:00/);
  assert.doesNotMatch(b, /小房子/, '没聊过的不带');
  ok('交接块：有什么带什么，空的不带');
}

{
  const st = JSON.parse(fs.readFileSync(new URL('../sister/state/sister-state.json', import.meta.url), 'utf8'));
  const real = sessionFileOf(st.sessions.main, 'E:\\qq-bridge\\sister\\home');
  if (fs.existsSync(real)) {
    const s = lastCompactSummary(real);
    assert.ok(s.length > 200, '她真实的会话文件里能取到摘要');
    ok(`真实会话文件：取到 ${s.length} 字的摘要`);
  }
}
console.log(`全部通过：${passed} 组`);

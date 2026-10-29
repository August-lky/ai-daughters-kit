// 拍一拍叫醒 + 收尾没有观察门、刚有人说话时只附一句提醒（2026-10-29 M12 → 同日老大松绑：做提醒，不做限制）。真桥接代码跑在隔离的测试桩里，不碰活的 QQ / DSH / 配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const SELF = '999';
let failures = 0;
let tests = 0;

async function test(name, run, { observe = true } = {}) {
  tests++;
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: observe, preSleepWaitMs: 60000, preSleepWaitGroupMs: 60000 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/socialV2/${route}?key=${encodeURIComponent(KEY)}`,
      method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(JSON.stringify({ key: KEY, ...body }));
  });
  const clearWake = () => { if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; };
  const poke = async (sender, target) => {
    clearWake();
    await h.handlePokeNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: Number(SELF), group_id: 456, user_id: Number(sender), target_id: Number(target) });
    const woke = st.pendingWakeReason === 'poke';
    clearWake();
    return woke;
  };
  try { await run({ h, st, request, poke }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
  finally { clearWake(); await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('拍一拍：默认只有拍她才叫醒，别人互相拍不叫醒（但照样进消息流）', async ({ st, poke }) => {
  st.bootstrapSent = true;
  assert.equal(st.wakeConfig.triggers.poke, true);
  assert.equal(st.wakeConfig.triggers.pokeOthers, false, 'pokeOthers 默认关');
  const before = st.unread.length;
  assert.equal(await poke('777', '888'), false, '别人互相拍不叫醒');
  assert.equal(st.unread.length, before + 1, '别人互相拍也记进消息流');
  assert.equal(await poke('777', SELF), true, '拍她叫醒');
}, { observe: false });

await test('拍一拍：开了 pokeOthers 别人互相拍也叫醒；关了 poke 拍她不叫醒', async ({ st, poke }) => {
  st.bootstrapSent = true;
  st.wakeConfig.triggers.pokeOthers = true;
  assert.equal(await poke('777', '888'), true);
  st.wakeConfig.triggers.poke = false;
  assert.equal(await poke('777', SELF), false, 'poke 关了，拍她不叫醒');
  assert.equal(await poke('777', '888'), true, 'pokeOthers 和 poke 各管各的');
}, { observe: false });

await test('wake-config：pokeOthers 只收布尔，能存能回传', async ({ st, request }) => {
  const r = await request('wake-config', { config: { mode: 'diving', infinite: true, triggers: { pokeOthers: true } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(st.wakeConfig.triggers.pokeOthers, true);
  assert.equal(r.data.wakeConfig.triggers.pokeOthers, true);
  const r2 = await request('wake-config', { config: { triggers: { pokeOthers: 'yes' } } });
  assert.equal(r2.status, 200);
  assert.equal(st.wakeConfig.triggers.pokeOthers, false, '脏字符串不当成开');
}, { observe: false });

// 2026-10-29 老大：「这个东西应该是做提醒而不是做限制」。沉睡前观察门整个去掉：
// 设潜水 / mark_read 回潜水一律直接成功；刚还有人在说话、又不是只收窄，就在返回里附一句家常提醒（hint），没人说话就不附。
const say = (h, text = '正在聊') => h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, 'f-1', [], '789', []);
const remindsToWait = (hint) => typeof hint === 'string' && /qq_wait_for_messages/.test(hint) && /不看也行/.test(hint);

await test('没有观察门：照原样再睡一次、关一个开一个、调高概率、加关键词，都直接成功并落盘', async ({ h, st, request }) => {
  say(h);
  const same = await request('wake-config', { config: { mode: 'diving', infinite: true } });
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.ok(remindsToWait(same.data.hint), '刚有人说话：成功返回里带一句提醒');
  assert.match(same.data.hint, /^好，设好了。刚刚还有人在说话/);
  const mixed = await request('wake-config', { config: { triggers: { poke: false, pokeOthers: true } } });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
  assert.equal(st.wakeConfig.triggers.pokeOthers, true, '设置落盘了');
  const higher = await request('wake-config', { config: { triggers: { probability: 0.9 } } });
  assert.equal(higher.status, 200);
  assert.equal(st.wakeConfig.triggers.probability, 0.9);
  const newKw = await request('wake-config', { config: { triggers: { keywords: ['新词'] } } });
  assert.equal(newKw.status, 200);
  assert.deepEqual([...st.wakeConfig.triggers.keywords], ['新词']);
  for (const r of [same, mixed, higher, newKw]) assert.equal('error' in r.data, false, '不报错');
});

await test('没有观察门：从活跃切潜水、无限期改成有限时间，也直接成功', async ({ h, st, request }) => {
  say(h);
  st.wakeConfig.mode = 'active';
  st.wakeConfig.triggers.anyMessage = true;
  const toDive = await request('wake-config', { config: { mode: 'diving', triggers: { anyMessage: false } } });
  assert.equal(toDive.status, 200, JSON.stringify(toDive.data));
  assert.ok(remindsToWait(toDive.data.hint));
  st.wakeConfig.infinite = true;
  const finite = await request('wake-config', { config: { infinite: false, sleepMs: 600000 } });
  assert.equal(finite.status, 200, JSON.stringify(finite.data));
  assert.equal(st.wakeConfig.infinite, false);
});

await test('提醒：只收窄（关掉一个触发、调低概率、去掉关键词）不附提醒', async ({ h, st, request }) => {
  st.wakeConfig.triggers.probability = 0.2;
  st.wakeConfig.triggers.keywords = ['鲸鱼', '吃饭'];
  say(h);
  const r = await request('wake-config', { config: { triggers: { poke: false, probability: 0.05, keywords: ['鲸鱼'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(st.wakeConfig.triggers.poke, false);
  assert.equal(st.wakeConfig.triggers.probability, 0.05);
  assert.equal('hint' in r.data, false, '只让自己少被打扰的改动不提醒');
});

await test('提醒：没人在说话、对方说了晚安、或者已经等过一会儿，都不附', async ({ h, st, request }) => {
  const quiet = await request('wake-config', { config: { mode: 'diving', infinite: true } });
  assert.equal(quiet.status, 200);
  assert.equal('hint' in quiet.data, false, '没人说过话');
  say(h);
  st.lastIncomingAt = Date.now() - 10 * 60000; // 10 分钟前，超过 1 分钟的窗口
  const old = await request('wake-config', { config: { mode: 'diving', infinite: true } });
  assert.equal('hint' in old.data, false, '已经安静够久');
  say(h, '晚安啦');
  const bye = await request('wake-config', { config: { mode: 'diving', infinite: true } });
  assert.equal('hint' in bye.data, false, '对方说了结束语');
  say(h);
  st.preSleepWaitObservedAt = Date.now() + 1; // 她等过一会儿、看过带回来的消息，之后没新消息
  const seen = await request('mark-read', {});
  assert.equal(seen.status, 200);
  assert.equal('hint' in seen.data, false, '等过了就不再提醒');
});

await test('mark_read 回潜水：刚有人说话也直接成功，返回里带提醒', async ({ h, st, request }) => {
  say(h);
  assert.equal(st.wakeConfig.mode, 'diving');
  const r = await request('mark-read', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.ok(remindsToWait(r.data.hint));
  assert.match(r.data.hint, /^好，回去潜着了。/);
  assert.equal(st.unread.length, 0, '照常标成已读');
});

{
  const src = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  tests++;
  try {
    assert.match(src, /pokeOthers: z\.boolean\(\)\.optional\(\)\.describe\('群里别人互相拍一拍也唤醒你（默认关）'\)/, '工具参数里有 pokeOthers（不然会被参数校验丢掉）');
    assert.match(src, /可以再开 triggers\.pokeOthers（默认关）/);
    assert.ok(!/完成一次沉睡前观察|下次想睡需重新等待观察窗口|绝不代替沉睡前观察/.test(src), '工具说明里不再要求先观察');
    assert.ok((src.match(/做提醒，不做限制/g) || []).length >= 3, 'mark_read / set_wake_config / wait 三处都说了是提醒');
    assert.ok(!/还不能通过 qq_mark_read 直接回到潜水|还不能立刻设置潜水/.test(bridge), '桥接里不再有拦人的报错');
    assert.ok(!/【沉睡前强制等待】/.test(bridge.replace(/^\s*\/\/.*$/gm, '')), '唤醒提示里不再出现【沉睡前强制等待】');
    console.log('PASS 工具说明和唤醒提示：观察从限制改成提醒');
  } catch (error) { failures++; console.error('FAIL 工具说明', error.message); }
}

console.log(`\n拍一拍 / 唤醒设置：${tests - failures}/${tests} 通过`);
if (failures) process.exitCode = 1;

// 推送重试按路轮换（2026-10-29 M13）：git 调用和等待都是假的，不联网、不碰真仓库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routeFor, gitInvocation, resolveProxy, pushWithRetry, hideCreds } from './git-push-retry.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };
const PROXY = 'http://127.0.0.1:1';

{
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => routeFor(n, PROXY)), ['proxy', 'proxy', 'direct', 'proxy', 'proxy', 'direct']);
  assert.deepEqual([1, 2, 3].map((n) => routeFor(n, '')), ['direct', 'direct', 'direct'], '没代理就一直直连');
  ok('轮换顺序：走代理 → 走代理 → 直连；没代理只直连');
}

{
  const env = { PATH: 'x', HTTPS_PROXY: 'http://env-proxy', http_proxy: 'http://env2' };
  const p = gitInvocation('proxy', PROXY, ['push', 'origin', 'main'], env);
  assert.deepEqual(p.args, ['-c', `http.proxy=${PROXY}`, 'push', 'origin', 'main']);
  assert.equal(p.env.GIT_TERMINAL_PROMPT, '0');
  const d = gitInvocation('direct', PROXY, ['push', 'origin', 'main'], env);
  assert.deepEqual(d.args, ['-c', 'http.proxy=', 'push', 'origin', 'main'], '直连显式清掉 git 的代理设置');
  assert.equal(d.env.HTTPS_PROXY, undefined, '直连去掉环境变量里的代理');
  assert.equal(d.env.http_proxy, undefined);
  assert.equal(d.env.PATH, 'x');
  assert.equal(env.HTTPS_PROXY, 'http://env-proxy', '不改调用方的环境');
  ok('git 参数：走代理用 -c http.proxy=<代理>，直连清掉代理');
}

{
  assert.equal(resolveProxy({ root: 'R', env: { HTTPS_PROXY: 'http://a' }, gitProxy: () => 'http://b', readField: () => 'http://c' }), 'http://a');
  assert.equal(resolveProxy({ root: 'R', env: {}, gitProxy: () => 'http://b', readField: () => 'http://c' }), 'http://b');
  const asked = [];
  assert.equal(resolveProxy({ root: 'R', env: {}, gitProxy: () => '', readField: (f) => { asked.push(f); return /sister/.test(f) ? 'http://s' : ''; } }), 'http://s');
  assert.equal(asked.length, 2, '先看 config.json，再看 sister/config.json');
  assert.equal(resolveProxy({ root: 'R', env: {}, gitProxy: () => '', readField: () => '' }), '');
  ok('找代理：环境变量 → git 全局 → config.json → sister/config.json');
}

{
  // 前两次（都走代理）失败，第三次直连成功
  const calls = [];
  const logs = [];
  const sleeps = [];
  const r = await pushWithRetry({
    cwd: 'C:/nowhere', proxy: PROXY, attempts: 3, log: (m) => logs.push(m),
    env: { HTTPS_PROXY: 'http://env-proxy' },
    run: (args, { env }) => {
      calls.push({ args, proxyEnv: env.HTTPS_PROXY });
      if (calls.length < 3) { const e = new Error('git failed'); e.stderr = `fatal: unable to access 'https://user:pw@github.com/x.git/': Connection was reset\n`; throw e; }
    },
    sleep: async (ms) => { sleeps.push(ms); },
    delayMs: (a) => a * 10
  });
  assert.deepEqual(r, { ok: true, attempt: 3, route: 'direct' });
  assert.deepEqual(calls.map((c) => c.args[1]), [`http.proxy=${PROXY}`, `http.proxy=${PROXY}`, 'http.proxy=']);
  assert.equal(calls[2].proxyEnv, undefined, '直连那次环境里没有代理');
  assert.deepEqual(sleeps, [10, 20], '每次失败后等一会儿，越等越久');
  assert.match(logs[0], /第 1 次没成（走代理 http:\/\/127\.0\.0\.1:1）：.*Connection was reset/);
  assert.match(logs[1], /第 2 次没成（走代理/);
  assert.match(logs[2], /第 3 次成功（直连）/);
  assert.ok(logs.every((l) => !l.includes('user:pw')), '日志里不留网址凭据');
  ok('前两次走代理失败、第三次直连成功，日志写清每次的路和 git 原话');
}

{
  // 全部失败：抛错，次数到上限就停
  let n = 0;
  const logs = [];
  await assert.rejects(pushWithRetry({
    cwd: 'C:/nowhere', proxy: PROXY, attempts: 3, log: (m) => logs.push(m),
    run: () => { n++; const e = new Error('x'); e.stderr = 'Failed to connect to github.com:443 after 21048 ms'; throw e; },
    sleep: async () => {}
  }), /连续 3 次没成/);
  assert.equal(n, 3);
  assert.equal(logs.length, 3);
  assert.match(logs[2], /直连）：Failed to connect/);
  ok('连续失败到上限就停，报错');
}

{
  // 没代理：只直连；第一次就成功不等待
  const calls = [];
  let slept = false;
  const r = await pushWithRetry({ cwd: 'C:/nowhere', proxy: '', run: (args) => { calls.push(args); }, sleep: async () => { slept = true; } });
  assert.deepEqual(r, { ok: true, attempt: 1, route: 'direct' });
  assert.equal(calls[0][1], 'http.proxy=');
  assert.equal(slept, false);
  ok('没代理时直连，一次成功不等待');
}

{
  assert.equal(hideCreds('https://tok@github.com/a http://u:p@127.0.0.1:1'), 'https://***@github.com/a http://***@127.0.0.1:1');
  // 两个脚本都接上了
  for (const f of ['backup-her.mjs', 'publish-kit.mjs']) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ pushWithRetry, resolveProxy \} from '\.\/git-push-retry\.mjs'/, f);
    assert.match(src, /await pushWithRetry\(\{ cwd: OUT, proxy, attempts: 3, log \}\)/, f);
    assert.doesNotMatch(src, /execFileSync\('git', \['push'|git\('push'/, `${f} 不再直接推送`);
  }
  ok('backup-her / publish-kit 都改用轮换推送');
}

console.log(`全部通过：${passed} 组`);

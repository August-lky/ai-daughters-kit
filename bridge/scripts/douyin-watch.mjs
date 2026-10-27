#!/usr/bin/env node
// 抖音自主观看（自动刷）开关，走插件设置页同样的接口。给 scripts/restart-dsh.sh 用：
//   node scripts/douyin-watch.mjs running   → 打印 yes / no（DSH 没起来也算 no）
//   node scripts/douyin-watch.mjs start     → 开一轮，等到它真跑起来再退出
const BASE = 'http://127.0.0.1:3080/api/douyin-browser';
const state = async () => (await fetch(`${BASE}/state`, { signal: AbortSignal.timeout(10000) })).json();

const cmd = process.argv[2];
if (cmd === 'running') {
  try { console.log((await state()).watch?.running ? 'yes' : 'no'); } catch { console.log('no'); }
} else if (cmd === 'start') {
  const s0 = await state();
  const post = (p) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-douyin-settings-token': s0.token }, body: '{}', signal: AbortSignal.timeout(60000) });
  let r = await post('/watch/start');
  // 重启 DSH 时那一轮的刷视频进程跟着退出了，锁文件还在，新开一轮会被 409 挡回（2026-10-26 实测）。
  // /watch/stop 会清掉「退出进程的残留锁」并保留这一轮的预算，清完再开。
  if (r.status === 409) {
    await post('/watch/stop');
    await new Promise((res) => { setTimeout(res, 3000); });
    r = await post('/watch/start');
  }
  let running = false;
  for (let i = 0; i < 12 && !running; i++) {
    await new Promise((res) => { setTimeout(res, 5000); });
    running = Boolean((await state()).watch?.running);
  }
  console.log(`自动刷抖音${running ? '接上了' : `没接上（/watch/start ${r.status}）`}`);
  if (!running) process.exitCode = 1;
} else {
  console.log('用法：node scripts/douyin-watch.mjs running|start');
  process.exitCode = 2;
}

// 等小鲸鱼闲下来再重启（2026-10-25：重启时打断过她一轮）。看桥接日志尾巴：连续 quietSec 秒没有唤醒 / 发送 / 排队 / 回复检查，就算闲。
// node scripts/wait-fish-idle.mjs [quietSec=75] [maxWaitSec=900]   闲了退出码 0，等超时退出码 1。
import fs from 'node:fs';

const LOG = new URL('../bridge-run.log', import.meta.url);
const quietSec = Number(process.argv[2]) || 75;
const maxWaitSec = Number(process.argv[3]) || 900;
const BUSY = /唤醒 |工具统一发送|会话繁忙|回复检查唤醒|已补投|DSH 事件流/;
const started = Date.now();
let lastBusyAt = Date.now();
let offset = fs.statSync(LOG).size;
// 先看最近一段：刚有动静就从那时算起
const tail = fs.readFileSync(LOG, 'utf8').slice(-6000).split('\n').filter((l) => BUSY.test(l) && !/忽略未授权/.test(l));
if (!tail.length) lastBusyAt = Date.now() - quietSec * 1000;
while (Date.now() - started < maxWaitSec * 1000) {
  const size = fs.statSync(LOG).size;
  if (size > offset) {
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    if (buf.toString('utf8').split('\n').some((l) => BUSY.test(l) && !/忽略未授权/.test(l))) lastBusyAt = Date.now();
  }
  if (Date.now() - lastBusyAt >= quietSec * 1000) { console.log(`她闲下来了（${Math.round((Date.now() - started) / 1000)} 秒）`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`等了 ${maxWaitSec} 秒她还在忙`);
process.exit(1);

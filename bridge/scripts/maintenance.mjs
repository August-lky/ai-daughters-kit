// 「维护中」标记（2026-10-25 主人：重启时别让姐姐误报妹妹停了）。
//   node scripts/maintenance.mjs on [分钟，默认 20] [原因]   重启前打上
//   node scripts/maintenance.mjs off                        重启完撤掉（再留 2 分钟等心跳恢复）
//   node scripts/maintenance.mjs                            看现在的状态
// 姐姐的保险（sister/fish-status.mjs fishHealthIssues）看到 until 没过就不报。忘了 off 也没事：到点自己失效。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const F = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'maintenance.json');
const [cmd, a, ...rest] = process.argv.slice(2);
if (cmd === 'on') {
  const min = Math.min(120, Math.max(1, Number(a) || 20));
  fs.writeFileSync(F, JSON.stringify({ until: Date.now() + min * 60e3, reason: rest.join(' ') || 'restart', since: Date.now() }, null, 2));
  console.log(`维护中，${min} 分钟内姐姐不报妹妹的异常`);
} else if (cmd === 'off') {
  const j = (() => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return {}; } })();
  fs.writeFileSync(F, JSON.stringify({ ...j, until: Date.now() + 2 * 60e3, endedAt: Date.now() }, null, 2));
  console.log('维护结束（再留 2 分钟余量）');
} else {
  try {
    const j = JSON.parse(fs.readFileSync(F, 'utf8'));
    const left = Math.round((j.until - Date.now()) / 60e3);
    console.log(left > 0 ? `维护中，还剩约 ${left} 分钟（${j.reason || ''}）` : '没在维护');
  } catch { console.log('没在维护'); }
}

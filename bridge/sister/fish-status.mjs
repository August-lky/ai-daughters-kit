// 妹妹现在在干嘛（2026-10-24 主人：想知道妹妹睡没睡，不用来问妈妈、也不用把妹妹吵醒，问姐姐就行）。
// 只读文件，不碰妹妹：睡没睡（state/sleep-state.json）、最近在哪说过话（state/social-v2.json 各会话的时间）、
// 在不在刷抖音（插件 video-impressions.jsonl 最后一条）。只给「在哪、什么时候」，不给聊天内容。
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_STATE = path.join(process.env.USERPROFILE || 'C:/Users/admin', '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'state');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** 本机毫秒 → 北京时间「10月25日 10:29」。 */
function bjText(ms, skew) {
  const d = new Date(ms - skew + 8 * 3600e3);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function ago(ms, now) {
  const m = Math.round((now - ms) / 60e3);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}前` : `${Math.floor(h / 24)} 天前`;
}

/**
 * 妹妹那边现在有没有出事（2026-10-25 主人：她消息发不出去就告诉姐姐，姐姐告诉老大、报给妈妈）。
 * 读桥接写的 state/fish-health.json（见 bridge.js noteFishHealth）。返回 [{ sig, text }]，没事就是空数组。
 * 只算「还没好」的：出事之后这个会话又成功发出去过，就不算了。
 */
export function fishHealthIssues({ bridgeState, nameOf = (k) => k, now = Date.now() } = {}) {
  // 妈妈在重启 / 维护（state/maintenance.json 的 until 还没过）：停一会儿是正常的，不报
  const m = readJson(path.join(bridgeState, 'maintenance.json'));
  if (Number(m?.until) > now) return [];
  const h = readJson(path.join(bridgeState, 'fish-health.json'));
  if (!h || !Array.isArray(h.events)) return [];
  const issues = [];
  if (Number(h.heartbeatAt) && now - Number(h.heartbeatAt) > 5 * 60e3) {
    issues.push({ sig: 'bridge', text: `她的桥接 ${Math.round((now - Number(h.heartbeatAt)) / 60e3)} 分钟没动静了，可能停了` });
    return issues;
  }
  const ev = h.events.filter((e) => now - Number(e.at) < 30 * 60e3);
  const lastOk = (key) => Math.max(0, ...ev.filter((e) => e.kind === 'ok' && (!key || e.key === key)).map((e) => Number(e.at)));
  const runKeys = [...new Set(ev.filter((e) => e.kind === 'run').map((e) => e.key))];
  for (const key of runKeys) {
    const errs = ev.filter((e) => e.kind === 'run' && e.key === key && now - Number(e.at) < 15 * 60e3 && Number(e.at) > lastOk(key));
    if (errs.length >= 2) issues.push({ sig: `run:${key}`, text: `她在「${nameOf(key)}」那边每次都运行失败（${errs.length} 次，最近一次：${errs[errs.length - 1].text || '没写原因'}）` });
  }
  const recent = (kind, min) => ev.filter((e) => e.kind === kind && now - Number(e.at) < min * 60e3 && Number(e.at) > lastOk(e.key || ''));
  const tok = ev.filter((e) => e.kind === 'token' && now - Number(e.at) < 10 * 60e3 && Number(e.at) > lastOk(''));
  if (tok.length >= 3) issues.push({ sig: 'token', text: `她的会话令牌一直被拒（10 分钟 ${tok.length} 次），工具都用不了` });
  const sends = recent('send', 10);
  if (sends.length >= 2) issues.push({ sig: 'send', text: `她的 QQ 消息发不出去（10 分钟 ${sends.length} 次）` });
  const down = Math.max(0, ...ev.filter((e) => e.kind === 'qq-down').map((e) => Number(e.at)));
  const up = Math.max(0, ...ev.filter((e) => e.kind === 'qq-up').map((e) => Number(e.at)));
  if (down > up && now - down > 3 * 60e3) issues.push({ sig: 'qq', text: `她的 QQ 连接断了 ${Math.round((now - down) / 60e3)} 分钟还没连上` });
  return issues;
}

/**
 * 妹妹的状态。bridgeState：桥接的 state 目录；nameOf(key)：会话 key → 叫法（老大、群名…）。
 * 返回 { line: 一句话, detail: 几行 }。
 */
export function fishStatus({ bridgeState, nameOf = (k) => k, now = Date.now(), pluginState = PLUGIN_STATE } = {}) {
  const skew = Number(readJson(path.join(bridgeState, 'clock-skew.json'))?.skewMs) || 0;
  const sleep = readJson(path.join(bridgeState, 'sleep-state.json'));
  const asleep = !!sleep?.sleeping && (!sleep.until || sleep.until > now);
  const social = readJson(path.join(bridgeState, 'social-v2.json'));
  const acts = Object.entries(social?.conversations || {})
    .map(([k, c]) => ({ key: k, said: Number(c?.lastAiReplyAt) || 0, acted: Number(c?.lastActionAt) || 0 }))
    .filter((x) => x.said || x.acted)
    .sort((a, b) => Math.max(b.said, b.acted) - Math.max(a.said, a.acted));
  const lastSaid = [...acts].sort((a, b) => b.said - a.said)[0];
  let watch = null;
  try {
    const lines = fs.readFileSync(path.join(pluginState, 'video-impressions.jsonl'), 'utf8').trim().split('\n').slice(-3);
    const j = JSON.parse(lines[lines.length - 1]);
    if (Number(j.at) && now - Number(j.at) < 10 * 60e3) watch = j;
  } catch { /* 没在刷 */ }

  const detail = [];
  let line;
  if (asleep) {
    line = `小鲸鱼在睡觉${sleep.natural ? '，打算睡到自然醒' : (sleep.until ? `，打算睡到 ${bjText(sleep.until, skew)}` : '')}`; // 2026-10-29：自然醒的 until 只是 14 小时的上限，不当成她定的钟点
    detail.push(`在睡觉：${sleep.since ? `${bjText(sleep.since, skew)} 睡的` : ''}${sleep.natural ? '，打算睡到自然醒' : (sleep.until ? `，打算睡到 ${bjText(sleep.until, skew)}` : '')}${sleep.reason ? `（她睡前说：${String(sleep.reason).slice(0, 60)}）` : ''}`);
    detail.push('睡着的时候别人找她不会叫醒她，消息会攒着，她醒了会看到。');
  } else if (watch) {
    line = `小鲸鱼醒着，正在刷抖音（${ago(Number(watch.at), now)}在看《${String(watch.title || '').replace(/\s+/g, ' ').slice(0, 30)}》）`;
    detail.push(line.replace(/^小鲸鱼/, ''));
  } else {
    const last = acts[0];
    line = last ? `小鲸鱼醒着，${ago(Math.max(last.said, last.acted), now)}在「${nameOf(last.key)}」那边有动静` : '小鲸鱼醒着';
    detail.push(line.replace(/^小鲸鱼/, ''));
  }
  const issues = fishHealthIssues({ bridgeState, nameOf, now });
  if (issues.length) {
    line += `；⚠ 她那边出问题了：${issues.map((i) => i.text).join('；')}`;
    detail.push(`⚠ 出问题了：\n${issues.map((i) => `- ${i.text}`).join('\n')}`);
  }
  if (lastSaid?.said) detail.push(`最近一次说话：${ago(lastSaid.said, now)}，在「${nameOf(lastSaid.key)}」`);
  const others = acts.slice(0, 4).map((x) => `「${nameOf(x.key)}」${ago(Math.max(x.said, x.acted), now)}`);
  if (others.length) detail.push(`最近有动静的地方：${others.join('、')}`);
  return { line, detail: detail.join('\n') };
}

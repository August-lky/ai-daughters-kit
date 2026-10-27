// ⚠ 本机补丁（2026-10-22，主人要求，非上游代码）：私信优先。
//
// 主人：「她现在抖音回复我引用的视频的回复速度特别慢」。实测：刷视频时 douyin_chat_read 中位 59 秒
// （不刷时 0.4 秒），因为私信和刷视频共用同一个标签页、同一把 tab 锁，私信每个动作都要排在刷视频后面。
// 现在：主人发来私信、或者她在用 douyin_chat_* 工具时，把"私信优先"往后延 3 分钟；
// 刷视频每一拍开始前看一眼，没过期就原地等（不占浏览器），过期了再接着刷。
import fs from 'node:fs';
import path from 'node:path';

export const CHAT_PRIORITY_MS = 3 * 60_000;
const fileOf = (stateDir) => path.join(stateDir, 'chat-priority.json');

export function bumpChatPriority(stateDir, ms = CHAT_PRIORITY_MS, now = Date.now()) {
  try {
    const until = Math.max(chatPriorityUntil(stateDir), now + ms);
    fs.writeFileSync(fileOf(stateDir), JSON.stringify({ until, updatedAt: new Date(now).toISOString() }));
  } catch { /* 写不下来最多是这次不让路 */ }
}

export function chatPriorityUntil(stateDir) {
  try { return Number(JSON.parse(fs.readFileSync(fileOf(stateDir), 'utf8')).until) || 0; } catch { return 0; }
}

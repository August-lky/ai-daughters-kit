// 生活不停（2026-10-24 主人：睡着以后生活也在继续）。
//
// 以前她睡着时，群消息和别人的私聊直接丢掉，醒来像时间停住了。
// 现在照样不叫醒她、不进那边的上下文，只在这里记一笔；醒来时（跟老大私聊那边）给她看一眼：
// 谁找过她、群里聊了什么、有没有人 @ 她。回不回、回谁，她自己定。
//
// 存在 state/asleep-log.json，桥接重启也不丢；说过一次就标记，下次睡着时清掉。

import fs from 'node:fs';

const clip = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...s].length > max ? `${[...s].slice(0, max).join('')}…` : s;
};

export function createAsleepLog(file, { max = 400 } = {}) {
  let state = { entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw?.entries)) state = { entries: raw.entries };
  } catch { /* 没有就是空的 */ }
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* 写不了就算了，只是少记一笔 */ }
  };
  return {
    /** kind: 'group' | 'private' | 'poke'；atMe：@ 了她或回复了她 */
    record({ at = Date.now(), key, kind, who = '', text = '', atMe = false }) {
      if (!key) return;
      state.entries.push({ at, key, kind, who: clip(who, 20), text: clip(text, 80), atMe: atMe === true, told: false });
      if (state.entries.length > max) state.entries = state.entries.slice(-max);
      save();
    },
    /** 还没跟她说过的条数 */
    pending() {
      return state.entries.filter((e) => !e.told).length;
    },
    /**
     * 拼给她看的一段。titleOf(key) 给群名；clock(ms) 给北京时间。
     * markTold=true 时把这些标成说过了，下次唤醒不再重复。
     */
    digest({ titleOf = () => '', clock = (ms) => new Date(ms).toISOString(), markTold = true } = {}) {
      const fresh = state.entries.filter((e) => !e.told);
      if (!fresh.length) return '';
      const groups = new Map();
      const privates = new Map();
      const pokes = new Map();
      for (const e of fresh) {
        const bucket = e.kind === 'group' ? groups : e.kind === 'private' ? privates : pokes;
        if (!bucket.has(e.key)) bucket.set(e.key, []);
        bucket.get(e.key).push(e);
      }
      const lines = [];
      for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
        const people = new Set(list.map((e) => e.who).filter(Boolean));
        const toMe = list.filter((e) => e.atMe);
        const name = titleOf(key) || key;
        let line = `- 群「${name}」：${list.length} 条，${people.size} 个人在聊（${clock(list[0].at)}～${clock(list.at(-1).at)}）`;
        if (toMe.length) line += `；有 ${toMe.length} 条是冲你来的：${toMe.slice(-3).map((e) => `${e.who}「${e.text}」`).join('，')}`;
        const tail = list.filter((e) => !e.atMe).slice(-3);
        if (tail.length) line += `；最后聊到：${tail.map((e) => `${e.who}「${e.text}」`).join('，')}`;
        lines.push(line);
      }
      if (groups.size > 6) lines.push(`- 另外还有 ${groups.size - 6} 个群也有人说话`);
      for (const [, list] of [...privates].slice(0, 8)) {
        const who = list.at(-1).who || '有人';
        const say = list.length === 1 ? `「${list[0].text}」` : `「${list[0].text}」……最后一条「${list.at(-1).text}」`;
        lines.push(`- ${who} 私聊你 ${list.length} 条（${clock(list[0].at)} 起）：${say}`);
      }
      for (const [key, list] of pokes) {
        const who = list.at(-1).who || '有人';
        const where = key.startsWith('group:') ? `在群「${titleOf(key) || key}」` : '私聊里';
        lines.push(`- ${who} ${where}拍了拍你${list.length > 1 ? ` ${list.length} 次` : ''}`);
      }
      if (markTold) {
        for (const e of fresh) e.told = true;
        save();
      }
      return `【你睡着的时候】你睡着这段时间，外面没停：\n${lines.join('\n')}\n这些都过去一阵了，那边的你还没看到。回不回、回谁、怎么回，你自己定；想去哪边接话就用 qq_go_to 把要说的带过去。\n\n`;
    },
    /** 她又睡下时清掉已经说过的，没说过的留着 */
    dropTold() {
      const before = state.entries.length;
      state.entries = state.entries.filter((e) => !e.told);
      if (state.entries.length !== before) save();
    }
  };
}

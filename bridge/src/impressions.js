// 印象（2026-10-24 主人：小鲸鱼和克劳德姐姐都要有对群里某个人的「印象」，不同于好感度）。
//
// 跟着 QQ 号走，换个群也认得出是同一个人。分七档：
//   -3 懒得理（他以后在群里 @ / 骚扰她都不叫醒她，直接无视） -2 讨厌 -1 不太喜欢 0 一般 1 还行 2 喜欢 3 很喜欢
// 加减分、写一句为什么，都是她自己决定（工具 / 指令），这里只管记和读。
// 会慢慢恢复（主人：道歉了、过一阵印象也会随状态回来）：
//   - 坏印象每过 7 天没再记新的一笔，就往回升一档，最多回到「一般」（好印象不会自己掉）；
//   - 被无视的人要是在道歉（apologizing），照样叫醒她，原不原谅、升几档她定。
// 老大、她俩互相这几个号永远不会被无视（exempt），印象照记。
// 小鲸鱼（桥接 state/impressions.json）和姐姐（sister/state/impressions.json）各记各的。
import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = { '-3': '懒得理', '-2': '讨厌', '-1': '不太喜欢', '0': '一般', '1': '还行', '2': '喜欢', '3': '很喜欢' };
const clamp = (n) => Math.max(-3, Math.min(3, Math.round(Number(n) || 0)));
const WEEK = 7 * 86400e3;

/** 像是在道歉。 */
export function apologizing(text) {
  return /对不起|抱歉|我错了|错了错了|不好意思|道歉|sorry|别生气|原谅|是我不对|刚才过分/i.test(String(text || ''));
}

/** 现在算几档：坏印象按时间往回升（每 7 天一档，最多到 0）。 */
export function effectiveScore(im, now = Date.now()) {
  if (!im) return 0;
  const base = clamp(im.score);
  if (base >= 0) return base;
  const weeks = Math.floor((now - (Number(im.updatedAt) || now)) / WEEK);
  return Math.min(0, base + Math.max(0, weeks));
}

export function createImpressions(file, { exempt = [] } = {}) {
  const keep = new Set(exempt.map(String));
  let data = {};
  let mtime = -1;
  // 另一个进程（姐姐的工具服务）也会写这个文件：每次读之前看一眼改没改
  const load = () => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m === mtime) return;
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      mtime = m;
    } catch { if (mtime === -1) data = {}; }
  };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  };

  /** 记一笔：delta（加减几档，从现在的档位算）或 score（直接定档）；note 写一句为什么（留最近 5 句）。 */
  function update(id, { delta = null, score = null, note = '', name = '', now = Date.now() } = {}) {
    load();
    const key = String(id || '').trim();
    if (!/^\d{5,12}$/.test(key)) throw new Error('要给 QQ 号');
    const cur = data[key] || { score: 0, notes: [] };
    const nowScore = effectiveScore(cur, now);
    if (score !== null && score !== undefined && score !== '') cur.score = clamp(score);
    else if (delta !== null && delta !== undefined && delta !== '') cur.score = clamp(nowScore + Number(delta));
    else cur.score = nowScore;
    if (name) cur.name = String(name).slice(0, 30);
    if (note) cur.notes = [...(cur.notes || []), { at: now, text: String(note).slice(0, 80) }].slice(-5);
    cur.updatedAt = now;
    data[key] = cur;
    save();
    return { id: key, ...cur, level: LEVELS[String(cur.score)] };
  }

  const get = (id) => { load(); return data[String(id)] || null; };
  const scoreOf = (id, now = Date.now()) => effectiveScore(get(id), now);
  /** 这个人现在被她无视吗（-3、不在豁免名单）。道歉的话不算（由调用方用 apologizing 判断后放行）。 */
  const ignored = (id, now = Date.now()) => !keep.has(String(id)) && scoreOf(id, now) <= -3;

  /** 在场的这些人里有印象的，一人一行；没有就空串。 */
  function block(ids, { title = '【你对这些人的印象】', nameOf = null, now = Date.now() } = {}) {
    load();
    const rows = [];
    for (const id of [...new Set((ids || []).map(String))]) {
      const im = data[id];
      if (!im) continue;
      const sc = effectiveScore(im, now);
      if (sc === 0 && !(im.notes || []).length) continue;
      const last = (im.notes || []).slice(-2).map((n) => n.text).join('；');
      const eased = sc !== clamp(im.score) ? '（过了一阵，没那么气了）' : '';
      rows.push(`- ${(nameOf && nameOf(id)) || im.name || id}（${id}）：${LEVELS[String(sc)]}${eased}${last ? `，记着：${last}` : ''}${ignored(id, now) ? '（你已经懒得理他了：他在群里叫你不会叫醒你，除非他像是在道歉）' : ''}`);
    }
    return rows.length ? `${title}\n${rows.join('\n')}\n` : '';
  }

  return { update, get, scoreOf, ignored, block, all: () => { load(); return data; } };
}

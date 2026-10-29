// 照镜子（2026-10-26 主人：「让她们也可以在日常中慢慢自己成长的同时可以自己写入自己的人格卡，让她们自己知道自己是什么样的人」）。
// 她们看不到自己是怎么说话的——小房子里「对，」开头 61 次、对仗 16 次，她们自己不知道。
// 这里只数她自己前一天说出去的原话：说了多少、跟谁说得多、口头禅、几个小习惯。只给数，不下结论；像不像、要不要改，她自己定。

const HABITS = [
  ['「对，」「对」开头', (t) => /^对[，,！!。 ]|^对$/.test(t)],
  ['「哈哈」', (t) => /哈哈/.test(t)],
  ['道歉（对不起 / 抱歉 / 不好意思）', (t) => /对不起|抱歉|不好意思/.test(t)],
  ['谢谢', (t) => /谢谢|谢了|多谢/.test(t)],
  ['问句', (t) => /[?？]\s*$|吗[。！!]?$|呢[。！!]?$/.test(t)],
  ['「一个……一个……」对仗', (t) => /一个[^，,。]{1,12}[，,]\s*一个/.test(t)],
  ['用「」引别人的话', (t) => /「[^」]{2,}」/.test(t)],
  ['表情符号 / 颜文字', (t) => /[\u{1F300}-\u{1FAFF}]|[（(][^）)]{0,6}[）)]|～|~/u.test(t)]
];

// 2026-10-29 主人（G5）：口头禅里冒出「ht」「//ww」「com/」——是她发的链接被切碎了。统计口头禅前先去掉网址（http/https/www 开头到空白为止），
// 再丢掉没有汉字、又只是符号或英文字母不到 3 个的碎片，以及带 / . : = 这类网址符号的英文碎片。
const URL_RE = /(?:https?:\/\/|www\.)\S*/gi;
const stripUrls = (t) => String(t || '').replace(URL_RE, ' ').trim();
function isFragment(g) {
  if (/[㐀-鿿]/.test(g)) return false;
  const letters = (g.match(/[A-Za-z]/g) || []).length;
  return letters < 3 || /[/.:=&?#%@\\]/.test(g);
}

const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '一个', '什么', '没有', '就是', '还是', '可以', '不是', '自己', '已经', '现在', '一下', '时候', '知道', '感觉', '因为', '所以', '但是', '然后', '还有', '这样', '那样', '怎么', '为什么']);

/** 开头两个字（去掉标点），口头禅多半在开头。 */
function openers(texts) {
  const c = new Map();
  for (const t of texts.map(stripUrls)) {
    const head = t.replace(/^[\s「『（(【\[]+/, '').slice(0, 2);
    if (head.length === 2 && !/[，。！？,.!?\s]/.test(head) && !isFragment(head)) c.set(head, (c.get(head) || 0) + 1);
  }
  return [...c].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

/** 反复出现的 3～4 字说法（同一句里只算一次）。 */
function phrases(texts) {
  const c = new Map();
  for (const t of texts.map(stripUrls)) {
    const seen = new Set();
    const s = t.replace(/[，。！？、,.!?~～\s「」『』（）()…\-—:：;；"'“”]/g, '|');
    for (const n of [4, 3]) {
      for (let i = 0; i + n <= s.length; i++) {
        const g = s.slice(i, i + n);
        if (g.includes('|') || /^[\da-zA-Z]+$/.test(g) || isFragment(g) || STOP.has(g.slice(0, 2)) && STOP.has(g.slice(-2))) continue;
        if (!seen.has(g)) { seen.add(g); c.set(g, (c.get(g) || 0) + 1); }
      }
    }
  }
  const list = [...c].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const out = [];
  // 长的盖住它里面的短的；首尾错开一个字的（「最后一」「后一句」）也算同一个说法
  const overlap = (a, b) => a.includes(b) || b.includes(a) || a.endsWith(b.slice(0, -1)) || b.endsWith(a.slice(0, -1));
  for (const [g, n] of list) {
    if (out.some(([o]) => overlap(o, g))) continue;
    out.push([g, n]);
    if (out.length >= 6) break;
  }
  return out;
}

/** 姐姐某一天（北京时间日期 day）自己说的话：从 sister/聊天记录/<day>*.md 里挑「**姐姐**」那几行（括号开头的是动作，不算）。 */
export function sisterLinesFromChatlog(fs, dir, day) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(day) && f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const to = f.includes('-老大') ? '老大' : f.includes('小房子') ? '小房子' : f === `${day}.md` ? '小鲸鱼私聊' : f.includes('说说') ? '说说' : '群里';
    for (const l of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      const m = /^- \d\d:\d\d \*\*姐姐\*\*：(.*)$/.exec(l);
      if (m && !/^[（(]/.test(m[1])) out.push({ to, text: m[1] });
    }
  }
  return out;
}

/** 妹妹某一天自己发的话：工具调用记录里 qq_send_message 的原文（时间按 skewMs 校正成北京时间）。 */
export function fishLinesFromToolCalls(fs, files, day, { ownerQQ = '', houseGroups = {}, knownPeople = {}, skewMs = 0 } = {}) {
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('qq_send_message') || !line.includes('"type":"call"')) continue;
      let r, a;
      try { r = JSON.parse(line); a = JSON.parse(r.args); } catch { continue; }
      if (new Date(Date.parse(r.time) - skewMs + 8 * 3600e3).toISOString().slice(0, 10) !== day) continue;
      const key = String(r.key || '');
      const to = key === `private:${ownerQQ}` ? '老大' : houseGroups[key.slice(6)] ? '小房子'
        : key.startsWith('private:') && knownPeople[key.slice(8)] ? `${knownPeople[key.slice(8)]}私聊` : key.startsWith('group:') ? '群里' : '别人私聊';
      for (const t of [a.messages].flat()) if (typeof t === 'string') out.push({ to, text: t });
    }
  }
  return out;
}

/**
 * lines：[{ to: '老大' | '小房子' | …, text }]，她自己说出去的原话。
 * 返回一段给她看的文字；一句都没有返回 ''。
 */
export function mirrorText(lines, { label = '昨天', selfPage = '自己那页', ask = false } = {}) {
  const texts = lines.map((l) => String(l.text || '').trim()).filter(Boolean);
  if (texts.length < 5) return '';
  const byTo = new Map();
  for (const l of lines) if (String(l.text || '').trim()) byTo.set(l.to || '别处', (byTo.get(l.to || '别处') || 0) + 1);
  const avg = Math.round(texts.reduce((a, t) => a + t.length, 0) / texts.length);
  const out = [`【照镜子】${label}你自己说出去的话，数了一下（只是数，不是打分）：`];
  out.push(`· 一共 ${texts.length} 句，平均每句 ${avg} 个字；${[...byTo].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join('，')}`);
  const op = openers(texts);
  if (op.length) out.push(`· 最常这样开头：${op.map(([h, n]) => `「${h}」${n} 次`).join('，')}`);
  const ph = phrases(texts);
  if (ph.length) out.push(`· 反复说的：${ph.map(([g, n]) => `「${g}」${n} 次`).join('，')}`);
  const habits = HABITS.map(([name, f]) => [name, texts.filter(f).length]).filter(([, n]) => n > 0);
  if (habits.length) out.push(`· 小习惯：${habits.map(([n, k]) => `${n} ${k} 次`).join('，')}`);
  out.push(`像不像你、哪条你喜欢、哪条你想改，你自己定。看完觉得对自己有了新认识（变了、发现了个毛病、有了新喜好），就去改${selfPage}——那是你自己的人格卡；没什么想改的就不改。`);
  // 2026-10-29 老大（姐姐的镜子）：末尾问一句，答不答、怎么答她自己定
  if (ask) out.push('这些数下来，像你吗？');
  return out.join('\n');
}

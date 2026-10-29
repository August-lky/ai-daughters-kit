// 聊天记录（给索引看的原话）：每条收到、发出的消息按「北京日期 + 会话」写进一个 md 文件。
//
// 2026-10-29 老大：「给妹妹也做成一样吧」——姐姐一直有 sister/聊天记录/*.md（sister.mjs 的 chatLog），
// 妹妹的索引里却只有存成瞬间的那几段。现在小鲸鱼的桥接也这样写，放在 家/小鲸鱼/聊天记录/（跟脑子并列，不放进脑子里；
// 路径见 brains.js 的 chatLogs），brain/index.py 把它们编进她的索引。
//
// 格式跟姐姐的一样：
//   文件名  <日期>-<会话>.md，会话是 老大 / 姐姐 / 群<群名> / 私聊<昵称> / 抖音老大 / 抖音<昵称>
//   标题    # 小鲸鱼和老大（10月26日 周一）          （群：# 小鲸鱼在群「小房子」（…））
//   每行    - 07:11 **小鲸鱼**：早，姐姐。……            （一条消息一行，换行压成空格）
// 文件名里带「-群」的是群聊，其余都是私聊（brain/index.py 的 is_private_chatlog 靠这个认，想起来时标「私聊里的」）。
//
// 时间：本机时钟比真实时间快约 3 小时，传进来的 at 是本机毫秒，这里扣掉 skewMs() 再换北京时间。
// 写不下来就算了（返回 ok:false），不能因为记录影响她说话。

import fs from 'node:fs';
import path from 'node:path';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
/** 一条消息最多记多少字（长转发、整篇贴文只留开头，原文本来就在 QQ 里）。 */
export const MAX_LINE_CHARS = 800;

/** 本机毫秒（扣掉时钟偏差后）→ 北京时间的日期和钟点。 */
export function bjParts(hostMs, skewMs = 0) {
  const d = new Date(Number(hostMs) - (Number(skewMs) || 0) + 8 * 3600e3);
  const pad = (n) => String(n).padStart(2, '0');

  return {
    day: d.toISOString().slice(0, 10),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    wd: WEEKDAY[d.getUTCDay()],
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** 文件名里不能有的字符去掉，太长截断。 */
export function safeName(name, max = 40) {
  return String(name ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, max);
}

/**
 * 会话 → { suffix, title }。type：
 *   owner（老大私聊）| sister（姐姐私聊）| group（群，name 是群名）| friend（别的私聊，name 是昵称）
 *   douyin-owner | douyin-friend（抖音私信，name 是对方名字）
 */
export function sessionInfo({ type, name = '' } = {}, selfName = '小鲸鱼') {
  const n = safeName(name);

  switch (type) {
    case 'owner': return { suffix: '-老大', title: `${selfName}和老大` };
    case 'sister': return { suffix: '-姐姐', title: `${selfName}和姐姐` };
    case 'group': return { suffix: `-群${n || '未知'}`, title: `${selfName}在群「${n || '未知'}」` };
    case 'douyin-owner': return { suffix: '-抖音老大', title: `${selfName}和老大的抖音私信` };
    case 'douyin-friend': return { suffix: `-抖音${n || '朋友'}`, title: `${selfName}和${n || '朋友'}的抖音私信` };
    default: return { suffix: `-私聊${n || '朋友'}`, title: `${selfName}和${n || '朋友'}` };
  }
}

export const chatLogFileName = (day, info) => `${day}${info.suffix}.md`;
export const chatLogHeader = (info, parts) => `# ${info.title}（${parts.month}月${parts.date}日 周${parts.wd}）\n\n`;

/** 一条消息 → 一行（不含换行符）。空文字返回 ''。 */
export function chatLogLine(hm, who, text) {
  let t = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s*\n+\s*/g, ' ').trim();

  if (!t) return '';

  if (t.length > MAX_LINE_CHARS) t = `${t.slice(0, MAX_LINE_CHARS)}……`;

  const name = safeName(who, 30).replace(/\*/g, '') || '某人';

  return `- ${hm} **${name}**：${t}`;
}

/**
 * 一条消息在聊天记录里署谁的名字：她自己 → 小鲸鱼，老大 → 老大，姐姐 → 姐姐（认 knownPeople 里名字带「姐姐」的），
 * 认得的人用 knownPeople 里的名字，别人用群名片 / 昵称（去掉桥接加的「（不是你老大）」之类注释），都没有就用 QQ 号。
 * key / ownerQQ：老大的私聊里不是她说的就是老大说的。
 */
export function whoLabel({ isOwner = false, isSelf = false, userId = '', sender = '', knownPeople = {}, selfName = '小鲸鱼', key = '', ownerQQ = '' } = {}) {
  if (isSelf) return selfName;
  if (isOwner || (ownerQQ && key === `private:${ownerQQ}`)) return '老大';

  const uid = String(userId ?? '');
  const known = String(knownPeople?.[uid] ?? '').trim();

  if (known) return /姐姐/.test(known) ? '姐姐' : known;

  const name = String(sender ?? '').replace(/（(?:不是你老大|引用的是[^）]*)）\s*$/, '').trim();

  if (/姐姐/.test(name)) return '姐姐';
  if (name && !['私聊', '群', '对方', '系统', '我'].includes(name)) return name;

  return uid || '某人';
}

/** 一行 → { hm, who, text }，不是消息行返回 null。 */
export function parseChatLogLine(line) {
  const m = /^- (\d{2}:\d{2}) \*\*(.+?)\*\*：([\s\S]*)$/.exec(String(line ?? ''));

  return m ? { hm: m[1], who: m[2], text: m[3] } : null;
}

/**
 * 聊天记录目录。dir：家/小鲸鱼/聊天记录；skewMs：() => 本机比真实时间快多少毫秒。
 * append({ session:{type,name}, who, text, at }) → { ok, file?, error? }；at 是本机毫秒（不传就是现在）。
 */
export function createChatLog({ dir, selfName = '小鲸鱼', skewMs = () => 0, onError = () => {} } = {}) {
  if (!dir) throw new Error('createChatLog 需要 dir');

  const skew = () => { try { return Number(skewMs()) || 0; } catch { return 0; } };

  return {
    dir,
    selfName,
    fileFor(session, hostMs = Date.now()) {
      const parts = bjParts(hostMs, skew());
      const info = sessionInfo(session, selfName);

      return { file: path.join(dir, chatLogFileName(parts.day, info)), parts, info };
    },
    append({ session, who, text, at } = {}) {
      try {
        const { file, parts, info } = this.fileFor(session, Number.isFinite(+at) && at ? +at : Date.now());
        const line = chatLogLine(parts.hm, who, text);

        if (!line) return { ok: false, error: 'empty' };

        fs.mkdirSync(dir, { recursive: true });

        if (!fs.existsSync(file)) fs.writeFileSync(file, chatLogHeader(info, parts));

        fs.appendFileSync(file, `${line}\n`);

        return { ok: true, file };
      } catch (error) { onError(error); return { ok: false, error: error?.message ?? String(error) }; }
    },
  };
}

/**
 * 群号 → 群名（写文件名用，要稳定：同一个群每次都得得到同一个名字，不然一天的话会散在两个文件里）。
 * 先后顺序：配置里起的叫法（小房子）> 向 QQ 问到过的（缓存）> 姐姐记的 > 会话标题 > 群号。
 */
export function pickGroupName(gid, { alias = '', cached = '', sister = '', title = '' } = {}) {
  for (const x of [alias, cached, sister, title]) {
    const n = safeName(x);

    if (n) return n;
  }

  return String(gid);
}

/** 姐姐的状态文件里记的群名 { 群号: 名字 }（只读，读不到就是空）。 */
export function sisterGroupNames(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};

    for (const [gid, g] of Object.entries(st?.groupState || {})) if (g?.name && String(g.name) !== String(gid)) out[gid] = String(g.name);

    return out;
  } catch { return {}; }
}

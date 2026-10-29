// 「此刻在别处」（2026-10-29 施工单 C，老大同意）：小鲸鱼是一个人在好几扇门里，每次被叫醒时带一句她这会儿在别的会话正在干什么——
// 在别的群回话、在刷抖音、在写书、在跟姐姐聊……让她知道自己「同时还在别处」，不至于每扇门里都像第一次醒。
//
// 数据来源（都是内存里现成的，不读盘、不调模型）：
//   · 实时缓冲（src/live-buffer.js）里各会话最近几分钟的条目：调了什么工具、刚发出去什么话、一轮开始 / 结束了没有；
//   · 桥接知道的各会话「忙不忙」；
//   · 抖音自己刷的那个循环（它不属于任何一个会话）。
// 只说别处的事，不重复本会话的事；简短、家常，不出现数字和时间戳；一句话最多说三处。
// 隐私：别处是私聊时，不把私聊里说的原话带到群里来（只说「在老大私聊那边回话」）；本会话也是私聊时才引原话。
//
// 纯函数，方便测试：describeElsewhere(input) → 一段话（没有就 ''）；elsewhereBlock(input) → 带标题和换行的一整块。

/** 工具名（去掉 mcp 前缀）→ 在做什么。先匹配到的算。 */
export const TOOL_ACTIVITY = Object.freeze([
  [/^douyin_chat/, '在抖音私信里聊'],
  [/^douyin_/, '刷抖音'],
  [/^bili_/, '看 B 站'],
  [/^music_score$/, '扒谱'],
  [/^qq_explore/, '到处逛逛'],
  [/^novel_/, '写合写的书'],
  [/^(rambling_append|qq_growth_note)$/, '写碎碎念或日记'],
  [/^pc_(screenshot|activity)$/, '看老大的电脑'],
  [/^(web_|playwright|browser_)/, '上网查东西'],
  [/^qq_(post|like|comment|get)_qzone/, '逛 QQ 空间'],
  [/^(memory_|remember$|qq_note$|qq_self$|qq_keep_moment$|qq_recall$|qq_impression$)/, '整理自己的记忆']
]);

export function activityOfTool(name) {
  const n = String(name ?? '').replace(/^mcp__.+?__/, '');

  for (const [re, text] of TOOL_ACTIVITY) if (re.test(n)) return text;

  return '';
}

const clip = (s, n) => {
  const t = String(s ?? '').replaceAll(/\s+/g, ' ').trim();

  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param {object} o
 * @param {string} o.currentKey 本会话（不说它的事）
 * @param {number} [o.now]
 * @param {Array<{key:string,label?:string,busy?:boolean}>} [o.sessions] 桥接知道的各会话
 * @param {Array<object>} [o.entries] 实时缓冲的条目（kind / session / t / name / text）
 * @param {(key:string)=>'owner'|'sister'|'house'|'group'|'friend'} [o.kindOf] 会话是哪一类
 * @param {{watching?:boolean}} [o.douyin] 抖音自己刷的循环
 * @param {number} [o.windowMs] 多近的算「此刻」（默认 8 分钟）
 * @param {number} [o.sayMs] 刚说的话多近的才提（默认 20 分钟）
 * @param {number} [o.max] 最多说几处（默认 3）
 */
export function describeElsewhere({
  currentKey = '', now = Date.now(), sessions = [], entries = [], kindOf = () => 'group', douyin = null,
  windowMs = 8 * 60e3, sayMs = 20 * 60e3, max = 3
} = {}) {
  const labels = new Map(sessions.map((s) => [s.key, s.label || '']));
  const busy = new Set(sessions.filter((s) => s.busy).map((s) => s.key));
  const per = new Map();
  const get = (key) => { if (!per.has(key)) per.set(key, { key, activity: '', activityAt: 0, open: false, said: '', saidAt: 0, lastAt: 0 });

 return per.get(key); };

  for (const e of entries) {
    const key = e?.session;

    if (!key || key === currentKey || !Number.isFinite(Number(e.t))) continue;

    const age = now - e.t;

    if (age > Math.max(windowMs, sayMs) || age < -5000) continue;

    const p = get(key);
    p.lastAt = Math.max(p.lastAt, e.t);

    if (e.kind === 'turn-start') p.open = true;
    else if (e.kind === 'turn-end') p.open = false;
    else if (e.kind === 'tool-call' && age <= windowMs) {
      const a = activityOfTool(e.name);

      if (a && e.t >= p.activityAt) { p.activity = a; p.activityAt = e.t; }

      p.open = true;
    } else if (e.kind === 'sent' && e.text && e.t >= p.saidAt) { p.said = e.text; p.saidAt = e.t; }
  }

  for (const key of busy) if (key !== currentKey) get(key).open = true;

  const currentPrivate = ['owner', 'sister', 'friend'].includes(kindOf(currentKey)) && String(currentKey).startsWith('private:');

  const where = (key) => {
    const kind = kindOf(key);
    const label = clip(labels.get(key) || '', 14);

    if (kind === 'owner') return '老大私聊那边';
    if (kind === 'sister') return String(key).startsWith('group:') ? '小房子里' : '姐姐私聊那边';
    if (kind === 'house') return '小房子里';
    if (kind === 'friend') return label ? `${label}的私聊那边` : '别人的私聊那边';

    return label ? `「${label}」群里` : '另一个群里';
  };

  const items = [];

  for (const p of per.values()) {
    const kind = kindOf(p.key);
    const isPrivateThere = String(p.key).startsWith('private:');
    const where1 = where(p.key);
    const recentActivity = p.activity && now - p.activityAt <= windowMs;
    const sayOk = p.said && now - p.saidAt <= sayMs && (!isPrivateThere || currentPrivate);
    let text = '';
    let rank = 0;

    if (recentActivity && (kind === 'owner' || kind === 'sister' || kind === 'house' || kind === 'friend' || kind === 'group')) {
      text = `${where1}正在${p.activity}`;
      rank = 3;
    } else if (p.open) {
      text = `${where1}正在回话`;
      rank = 2;
    }

    if (sayOk) {
      const said = `刚说了「${clip(p.said, 16)}」`;
      text = text ? `${text}，${said}` : `${where1}${said}`;
      rank = Math.max(rank, 1);
    }

    if (text) items.push({ text, rank, at: Math.max(p.lastAt, p.saidAt, p.activityAt) });
  }

  items.sort((a, b) => b.rank - a.rank || b.at - a.at);
  const parts = items.slice(0, max).map((x) => x.text);

  if (douyin?.watching && !parts.some((t) => t.includes('刷抖音'))) parts.unshift('自己在刷抖音');

  return parts.slice(0, max).join('；');
}

/** 带标题和换行的一整块；没有可说的返回 ''。 */
export function elsewhereBlock(input = {}) {
  const t = describeElsewhere(input);

  return t ? `【此刻在别处】你这会儿同时还在别的地方：${t}。（只是让你知道，这边怎么做你自己定）\n\n` : '';
}

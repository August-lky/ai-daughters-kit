// QQ 卡片消息解析。
//
// 群里分享小红书 / B站 / 抖音 / 小程序 / 音乐 / 群文件时，OneBot 上报的是：
//   { type: 'json', data: { data: '<一整串 JSON 文本>' } }
// 老式卡片（群文件、红包、空间）则是 `xml` 段，里面是 XML 文本。
//
// 以前两种都统一折成四个字 `[卡片消息]` —— 模型案头就这四个字，
// 等于「有人发了个东西，但你不知道是什么」，既接不上话也没法判断要不要点开。
//
// 这个模块把卡片拆成「来源 · 标题 · 简介 · 链接」。
//
// 链接必须清洗：小红书分享链里 xsec_token / share_id / track_code / apptime
// 加起来两三百字符，全塞进上下文一天就是几万 token，而对「点开看」毫无用处。
// 只保留能定位内容本身的参数（B站的 p、YouTube 的 v、BV 号…），其余全丢。

const CARD_APP_LABELS = {
  'com.tencent.structmsg': '分享',
  'com.tencent.tuwen.lua': '图文',
  'com.tencent.miniapp_01': '小程序',
  'com.tencent.miniapp': '小程序',
  'com.tencent.music.lua': '音乐',
  'com.tencent.troopfile': '群文件',
  'com.tencent.mannounce': '群公告',
  'com.tencent.qzone': '空间',
  'com.tencent.lightapp': '小程序',
  'com.tencent.qqmail': '邮件',
  'com.tencent.gamecenter': '游戏'
};

// 保留的 query 参数：能唯一定位内容的那些。其余（跟踪/分享来源/时间戳）一律丢。
const CARD_KEEP_PARAMS = new Set([
  'p', 'v', 'bvid', 'aid', 'bv', 'mid', 'vid', 'id', 'page', 't', 'start', 'cid', 'sid'
]);

/** 压掉控制字符/换行并限长——卡片内容是外部输入，不能让它伪造出提示词段落。 */
function sanitizeCardField(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 分享链清洗：去掉跟踪参数，超长就退回 origin+pathname。 */
export function cleanCardUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let u = null;
  try {
    u = new URL(s);
  } catch {
    return s.length > 130 ? `${s.slice(0, 130)}…` : s;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (CARD_KEEP_PARAMS.has(k) && v.length <= 48) kept.append(k, v);
  }
  u.search = kept.toString();
  u.hash = '';
  let out = u.toString();
  if (out.length > 130) out = u.origin + u.pathname;
  if (out.length > 130) out = `${out.slice(0, 130)}…`;
  return out;
}

function pickField(node, names) {
  if (!node || typeof node !== 'object') return '';
  for (const n of names) {
    const v = node[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#44;/g, ',')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * 把卡片原始串解析成 {source,title,desc,url,preview}。
 * 解析不出来返回 null（调用方回退成 `[卡片消息]`）。
 */
export function parseCardPayload(raw) {
  let s = raw;
  if (s && typeof s === 'object') {
    try {
      s = JSON.stringify(s);
    } catch {
      s = '';
    }
  }
  s = String(s ?? '').trim();
  if (!s) return null;

  if (s.startsWith('{')) {
    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
    // meta 的分支名不固定：news / detail_1 / music / video / …
    // 取第一个有内容的子对象就够；QQ 一张卡片只会填一个分支。
    let node = null;
    for (const k of Object.keys(meta)) {
      const v = meta[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        node = v;
        break;
      }
    }

    let title = pickField(node, ['title', 'name', 'head', 'nickname']);
    // 兜底 prompt 形如「[分享]标题」，前缀去掉
    const prompt = pickField(obj, ['prompt']);
    if (!title && prompt) title = prompt.replace(/^\[[^\]]*\]\s*/, '');
    const desc = pickField(node, ['desc', 'description', 'summary', 'subText']);
    const url = pickField(node, ['jumpUrl', 'jump_url', 'qqdocurl', 'url', 'linkUrl']);
    const tag = pickField(node, ['tag', 'source', 'appName', 'tagName']);
    const preview = pickField(node, ['preview', 'icon', 'imageUrl', 'picUrl', 'cover']);
    const appLabel = CARD_APP_LABELS[String(obj.app ?? '')] || pickField(obj, ['desc', 'appName']);

    const card = {
      source: tag || appLabel || '卡片',
      title: title.replace(/^\[[^\]]*\]\s*/, '').trim(),
      desc,
      url,
      preview
    };
    if (!card.title && !card.desc && !card.url) return null;
    return card;
  }

  if (s.startsWith('<')) {
    const pickTag = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(s);
      return m ? decodeXmlEntities(m[1]) : '';
    };
    const card = {
      source: pickTag('brief') || pickTag('source') || '卡片',
      title: pickTag('title'),
      desc: pickTag('summary') || pickTag('desc'),
      url: pickTag('url') || pickTag('jumpUrl'),
      preview: pickTag('thumb') || pickTag('preview')
    };
    if (!card.title && !card.desc && !card.url) return null;
    return card;
  }

  return null;
}

/**
 * 卡片段 → 一行可读文本。解析失败时回退成 `[卡片消息]`（保持旧行为）。
 */
export function cardToText(data) {
  const raw = data?.data ?? data?.content ?? data?.raw ?? '';
  const card = parseCardPayload(raw);
  if (!card) return '[卡片消息]';
  const source = sanitizeCardField(card.source, 12) || '卡片';
  const title = sanitizeCardField(card.title, 60);
  const desc = sanitizeCardField(card.desc, 80);
  const url = cleanCardUrl(card.url);
  const parts = [];
  if (title) parts.push(title);
  if (desc && desc !== title && !title.includes(desc)) parts.push(desc);
  if (url) parts.push(url);
  if (!parts.length) return `[卡片·${source}]`;
  return `[卡片·${source}] ${parts.join('｜')}`;
}

/** 卡片里的预览图地址（给媒体登记用，没有就返回空串）。 */
export function cardPreviewUrl(data) {
  const raw = data?.data ?? data?.content ?? data?.raw ?? '';
  const card = parseCardPayload(raw);
  return card?.preview && /^https?:\/\//i.test(card.preview) ? card.preview : '';
}

// 检索服务（brain/service.py，127.0.0.1:3210）的客户端：按话题想起、记错了降权、睡前整理建议、刚留下瞬间。
// 小鲸鱼（bridge.js）和姐姐（sister.mjs）共用同一份，接口一样。
//
// 2026-10-29 大脑方案下半（老大：记忆统一，私聊只标注不过滤）。原则：服务没起、还在重建、超时（默认 1.5 秒），
// 一律静默当没有——绝不拖慢唤醒、不抛错、不往 QQ 发任何东西。
import http from 'node:http';

export const BRAIN_SERVICE = Object.freeze({ host: '127.0.0.1', port: Number(process.env.MEMORY_PORT || 3210) });
export const RECALL_TITLE = '【可能想起的：想用就用，不想提就当没想起】';
export const RECALL_TIMEOUT_MS = 1500;
/** 「这个想起来的东西不对」的话：老大说「记错了」「你记错了」「不是这样」。太长的话是在讲别的事，不算。 */
const CORRECTION_RE = /记错了|你记错|记错啦|记岔了|不是这样/;

/** POST JSON，永不 reject：失败 / 超时 / 非 200 都返回 null。 */
export function postJson(pathName, body, { timeoutMs = RECALL_TIMEOUT_MS, service = BRAIN_SERVICE } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
      const req = http.request({
        host: service.host, port: service.port, path: pathName, method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) { done(null); return; }
          try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); }
        });
        res.on('error', () => done(null));
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      const hard = setTimeout(() => { try { req.destroy(); } catch { /* 已经没了 */ } done(null); }, timeoutMs + 200);
      hard.unref?.();
      req.end(payload);
    } catch { done(null); }
  });
}

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const maskDigits = (s) => String(s ?? '').replace(/\d{7,}/g, '…');

/**
 * 从最近的消息（桥接的 recentMessages：{ text|plain, isSelf, time|at }）里取「这句 + 前两句」：
 * 这句 = 最新一条别人说的话；前两句 = 它前面紧挨着的两条（谁说的都行，含她自己）。
 * 这句已经是很久以前的（默认 30 分钟前）就返回 null——话题早过去了，没必要想。
 */
export function recallQueryFromMessages(messages, { nowMs = Date.now(), maxAgeMs = 30 * 60e3, lineChars = 160 } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && (m.text || m.plain));
  let ci = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) if (!list[i].isSelf) { ci = i; break; }
  if (ci < 0) return null;
  const t = Number(list[ci].time ?? list[ci].at);
  if (Number.isFinite(t) && t > 0 && nowMs - t > maxAgeMs) return null;
  const clean = (m) => oneLine(maskDigits(String(m.text || m.plain || '')), lineChars);
  const query = clean(list[ci]);
  if (!query || /^(\[[^\]]{1,8}\]\s*)+$/.test(query)) return null;      // 只有 [图片] [表情] 之类
  const prev = list.slice(Math.max(0, ci - 2), ci).map(clean).filter(Boolean);
  return { query, prev };
}

/** 从一串已经整理好的行里取「最后一行 + 前两行」（姐姐那边用：行 = 别人 / 她自己说的话，一行一句）。 */
export function recallQueryFromLines(lines, { lineChars = 160 } = {}) {
  const list = (Array.isArray(lines) ? lines : []).map((l) => oneLine(maskDigits(String(l ?? '').replace(/^\[#\d+\]\s*/, '')), lineChars)).filter(Boolean);
  if (!list.length) return null;
  const query = list[list.length - 1];
  if (/^(\[[^\]]{1,8}\]\s*)+$/.test(query)) return null;
  return { query, prev: list.slice(Math.max(0, list.length - 3), list.length - 1) };
}

/** 去检索服务按话题想起；永不抛错，没起来 / 超时 / 没想起什么都返回 null（有东西才返回 { items, pressed, lines }）。 */
export async function brainRecall({ brain = 'whale', query, prev = [], mode = 'private', viewerKey = '', timeoutMs = RECALL_TIMEOUT_MS, post = postJson } = {}) {
  if (!query) return null;
  try {
    const r = await post('/recall', { brain, query, prev, mode, viewer: viewerKey }, { timeoutMs });
    if (!r || r.ok === false || !Array.isArray(r.lines) || !r.lines.length) return null;
    return { items: r.items || [], pressed: r.pressed || null, lines: r.lines, mode: r.mode };
  } catch { return null; }
}

/** 想起来的东西放进唤醒消息的样子：标题 + 一行一条。没有就是 ''。 */
export function formatRecallBlock(result) {
  if (!result?.lines?.length) return '';
  return `${RECALL_TITLE}\n${result.lines.join('\n')}\n\n`;
}

/** 老大这句话是不是在说「你记错了」。 */
export function isMemoryCorrection(text) {
  const t = String(text ?? '').trim();
  return t.length > 0 && t.length <= 60 && CORRECTION_RE.test(t);
}

/**
 * 老大说「记错了」：把最近一次想起的条目降权。返回 { demoted: [{label, preview}] }；最近没想起过什么 / 服务没起来是空数组。
 */
export async function brainDemote({ brain = 'whale', maxAgeMin = 30, timeoutMs = 3000, post = postJson } = {}) {
  try {
    const r = await post('/demote', { brain, maxAgeMin }, { timeoutMs });
    return { demoted: Array.isArray(r?.demoted) ? r.demoted : [] };
  } catch { return { demoted: [] }; }
}

/** 「老大说你刚才记错了」提醒她的那句话（放进唤醒消息）。demoted 为空返回 ''。 */
export function correctionReminder(demoted) {
  const list = (Array.isArray(demoted) ? demoted : []).filter((d) => d && (d.preview || d.label));
  if (!list.length) return '';
  const shown = list.slice(0, 3).map((d) => `· ${oneLine(d.preview || '', 70)}（${d.label || '某处'}）`).join('\n');
  return `【老大说你刚才记错了】要不要去改改本子？我先把下面这几条标成「少想起」了（你改过本子，它们就恢复）：\n${shown}\n\n`;
}

/** 睡前整理建议：{ text, total }。服务没起来是 null。 */
export async function brainTidy({ brain = 'whale', timeoutMs = 4000, post = postJson } = {}) {
  try {
    const r = await post('/tidy', { brain }, { timeoutMs });
    if (!r || r.ok === false) return null;
    return { text: String(r.text || ''), total: Number(r.total) || 0 };
  } catch { return null; }
}

/** 刚留下一个瞬间：让检索服务马上把它收进索引（发了就不管，不等结果）。 */
export function brainRememberMoment({ brain = 'whale', timeoutMs = 2000, post = postJson } = {}) {
  try { void Promise.resolve(post('/remember-moment', { brain }, { timeoutMs })).catch(() => {}); } catch { /* 没起来就算了 */ }
}

// 大肥鱼表情包（2026-10-24 主人：表情包给她吧）。
//
// 来源：Loping151/dsh-nekowhale-stickers 的知识文件 + kiriyuki.com 的图片清单，
// 合成 assets/fish-stickers/catalog.json（322 张，每张带情绪 / 标签 / 什么时候用 / 画面描述）。
// 图片作者：B站 可以叫我云大人；图片许可 CC BY-NC 4.0（非商用、需署名）。
//
// 全套 GIF 约 400MB，不一次拉完：她第一次发哪张才从 kiriyuki.com 下哪张，
// 按清单里的哈希校验后存进 state/fish-sticker-cache/，以后直接用本地的。
// 这里只放纯函数和带注入下载器的取图，桥接负责发送。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadFishCatalog(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stickers = Array.isArray(raw?.stickers) ? raw.stickers.filter((s) => s && s.code && s.file && s.hash) : [];
    return { ...raw, stickers };
  } catch {
    return { stickers: [] };
  }
}

// 她叫一张图的名字：「鱼:猫猫搓手」。同名的（如两张「好吃」）用编号区分：「鱼:10N01」。
export function fishLabel(s) {
  return `鱼:${s.name || s.code}`;
}

const stripPrefix = (ref) => String(ref ?? '').trim().replace(/^(?:大肥鱼|鱼)\s*[:：]\s*/, '');

/** 按编号 / 文件名 / 名字找一张；名字对上好几张时返回 { ambiguous: [...] }。 */
export function findFish(catalog, ref) {
  const raw = String(ref ?? '').trim();
  const q = stripPrefix(raw);
  if (!q) return null;
  const all = catalog?.stickers ?? [];
  const exact = all.find((s) => s.code === q || s.code.split('_')[0] === q || `${s.pack}/${s.code}` === q);
  if (exact) return { sticker: exact };
  const byName = all.filter((s) => s.name === q);
  if (byName.length === 1) return { sticker: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };
  return null;
}

/**
 * 按心情 / 场景搜。空格或逗号分开的几个词各自打分：情绪完全对上、名字、标签、用途、画面描述依次递减。
 * 没写词就按情绪分组各挑一张，当「随便看看」。
 */
export function searchFish(catalog, query, { limit = 12, pack = '' } = {}) {
  const all = (catalog?.stickers ?? []).filter((s) => !pack || s.pack === pack);
  const words = String(query ?? '').split(/[\s,，、;；/]+/).map((w) => w.trim()).filter(Boolean);
  const max = Math.min(40, Math.max(1, Number(limit) || 12));
  if (!words.length) {
    const seen = new Set();
    return all.filter((s) => (seen.has(s.emotion) ? false : seen.add(s.emotion))).slice(0, max);
  }
  const scored = [];
  for (const s of all) {
    let score = 0;
    for (const w of words) {
      if (s.emotion === w) score += 6;
      if (s.name && s.name.includes(w)) score += 5;
      if ((s.tags || []).some((t) => t === w)) score += 4;
      else if ((s.tags || []).some((t) => t.includes(w) || (w.length >= 2 && w.includes(t)))) score += 3;
      if (s.text && s.text.includes(w)) score += 3;
      if (s.use && s.use.includes(w)) score += 2;
      if (s.meme && s.meme.includes(w)) score += 1;
      if (s.desc && s.desc.includes(w)) score += 1;
    }
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.s);
}

/** 给她看的一行：名字、情绪、什么时候用、画面（双人的写明谁对谁）。 */
export function describeFish(s, { withDesc = true } = {}) {
  const parts = [`${fishLabel(s)}（${s.code.split('_')[0]}）`, s.emotion];
  if (s.dir) parts.push(s.dir);
  if (s.text) parts.push(`图上写着「${s.text}」`);
  if (s.use) parts.push(`用在：${s.use}`);
  if (withDesc && s.desc) parts.push(`画面：${s.desc}`);
  return parts.filter(Boolean).join('｜');
}

export function fishUrl(catalog, s) {
  const site = String(catalog?.site || 'https://kiriyuki.com').replace(/\/+$/, '');
  const base = String(catalog?.gifBase || '/media/gif');
  return `${site}${base}/${encodeURIComponent(s.pack)}/${encodeURIComponent(s.file)}?h=${s.hash}`;
}

const sha1hex = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/**
 * 取一张 GIF：本地缓存里有且哈希对得上就直接用；没有就下载、校验、落盘。
 * fetchBuffer(url, maxBytes) => { buffer }，由桥接注入（用带 DNS 固定的安全下载器）。
 */
export async function getFishGif(catalog, s, { cacheDir, fetchBuffer, maxBytes }) {
  const file = path.join(cacheDir, `${s.hash}.gif`);
  try {
    const cached = fs.readFileSync(file);
    if (sha1hex(cached).startsWith(s.hash)) return { buffer: cached, cached: true };
  } catch { /* 没缓存 */ }
  const { buffer } = await fetchBuffer(fishUrl(catalog, s), maxBytes);
  if (!buffer?.length) throw new Error('图片是空的');
  if (!sha1hex(buffer).startsWith(s.hash)) throw new Error('下下来的图和清单对不上（可能网站换了图）');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return { buffer, cached: false };
}

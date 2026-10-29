// 看图：两个女儿共用的一套（2026-10-29 主人，大整理第二批 D1～D3）。
//
// 为什么要有这个文件：
//   - 小鲸鱼那边会抽帧，但大 GIF 20 秒下载超时、每个备用地址再下一遍；抽帧失败的兜底把 GIF 当 jpg 压，
//     再失败就原样交出，超过约 7.5MB 会把工具连接撑断；探不到时长时只抽前 3 秒。
//   - 姐姐那边根本不抽帧（Claude 只看第一帧，「姐姐看不到 GIF」就是这个），超过 4.5MB 直接丢、不提示。
// 现在两边都走这里：
//   viewImage(字节)            → 动图从头到尾均匀抽 6 帧拼成 3×2；静态大图缩到长边 1600；
//                                抽帧失败只取首帧再缩；最终保证 < 3.5MB（base64 后 < 5MB），实在压不下就说「这张太大了看不清」。
//   createImageDownloader(...) → 单地址 40 秒；超过大小上限第一次就放弃（不再按每个 rkey 重下）；
//                                失败过的地址短时间内不再重试。
//   segImageRef(段)            → QQ 消息段 → 下载用的地址列表（市场表情没 url 时按 emoji_id 拼 CDN 地址）和去重用的 key。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFetchBuffer } from './safe-fetch.js';

const WINGET_FFMPEG = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
export const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || (fs.existsSync(WINGET_FFMPEG) ? WINGET_FFMPEG : 'ffmpeg');

export const VIEW_MAX_BYTES = Math.floor(3.5 * 1024 * 1024); // 给模型的单张上限（base64 后约 4.7MB，低于 Claude 的 5MB）
export const BASE64_MAX = 5 * 1024 * 1024;
export const VIEW_MAX_SIDE = 1600;   // 两个模型自己也会缩到这个量级，再大只是白占地方（姐姐的会话存档就是被图撑大的）
export const SHRINK_ABOVE_BYTES = 1024 * 1024;
export const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 40000;
export const TOO_BIG_TEXT = '这张太大了看不清';

// ── 认格式、量尺寸、数帧（纯 JS，不起子进程） ─────────────────────────────────

/** 按文件头认图片格式；不是 PNG/JPEG/GIF/WebP 就返回空。 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function webpSize(buf) {
  const tag = buf.toString('latin1', 12, 16);
  if (tag === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (tag === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (tag === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
  return null;
}

function jpegSize(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const m = buf[p + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
    p += 2 + buf.readUInt16BE(p + 2);
  }
  return null;
}

/** 宽高（读文件头）；认不出返回 null。 */
export function imageSize(buf) {
  const mime = sniffMime(buf);
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp') return webpSize(buf);
    if (mime === 'image/jpeg') return jpegSize(buf);
  } catch { /* 文件头残缺 */ }
  return null;
}

/** GIF 一共几帧（数图像块）、总时长（图形控制扩展里的延时之和）。 */
function gifFrames(buf) {
  if (buf.length < 13 || buf.toString('latin1', 0, 3) !== 'GIF') return null;
  let p = 13;
  if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
  let frames = 0, delay = 0;
  const skipSub = () => { while (p < buf.length) { const n = buf[p]; p += 1; if (n === 0) return true; p += n; } return false; };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9 && buf[p] === 4 && p + 4 < buf.length) delay += buf.readUInt16LE(p + 2);
      if (!skipSub()) break;
    } else if (b === 0x2c) {
      if (p + 9 > buf.length) break;
      const f = buf[p + 8];
      p += 9;
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
      p += 1; // LZW 最小码长
      frames += 1;
      if (!skipSub()) break;
    } else break; // 结构坏了，数到哪算哪
  }
  return frames ? { frames, durationMs: delay * 10 } : null;
}

/** 动图的帧数：GIF 数图像块、APNG 读 acTL、动态 WebP 数 ANMF。不是动图或数不出来返回 null。 */
export function countFrames(buf) {
  const mime = sniffMime(buf);
  try {
    if (mime === 'image/gif') return gifFrames(buf);
    if (mime === 'image/png') {
      const i = buf.indexOf('acTL', 8, 'latin1');
      return i > 0 && i + 8 <= buf.length ? { frames: buf.readUInt32BE(i + 4), durationMs: 0 } : null;
    }
    if (mime === 'image/webp') {
      let p = 12, frames = 0;
      while (p + 8 <= buf.length) {
        const size = buf.readUInt32LE(p + 4);
        if (buf.toString('latin1', p, p + 4) === 'ANMF') frames += 1;
        p += 8 + size + (size & 1);
      }
      return frames ? { frames, durationMs: 0 } : null;
    }
  } catch { /* 文件残缺 */ }
  return null;
}

/** 可能是动图（GIF / APNG / 动态 WebP）。单帧 GIF 也算，数完帧再说。 */
export function maybeAnimated(buf) {
  const mime = sniffMime(buf);
  if (mime === 'image/gif') return true;
  if (mime === 'image/png') { const i = buf.indexOf('acTL', 8, 'latin1'); return i > 0 && i < 4096; }
  if (mime === 'image/webp') return buf.indexOf('ANMF', 12, 'latin1') > 0;
  return false;
}

/** 从 total 帧里均匀挑 want 帧（含第一帧和最后一帧），覆盖整段。 */
export function pickFrameIndexes(total, want = 6) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (n <= 0) return [];
  if (n <= want) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < want; i += 1) out.push(Math.round((i * (n - 1)) / (want - 1)));
  return [...new Set(out)];
}

/** 几帧拼成几行几列：≤3 帧排一行，4 帧 2×2，再多 3×2。 */
export function sheetLayout(k) {
  if (k <= 3) return { cols: Math.max(1, k), rows: 1 };
  if (k === 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

// ── 跑 ffmpeg（异步，不卡住桥接 / 姐姐的主循环；同时最多两个） ────────────────

let running = 0;
const waiters = [];
async function withSlot(fn) {
  if (running >= 2) await new Promise((resolve) => { waiters.push(resolve); });
  running += 1;
  try { return await fn(); } finally { running -= 1; waiters.shift()?.(); }
}

function run(cmd, args, { timeoutMs = 30000 } = {}) {
  return withSlot(() => new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (error) { resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error?.message ?? error) }); return; }
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error?.message ?? error) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
  }));
}

const ffprobeOf = (ffmpeg) => String(ffmpeg).replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const isJpeg = (b) => b && b.length > 100 && b[0] === 0xff && b[1] === 0xd8;

/** JS 数不出帧时：先 ffprobe 数包（不解码，快），再不行让 ffmpeg 整段解一遍数帧。 */
async function probeFrameCount(file, ffmpeg) {
  const p = await run(ffprobeOf(ffmpeg), ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { timeoutMs: 15000 });
  const n = Number.parseInt(String(p.stdout).trim(), 10);
  if (p.code === 0 && n > 0) return n;
  const d = await run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: 30000 });
  const all = [...String(d.stderr).matchAll(/frame=\s*(\d+)/g)];
  const m = all.length ? Number(all[all.length - 1][1]) : 0;
  return m > 0 ? m : 0;
}

// 透明处垫白：先缩，再叠到同尺寸白底上（跟 image-shrink.js 一样的做法）
const WHITE_PAD = 'format=rgba,split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay=format=auto';
const JPEG_PIPE = ['-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];

async function makeSheet(file, total, ffmpeg, { frames = 6, cell = 320 } = {}) {
  const idx = pickFrameIndexes(total, frames);
  if (idx.length < 2) return null;
  const { cols, rows } = sheetLayout(idx.length);
  const select = `select='${idx.map((i) => `eq(n,${i})`).join('+')}'`;
  const scale = `scale=${cell}:${cell}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const graph = `[0:v]${select},${scale},${WHITE_PAD},tile=${cols}x${rows}:padding=4:color=black,format=yuvj420p[out]`;
  const r = await run(ffmpeg, ['-v', 'error', '-i', file, '-filter_complex', graph, '-map', '[out]', '-fps_mode', 'passthrough', '-frames:v', '1', '-q:v', '4', ...JPEG_PIPE], { timeoutMs: 30000 });
  return r.code === 0 && isJpeg(r.stdout) ? { buffer: r.stdout, frames: idx.length } : null;
}

async function shrinkFirstFrame(file, ffmpeg, { maxSide, quality }) {
  const fit = `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
  const graph = `[0:v]${fit},${WHITE_PAD},format=yuvj420p[out]`;
  const r = await run(ffmpeg, ['-v', 'error', '-i', file, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', String(quality), ...JPEG_PIPE], { timeoutMs: 20000 });
  return r.code === 0 && isJpeg(r.stdout) ? r.stdout : null;
}

const fits = (buf, maxBytes) => buf.length <= maxBytes && Math.ceil(buf.length / 3) * 4 < BASE64_MAX;
const shrinkSteps = (maxSide) => [[maxSide, 3], [Math.min(1024, maxSide), 6]]; // 先缩到长边 maxSide（1600）；还太大再缩一档

/** 动图：数出帧数（JS → ffprobe → ffmpeg 解码），从头到尾均匀抽帧拼图；抽帧失败只取首帧再缩。数出来只有一帧返回 null（按静态图处理）。 */
async function viewAnimated(buf, mime, src, o) {
  const counted = o.count(buf);
  const total = counted?.frames || await probeFrameCount(src(), o.ffmpeg);
  if (total <= 1) return null;
  const sheet = await o.makeSheetImpl(src(), total, o.ffmpeg, { frames: o.frames, cell: o.cell });
  if (sheet && fits(sheet.buffer, o.maxBytes)) {
    const secs = counted?.durationMs ? `，整段约 ${(counted.durationMs / 1000).toFixed(1)} 秒` : '';
    return { ok: true, buffer: sheet.buffer, mimeType: 'image/jpeg', kind: 'sheet', frames: sheet.frames, note: `（动图：从头到尾均匀抽了 ${sheet.frames} 帧拼成一张${secs}，按时间顺序从左到右、从上到下看）` };
  }
  o.log(`[image-view] 动图抽帧没成（${total} 帧），改成只看第一帧`);
  // 不再把 GIF 当 jpg 压：只取首帧转 JPEG
  for (const [side, q] of shrinkSteps(o.maxSide)) {
    const first = await shrinkFirstFrame(src(), o.ffmpeg, { maxSide: side, quality: q });
    if (first && fits(first, o.maxBytes)) return { ok: true, buffer: first, mimeType: 'image/jpeg', kind: 'first-frame', note: '（动图没能抽帧，只看到第一帧）' };
  }
  if (fits(buf, o.maxBytes)) return { ok: true, buffer: buf, mimeType: mime, kind: 'original', note: '（动图没能抽帧，只看得到第一帧）' };
  return { ok: false, reason: TOO_BIG_TEXT };
}

/** 静态图（含单帧 GIF）：不大就原样给；大了缩到长边 maxSide，还大就再缩一档；都不行说看不清。 */
async function viewStill(buf, mime, dims, src, o) {
  const longSide = dims ? Math.max(dims.width, dims.height) : 0;
  const originalOk = fits(buf, o.maxBytes) && longSide <= o.maxSide;
  if (originalOk && buf.length <= o.shrinkAboveBytes) return { ok: true, buffer: buf, mimeType: mime, kind: 'original', note: '' };
  for (const [side, q] of shrinkSteps(o.maxSide)) {
    const small = await shrinkFirstFrame(src(), o.ffmpeg, { maxSide: side, quality: q });
    if (!small || !fits(small, o.maxBytes)) continue;
    if (originalOk && small.length >= buf.length) break; // 缩完反而更大：原图本身就合适
    return { ok: true, buffer: small, mimeType: 'image/jpeg', kind: 'shrunk', note: '' };
  }
  if (fits(buf, o.maxBytes)) return { ok: true, buffer: buf, mimeType: mime, kind: 'original', note: '' };
  return { ok: false, reason: TOO_BIG_TEXT };
}

/**
 * 一张图 → 给模型看的样子。
 * 返回 { ok:true, buffer, mimeType, kind, note, frames? }，kind 是 sheet（动图拼图）/ first-frame（动图只取到首帧）/ shrunk / original；
 * 或 { ok:false, reason }（reason 是能直接念给她听的一句话）。不抛错。
 * count / makeSheetImpl 测试时可换成假的（数不出帧 / 抽帧失败）。
 */
export async function viewImage(buf, {
  maxBytes = VIEW_MAX_BYTES, maxSide = VIEW_MAX_SIDE, shrinkAboveBytes = SHRINK_ABOVE_BYTES,
  frames = 6, cell = 320, maxPixels = 64000000, ffmpeg = DEFAULT_FFMPEG, log = () => {},
  count = countFrames, makeSheetImpl = makeSheet
} = {}) {
  const mime = sniffMime(buf);
  if (!mime) return { ok: false, reason: '这不是能看的图片格式' };
  const dims = imageSize(buf);
  if (dims && dims.width * dims.height > maxPixels) return { ok: false, reason: `这张图尺寸太大了（${dims.width}×${dims.height}），看不了` };
  const o = { maxBytes, maxSide, shrinkAboveBytes, frames, cell, ffmpeg, log, count, makeSheetImpl };
  let dir = null;
  const src = () => {
    const file = () => path.join(dir, `src.${mime.split('/')[1]}`);
    if (!dir) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-view-'));
      fs.writeFileSync(file(), buf);
    }
    return file();
  };
  try {
    const animated = maybeAnimated(buf) ? await viewAnimated(buf, mime, src, o) : null;
    return animated || await viewStill(buf, mime, dims, src, o);
  } catch (error) {
    log(`[image-view] 处理图片出错：${error?.message ?? error}`);
    return fits(buf, maxBytes) ? { ok: true, buffer: buf, mimeType: mime, kind: 'original', note: '' } : { ok: false, reason: TOO_BIG_TEXT };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就留在临时目录 */ } }
  }
}

// ── 地址、去重 key ──────────────────────────────────────────────────────────

/** 去掉 rkey（QQ 图片链接的临时签名），同一张图的不同签名算一个地址。 */
export function stripRkey(u) {
  const s = String(u ?? '');
  const q = s.indexOf('?');
  // 没有「?」时 rkey 是被硬拼在后面的（url + '&rkey=…'），直接去掉
  if (q < 0) return s.replace(/&rkey=[^&#]*/gi, '');
  const query = s.slice(q + 1).split('&').filter((part) => part && !/^rkey=/i.test(part)).join('&');
  return query ? `${s.slice(0, q)}?${query}` : s.slice(0, q);
}

// QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
// https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。只接受纯十六进制 id，绝不把任意字符串拼进 URL。
export function emojiCdnCandidates(emojiId) {
  const id = String(emojiId ?? '').trim();
  if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
  return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
}

// 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
export function emojiIdFromFileName(file) {
  const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
  return match ? match[1] : '';
}

/** 一张图的身份：表情按 emoji_id，图片按文件名（QQ 给的是内容摘要式的名字），再不行按去掉 rkey 的地址。 */
export function imageKey({ url = '', file = '', emojiId = '' } = {}) {
  if (emojiId) return `e:${String(emojiId).toLowerCase()}`;
  const f = String(file ?? '').trim();
  if (/[0-9a-f]{16,}/i.test(f)) return `f:${f.toLowerCase()}`;
  if (/^https?:\/\//i.test(String(url))) return `u:${stripRkey(url)}`;
  return f ? `f:${f.toLowerCase()}` : '';
}

/** QQ 消息段（image / mface）→ { url, file, summary, emojiId?, urls, key, sticker }；不是图或什么地址都没有返回 null。 */
export function segImageRef(seg) {
  if (!seg || (seg.type !== 'image' && seg.type !== 'mface')) return null;
  const d = seg.data || {};
  const url = String(d.url || '').trim();
  const file = String(d.file || '').trim();
  const emojiId = String(d.emoji_id || d.emojiId || '').trim() || emojiIdFromFileName(file);
  const urls = [url, ...emojiCdnCandidates(emojiId)].filter((u, i, all) => /^https?:\/\//i.test(u) && all.indexOf(u) === i);
  if (!urls.length && !file) return null;
  const sticker = seg.type === 'mface' || String(d.sub_type ?? d.subType ?? '') === '1' || !!emojiId;
  return { url, file, summary: String(d.summary || ''), ...(emojiId ? { emojiId } : {}), urls, key: imageKey({ url, file, emojiId }), sticker };
}

// ── 下载 ────────────────────────────────────────────────────────────────────

export const isTooLargeError = (e) => e?.code === 'TOO_LARGE' || /超过大小限制/.test(String(e?.message ?? e));
const isTimeoutError = (e) => /超时|timeout|ETIMEDOUT|aborted/i.test(String(e?.message ?? e));

/**
 * 下载器：一个进程一个，记着哪些地址刚失败过。
 * download(urls, { rkeys, accept }) → { ok:true, buffer, url } 或 { ok:false, reason, tooLarge?, error? }。
 *   - 每个地址先原样试、再逐个拼 rkey（QQ 图片要 rkey 才下得来）；
 *   - 超过大小上限：第一次就放弃，这个地址记 badTtlMs 内不再下（不按每个 rkey 重下一遍）；
 *   - 超时：这个地址的其余 rkey 变体不再试（换签名也是同样慢），记 failTtlMs；
 *   - 别的失败（400 签名不对之类）照常换下一个变体。
 */
export function createImageDownloader({
  fetchBuffer = safeFetchBuffer, maxBytes = DOWNLOAD_MAX_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS,
  badTtlMs = 10 * 60e3, failTtlMs = 2 * 60e3, now = () => Date.now()
} = {}) {
  const bad = new Map(); // 去掉 rkey 的地址 → { until, reason, tooLarge }
  const mb = Math.round(maxBytes / 1024 / 1024);
  function remember(key, rec, ttl) {
    bad.set(key, { ...rec, until: now() + ttl });
    if (bad.size > 300) bad.delete(bad.keys().next().value);
  }
  /** 一个地址的所有 rkey 变体：成功 { ok, buffer, url }；太大 { tooLarge }；否则 { failed }。 */
  async function tryVariants(url, rkeys, accept, tried) {
    let failed = null;
    for (const v of url.includes('rkey=') ? [url] : [url, ...rkeys.map((s) => url + s)]) {
      try {
        const buf = (await fetchBuffer(v, maxBytes, { timeoutMs }))?.buffer;
        if (buf?.length && (!accept || accept(buf))) return { ok: true, buffer: buf, url: v };
        failed = { reason: '下下来的不是图片', error: 'not an image' };
      } catch (error) {
        const msg = String(error?.message ?? error);
        tried.push(msg);
        if (isTooLargeError(error)) return { tooLarge: true, reason: `这张图太大了（超过 ${mb}MB），没下载`, error: msg };
        failed = isTimeoutError(error) ? { reason: '下载超时了', error: msg } : { reason: '下载没成功（链接可能过期了）', error: msg };
        if (isTimeoutError(error)) break;
      }
    }
    return { failed };
  }
  async function download(urls, { rkeys = [], accept = null } = {}) {
    let last = null;
    const tried = [];
    for (const raw of Array.isArray(urls) ? urls : [urls]) {
      const url = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const key = stripRkey(url);
      const known = bad.get(key);
      if (known && known.until > now()) {
        last = { reason: known.reason, tooLarge: !!known.tooLarge };
        if (known.tooLarge) break;
        continue;
      }
      const r = await tryVariants(url, rkeys, accept, tried);
      if (r.ok) { bad.delete(key); return r; }
      if (r.tooLarge) {
        remember(key, { reason: r.reason, tooLarge: true }, badTtlMs);
        return { ok: false, tooLarge: true, reason: r.reason, error: r.error, tried };
      }
      if (r.failed) { last = r.failed; remember(key, { reason: r.failed.reason }, failTtlMs); }
    }
    return { ok: false, reason: last?.reason || '没有能下载的地址', ...(last?.tooLarge ? { tooLarge: true } : {}), ...(last?.error ? { error: last.error } : {}), tried };
  }
  return {
    download,
    isBad: (u) => { const b = bad.get(stripRkey(u)); return !!b && b.until > now(); },
    forget: (u) => bad.delete(stripRkey(u)),
  };
}

/**
 * 下载 + 处理一张图（姐姐的唤醒附图和 qq_message_images 用）。
 * ref 来自 segImageRef；getLocalFile(file) 问协议端要本地缓存（拿到 Buffer 或 null）。
 * 返回 viewImage 的结果，失败时 { ok:false, reason }。
 */
export async function fetchImageForView(ref, { downloader, rkeys = [], getLocalFile = null, view = viewImage, viewOptions = {} } = {}) {
  if (!ref) return { ok: false, reason: '没有这张图' };
  let buf = null;
  let reason = '';
  if (ref.urls?.length && downloader) {
    const d = await downloader.download(ref.urls, { rkeys, accept: (b) => !!sniffMime(b) });
    if (d.ok) buf = d.buffer; else reason = d.reason;
  }
  if (!buf && ref.file && getLocalFile) {
    try { buf = await getLocalFile(ref.file); } catch { /* 协议端也没有 */ }
  }
  if (!buf) return { ok: false, reason: reason || 'QQ 那边没给到这张图' };
  if (!sniffMime(buf)) return { ok: false, reason: '这不是能看的图片格式' };
  return view(buf, viewOptions);
}

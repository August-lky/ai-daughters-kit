// 大图先缩小再给她们看（2026-10-25 主人：「给姐姐发了张将近 3MB 的人设图她那边看不到，只能看到[图片]」——
// 原图其实是 8MB 的 PNG：姐姐那边单张超过 4.5MB 就丢，妹妹那边超过 8MB 就丢，都不提示）。
// 超过 maxBytes 的图用本机 ffmpeg 缩到长边 maxSide 以内、透明处垫白、转 JPEG（通常几百 KB）。
// 两个模型自己也会把大图缩到这个量级，看得一样清楚。动图不缩（会丢帧），交给原来的逻辑。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINGET_FFMPEG = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
const FFMPEG = fs.existsSync(WINGET_FFMPEG) ? WINGET_FFMPEG : 'ffmpeg';

export function isAnimated(buf) {
  if (!buf || buf.length < 6) return false;
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return true; // GIF 一律当动图（单帧的也不大）
  // APNG：PNG 里有 acTL 块
  if (buf[0] === 0x89 && buf.subarray(0, 4).toString('latin1') === '\x89PNG') return buf.indexOf('acTL', 8, 'latin1') > 0 && buf.indexOf('acTL', 8, 'latin1') < 4096;
  return false;
}

/** 缩小一张静态图。不需要缩（不超 maxBytes）或缩不了时返回 null，调用方照用原图。 */
export function shrinkImage(buf, { maxBytes = 1.5 * 1024 * 1024, maxSide = 2000, quality = 3, timeoutMs = 30000 } = {}) {
  if (!buf || buf.length <= maxBytes || isAnimated(buf)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const fit = `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
    // 透明背景垫白：先缩，再叠到同尺寸白底上
    const graph = `[0:v]${fit},format=rgba[f];[f]split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay=format=auto,format=yuvj420p`;
    const child = spawn(FFMPEG, ['-v', 'error', '-i', 'pipe:0', '-filter_complex', graph, '-frames:v', '1', '-q:v', String(quality), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true });
    const out = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(out);
      resolve(code === 0 && jpg.length > 1000 && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length < buf.length ? { buffer: jpg, mimeType: 'image/jpeg' } : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

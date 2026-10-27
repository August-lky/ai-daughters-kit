// 把一张很大的设定图做成「全图 + 3×3 高清局部」（2026-10-25 主人：人设图太大，缩小后小字看不清，会影响她们对自己的印象）。
// 模型看图时会把长边缩到约 1500–2000 像素，大图整张给只能看个大概；切成 9 块，每块都在这个尺寸以内，细节原样保留。
// node scripts/make-sheet-tiles.mjs <原图> <输出目录> <全图名> <局部名前缀> <png|jpg> [en|zh]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [src, outDir, overviewName, prefix, fmt = 'png', lang = 'en'] = process.argv.slice(2);
if (!src || !outDir || !overviewName || !prefix) { console.error('用法见文件头'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().split(',').map(Number);
const ext = fmt === 'jpg' ? 'jpg' : 'png';
const q = ext === 'jpg' ? ['-q:v', '2'] : [];
// 透明处垫白（和 image-shrink 一样），再缩 / 裁
const white = (vf) => `${vf},format=rgba[f];[f]split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay=format=auto${ext === 'jpg' ? ',format=yuvj420p' : ''}`;
const run = (vf, out) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-filter_complex', white(`[0:v]${vf}`), '-frames:v', '1', ...q, out], { windowsHide: true });

const overview = path.join(outDir, `${overviewName}.${ext}`);
run(`scale=w='min(2000,iw)':h='min(2000,ih)':force_original_aspect_ratio=decrease`, overview);
const names = lang === 'zh'
  ? [['左上', '上中', '右上'], ['左中', '正中', '右中'], ['左下', '下中', '右下']]
  : [['top-left', 'top', 'top-right'], ['mid-left', 'mid', 'mid-right'], ['bottom-left', 'bottom', 'bottom-right']];
// 每块稍微叠一点边（4%），切线压到的字两边都看得到
const tw = Math.ceil(W / 3), th = Math.ceil(H / 3), padX = Math.round(W * 0.04), padY = Math.round(H * 0.04);
const made = [overview];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
  const x = Math.max(0, c * tw - padX), y = Math.max(0, r * th - padY);
  const w = Math.min(W - x, tw + 2 * padX), h = Math.min(H - y, th + 2 * padY);
  const out = path.join(outDir, `${prefix}${names[r][c]}.${ext}`);
  run(`crop=${w}:${h}:${x}:${y},scale=w='min(2000,iw)':h='min(2000,ih)':force_original_aspect_ratio=decrease`, out);
  made.push(out);
}
for (const f of made) console.log(path.basename(f), `${Math.round(fs.statSync(f).size / 1024)}KB`);

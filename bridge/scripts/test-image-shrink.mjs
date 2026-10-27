// 大图缩小：小图不动、动图不动、大图缩到长边 2000 以内的 JPEG；透明处垫白。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shrinkImage, isAnimated } from '../src/image-shrink.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✅ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });

{
  assert.equal(await shrinkImage(Buffer.alloc(1000, 1)), null, '小图不动');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(3 * 1024 * 1024)]);
  assert.equal(isAnimated(gif), true);
  assert.equal(await shrinkImage(gif), null, '动图不动');
  ok('小图、动图原样不动');
}

{
  // 噪点大 PNG（压不小），带一半透明
  const png = path.join(dir, 'big.png');
  ffmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=3600x2400', '-vf', "format=rgba,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255':a='if(lt(X,1800),0,255)'", '-frames:v', '1', png]);
  const buf = fs.readFileSync(png);
  assert.ok(buf.length > 1.5 * 1024 * 1024, `测试图要够大（${buf.length}）`);
  const s = await shrinkImage(buf);
  assert.ok(s, '大图要缩');
  assert.equal(s.mimeType, 'image/jpeg');
  assert.ok(s.buffer.length < buf.length);
  const out = path.join(dir, 'out.jpg');
  fs.writeFileSync(out, s.buffer);
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().split(',').map(Number);
  assert.deepEqual([w, h], [2000, 1333], '长边缩到 2000，比例不变');
  // 左半边原来透明，应该垫成白色（取左上角一个像素看亮度）
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'crop=2:2:10:10', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  assert.ok(px[0] > 230, `透明处垫白（亮度 ${px[0]}）`);
  ok(`大图缩到 ${w}×${h} JPEG（${Math.round(buf.length / 1024)}KB → ${Math.round(s.buffer.length / 1024)}KB），透明处垫白`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`全部通过：${passed} 组`);

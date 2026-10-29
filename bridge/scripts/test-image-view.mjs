// 共用看图（2026-10-29 大整理第二批）：动图从头到尾均匀抽帧拼图、数不出帧也能抽、抽帧失败只取首帧、
// 静态大图缩到长边 1600、实在压不下说看不清；下载器太大第一次就放弃、失败的地址短时间不再试；
// 市场表情没 url 时按 emoji_id 拼 CDN 地址。不连网、不碰活的东西；没有 ffmpeg 时跳过要 ffmpeg 的几组并说明。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  viewImage, countFrames, pickFrameIndexes, sheetLayout, imageSize, sniffMime, stripRkey, imageKey, segImageRef,
  createImageDownloader, fetchImageForView, emojiCdnCandidates, TOO_BIG_TEXT, VIEW_MAX_BYTES, DEFAULT_FFMPEG
} from '../src/image-view.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };

// ── 纯函数 ──
{
  assert.deepEqual(pickFrameIndexes(60, 6), [0, 12, 24, 35, 47, 59], '60 帧均匀取 6 帧，含首尾');
  assert.deepEqual(pickFrameIndexes(5, 6), [0, 1, 2, 3, 4]);
  assert.deepEqual(pickFrameIndexes(0, 6), []);
  assert.deepEqual(sheetLayout(2), { cols: 2, rows: 1 });
  assert.deepEqual(sheetLayout(4), { cols: 2, rows: 2 });
  assert.deepEqual(sheetLayout(6), { cols: 3, rows: 2 });
  ok('均匀取帧覆盖整段（含第一帧和最后一帧），拼图排法');
}
{
  const u = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC&rkey=SECRET1';
  assert.equal(stripRkey(u), 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC');
  assert.equal(imageKey({ url: u }), imageKey({ url: u.replace('SECRET1', 'OTHER2') }), '换了 rkey 还是同一张图');
  assert.equal(imageKey({ file: 'ABCDEF0123456789ABCDEF0123456789.jpg', url: u }), 'f:abcdef0123456789abcdef0123456789.jpg', '有摘要式文件名按文件名');
  assert.equal(imageKey({ emojiId: 'F96BF2D2D93C3530D5EB148F55206FB1' }), 'e:f96bf2d2d93c3530d5eb148f55206fb1');
  ok('图片 key：去掉 rkey 的地址 / 文件名 / emoji_id');
}
{
  const id = 'f96bf2d2d93c3530d5eb148f55206fb1';
  const r = segImageRef({ type: 'mface', data: { emoji_id: id, emoji_package_id: '1', summary: '[糖]' } });
  assert.ok(r, '市场表情没 url 也没 file，不能被滤掉');
  assert.deepEqual(r.urls, emojiCdnCandidates(id), '按 emoji_id 拼 CDN 地址');
  assert.equal(r.sticker, true);
  const byFile = segImageRef({ type: 'image', data: { file: `f9-${id}.gif`, sub_type: 1 } });
  assert.deepEqual(byFile.urls, emojiCdnCandidates(id), '文件名里嵌着 emoji_id 也能推出 CDN');
  assert.equal(segImageRef({ type: 'mface', data: { summary: '[糖]' } }), null, '什么地址都没有才不要');
  assert.equal(segImageRef({ type: 'text', data: { text: 'x' } }), null);
  assert.deepEqual(segImageRef({ type: 'image', data: { url: 'https://x/a.jpg', file: 'a.jpg' } }).urls, ['https://x/a.jpg']);
  ok('消息段 → 下载地址：市场表情走 CDN 兜底');
}

// ── 下载器 ──
{
  const calls = [];
  const big = Object.assign(new Error('图片超过大小限制（100 字节）'), { code: 'TOO_LARGE' });
  let t = 1000;
  const d = createImageDownloader({ fetchBuffer: async (u) => { calls.push(u); throw big; }, maxBytes: 100, now: () => t });
  const r1 = await d.download(['https://img.example/a.gif'], { rkeys: ['&rkey=1', '&rkey=2', '&rkey=3'] });
  assert.equal(r1.ok, false);
  assert.equal(r1.tooLarge, true);
  assert.equal(calls.length, 1, '太大：第一次就放弃，不按每个 rkey 重下');
  const r2 = await d.download(['https://img.example/a.gif&rkey=9'], { rkeys: ['&rkey=1'] });
  assert.equal(calls.length, 1, '同一张（换了 rkey）短时间内不再下');
  assert.equal(r2.tooLarge, true);
  assert.match(r2.reason, /太大/);
  t += 11 * 60e3;
  await d.download(['https://img.example/a.gif']);
  assert.equal(calls.length, 2, '过了 10 分钟可以再试');
  ok('下载器：超过大小上限第一次就放弃、记住不再重试');
}
{
  const calls = [];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const d = createImageDownloader({
    fetchBuffer: async (u) => {
      calls.push(u);
      if (u.startsWith('https://slow.example')) throw new Error('请求超时：slow.example');
      if (u.includes('rkey=2')) return { buffer: png };
      throw new Error('图片抓取失败：HTTP 400');
    }
  });
  const slow = await d.download(['https://slow.example/x', 'https://cdn.example/y'], { rkeys: ['&rkey=1', '&rkey=2'] });
  assert.equal(slow.ok, true, '第一个地址超时后换备用地址');
  assert.deepEqual(calls, ['https://slow.example/x', 'https://cdn.example/y', 'https://cdn.example/y&rkey=1', 'https://cdn.example/y&rkey=2'], '超时的地址不再试别的 rkey；400 照常换下一个 rkey');
  calls.length = 0;
  const again = await d.download(['https://slow.example/x']);
  assert.equal(calls.length, 0, '刚超时的地址 2 分钟内不再试');
  assert.equal(again.reason, '下载超时了');
  ok('下载器：超时的地址跳过其余 rkey、换备用地址；短时间不重试');
}
{
  const local = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
  const d = createImageDownloader({ fetchBuffer: async () => { throw new Error('网络不可用'); } });
  const r = await fetchImageForView({ urls: ['https://x.example/a'], file: 'a.gif' }, { downloader: d, getLocalFile: async () => local });
  assert.equal(r.ok, true, '下载不了就问协议端要本地缓存');
  const r2 = await fetchImageForView({ urls: ['https://x.example/b'], file: '' }, { downloader: d });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /没成功|过期/);
  ok('下载 + 看图：下载失败退到本地缓存；都没有就给原因');
}

// ── 要 ffmpeg 的几组 ──
let hasFfmpeg = true;
try { execFileSync(DEFAULT_FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true }); } catch { hasFfmpeg = false; }
if (!hasFfmpeg) {
  console.log('⚠ 这台机器找不到 ffmpeg，跳过抽帧 / 缩图那几组（不算失败）');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-view-'));
  const ff = (args) => execFileSync(DEFAULT_FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true });
  // 60 帧、12 秒的 GIF：第 n 帧亮度 = 4n（越往后越亮），用来看抽到的是不是整段
  const gifPath = path.join(dir, 'ramp.gif');
  ff(['-f', 'lavfi', '-i', "nullsrc=s=64x64:r=5:d=12,geq=lum='N*4':cb=128:cr=128", gifPath]);
  const gif = fs.readFileSync(gifPath);
  const cellLum = (jpg, col, row) => {
    const f = path.join(dir, `cell-${col}-${row}.jpg`);
    fs.writeFileSync(f, jpg);
    const px = execFileSync(DEFAULT_FFMPEG, ['-v', 'error', '-i', f, '-vf', `crop=4:4:${col * 324 + 158}:${row * 324 + 158}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true });
    return px[0];
  };
  {
    assert.deepEqual(countFrames(gif), { frames: 60, durationMs: 12000 });
    const r = await viewImage(gif);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'sheet');
    assert.equal(r.frames, 6);
    assert.equal(sniffMime(r.buffer), 'image/jpeg');
    assert.deepEqual(imageSize(r.buffer), { width: 3 * 320 + 2 * 4, height: 2 * 320 + 4 }, '3×2，每帧 320');
    const first = cellLum(r.buffer, 0, 0), last = cellLum(r.buffer, 2, 1);
    assert.ok(first < 30, `第一格是开头（亮度 ${first}）`);
    assert.ok(last > 200, `最后一格是结尾（亮度 ${last}），不是只抽了前 3 秒`);
    assert.match(r.note, /6 帧/);
    ok(`动图从头到尾抽 6 帧拼成 3×2（首格亮度 ${first}，末格 ${last}）`);
  }
  {
    const r = await viewImage(gif, { count: () => null });
    assert.equal(r.kind, 'sheet', '文件头数不出帧时用 ffprobe 数');
    const last = cellLum(r.buffer, 2, 1);
    assert.ok(last > 200, `探不到帧数也覆盖到结尾（末格亮度 ${last}）`);
    ok('数不出帧数时改用 ffprobe 数，照样覆盖整段');
  }
  {
    const r = await viewImage(gif, { makeSheetImpl: async () => null });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'first-frame', '抽帧失败只取首帧');
    assert.equal(sniffMime(r.buffer), 'image/jpeg', '首帧转成 JPEG，不是把 GIF 当 jpg 压');
    assert.match(r.note, /第一帧/);
    ok('抽帧失败：只取第一帧再缩，并且说一声');
  }
  {
    const png = path.join(dir, 'big.png');
    ff(['-f', 'lavfi', '-i', 'nullsrc=s=3600x2400', '-vf', "format=rgb24,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'", '-frames:v', '1', png]);
    const buf = fs.readFileSync(png);
    assert.ok(buf.length > VIEW_MAX_BYTES, `测试图要比上限大（${buf.length}）`);
    const r = await viewImage(buf);
    assert.equal(r.kind, 'shrunk');
    assert.deepEqual(imageSize(r.buffer), { width: 1600, height: 1067 }, '长边缩到 1600');
    assert.ok(r.buffer.length < VIEW_MAX_BYTES && Math.ceil(r.buffer.length / 3) * 4 < 5 * 1024 * 1024, '结果 < 3.5MB，base64 后 < 5MB');
    const tooBig = await viewImage(buf, { maxBytes: 2000 });
    assert.deepEqual(tooBig, { ok: false, reason: TOO_BIG_TEXT }, '实在压不下就说看不清，不原样交出');
    ok(`静态大图 ${Math.round(buf.length / 1024 / 1024)}MB → ${Math.round(r.buffer.length / 1024)}KB（1600×1067）；压不下说「${TOO_BIG_TEXT}」`);
  }
  {
    const r = await viewImage(gif, { ffmpeg: path.join(dir, 'no-such-ffmpeg.exe') });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'original', 'ffmpeg 不在：小动图原样给（模型能看第一帧）');
    assert.match(r.note, /第一帧/);
    const bigGif = Buffer.concat([gif, Buffer.alloc(4 * 1024 * 1024)]);
    const r2 = await viewImage(bigGif, { ffmpeg: path.join(dir, 'no-such-ffmpeg.exe') });
    assert.deepEqual(r2, { ok: false, reason: TOO_BIG_TEXT }, 'ffmpeg 不在又太大：不原样交出');
    ok('ffmpeg 不可用时：小的原样给并说明，大的说看不清');
  }
  {
    const r = await viewImage(Buffer.from('<html>not an image</html>'));
    assert.equal(r.ok, false);
    const small = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
    const r2 = await viewImage(small);
    assert.equal(r2.kind, 'original', '单帧小 GIF 原样给');
    ok('不是图片给原因；单帧小图原样');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`全部通过：${passed} 组`);

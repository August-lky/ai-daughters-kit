// 小鲸鱼看图走共用模块（2026-10-29 大整理第二批）：工具取图和内联路径的动图都抽帧拼图；
// 太大的图第一次就放弃、不按每个 rkey 重下；取不到时写明原因。真桥接代码跑在隔离测试桩里，不碰活的 QQ / DSH / 配置。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DEFAULT_FFMPEG } from '../src/image-view.js';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests += 1;
  try { await run(); console.log('PASS', name); } catch (error) { failures += 1; console.error('FAIL', name, error.stack); }
}

let gif = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-view-'));
  const f = path.join(dir, 'ramp.gif');
  execFileSync(DEFAULT_FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=64x64:r=5:d=12,geq=lum='N*4':cb=128:cr=128", f], { windowsHide: true });
  gif = fs.readFileSync(f);
  fs.rmSync(dir, { recursive: true, force: true });
} catch { console.log('⚠ 找不到 ffmpeg，跳过动图那两组（不算失败）'); }

const STICKER = 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif';

if (gif) {
  await test('工具取图（fetchMediaData）：动图从头到尾抽帧拼图', async () => {
    const h = await bridgeHarness({ globals: { safeFetchBuffer: async () => ({ buffer: gif }) } });
    try {
      const out = await h.fetchMediaData([{ kind: 'sticker', url: STICKER, summary: '[动]' }]);
      assert.equal(out[0].mimeType, 'image/jpeg');
      assert.match(out[0].text, /动图：从头到尾均匀抽了 6 帧/);
      assert.ok(Buffer.from(out[0].data, 'base64').length < 3.5 * 1024 * 1024);
    } finally { await h.close(); }
  });
  await test('内联路径（resolveMediaList）：表情 / 动图也抽帧，不再原样塞进去', async () => {
    const h = await bridgeHarness({ globals: { safeFetchBuffer: async () => ({ buffer: gif }) } });
    try {
      const parts = await h.resolveMediaList([{ kind: 'sticker', url: STICKER, summary: '动' }]);
      const img = parts.find((p) => p.type === 'image');
      assert.equal(img?.mediaType, 'image/jpeg', '动图换成了拼图');
      assert.match(parts.find((p) => p.type === 'text').text, /\[表情:动\]（动图/);
    } finally { await h.close(); }
  });
}

await test('太大的图：第一次就放弃，不按每个 rkey 重下；写明是太大了', async () => {
  const calls = [];
  const h = await bridgeHarness({ globals: { safeFetchBuffer: async (u) => { calls.push(u); throw Object.assign(new Error('图片超过大小限制（20971520 字节）'), { code: 'TOO_LARGE' }); } } });
  try {
    h.bot.call = async (action) => (action === 'get_rkey' ? [{ rkey: '&rkey=a' }, { rkey: '&rkey=b' }, { rkey: '&rkey=c' }] : null);
    const out = await h.fetchMediaData([{ kind: 'sticker', url: STICKER }]);
    assert.equal(calls.length, 1, `只下了一次（实际 ${calls.length} 次）`);
    assert.match(out[0].text, /太大/);
    assert.equal(out[0].failed, true);
    assert.equal(out[0].data, undefined);
    // 同一张再看：10 分钟内不再下
    await h.fetchMediaData([{ kind: 'sticker', url: STICKER }]);
    assert.equal(calls.length, 1);
  } finally { await h.close(); }
});

await test('取不到的图：带上原因，不再只写「获取失败」', async () => {
  const h = await bridgeHarness({ globals: { safeFetchBuffer: async () => { throw new Error('请求超时：gxh.vip.qq.com'); } } });
  try {
    const out = await h.fetchMediaData([{ kind: 'sticker', url: STICKER }]);
    assert.match(out[0].text, /表情获取失败：下载超时了/);
    const parts = await h.resolveMediaList([{ kind: 'sticker', url: STICKER, summary: '糖' }]);
    assert.match(parts[0].text, /获取失败：下载超时了/);
  } finally { await h.close(); }
});

console.log(`Bridge image view: ${tests - failures}/${tests} passed.`);
if (failures) process.exitCode = 1;

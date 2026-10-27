// 大肥鱼表情包（2026-10-24）：目录、搜索、按名字找、取图（哈希校验 + 缓存）、桥接与工具接线。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { loadFishCatalog, findFish, searchFish, describeFish, fishLabel, fishUrl, getFishGif } from '../src/fish-stickers.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const catalog = loadFishCatalog(new URL('../assets/fish-stickers/catalog.json', import.meta.url));

assert.equal(catalog.stickers.length, 322);
assert.match(catalog.attribution, /可以叫我云大人/);
assert.match(catalog.license, /CC BY-NC/);
ok('目录 322 张，带署名和许可');

assert.equal(findFish(catalog, '鱼:猫猫搓手').sticker.code, '10N01_猫猫搓手');
assert.equal(findFish(catalog, '鱼：10N01').sticker.code, '10N01_猫猫搓手');
assert.equal(findFish(catalog, '大肥鱼/10N01_猫猫搓手').sticker.code, '10N01_猫猫搓手');
assert.ok(findFish(catalog, '鱼:好吃').ambiguous.length === 2, '同名两张要她挑编号');
assert.equal(findFish(catalog, '摸摸头不存在的'), null);
assert.equal(findFish(catalog, ''), null);
ok('按名字 / 编号 / 全称找，同名的报出来让她选');

const confused = searchFish(catalog, '疑惑 没听懂');
assert.ok(confused.length > 0 && confused.every((s) => s.emotion === '疑惑' || s.tags.some((t) => t.includes('没听懂') || t.includes('疑惑')) || s.use.includes('没听懂') || s.desc.includes('疑惑')));
assert.equal(confused[0].emotion, '疑惑');
assert.ok(searchFish(catalog, '刚睡醒').some((s) => s.name === '苏醒'));
assert.ok(searchFish(catalog, '', { limit: 40 }).length >= 20, '不写词就每种情绪给一张');
assert.ok(searchFish(catalog, '喂药', { pack: '大肥鱼和GPT娘' }).every((s) => s.pack === '大肥鱼和GPT娘'));
assert.equal(searchFish(catalog, 'zzzz不可能有的词').length, 0);
ok('按心情 / 场景搜，能限单人双人');

const line = describeFish(findFish(catalog, '鱼:2TT01').sticker);
assert.match(line, /^鱼:喝药（2TT01）｜搞怪｜大肥鱼→GPT娘｜用在：/);
assert.equal(fishLabel({ name: '', code: 'X1' }), '鱼:X1');
assert.match(fishUrl(catalog, findFish(catalog, '鱼:10N01').sticker), /^https:\/\/kiriyuki\.com\/media\/gif\/%E5%A4%A7%E8%82%A5%E9%B1%BC\/10N01_.*\.gif\?h=4a44767ab58b$/);
ok('给她看的一行写明谁对谁；下载地址按清单拼');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-'));
  const buf = Buffer.from('GIF89a假的图');
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const s = { code: 'T1_测试', pack: '大肥鱼', file: 'T1_测试.gif', hash };
  let calls = 0;
  const fetchBuffer = async () => { calls += 1; return { buffer: buf }; };
  const a = await getFishGif(catalog, s, { cacheDir: dir, fetchBuffer, maxBytes: 1e6 });
  assert.equal(a.cached, false);
  const b = await getFishGif(catalog, s, { cacheDir: dir, fetchBuffer, maxBytes: 1e6 });
  assert.equal(b.cached, true); assert.equal(calls, 1, '第二次用缓存，不再下载');
  await assert.rejects(getFishGif(catalog, { ...s, hash: '000000000000' }, { cacheDir: dir, fetchBuffer, maxBytes: 1e6 }), /对不上/);
  assert.ok(!fs.existsSync(path.join(dir, '000000000000.gif')), '对不上的不落盘');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('取图：第一次下、校验哈希、缓存；对不上的不收');
}

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
assert.match(src, /const fish = findFish\(fishCatalogV2\(\), stickerRef\);/);
assert.match(src, /if \(fish\?\.sticker\) return sendFishStickerV2\(key, fish\.sticker, options, assertSendAllowed\);/);
assert.match(src, /sub_type: 1, summary: '\[动画表情\]'/);
assert.match(src, /url\.pathname === '\/api\/socialV2\/fish-stickers'/);
assert.match(src, /\$\{fishStickerHintV2\(\)\}/);
const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
assert.match(mcp, /'qq_fish_sticker',/);
assert.match(mcp, /qq_fish_sticker: 'listStickers'/);
ok('接线：收藏里找不到才看大肥鱼；以表情样子发；搜索接口、提示词、工具都在');

console.log(`全部通过：${passed} 组`);

// 离线测试：推荐流 / 详情 JSON 的被动解析与缓存合并，以及转写结果裁剪。
// 运行：node scripts/test-audio-feed-cache.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAwemePayload, rememberAweme, lookupAweme, mergeAwemeInfo, trimAudioResult } from '../core.mjs';

const feed = {
  status_code: 0,
  aweme_list: [
    { aweme_id: '7675682940059208995', desc: '盘点那些术力口惨案  #二次元 #初音未来', music: { id: 1, title: '千本樱', author: '黒うさP', play_url: { uri: 'x' } }, video: { play_addr: { url_list: ['https://example.invalid/not-used'] }, subtitle: 'OCR 字幕一行' } },
    { aweme_id: 123, desc: 'short id ignored' },
    { aweme_id: '7675682940059208996', desc: '   多  空格   文案   ', music: { title: '', author: '' }, caption: '这是 caption 字段', ocr_content: [{ text: '第一行' }, { text: '第二行' }] },
    null, 'junk', { aweme_id: '7675682940059208997' },
  ],
};

test('parseAwemePayload: feed list', () => {
  const items = parseAwemePayload(feed);
  assert.deepEqual(items.map(i => i.id), ['7675682940059208995', '7675682940059208996', '7675682940059208997']);
  assert.equal(items[0].desc, '盘点那些术力口惨案 #二次元 #初音未来');
  assert.deepEqual(items[0].music, { title: '千本樱', author: '黒うさP' });
  assert.deepEqual(items[0].captions, { subtitle: 'OCR 字幕一行' });
  assert.equal(items[1].desc, '多 空格 文案');
  assert.equal(items[1].music, null, '空音乐信息不保留');
  assert.deepEqual(items[1].captions, { caption: '这是 caption 字段', ocr_content: '第一行 第二行' });
  assert.equal(items[2].desc, null);
  assert.equal('captions' in items[2], false);
  assert.equal(JSON.stringify(items).includes('example.invalid'), false, '不保留任何 play_addr');
});

test('parseAwemePayload: detail + garbage', () => {
  assert.deepEqual(parseAwemePayload({ aweme_detail: { aweme_id: '7675682940059208999', desc: 'd', music: { author: '某歌手' } } }).map(i => [i.id, i.desc, i.music]), [['7675682940059208999', 'd', { title: null, author: '某歌手' }]]);
  for (const bad of [null, undefined, 1, 'x', [], {}, { aweme_list: 'nope' }, { aweme_detail: 'nope' }]) assert.deepEqual(parseAwemePayload(bad), []);
});

test('rememberAweme caps the cache and keeps latest', () => {
  const cache = new Map();
  for (let i = 0; i < 250; i++) rememberAweme(cache, { id: String(7000000000000000000n + BigInt(i)), desc: `d${i}` });
  assert.equal(cache.size, 200);
  assert.equal(cache.has('7000000000000000000'), false);
  assert.equal(cache.has('7000000000000000249'), true);
  rememberAweme(cache, { id: '7000000000000000100', desc: 'updated' });
  assert.equal(cache.size, 200);
  assert.equal(cache.get('7000000000000000100').desc, 'updated');
  rememberAweme(cache, null); rememberAweme(cache, {});
  assert.equal(cache.size, 200);
});

test('lookupAweme by id, by title prefix, and miss', () => {
  const cache = new Map();
  for (const item of parseAwemePayload(feed)) rememberAweme(cache, item);
  assert.equal(lookupAweme(cache, { id: '7675682940059208995' }).matchedBy, 'id');
  assert.equal(lookupAweme(cache, { id: null, title: '盘点那些术力口惨案 #二次元 #初音未来 - 抖音' }).matchedBy, 'title');
  assert.equal(lookupAweme(cache, { id: null, title: '盘点' }), null, '太短的标题不做前缀匹配');
  assert.equal(lookupAweme(cache, { id: '1', title: '完全不相关的标题文字' }), null);
  assert.equal(lookupAweme(new Map(), { id: '7675682940059208995' }), null);
  assert.equal(lookupAweme(undefined, { id: '7675682940059208995' }), null);
});

test('mergeAwemeInfo adds desc/music/captions to state.video', () => {
  const cache = new Map();
  for (const item of parseAwemePayload(feed)) rememberAweme(cache, item);
  const state = { video: { id: '7675682940059208995', title: 'x' } };
  mergeAwemeInfo(state, cache);
  assert.equal(state.video.desc, '盘点那些术力口惨案 #二次元 #初音未来');
  assert.deepEqual(state.video.music, { title: '千本樱', author: '黒うさP' });
  assert.equal(state.video.infoMatchedBy, 'id');
  const untouched = { video: { id: '1', title: 'nothing' } };
  mergeAwemeInfo(untouched, cache);
  assert.deepEqual(untouched, { video: { id: '1', title: 'nothing' } });
  assert.deepEqual(mergeAwemeInfo({ video: null }, cache), { video: null });
  assert.equal(mergeAwemeInfo(null, cache), null);
});

test('trimAudioResult shapes', () => {
  assert.deepEqual(trimAudioResult({ ok: true, text: ' a  b ', language: 'zh', segments: [{ relativeStart: 0.04, relativeEnd: 1.26, start: 5.04, end: 6.26, text: ' hi ' }, { text: '' }, null] }), { text: 'a b', language: 'zh', segments: [{ start: 0, end: 1.3, text: 'hi' }] });
  assert.deepEqual(trimAudioResult({ ok: true, text: '', silent: true, segments: [] }), { text: '', language: null, segments: [], silent: true });
  assert.deepEqual(trimAudioResult({ ok: false, status: 'disabled', error: '媒体能力当前关闭' }), { text: '', error: '媒体能力当前关闭' });
  assert.deepEqual(trimAudioResult(null), { text: '', error: 'transcribe-failed' });
  assert.equal(trimAudioResult({ ok: true, text: 'x'.repeat(5000) }).text.length, 1500);
});

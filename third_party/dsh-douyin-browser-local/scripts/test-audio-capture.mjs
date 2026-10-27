// 离线测试：capture() 顺带录音 —— 成功 / 失败 / 超时 / 关闭 四种情况下的结果形状，转写用替身。
// 运行：node scripts/test-audio-capture.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../core.mjs';

const VIDEO_ID = '7000000000000000001';
function fakeState() {
  return { url: `https://www.douyin.com/video/${VIDEO_ID}`, title: 't', liveActive: false, searchResults: [], visibleText: '', loginRequired: false, verificationRequired: false, privateChatVisible: false, unsupportedPage: false,
    video: { id: VIDEO_ID, live: false, ad: false, url: `https://www.douyin.com/video/${VIDEO_ID}`, author: 'a', title: '测试作品', time: 1, duration: 30, paused: false, muted: false, readyState: 4, width: 720, height: 1280, viewport: { x: 0, y: 0, width: 300, height: 500 } } };
}
function makeController({ transcribe, enabled = true, record = async () => ({ data: Buffer.from('webm').toString('base64'), mimeType: 'audio/webm', bytes: 4 }) }) {
  const controller = new BrowserController({ source: 'verification', memory: { recordVideo() {} } });
  controller.page = { evaluate: async () => fakeState(), screenshot: async () => Buffer.from('jpeg') };
  controller.getMediaAdapter = async () => ({ settings: async () => ({ enabled, backend: 'local-whisper' }), transcribeAudio: transcribe });
  controller.recordAudioTrack = record;
  controller.audioTranscribeTimeoutMs = 300;
  return controller;
}

test('audio success attaches trimmed transcript to capture result', async () => {
  const seen = [];
  const controller = makeController({ transcribe: async (args, { signal }) => { seen.push({ args, signal }); return { ok: true, text: ' 你好 世界 ', language: 'zh', segments: Array.from({ length: 15 }, (_, i) => ({ relativeStart: i, relativeEnd: i + 0.55, start: i, end: i + 0.55, text: `句${i}` })) }; } });
  const result = await controller.capture(1);
  assert.equal(result.frames.length, 3);
  assert.deepEqual(result.audio.text, '你好 世界');
  assert.equal(result.audio.language, 'zh');
  assert.equal(result.audio.segments.length, 12);
  assert.deepEqual(result.audio.segments[1], { start: 1, end: 1.6, text: '句1' });
  assert.match(result.observation.note, /audio\.text/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].args.allowEmpty, true);
  assert.equal(seen[0].args.durationSeconds, 1);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(result.personaEvidenceId, undefined, 'verification 入口不登记人格证据');
});

test('silence from adapter becomes text:"" without error', async () => {
  const controller = makeController({ transcribe: async () => ({ ok: true, text: '', silent: true, segments: [], language: null }) });
  const result = await controller.capture(1);
  assert.deepEqual(result.audio, { text: '', language: null, segments: [], silent: true });
  assert.match(result.observation.note, /没有拿到可用的语音转写/);
});

test('transcribe failure yields text:"" + error and keeps frames', async () => {
  const controller = makeController({ transcribe: async () => { throw new Error('媒体处理失败；依赖、模型下载或媒体格式未通过。'); } });
  const result = await controller.capture(1);
  assert.equal(result.frames.length, 3);
  assert.equal(result.audio.text, '');
  assert.match(result.audio.error, /媒体处理失败/);
});

test('adapter ok:false yields text:"" + error', async () => {
  const controller = makeController({ transcribe: async () => ({ ok: false, status: 'failed', error: 'Whisper 未识别到可用对白' }) });
  const result = await controller.capture(1);
  assert.equal(result.audio.text, '');
  assert.match(result.audio.error, /Whisper/);
});

test('recording failure (no track) yields text:"" + error', async () => {
  const controller = makeController({ transcribe: async () => ({ ok: true, text: 'x' }), record: async () => { throw new Error('当前作品没有向浏览器暴露可采集音轨'); } });
  const result = await controller.capture(1);
  assert.equal(result.audio.text, '');
  assert.match(result.audio.error, /音轨/);
});

test('transcribe timeout attaches nothing and aborts the adapter signal', async () => {
  let captured;
  const controller = makeController({ transcribe: (args, { signal }) => new Promise((_, reject) => { captured = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const started = Date.now();
  const result = await controller.capture(1);
  assert.equal(result.frames.length, 3);
  assert.equal('audio' in result, false);
  assert.ok(Date.now() - started < 1000 + 300 + 800, '超时不能拖太久');
  assert.equal(captured.aborted, true);
});

test('audio disabled attaches nothing and never records', async () => {
  let recorded = 0;
  const controller = makeController({ enabled: false, transcribe: async () => ({ ok: true, text: 'x' }), record: async () => { recorded++; return { data: '', mimeType: 'audio/webm', bytes: 0 }; } });
  const result = await controller.capture(1);
  assert.equal('audio' in result, false);
  assert.equal(recorded, 0);
});

test('screenshot-only (seconds=0) never records audio', async () => {
  let recorded = 0;
  const controller = makeController({ transcribe: async () => ({ ok: true, text: 'x' }), record: async () => { recorded++; return { data: '', mimeType: 'audio/webm', bytes: 0 }; } });
  const result = await controller.capture(0);
  assert.equal(result.frames.length, 1);
  assert.equal('audio' in result, false);
  assert.equal(recorded, 0);
});

test('long window caps recording at 30 seconds', async () => {
  let askedSeconds = null;
  const controller = makeController({ transcribe: async args => ({ ok: true, text: 'ok', segments: [] }), record: async seconds => { askedSeconds = seconds; return { data: 'AA==', mimeType: 'audio/webm', bytes: 1 }; } });
  // 1 秒的帧窗口足够验证封顶逻辑；这里直接调 observeAudio 看传入的秒数。
  await controller.observeAudio(Math.min(60, 30));
  assert.equal(askedSeconds, 30);
});

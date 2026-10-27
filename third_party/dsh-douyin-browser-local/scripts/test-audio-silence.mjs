// 离线测试：MediaAdapter 本地 Whisper 路线的静音处理。
// 用真实 ffmpeg/ffprobe + 真实 local_whisper.py，但通过 PYTHONPATH 注入一个"识别不到任何片段"的替身 faster_whisper，
// 不需要已安装的依赖或模型。运行：node scripts/test-audio-silence.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MediaAdapter } from '../media/index.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-audio-test-'));
const fakeModule = path.join(temp, 'pypath', 'faster_whisper');
fs.mkdirSync(fakeModule, { recursive: true });
fs.writeFileSync(path.join(fakeModule, '__init__.py'), `import os, json
class _Info:
    language = 'zh'
    language_probability = 0.5
class WhisperModel:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs
    def transcribe(self, path, **kwargs):
        with open(os.environ['FAKE_WHISPER_LOG'], 'a', encoding='utf-8') as f:
            f.write(json.dumps({'cpu_threads': self.kwargs.get('cpu_threads'), 'compute_type': self.kwargs.get('compute_type')}) + '\\n')
        return iter(()), _Info()
`);
const silent = path.join(temp, 'silent.webm');
execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:a', 'libopus', silent]);
const settingsFile = path.join(temp, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ enabled: true, backend: 'local-whisper' }));
const python = ['C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe', 'python'].find(p => { try { execFileSync(p, ['-c', 'pass'], { stdio: 'ignore' }); return true; } catch { return false; } });
const log = path.join(temp, 'fake.log');
process.env.PYTHONPATH = path.join(temp, 'pypath');
process.env.FAKE_WHISPER_LOG = log;
const adapter = new MediaAdapter({ settingsFile, config: { DOUYIN_MEDIA_WHISPER_MODEL: 'small' }, python });

test('silence with allowEmpty:true -> ok:true, text:"", silent:true', async () => {
  const result = await adapter.transcribeAudio({ source: silent, backend: 'local-whisper', durationSeconds: 2, allowEmpty: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, '');
  assert.equal(result.silent, true);
  assert.deepEqual(result.segments, []);
  assert.ok(result.limitations.some(item => /没有识别到对白/.test(item)));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.at(-1), { cpu_threads: 4, compute_type: 'int8' });
});

test('silence without allowEmpty keeps the original failure (douyin_listen path)', async () => {
  const result = await adapter.transcribeAudio({ source: silent, backend: 'local-whisper', durationSeconds: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /未识别到可用对白/);
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });

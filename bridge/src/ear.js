// 「耳朵」（2026-10-25 主人：「想让她们『听到』旋律、视频里的声音」）。
// 两个模型都只能读文字，声音到不了她们那里。抖音插件里已经有一副本地耳朵（sherpa-onnx：SenseVoice 听人声和笑声掌声这类事件，
// CED-small + librosa 听曲风、乐器、情绪、男女声、节奏、调性、哪里变响、人声音域和走向）。这里把它借出来给别处用：
// 给一个音频 / 视频文件，返回一段文字描述。全在本机 CPU 上跑，不占显卡，不往外发任何东西。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MEDIA = path.join(os.homedir(), '.dsh', 'profiles', 'tauri', 'node_modules', 'dsh-douyin-browser-local', 'media');
const PY = path.join(MEDIA, '.venv', 'Scripts', 'python.exe');
const MODELS = path.join(MEDIA, '.models');
const WINGET_FFMPEG = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
const FFMPEG = fs.existsSync(WINGET_FFMPEG) ? WINGET_FFMPEG : 'ffmpeg';

export function earAvailable() {
  return fs.existsSync(PY) && fs.existsSync(path.join(MEDIA, 'local_sensevoice.py')) && fs.existsSync(path.join(MEDIA, 'local_music.py'));
}

function runPyJson(script, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [path.join(MEDIA, script)], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } reject(new Error(`${script} 超时`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${script} 退出码 ${code}：${err.slice(-200)}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new Error(`${script} 输出看不懂`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function toWav(file, wav, { start = 0, seconds = 120 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-v', 'error', '-y', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
      { windowsHide: true, timeout: 60000 }, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * 听一段：返回 { speech: {text, events}, music: {isMusic, description, ...} }，哪边失败那边就是 null。
 * start / seconds：从第几秒开始听多久（默认开头 2 分钟；配乐分析只看其中前 60 秒）。
 */
export async function hear(file, { start = 0, seconds = 120 } = {}) {
  if (!earAvailable()) throw new Error('耳朵没装好（抖音插件的本地音频环境不在）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ear-'));
  const wav = path.join(dir, 'a.wav');
  try {
    await toWav(file, wav, { start, seconds });
    if (!fs.existsSync(wav) || fs.statSync(wav).size < 16000) throw new Error('这段没有声音');
    const [speech, music] = await Promise.all([
      runPyJson('local_sensevoice.py', { path: wav, language: 'auto', modelsDir: MODELS, cpuThreads: 4 }, 120000).catch(() => null),
      runPyJson('local_music.py', { path: wav, modelsDir: MODELS }, 90000).catch(() => null)
    ]);
    return { speech, music };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时文件删不掉不要紧 */ }
  }
}

// ── QQ 语音（2026-10-25：姐姐第一次发语音，小鲸鱼那边收到只有「[语音]」，「连字都没有，那种是真的听不见」）──
// QQ 语音是腾讯的 SILK 格式，ffmpeg 解不了，用 silk-wasm 解成 PCM 再交给耳朵。同一条只听一次（按文件名缓存）。
const heardCache = new Map();

async function readRecordBytes(data) {
  const src = String(data?.url || '');
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`下载语音 HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (src && fs.existsSync(src)) return fs.readFileSync(src);
  throw new Error('拿不到语音文件');
}

async function hearRecordNow(data) {
  const buf = await readRecordBytes(data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ear-qq-'));
  try {
    const { isSilk, decode } = await import('silk-wasm');
    let file, seconds = null;
    if (isSilk(buf)) {
      const pcm = await decode(buf, 24000);
      seconds = Math.round(pcm.duration / 1000);
      const raw = path.join(dir, 'v.pcm');
      fs.writeFileSync(raw, Buffer.from(pcm.data));
      file = path.join(dir, 'v.wav');
      await new Promise((resolve, reject) => execFile(FFMPEG, ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, file],
        { windowsHide: true, timeout: 30000 }, (e) => (e ? reject(e) : resolve())));
    } else {
      file = path.join(dir, 'v.bin');
      fs.writeFileSync(file, buf);
    }
    return { heard: await hear(file, { seconds: 180 }), seconds };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不要紧 */ }
  }
}

/** 一条 QQ 语音段（record 的 data）→「[语音 7秒：「……」]」这样一句；听不了就退回「[语音]」。最多等 timeoutMs。 */
export async function hearQqRecord(data, { timeoutMs = 40000 } = {}) {
  const key = String(data?.file || data?.url || '');
  if (!key || !earAvailable()) return '[语音]';
  if (!heardCache.has(key)) {
    heardCache.set(key, hearRecordNow(data).then(({ heard, seconds }) => {
      const said = String(heard?.speech?.text || '').trim();
      const extra = [];
      if (heard?.music?.isMusic && heard.music.description) extra.push(`听着是音乐：${heard.music.description}`);
      const ev = (heard?.speech?.events || []).filter((e) => e !== '背景音乐' || !heard?.music?.isMusic);
      if (ev.length) extra.push(`还听到${ev.join('、')}`);
      const len = seconds ? ` ${seconds}秒` : '';
      if (!said && !extra.length) return `[语音${len}：没听出说了什么]`;
      return `[语音${len}${said ? `：「${said.slice(0, 300)}」` : ''}${extra.length ? `（${extra.join('；')}）` : ''}]`;
    }).catch(() => '[语音]'));
    if (heardCache.size > 200) heardCache.delete(heardCache.keys().next().value);
  }
  return await Promise.race([heardCache.get(key), new Promise((r) => setTimeout(() => r('[语音]'), timeoutMs))]);
}

/** 把听到的写成几行给她看。什么都没听出来返回 ''。 */
export function describeHearing(h, { maxSpeech = 400 } = {}) {
  if (!h) return '';
  const lines = [];
  if (h.music?.isMusic && h.music.description) lines.push(`配乐 / 音乐：${h.music.description}`);
  const said = String(h.speech?.text || '').trim();
  if (said) lines.push(`人声 / 歌词（听写，可能有错字）：「${said.length > maxSpeech ? `${said.slice(0, maxSpeech)}…` : said}」`);
  const events = (h.speech?.events || []).filter((e) => !(e === '背景音乐' && h.music?.isMusic));
  if (events.length) lines.push(`还听到：${events.join('、')}`);
  if (!lines.length && h.music && !h.music.isMusic && !said) lines.push('基本没什么声音（没有音乐，也没人说话）');
  return lines.join('\n');
}

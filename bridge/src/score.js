// 读谱（2026-10-25 主人：想让她们「听到」旋律，而不只是「读歌」）。
// 两个模型都听不了声音；这里把一段歌扒成「谱面卡」：按小节排的简谱旋律、每小节的和弦、节拍、调性、响度起伏。
// 她们读到的是旋律本身（音符、音程、和弦进行），像会看谱的人读谱，而不是别人写好的感想。
//
// 引擎：CrispASR v0.8.44（MIT，E:\music-ear）——htdemucs 分离人声、Beat This! 节拍、BTC 和弦（权重 CC-BY-NC-SA，自用）、
// CREPE 音高。默认走显卡（Vulkan 版）；语音服务正占着显卡、显存不够、或显卡那一步失败，就退回 CPU 版。
// 同一时间只扒一首（跨进程用锁文件），不跟别的显卡活抢。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'E:\\music-ear';
const EXE = {
  gpu: path.join(ROOT, 'vulkan', 'crispasr-windows-x86_64-vulkan', 'crispasr.exe'),
  cpu: path.join(ROOT, 'cpu', 'crispasr-windows-x86_64-cpu', 'crispasr.exe')
};
const MODELS = path.join(ROOT, 'models');
const LOCK = path.join(ROOT, 'run.lock');
const WINGET_FFMPEG = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
const FFMPEG = fs.existsSync(WINGET_FFMPEG) ? WINGET_FFMPEG : 'ffmpeg';

/**
 * 本机补丁（2026-10-29）：读谱要先从 B 站下视频；B 站风控 / 要登录时接口回一整页网页，旧版插件直接 .json()，
 * 把「Unexpected token '<', "<!DOCTYPE "... is not valid JSON」连同整段堆栈一路传到了她那儿（M11）。
 * 这里把这种错误、以及任何堆栈，换成一句她看得懂、知道下一步怎么办的话；本来就是人话的原样留着。
 */
export const BILI_BLOCKED_HINT = 'B 站这会儿不让看这条（可能是风控或者需要登录），可以过一会儿再试，或者换一条';
export function friendlyToolError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '这次没弄成，可以过一会儿再试';
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 插件打过补丁后自己会说人话（带状态码），直接用它那句
  const human = lines.find((l) => l.startsWith('B 站这会儿不让看'));
  if (human) return human;
  const status = /\bHTTP\s*(\d{3})\b/i.exec(s)?.[1];
  if (/<!DOCTYPE|<html|is not valid JSON|Unexpected token\s*'?<'?/i.test(s)) return `${BILI_BLOCKED_HINT}${status ? `（HTTP ${status}）` : ''}`;
  const stack = lines.some((l) => /^at\s.+:\d+:\d+\)?$/.test(l)) || /node:internal|file:\/\/\/|^Node\.js v\d/m.test(s);
  if (stack) return '这次没弄成（那边程序出了岔子），可以过一会儿再试，或者换一条';
  return s;
}

export function scoreAvailable() {
  return fs.existsSync(EXE.cpu) && fs.existsSync(path.join(MODELS, 'htdemucs-f16.gguf'));
}

function run(exe, args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

/**
 * 显卡这会儿能不能用：语音服务装着模型、或者显存剩不到 GPU_MIN_FREE_MB，就不用。
 * 2026-10-26：原来门槛 2.5GB，平时 QQ / 微信 / Unity Hub / 抖音窗口就占掉 6GB+、只剩 1.7GB，一直退 CPU（45 秒片段扒了 579 秒，
 * DSH 工具限时 300 秒，她四次全「请求超时」）。实测强制走显卡：剩 1.7GB 照样 45 秒扒完，峰值只多用约 750MB。显卡那步真失败了 task() 会自己退 CPU。
 */
const GPU_MIN_FREE_MB = 1200;
// CPU 上慢的只有分离人声这一步（10-26 实测 20 秒片段：分离 459 秒，节拍 1 秒、和弦 0 秒、旋律 2 秒），DSH 工具限时 300 秒。
// 所以没有显卡（或显卡那步分离失败）时直接跳过分离，拿原曲测旋律，卡上注明「旋律可能混进伴奏」，几秒就出卡，片段也不用截短。
async function gpuFree() {
  if (!fs.existsSync(EXE.gpu)) return false;
  try {
    const h = await (await fetch('http://127.0.0.1:9881/health', { signal: AbortSignal.timeout(1500) })).json();
    if (h?.loaded) return false;
  } catch { /* 语音服务没开，正好 */ }
  const r = await run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeoutMs: 10000 });
  const free = Number(String(r.stdout).trim().split('\n')[0]);
  return r.ok && free >= GPU_MIN_FREE_MB;
}

// 2026-10-26：原来等 6 分钟，DSH 那边 300 秒就放弃了还在排队，越排越堵；等一分钟不行就直说。
async function withLock(fn, { waitMs = 60e3 } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      break;
    } catch {
      let stale = true;
      try { stale = Date.now() - JSON.parse(fs.readFileSync(LOCK, 'utf8')).at > 10 * 60e3; } catch { /* 读不了就当旧的 */ }
      if (stale) { try { fs.rmSync(LOCK, { force: true }); } catch { /* 下一轮再试 */ } continue; }
      if (Date.now() > end) throw new Error('前面还有一首在扒，等会儿再来');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(LOCK, { force: true }); } catch { /* 删不掉下次当旧锁 */ } }
}

/** 先用显卡跑，失败（或显卡不让用）再用 CPU；返回解析好的 JSON。 */
async function task(name, args, { gpu, cpuArgs = args, timeoutMs }) {
  const tries = gpu ? [['gpu', args], ['cpu', cpuArgs]] : [['cpu', cpuArgs]];
  let last = '';
  for (const [which, a] of tries) {
    const r = await run(EXE[which], a, { timeoutMs });
    if (r.ok) {
      if (!a.some((x) => /-format$/.test(x))) return { which };
      // 它把输入路径原样写进 "file"（Windows 路径的反斜杠没转义，JSON 就坏了），解析前去掉那一行
      const json = r.stdout.slice(r.stdout.indexOf('{')).replace(/"file"\s*:\s*"[^\n]*?",\s*\n/, '');
      try { return { which, data: JSON.parse(json) }; } catch { last = `${name} 输出看不懂`; continue; }
    }
    last = `${name}（${which}）失败：${(r.stderr || String(r.error?.message || '')).trim().split('\n').pop()?.slice(0, 160)}`;
  }
  throw new Error(last);
}

// ── 音乐小工具 ───────────────────────────────────────────────────────────
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const DEGREES = ['1', '#1', '2', 'b3', '3', '4', '#4', '5', '#5', '6', 'b7', '7'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** 降号调（1=F Bb Eb Ab Db Gb）用降号名，其余用升号名。 */
export const spellFor = (doh) => ([5, 10, 3, 8, 1, 6].includes(doh) ? FLATS : SHARPS);
const midiName = (m, spell = NAMES) => `${spell[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

/** 和弦名 → [根音 0–11, 是否小三和弦, 显示名]；N 返回 null。 */
export function parseChord(label) {
  const s = String(label || '').trim();
  if (!s || s === 'N' || s === 'X') return null;
  const [rootRaw, qual = 'maj'] = s.split(':');
  const flat = { Db: 'C#', Gb: 'F#', 'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  const root = NAMES.indexOf(flat[rootRaw] || rootRaw);
  if (root < 0) return null;
  const minor = /^min/.test(qual) || qual === 'hdim7' || qual === 'dim';
  const suffix = { maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7', dim: 'dim', dim7: 'dim7', hdim7: 'm7b5', aug: 'aug', sus2: 'sus2', sus4: 'sus4', min6: 'm6', maj6: '6', minmaj7: 'mM7' }[qual] ?? qual;
  return { root, minor, name: `${NAMES[root]}${suffix}` };
}

/** 调性：人声音高分布 + 和弦根音（按时长加权）跟大小调模板比相关。 */
export function detectKey(pcWeights) {
  let best = { r: -2 };
  for (let k = 0; k < 12; k++) {
    for (const [mode, tpl] of [['major', MAJOR], ['minor', MINOR]]) {
      const rot = tpl.map((_, i) => tpl[((i - k) % 12 + 12) % 12]);
      const r = corr(pcWeights, rot);
      if (r > best.r) best = { r, tonic: k, mode };
    }
  }
  // 简谱按大调记：小调用关系大调的 1（主音是 6）
  return { ...best, doh: best.mode === 'minor' ? (best.tonic + 3) % 12 : best.tonic };
}

/** 一个 MIDI 音 → 简谱记号（相对 doh，' 高八度 , 低八度；center 是不加点的那个八度里 1 的 MIDI）。 */
export function jianpu(midi, doh, center) {
  const off = midi - center;
  const oct = Math.floor(off / 12);
  const deg = DEGREES[((off % 12) + 12) % 12];
  return deg + (oct > 0 ? "'".repeat(oct) : oct < 0 ? ','.repeat(-oct) : '');
}

function readWavMono(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) return null;
  const n = Math.floor(data.length / 2 / fmt.ch), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2); out[i] = s / fmt.ch / 32768; }
  return { rate: fmt.rate, samples: out };
}

/**
 * 把节拍、和弦、音高排成谱面卡。纯计算，测试直接喂数据。
 * beats: [{time, downbeat}]；chords: [{start_ms,end_ms,chord,confidence}]；frames: [{time_ms,f0_hz,voiced_prob}]；
 * rms(t0,t1) → 0..1 响度（可选）；offset：这段在原曲里从第几秒开始。
 */
export function renderCard({ title = '', offset = 0, duration, tempo, beats, chords, frames, rms = null, slotsPerBeat = 2 }) {
  const allBeats = beats.map((b) => b.time).sort((a, b) => a - b);
  const downIdx = beats.map((b, i) => (b.downbeat ? i : -1)).filter((i) => i >= 0);
  // 每小节几拍：相邻强拍之间最常见的拍数（强拍时有时无，不能逐个信）
  const gaps = downIdx.slice(1).map((v, i) => v - downIdx[i]).filter((g) => g >= 2 && g <= 7);
  const count = {};
  for (const g of gaps) count[g] = (count[g] || 0) + 1;
  // 只有某种拍数明显占多数（≥60%）才信它；短片段强拍少、时有时无，否则按最常见的 4 拍
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const meter = top && top[1] / gaps.length >= 0.6 ? Number(top[0]) : 4;
  const beatLen = allBeats.length > 1 ? (allBeats[allBeats.length - 1] - allBeats[0]) / (allBeats.length - 1) : 0.5;
  // 从第一个「后面跟着规整小节」的强拍起，按 meter 拍一小节规整地切；之前的拍算弱起
  let first = downIdx.find((i, k) => downIdx[k + 1] - i === meter) ?? downIdx[0] ?? 0;
  while (first - meter >= 0) first -= meter;
  const bars = [];
  if (first > 0) bars.push({ pickup: true, beats: allBeats.slice(0, first) });
  for (let i = first; i < allBeats.length; i += meter) bars.push({ beats: allBeats.slice(i, i + meter) });
  for (const b of bars) { b.a = b.beats[0]; b.b = b.beats[b.beats.length - 1] + beatLen; }
  for (let i = 0; i < bars.length - 1; i++) bars[i].b = bars[i + 1].a;
  // 片段最后那一两拍（落在结尾上、凑不成半小节）不单独成一行
  while (bars.length > 1 && bars[bars.length - 1].beats.length < Math.ceil(meter / 2) && bars[bars.length - 1].a >= duration - beatLen * 1.5) bars.pop();

  // 人声音高：有声帧（置信 ≥0.5）转 MIDI，中值平滑
  const voiced = frames.filter((f) => f.voiced_prob >= 0.5 && f.f0_hz > 60 && f.f0_hz < 1400).map((f) => ({ t: f.time_ms / 1000, m: hzToMidi(f.f0_hz) }));
  for (let i = 2; i < voiced.length - 2; i++) voiced[i].ms = voiced.slice(i - 2, i + 3).map((x) => x.m).sort((a, b) => a - b)[2];
  for (const v of voiced) v.ms ??= v.m;

  // 调性：音高分布（按帧）+ 和弦（按秒）
  const pc = new Array(12).fill(0);
  for (const v of voiced) pc[((Math.round(v.ms) % 12) + 12) % 12] += 0.02;
  for (const c of chords) { const p = parseChord(c.chord); if (p) { const d = (c.end_ms - c.start_ms) / 1000; pc[p.root] += d * 1.5; pc[(p.root + (p.minor ? 3 : 4)) % 12] += d; pc[(p.root + 7) % 12] += d; } }
  const key = detectKey(pc);
  const spell = spellFor(key.doh);

  // 每小节切格（每拍 slotsPerBeat 格），每格取人声中位音高
  for (const bar of bars) {
    const edges = [...bar.beats, bar.b];
    bar.slots = [];
    for (let i = 0; i < edges.length - 1; i++) {
      for (let s = 0; s < slotsPerBeat; s++) {
        const t0 = edges[i] + ((edges[i + 1] - edges[i]) * s) / slotsPerBeat, t1 = edges[i] + ((edges[i + 1] - edges[i]) * (s + 1)) / slotsPerBeat;
        const inSlot = voiced.filter((v) => v.t >= t0 && v.t < t1);
        if (inSlot.length / Math.max(1, Math.round((t1 - t0) / 0.02)) < 0.4) { bar.slots.push(null); continue; }
        const ms = inSlot.map((v) => v.ms).sort((x, y) => x - y);
        bar.slots.push(Math.round(ms[Math.floor(ms.length / 2)]));
      }
    }
  }
  // 八度纠错：泛音常被当成主音，比前后几个音高 / 低出将近一个八度以上的，挪回去
  const flat = bars.flatMap((b) => b.slots);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] == null) continue;
    const near = flat.slice(Math.max(0, i - 6), i + 7).filter((x, j) => x != null && j !== Math.min(i, 6));
    if (near.length < 3) continue;
    const med = near.sort((a, b) => a - b)[Math.floor(near.length / 2)];
    while (flat[i] - med > 9) flat[i] -= 12;
    while (med - flat[i] > 9) flat[i] += 12;
  }
  let k = 0;
  for (const b of bars) b.slots = b.slots.map(() => flat[k++]);

  // 不加点的八度：选让「加了点的音」最少的那个
  const sung = flat.filter((x) => x != null).sort((a, b) => a - b);
  const med = sung[Math.floor(sung.length / 2)] ?? 64;
  const base = key.doh + 12 * Math.floor((med - key.doh) / 12);
  const marks = (c) => sung.filter((m) => m < c || m >= c + 12).length;
  const center = [base - 12, base, base + 12].sort((x, y) => marks(x) - marks(y))[0];
  const lo = sung[Math.floor(sung.length * 0.05)], hi = sung[Math.floor(sung.length * 0.95)];

  const energies = bars.map((b) => (rms ? rms(b.a, b.b) : 0));
  const maxE = Math.max(1e-9, ...energies);
  let lowConf = 0, n = 0;
  const rows = bars.map((bar, bi) => {
    const toks = bar.slots.map((m, i) => (m == null ? '0' : i > 0 && bar.slots[i - 1] === m ? '-' : jianpu(m, key.doh, center)));
    const groups = [];
    for (let i = 0; i < toks.length; i += slotsPerBeat) groups.push(toks.slice(i, i + slotsPerBeat).join(' '));
    const cs = [];
    for (const c of chords) {
      const ov = Math.min(bar.b, c.end_ms / 1000) - Math.max(bar.a, c.start_ms / 1000);
      if (ov < (bar.b - bar.a) * 0.25) continue;
      const p = parseChord(c.chord);
      const label = p ? `${spell[p.root]}${p.name.replace(/^[A-G][#b]?/, '')}(${DEGREES[((p.root - key.doh) % 12 + 12) % 12]}${p.minor ? 'm' : ''})` : '—';
      const q = c.confidence != null && c.confidence < 0.6 ? '?' : '';
      if (q) lowConf++;
      if (cs[cs.length - 1] !== label + q) cs.push(label + q);
    }
    const loud = rms ? ` 响${Math.round((9 * energies[bi]) / maxE)}` : '';
    const name = bar.pickup ? '弱起  ' : `第${String(++n).padStart(2, ' ')}小节`;
    return `${name} ${clock(offset + bar.a)}${loud} | ${(cs.join(' ') || '—').padEnd(14, ' ')} | ${groups.join(' | ')}`;
  });

  const bpm = Math.round(tempo || 60 / beatLen);
  const keyName = `${spell[key.tonic]} ${key.mode === 'major' ? '大调' : '小调'}`;
  const dohNote = key.mode === 'minor' ? `（简谱按 1=${spell[key.doh]} 记，6 是主音）` : `（1=${spell[key.doh]}）`;
  const voicedShare = sung.length / Math.max(1, flat.length);
  const head = [
    `【谱面卡】${title ? `${title} ` : ''}${clock(offset)}–${clock(offset + duration)}，共 ${n} 小节`,
    `整体：约 ${bpm} BPM${bpm > 140 ? `（也可以听成 ${Math.round(bpm / 2)} BPM，每拍算两下）` : ''}，每小节 ${meter} 拍；${keyName}${dohNote}；人声大约 ${lo != null ? `${midiName(lo, spell)}–${midiName(hi, spell)}` : '（几乎没人声）'}`,
    `怎么读：每行一小节，「|」隔开每一拍，每拍分成 ${slotsPerBeat} 格；数字是简谱音，' 高八度 , 低八度，# b 升降；- 是上一个音拖着，0 是没唱。和弦后括号里是它在这个调里的级数，带 ? 的机器不太确定。${rms ? '「响」是这小节的响度（0–9）。' : ''}`
  ];
  const warn = `提醒：这是机器从混音里扒的大概谱子——人声先从伴奏里分出来再跟音高，转音、滑音、很快的装饰音可能漏或者并成一个音；同一个音唱两下可能被并成拖长；和弦常把七和弦认成三和弦。${voicedShare < 0.2 ? '这段人声很少（可能是前奏 / 纯音乐），旋律行大多是 0。' : ''}${lowConf > n / 3 ? '这段和弦不确定的比较多。' : ''}`;
  return [...head, '', ...rows, '', warn].join('\n');
}

/**
 * 扒一段：file 可以是视频或音频。start / seconds：从第几秒开始扒多久（最多 90 秒）。
 * 返回 { card, engine: 'gpu'|'cpu'|'mixed', took }。
 */
export async function scoreFile(file, { title = '', start = 0, seconds = 45, log = () => {} } = {}) {
  if (!scoreAvailable()) throw new Error('读谱工具没装好');
  seconds = Math.max(10, Math.min(90, Number(seconds) || 45));
  start = Math.max(0, Number(start) || 0);
  // 2026-10-29：兜底，冒上来的错误先换成人话再给她（见 friendlyToolError）
  return withLock(async () => {
    const t0 = Date.now();
    const gpu = await gpuFree();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));
    try {
      const mix = path.join(dir, 'mix.wav');
      const cut = await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', mix], { timeoutMs: 60000 });
      if (!cut.ok || !fs.existsSync(mix) || fs.statSync(mix).size < 44100 * 4) throw new Error('这段没有声音，或者文件读不了');
      const duration = (fs.statSync(mix).size - 44) / 4 / 44100;
      const used = new Set();
      let vocals = path.join(dir, 'mix_vocals.wav');
      let separated = false;
      if (gpu) {
        // 只在显卡上分；显卡这步失败不退 CPU（CPU 上要七八分钟），直接拿原曲
        const r = await run(EXE.gpu, ['--separate', '-m', path.join(MODELS, 'htdemucs-f16.gguf'), '--stems', 'vocals', '--sep-output-dir', dir, '-f', mix], { timeoutMs: 180000 });
        separated = r.ok && fs.existsSync(vocals);
        if (separated) used.add('gpu');
      }
      if (!separated) vocals = mix;
      const beats = await task('节拍', ['--beats', '-m', path.join(MODELS, 'beat-this-f16.gguf'), '--beats-format', 'json', '-f', mix], { gpu, timeoutMs: 300000 });
      const chords = await task('和弦', ['--chords', '-m', path.join(MODELS, 'btc-chords-large-f16.gguf'), '--chords-format', 'json', '-f', mix], { gpu, timeoutMs: 300000 });
      const pitch = await task('旋律', ['--pitch', '-m', path.join(MODELS, 'crepe-full-f16.gguf'), '--pitch-format', 'json', '--pitch-hop-ms', '20', '-f', vocals],
        { gpu, cpuArgs: ['--pitch', '-m', path.join(MODELS, 'crepe-tiny-f16.gguf'), '--pitch-format', 'json', '--pitch-hop-ms', '20', '-f', vocals], timeoutMs: 600000 });
      for (const x of [beats, chords, pitch]) used.add(x.which);
      const wav = readWavMono(mix);
      const rms = wav ? (a, b) => {
        const i0 = Math.max(0, Math.floor(a * wav.rate)), i1 = Math.min(wav.samples.length, Math.floor(b * wav.rate));
        let s = 0; for (let i = i0; i < i1; i++) s += wav.samples[i] ** 2;
        return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
      } : null;
      const card = renderCard({ title, offset: start, duration, tempo: beats.data?.tempo_bpm, beats: beats.data?.beats || [], chords: chords.data?.chords || [], frames: pitch.data?.frames || [], rms });
      const engine = used.size > 1 ? 'mixed' : [...used][0];
      log(`[score] ${title || path.basename(file)} ${start}+${seconds}s 用 ${engine} 扒了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
      const note = separated ? '' : '（这次显卡被别的程序占着，没把人声单独分出来，旋律是从整首歌里测的，可能混进伴奏的音；和弦、节拍不受影响。想要干净的旋律，过会儿再扒一次。）\n';
      return { card: note + card, engine, took: (Date.now() - t0) / 1000 };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时文件删不掉不要紧 */ }
    }
  }).catch((error) => { throw new Error(friendlyToolError(error?.message ?? error)); });
}

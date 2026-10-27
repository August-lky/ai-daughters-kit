"""本机音乐描述入口（sherpa-onnx 音频打标签 CED-small + numpy 算节奏），不读取服务凭据或用户其他文件。

本机补丁（2026-10-24，music）：她用的模型只能读文字，旋律到不了她那里。这里把一段音轨"翻译"成文字描述：
曲风、乐器、情绪、有没有人唱，再加上大概的节奏快慢（BPM）和音量起伏。她拿到的是描述，不是声音本身。
"""
import csv
import importlib.util
import json
from pathlib import Path
import sys
import wave

MODEL_DIR_NAME = "sherpa-onnx-ced-small-audio-tagging-2024-04-19"

# AudioSet 标签 → 中文，只翻她聊音乐用得上的几类；其余标签不报
GENRES = {"Pop music": "流行", "Rock music": "摇滚", "Heavy metal": "重金属", "Punk rock": "朋克", "Hip hop music": "说唱", "Rhythm and blues": "R&B",
          "Soul music": "灵魂乐", "Reggae": "雷鬼", "Country": "乡村", "Jazz": "爵士", "Blues": "布鲁斯", "Classical music": "古典", "Opera": "歌剧",
          "Electronic music": "电子", "House music": "浩室", "Techno": "科技舞曲", "Dubstep": "回响贝斯", "Drum and bass": "鼓打贝斯", "Electronic dance music": "电子舞曲",
          "Ambient music": "氛围音乐", "Trance music": "出神舞曲（Trance）", "Music of Asia": "亚洲风", "Music of Latin America": "拉丁", "Folk music": "民谣",
          "Funk": "放克", "Disco": "迪斯科", "Video game music": "游戏音乐", "Soundtrack music": "影视配乐", "Background music": "背景音乐",
          "Christmas music": "圣诞歌", "Dance music": "舞曲", "Wedding music": "婚礼音乐", "Theme music": "主题曲", "Jingle (music)": "广告曲",
          "Lullaby": "摇篮曲", "Children's music": "儿歌", "A capella": "清唱", "Vocal music": "人声音乐", "Music for children": "儿歌",
          "Carnatic music": "南印度音乐", "Music of Bollywood": "宝莱坞", "Traditional music": "传统音乐", "Independent music": "独立音乐"}
INSTRUMENTS = {"Piano": "钢琴", "Electric piano": "电钢琴", "Keyboard (musical)": "键盘", "Organ": "管风琴", "Synthesizer": "合成器", "Guitar": "吉他",
               "Electric guitar": "电吉他", "Acoustic guitar": "木吉他", "Bass guitar": "贝斯", "Drum": "鼓", "Drum kit": "架子鼓", "Drum machine": "鼓机",
               "Violin, fiddle": "小提琴", "Cello": "大提琴", "Orchestra": "管弦乐团", "String section": "弦乐", "Brass instrument": "铜管", "Trumpet": "小号",
               "Saxophone": "萨克斯", "Flute": "长笛", "Harp": "竖琴", "Ukulele": "尤克里里", "Accordion": "手风琴", "Bell": "铃声", "Guzheng": "古筝",
               "Erhu": "二胡", "Pipa": "琵琶", "Dizi": "笛子", "Zither": "古筝/齐特琴", "Sitar": "西塔琴", "Plucked string instrument": "弹拨乐", "Scratching (performance technique)": "搓碟",
               "Beatboxing": "Beatbox", "Clapping": "拍手", "Whistling": "口哨"}
MOODS = {"Happy music": "欢快", "Funny music": "滑稽", "Sad music": "伤感", "Tender music": "温柔", "Exciting music": "激昂", "Angry music": "愤怒", "Scary music": "紧张/吓人"}
VOICES = {"Singing": "有人在唱", "Male singing": "男声唱", "Female singing": "女声唱", "Child singing": "童声唱", "Choir": "合唱", "Rapping": "说唱",
          "Synthetic singing": "合成人声（像虚拟歌手）", "Chant": "吟唱", "Humming": "哼唱", "Yodeling": "约德尔"}


def model_files(models_dir):
    base = Path(models_dir) / MODEL_DIR_NAME
    return base / "model.int8.onnx", base / "class_labels_indices.csv"


if "--probe" in sys.argv:
    models_dir = Path(sys.argv[sys.argv.index("--models-dir") + 1]) if "--models-dir" in sys.argv else Path(__file__).parent / ".models"
    model, labels = model_files(models_dir)
    cached = model.is_file() and labels.is_file()
    dependency = importlib.util.find_spec("sherpa_onnx") is not None
    print(json.dumps({"available": dependency and cached, "dependencyAvailable": dependency, "modelCached": cached}))
    raise SystemExit(0)

request = json.load(sys.stdin)
import numpy as np
import sherpa_onnx

models_dir = Path(request["modelsDir"]) if request.get("modelsDir") else Path(__file__).parent / ".models"
model, labels = model_files(models_dir)
with open(labels, encoding="utf-8") as fh:
    names = {int(row["index"]): row["display_name"] for row in csv.DictReader(fh)}

with wave.open(request["path"], "rb") as wav:
    rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
    raw = wav.readframes(wav.getnframes())
if width != 2:
    raise SystemExit("只支持 16 位 PCM WAV")
samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
if channels > 1:
    samples = samples.reshape(-1, channels).mean(axis=1)

config = sherpa_onnx.AudioTaggingConfig(
    model=sherpa_onnx.AudioTaggingModelConfig(ced=str(model), num_threads=2, provider="cpu"),
    labels=str(labels), top_k=40)
tagger = sherpa_onnx.AudioTagging(config)

# 2026-10-24：CED 一次只吃得下约 30 秒，再长 onnxruntime 就报广播错误（31/40/60 秒实测都崩）。
# 切成 10 秒一段分别打标签，同一个标签取各段的平均（某段没出现记 0），整段的感觉不偏向哪一截。
WINDOW = rate * 10
chunks = [samples[i:i + WINDOW] for i in range(0, len(samples), WINDOW)]
chunks = [c for c in chunks if len(c) >= rate] or [samples]  # 尾巴不足 1 秒的丢掉
totals = {}
for chunk in chunks:
    stream = tagger.create_stream()
    stream.accept_waveform(sample_rate=rate, waveform=chunk)
    for event in tagger.compute(stream):
        name = getattr(event, "name", None) or names.get(int(getattr(event, "index", -1)), "")
        totals[name] = totals.get(name, 0.0) + float(getattr(event, "prob", 0.0))
scores = {k: v / len(chunks) for k, v in totals.items()}


def pick(table, floor, limit):
    found = sorted(((scores[k], v) for k, v in table.items() if scores.get(k, 0) >= floor), reverse=True)
    out = []
    for _, label in found:
        if label not in out:
            out.append(label)
    return out[:limit]


music_prob = scores.get("Music", 0.0)


def tempo_bpm(x, sr):
    """粗算节奏：短时能量的起伏做自相关，取 60~180 BPM 里最像的周期。只是大概。"""
    hop = int(sr * 0.01)
    if len(x) < sr * 4 or hop <= 0:
        return None
    frames = len(x) // hop
    energy = np.array([float(np.sum(x[i * hop:(i + 1) * hop] ** 2)) for i in range(frames)])
    onset = np.maximum(0.0, np.diff(np.log1p(energy * 1000)))
    if not onset.any():
        return None
    onset = onset - onset.mean()
    corr = np.correlate(onset, onset, mode="full")[len(onset) - 1:]
    lo, hi = int(60 / 180 * 100), int(60 / 60 * 100)
    if hi >= len(corr):
        return None
    lag = lo + int(np.argmax(corr[lo:hi]))
    if corr[lag] <= 0:
        return None
    return round(60 * 100 / lag)


def energy_shape(x, sr):
    """音量起伏：每秒的响度，看是平稳、渐强还是有明显爆发。"""
    sec = [float(np.sqrt(np.mean(x[i:i + sr] ** 2)) + 1e-9) for i in range(0, len(x) - sr + 1, sr)]
    if len(sec) < 3:
        return None
    db = 20 * np.log10(np.array(sec))
    spread = float(db.max() - db.min())
    if spread < 6:
        return "音量很平稳"
    if db[-1] - db[0] > 6:
        return "越来越响"
    if db[0] - db[-1] > 6:
        return "越来越轻"
    return "有明显的起伏和爆发"


result = {"isMusic": music_prob >= 0.3, "musicConfidence": round(music_prob, 2)}
if result["isMusic"]:
    result.update({
        "genres": pick(GENRES, 0.12, 3),
        "instruments": pick(INSTRUMENTS, 0.12, 4),
        "moods": pick(MOODS, 0.05, 2),
        "voices": pick(VOICES, 0.08, 2),
    })
    bpm = tempo_bpm(samples, rate)
    if bpm:
        result["tempoBpm"] = bpm
        result["tempo"] = "慢" if bpm < 80 else "中速" if bpm < 115 else "快" if bpm < 145 else "很快"
    shape = energy_shape(samples, rate)
    if shape:
        result["dynamics"] = shape
    parts = []
    if result["genres"]:
        parts.append("听着像" + "、".join(result["genres"]))
    if result["instruments"]:
        parts.append("能听出" + "、".join(result["instruments"]))
    if result["voices"]:
        parts.append("、".join(result["voices"]))
    if result.get("tempo"):
        parts.append(f"节奏{result['tempo']}（约 {result['tempoBpm']} BPM，粗算）")
    if result["moods"]:
        parts.append("情绪偏" + "、".join(result["moods"]))
    if shape:
        parts.append(shape)

    # 2026-10-24 主人批准装 librosa（「耳朵」）：在上面的标签之外，再听出调性、什么时候变响、最高点在哪、人声往哪走。
    # 没装 librosa 或算失败，就只用上面的粗算，不影响原来的结果。
    try:
        import librosa
        y = samples[: rate * 60].astype(np.float32)
        if rate != 22050:
            y = librosa.resample(y, orig_sr=rate, target_sr=22050)
        sr = 22050
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        if 50 <= bpm <= 210:
            result["tempoBpm"] = round(bpm)
            result["tempo"] = "慢" if bpm < 80 else "中速" if bpm < 115 else "快" if bpm < 145 else "很快"
        # 调性：色度平均后跟 Krumhansl 大小调模板比相关
        chroma = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(y), sr=sr).mean(axis=1)
        major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
        best = max(((np.corrcoef(chroma, np.roll(tpl, k))[0, 1], f"{names[k]} {'大调' if m == 'maj' else '小调'}") for m, tpl in (("maj", major), ("min", minor)) for k in range(12)), key=lambda t: t[0])
        if best[0] > 0.5:
            result["key"] = best[1]
        # 响度曲线：每 5 秒一格（0–9），找最响的地方
        rms = librosa.feature.rms(y=y)[0]
        per = max(1, int(5 * sr / 512))
        blocks = [float(rms[i:i + per].mean()) for i in range(0, len(rms), per)]
        if len(blocks) >= 3:
            hi = max(blocks) or 1e-9
            curve = [min(9, int(9 * b / hi + 0.5)) for b in blocks]
            result["energyCurve"] = " ".join(str(c) for c in curve)
            peak = int(np.argmax(blocks)) * 5
            result["peakAt"] = f"{peak // 60}:{peak % 60:02d}"
            rise = next((i for i in range(1, len(curve)) if curve[i] - curve[i - 1] >= 3), None)
            if rise is not None:
                result["riseAt"] = f"{rise * 5 // 60}:{rise * 5 % 60:02d}"
        # 人声旋律：谐波部分用 pyin 跟音高，看音域、前后半段走向、最长的长音
        f0, voiced, _ = librosa.pyin(librosa.effects.harmonic(y), fmin=80, fmax=1000, sr=sr)
        pitched = f0[voiced & ~np.isnan(f0)] if f0 is not None else np.array([])
        if len(pitched) > 50:
            lo_n, hi_n = librosa.hz_to_note(np.percentile(pitched, 10)), librosa.hz_to_note(np.percentile(pitched, 90))
            half = len(pitched) // 2
            trend = np.median(pitched[half:]) / max(1e-9, np.median(pitched[:half]))
            way = "后半段往上走" if trend > 1.12 else "后半段往下走" if trend < 0.89 else "前后差不多高"
            # 最长的长音：连续有声且音高变化不到半音
            midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
            longest, run = 0, 0
            for a, b in zip(midi[:-1], midi[1:]):
                run = run + 1 if not (np.isnan(a) or np.isnan(b)) and abs(a - b) < 0.5 else 0
                longest = max(longest, run)
            held = longest * 512 / sr
            result["melody"] = f"音域大约 {lo_n}–{hi_n}，{way}" + (f"，有个约 {held:.1f} 秒的长音" if held >= 1.0 else "")
    except Exception:  # noqa: BLE001 —— 耳朵出错不影响原来的粗算
        pass

    # 插件那边描述只留 200 字：情绪、整体音量放到最后，先说新听出来的
    tail = [p for p in parts if p.startswith("情绪") or p == shape]
    parts = [p for p in parts if not p.startswith("节奏") and p not in tail]
    if result.get("tempo"):
        parts.append(f"节奏{result['tempo']}（约 {result['tempoBpm']} BPM）")
    if result.get("key"):
        parts.append(result["key"])
    if result.get("riseAt") or result.get("peakAt"):
        parts.append("".join([f"{result['riseAt']} 起变响，" if result.get("riseAt") else "", f"{result['peakAt']} 前后最响" if result.get("peakAt") else ""]))
    if result.get("melody"):
        parts.append("人声" + result["melody"])
    result["description"] = "；".join(parts + tail)
sys.stdout.reconfigure(encoding="utf-8")  # 不管谁调用，都按 UTF-8 输出中文
print(json.dumps(result, ensure_ascii=False))

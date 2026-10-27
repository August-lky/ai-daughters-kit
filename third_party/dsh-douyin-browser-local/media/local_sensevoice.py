"""本机 SenseVoice CPU 转写入口（sherpa-onnx），不读取服务凭据或用户其他文件。

本机补丁（2026-10-24，sensevoice）：她反馈 Whisper small 把「一口气全说完」认成「一口全说往前实名」。
SenseVoice 对中文和带配乐的片段明显更准，还能认英语、日语、韩语、粤语，并顺带标出背景音乐、笑声等事件。
输出和 local_whisper.py 同一形状（text / language / segments），多一个 events。
"""
import importlib.util
import json
from pathlib import Path
import sys
import wave

MODEL_DIR_NAME = "sense-voice-zh-en-ja-ko-yue-2024-07-17"
CHUNK_SECONDS = 15
EVENT_NAMES = {"BGM": "背景音乐", "Laughter": "笑声", "Applause": "掌声", "Cry": "哭声", "Sneeze": "喷嚏", "Cough": "咳嗽", "Breath": "呼吸声"}
LANG_NAMES = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "yue": "yue"}


def model_files(models_dir):
    base = Path(models_dir) / MODEL_DIR_NAME
    return base / "model.int8.onnx", base / "tokens.txt"


def tag(value):
    """sherpa 给的 lang / event / emotion 形如 <|zh|>、<|BGM|>，去掉尖括号。"""
    return str(value or "").strip().strip("<|>").strip()


if "--probe" in sys.argv:
    models_dir = Path(sys.argv[sys.argv.index("--models-dir") + 1]) if "--models-dir" in sys.argv else Path(__file__).parent / ".models"
    model, tokens = model_files(models_dir)
    cached = model.is_file() and tokens.is_file()
    dependency = importlib.util.find_spec("sherpa_onnx") is not None
    print(json.dumps({"available": dependency and cached, "dependencyAvailable": dependency, "modelCached": cached}))
    raise SystemExit(0)

request = json.load(sys.stdin)
import numpy as np
import sherpa_onnx

models_dir = Path(request["modelsDir"]) if request.get("modelsDir") else Path(__file__).parent / ".models"
model, tokens = model_files(models_dir)
try:
    threads = max(1, min(16, int(request.get("cpuThreads") or 4)))
except (TypeError, ValueError):
    threads = 4
language = request.get("language") or "auto"
if language not in ("auto", "zh", "en", "ja", "ko", "yue"):
    language = "auto"
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=str(model), tokens=str(tokens), num_threads=threads, use_itn=True, language=language)

with wave.open(request["path"], "rb") as wav:
    rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
    raw = wav.readframes(wav.getnframes())
if width != 2:
    raise SystemExit("只支持 16 位 PCM WAV")
samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
if channels > 1:
    samples = samples.reshape(-1, channels).mean(axis=1)

# 按 15 秒一段送进去：SenseVoice 是整段识别，分段既能给出时间轴，也避免长片段里后半段被吞。
segments, events, langs = [], [], []
step = CHUNK_SECONDS * rate
for offset in range(0, len(samples), step):
    chunk = samples[offset:offset + step]
    if len(chunk) < rate * 0.3:
        continue
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, chunk)
    recognizer.decode_stream(stream)
    result = stream.result
    event = tag(getattr(result, "event", ""))
    if event in EVENT_NAMES and EVENT_NAMES[event] not in events:
        events.append(EVENT_NAMES[event])
    lang = tag(getattr(result, "lang", ""))
    if lang in LANG_NAMES:
        langs.append(LANG_NAMES[lang])
    text = str(result.text or "").strip()
    # 没人说话时它偶尔吐一个孤零零的标点，当作没有对白
    if text and any(ch.isalnum() for ch in text):
        start = offset / rate
        segments.append({"start": start, "end": start + len(chunk) / rate, "text": text})

print(json.dumps({"text": " ".join(item["text"] for item in segments).strip(),
                  "language": max(set(langs), key=langs.count) if langs else None,
                  "segments": segments, "events": events, "engine": "sensevoice"}, ensure_ascii=False))

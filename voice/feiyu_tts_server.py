"""小鲸鱼的嗓子：常驻本机的肥鱼 CosyVoice3 合成服务（只听 127.0.0.1）。

服务常驻，模型不常驻：有人要说话才装进显卡（约 15～25 秒），说完空闲 5 分钟（FEIYU_IDLE_SEC）就整个卸掉，
显卡空出来。连着说话时模型一直在，每句几秒出声。桥接调 POST /speak 拿 wav 路径。
声音配方写在 voices.json：用哪套权重（cute=粉丝训练的 F6 / base=原版）、参考音频和它的原文、
变调（半音）、语速、可选的语气指令。改完 voices.json 调 POST /reload 或重启本服务就生效，不用动模型。

来源：Esmerubphire/FeiyuVoice-CosyVoice3（自用，不可商用）。推理参数照它的 infer.py：
zero_shot、seed 42、fp32、prompt 前缀 'You are a helpful assistant.<|endofprompt|>'。
"""
import gc
import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PKG = ROOT / 'FeiyuVoice-CosyVoice3'
REPO = ROOT / 'CosyVoice'
OUT = ROOT / 'out'
VOICES = ROOT / 'voices.json'
PREFIX = 'You are a helpful assistant.<|endofprompt|>'
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1', OMP_NUM_THREADS='4')
sys.path.insert(0, str(REPO))
sys.path.append(str(REPO / 'third_party' / 'Matcha-TTS'))
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('feiyu')

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402


def _sf_load(path, *args, **kwargs):
    """torchaudio 2.11 的 load 要另装 torchcodec；参考音频就是本地 wav，用 soundfile 读一样。"""
    data, sr = sf.read(str(path), dtype='float32', always_2d=True)
    return torch.from_numpy(data.T.copy()), sr


torchaudio.load = _sf_load

LOCK = threading.Lock()
STATE = {'model': None, 'weights': {}, 'loaded': None, 'voices': {}, 'spk': set(), 'last': 0.0}
IDLE_SEC = float(os.environ.get('FEIYU_IDLE_SEC', '300'))


def load_voices():
    data = json.loads(VOICES.read_text(encoding='utf-8-sig'))
    STATE['voices'] = data
    STATE['spk'] = set()
    return data


def load_model():
    from cosyvoice.cli.cosyvoice import AutoModel
    model_dir = PKG / 'models' / 'Fun-CosyVoice3-0.5B-2512'
    t = time.perf_counter()
    voice = AutoModel(model_dir=str(model_dir), fp16=os.environ.get('FEIYU_FP16') == '1', load_trt=False, load_vllm=False)
    voice.model.llm.eval()
    # 两套 LLM 权重放内存里，按声音切换（切一次约 1 秒）
    STATE['weights'] = {
        'base': {k: v.detach().cpu().clone() for k, v in voice.model.llm.state_dict().items()},
        'cute': torch.load(PKG / 'models' / 'feiyu_cute_F6_0040.pt', map_location='cpu', weights_only=True),
    }
    STATE['loaded'] = 'base'
    STATE['model'] = voice
    # 计时：每句话里「想词」（LLM 出语音 token）和「出声」（flow+声码器）各用了多久，写进日志
    STATE['t'] = {'llm': 0.0, 'wav': 0.0}
    m = voice.model
    raw_llm, raw_wav = m.llm_job, m.token2wav

    def timed_llm(*a, **k):
        t0 = time.perf_counter()
        try:
            return raw_llm(*a, **k)
        finally:
            STATE['t']['llm'] += time.perf_counter() - t0

    def timed_wav(*a, **k):
        t0 = time.perf_counter()
        try:
            return raw_wav(*a, **k)
        finally:
            STATE['t']['wav'] += time.perf_counter() - t0
    m.llm_job, m.token2wav = timed_llm, timed_wav
    log.info('model ready in %.1fs (cuda=%s)', time.perf_counter() - t, torch.cuda.is_available())


def ensure_model():
    """调用方持有 LOCK。"""
    if STATE['model'] is None:
        load_model()
    STATE['last'] = time.time()


def unload_model():
    """调用方持有 LOCK。把模型、两套权重、参考音频缓存全扔掉，显存还给别人。"""
    if STATE['model'] is None:
        return
    STATE.update(model=None, weights={}, loaded=None, spk=set())
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    log.info('idle %.0fs, model unloaded (cuda reserved now %.0f MB)', IDLE_SEC,
             torch.cuda.memory_reserved() / 2**20 if torch.cuda.is_available() else 0)


def idle_watch():
    while True:
        time.sleep(30)
        if STATE['model'] is not None and time.time() - STATE['last'] > IDLE_SEC:
            with LOCK:
                if STATE['model'] is not None and time.time() - STATE['last'] > IDLE_SEC:
                    unload_model()
                    # 2026-10-25 主人：不用就关。卸了模型进程还攥着几 GB 内存，干脆整个退出；要说话时桥接 / 姐姐会再拉起来
                    log.info('idle, service exits (started again on demand)')
                    logging.shutdown()
                    os._exit(0)


def use_weights(name):
    if STATE['loaded'] == name:
        return
    STATE['model'].model.llm.load_state_dict(STATE['weights'][name], strict=True)
    STATE['model'].model.llm.eval()
    STATE['loaded'] = name


def spk_id(name, v):
    # 按参考音频+原文缓存（试音时临时换参考也不会串）
    sid = 'v_' + hashlib.sha256(f"{v['ref']}|{v['ref_text']}".encode()).hexdigest()[:12]
    if sid not in STATE['spk']:
        voice = STATE['model']
        ref = (ROOT / v['ref']).resolve() if not Path(v['ref']).is_absolute() else Path(v['ref'])
        prompt = voice.frontend.text_normalize(PREFIX + v['ref_text'], split=False, text_frontend=True)
        voice.add_zero_shot_spk(prompt, str(ref), sid)
        STATE['spk'].add(sid)
    return sid


def post_process(src, dst, v):
    """变调 / 音色微调（ffmpeg，不过模型）。pitch 是半音，formant 是共振峰系数（1=不变）。"""
    pitch = float(v.get('pitch', 0) or 0)
    eq = v.get('eq')  # 例如 "equalizer=f=3000:t=q:w=1:g=-3"
    filters = []
    if pitch:
        ratio = 2 ** (pitch / 12)
        # rubberband 保留时长只变调；formant=preserved 让声音不至于变成花栗鼠/大叔
        filters.append(f"rubberband=pitch={ratio:.5f}:formant={v.get('formant', 'preserved')}")
    if eq:
        filters.append(eq)
    if not filters:
        os.replace(src, dst)
        return
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', str(src), '-af', ','.join(filters), str(dst)], check=True, timeout=60)
    os.remove(src)


def speak(text, name, override=None):
    v = STATE['voices'].get(name)
    if not v:
        raise ValueError(f'没有这个声音：{name}（voices.json 里有：{", ".join(STATE["voices"])}）')
    # 试音：临时改几个参数（pitch / speed / formant / eq / ref / ref_text / weights / instruct / seed），不写进 voices.json
    v = {**v, **(override or {})}
    key = hashlib.sha256(json.dumps([text, name, v], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
    OUT.mkdir(exist_ok=True)
    dst = OUT / f'{key}.wav'
    if dst.exists() and dst.stat().st_size > 2048:
        return dst, None
    from cosyvoice.utils.common import set_all_random_seed
    with LOCK:
        t = time.perf_counter()
        ensure_model()
        use_weights(v.get('weights', 'cute'))
        sid = spk_id(name, v)
        set_all_random_seed(int(v.get('seed', 42)))
        voice = STATE['model']
        with torch.inference_mode():
            if v.get('instruct'):
                ref = (ROOT / v['ref']).resolve()
                gen = voice.inference_instruct2(text, f"You are a helpful assistant. {v['instruct']}<|endofprompt|>", str(ref),
                                                zero_shot_spk_id='', stream=False, speed=float(v.get('speed', 1.0)))
            else:
                gen = voice.inference_zero_shot(text, '', '', zero_shot_spk_id=sid, stream=False, speed=float(v.get('speed', 1.0)))
            audio = np.concatenate([x['tts_speech'].detach().cpu().numpy()[0] for x in gen])
        assert len(audio) > 2400 and np.isfinite(audio).all() and abs(audio).max() > 1e-4, '没合成出声音'
        gain = min(1.0, 0.98 / float(abs(audio).max()))
        raw = OUT / f'{key}.raw.wav'
        sf.write(raw, audio * gain, voice.sample_rate, subtype='PCM_16')
        post_process(raw, dst, v)
        took = time.perf_counter() - t
        STATE['last'] = time.time()
    log.info('[%s] %.1fs audio in %.1fs (llm %.1fs, wav %.1fs): %s', name, len(audio) / voice.sample_rate, took, STATE['t']['llm'], STATE['t']['wav'], text[:30])
    STATE['t'] = {'llm': 0.0, 'wav': 0.0}
    return dst, took


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'loaded': STATE['model'] is not None, 'voices': list(STATE['voices'])})
        self._json(404, {'ok': False})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
            if self.path == '/reload':
                with LOCK:
                    load_voices()
                return self._json(200, {'ok': True, 'voices': list(STATE['voices'])})
            if self.path == '/speak':
                text = str(req.get('text') or '').strip()
                if not text or len(text) > 300:
                    return self._json(400, {'ok': False, 'error': '要说的话为空或超过 300 字'})
                path, took = speak(text, str(req.get('voice') or 'feiyu-cute'), req.get('override') if isinstance(req.get('override'), dict) else None)
                return self._json(200, {'ok': True, 'path': str(path), 'took': took})
            self._json(404, {'ok': False})
        except Exception as e:  # noqa: BLE001 — 合成失败要把原因带回给桥接
            log.exception('speak failed')
            self._json(500, {'ok': False, 'error': f'{type(e).__name__}: {e}'})


def main():
    port = int(os.environ.get('FEIYU_TTS_PORT', '9881'))
    load_voices()
    os.chdir(REPO)
    threading.Thread(target=idle_watch, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    log.info('listening on 127.0.0.1:%d', port)
    server.serve_forever()


if __name__ == '__main__':
    main()

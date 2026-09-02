#!/usr/bin/env python3
"""
查字宝 - 云端语音代理服务 v3
==============================
  POST /api/asr  — 语音识别
  GET  /api/tts  — 语音合成（edge-tts 微软晓晓，免费无 key）
  GET  /api/ping — 健康检查

识别引擎（全部服务器本地推理，无 key、无外呼，语音不落盘）：
  1. SenseVoice-small via sherpa-onnx（默认）— 阿里 FunASR 中文专用模型，int8 CPU
     实测 0.3s 音频 15ms 返回（whisper-small 为 2s 级），中文短语音/单字显著更准。
     安装：pip install sherpa-onnx opencc numpy
     模型（约 240MB，两件）：
       mkdir -p /opt/chazi-voice/sensevoice
       curl -L -o /tmp/sv.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
       tar xjf /tmp/sv.tar.bz2 -C /tmp/sv --strip-components=1
       cp /tmp/sv/model.int8.onnx /tmp/sv/tokens.txt /opt/chazi-voice/sensevoice/
     （服务器连 GitHub 慢时：本机下载后 scp 上去即可；路径用 SENSEVOICE_DIR 环境变量覆盖）
  2. faster-whisper（自动回退）— 未装 sherpa-onnx/模型文件缺失/识别异常时启用，
     模型由 WHISPER_MODEL 控制（base/small）

引擎开关：环境变量 ASR_ENGINE = sensevoice(默认) | whisper
"""

import os, io, re, wave, hashlib, asyncio, threading, time
import numpy as np
from flask import Flask, request, Response, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "5001"))
# TTS 磁盘缓存：同一段文字的音频只生成一次，之后毫秒级返回
TTS_CACHE_DIR = os.environ.get("TTS_CACHE_DIR", "/opt/chazi-voice/tts-cache")
try:
    os.makedirs(TTS_CACHE_DIR, exist_ok=True)
except OSError:
    # 缓存目录不可写时降级到系统临时目录（只影响 TTS 缓存速度，不影响识别）
    import tempfile as _tf
    TTS_CACHE_DIR = os.path.join(_tf.gettempdir(), "chazi-tts-cache")
    os.makedirs(TTS_CACHE_DIR, exist_ok=True)
    print(f"[tts] 缓存目录降级到 {TTS_CACHE_DIR}", flush=True)

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")   # 回退引擎模型
ASR_ENGINE = os.environ.get("ASR_ENGINE", "sensevoice").lower()  # sensevoice | whisper
SENSEVOICE_DIR = os.environ.get("SENSEVOICE_DIR", "/opt/chazi-voice/sensevoice")
SV_MODEL_PATH = os.path.join(SENSEVOICE_DIR, "model.int8.onnx")
SV_TOKENS_PATH = os.path.join(SENSEVOICE_DIR, "tokens.txt")

# ── 识别引擎（常驻内存，启动时后台加载）────────────────────────
_sv_recognizer = None      # sherpa-onnx SenseVoice
_whisper_model = None      # faster-whisper 回退
ENGINE_STATUS = "未加载"   # 实际加载状态（/api/ping 如实上报，便于排查静默回退）
_model_lock = threading.Lock()
_infer_lock = threading.Lock()  # 推理串行化（单线程推理 15ms 级，串行足够）

_CN_DIGITS = "零一二三四五六七八九"

def digits_to_cn(text: str) -> str:
    """识别引擎开 ITN 会把口述数字转成阿拉伯数字（如"四"→"4"），查字场景必须转回汉字"""
    if not any("0" <= c <= "9" for c in text):
        return text
    return "".join(_CN_DIGITS[int(c)] if "0" <= c <= "9" else c for c in text)

def to_simplified(text: str) -> str:
    try:
        from opencc import OpenCC
        return OpenCC("t2s").convert(text)
    except Exception:
        return text

def postprocess(text: str) -> str:
    """公共后处理：去识别标签/标点 → 繁转简 → 数字转汉字"""
    text = re.sub(r"<\|[^|]*\|>", "", text)      # SenseVoice 语言/情感标签 <|zh|><|NEUTRAL|>…
    text = re.sub(r"[。．，、；？！?!,.;:：''\"…\s]+", "", text)  # 短语音识别常带句号
    text = to_simplified(text)
    return digits_to_cn(text).strip()

def wav_bytes_to_samples(wav_bytes: bytes):
    """前端上传的 WAV → (float32 samples, 采样率)"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0, sr

# ── SenseVoice-small（主引擎，sherpa-onnx）─────────────────────
def get_sensevoice():
    global _sv_recognizer
    if ASR_ENGINE != "sensevoice":
        return None
    if _sv_recognizer is None:
        with _model_lock:
            if _sv_recognizer is None:
                if not (os.path.exists(SV_MODEL_PATH) and os.path.exists(SV_TOKENS_PATH)):
                    print(f"[asr] 未找到模型文件 {SV_MODEL_PATH}，回退 faster-whisper", flush=True)
                    return None
                import sherpa_onnx
                _sv_recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                    model=SV_MODEL_PATH,
                    tokens=SV_TOKENS_PATH,
                    num_threads=min(4, os.cpu_count() or 2),
                    use_itn=True,
                    language="zh",
                )
                print("[asr] SenseVoice-small(sherpa-onnx) 就绪 ✓", flush=True)
                globals()["ENGINE_STATUS"] = "SenseVoice-small ✓"
    return _sv_recognizer

def sensevoice_asr(wav_bytes: bytes):
    """SenseVoice 识别，返回 (文本, 时长秒)；引擎不可用时返回 (None, 0.0)"""
    rec = get_sensevoice()
    if rec is None:
        return None, 0.0
    samples, sr = wav_bytes_to_samples(wav_bytes)
    if samples.size < sr // 10:  # <0.1s 视为无效
        return "", len(samples) / sr
    with _infer_lock:
        stream = rec.create_stream()
        stream.accept_waveform(sr, samples)
        rec.decode_stream(stream)
        text = stream.result.text
    return postprocess(text), len(samples) / sr

# ── faster-whisper（回退引擎）──────────────────────────────────
def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        with _model_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel(
                    WHISPER_MODEL,
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=min(8, os.cpu_count() or 4),
                    num_workers=2,
                )
                globals()["ENGINE_STATUS"] = "faster-whisper(" + WHISPER_MODEL + ")（回退）"
    return _whisper_model

def whisper_asr(wav_bytes: bytes):
    """faster-whisper 识别，返回 (文本, 时长秒)"""
    model = get_whisper()
    segments, _info = model.transcribe(
        io.BytesIO(wav_bytes),
        language="zh",
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
        initial_prompt="以下是普通话的词语。",
    )
    text = "".join(s.text for s in segments).strip()
    return postprocess(text), getattr(_info, "duration", 0.0)

def recognize(wav_bytes: bytes):
    """统一入口：SenseVoice 优先，未装/异常自动回退 whisper。返回 (文本, 引擎名, 时长)"""
    try:
        text, dur = sensevoice_asr(wav_bytes)
        if text is not None:
            return text, "sensevoice", dur
    except Exception as e:
        print(f"[asr] sensevoice 异常({e})，本次回退 whisper", flush=True)
    text, dur = whisper_asr(wav_bytes)
    return text, "whisper-" + WHISPER_MODEL, dur

@app.route("/api/asr", methods=["POST"])
def asr_handler():
    raw = request.get_data(cache=True)  # 先取原始 body（表单类 Content-Type 下流会被 parse 消费）
    if request.files and "file" in request.files:
        audio_data = request.files["file"].read()
    else:
        audio_data = raw
    if not audio_data or len(audio_data) < 1024:
        return jsonify({"error": "音频数据过短"}), 400
    try:
        t0 = time.time()
        text, engine, dur = recognize(audio_data)
        print(f"[asr] {engine} {time.time()-t0:.2f}s (音频 {dur:.1f}s) -> {text!r}", flush=True)
        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── edge-tts 朗读 ────────────────────────────────────────────────
async def edge_tts_generate(text: str) -> bytes:
    import edge_tts
    communicate = edge_tts.Communicate(text, "zh-CN-XiaoxiaoNeural")
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)

@app.route("/api/tts", methods=["GET"])
def tts_handler():
    text = request.args.get("text", "").strip()
    if not text:
        return jsonify({"error": "缺少 text 参数"}), 400
    if len(text) > 200:
        return jsonify({"error": "文本过长"}), 400
    # 命中磁盘缓存直接返回（毫秒级）
    key = hashlib.md5(text.encode("utf-8")).hexdigest()
    cache_path = os.path.join(TTS_CACHE_DIR, key + ".mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 500:
        try:
            with open(cache_path, "rb") as f:
                return Response(f.read(), mimetype="audio/mpeg")
        except Exception:
            pass
    try:
        mp3_data = asyncio.run(edge_tts_generate(text))
        if not mp3_data:
            return jsonify({"error": "生成失败"}), 500
        try:
            with open(cache_path, "wb") as f:
                f.write(mp3_data)
        except Exception:
            pass
        return Response(mp3_data, mimetype="audio/mpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({
        "ok": True,
        "asr": True,
        "tts": True,
        "model": ENGINE_STATUS,
        "provider": "本地推理 SenseVoice/whisper + edge-tts (免费无key，无外呼)",
    })

if __name__ == "__main__":
    print(f"查字宝语音代理 v3 → http://0.0.0.0:{LISTEN_PORT}")
    print(f"  识别: {ASR_ENGINE}(主)" + (f" + faster-whisper({WHISPER_MODEL})回退" if ASR_ENGINE == "sensevoice" else ""))
    print("  朗读: edge-tts 晓晓")
    threading.Thread(
        target=lambda: (
            print("预热识别模型…", flush=True),
            get_sensevoice() if ASR_ENGINE == "sensevoice" else get_whisper(),
            print("模型就绪 ✓", flush=True),
        ),
        daemon=True,
    ).start()
    app.run(host="0.0.0.0", port=LISTEN_PORT, debug=False)

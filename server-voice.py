#!/usr/bin/env python3
"""
查字宝 - 云端语音代理服务 v3
==============================
  POST /api/asr  — 语音识别
  GET  /api/tts  — 语音合成（edge-tts 微软晓晓，免费无 key）
  GET  /api/ping — 健康检查

识别引擎链（按顺序自动回退）：
  1. 讯飞语音听写（商业，可选）— 配置了三个环境变量才启用：
       XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET
     开通：xfyun.cn 控制台创建应用 → 领取语音听写免费包（家用额度足够）
     失败/超限自动回退本地引擎，前端无感
  2. SenseVoice-small via sherpa-onnx — 阿里 FunASR 中文专用模型，int8 CPU
       模型：/opt/chazi-voice/sensevoice/{model.int8.onnx, tokens.txt}
  3. faster-whisper（最终兜底）— WHISPER_MODEL 控制（base/small）

引擎开关：环境变量 ASR_ENGINE = sensevoice(默认) | whisper（只影响本地引擎选择）
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

# ── 讯飞语音听写（商业引擎，可选）──────────────────────────────
# 开通：https://www.xfyun.cn → 控制台 → 创建应用（语音听写流式版，领取免费包）
# 环境变量：XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET（三者都设置才启用）
# 免费额度用完或调用失败时自动回退本地 SenseVoice，不影响可用性
XFYUN_APP_ID = os.environ.get("XFYUN_APP_ID", "").strip()
XFYUN_API_KEY = os.environ.get("XFYUN_API_KEY", "").strip()
XFYUN_API_SECRET = os.environ.get("XFYUN_API_SECRET", "").strip()
XFYUN_ENABLED = bool(XFYUN_APP_ID and XFYUN_API_KEY and XFYUN_API_SECRET)

def xfyun_asr(wav_bytes: bytes):
    """讯飞语音听写流式版。返回 (文本, 时长秒)；不可用/失败返回 (None, 0.0) 由调用方回退"""
    if not XFYUN_ENABLED:
        return None, 0.0
    import base64, hashlib, hmac, json, ssl
    from datetime import datetime
    from time import gmtime
    try:
        import websocket
    except ImportError:
        print("[asr] 讯飞已配置但缺 websocket-client，pip install websocket-client", flush=True)
        return None, 0.0

    samples, sr = wav_bytes_to_samples(wav_bytes)
    if samples.size < sr // 10:
        return "", len(samples) / sr
    if sr != 16000:
        # 讯飞 iat 只收 16k：重采样（前置 resample 已是带限抽取，这里线性即可）
        n = int(len(samples) * 16000 / sr)
        x_old = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)

    # —— 鉴权（官方 HmacSHA256 方案）——
    date = datetime.now(gmtime()).strftime("%a, %d %b %Y %H:%M:%S GMT")
    signature_origin = "host: iat-api.xfyun.cn\ndate: " + date + "\nGET /v2/iat HTTP/1.1"
    signature_sha = hmac.new(XFYUN_API_SECRET.encode(), signature_origin.encode(), hashlib.sha256).digest()
    import base64 as b64mod
    signature = b64mod.b64encode(signature_sha).decode()
    authorization_origin = ('api_key="' + XFYUN_API_KEY + '", algorithm="hmac-sha256", '
                            'headers="host date request-line", signature="' + signature + '"')
    authorization = b64mod.b64encode(authorization_origin.encode()).decode()
    from urllib.parse import urlencode
    url = "wss://iat-api.xfyun.cn/v2/iat?" + urlencode({"authorization": authorization, "date": date, "host": "iat-api.xfyun.cn"})

    # —— 流式发送：每帧 1280 字节（40ms），首帧带配置，末帧 status=2 ——
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    frame_size = 1280
    total_frames = (len(pcm) + frame_size - 1) // frame_size
    text_parts = []
    ws = websocket.create_connection(url, timeout=10, sslopt={"cert_reqs": ssl.CERT_NONE})
    try:
        for i in range(total_frames):
            chunk = pcm[i * frame_size:(i + 1) * frame_size]
            status = 2 if i == total_frames - 1 else (0 if i == 0 else 1)
            frame = {"data": {"status": status, "format": "audio/L16;rate=16000", "encoding": "raw", "audio": base64.b64encode(chunk).decode()}}
            if status == 0:
                frame["common"] = {"app_id": XFYUN_APP_ID}
                frame["business"] = {"language": "zh_cn", "domain": "iat", "accent": "mandarin", "vad_eos": 3000, "dwa": "wpgs"}
            ws.send(json.dumps(frame))
            resp = json.loads(ws.recv())
            code = resp.get("code", -1)
            if code != 0:
                raise RuntimeError("讯飞 code=%s %s" % (code, resp.get("message", "")))
            data = resp.get("data") or {}
            result = data.get("result") or {}
            ws_list = result.get("ws") or []
            for seg in ws_list:
                for cw in seg.get("cw") or []:
                    w = cw.get("w", "")
                    if w:
                        text_parts.append(w)
            if data.get("status") == 2:
                break
    finally:
        try:
            ws.close()
        except Exception:
            pass
    text = postprocess("".join(text_parts))
    return text, len(samples) / 16000

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
    """统一入口：讯飞(已配置时) → SenseVoice → whisper，逐级自动回退。返回 (文本, 引擎名, 时长)"""
    if XFYUN_ENABLED:
        try:
            text, dur = xfyun_asr(wav_bytes)
            if text is not None:
                return text, "xfyun", dur
        except Exception as e:
            print(f"[asr] 讯飞异常({e})，回退本地引擎", flush=True)
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
        "model": ("讯飞语音听写 → " if XFYUN_ENABLED else "") + ENGINE_STATUS,
        "provider": ("讯飞(商业) + " if XFYUN_ENABLED else "") + "本地推理 SenseVoice/whisper + edge-tts",
    })

if __name__ == "__main__":
    print(f"查字宝语音代理 v3 → http://0.0.0.0:{LISTEN_PORT}")
    xfyun_tip = " + 讯飞商业(已配置)" if XFYUN_ENABLED else "（讯飞未配置，设 XFYUN_APP_ID/XFYUN_API_KEY/XFYUN_API_SECRET 启用）"
    print(f"  识别: {ASR_ENGINE}(主)" + xfyun_tip + (f" + faster-whisper({WHISPER_MODEL})回退" if ASR_ENGINE == "sensevoice" else ""))
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

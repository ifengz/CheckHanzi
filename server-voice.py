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
    """公共后处理：去识别标签/标点 → 繁转简 → 数字转汉字。
    空格只删「非英文语境」的：英文词间空格必须保留（"ice cream" 不能被拼成 "icecream"），
    汉字/拼音之间的空格照删（短语音识别常带句号、词间空格）"""
    text = re.sub(r"<\|[^|]*\|>", "", text)      # SenseVoice 语言/情感标签 <|zh|><|NEUTRAL|>…
    text = re.sub(r"[。．，、；？！?!,.;:：''\"…]+", "", text)  # 短语音识别常带句号（英文词不含 . ,，可安全删）
    text = re.sub(r"(?<![A-Za-z])\s+(?![A-Za-z])", "", text)  # 两侧都不是英文单词的空格 → 删
    text = re.sub(r"\s{2,}", " ", text).strip()               # 多余空格归一
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
    """讯飞中英识别大模型（iat.xf-yun.com/v1 免费包）。返回 (文本, 时长秒)；失败返回 (None, 0.0) 由调用方回退"""
    if not XFYUN_ENABLED:
        return None, 0.0
    import base64, hashlib, hmac, json, ssl
    from email.utils import formatdate
    try:
        import websocket
    except ImportError:
        print("[asr] 讯飞已配置但缺 websocket-client，pip install websocket-client", flush=True)
        return None, 0.0

    samples, sr = wav_bytes_to_samples(wav_bytes)
    if samples.size < sr // 10:
        return "", len(samples) / sr
    if sr != 16000:
        # 讯飞只收 16k：线性重采样兜底（前端上传的已是 16k）
        n = int(len(samples) * 16000 / sr)
        x_old = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)

    # —— 鉴权（大模型接口，时钟偏差需 <=300s）——
    date = formatdate(usegmt=True)
    signature_origin = "host: iat.xf-yun.com\ndate: " + date + "\nGET /v1 HTTP/1.1"
    signature = base64.b64encode(
        hmac.new(XFYUN_API_SECRET.encode(), signature_origin.encode(), hashlib.sha256).digest()).decode()
    authorization_origin = ('api_key="' + XFYUN_API_KEY + '", algorithm="hmac-sha256", '
                            'headers="host date request-line", signature="' + signature + '"')
    authorization = base64.b64encode(authorization_origin.encode()).decode()
    from urllib.parse import urlencode
    url = "wss://iat.xf-yun.com/v1?" + urlencode({"authorization": authorization, "date": date, "host": "iat.xf-yun.com"})

    # —— 发送：1280 字节/帧，全部发完再收结果；末帧空音频 status=2；不开 dwa（追加语义，解析简单）——
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    frame_size = 1280
    chunks = [pcm[i:i + frame_size] for i in range(0, len(pcm), frame_size)]
    text_parts = []
    ws = websocket.create_connection(url, timeout=10, sslopt={"cert_reqs": ssl.CERT_NONE})
    try:
        seq = 0
        for i, chunk in enumerate(chunks):
            seq += 1
            frame = {"header": {"app_id": XFYUN_APP_ID, "status": 0 if i == 0 else 1}}
            if i == 0:
                frame["parameter"] = {"iat": {
                    "domain": "slm", "language": "zh_cn", "accent": "mandarin", "eos": 6000,
                    "result": {"encoding": "utf8", "compress": "raw", "format": "json"}}}
            frame["payload"] = {"audio": {
                "encoding": "raw", "sample_rate": 16000, "channels": 1, "bit_depth": 16,
                "seq": seq, "status": 0 if i == 0 else 1,
                "audio": base64.b64encode(chunk).decode()}}
            ws.send(json.dumps(frame))
        # 末帧：空音频 + status=2
        seq += 1
        ws.send(json.dumps({
            "header": {"app_id": XFYUN_APP_ID, "status": 2},
            "payload": {"audio": {"encoding": "raw", "sample_rate": 16000, "channels": 1,
                                  "bit_depth": 16, "seq": seq, "status": 2, "audio": ""}}}))
        # —— 收结果：直到 header.status==2；text 为 base64(JSON)，JSON 里 ws[].cw[].w 取字 ——
        got_final = False
        for _ in range(len(chunks) + 20):
            try:
                resp = json.loads(ws.recv())
            except Exception:
                break
            header = resp.get("header") or {}
            if header.get("code", -1) != 0:
                raise RuntimeError("讯飞 code=%s %s" % (header.get("code"), header.get("message", "")))
            payload = resp.get("payload") or {}
            result = payload.get("result")
            if result and result.get("text"):
                obj = json.loads(base64.b64decode(result["text"]).decode("utf-8"))
                for seg in obj.get("ws") or []:
                    for cw in seg.get("cw") or []:
                        w = cw.get("w", "")
                        if w:
                            text_parts.append(w)
            if header.get("status") == 2 or (result and result.get("status") == 2):
                got_final = True
                break
        if not got_final and not text_parts:
            raise RuntimeError("讯飞未返回最终结果（超时）")
    finally:
        try:
            ws.close()
        except Exception:
            pass
    # 讯飞按词返回 token：汉字紧拼，英文单词之间补空格（否则 "Hello everyone" 拼成 "Helloeveryone"）
    joined = ""
    for w in text_parts:
        if joined and w and joined[-1].isascii() and joined[-1].isalpha() and w[0].isascii() and w[0].isalpha():
            joined += " "
        joined += w
    text = postprocess(joined)
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

def whisper_asr(wav_bytes: bytes, lang: str = "zh"):
    """faster-whisper 识别，返回 (文本, 时长秒)；lang 传 None 让 whisper 自动检测（英文词兜底用）。
    英文兜底走 beam=5：短音频（单词级）贪心解码极易错，多候选打分明显更准"""
    model = get_whisper()
    segments, _info = model.transcribe(
        io.BytesIO(wav_bytes),
        language=lang,
        vad_filter=True,
        beam_size=1 if lang == "zh" else 5,
        condition_on_previous_text=False,
        initial_prompt=None if lang is None else "以下是普通话的词语。",
    )
    text = "".join(s.text for s in segments).strip()
    return postprocess(text), getattr(_info, "duration", 0.0)

def recognize(wav_bytes: bytes):
    """统一入口：讯飞(已配置时) → SenseVoice → whisper，逐级自动回退。返回 (文本, 引擎名, 时长)"""
    if XFYUN_ENABLED:
        try:
            text, dur = xfyun_asr(wav_bytes)
            if text is not None:
                if text:
                    return text, "xfyun", dur
                # 讯飞返回空（中文短语听不清 / 英文单词 zh_cn 引擎常为空）→ whisper 自动语种补一轮
                try:
                    wtext, wdur = whisper_asr(wav_bytes, lang=None)
                    if wtext:
                        return wtext, "whisper-en", wdur
                except Exception as e:
                    print(f"[asr] whisper 补识别异常({e})", flush=True)
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
    # 音频留存（诊断用）：最近 10 条，覆盖式，排查"识别不准"时把真实上传音频拉下来分析
    try:
        import glob as _glob
        _dbg = "/opt/chazi-voice/audio-debug"
        os.makedirs(_dbg, exist_ok=True)
        _old = sorted(_glob.glob(_dbg + "/*.wav"))
        if len(_old) >= 10:
            for _f in _old[:len(_old) - 9]:
                os.remove(_f)
        with open(_dbg + "/%s.wav" % time.strftime("%H%M%S"), "wb") as _f:
            _f.write(audio_data)
    except Exception:
        pass
    try:
        t0 = time.time()
        text, engine, dur = recognize(audio_data)
        print(f"[asr] {engine} {time.time()-t0:.2f}s (音频 {dur:.1f}s) -> {text!r}", flush=True)
        provider = {"xfyun": "讯飞"}.get(engine, "本地")
        return jsonify({"text": text, "provider": provider})
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
                # 长缓存：同一个字内容不变，iPad 浏览器本地缓存后第二次点击零请求
                return Response(f.read(), mimetype="audio/mpeg", headers={"Cache-Control": "public, max-age=31536000, immutable"})
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
        return Response(mp3_data, mimetype="audio/mpeg", headers={"Cache-Control": "public, max-age=31536000, immutable"})
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
            # SenseVoice 先就绪（中文主路径）；whisper 也后台预热——
            # 否则讯飞空结果转英文兜底时冷加载要 5-7 秒（日志实测），孩子端就是"没响应"
            get_sensevoice() if ASR_ENGINE == "sensevoice" else get_whisper(),
            get_whisper(),
            print("模型就绪 ✓", flush=True),
        ),
        daemon=True,
    ).start()
    app.run(host="0.0.0.0", port=LISTEN_PORT, debug=False)

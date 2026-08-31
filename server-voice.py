#!/usr/bin/env python3
"""
查字宝 - 云端语音代理服务 v2
==============================
  POST /api/asr  — 语音识别（faster-whisper small，服务器本地，免费无 key）
  GET  /api/tts  — 语音合成（edge-tts 微软晓晓，免费无 key）
  GET  /api/ping — 健康检查

无需任何 API key，全部跑在服务器本地。断网/服务不可用时前端自动回退本地引擎。
"""

import os, io, asyncio, threading, time
from flask import Flask, request, Response, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "5001"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")  # base 快(2s) + opencc 转简体

# ── faster-whisper 模型（常驻内存，启动时加载一次）──────────────
_model = None
_model_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel
                _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model

def whisper_asr(wav_bytes: bytes) -> str:
    """用 faster-whisper 识别音频，返回简体中文文本"""
    model = get_model()
    segments, _info = model.transcribe(
        io.BytesIO(wav_bytes),
        language="zh",
        vad_filter=True,
        beam_size=1,
    )
    text = "".join(s.text for s in segments).strip()
    # faster-whisper base 可能输出繁体（蘋果），转成简体
    try:
        from opencc import OpenCC
        text = OpenCC("t2s").convert(text)
    except Exception:
        pass
    return text


@app.route("/api/asr", methods=["POST"])
def asr_handler():
    audio_data = None
    if request.files and "file" in request.files:
        audio_data = request.files["file"].read()
    else:
        audio_data = request.get_data()
    if not audio_data or len(audio_data) < 1024:
        return jsonify({"error": "音频数据过短"}), 400
    try:
        t0 = time.time()
        text = whisper_asr(audio_data)
        print(f"[asr] {time.time()-t0:.2f}s -> {text!r}", flush=True)
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
    try:
        mp3_data = asyncio.run(edge_tts_generate(text))
        if not mp3_data:
            return jsonify({"error": "生成失败"}), 500
        return Response(mp3_data, mimetype="audio/mpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({
        "ok": True,
        "asr": True,
        "tts": True,
        "model": WHISPER_MODEL,
        "provider": "faster-whisper + edge-tts (免费无 key)",
    })


if __name__ == "__main__":
    print(f"查字宝语音代理 v2 → http://0.0.0.0:{LISTEN_PORT}")
    print(f"  识别: faster-whisper({WHISPER_MODEL})  朗读: edge-tts 晓晓")
    threading.Thread(target=lambda: (print("预热模型…", flush=True), get_model(), print("模型就绪 ✓", flush=True)), daemon=True).start()
    app.run(host="0.0.0.0", port=LISTEN_PORT, debug=False)
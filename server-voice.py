#!/usr/bin/env python3
"""
查字宝 - 云端语音代理服务
======================
提供两个端点：
  POST /api/asr  — 语音识别（Groq Whisper large-v3）
  GET  /api/tts  — 语音合成（edge-tts 微软晓晓）

环境变量：
  GROQ_API_KEY — Groq 免费 key（必填，否则 ASR 不可用）
  LISTEN_PORT  — 监听端口（默认 5001）

部署：宝塔 node 项目 / systemd 均可
"""

import os, io, asyncio, base64, tempfile, wave, sys
from flask import Flask, request, Response, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # 允许跨域

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "5001"))

# ── 语音识别（Groq Whisper large-v3）──────────────────────────────
def groq_asr(wav_bytes: bytes) -> str:
    """调用 Groq Whisper large-v3，返回识别文本"""
    import groq
    client = groq.Groq(api_key=GROQ_API_KEY)
    # Groq 接受文件上传，需要文件名
    transcription = client.audio.transcriptions.create(
        file=("audio.wav", io.BytesIO(wav_bytes), "audio/wav"),
        model="whisper-large-v3",
        language="zh",
        response_format="text",
    )
    return transcription.strip() if transcription else ""


@app.route("/api/asr", methods=["POST"])
def asr_handler():
    # 检查 key
    if not GROQ_API_KEY:
        return jsonify({"error": "GROQ_API_KEY 未配置"}), 503

    # 接收音频：支持 multipart/form-data（file 字段）或 raw body
    audio_data = None
    if request.files and "file" in request.files:
        audio_data = request.files["file"].read()
    else:
        audio_data = request.get_data()

    if not audio_data or len(audio_data) < 1024:
        return jsonify({"error": "音频数据过短"}), 400

    try:
        text = groq_asr(audio_data)
        if not text:
            return jsonify({"text": ""}), 200
        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 语音合成（edge-tts 微软晓晓）──────────────────────────────────
async def edge_tts_generate(text: str) -> bytes:
    """调用 edge-tts 生成 mp3 音频"""
    import edge_tts
    # 中文顶级音色
    voice = "zh-CN-XiaoxiaoNeural"
    communicate = edge_tts.Communicate(text, voice)
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


# ── 健康检查 ───────────────────────────────────────────────────────
@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({
        "ok": True,
        "groq": bool(GROQ_API_KEY),
        "asr": bool(GROQ_API_KEY),
        "tts": True,
    })


# ── 启动 ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not GROQ_API_KEY:
        print("⚠️  GROQ_API_KEY 未设置，ASR 将不可用")
    print(f"查字宝语音代理启动 → http://0.0.0.0:{LISTEN_PORT}")
    print(f"  TTS 端点:  GET /api/tts?text=好")
    if GROQ_API_KEY:
        print(f"  ASR 端点:  POST /api/asr (multipart/form-data file=audio.wav)")
    app.run(host="0.0.0.0", port=LISTEN_PORT, debug=False)
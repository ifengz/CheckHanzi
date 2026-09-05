#!/usr/bin/env bash
# 英文识别实验：合成英文单词音频，分别用 zh_cn / en_us 两种讯飞配置识别，对比结果
set -euo pipefail
PY=/opt/chazi-voice/venv/bin/python

: "$XFYUN_APP_ID" "$XFYUN_API_KEY" "$XFYUN_API_SECRET"  # 由 ssh 命令前缀传入，set -u 校验

$PY - <<'PYEOF'
import os, sys, io, wave, json, base64, hashlib, hmac, ssl, asyncio, subprocess, tempfile
from email.utils import formatdate
from urllib.parse import urlencode
import numpy as np

try:
    import websocket
    import edge_tts
except ImportError as e:
    print("缺依赖:", e); sys.exit(1)

APP_ID = os.environ["XFYUN_APP_ID"]; KEY = os.environ["XFYUN_API_KEY"]; SECRET = os.environ["XFYUN_API_SECRET"]

def xfyun(audio_bytes, language, accent, encoding="lame", sample_rate=16000):
    chunks = [audio_bytes[i:i+1280] for i in range(0, len(audio_bytes), 1280)]
    date = formatdate(usegmt=True)
    origin = "host: iat.xf-yun.com" + chr(10) + "date: " + date + chr(10) + "GET /v1 HTTP/1.1"
    sig = base64.b64encode(hmac.new(SECRET.encode(), origin.encode(), hashlib.sha256).digest()).decode()
    auth = base64.b64encode(('api_key="' + KEY + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + sig + '"').encode()).decode()
    url = "wss://iat.xf-yun.com/v1?" + urlencode({"authorization": auth, "date": date, "host": "iat.xf-yun.com"})
    ws = websocket.create_connection(url, timeout=10, sslopt={"cert_reqs": ssl.CERT_NONE})
    parts = []
    try:
        for i, c in enumerate(chunks):
            f = {"header": {"app_id": APP_ID, "status": 0 if i == 0 else 1}}
            if i == 0:
                f["parameter"] = {"iat": {"domain": "slm", "language": language, "accent": accent, "eos": 6000,
                                          "result": {"encoding": "utf8", "compress": "raw", "format": "json"}}}
            f["payload"] = {"audio": {"encoding": encoding, "sample_rate": sample_rate, "channels": 1,
                                      "seq": i+1, "status": 0 if i == 0 else 1, "audio": base64.b64encode(c).decode()}}
            ws.send(json.dumps(f))
        ws.send(json.dumps({"header": {"app_id": APP_ID, "status": 2},
                            "payload": {"audio": {"encoding": encoding, "sample_rate": sample_rate, "channels": 1,
                                                  "seq": len(chunks)+1, "status": 2, "audio": ""}}}))
        for _ in range(len(chunks) + 20):
            try:
                resp = json.loads(ws.recv())
            except Exception:
                break
            h = resp.get("header") or {}
            if h.get("code", -1) != 0:
                return "ERR %s %s" % (h.get("code"), h.get("message", ""))
            pl = resp.get("payload") or {}
            res = pl.get("result")
            if res and res.get("text"):
                obj = json.loads(base64.b64decode(res["text"]).decode("utf-8"))
                for seg in obj.get("ws") or []:
                    for cw in seg.get("cw") or []:
                        w = cw.get("w", "")
                        if w: parts.append(w)
            if h.get("status") == 2 or (res and res.get("status") == 2):
                break
    finally:
        try: ws.close()
        except Exception: pass
    return "".join(parts) or "(空)"

words = ["here", "hear", "apple", "hello", "banana"]
d = tempfile.mkdtemp()
for wtext in words:
    mp3 = os.path.join(d, wtext + ".mp3")
    async def gen(path, t=wtext):
        com = edge_tts.Communicate(t, "en-US-GuyNeural")
        chunks = []
        async for ch in com.stream():
            if ch["type"] == "audio":
                chunks.append(ch["data"])
        open(path, "wb").write(b"".join(chunks))
    asyncio.run(gen(mp3))
    audio = open(mp3, "rb").read()
    zh = xfyun(audio, "zh_cn", "mandarin", "lame")
    en = xfyun(audio, "en_us", "american", "lame")
    print(f"{wtext:8s} zh_cn -> {zh!r:22s} en_us -> {en!r}")
PYEOF

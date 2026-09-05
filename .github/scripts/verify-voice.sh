#!/usr/bin/env bash
# 语音服务部署后验证：引擎加载状态 + 真实识别一次 + 服务日志
set -u
PORT=5001

echo "=== 1) ping —— model 字段应为 SenseVoice-small ==="
curl -s --max-time 5 "http://127.0.0.1:$PORT/api/ping"; echo

echo "=== 2) 生成测试语音并识别（验证 SenseVoice 通路）==="
/opt/chazi-voice/venv/bin/python - << 'PYEOF'
import io, wave, struct, math, urllib.request
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    for i in range(9600):
        hi = 1 if (i // 800) % 2 == 0 else -1
        w.writeframes(struct.pack("<h", int(6000 * hi * math.sin(2 * 3.14159265 * 440 * (i % 800) / 16000))))
req = urllib.request.Request(
    "http://127.0.0.1:5001/api/asr",
    data=buf.getvalue(),
    headers={"Content-Type": "application/octet-stream"},
)
print("asr result:", urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))
PYEOF

echo "=== 3) 服务最近日志 ===="
journalctl -u chazi-voice -n 8 --no-pager 2>/dev/null | tail -8 || tail -8 /opt/chazi-voice/voice.log 2>/dev/null || true

echo "=== 4) 内存与负载 ==="
free -m | head -3
nproc

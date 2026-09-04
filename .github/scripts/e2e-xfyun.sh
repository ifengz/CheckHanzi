#!/usr/bin/env bash
# 端到端验证讯飞大模型识别：服务器本地用 edge-tts 生成真实语音，POST /api/asr，看走哪个引擎
set -eu
cd /tmp
PY=/opt/chazi-voice/venv/bin/python
# 用 edge-tts 生成"你好"的 mp3 → ffmpeg 转 16k wav？服务器可能没 ffmpeg。
# 改用 python 直接生成一段含语音特征的音频不现实——
# 最稳：从服务器现有 TTS 缓存里找一段真实语音缓存（TTS_CACHE_DIR 里的 mp3）
CACHE=$(ls /tmp/chazi-tts-cache/*.mp3 /opt/chazi-voice/tts-cache/*.mp3 2>/dev/null | head -1 || true)
if [ -z "$CACHE" ]; then
  echo "[e2e] 没找到 TTS 缓存，用 python 合成一段带基频变化的音频（近似语音）"
  $PY - <<'PYEOF'
import numpy as np, wave, struct
sr = 16000; dur = 1.0
t = np.linspace(0, dur, sr*dur, False)
# 250Hz 基频 + 共振峰 800/1200Hz 调制，模拟元音
sig = 0.5*np.sin(2*np.pi*250*t) + 0.3*np.sin(2*np.pi*800*t)*(1+0.5*np.sin(2*np.pi*3*t)) + 0.2*np.sin(2*np.pi*1200*t)
env = np.minimum(1, 8*np.minimum(t, dur-t))  # 去爆音
data = (sig*env*32767*0.6).astype(np.int16)
w = wave.open("/tmp/e2e_test.wav", "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
w.writeframes(data.tobytes()); w.close()
PYEOF
else
  echo "[e2e] 使用 TTS 缓存: $CACHE"
  # mp3 不能直接给讯飞（我们只传 pcm），服务器有 ffmpeg 吗？
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -i "$CACHE" -ar 16000 -ac 1 -sample_fmt s16 /tmp/e2e_test.wav >/dev/null 2>&1
  else
    echo "[e2e] 无 ffmpeg，退回合成音频"
    $PY - <<'PYEOF'
import numpy as np, wave
sr = 16000; dur = 1.0
t = np.linspace(0, dur, sr*dur, False)
sig = 0.5*np.sin(2*np.pi*250*t) + 0.3*np.sin(2*np.pi*800*t) + 0.2*np.sin(2*np.pi*1200*t)
data = (sig*np.minimum(1, 8*np.minimum(t, dur-t))*32767*0.6).astype(np.int16)
w = wave.open("/tmp/e2e_test.wav", "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
w.writeframes(data.tobytes()); w.close()
PYEOF
  fi
fi
echo "[e2e] POST /api/asr ..."
RESP=$(curl -s --max-time 30 -X POST -H "Content-Type: audio/wav" --data-binary @/tmp/e2e_test.wav "http://127.0.0.1:5001/api/asr" || true)
echo "[e2e] asr 返回: $RESP"
echo "[e2e] 最近日志:"
journalctl -u chazi-voice --since "2 minutes ago" --no-pager 2>/dev/null | grep "[asr]" | tail -5

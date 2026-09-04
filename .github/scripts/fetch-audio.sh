#!/usr/bin/env bash
# 拉取服务器上最近留存的识别音频到 Actions artifact
set -eu
echo "=== 服务器上的留存音频 ==="
ls -la /opt/chazi-voice/audio-debug/ 2>/dev/null || echo "(无留存)"
mkdir -p ./audio-out
scp -o StrictHostKeyChecking=no -i ~/.ssh/voice_deploy_key -P "${SSH_PORT:-22}" \
    "$SSH_USER@$SSH_HOST:/opt/chazi-voice/audio-debug/*.wav" ./audio-out/ 2>/dev/null || echo "(scp 拉取失败或为空)"
ls -la ./audio-out/ || true
echo "=== 各音频基本信息 ==="
for f in ./audio-out/*.wav; do
  [ -f "$f" ] || continue
  python3 - "$f" <<'PYEOF'
import sys, wave
f = sys.argv[1]
try:
    w = wave.open(f)
    print(f, "时长 %.1fs 采样率 %d" % (w.getnframes()/w.getframerate(), w.getframerate()))
except Exception as e:
    print(f, "非标准wav:", e)
PYEOF
done

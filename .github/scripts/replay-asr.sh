#!/usr/bin/env bash
# 回放真实留存音频（audio-debug 最近 10 条）走新识别链，验证音量归一/回退链效果
set -u
PY=/opt/chazi-voice/venv/bin/python
DIR=/opt/chazi-voice/audio-debug
ls -la "$DIR"/*.wav 2>/dev/null | tail -10 || { echo "[replay] 没有留存音频"; exit 0; }
for f in $(ls -t "$DIR"/*.wav 2>/dev/null | head -8); do
  RESP=$(curl -s --max-time 30 -X POST -H "Content-Type: audio/wav" --data-binary @"$f" "http://127.0.0.1:5001/api/asr" || true)
  DUR=$($PY -c "import wave,sys; w=wave.open('$f'); print(round(w.getnframes()/w.getframerate(),1))" 2>/dev/null || echo "?")
  echo "[replay] $(basename $f) (${DUR}s) -> $RESP"
done
echo "[replay] 引擎日志:"
journalctl -u chazi-voice --since "3 minutes ago" --no-pager 2>/dev/null | grep -F "[asr]" | grep -v 就绪 | tail -12

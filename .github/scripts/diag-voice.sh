#!/usr/bin/env bash
echo "=== unit 全文（XFYUN 值打码）==="
sed "s/XFYUN_API_SECRET=.*/XFYUN_API_SECRET=***/; s/XFYUN_API_KEY=.*/XFYUN_API_KEY=***/; s/XFYUN_APP_ID=.*/XFYUN_APP_ID=***/" /etc/systemd/system/chazi-voice.service
echo "=== server-voice.py 讯飞相关行 ==="
grep -n "XFYUN" /opt/chazi-voice/server-voice.py | sed "s/=.*/=***/" | head -8
md5sum /opt/chazi-voice/server-voice.py
echo "=== 进程实际环境 ==="
PID=$(pgrep -f server-voice.py | head -1)
tr "\0" "\n" < "/proc/$PID/environ" 2>/dev/null | grep "XFYUN" | sed "s/=.*/=***/"
echo "=== ping ==="
curl -s http://127.0.0.1:5001/api/ping; echo

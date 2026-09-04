#!/usr/bin/env bash
# 语音服务诊断：unit 环境变量 + 服务器代码版本 + 实际引擎状态
echo "=== unit 文件里的 XFYUN 行（值打码）==="
grep -c "Environment=XFYUN_" /etc/systemd/system/chazi-voice.service && echo "(数量如上，值不显示)"
systemctl show chazi-voice -p Environment 2>/dev/null | sed "s/XFYUN_API_SECRET=[^ ]*/XFYUN_API_SECRET=***/g; s/XFYUN_API_KEY=[^ ]*/XFYUN_API_KEY=***/g"
echo "=== 服务器上 server-voice.py 的讯飞代码 ==="
grep -n "XFYUN_ENABLED" /opt/chazi-voice/server-voice.py | head -3
echo "=== 实际 ping ==="
curl -s http://127.0.0.1:5001/api/ping; echo
echo "=== 最近识别日志（若已测试）==="
journalctl -u chazi-voice --since "10 minutes ago" --no-pager 2>/dev/null | grep "[asr]" | tail -10

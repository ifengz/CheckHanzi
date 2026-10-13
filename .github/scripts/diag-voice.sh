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
echo "=== 粤语朗读凭据是否就位（只报有无与区域，绝不打印密钥）==="
grep -c "^Environment=AZURE_SPEECH_KEY=" /etc/systemd/system/chazi-voice.service 2>/dev/null | sed "s/^/unit 内 AZURE_SPEECH_KEY 条数: /"
grep -o "^Environment=AZURE_SPEECH_REGION=[^ ]*" /etc/systemd/system/chazi-voice.service 2>/dev/null | sed "s/^/unit 区域: /"
grep -o "^EnvironmentFile=.*" /etc/systemd/system/chazi-voice.service 2>/dev/null | sed "s/^/unit 挂了: /"
ls -l /opt/chazi-voice/env 2>/dev/null | sed "s/^/env 文件: /" || echo "env 文件: 不存在"
tr "\0" "\n" < "/proc/$PID/environ" 2>/dev/null | grep -c "^AZURE_SPEECH_KEY=" | sed "s/^/运行进程有 KEY 条数: /"
tr "\0" "\n" < "/proc/$PID/environ" 2>/dev/null | grep -o "^AZURE_SPEECH_REGION=.*" | sed "s/^/运行进程区域: /"
echo "=== 粤语失败到底卡在哪一步（只取文案）==="
{ tail -400 /opt/chazi-voice/voice.log 2>/dev/null; journalctl -u chazi-voice.service --no-pager -n 400 2>/dev/null; } \
  | grep -o "粤语朗读未配置\|Azure 合成失败 HTTP [0-9]*\|Azure 不接受这个读法 HTTP [0-9]*\|连不上上游" | sort | uniq -c
echo "=== drop-in 与合并后的 unit 环境 ==="
ls -l /etc/systemd/system/chazi-voice.service.d/ 2>/dev/null || echo "无 drop-in 目录"
systemctl show -p Environment --value chazi-voice.service 2>/dev/null | tr " " "\n" | grep -c "^AZURE_SPEECH_KEY=" | sed "s/^/合并后 unit 有 KEY 条数: /"
systemctl show -p EnvironmentFiles --value chazi-voice.service 2>/dev/null | sed "s/^/unit EnvironmentFiles: /"
echo "=== 时间线：未配置 与 打到 Azure 的首末各一条 ==="
journalctl -u chazi-voice.service --no-pager 2>/dev/null > /tmp/cv.log
grep "粤语朗读未配置" /tmp/cv.log | sed -n "1p;\$p" | cut -c1-72 | sed "s/^/[未配置] /"
grep "Azure" /tmp/cv.log | sed -n "1p;\$p" | cut -c1-96 | sed "s/^/[打到Azure] /"
grep -c "粤语朗读未配置" /tmp/cv.log | sed "s/^/未配置条数: /"
grep -c "Azure 合成失败\|Azure 不接受" /tmp/cv.log | sed "s/^/打到Azure条数: /"
systemctl show -p ActiveEnterTimestamp --value chazi-voice.service | sed "s/^/本进程启动于: /"

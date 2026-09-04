#!/usr/bin/env bash
# 配置讯飞引擎：三个值由 Actions Secrets 经 ssh 命令前缀环境变量传入（日志自动打码）
# 用 systemd drop-in 目录写入（不动主 unit，幂等），重启后 ping 验证
set -eu
UNIT=chazi-voice.service

fail(){ echo "[xfyun-setup] FATAL: $*"; exit 1; }
[ -n "${XFYUN_APP_ID:-}" ] || fail "XFYUN_APP_ID 未传入"
[ -n "${XFYUN_API_KEY:-}" ] || fail "XFYUN_API_KEY 未传入"
[ -n "${XFYUN_API_SECRET:-}" ] || fail "XFYUN_API_SECRET 未传入"

D="/etc/systemd/system/$UNIT.d"
mkdir -p "$D"
{
  printf '[Service]
'
  printf 'Environment=XFYUN_APP_ID=%s
' "$XFYUN_APP_ID"
  printf 'Environment=XFYUN_API_KEY=%s
' "$XFYUN_API_KEY"
  printf 'Environment=XFYUN_API_SECRET=%s
' "$XFYUN_API_SECRET"
} > "$D/xfyun.conf"
chmod 644 "$D/xfyun.conf"
echo "[xfyun-setup] drop-in 已写入: $D/xfyun.conf (值打码)"
systemctl daemon-reload
systemctl restart "$UNIT"
echo "[xfyun-setup] 已重启, 等待健康检查..."
for i in $(seq 1 20); do
  sleep 2
  RESP=$(curl -s --max-time 3 "http://127.0.0.1:5001/api/ping" 2>/dev/null || true)
  if echo "$RESP" | grep -q '"ok"'; then
    echo "[xfyun-setup] ping: $RESP"
    # 有讯飞 provider 前缀才算配置成功
    if echo "$RESP" | grep -q 'xfyun\|\u8baf\u98de'; then
      echo "[xfyun-setup] DONE OK (讯飞已启用)"
    else
      echo "[xfyun-setup] WARN: 服务正常但讯飞前缀未出现, 请检查 server-voice.py 是否最新"
    fi
    exit 0
  fi
done
echo "[xfyun-setup] FATAL: 健康检查失败"
journalctl -u "$UNIT" -n 15 --no-pager 2>/dev/null | tail -15
exit 1

#!/usr/bin/env bash
# 配置讯飞引擎：三个值由 Actions Secrets 经环境变量传入（日志自动打码），写入 chazi-voice.service 并重启验证
set -u
UNIT=chazi-voice.service

fail(){ echo "[xfyun-setup] FATAL: $*"; exit 1; }
[ -n "${XFYUN_APP_ID:-}" ] || fail "XFYUN_APP_ID 未传入"
[ -n "${XFYUN_API_KEY:-}" ] || fail "XFYUN_API_KEY 未传入"
[ -n "${XFYUN_API_SECRET:-}" ] || fail "XFYUN_API_SECRET 未传入"

UPATH=$(systemctl show -p FragmentPath --value "$UNIT")
[ -n "$UPATH" ] && [ -f "$UPATH" ] || fail "找不到 $UNIT 的 unit 文件"
echo "[xfyun-setup] unit: $UPATH"
export UNIT_PATH="$UPATH"

python3 - <<'PYEOF'
import os, sys
upath = os.environ.get("UNIT_PATH", "")
appid = os.environ.get("XFYUN_APP_ID", "")
key = os.environ.get("XFYUN_API_KEY", "")
secret = os.environ.get("XFYUN_API_SECRET", "")
lines = open(upath, encoding="utf-8").read().splitlines()
out, inserted = [], False
for ln in lines:
    if ln.startswith("Environment=XFYUN_"):
        continue
    out.append(ln)
    if ln.strip() == "[Service]":
        out.append("Environment=XFYUN_APP_ID=" + appid)
        out.append("Environment=XFYUN_API_KEY=" + key)
        out.append("Environment=XFYUN_API_SECRET=" + secret)
        inserted = True
if not inserted:
    print("[xfyun-setup] FATAL: no Service section")
    sys.exit(1)
open(upath, "w", encoding="utf-8").write("
".join(out) + "
")
print("[xfyun-setup] unit written (values hidden)")
PYEOF
# 去掉占位失败行（python 成功执行到这里说明 unit 已写入）
systemctl daemon-reload
systemctl restart "$UNIT"
echo "[xfyun-setup] restarted, waiting..."
for i in $(seq 1 20); do
  sleep 2
  RESP=$(curl -s --max-time 3 "http://127.0.0.1:5001/api/ping" 2>/dev/null || true)
  if echo "$RESP" | grep -q '"ok"'; then
    echo "[xfyun-setup] ping: $RESP"
    echo "[xfyun-setup] DONE OK"
    exit 0
  fi
done
echo "[xfyun-setup] FATAL: health check failed"
journalctl -u "$UNIT" -n 15 --no-pager 2>/dev/null | tail -15
exit 1

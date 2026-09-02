#!/usr/bin/env bash
# 查字宝语音服务自动部署脚本（在服务器上执行，由 GitHub Actions 通过 ssh 调起）
# 顺序：依赖自检/安装 → 模型就位(仅首次) → 重启(自动探测运行方式) → 健康检查
# 关键安全设计：依赖装好、模型就位之后才重启；健康检查不过则 CI 报红（服务不会静默挂掉）
set -u
APP_DIR=/opt/chazi-voice
SV_DIR="$APP_DIR/sensevoice"
PY=python3
PORT=5001

log(){ echo "[voice-deploy] $*"; }
fail(){ log "FATAL: $*"; exit 1; }

# ── 0) 基础检查 ─────────────────────────────────────────────
command -v "$PY" >/dev/null 2>&1 || fail "服务器没有 python3"
mkdir -p "$APP_DIR" 2>/dev/null || sudo -n mkdir -p "$APP_DIR" || fail "无法创建 $APP_DIR（用户无权限且无 sudo）"

# ── 1) 依赖自检：缺啥装啥，齐了秒过 ──────────────────────────
MISSING=""
for m in flask flask_cors edge_tts sherpa_onnx opencc numpy; do
  "$PY" -c "import $m" 2>/dev/null || MISSING="$MISSING $m"
done
if [ -n "$MISSING" ]; then
  log "安装缺失依赖:$MISSING"
  "$PY" -m pip install -q $MISSING || fail "依赖安装失败，请手动登录服务器执行 pip3 install $MISSING 查看报错"
fi

# ── 2) SenseVoice 模型就位（约240MB，仅首次下载，装过跳过）────
if [ ! -f "$SV_DIR/model.int8.onnx" ] || [ ! -f "$SV_DIR/tokens.txt" ]; then
  log "SenseVoice 模型缺失，开始下载（仅首次，约240MB）"
  mkdir -p "$SV_DIR" /tmp/sv-dl
  BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
  ok=0
  for u in "$BASE" "https://ghfast.top/$BASE" "https://gh-proxy.com/$BASE"; do
    log "尝试下载: $u"
    curl -fL --connect-timeout 10 --max-time 900 -o /tmp/sv-dl/sv.tar.bz2 "$u" && ok=1 && break
  done
  [ "$ok" = "1" ] || fail "模型下载失败。可从本机上传：scp /tmp/sv-onnx/model.int8.onnx /tmp/sv-onnx/tokens.txt 用户@服务器:$SV_DIR/ 后重新跑一次部署"
  tar xjf /tmp/sv-dl/sv.tar.bz2 -C /tmp/sv-dl --strip-components=1
  cp /tmp/sv-dl/model.int8.onnx /tmp/sv-dl/tokens.txt "$SV_DIR/"
  log "模型就位 ✓"
else
  log "模型已存在，跳过下载"
fi

# ── 3) 重启：自动探测运行方式 ────────────────────────────────
UNIT=""
command -v systemctl >/dev/null 2>&1 && \
  UNIT=$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '/chazi|voice/{print $1; exit}')
if [ -n "$UNIT" ]; then
  log "检测到 systemd 服务($UNIT)，restart"
  systemctl restart "$UNIT"
elif command -v supervisorctl >/dev/null 2>&1 && supervisorctl status 2>/dev/null | grep -qi "chazi\|voice"; then
  log "检测到 supervisor，restart"
  supervisorctl restart chazi-voice 2>/dev/null || supervisorctl restart all
else
  log "无 systemd/supervisor，pkill + nohup 兜底重启"
  pkill -f server-voice.py 2>/dev/null || true
  sleep 1
  cd "$APP_DIR" && nohup "$PY" server-voice.py >> "$APP_DIR/voice.log" 2>&1 &
fi

# ── 4) 健康检查：最多等 40 秒（含 SenseVoice 首次加载）────────
for i in $(seq 1 20); do
  sleep 2
  RESP=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)
  if echo "$RESP" | grep -q '"ok"'; then
    log "健康检查通过: $RESP"
    log "当前进程: $(pgrep -af server-voice.py || echo '未找到(可能由进程管理器以其他名字托管)')"
    log "部署完成 ✓"
    exit 0
  fi
done

log "健康检查失败（服务没在 $PORT 起来），最近日志："
tail -20 "$APP_DIR/voice.log" 2>/dev/null
journalctl -n 20 --no-pager 2>/dev/null | tail -20
exit 1

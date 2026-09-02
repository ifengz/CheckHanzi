#!/usr/bin/env bash
# 查字宝语音服务自动部署脚本（在服务器上执行，由 GitHub Actions 通过 ssh 调起）
# 策略：从运行中的进程反查真实解释器/工作目录/环境变量，依赖装进那个环境，
#       重启沿用 systemd/supervisor/原样三种方式自动探测；失败在杀进程前中止，绝不带崩线上。
set -u
APP_DIR=/opt/chazi-voice
SV_DIR="$APP_DIR/sensevoice"
PORT=5001

log(){ echo "[voice-deploy] $*"; }
fail(){ log "FATAL: $*"; exit 1; }

# ---- 0) 目录 & 现役进程探测 ----
mkdir -p "$APP_DIR" 2>/dev/null || sudo -n mkdir -p "$APP_DIR" || fail "无法创建 $APP_DIR"

PID=$(pgrep -f server-voice.py 2>/dev/null | head -1 || true)
EXE=""; CWD="$APP_DIR"; UNIT=""; PNAME=""
if [ -n "$PID" ]; then
  EXE=$(readlink -f "/proc/$PID/exe" 2>/dev/null || true)
  CWD=$(readlink -f "/proc/$PID/cwd" 2>/dev/null || echo "$APP_DIR")
  log "发现运行中的服务: PID=$PID"
  log "  解释器: ${EXE:-未知}"
  log "  工作目录: $CWD"
  if command -v systemctl >/dev/null 2>&1; then
    UNIT=$(systemctl status "$PID" --no-pager 2>/dev/null | grep -o "[a-zA-Z0-9_.@-]*[.]service" | head -1 || true)
    [ -n "$UNIT" ] && log "  托管方式: systemd($UNIT)"
  fi
  if [ -z "$UNIT" ]; then
    PPID_NUM=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d " ")
    PNAME=$(ps -o comm= -p "$PPID_NUM" 2>/dev/null || true)
    [ -n "$PNAME" ] && log "  父进程: $PNAME"
  fi
else
  log "未发现运行中的 server-voice.py 进程（可能服务已停）"
fi

# ---- 1) 依赖安装：装进进程真实使用的环境；没有进程就建专用 venv ----
if [ -n "$EXE" ] && [ -x "$EXE" ]; then
  PY="$EXE"
else
  log "创建专用虚拟环境 $APP_DIR/venv"
  if ! python3 -m venv "$APP_DIR/venv" 2>/dev/null; then
    apt-get install -y python3-venv >/dev/null 2>&1 || sudo -n apt-get install -y python3-venv
    python3 -m venv "$APP_DIR/venv" || fail "venv 创建失败"
  fi
  PY="$APP_DIR/venv/bin/python"
fi
log "依赖检查解释器: $PY"
MISSING=""
for m in flask flask_cors edge_tts sherpa_onnx opencc numpy; do
  "$PY" -c "import $m" 2>/dev/null || MISSING="$MISSING $m"
done
if [ -n "$MISSING" ]; then
  log "安装缺失依赖:$MISSING"
  "$PY" -m pip install $MISSING || \
    "$PY" -m pip install --break-system-packages $MISSING || \
    fail "依赖安装失败（解释器 $PY）"
fi
"$PY" -c "import sherpa_onnx" 2>/dev/null || fail "sherpa_onnx 仍不可用（$PY）"

# ---- 2) SenseVoice 模型就位（约240MB，仅首次）----
if [ ! -f "$SV_DIR/model.int8.onnx" ] || [ ! -f "$SV_DIR/tokens.txt" ]; then
  log "SenseVoice 模型缺失，开始下载（仅首次，约240MB，可能需要几分钟）"
  mkdir -p "$SV_DIR" /tmp/sv-dl
  BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
  ok=0
  for u in "$BASE" "https://ghfast.top/$BASE" "https://gh-proxy.com/$BASE"; do
    log "尝试下载: $u"
    curl -fL --connect-timeout 10 --max-time 900 -o /tmp/sv-dl/sv.tar.bz2 "$u" && ok=1 && break
  done
  [ "$ok" = "1" ] || fail "模型下载失败。可从本机上传：scp /tmp/sv-onnx/model.int8.onnx /tmp/sv-onnx/tokens.txt 用户@服务器:$SV_DIR/ 后重跑部署"
  tar xjf /tmp/sv-dl/sv.tar.bz2 -C /tmp/sv-dl --strip-components=1
  cp /tmp/sv-dl/model.int8.onnx /tmp/sv-dl/tokens.txt "$SV_DIR/"
  log "模型就位 OK"
else
  log "模型已存在，跳过下载"
fi

# ---- 3) 重启：沿用原托管方式，原样还原环境 ----
if [ -n "$PID" ] && [ -n "$UNIT" ]; then
  log "systemd 重启: $UNIT"
  systemctl restart "$UNIT"
elif [ -n "$PID" ] && [ "$PNAME" = "supervisord" ] && command -v supervisorctl >/dev/null 2>&1; then
  log "supervisor 重启"
  supervisorctl restart chazi-voice 2>/dev/null || supervisorctl restart all
elif [ -n "$PID" ]; then
  log "原样重启：同解释器 + 同工作目录 + 同环境变量"
  tr "\0" "\n" < "/proc/$PID/environ" > /tmp/voice_env.$$ 2>/dev/null || : > /tmp/voice_env.$$
  pkill -f server-voice.py 2>/dev/null || true
  sleep 1
  cd "$CWD"
  while IFS= read -r kv; do case "$kv" in *=*) export "$kv" ;; esac; done < /tmp/voice_env.$$
  rm -f /tmp/voice_env.$$
  nohup "$PY" server-voice.py >> "$APP_DIR/voice.log" 2>&1 &
  log "已用 $PY 在 $CWD 重新拉起"
else
  log "无原进程，用 $PY 直接启动"
  cd "$APP_DIR" && nohup "$PY" server-voice.py >> "$APP_DIR/voice.log" 2>&1 &
fi

# ---- 4) 健康检查：最多等 40 秒（含 SenseVoice 首次加载）----
for i in $(seq 1 20); do
  sleep 2
  RESP=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)
  if echo "$RESP" | grep -q '"ok"'; then
    log "健康检查通过: $RESP"
    log "当前进程: $(pgrep -af server-voice.py || echo 未找到)"
    log "部署完成 OK"
    exit 0
  fi
done

log "健康检查失败（服务没在 $PORT 起来），最近日志："
tail -25 "$APP_DIR/voice.log" 2>/dev/null
journalctl -n 25 --no-pager 2>/dev/null | tail -25
exit 1

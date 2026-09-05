#!/usr/bin/env bash
# 查字宝语音服务自动部署脚本 v3（在服务器上执行，由 GitHub Actions 通过 ssh 调起）
# 探测：/proc/PID/cmdline 取原始解释器（venv 入口，不做符号链接解析）
# 依赖：装进该解释器环境；若是系统 python（PEP668）则建专用 venv 并改 systemd unit 的 ExecStart
# 重启：systemd restart；失败在杀进程前中止，绝不带崩线上
set -u
APP_DIR=/opt/chazi-voice
RELEASE_DIR="$APP_DIR/incoming"
SV_DIR="$APP_DIR/sensevoice"
PORT=5001

log(){ echo "[voice-deploy] $*"; }
fail(){ log "FATAL: $*"; exit 1; }

# ---- 0) 目录 & 现役进程探测 ----
mkdir -p "$APP_DIR" 2>/dev/null || sudo -n mkdir -p "$APP_DIR" || fail "无法创建 $APP_DIR"

PID=$(pgrep -f server-voice.py 2>/dev/null | head -1 || true)
CMD0=""; UNIT=""
if [ -n "$PID" ]; then
  CMD0=$(tr "\0" "\n" < "/proc/$PID/cmdline" 2>/dev/null | head -1)
  log "发现运行中的服务: PID=$PID"
  log "  启动解释器(cmdline): $CMD0"
fi
if command -v systemctl >/dev/null 2>&1; then
  if [ -n "$PID" ]; then
    UNIT=$(systemctl status "$PID" --no-pager 2>/dev/null | grep -o "[a-zA-Z0-9_.@-]*[.]service" | head -1 || true)
  fi
  if [ -z "$UNIT" ]; then
    UNIT=$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk "/chazi|voice/{print \$1; exit}" || true)
  fi
  [ -n "$UNIT" ] && log "  托管方式: systemd($UNIT)"
fi
if [ -n "$UNIT" ]; then
  systemctl cat "$UNIT" 2>/dev/null | grep -E "^ExecStart=|^WorkingDirectory=" | sed "s/^/  [unit] /" || true
fi

# ---- 1) 选定依赖安装目标解释器 ----
# venv 判定：cmdline 的解释器路径存在、可执行、且不在 /usr /bin 系统目录下
PY=""
NEED_UNIT_PATCH=0
case "$CMD0" in
  /usr/bin/*|/bin/*|"" ) NEED_UNIT_PATCH=1 ;;
  * ) [ -x "$CMD0" ] && PY="$CMD0" || NEED_UNIT_PATCH=1 ;;
esac

if [ "$NEED_UNIT_PATCH" = "1" ]; then
  log "创建专用虚拟环境 $APP_DIR/venv（系统 python 受 PEP668 保护，不直接装）"
  if ! python3 -m venv "$APP_DIR/venv" 2>/dev/null; then
    apt-get install -y python3-venv >/dev/null 2>&1 || sudo -n apt-get install -y python3-venv
    python3 -m venv "$APP_DIR/venv" || fail "venv 创建失败"
  fi
  PY="$APP_DIR/venv/bin/python"
fi
log "依赖目标解释器: $PY"

MISSING=""
for m in flask flask_cors edge_tts sherpa_onnx opencc numpy websocket; do
  "$PY" -c "import $m" 2>/dev/null || MISSING="$MISSING $m"
done
if [ -n "$MISSING" ]; then
  # websocket 导入名对应 pip 包名是 websocket-client（pip install websocket 是废弃旧包，无 create_connection）
  PKGS=$(echo "$MISSING" | sed 's/\bwebsocket\b/websocket-client/g')
  log "安装缺失依赖:$PKGS"
  if ! "$PY" -m pip install $PKGS 2>&1 | tail -5; then
    if [ "$NEED_UNIT_PATCH" = "0" ]; then
      log "该解释器装依赖失败，改用专用 venv + 修改 systemd unit"
      python3 -m venv "$APP_DIR/venv" 2>/dev/null || fail "venv 创建失败"
      PY="$APP_DIR/venv/bin/python"
      "$PY" -m pip install $PKGS 2>&1 | tail -5 || fail "专用 venv 依赖安装失败"
    else
      fail "依赖安装失败（$PY）"
    fi
  fi
fi
# 若已误装废弃 websocket 包，强制替换为 websocket-client
if "$PY" -c "import websocket" 2>/dev/null && ! "$PY" -c "from websocket import create_connection" 2>/dev/null; then
  log "检测到废弃 websocket 包，替换为 websocket-client"
  "$PY" -m pip uninstall -y websocket 2>&1 | tail -2
  "$PY" -m pip install websocket-client 2>&1 | tail -3
fi
"$PY" -c "from websocket import create_connection" 2>/dev/null || fail "websocket-client 校验失败（$PY）"
"$PY" -c "import sherpa_onnx, flask, opencc, numpy" 2>/dev/null || fail "依赖校验不过（$PY）"

# The bundled, pinned FFmpeg build provides loudnorm without a system package change.
if ! "$PY" -c "import importlib.metadata; assert importlib.metadata.version('imageio-ffmpeg') == '0.6.0'" 2>/dev/null; then
  "$PY" -m pip install 'imageio-ffmpeg==0.6.0' || fail "FFmpeg 依赖安装失败"
fi
"$PY" -c "import os, subprocess, imageio_ffmpeg; binary = os.environ.get('FFMPEG_BIN') or imageio_ffmpeg.get_ffmpeg_exe(); result = subprocess.run([binary, '-hide_banner', '-filters'], capture_output=True, text=True, check=True, timeout=10); assert 'loudnorm' in result.stdout" || fail "FFmpeg loudnorm 校验失败"
log "依赖就绪 ✓"

# 若切换到了专用 venv 且是 systemd 托管：改 unit 的 ExecStart 指向 venv python（保留 Environment 等）
if [ "$NEED_UNIT_PATCH" = "1" ] && [ -n "$UNIT" ]; then
  UPATH=$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null)
  if [ -n "$UPATH" ] && [ -f "$UPATH" ]; then
    log "修改 $UPATH 的 ExecStart -> $PY（先备份 .bak）"
    cp "$UPATH" "$UPATH.bak"
    sed -i "s|^ExecStart=.*|ExecStart=$PY $APP_DIR/server-voice.py|" "$UPATH"
    systemctl daemon-reload
  fi
fi

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

# Validate staged data and routes before replacing the running release.
gzip -dc "$RELEASE_DIR/data/english/ecdict.sqlite3.gz" > "$RELEASE_DIR/data/english/ecdict.sqlite3.tmp" || fail "英文词库解压失败"
mv "$RELEASE_DIR/data/english/ecdict.sqlite3.tmp" "$RELEASE_DIR/data/english/ecdict.sqlite3" || fail "英文词库准备失败"
"$PY" "$RELEASE_DIR/.github/scripts/check-english.py" || fail "英文词库和接口校验失败"
"$PY" -m py_compile "$RELEASE_DIR/server-voice.py" "$RELEASE_DIR/voice_audio.py" "$RELEASE_DIR/english_lookup.py" || fail "后端语法检查失败"
mkdir -p "$APP_DIR/data/english" || fail "英文数据目录创建失败"
for name in ecdict.sqlite3 ECDICT-LICENSE.txt manifest.json; do
  mv "$RELEASE_DIR/data/english/$name" "$APP_DIR/data/english/$name" || fail "英文词库安装失败: $name"
done
for name in voice_audio.py english_lookup.py server-voice.py; do
  mv "$RELEASE_DIR/$name" "$APP_DIR/$name" || fail "后端安装失败: $name"
done

# ---- 3) 重启 ----
if [ -n "$UNIT" ]; then
  log "systemd 重启: $UNIT"
  systemctl restart "$UNIT"
elif [ -n "$PID" ]; then
  log "无 systemd，原样 nohup 重启（同解释器/同目录/同环境）"
  tr "\0" "\n" < "/proc/$PID/environ" > /tmp/voice_env.$$ 2>/dev/null || : > /tmp/voice_env.$$
  pkill -f server-voice.py 2>/dev/null || true
  sleep 1
  cd "$APP_DIR"
  while IFS= read -r kv; do case "$kv" in *=*) export "$kv" ;; esac; done < /tmp/voice_env.$$
  rm -f /tmp/voice_env.$$
  nohup "$PY" server-voice.py >> "$APP_DIR/voice.log" 2>&1 &
else
  log "无原进程，用 $PY 直接启动"
  cd "$APP_DIR" && nohup "$PY" server-voice.py >> "$APP_DIR/voice.log" 2>&1 &
fi

# ---- 4) 健康检查：最多等 40 秒（含 SenseVoice 首次加载）----
for i in $(seq 1 20); do
  sleep 2
  RESP=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)
  if printf '%s' "$RESP" | "$PY" -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null; then
    ENGLISH=$(curl -s --max-time 5 -H 'Content-Type: application/json' --data '{"text":"apple"}' "http://127.0.0.1:$PORT/api/english" || true)
    printf '%s' "$ENGLISH" | "$PY" -c 'import json,sys; result=json.load(sys.stdin); assert result.get("kind") == "word" and result.get("word") == "apple" and result.get("meanings")' || fail "英文单词线上查询验证失败"
    log "健康检查通过: $RESP"
    log "当前进程: $(pgrep -af server-voice.py || echo 未找到)"
    log "部署完成 OK"
    exit 0
  fi
done

log "健康检查失败（服务没在 $PORT 起来），最近日志："
tail -25 "$APP_DIR/voice.log" 2>/dev/null
journalctl -u "$UNIT" -n 25 --no-pager 2>/dev/null | tail -25
exit 1

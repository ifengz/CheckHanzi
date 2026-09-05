#!/usr/bin/env bash
# TTS 延迟取证：服务器侧缓存命中耗时 + 站点完整链路耗时 + 缓存头检查
set -u
PORT=5001
echo "=== 1) 本机直连语音服务（缓存命中耗时）==="
for t in 饭 天 好; do
  curl -s -o /dev/null -w "  /api/tts?text=$t  → %{time_total}s (HTTP %{http_code}, %{size_download}B)\n" "http://127.0.0.1:$PORT/api/tts?text=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" $t)"
done
echo "=== 2) 缓存文件数 ==="
ls /opt/chazi-voice/tts-cache/*.mp3 2>/dev/null | wc -l
echo "=== 3) 经 Nginx 站点访问（找站点根 + 计时）==="
SITE_DIR=$(nginx -T 2>/dev/null | grep -oP 'root\s+\K[^;]+' | head -1)
echo "  站点根: $SITE_DIR"
if [ -n "$SITE_DIR" ] && [ -f "$SITE_DIR/char-dict.html" ]; then
  curl -s -o /dev/null -w "  本机经 nginx /api/tts?text=饭 → %{time_total}s (HTTP %{http_code})\n" "http://127.0.0.1/api/tts?text=%E9%A5%AD"
  curl -s -I "http://127.0.0.1/api/tts?text=%E9%A5%AD" | grep -iE "cache-control|content-type|HTTP/" | sed 's/^/  /'
else
  echo "  未找到站点 char-dict.html，跳过 nginx 测试"
fi
echo "=== 4) 语音服务最近日志 ===="
journalctl -u chazi-voice -n 5 --no-pager 2>/dev/null | tail -5

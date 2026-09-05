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
echo "=== 3) 经 Nginx 全链路（80/443，验证 Cache-Control 透传）==="
for p in 80 443; do
  echo "  -- 端口 $p --"
  curl -sk -D- -o /dev/null --max-time 5 "http$( [ $p = 443 ] && echo s )://127.0.0.1/api/tts?text=%E9%A5%AD" 2>/dev/null | grep -iE "^HTTP/|cache-control|content-type|content-length" | sed 's/^/  /'
done
echo "  -- HTML 缓存头 --"
curl -sk -D- -o /dev/null --max-time 5 "http://127.0.0.1/char-dict.html" 2>/dev/null | grep -iE "^HTTP/|cache-control|expires|last-modified" | sed 's/^/  /'
echo "=== 4) 语音服务最近日志 ===="
journalctl -u chazi-voice -n 5 --no-pager 2>/dev/null | tail -5

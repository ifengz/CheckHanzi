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
echo "=== 2c) 站点代码是否为最新修复版 ==="
SW=$(find /www/wwwroot -maxdepth 3 -name "char-dict.html" 2>/dev/null | head -1)
if [ -n "$SW" ]; then
  echo "  站点文件: $SW"
  for pat in "CONC = 2" "lastTouch < 3000" "provider" "讯飞识别" "还没收进词库"; do
    grep -q "$pat" "$SW" && echo "  ✓ 含: $pat" || echo "  ✗ 缺: $pat"
  done
fi
echo "=== 2d) 语音服务 provider 字段 ==="
grep -c 'provider' /opt/chazi-voice/server-voice.py | sed 's/^/  server-voice.py 含 provider 处数: /'
echo "=== 2b) sw.js 是否已部署到站点 ==="
find /www/wwwroot -maxdepth 3 -name "sw.js" 2>/dev/null | head -3 | sed 's/^/  /'
SW=$(find /www/wwwroot -maxdepth 3 -name "sw.js" 2>/dev/null | head -1)
if [ -n "$SW" ]; then
  echo "  sw.js 位于: $SW"
  DIR=$(dirname "$SW")
  grep -c "serviceWorker" "$DIR/char-dict.html" 2>/dev/null | sed 's/^/  站点 char-dict.html 含 SW 注册代码处数: /'
fi
echo "=== 3) 经 Nginx 全链路（80/443，验证 Cache-Control 透传）==="
for p in 80 443; do
  echo "  -- 端口 $p --"
  curl -sk -D- -o /dev/null --max-time 5 "http$( [ $p = 443 ] && echo s )://127.0.0.1/api/tts?text=%E9%A5%AD" 2>/dev/null | grep -iE "^HTTP/|cache-control|content-type|content-length" | sed 's/^/  /'
done
echo "  -- HTML 缓存头 --"
curl -sk -D- -o /dev/null --max-time 5 "http://127.0.0.1/char-dict.html" 2>/dev/null | grep -iE "^HTTP/|cache-control|expires|last-modified" | sed 's/^/  /'
echo "=== 4) 语音服务最近日志 ===="
journalctl -u chazi-voice -n 5 --no-pager 2>/dev/null | tail -5

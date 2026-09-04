# -*- coding: utf-8 -*-
"""一次性预热：把字典全部汉字的 TTS（edge-tts 晓晓）预生成到服务器缓存。
之后 /api/tts 对任何字典字都是磁盘缓存直出（毫秒级），不再现场调微软接口。
用法: TTS_CACHE_DIR=/opt/chazi-voice/tts-cache python3 prewarm_tts.py /tmp/char-dict.html
"""
import sys, json, hashlib, os, asyncio, re, pathlib

html_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/char-dict.html"
html = open(html_path, encoding="utf-8").read()
m = re.search(r"var DICT = (\{.*?\});", html, re.S)
chars = list(json.loads(m.group(1)).keys())

cache_dir = pathlib.Path(os.environ.get("TTS_CACHE_DIR", "/opt/chazi-voice/tts-cache"))
cache_dir.mkdir(parents=True, exist_ok=True)

def cached(c):
    p = cache_dir / (hashlib.md5(c.encode()).hexdigest() + ".mp3")
    return p.exists() and p.stat().st_size > 500

todo = [c for c in chars if not cached(c)]
print(f"字典 {len(chars)} 字，需要生成 {len(todo)} 个", flush=True)

import edge_tts
SEM = asyncio.Semaphore(6)
done = 0
fail = 0

async def gen(c):
    global done, fail
    path = cache_dir / (hashlib.md5(c.encode()).hexdigest() + ".mp3")
    async with SEM:
        for attempt in range(3):
            try:
                com = edge_tts.Communicate(c, "zh-CN-XiaoxiaoNeural")
                chunks = []
                async for ch in com.stream():
                    if ch["type"] == "audio":
                        chunks.append(ch["data"])
                data = b"".join(chunks)
                if len(data) > 500:
                    path.write_bytes(data)
                    done += 1
                    if done % 200 == 0:
                        print(f"  进度 {done}/{len(todo)}", flush=True)
                    return
            except Exception as e:
                if attempt == 2:
                    fail += 1
                    print(f"  失败 {c}: {e}", flush=True)
                await asyncio.sleep(1.5)

async def main():
    await asyncio.gather(*(gen(c) for c in todo))

asyncio.run(main())
print(f"完成：成功 {done}，失败 {fail}（失败的字由 /api/tts 现场生成兜底）", flush=True)

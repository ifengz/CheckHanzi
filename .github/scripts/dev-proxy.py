#!/usr/bin/env python3
"""本地开发代理：静态文件 + 分流。
  /api/tts*      → 本地新后端 127.0.0.1:8788（含粤语分支）
  其余 /api/*    → 线上 https://hanzi.usfan.net（真实识别与英文）
只监听 127.0.0.1。
"""
import argparse
import http.server
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCAL_TTS = "http://127.0.0.1:8788"
PROD = "https://hanzi.usfan.net"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if self.path.split("?")[0].endswith((".html", ".js")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def target(self):
        if self.path.startswith("/api/tts"):
            return LOCAL_TTS
        if self.path.startswith("/api/"):
            return PROD
        return None

    def proxy(self):
        where = self.target()
        if not where:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "connection", "accept-encoding"}}
        req = urllib.request.Request(where + self.path, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in {"transfer-encoding", "connection", "content-length", "content-encoding"}:
                        self.send_header(k, v)
                self.send_header("X-Dev-Upstream", where)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as err:
            payload = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", err.headers.get("Content-Type", "application/json"))
            self.send_header("X-Dev-Upstream", where)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as err:
            msg = ('{"error":"本地开发代理转发失败：%s（上游 %s）"}' % (type(err).__name__, where)).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.proxy()
        else:
            self.send_error(405)

    def log_message(self, fmt, *args):
        text = fmt % args
        if "/api/" in text:
            print("[dev]", self.command, text.split(" ")[1], "→",
                  LOCAL_TTS if text.split(" ")[1].startswith("/api/tts") else PROD, flush=True)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    print(f"本地开发：http://127.0.0.1:{port}/char-dict.html   （/api/tts→本地，其余→线上）", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

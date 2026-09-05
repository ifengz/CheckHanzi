#!/usr/bin/env python3
"""Preview local UI using the real deployed voice API; no mock audio or ASR."""

import http.server
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
VOICE_ORIGIN = "https://hanzi.usfan.net"


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def voice_request(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length else None
        request = urllib.request.Request(
            VOICE_ORIGIN + self.path,
            data=data,
            method=self.command,
            headers={"Content-Type": self.headers.get("Content-Type", "application/octet-stream")},
        )
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError:
            self.send_error(502, "Deployed voice API unavailable")
            return
        with response:
            body = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", response.headers.get("Cache-Control", "no-store"))
            self.end_headers()
            self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.voice_request()
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.voice_request()
            return
        self.send_error(405)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Preview: http://127.0.0.1:{port}/char-dict.html", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), PreviewHandler).serve_forever()

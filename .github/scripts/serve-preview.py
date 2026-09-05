#!/usr/bin/env python3
"""Preview local UI against an explicit real API origin; no mock responses."""

import argparse
import http.server
import pathlib
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
API_ORIGIN = "https://hanzi.usfan.net"


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
            API_ORIGIN + self.path,
            data=data,
            method=self.command,
            headers={"Content-Type": self.headers.get("Content-Type", "application/octet-stream")},
        )
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError:
            self.send_error(502, "Configured API unavailable")
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=8765)
    parser.add_argument("--api-origin", default=API_ORIGIN)
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.api_origin)
    if origin.scheme not in {"http", "https"} or not origin.netloc or origin.path not in {"", "/"} or origin.query or origin.fragment or origin.username:
        parser.error("--api-origin must be an HTTP(S) origin without credentials or a path")
    API_ORIGIN = args.api_origin.rstrip("/")
    port = args.port
    print(f"Preview: http://127.0.0.1:{port}/char-dict.html", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), PreviewHandler).serve_forever()

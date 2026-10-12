#!/usr/bin/env python3
"""发音本地调试台：一个字/词同时喂给现网 Azure 和 Google，听差别、看上游返回码。

只绑 127.0.0.1，密钥只读文件、绝不下发给页面；音频走 voice_audio 里生产同一套
SSML 构造与响度归一，所以这里听到的就是线上会听到的。

用法：
    python3 dev-pron-debug.py                 # http://127.0.0.1:8799
    python3 dev-pron-debug.py 8899            # 换端口
    https_proxy=http://127.0.0.1:7897 python3 dev-pron-debug.py   # 本机直连 Google 不通时要带
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

import voice_audio

ROOT = pathlib.Path(__file__).resolve().parent
PAGE = ROOT / "dev-pron-debug.html"
CACHE = pathlib.Path(os.environ.get("PRON_DEBUG_CACHE", "/tmp/chazi-pron-debug"))
AZURE_KEY_FILE = os.path.expanduser("~/.config/chazi/azure_speech_key")
GOOGLE_KEY_FILE = os.path.expanduser("~/.config/chazi/gcp_tts_key")
AZURE_REGION = os.environ.get("AZURE_SPEECH_REGION", "eastasia")
ENGINES = {
    "azure": {"label": "现网 Azure（zh-HK-HiuMaan）", "lang": "yue-HK", "voice": voice_audio.TTS_VOICES["yue"]},
    "gstd": {"label": "Google Standard", "lang": "yue-HK", "voice": "yue-HK-Standard-A"},
    "gchirp": {"label": "Google Chirp3-HD", "lang": "yue-HK", "voice": "yue-HK-Chirp3-HD-Achernar"},
}


class UpstreamError(RuntimeError):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def read_key(path, name):
    p = pathlib.Path(os.path.expanduser(path))
    if not p.exists():
        raise UpstreamError(500, f"缺 {name} 密钥文件：{path}")
    key = p.read_text(encoding="utf8").strip()
    if not key:
        raise UpstreamError(500, f"{name} 密钥文件是空的：{path}")
    return key


def load_table():
    """读我们自己的两张离线表，用来预填读法；文件是 `var X = {…}` 形式。"""
    out = {}
    for name, path, attr in (("yue", ROOT / "models/dictionary/cantonese-data.js", "CANTONESE_DATA"),
                             ("zh", ROOT / "models/dictionary/character-data.js", None)):
        src = path.read_text(encoding="utf8")
        out[name] = json.loads(src[src.index("{"):src.rindex("}") + 1])
    return out


TABLE = load_table()


def legal_syllables():
    """本仓表里真实出现过的粤拼音节；换 Google 时它是唯一能自建的那道合法性闸门。"""
    out = set()
    for entry in TABLE["yue"].get("char", {}).values():
        out.update(entry.get("a") or [])
        if entry.get("t"):
            out.add(entry["t"])
    for readings in TABLE["yue"].get("word", {}).values():
        out.update(readings if isinstance(readings, list) else [])
    return out


LEGAL = legal_syllables()


def lookup(text):
    han = [ch for ch in text if "\u3400" <= ch <= "\u9fff"]
    chars = []
    for ch in han:
        entry = TABLE["yue"].get("char", {}).get(ch) or {}
        chars.append({"char": ch, "all": entry.get("a", []), "pick": entry.get("t") or (entry.get("a") or [""])[0]})
    word = TABLE["yue"].get("word", {}).get(text)
    zh = TABLE["zh"].get("chars", {}).get(text) or TABLE["zh"].get("pinyin", {}).get(text)
    source = "逐字候选"
    if isinstance(word, list) and len(word) == len(chars):
        # 生产送出去的就是词表读法，调试台要一模一样，否则测的是另一套东西
        for entry, reading in zip(chars, word):
            entry["pick"] = reading
        source = "整词命中"
    return {"legal": len(LEGAL), "han": "".join(han), "chars": chars, "word": " ".join(word) if isinstance(word, list) else (word or ""),
            "source": source,
            "pinyin": (zh or {}).get("p") if isinstance(zh, dict) else zh,
            "unverified": text in (TABLE["yue"].get("unverified") or {})}


def google_ssml(text, readings):
    from xml.sax.saxutils import escape
    items = voice_audio.split_readings(readings)
    han = [ch for ch in text if "\u3400" <= ch <= "\u9fff"]
    if len(items) != len(han):
        raise UpstreamError(400, f"粤拼数量 {len(items)} 与汉字数 {len(han)} 不一致")
    for item in items:
        if not voice_audio.JYUTPING.match(item):
            raise UpstreamError(400, f"粤拼格式不合法：{item!r}")
    parts = []
    index = 0
    for ch in text:
        if "\u3400" <= ch <= "\u9fff":
            parts.append(f'<phoneme alphabet="jyutping" ph="{items[index]}">{escape(ch)}</phoneme>')
            index += 1
        else:
            parts.append(escape(ch))
    return "<speak>" + "".join(parts) + "</speak>"


def synth(engine, text, readings):
    cfg = ENGINES.get(engine)
    if not cfg:
        raise UpstreamError(400, f"未知引擎：{engine}")
    if engine == "azure":
        ssml = voice_audio.azure_ssml(text, readings, cfg["voice"])
    else:
        ssml = google_ssml(text, readings)
    key = voice_audio.tts_cache_key(text, "yue", cfg["voice"], " ".join(voice_audio.split_readings(readings)))
    path = CACHE / f"{engine}-{key}.mp3"
    if path.exists() and path.stat().st_size > 500:
        return path.read_bytes(), {"X-Cache": "HIT", "X-Voice": cfg["voice"], "X-SSML": urllib.parse.quote(ssml)}
    t0 = time.time()
    if engine == "azure":
        token = read_key(AZURE_KEY_FILE, "Azure")
        req = urllib.request.Request(f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1",
                                     data=ssml.encode("utf8"),
                                     headers={"Authorization": f"Bearer {token}", "Ocp-Apim-Subscription-Key": token,
                                              "Content-Type": "application/ssml+xml",
                                              "X-Microsoft-OutputFormat": voice_audio.AZURE_OUTPUT_FORMAT,
                                              "User-Agent": "chazi-pron-debug"})
    else:
        import base64
        req = urllib.request.Request("https://texttospeech.googleapis.com/v1/text:synthesize",
                                     data=json.dumps({"input": {"ssml": ssml},
                                                      "voice": {"languageCode": cfg["lang"], "name": cfg["voice"]},
                                                      "audioConfig": {"audioEncoding": "MP3", "sampleRateHertz": 24000}}).encode(),
                                     headers={"Content-Type": "application/json", "X-Goog-Api-Key": read_key(GOOGLE_KEY_FILE, "Google")})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read()
            if engine != "azure":
                raw = base64.b64decode(json.loads(raw)["audioContent"])
    except urllib.error.HTTPError as exc:
        body = exc.read()[:200].decode("utf8", "replace")
        raise UpstreamError(exc.code, f"上游 {exc.code}：{body or '无响应体（Azure 4xx 就是这样）'}") from exc
    except urllib.error.URLError as exc:
        raise UpstreamError(502, f"连不上上游：{exc.reason}（本机直连 Google 不通时要带 https_proxy）") from exc
    mp3 = voice_audio.normalize_mp3_bytes(raw)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(mp3)
    return mp3, {"X-Cache": "MISS", "X-Voice": cfg["voice"], "X-SSML": urllib.parse.quote(ssml), "X-Raw-Bytes": str(len(raw))}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            elif u.path == "/api/engines":
                self._send(200, json.dumps([{"id": k, **v} for k, v in ENGINES.items()]).encode())
            elif u.path == "/api/lookup":
                text = "".join(q.get("text", []))
                if not text:
                    raise UpstreamError(400, "text 不能为空")
                self._send(200, json.dumps(lookup(text), ensure_ascii=False).encode())
            elif u.path == "/api/say":
                text = "".join(q.get("text", []))
                readings = "".join(q.get("readings", []))
                if not text:
                    raise UpstreamError(400, "text 不能为空")
                engine = "".join(q.get("engine", []))
                mp3, headers = synth(engine, text, readings)
                unknown = [r for r in voice_audio.split_readings(readings) if r not in LEGAL]
                if unknown:
                    headers["X-Warn"] = urllib.parse.quote("读法不在本仓音节表：" + " ".join(unknown) + "（Azure 会回 400，Google 会静默按默认读法发）")
                self._send(200, mp3, "audio/mpeg", headers)
            else:
                self._send(404, b'{"error":"not found"}')
        except voice_audio.VoiceAudioError as exc:
            self._send(400, json.dumps({"error": str(exc)}, ensure_ascii=False).encode())
        except UpstreamError as exc:
            self._send(exc.status, json.dumps({"error": exc.detail}, ensure_ascii=False).encode())
        except Exception as exc:  # 调试台要把异常原样吐给页面，不要静默
            self._send(500, json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False).encode())


def main():
    from http.server import ThreadingHTTPServer
    port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8799
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"发音调试台： http://127.0.0.1:{port}/   缓存目录 {CACHE}")
    print("提示：本机直连 Google 不通，需要 https_proxy=http://127.0.0.1:7897 再启动")
    srv.serve_forever()


if __name__ == "__main__":
    main()

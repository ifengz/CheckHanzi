"""Local ECDICT lookup and MyMemory sentence translation for Flask."""

from __future__ import annotations

import json
import os
import re
import socket
import sqlite3
import unicodedata
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from flask import Blueprint, jsonify, request


APP_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = APP_DIR / "data" / "english" / "ecdict.sqlite3"
DEFAULT_CACHE_PATH = APP_DIR / "english-cache.sqlite3"
MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get"
MYMEMORY_ORIGIN = ("https", "api.mymemory.translated.net", 443)
SOURCE = {"name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT"}
TRANSLATION_SOURCE = {"name": "MyMemory", "url": "https://mymemory.translated.net/"}

_SINGLE_WORD_RE = re.compile(r"^([A-Za-z]+(?:['-][A-Za-z]+)*)(?:[.!?])?$")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_POS_PREFIX_RE = re.compile(r"^([A-Za-z]+(?:\.[A-Za-z]+)*\.)\s*(.*)$")
_FORM_CODES = frozenset({"p", "d", "i", "3", "r", "t", "s"})


class EnglishLookupError(Exception):
    code = "invalid_request"
    status = 400

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class NotFoundError(EnglishLookupError):
    code = "not_found"
    status = 404


class DictionaryUnavailableError(EnglishLookupError):
    code = "dictionary_unavailable"
    status = 502


class CacheUnavailableError(EnglishLookupError):
    code = "cache_unavailable"
    status = 502


class QuotaError(EnglishLookupError):
    code = "quota_exceeded"
    status = 429


class UpstreamInvalidError(EnglishLookupError):
    code = "upstream_invalid"
    status = 502


class UpstreamTimeoutError(EnglishLookupError):
    code = "upstream_timeout"
    status = 504


def normalize_query(text: str) -> str:
    """Return the dictionary matching key without changing the response query."""
    value = unicodedata.normalize("NFKC", text).strip().casefold()
    return re.sub(r"\s+", " ", value).replace("’", "'").replace("‘", "'")


def _error_response(error):
    return jsonify({"error": {"code": error.code, "message": error.message}}), error.status


def _validate_text(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise EnglishLookupError("请求必须包含 text 字符串")
    text = payload["text"]
    if not text.strip():
        raise EnglishLookupError("text 不能为空")
    if len(text) > 300 or len(text.encode("utf-8")) > 500:
        raise EnglishLookupError("text 最多 300 个字符且 UTF-8 不超过 500 字节")
    if _CJK_RE.search(text) or not _LATIN_RE.search(text):
        raise EnglishLookupError("只支持包含拉丁字母的英文文本")
    return text


def _dictionary_key(text):
    key = normalize_query(text)
    match = _SINGLE_WORD_RE.fullmatch(key)
    return match.group(1) if match else key


def _is_single_word(text):
    return _SINGLE_WORD_RE.fullmatch(normalize_query(text)) is not None


def _translation_lines(value):
    return [part.strip() for part in re.split(r"\\r\\n|\\n|\r?\n", value or "") if part.strip()]


def _meaning(line):
    match = _POS_PREFIX_RE.match(line)
    if match is None:
        return {"partOfSpeech": "", "translation": line}
    return {"partOfSpeech": match.group(1), "translation": match.group(2)}


def _forms(exchange, word):
    forms = []
    for item in (exchange or "").split("/"):
        code, separator, form = item.partition(":")
        if separator and code in _FORM_CODES and len(form) > 1 and form != word:
            forms.append(form)
    return list(dict.fromkeys(forms))


class Dictionary:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get("ENGLISH_DICTIONARY_PATH", DEFAULT_DB_PATH))

    def ensure_available(self):
        if not self.path.is_file():
            raise DictionaryUnavailableError("英文词典文件不可用")
        try:
            with closing(self._connect()) as connection:
                connection.execute("SELECT 1 FROM word LIMIT 1").fetchone()
        except (OSError, sqlite3.Error) as exc:
            raise DictionaryUnavailableError("英文词典文件不可用") from exc

    def _connect(self):
        return sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True)

    def lookup(self, query):
        try:
            with closing(self._connect()) as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute(
                    "SELECT word, phonetic, translation, exchange FROM word WHERE normalized = ? LIMIT 1",
                    (_dictionary_key(query),),
                ).fetchone()
        except (OSError, sqlite3.Error) as exc:
            raise DictionaryUnavailableError("英文词典文件不可用") from exc
        if row is None:
            return None
        meanings = [_meaning(line) for line in _translation_lines(row["translation"])]
        if not meanings:
            raise NotFoundError("这个单词暂缺中文释义")
        return {
            "word": row["word"],
            "phonetic": row["phonetic"] or "",
            "meanings": meanings,
            "forms": _forms(row["exchange"], row["word"]),
        }


class TranslationCache:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get("ENGLISH_TRANSLATION_CACHE_PATH", DEFAULT_CACHE_PATH))

    def ensure_available(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(self.path)) as connection, connection:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS translation_cache "
                    "(query TEXT PRIMARY KEY, translation TEXT NOT NULL)"
                )
        except (OSError, sqlite3.Error) as exc:
            raise CacheUnavailableError("英文翻译缓存不可用") from exc

    def get(self, query):
        try:
            with closing(sqlite3.connect(self.path)) as connection:
                row = connection.execute(
                    "SELECT translation FROM translation_cache WHERE query = ?", (query,)
                ).fetchone()
        except (OSError, sqlite3.Error) as exc:
            raise CacheUnavailableError("英文翻译缓存不可用") from exc
        return row[0] if row else None

    def put(self, query, translation):
        try:
            with closing(sqlite3.connect(self.path)) as connection, connection:
                connection.execute(
                    "INSERT INTO translation_cache(query, translation) VALUES (?, ?) "
                    "ON CONFLICT(query) DO UPDATE SET translation = excluded.translation",
                    (query, translation),
                )
        except (OSError, sqlite3.Error) as exc:
            raise CacheUnavailableError("英文翻译缓存不可用") from exc


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def _same_mymemory_origin(url):
    try:
        parsed = urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    return (parsed.scheme, parsed.hostname, port) == MYMEMORY_ORIGIN


class MyMemoryClient:
    def __init__(self, timeout=8.0, opener=None):
        self.timeout = timeout
        self.opener = opener or build_opener(_NoRedirect()).open

    def translate(self, text):
        url = MYMEMORY_ENDPOINT + "?q=" + quote(text, safe="") + "&langpair=en|zh-CN"
        request_obj = Request(url, headers={"Accept": "application/json", "User-Agent": "chazi-english/1"})
        try:
            with self.opener(request_obj, timeout=self.timeout) as response:
                if not _same_mymemory_origin(response.geturl()):
                    raise UpstreamInvalidError("句子翻译服务返回了无效数据")
                raw = response.read(100_000)
        except HTTPError as exc:
            if exc.code in (429, 456):
                raise QuotaError("句子翻译服务额度已用尽") from exc
            raise UpstreamInvalidError("句子翻译服务暂时不可用") from exc
        except (socket.timeout, TimeoutError) as exc:
            raise UpstreamTimeoutError("句子翻译服务超时") from exc
        except URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise UpstreamTimeoutError("句子翻译服务超时") from exc
            raise UpstreamInvalidError("句子翻译服务连接失败") from exc
        except OSError as exc:
            raise UpstreamTimeoutError("句子翻译服务超时") from exc
        try:
            data = json.loads(raw.decode("utf-8"))
            response_code = data["responseStatus"]
            quota_finished = data["quotaFinished"]
            translation = data["responseData"]["translatedText"]
        except (UnicodeDecodeError, TypeError, ValueError, KeyError) as exc:
            raise UpstreamInvalidError("句子翻译服务返回了无效数据") from exc
        if type(response_code) is not int or type(quota_finished) is not bool:
            raise UpstreamInvalidError("句子翻译服务返回了无效数据")
        if quota_finished is True or response_code in (429, 456):
            raise QuotaError("句子翻译服务额度已用尽")
        if response_code < 200 or response_code >= 300 or not isinstance(translation, str) or not translation.strip():
            raise UpstreamInvalidError("句子翻译服务返回了无效数据")
        return translation.strip()


def create_english_blueprint(dictionary=None, translator=None, cache=None):
    """Build a configured blueprint; all runtime dependencies are explicit."""
    dictionary = dictionary if dictionary is not None else Dictionary()
    translator = translator if translator is not None else MyMemoryClient()
    cache = cache if cache is not None else TranslationCache()
    dictionary.ensure_available()
    cache.ensure_available()
    blueprint = Blueprint("english_lookup", __name__)

    @blueprint.post("/api/english")
    def english_handler():
        try:
            text = _validate_text(request.get_json(silent=True))
            entry = dictionary.lookup(text)
            if entry is not None:
                return jsonify({"kind": "word", "query": text, **entry, "source": SOURCE})
            if _is_single_word(text):
                raise NotFoundError("未找到这个英文单词")
            translation = cache.get(text)
            if translation is None:
                translation = translator.translate(text)
                cache.put(text, translation)
            return jsonify({"kind": "sentence", "query": text, "translation": translation,
                            "source": TRANSLATION_SOURCE})
        except EnglishLookupError as error:
            return _error_response(error)
        except (OSError, sqlite3.Error):
            return _error_response(UpstreamInvalidError("英文查询服务暂时不可用"))

    return blueprint

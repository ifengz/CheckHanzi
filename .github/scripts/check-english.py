#!/usr/bin/env python3
"""Focused, offline checks for the English lookup response contract."""

from __future__ import annotations

import io
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from urllib.error import HTTPError, URLError

from flask import Flask

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, ROOT)

from english_lookup import (  # noqa: E402
    MyMemoryClient,
    TranslationCache,
    create_english_blueprint,
    normalize_query,
)


class TestTranslator:
    def __init__(self, translation="我喜欢苹果。"):
        self.translation = translation
        self.calls = 0

    def translate(self, text):
        self.calls += 1
        return self.translation


class TestResponse:
    def __init__(self, payload, url="https://api.mymemory.translated.net/get"):
        self.payload = payload
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def geturl(self):
        return self.url

    def read(self, _limit):
        return self.payload


def make_client(cache_path, translator=None):
    app = Flask(__name__)
    app.register_blueprint(create_english_blueprint(
        translator=translator or TestTranslator(), cache=TranslationCache(cache_path)
    ))
    return app.test_client()


def post(client, text):
    return client.post("/api/english", json={"text": text})


def assert_word(client, query, word):
    response = post(client, query)
    assert response.status_code == 200, (query, response.status_code, response.get_json())
    body = response.get_json()
    assert body["kind"] == "word"
    assert body["query"] == query
    assert body["word"] == word
    assert body["phonetic"]
    assert body["meanings"]
    assert body["source"] == {"name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT"}


def test_real_dictionary_words():
    with tempfile.TemporaryDirectory() as directory:
        client = make_client(os.path.join(directory, "cache.sqlite3"))
        for query, word in (("apple", "apple"), ("I", "I"), ("a", "a"),
                            ("apples", "apples"), ("don't", "don't"),
                            ("hello", "hello"), ("bicycle", "bicycle"),
                            ("Apple", "apple"), ("Apple.", "apple"),
                            ("Hello!", "hello")):
            assert_word(client, query, word)


def test_dictionary_manifest():
    directory = Path(ROOT) / "data/english"
    manifest = json.loads((directory / "manifest.json").read_text())
    for name in ("dictionary", "archive", "license"):
        item = manifest[name]
        path = directory / item["file"]
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        assert digest.hexdigest() == item["sha256"], name + " SHA-256 mismatch"
        if "bytes" in item:
            assert path.stat().st_size == item["bytes"], name + " size mismatch"
    with (directory / manifest["archive"]["file"]).open("rb") as source:
        header = source.read(10)
        assert header[:2] == b"\x1f\x8b"
        assert int.from_bytes(header[4:8], "little") == manifest["archive"]["gzip_mtime"] == 0
    connection = sqlite3.connect((directory / manifest["dictionary"]["file"]).as_uri() + "?mode=ro", uri=True)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT count(*) FROM word").fetchone()[0] == manifest["dictionary"]["row_count"]
        metadata = dict(connection.execute("SELECT key,value FROM metadata"))
        assert metadata["schema_version"] == str(manifest["schema_version"])
        assert metadata["row_count"] == str(manifest["dictionary"]["row_count"])
        for stored, field in (("source_commit", "commit"), ("source_gitblob", "git_blob"), ("source_sha256", "csv_sha256"), ("source_bytes", "csv_bytes")):
            assert metadata[stored] == str(manifest["source"][field]), stored
    finally:
        connection.close()


def test_literal_newline_and_query_preservation():
    with tempfile.TemporaryDirectory() as directory:
        response = post(make_client(os.path.join(directory, "cache.sqlite3")), "  Apple  ")
        assert response.status_code == 200
        assert response.get_json()["query"] == "  Apple  "
        a_body = post(make_client(os.path.join(directory, "second.sqlite3")), "a").get_json()
        assert len(a_body["meanings"]) == 2
        assert a_body["meanings"][1]["partOfSpeech"] == "art."
        assert "\\r" not in " ".join(item["translation"] for item in a_body["meanings"])
        assert normalize_query("Don’t") == "don't"


def test_unknown_single_word_is_404():
    with tempfile.TemporaryDirectory() as directory:
        response = post(make_client(os.path.join(directory, "cache.sqlite3")), "zzqnotawordxk.")
        assert response.status_code == 404
        assert response.get_json()["error"]["code"] == "not_found"
        missing_meaning = post(make_client(os.path.join(directory, "cache.sqlite3")), "-max")
        assert missing_meaning.status_code == 404
        assert missing_meaning.get_json()["error"]["message"] == "这个单词暂缺中文释义"


def test_successful_sentence_is_cached():
    with tempfile.TemporaryDirectory() as directory:
        translator = TestTranslator()
        client = make_client(os.path.join(directory, "cache.sqlite3"), translator)
        first = post(client, "I like apples.")
        second = post(client, "I like apples.")
        assert first.status_code == 200
        assert first.get_json()["kind"] == "sentence"
        assert first.get_json()["translation"] == "我喜欢苹果。"
        assert second.get_json() == first.get_json()
        assert translator.calls == 1


def test_upstream_errors_are_typed_and_not_cached():
    def quota_opener(request, timeout):
        raise HTTPError(request.full_url, 429, "quota", {}, io.BytesIO(b""))

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(
            os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=quota_opener)
        )
        response = post(client, "A sentence not in the dictionary.")
        assert response.status_code == 429
        assert response.get_json()["error"]["code"] == "quota_exceeded"

    def broken_opener(request, timeout):
        raise URLError("offline")

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(
            os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=broken_opener)
        )
        response = post(client, "A second sentence not in the dictionary.")
        assert response.status_code == 502
        assert response.get_json()["error"]["code"] == "upstream_invalid"

    def timeout_opener(request, timeout):
        raise TimeoutError("timeout")

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=timeout_opener))
        response = post(client, "A timed out sentence.")
        assert response.status_code == 504
        assert response.get_json()["error"]["code"] == "upstream_timeout"


def test_nested_status_and_redirect_are_invalid():
    quota_payload = json.dumps({
        "responseData": {"translatedText": "不应返回"}, "responseStatus": 200, "quotaFinished": True,
    }).encode()

    def quota_finished_opener(request, timeout):
        return TestResponse(quota_payload)

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(
            os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=quota_finished_opener)
        )
        response = post(client, "A quota-finished sentence not in the dictionary.")
        assert response.status_code == 429
        assert response.get_json()["error"]["code"] == "quota_exceeded"

    payload = json.dumps({
        "responseData": {"translatedText": "不应返回"}, "responseStatus": 503, "quotaFinished": False,
    }).encode()

    def invalid_opener(request, timeout):
        return TestResponse(payload)

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(
            os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=invalid_opener)
        )
        response = post(client, "A third sentence not in the dictionary.")
        assert response.status_code == 502
        assert response.get_json()["error"]["code"] == "upstream_invalid"

    def mistyped_opener(request, timeout):
        return TestResponse(json.dumps({"responseStatus": "200", "quotaFinished": "true", "responseData": {"translatedText": "不应返回"}}).encode())

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=mistyped_opener))
        assert post(client, "A malformed quota response.").status_code == 502

    def redirected_opener(request, timeout):
        return TestResponse(b"{}", "https://example.com/get")

    with tempfile.TemporaryDirectory() as directory:
        client = make_client(
            os.path.join(directory, "cache.sqlite3"), MyMemoryClient(opener=redirected_opener)
        )
        response = post(client, "A fourth sentence not in the dictionary.")
        assert response.status_code == 502
        assert response.get_json()["error"]["code"] == "upstream_invalid"


def main():
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print("PASS {}".format(test.__name__))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Focused, offline checks for the English lookup response contract."""

from __future__ import annotations

import io
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from contextlib import redirect_stdout
from unittest.mock import patch
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


def load_reverse_dictionary_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_english", Path(ROOT) / "models/dictionary/generate_english.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_reverse_dictionary_qualified_lines():
    generator = load_reverse_dictionary_generator()
    assert list(generator.gloss_candidates(None)) == []
    for newline in ("\\r\\n", "\\n", "\r\n", "\n"):
        translation = "n. 苹果, 银行" + newline + "art. [计] 累加器, 地址" + newline + "n. 学校, 花园"
        candidates = list(generator.gloss_candidates(translation))
        assert [(i, t) for i, t, _ in candidates] == list(enumerate(generator.gloss_tokens(translation)))
        assert [t for _, t, qualified in candidates if qualified] == ["地址"]
        assert candidates[-1][1:] == ("花园", False)
    assert list(generator.gloss_candidates("n. 阿姨, 姨妈, 姑妈")) == [
        (0, "阿姨", False), (1, "姨妈", False), (2, "姑妈", False)
    ]


def test_reverse_dictionary_does_not_promote_unreviewed_fallback():
    generator = load_reverse_dictionary_generator()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "fixture.csv"
        with source.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["word", "translation", "oxford"])
            writer.writeheader()
            writer.writerows([
                {"word": "a", "translation": "n. [计] 累加器, 地址", "oxford": 1},
                {"word": "fallback", "translation": "n. 测试, 地址", "oxford": 1},
                {"word": "apple", "translation": "n. 苹果, 家伙", "oxford": 1},
            ])
        with patch.object(generator, "ROOT", root), patch.object(
            generator, "app_universe", return_value=({"址"}, {"地址", "苹果"})
        ), redirect_stdout(io.StringIO()):
            generator.build(source, generator.sha256(source), {
                "repository": "fixture", "download_url": "fixture", "licence": "fixture"
            })
        text = (root / "english-data.js").read_text(encoding="utf-8")
        output = json.loads(text.removeprefix("var ENGLISH_DATA = ").strip().removesuffix(";"))
        assert output["word"] == {"苹果": "apple"}
        assert output["char"] == {}


def test_real_dictionary_words():
    with tempfile.TemporaryDirectory() as directory:
        client = make_client(os.path.join(directory, "cache.sqlite3"))
        for query, word in (("apple", "apple"), ("I", "I"), ("a", "a"),
                            ("apples", "apples"), ("don't", "don't"),
                            ("hello", "hello"), ("bicycle", "bicycle"),
                            ("Apple", "apple"), ("Apple.", "apple"),
                            ("Hello!", "hello")):
            assert_word(client, query, word)


def test_numeric_asr_transcript_looks_up_english_number():
    with tempfile.TemporaryDirectory() as directory:
        client = make_client(os.path.join(directory, "cache.sqlite3"))
        for query in ("11", "11."):
            response = post(client, query)
            assert response.status_code == 200, (query, response.status_code, response.get_json())
            body = response.get_json()
            assert body["kind"] == "word"
            assert body["query"] == query
            assert body["word"] == "11"
            assert body["meanings"][0]["translation"] == "eleven"


def test_spaced_numeric_asr_transcript_is_translated_as_sentence():
    with tempfile.TemporaryDirectory() as directory:
        translator = TestTranslator("一，二，三，四，五。")
        client = make_client(os.path.join(directory, "cache.sqlite3"), translator)
        response = post(client, "1 2 3 4 5")
        assert response.status_code == 200, (response.status_code, response.get_json())
        body = response.get_json()
        assert body["kind"] == "sentence"
        assert body["query"] == "1 2 3 4 5"
        assert body["translation"] == "一，二，三，四，五。"
        assert translator.calls == 1


def test_malformed_numeric_transcript_is_rejected():
    with tempfile.TemporaryDirectory() as directory:
        response = post(make_client(os.path.join(directory, "cache.sqlite3")), "11!!")
        assert response.status_code == 400
        assert response.get_json()["error"]["code"] == "invalid_request"


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
    tests = []
    generator_available = (Path(ROOT) / "models/dictionary/generate_english.py").is_file()
    backend_only = not (Path(ROOT) / "char-dict.html").is_file()
    for name, value in globals().items():
        if not name.startswith("test_"):
            continue
        # The backend release intentionally excludes build-time dictionary tools.
        if name.startswith("test_reverse_dictionary_") and backend_only and not generator_available:
            print("SKIP {} (build-time generator absent from backend-only package)".format(name))
            continue
        tests.append(value)
    for test in tests:
        test()
        print("PASS {}".format(test.__name__))


if __name__ == "__main__":
    main()

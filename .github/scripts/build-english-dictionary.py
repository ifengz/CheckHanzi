#!/usr/bin/env python3
"""Build the checked-in, read-only SQLite subset used by english_lookup.py."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import sqlite3
import tempfile
import unicodedata
from pathlib import Path


SOURCE_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_BLOB = "c4ade63ea08cf39d9c3475e96929036d64d94c94"
SOURCE_BYTES = 65933428
SOURCE_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
SOURCE_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/{}/ecdict.csv".format(SOURCE_COMMIT)


def normalize(value):
    value = unicodedata.normalize("NFKC", value).strip().casefold()
    return " ".join(value.replace("’", "'").replace("‘", "'").split())


def build(source_path, output_path, gzip_path):
    source_size = os.path.getsize(source_path)
    if source_size != SOURCE_BYTES:
        raise SystemExit("source size mismatch: expected {}, got {}".format(SOURCE_BYTES, source_size))
    with open(source_path, "rb") as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != SOURCE_SHA256:
        raise SystemExit("source SHA-256 mismatch: expected {}, got {}".format(SOURCE_SHA256, digest.hexdigest()))
    output_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_dir, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".ecdict-", suffix=".sqlite3", dir=output_dir)
    os.close(fd)
    try:
        db = sqlite3.connect(temporary)
        try:
            db.executescript("""
                PRAGMA page_size = 4096;
                PRAGMA journal_mode = OFF;
                PRAGMA synchronous = FULL;
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE word (
                    id INTEGER PRIMARY KEY,
                    normalized TEXT NOT NULL UNIQUE,
                    word TEXT NOT NULL,
                    phonetic TEXT NOT NULL,
                    translation TEXT NOT NULL,
                    pos TEXT NOT NULL,
                    exchange TEXT NOT NULL
                );
            """)
            count = 0
            with open(source_path, "r", encoding="utf-8", newline="") as source:
                reader = csv.DictReader(source)
                for row in reader:
                    word = row.get("word", "").strip()
                    normalized = normalize(word)
                    if not normalized:
                        continue
                    values = (normalized, word, row.get("phonetic", "").strip(),
                              row.get("translation", "").strip(), row.get("pos", "").strip(),
                              row.get("exchange", "").strip())
                    try:
                        db.execute("INSERT INTO word(normalized,word,phonetic,translation,pos,exchange) VALUES(?,?,?,?,?,?)", values)
                        count += 1
                    except sqlite3.IntegrityError as error:
                        raise SystemExit("duplicate normalized word: {}".format(normalized)) from error
            db.executemany("INSERT INTO metadata(key,value) VALUES(?,?)", [
                ("source_name", "ECDICT"),
                ("source_url", "https://github.com/skywind3000/ECDICT"),
                ("source_download_url", SOURCE_URL),
                ("source_commit", SOURCE_COMMIT),
                ("source_gitblob", SOURCE_BLOB),
                ("source_bytes", str(source_size)),
                ("source_sha256", digest.hexdigest()),
                ("row_count", str(count)),
                ("schema_version", "1"),
            ])
            db.commit()
            db.execute("VACUUM")
        finally:
            db.close()
        os.replace(temporary, output_path)
        if gzip_path:
            compressed_dir = os.path.dirname(os.path.abspath(gzip_path))
            os.makedirs(compressed_dir, exist_ok=True)
            fd, compressed_temp = tempfile.mkstemp(prefix=".ecdict-", suffix=".gz", dir=compressed_dir)
            os.close(fd)
            try:
                with open(output_path, "rb") as source, open(compressed_temp, "wb") as raw_target:
                    target = gzip.GzipFile(filename="", fileobj=raw_target, mode="wb", compresslevel=9, mtime=0)
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        target.write(chunk)
                    target.close()
                os.replace(compressed_temp, gzip_path)
            finally:
                if os.path.exists(compressed_temp):
                    os.unlink(compressed_temp)
            def artifact(path):
                path = Path(path)
                hasher = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        hasher.update(chunk)
                return {"file": path.name, "bytes": path.stat().st_size, "sha256": hasher.hexdigest()}

            manifest = {
                "schema_version": 1,
                "dictionary": dict(artifact(output_path), row_count=count),
                "archive": dict(artifact(gzip_path), gzip_mtime=0),
                "source": {"name": "ECDICT", "repository": "https://github.com/skywind3000/ECDICT",
                           "download_url": SOURCE_URL, "commit": SOURCE_COMMIT, "git_blob": SOURCE_BLOB,
                           "csv_bytes": SOURCE_BYTES, "csv_sha256": SOURCE_SHA256},
                "license": artifact(Path(output_dir) / "ECDICT-LICENSE.txt"),
            }
            manifest_path = Path(output_dir) / "manifest.json"
            pending_manifest = manifest_path.with_suffix(".json.tmp")
            pending_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            os.replace(pending_manifest, manifest_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="ECDICT ecdict.csv")
    parser.add_argument("--output", default="data/english/ecdict.sqlite3")
    parser.add_argument("--gzip-output", default="data/english/ecdict.sqlite3.gz")
    args = parser.parse_args()
    build(args.source, args.output, args.gzip_output)
    print("built {} and {}".format(args.output, args.gzip_output))


if __name__ == "__main__":
    main()

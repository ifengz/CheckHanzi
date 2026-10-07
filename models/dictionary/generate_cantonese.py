#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build models/dictionary/cantonese-data.js (Cantonese readings for the lookup page).

Run with the pinned toolchain (ToJyutping needs Python >= 3.10):

  uv venv /tmp/canto-venv --python 3.12
  uv pip install --python /tmp/canto-venv/bin/python ToJyutping
  /tmp/canto-venv/bin/python models/dictionary/generate_cantonese.py \
    --jyutping-table /tmp/jp.tsv --unihan /tmp/Unihan-17.0.0.zip \
    --app char-dict.html --output models/dictionary/cantonese-data.js

Sources and licences are recorded in source-lock.json and models/dictionary/sources.md.
"""

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import ToJyutping

ROOT = Path(__file__).resolve().parent
CJK = re.compile(r"[㐀-鿿]")
CJK_WORD = re.compile(r"[㐀-鿿]+")
JP_SYLLABLE = re.compile(r"^[a-z]+\d$")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require_checksum(path, expected, label):
    actual = sha256(path)
    if actual != expected:
        raise SystemExit(f"{label} 校验不匹配：{actual} != {expected}")
    return actual


def official_readings(path):
    """char -> set(jyutping) from the government 粵語拼音表 (CC BY 4.0)."""
    table = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) < 3 or parts[0] == "CH" or not CJK.fullmatch(parts[0]):
            continue
        found = {r for r in re.split(r"[,;、\s]+", parts[2]) if JP_SYLLABLE.fullmatch(r)}
        if found:
            table.setdefault(parts[0], set()).update(found)
    return table


def unihan_cantonese(path):
    """char -> jyutping from Unihan kCantonese (Unicode License v3), one reading per char."""
    out = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.startswith("Unihan") or not name.endswith(".txt"):
                continue
            for line in archive.read(name).decode("utf-8").splitlines():
                parts = line.split("\t", 2)
                if len(parts) != 3 or parts[1] != "kCantonese" or not parts[0].startswith("U+"):
                    continue
                char = chr(int(parts[0][2:], 16))
                if CJK.fullmatch(char):
                    for reading in re.split(r"[,;\s]+", parts[2]):
                        if JP_SYLLABLE.fullmatch(reading):
                            out.setdefault(char, reading)
                            break
    return out


def app_corpus(path):
    """Head characters and their word list, straight out of the shipped page."""
    html = Path(path).read_text(encoding="utf-8")
    match = re.search(r"var DICT = (\{.*?\});", html, re.S)
    if not match:
        raise SystemExit("在 char-dict.html 里找不到 var DICT = {...};")
    raw = json.loads(match.group(1))
    heads = {c for c in raw if CJK.fullmatch(c)}
    words = {w for value in raw.values() if isinstance(value, dict)
             for w in (value.get("w") or [])
             if w and CJK_WORD.fullmatch(w)}
    return heads, words, raw


def tojyutping(text):
    """Per-character readings, None where the engine has nothing."""
    try:
        return [reading for _char, reading in ToJyutping.get_jyutping_list(text)]
    except Exception:
        return [None] * len(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jyutping-table", required=True)
    parser.add_argument("--unihan", required=True)
    parser.add_argument("--app", default="char-dict.html")
    parser.add_argument("--output", default=str(ROOT / "cantonese-data.js"))
    parser.add_argument("--lock", default=str(ROOT / "source-lock.json"), help="write resolved checksums here")
    args = parser.parse_args()

    lock = json.loads(Path(args.lock).read_text(encoding="utf-8")) if Path(args.lock).exists() else {}
    digests = {}
    for label, path, pinned in (
        ("unihan", args.unihan, lock.get("unihan", {}).get("sha256")),
        ("jyutping_table", args.jyutping_table, lock.get("jyutping_table", {}).get("sha256")),
    ):
        actual = sha256(path)
        if pinned and actual != pinned:
            raise SystemExit(f"{label} 校验不匹配：{actual} != {pinned}")
        digests[label] = actual

    official = official_readings(args.jyutping_table)
    fallback = unihan_cantonese(args.unihan)
    heads, words, raw = app_corpus(args.app)
    # 字头表必须覆盖词里出现的每一个字，否则前端拿不到候选集
    universe = set(heads) | {c for word in words for c in word}

    char_data, char_stats = {}, {"official": 0, "unihan": 0, "none": 0, "from_words": len(universe) - len(heads)}
    for char in sorted(universe):
        cand = sorted(official.get(char, ()))
        if cand:
            char_stats["official"] += 1
            entry = {"a": cand}
        elif char in fallback:
            char_stats["unihan"] += 1
            entry = {"a": [fallback[char]]}
        else:
            lone = tojyutping(char)[0]
            if not lone:
                char_stats["none"] += 1
                continue
            entry = {"a": [lone]}
        entry["t"] = tojyutping(char)[0] or entry["a"][0]
        char_data[char] = entry

    word_data, word_stats, warn = {}, {"ok": 0, "partial": 0, "warn": 0}, []
    for word in sorted(words):
        readings = tojyutping(word)
        if len(readings) != len(word) or any(r is None for r in readings):
            word_stats["partial"] += 1
            continue
        # 引擎给的读法必须是该字官方候选之一，否则就是它按普通话硬推的，不能当已核数据
        off = {r for ch in word for r in char_data.get(ch, {}).get("a", ())}
        if any(r not in char_data.get(ch, {}).get("a", ()) for ch, r in zip(word, readings)):
            warn.append(word)
            word_stats["warn"] += 1
            continue
        word_data[word] = readings
        word_stats["ok"] += 1
    word_stats["total"] = len(words)

    payload = {
        "meta": {
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "engine": f"ToJyutping {getattr(ToJyutping, '__version__', 'unknown')}",
            "sources": digests,
            "coverage": {"char": char_stats, "word": {**word_stats, "total": len(words)}},
        },
        "char": char_data,
        "word": word_data,
        # 官方表里没有这个读法 → 引擎按普通话推的，前端不显示、将来也不给它合成语音
        "unverified": warn,
    }
    body = "var CANTONESE_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    Path(args.output).write_text(body, encoding="utf-8")

    lock["jyutping_table"] = {"url": "https://github.com/lshk-org/jyutping-table/blob/master/list.tsv",
                              "licence": "CC BY 4.0", "sha256": digests["jyutping_table"]}
    Path(args.lock).write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"字 {len(universe)}（含仅出现在词里的 {char_stats['from_words']}）→ 官方 {char_stats['official']} / Unihan 兜底 {char_stats['unihan']} / 无数据 {char_stats['none']}")
    print(f"组词 {len(words)} → 已核 {word_stats['ok']} / 引擎硬推(入 unverified) {word_stats['warn']} / 缺读法 {word_stats['partial']}")
    if word_stats["warn"]:
        print("  unverified 前 12:", " ".join(warn[:12]))
    if char_stats["none"]:
        print("  警告：有无数据字，前端必须显式降级")
    print(f"输出 {args.output}：{len(body.encode('utf-8')) // 1024}KB")


if __name__ == "__main__":
    main()

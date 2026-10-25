#!/usr/bin/env python3
"""Build the offline Chinese-to-English word table from the pinned ECDICT CSV."""

import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT.parent.parent / "char-dict.html"
DICT_RE = re.compile(r"var DICT\s*=\s*(\{.*?\});", re.S)
SEP = re.compile(r"[,，;；/、\\\n]+")
POS_PREFIX = re.compile(r"^(?:[A-Za-z]+(?:\.[A-Za-z]+)*\.)\s*")
CJK = re.compile(r"^[\u3400-\u9fff]{1,4}$")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def app_universe():
    page = PAGE.read_text(encoding="utf-8")
    import json as J
    dict_blob = J.loads(DICT_RE.search(page).group(1))
    heads = set(dict_blob)
    words = {w for entry in dict_blob.values() for w in (entry.get("w") or [])}
    return heads, words


def gloss_tokens(translation):
    out = []
    for raw in SEP.split(translation or ""):
        token = POS_PREFIX.sub("", raw).strip()
        if token and CJK.match(token):
            out.append(token)
    return out


def gloss_candidates(translation):
    # Keep delimiters attached so ordinary glosses retain their existing ranks.
    parts = re.split(r"(\\r\\n|\\n|\r\n|\n)", translation or "")
    lines = [parts[0]] + [parts[i] + parts[i + 1] for i in range(1, len(parts), 2)]
    index = 0
    for line in lines:
        # A domain/usage label qualifies the whole line, including later synonyms.
        qualified = bool(re.search(r"\[[^\]]+\]", line))
        for token in gloss_tokens(line):
            yield index, token, qualified
            index += 1


def build(csv_path, expected_sha, lock):
    actual = sha256(csv_path)
    if actual != expected_sha:
        raise SystemExit(f"checksum mismatch: {actual} != {expected_sha}")
    heads, words = app_universe()
    universe = heads | words
    best = {}
    with open(csv_path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            word = (row.get("word") or "").strip()
            if not word:
                continue
            try:
                collins = int(row.get("collins") or 0)
                oxford = int(row.get("oxford") or 0)
                bnc = int(row.get("bnc") or 0)
                frq = int(row.get("frq") or 0)
            except ValueError:
                collins = oxford = bnc = frq = 0
            if not (oxford or collins):
                continue
            if re.search(r"(?:^|/)0:(?!$)[A-Za-z]", row.get("exchange") or ""):
                continue
            single = 0 if re.fullmatch(r"[a-z]+", word) else 1
            for index, token, qualified in gloss_candidates(row.get("translation")):
                if token not in universe:
                    continue
                score = (index, 0 if oxford else 1, 0 if collins else 1,
                         frq or 10 ** 9, bnc or 10 ** 9, single, len(word), word.lower())
                current = best.get(token)
                if current is None or score < current[0]:
                    best[token] = (score, word, qualified)
    # Do not promote a different, unreviewed meaning when the winning gloss is
    # qualified: this table cannot display that context, so leave it unavailable.
    table = {token: value[1] for token, value in best.items() if not value[2]}
    word_part = {k: v for k, v in table.items() if k in words}
    char_part = {k: v for k, v in table.items() if k in heads}
    out = {"meta": {"source": lock["repository"], "url": lock["download_url"], "licence": lock["licence"],
                    "sha256": actual, "word": len(word_part), "char": len(char_part)},
           "word": word_part, "char": char_part}
    target = ROOT / "english-data.js"
    target.write_text("var ENGLISH_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"组词 {len(word_part)}/{len(words)} = {100.0 * len(word_part) / len(words):.1f}%  "
          f"单字 {len(char_part)}/{len(heads)} = {100.0 * len(char_part) / len(heads):.1f}%  "
          f"体积 {target.stat().st_size} 字节")
    for probe in ["天空", "春天", "白天", "警察", "朋友", "秘密", "高兴", "苹果", "上学", "好人", "花园", "柠檬"]:
        print(f"  {probe} -> {table.get(probe, '（无）')}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="pinned ecdict.csv")
    args = parser.parse_args()
    manifest = json.loads((ROOT.parent.parent / "data/english/manifest.json").read_text(encoding="utf-8"))
    lock = dict(manifest["source"], licence="MIT")
    build(Path(args.source), lock["csv_sha256"], lock)

#!/usr/bin/env python3
"""Build offline dictionary metadata and on-demand Hanzi Writer stroke files."""

import argparse
import hashlib
import json
import re
import unicodedata
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
HAN = re.compile(r"^[\u4e00-\u9fff]$")
RS = re.compile(r"^(\d+'{0,3})\.(\d+)$")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_lock(path):
    return json.loads(path.read_text(encoding="utf-8"))


def require_checksum(path, expected):
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f"checksum mismatch for {path}: {actual}")


def unihan_values(path):
    fields = {}
    wanted = {"kMandarin", "kRSUnicode", "kTotalStrokes"}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.startswith("Unihan") or not name.endswith(".txt"):
                continue
            for line in archive.read(name).decode("utf-8").splitlines():
                parts = line.split("\t", 2)
                if len(parts) != 3 or parts[1] not in wanted or not parts[0].startswith("U+"):
                    continue
                char = chr(int(parts[0][2:], 16))
                fields.setdefault(char, {})[parts[1]] = parts[2]
    return fields


def radical_glyphs(path):
    glyphs = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        number, _symbol, unified = (part.strip() for part in line.split(";"))
        if unified:
            glyphs[number] = chr(int(unified, 16))
    return glyphs


def normalize_pinyin(value):
    value = unicodedata.normalize("NFC", value).strip().lower()
    return value if value else None


def pinyin_key(value):
    value = unicodedata.normalize("NFD", value.lower()).replace("u\u0308", "v")
    return "".join(char for char in value if not unicodedata.combining(char))


def mandarin_readings(value):
    return [reading for reading in (normalize_pinyin(item) for item in re.split(r"[,\s]+", value or "")) if reading]


def only_number(value):
    return int(value) if value and value.isdecimal() else None


def trusted_radical(source, all_values, glyphs):
    total = only_number(source.get("kTotalStrokes"))
    match = RS.fullmatch(source.get("kRSUnicode", ""))
    if total is None or not match:
        return None
    radical_number, residual = match.groups()
    radical = glyphs.get(radical_number)
    radical_total = only_number(all_values.get(radical, {}).get("kTotalStrokes")) if radical else None
    component_strokes = total - int(residual)
    if radical_total != component_strokes or component_strokes < 1:
        return None
    return {"r": radical, "s": component_strokes, "ts": total, "kind": "kangxi"}


def stroke_data(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        char: {"strokes": value["strokes"], "medians": value["medians"]}
        for char, value in data.items()
        if HAN.fullmatch(char)
        and isinstance(value.get("strokes"), list)
        and value["strokes"]
        and isinstance(value.get("medians"), list)
        and len(value["strokes"]) == len(value["medians"])
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--unihan", type=Path, required=True)
    parser.add_argument("--cjk-radicals", type=Path, required=True)
    parser.add_argument("--hanzi-writer-all", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stroke-dir", type=Path, required=True)
    parser.add_argument("--source-lock", type=Path, default=ROOT / "source-lock.json")
    args = parser.parse_args()

    locked = source_lock(args.source_lock)
    require_checksum(args.unihan, locked["unihan"]["sha256"])
    require_checksum(args.cjk_radicals, locked["cjk_radicals"]["sha256"])
    require_checksum(args.hanzi_writer_all, locked["hanzi_writer"]["all_json_sha256"])

    values = unihan_values(args.unihan)
    glyphs = radical_glyphs(args.cjk_radicals)
    strokes = stroke_data(args.hanzi_writer_all)
    chars, pinyin, radicals = {}, {}, {}
    for char in sorted((char for char in values if HAN.fullmatch(char)), key=ord):
        readings = mandarin_readings(values[char].get("kMandarin"))
        if not readings:
            continue
        chars[char] = {"p": readings[0] if len(readings) == 1 else readings, "w": []}
        for reading in readings:
            pinyin.setdefault(pinyin_key(reading), []).append(char)
        radical = trusted_radical(values[char], values, glyphs)
        if radical:
            radicals[char] = radical

    args.stroke_dir.mkdir(parents=True, exist_ok=True)
    for char, data in strokes.items():
        (args.stroke_dir / f"{ord(char):X}.json").write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    result = {
        "chars": chars,
        "pinyin": pinyin,
        "radicals": radicals,
        "strokeChars": "".join(sorted(strokes, key=ord)),
    }
    args.output.write_text(
        "var CHARACTER_DATA = " + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        f"generated {len(chars)} characters, {len(radicals)} trusted radicals, "
        f"{len(strokes)} local stroke files"
    )


if __name__ == "__main__":
    main()

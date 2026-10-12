# Offline Dictionary Sources

`character-data.js` is generated from fixed, checked sources. It contains
Unicode Unihan Mandarin readings for Basic CJK only; it does not add generated
words or definitions. Existing page pinyin, words, and New Chinese Dictionary
radicals are retained at merge time. A radical is emitted only for a missing
page record when Unicode's selected radical glyph has a matching, unambiguous
stroke count; otherwise the page does not show a radical card for that new
character. Generated radical records use `kind: "kangxi"` so the page can
avoid presenting the New Chinese Dictionary lookup instruction for a different
indexing system.

The generator verifies every source checksum in `source-lock.json` before it
writes output. Rebuild with:

```sh
python3 models/dictionary/generate_dictionary.py \
  --unihan /tmp/Unihan-17.0.0.zip \
  --cjk-radicals /tmp/CJKRadicals-17.0.0.txt \
  --hanzi-writer-all /tmp/hanzi-writer-data-68d10a4b/data/all.json \
  --output models/dictionary/character-data.js \
  --stroke-dir models/strokes/data
```

Unicode Unihan and CJKRadicals are Unicode 17.0.0 data under the Unicode
License v3; its notice is retained in `sources/UNICODE-LICENSE.txt`.
Hanzi Writer data is pinned to commit `68d10a4b21150cae5e1ebbd223eed289cf32d90c`.
It is derived from Make Me a Hanzi and distributed under the Arphic Public
License; the required unmodified license is retained in `sources/ARPHICPL.TXT`.
The generated stroke JSON changes file layout only and is freely available in
this repository under that license.

## Cantonese readings (`cantonese-data.js`)

`cantonese-data.js` is generated offline by `generate_cantonese.py`; the page reads it as a
static file and makes no network call for Cantonese. Three pinned sources are used:

- Character candidates: the government `電腦用漢字粵語拼音表` list from
  `lshk-org/jyutping-table` (`list.tsv`), **CC BY 4.0**, checksum recorded in `source-lock.json`.
  Attribution as required by that licence: © 政府粵語拼音表，via `lshk-org/jyutping-table`.
- Single-reading fallback for characters missing above: Unicode Unihan `kCantonese`,
  Unicode 17.0.0 under the Unicode Licence v3 (already retained in `sources/UNICODE-LICENSE.txt`).
- Per-word readings: `ToJyutping` (BSD-2-Clause), whose own data derives from
  `rime-cantonese` (CC BY 4.0). ToJyutping applies tone sandhi, which matches the agreed
  display standard of the *actual* reading rather than the dictionary form.

A word enters the word table only when every character reading is one of that character's
official candidates. Words that fail this test are listed in `unverified` (90 of 7,364) and
fall back to per-character candidates, which the page marks as `多读` instead of presenting a
single confident reading. Rebuild with the command in `generate_cantonese.py`.

Fetch the pinned inputs before rebuilding (they live outside the repository, e.g. `/tmp`):

```sh
curl -sLo /tmp/jp.tsv https://raw.githubusercontent.com/lshk-org/jyutping-table/master/list.tsv
curl -sLo /tmp/Unihan.zip https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip
shasum -a 256 /tmp/jp.tsv /tmp/Unihan.zip   # must equal source-lock.json
```

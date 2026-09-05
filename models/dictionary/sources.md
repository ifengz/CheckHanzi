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

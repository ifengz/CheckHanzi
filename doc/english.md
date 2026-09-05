# English lookup contract

`POST /api/english` accepts JSON `{ "text": string }`. Text may contain at
most 300 characters and 500 UTF-8 bytes. The original text is returned as
`query`; it is not trimmed, case-folded, or apostrophe-normalized in the
response.

The server first makes an exact normalized ECDICT lookup. Normalization is for
matching only: Unicode NFKC, trim, case-fold, whitespace collapse, and curly
apostrophe to ASCII apostrophe. Dictionary phrases are returned as words when
the exact phrase exists. A missing single English word returns HTTP 404. The
database has 770,611 entries from ECDICT commit
`bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`; its complete MIT notice is kept in
`data/english/ECDICT-LICENSE.txt`.

For a complete single word only, one trailing ASCII `.`, `!`, or `?` is ignored
for dictionary matching so ASR output such as `Apple.` remains a word lookup.
The returned `query` keeps that punctuation. Multiword text is never reduced to
one word and is sent unchanged to sentence translation when it has no exact
dictionary entry.

Dictionary response:

```json
{
  "kind": "word",
  "query": "Apple",
  "word": "apple",
  "phonetic": "'æpl",
  "meanings": [{ "partOfSpeech": "n.", "translation": "苹果, 家伙" }],
  "forms": ["apples"],
  "source": { "name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT" }
}
```

ECDICT's `translation` field is split only at its literal `\\r\\n` and
`\\n` delimiters. A part of speech is shown only when that individual line
contains one; the unrelated frequency-oriented `pos` field is not matched by
array position. Forms come only from known `exchange` fields, never from a
suffix guess.

An input which is not an exact dictionary phrase is translated by one explicit
MyMemory request to `https://api.mymemory.translated.net/get` with
`q=<encoded input>&langpair=en|zh-CN`. It sends no email, IP address, or API
key. The service's anonymous limit is 500 bytes per request and 5,000
characters per day. Only user-submitted sentences are sent; the server does no
batch prefetch. Successful results are cached in SQLite at
`/opt/chazi-voice/tts-cache/english.sqlite3` in the existing writable voice-cache directory, configurable through
`ENGLISH_TRANSLATION_CACHE_PATH`. The cache is outside the browser-served data
directory.

Sentence response:

```json
{
  "kind": "sentence",
  "query": "I like apples.",
  "translation": "我喜欢苹果。",
  "source": { "name": "MyMemory", "url": "https://mymemory.translated.net/" }
}
```

HTTP errors use `{ "error": { "code": "...", "message": "中文说明" } }`:
`400 invalid_request`, `404 not_found`, `429 quota_exceeded`, `502
dictionary_unavailable`, `502 cache_unavailable`, `502 upstream_invalid`, and
`504 upstream_timeout`. Redirects to another origin are rejected. A MyMemory
HTTP 429, `quotaFinished: true`, or nested `responseStatus` quota error is not
treated as a successful translation. Upstream response bodies are never
returned to the browser.

Deployment uploads `english_lookup.py`, this directory's gzip, license, and
manifest to a private incoming directory. It must validate the gzip SHA-256,
decompress it, validate the SQLite SHA-256 and metadata row count/schema/source
hash, then replace each deployed file atomically before Flask restarts. This
is not a transaction across files; a failed deployment must be reported and
resolved before publishing the new frontend. The
process does not download or decompress a dictionary during a request.

The source contains 1,872 entries without a Chinese definition. These return
an explicit missing-definition error; the app does not invent a meaning.

Primary provider specifications: [MyMemory API](https://mymemory.translated.net/doc/spec.php),
[usage limits](https://mymemory.translated.net/doc/usagelimits.php),
[terms](https://mymemory.translated.net/terms-and-conditions), and
[ECDICT](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b).

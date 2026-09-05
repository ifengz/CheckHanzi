# ECDICT data

`ecdict.sqlite3` is generated from ECDICT `ecdict.csv` at commit
`bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` (Git blob
`c4ade63ea08cf39d9c3475e96929036d64d94c94`, 65,933,428 bytes). The source is
licensed under MIT; the exact upstream notice is in `ECDICT-LICENSE.txt`.

`manifest.json` is the deployment verification contract: it records the gzip
and uncompressed SQLite hashes, sizes, row count, schema version, source
identity, and license hash. The gzip has an mtime of zero for reproducibility.

The SQLite file is read-only at runtime. Its `metadata` table records the
source URL, SHA-256, schema version, and generated row count. Rebuild it with
`.github/scripts/build-english-dictionary.py` and the pinned source CSV. The
builder rejects a CSV with the wrong size or SHA-256.

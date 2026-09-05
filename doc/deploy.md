# Release Checks

The production entry is https://hanzi.usfan.net/char-dict.html. The domain root is not the application entry.

Before pushing main:

- Read doc/core/lessons.md and the active task plan.
- Run `node .github/scripts/check-client.mjs` and the dictionary integrity check.
- Verify the working page through ego-lite against real voice responses. The legacy local dev-server.py mock endpoints cannot establish voice behavior.
- Check a cached and an uncached utterance, repeated clicks, switching characters, navigation during loading, and explicit network failure.
- Check complex characters and all result candidates at iPad landscape, reduced landscape height, portrait, and phone widths. No glyph clipping, overlapping sections, or inaccessible controls.
- Confirm dictionary source versions, licenses, generated data integrity, and unchanged existing entries.
- Review `git diff`, run `git diff --check`, and stage only the scoped release files. Process records and local test evidence remain ignored.
- Keep voice credentials, unrelated server configuration, and unrelated files unchanged. English lookup uses the approved pinned ECDICT dataset and MyMemory translation API; English speech uses the existing recognizer and Edge TTS provider.
- Run `.github/scripts/check-english.py` after decompressing the packaged dictionary; verify its source and asset manifest. Run `tests/check_voice_backend.py`, including its real Edge TTS case. Required Python packages include Flask, flask-cors, numpy, edge-tts and imageio-ffmpeg==0.6.0.
- Verify voice-only Chinese and English entry, spoken words and complete sentences, I/a/apostrophe preservation, sentence-word return, network/quota errors, and language changes during pending work. No child-facing typing field may remain.
- At iPad browser landscape sizes, verify the persistent large microphone on the left and scrollable results on the right in both languages, including Chinese detail/history. Check large touch targets and the stacked portrait layout.
- Check measured normalized audio and language/version cache isolation. Stage and verify backend/data before serving the new frontend; never expose server-only English data or cache files through static rsync.

After pushing:

- Wait for the deployment workflow for the exact pushed commit to succeed.
- Compare the deployed HTML and dictionary asset hashes with the committed files.
- Verify `/api/ping`, a real audio response, newly supported characters, and complex-character layout at the production page.
- Verify `/api/english` real word and sentence responses, multipart English ASR, and `X-TTS-Version: 2`; inspect actual English iPad landscape and phone screenshots.
- Distinguish emulated viewport checks from a physical iPad/Safari/child-voice check in the closeout.

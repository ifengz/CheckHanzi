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
- Keep voice providers, credentials, server configuration, and unrelated files unchanged.

After pushing:

- Wait for the deployment workflow for the exact pushed commit to succeed.
- Compare the deployed HTML and dictionary asset hashes with the committed files.
- Verify `/api/ping`, a real audio response, newly supported characters, and complex-character layout at the production page.
- Distinguish emulated viewport checks from a physical iPad/Safari/child-voice check in the closeout.

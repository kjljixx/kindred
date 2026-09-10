- Build frontend with `npm run build`

## Google Docs sync architecture

- `frontend/src/app.js` owns the sync coordinator. After the initial pull establishes a
  `{ documentId, revisionId }` target, editor transactions are queued in order as
  `{ transaction, before }`. Only document-changing, local transactions are queued;
  pull/conversion and compatibility-repair transactions are intentionally skipped.
- The coordinator polls the Google revision, pulls remote-only changes, and drains the
  local queue against the current revision. It permits one sync at a time. Failed
  transactions stay queued so a later poll can retry them.
- `frontend/src/gdocsSync.js` is the translation boundary. It converts a ProseMirror
  transaction plus its pre-transaction document (`before`) into Google Docs
  `batchUpdate` requests. Position mapping must use that pre-transaction document:
  Google indexes and ProseMirror node positions are not interchangeable.
- Structural requests (`insertTable`, row, or column inserts) run in their own phase.
  The code reads the document back after each phase because inserted structures change
  Google indexes before cell text or styling can be applied.
- Tables require special boundary handling. A paragraph separator between tables may
  need to remain for editor compatibility, while Google forbids deleting the final
  segment newline and requires `insertTable` to target an existing paragraph. Preserve
  the final paragraph and use its position; only replace a non-terminal separator.
- Google Docs API calls live in `src/kindred/server.py` under `/api/google-docs/*`;
  the frontend does not call Google directly. Relevant regressions belong in
  `frontend/test/gdocsSync.test.js`, especially for generated request sequences and
  table-boundary positions.

## Math detection

- `frontend/src/mathTextDetector.js` identifies plain-text math and wraps detected ranges in `span.render-latex`.
- Before math tokenization, URLs, email addresses, and supported phone-number formats are protected so their fragments cannot be classified as math. Keep new identifier-like formats in this protected-piece pass rather than adding range-level exclusions.
- Math ranges expand only to whitespace or text-punctuation (`.`, `;`, `:`, `!`, `?`) boundaries; do not include adjacent prose punctuation.
- In HTML input, do not classify text already rendered as math or text inside links.
- Add regressions for detection-boundary changes in `frontend/test/mathTextDetector.test.js`.

# Kindred

Document editor in the browser that uses Git for version control and integrates AI. The goal is an app that is Google Docs mixed with VSCode mixed with Pastebin.

See [HELP.md](https://github.com/kjljixx/kindred/blob/main/HELP.md) for general website usage instructions

## Install

```bash
pip install -e .
```

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. The editor works without a key; chat needs one. Set `KINDRED_REQUIRE_OPENROUTER_FREE_MODEL=true` to make the server reject chat requests that select any model other than `openrouter/free`.

### Frontend (required after UI changes)

Sources live in `frontend/`. Production assets are built into `src/kindred/static/dist/`:

```bash
cd frontend
npm ci
npm run build
```

Optional offline Pandoc import/export (vendors ~59MB wasm into `public/` then rebuild):

```bash
npm run vendor:pandoc
npm run build
```

Without a local `pandoc.wasm`, import/export falls back to CDN hosts when online.

## GUI

```bash
kindred --gui
```

Opens http://127.0.0.1:8765/ by default. Drafts and history live in the browser (IndexedDB).

Useful flags: `--host`, `--port`, `--no-browser`.

## Notes

- Default model is `openrouter/free`.
- Optional OpenLLMetry tracing when `TRACELOOP_API_KEY` or `TRACELOOP_BASE_URL` is set.

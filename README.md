# Kindred

Local writing-review GUI and CLI. Edit drafts in the browser; Analyze/chat call an LLM via LiteLLM when a provider API key is set.

## Install

```bash
pip install -e .
```

Copy `.env.example` to `.env` and set API keys for whichever LiteLLM provider you use (e.g. `OPENAI_API_KEY`). The editor works without a key; Analyze/chat need one.

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

## CLI

```bash
kindred path/to/draft.md -m openai/gpt-4o-mini
kindred path/to/draft.md -m human   # answer each unit yourself in the terminal
```

Useful flags: `--model` / `-m`, `--workers` / `-w`, `--out` / `-o`, `--host`, `--port`, `--no-browser`.

See HELP.md for general website usage instructions

## Notes

- Default model is `openai/gpt-5.6-luna` (override with `-m` or the request body in the GUI).
- Optional OpenLLMetry tracing when `TRACELOOP_API_KEY` or `TRACELOOP_BASE_URL` is set.

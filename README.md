# Kindred

Local writing-review GUI and CLI. Edit drafts in the browser; Analyze/chat call an LLM via LiteLLM when a provider API key is set.

## Install

```bash
pip install -e .
```

Copy `.env.example` to `.env` and set API keys for whichever LiteLLM provider you use (e.g. `OPENAI_API_KEY`) (Or don't if you don't want to, the doc editor still works fine the analysis/review feature just won't work).

## GUI

```bash
kindred --gui
```

Opens http://127.0.0.1:8765/ by default. Drafts and history live in the browser (IndexedDB); no API key is required to edit, import, or export. Analyze and chat need a configured provider key.

## CLI

```bash
kindred path/to/draft.md -m openai/gpt-4o-mini
kindred path/to/draft.md -m human   # answer each unit yourself in the terminal
```

Useful flags: `--model` / `-m`, `--workers` / `-w`, `--out` / `-o`, `--host`, `--port`, `--no-browser`.

## Notes

- Default model is `openai/gpt-5.6-luna` (override with `-m` or the request body in the GUI).
- Optional OpenLLMetry tracing when `TRACELOOP_API_KEY` or `TRACELOOP_BASE_URL` is set.

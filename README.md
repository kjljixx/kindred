# Google Docs Sync

Enable the API: Go to Google Cloud Console: APIs & Services and click Enable for Google Docs API.

Create Service Account:

    Go to IAM & Admin → Service Accounts → Create Service Account.

    Name it (e.g., `docs-sync`) and click Done.

Download Key JSON:

    Click on the new service account → Keys tab → Add Key → Create new key → choose JSON.

    Save the downloaded .json file in your project folder (e.g. service_account.json).

Share your Google Doc:

    Open the Google Doc in your browser.

    Click Share and invite the service account email (found in the JSON as client_email, ending in ...iam.gserviceaccount.com) as an Editor.

Set Environment Variable:
Add this to your .env file

GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\service_account.json"

# Kindred

Document editor in the browser that uses Git for version control and integrates AI. The goal is an app that is Google Docs mixed with VSCode mixed with Pastebin.

See [HELP.md](https://github.com/kjljixx/kindred/blob/main/HELP.md) for general website usage instructions

## Install

```bash
pip install -e .
```

Copy `.env.example` to `.env` and set API keys for whichever LiteLLM provider you use (e.g. `OPENAI_API_KEY`). The editor works without a key; chat needs one.

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

- Default model is `openai/gpt-5.6-luna`.
- Optional OpenLLMetry tracing when `TRACELOOP_API_KEY` or `TRACELOOP_BASE_URL` is set.

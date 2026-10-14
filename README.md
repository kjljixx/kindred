# Kindred

Document editor in the browser that uses Git for version control and integrates AI. The goal is an app that is Google Docs mixed with VSCode mixed with Pastebin.

See [HELP.md](https://github.com/kjljixx/kindred/blob/main/HELP.md) for general website usage instructions

## Intro

Kindred is basically me making the editor I wish I had. My key points were that it had to be:
- **Fast**. GDocs/Word take several seconds to open on my old laptop. Kindred takes ~600ms
- **Good, Thoughtful UI**. I got rid of all the buttons/options I never used, and tried to make a clean and sleek UI
- **Close Enough to full featured**. Has to have text colors, sizes, highlighting, different fonts, lists, tables, etc. Can't just be markdown or plaintext. I couldn't be bothered to do 10 different variants of checklists, though.
- **Compatibility**. It's not going to be perfect, but at least some ways of being able to stay compatible with Google Docs (implemented as Google Docs realtime sync), .docx (import/export), PDF (export)

Some other nice, unique features I've added since:
- **Automatic Math Detection**. Kindred automatically detects if you're typing in AsciiMath or just normal text; based on this it can render your math without you pressing any UI buttons or using clunky LaTeX syntax
- **Automatic Calculator**. As an extension of above, if your math expression can be calculated, and you tack on an equals sign at the end, the calculation result will be appended inline
- **Automatic document filing**. On initial commit of a document, Kindred automatically determines which existing folder a document should go in (or no folder at all).
- **Formatting Lock**. If you're filling out a form, you don't need to turn on bold/change text color every time you move on to the next question; just turn formatting lock on and your caret keeps your existing formatting no matter where you move it.
- **Branches/Git**. Because documents are stored w/ Git, you can make branches of documents, just like a codebase. Branches can also be merged with a nice inline UI
- **Chat**. Like many other editors, there's a built in chatbot that can make one-click accept suggestions. But, in Kindred it's also easy to comment on the LLM response; just move your caret into LLM response and begin typing your comment. Inspired by Delta comments UX (by Zed).

## Install

```bash
pip install -e .
```

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. The editor works without a key but chat & several features (auto place documents into folders, edge cases for math auto-detection, etc.) needs one.

### Frontend

```bash
cd frontend
npm ci
npm run build
```

Recommended offline Pandoc import/export (vendors ~59MB wasm into `public/` then rebuild):

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
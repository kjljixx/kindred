import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// KaTeX requires a document with a doctype (standards mode).
document.open();
document.write("<!DOCTYPE html><html><head></head><body></body></html>");
document.close();

globalThis.__KATEX_EXPORT_CSS__ = readFileSync(
  resolve(process.cwd(), "node_modules/katex/dist/katex.min.css"),
  "utf8",
);

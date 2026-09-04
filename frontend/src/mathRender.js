import katex from "katex";
import "mathlive";
import "katex/dist/katex.min.css";
import katexCssBundled from "katex/dist/katex.min.css?raw";
import AsciiMathParser from "asciimath2tex";
import { classifyMathHtml } from "./mathTextDetector.js";

/** KaTeX CSS embedded in HTML/PDF exports (font URLs point at jsDelivr). */
export function getMathExportEmbeddedCss() {
  const bundled = katexCssBundled?.length > 100 ? katexCssBundled : "";
  const fallback = globalThis.__KATEX_EXPORT_CSS__;
  const raw = bundled || (typeof fallback === "string" ? fallback : "");
  if (!raw) return "";
  return raw.replace(
    /url\(fonts\//g,
    "url(https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/fonts/",
  );
}

const asciiMathParser = new AsciiMathParser();

/** Convert the editor's stored ASCIIMath source to MathLive's LaTeX input. */
export function asciiMathToLatex(source) {
  return asciiMathParser.parse(String(source || "").trim());
}

/** Render KaTeX into a detached element (export/preview only — never PM view DOM). */
export function renderKatexInto(element, source) {
  const text = String(source || "").trim();
  if (!text) return;
  try {
    const tex = asciiMathToLatex(text);
    katex.render(tex, element, { throwOnError: false });
  } catch {
    element.textContent = text;
  }
}

/** Render KaTeX into every .render-latex element under a detached root. */
export function renderLatexIn(root) {
  if (!root) return;
  for (const element of root.querySelectorAll(".render-latex")) {
    if (element.querySelector(".katex")) continue;
    renderKatexInto(element, element.textContent || "");
  }
}

/** Classify + wrap math in HTML, then render KaTeX (export/preview only). */
export function renderMathHtml(inputHtml, classify = classifyMathHtml) {
  const classified = classify(inputHtml);
  const container = document.createElement("div");
  container.innerHTML = classified;
  renderLatexIn(container);
  return container.innerHTML;
}

/** Detect rendered KaTeX markup in export HTML. */
export function htmlHasRenderedMath(html) {
  return /class="katex(?:\s|")/.test(String(html || ""));
}

/** Classify + render math for HTML/PDF/DOCX export. */
export function renderMathForExport(inputHtml) {
  return renderMathHtml(inputHtml, classifyMathHtml);
}

/** Inject KaTeX CSS into a full HTML document (or wrap a fragment). */
export function injectMathExportStylesIntoHtml(html) {
  const body = String(html || "");
  if (!htmlHasRenderedMath(body)) return body;
  const styleBlock = `<style>\n${getMathExportEmbeddedCss()}\n</style>`;
  if (/<head[\s>]/i.test(body)) {
    return body.replace(/<head([^>]*)>/i, `<head$1>${styleBlock}`);
  }
  if (/<html[\s>]/i.test(body)) {
    return body.replace(/<html([^>]*)>/i, `<html$1><head>${styleBlock}</head>`);
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${styleBlock}
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * ProseMirror widget factory. MathLive owns formula hit-testing and editing while
 * the surrounding ProseMirror document continues to store ASCIIMath source.
 */
export function createMathWidget(source, { onCommit } = {}) {
  const text = String(source || "");
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "kindred-math-widget";
    wrap.contentEditable = "false";
    const field = document.createElement("math-field");
    field.className = "kindred-math-field";
    field.value = asciiMathToLatex(text);
    field.setAttribute("aria-label", `Formula: ${text}`);

    let committed = text;
    const commit = () => {
      const next = field.getValue("ascii-math");
      if (next === committed) return;
      committed = next;
      onCommit?.(next);
    };

    field.addEventListener("change", commit);
    field.addEventListener("blur", commit);
    wrap.append(field);
    return wrap;
  };
}

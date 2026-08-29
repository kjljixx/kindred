import katex from "katex";
import "katex/dist/katex.min.css";
import AsciiMathParser from "asciimath2tex";

const asciiMathParser = new AsciiMathParser();

/** Render KaTeX into a detached element (export/preview only — never PM view DOM). */
export function renderKatexInto(element, source) {
  const text = String(source || "").trim();
  if (!text) return;
  try {
    const tex = asciiMathParser.parse(text);
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
export function renderMathHtml(inputHtml, classifyMathHtml) {
  const classified = classifyMathHtml(inputHtml);
  const container = document.createElement("div");
  container.innerHTML = classified;
  renderLatexIn(container);
  return container.innerHTML;
}

/** ProseMirror widget factory — KaTeX overlay, does not touch doc text nodes. */
export function createMathWidget(source) {
  const text = String(source || "");
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "kindred-math-katex";
    wrap.contentEditable = "false";
    wrap.setAttribute("aria-hidden", "true");
    renderKatexInto(wrap, text);
    return wrap;
  };
}

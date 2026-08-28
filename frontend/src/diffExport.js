const SUCCESS_BG = "hsla(142, 71%, 45%, 0.22)";
const SUCCESS_COLOR = "hsl(142, 77%, 73%)";
const DANGER_BG = "hsla(0, 84%, 60%, 0.18)";
const DANGER_COLOR = "hsl(0, 93%, 82%)";

const STYLED_DIFF_FORMATS = new Set(["docx", "html", "pdf"]);

const DIFF_MARKER_RE = /\bdiff-(ins|del|image|table|list)/;

const PM_STRIP_CLASSES = new Set([
  "ProseMirror-selectednode",
  "ProseMirror-hideselection",
  "resize-cursor",
  "selectedCell",
  "column-resize-handle",
]);

const PM_REMOVE_SELECTORS = [
  ".merge-conflict",
  ".merge-table-row-conflict",
  ".merge-table-column-conflict",
  ".merge-table-cell-conflict",
  ".column-resize-handle",
];

/** Resolved diff colors/styles for export (from app.css theme). */
export const DIFF_CLASS_STYLES = {
  "diff-ins": `background: ${SUCCESS_BG}; color: ${SUCCESS_COLOR};`,
  "diff-del": `background: ${DANGER_BG}; color: ${DANGER_COLOR}; text-decoration: line-through;`,
  "diff-image-ins": `display: block; max-width: 100%; outline: 3px solid ${SUCCESS_COLOR}; outline-offset: 2px; filter: sepia(1) saturate(2.5) hue-rotate(85deg);`,
  "diff-image-del": `display: block; margin: 4px 0; opacity: 0.72;`,
  "diff-table-ins": `background: ${SUCCESS_BG};`,
  "diff-table-del": `display: block; margin: 8px 0; opacity: 0.5;`,
  "diff-table-cell-del": `background: ${DANGER_BG}; color: ${DANGER_COLOR}; text-decoration: line-through;`,
  "diff-table-cell-ins": `background: ${SUCCESS_BG}; color: ${SUCCESS_COLOR};`,
  "diff-table-row-del": `background: ${DANGER_BG}; border-color: ${DANGER_COLOR}; color: ${DANGER_COLOR}; text-decoration: line-through;`,
  "diff-table-row-ins": `background: ${SUCCESS_BG}; border-color: ${SUCCESS_COLOR}; color: ${SUCCESS_COLOR};`,
  "diff-table-column-del": `background: ${DANGER_BG}; border-color: ${DANGER_COLOR}; color: ${DANGER_COLOR}; text-decoration: line-through;`,
  "diff-table-column-ins": `background: ${SUCCESS_BG}; border-color: ${SUCCESS_COLOR}; color: ${SUCCESS_COLOR};`,
  "diff-list-ins": `background: ${SUCCESS_BG};`,
  "diff-list-del": `display: block; margin: 8px 0; opacity: 0.5; background: ${DANGER_BG}; color: ${DANGER_COLOR}; pointer-events: none;`,
  "diff-list-item-ins": `background: ${SUCCESS_BG};`,
  "diff-list-item-del": `background: ${DANGER_BG}; opacity: 0.5; pointer-events: none;`,
};

const DIFF_COMPOUND_CSS = `
.diff-image-del img {
  display: block;
  max-width: 100%;
  outline: 3px solid ${DANGER_COLOR};
  outline-offset: 2px;
  filter: sepia(1) saturate(3) hue-rotate(300deg);
}
.diff-table-ins td, .diff-table-ins th {
  border-color: ${SUCCESS_COLOR};
}
.diff-table-ins p {
  color: ${SUCCESS_COLOR};
}
.diff-table-del table {
  background: ${DANGER_BG};
}
.diff-table-del table td, .diff-table-del table th {
  border-color: ${DANGER_COLOR};
}
.diff-table-del td p, .diff-table-del th p {
  margin: 0;
  text-decoration: line-through;
  color: ${DANGER_COLOR};
}
.diff-table-cell-del p, .diff-table-cell-ins p {
  margin: 0;
}
.diff-list-del li > p {
  margin: 0;
  text-decoration: line-through;
}
.diff-list-item-del > p {
  margin: 0;
}
`;

/** Embedded CSS fallback for html/pdf export. */
export const DIFF_EXPORT_EMBEDDED_CSS = `${Object.entries(DIFF_CLASS_STYLES)
  .map(([cls, styles]) => `.${cls} { ${styles} }`)
  .join("\n")}
${DIFF_COMPOUND_CSS}`;

/**
 * @param {object} config
 * @param {string} dirtyViewMode
 * @param {string} formatId
 */
export function wantsStyledDiffExport(config, dirtyViewMode, formatId) {
  const mode = config?.export?.diffModeExport ?? "text";
  return (
    mode === "styledDiff" &&
    dirtyViewMode === "Diff" &&
    STYLED_DIFF_FORMATS.has(formatId)
  );
}

/**
 * @param {string} html
 */
export function hasDiffMarkers(html) {
  return DIFF_MARKER_RE.test(html || "");
}

/**
 * @param {Element} el
 * @param {string} addition
 */
function mergeStyle(el, addition) {
  const prev = (el.getAttribute("style") || "").trim();
  const sep = prev && !prev.endsWith(";") ? "; " : prev ? " " : "";
  el.setAttribute("style", `${prev}${sep}${addition}`);
}

/**
 * @param {Element} root
 */
export function sanitizeProseMirrorDom(root) {
  if (!root) return;
  root.removeAttribute("contenteditable");
  root.removeAttribute("spellcheck");
  root.removeAttribute("data-diff-del");

  for (const sel of PM_REMOVE_SELECTORS) {
    root.querySelectorAll(sel).forEach((node) => node.remove());
  }

  const walk = (el) => {
    if (el.nodeType !== 1) return;
    el.removeAttribute("data-diff-del");
    for (const cls of [...el.classList]) {
      if (PM_STRIP_CLASSES.has(cls) || cls.startsWith("ProseMirror-")) {
        el.classList.remove(cls);
      }
    }
    if (el.classList.contains("ProseMirror")) {
      el.classList.remove("ProseMirror");
    }
    for (const child of [...el.children]) walk(child);
  };
  walk(root);
}

/**
 * @param {Element} root
 */
export function inlineDiffExportStyles(root) {
  if (!root) return;

  const walk = (el, ancestors) => {
    if (el.nodeType !== 1) return;

    for (const cls of el.classList) {
      if (DIFF_CLASS_STYLES[cls]) mergeStyle(el, DIFF_CLASS_STYLES[cls]);
    }

    if (ancestors.includes("diff-image-del") && el.tagName === "IMG") {
      mergeStyle(
        el,
        `display: block; max-width: 100%; outline: 3px solid ${DANGER_COLOR}; outline-offset: 2px; filter: sepia(1) saturate(3) hue-rotate(300deg);`,
      );
    }
    if (ancestors.includes("diff-table-ins")) {
      if (el.tagName === "TD" || el.tagName === "TH") {
        mergeStyle(el, `border-color: ${SUCCESS_COLOR};`);
      }
      if (el.tagName === "P") mergeStyle(el, `color: ${SUCCESS_COLOR};`);
    }
    if (ancestors.includes("diff-table-del")) {
      if (el.tagName === "TABLE") mergeStyle(el, `background: ${DANGER_BG};`);
      if (el.tagName === "TD" || el.tagName === "TH") {
        mergeStyle(el, `border-color: ${DANGER_COLOR};`);
      }
      if (el.tagName === "P") {
        mergeStyle(
          el,
          `margin: 0; text-decoration: line-through; color: ${DANGER_COLOR};`,
        );
      }
    }
    if (
      ancestors.includes("diff-list-del") &&
      el.tagName === "P" &&
      el.parentElement?.tagName === "LI"
    ) {
      mergeStyle(el, "margin: 0; text-decoration: line-through;");
    }
    if (ancestors.includes("diff-list-item-del") && el.tagName === "P") {
      mergeStyle(el, "margin: 0;");
    }
    if (
      (ancestors.includes("diff-table-cell-del") ||
        ancestors.includes("diff-table-cell-ins")) &&
      el.tagName === "P"
    ) {
      mergeStyle(el, "margin: 0;");
    }

    const nextAncestors = [...ancestors];
    for (const cls of Object.keys(DIFF_CLASS_STYLES)) {
      if (el.classList.contains(cls)) nextAncestors.push(cls);
    }
    for (const child of el.children) walk(child, nextAncestors);
  };

  walk(root, []);
}

/**
 * @param {import('@tiptap/core').Editor} editor
 */
export function serializeDiffEditorHtml(editor) {
  if (!editor?.view?.dom) return "";
  const clone = editor.view.dom.cloneNode(true);
  sanitizeProseMirrorDom(clone);
  inlineDiffExportStyles(clone);
  return clone.innerHTML;
}

/**
 * @param {string} bodyHtml
 */
export function wrapStyledDiffHtml(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${DIFF_EXPORT_EMBEDDED_CSS}
</style>
</head>
<body>
${bodyHtml || ""}
</body>
</html>`;
}

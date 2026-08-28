import { describe, it, expect } from "vitest";
import {
  wantsStyledDiffExport,
  hasDiffMarkers,
  DIFF_CLASS_STYLES,
  sanitizeProseMirrorDom,
  inlineDiffExportStyles,
  wrapStyledDiffHtml,
} from "../src/diffExport.js";

const EDITOR_DIFF_CLASSES = [
  "diff-ins",
  "diff-del",
  "diff-image-ins",
  "diff-image-del",
  "diff-table-ins",
  "diff-table-del",
  "diff-table-cell-del",
  "diff-table-cell-ins",
  "diff-table-row-del",
  "diff-table-row-ins",
  "diff-table-column-del",
  "diff-table-column-ins",
  "diff-list-del",
  "diff-list-item-del",
  "diff-list-item-ins",
];

const configText = { export: { diffModeExport: "text" } };
const configStyled = { export: { diffModeExport: "styledDiff" } };

describe("wantsStyledDiffExport", () => {
  it("is false for text mode config", () => {
    expect(wantsStyledDiffExport(configText, "Diff", "docx")).toBe(false);
    expect(wantsStyledDiffExport(configText, "Diff", "html")).toBe(false);
  });

  it("is false for Text view even with styledDiff config", () => {
    expect(wantsStyledDiffExport(configStyled, "Text", "docx")).toBe(false);
    expect(wantsStyledDiffExport(configStyled, "Text", "pdf")).toBe(false);
  });

  it("is false for md and txt formats", () => {
    expect(wantsStyledDiffExport(configStyled, "Diff", "md")).toBe(false);
    expect(wantsStyledDiffExport(configStyled, "Diff", "txt")).toBe(false);
  });

  it("is true for docx, html, and pdf in Diff view with styledDiff config", () => {
    expect(wantsStyledDiffExport(configStyled, "Diff", "docx")).toBe(true);
    expect(wantsStyledDiffExport(configStyled, "Diff", "html")).toBe(true);
    expect(wantsStyledDiffExport(configStyled, "Diff", "pdf")).toBe(true);
  });
});

describe("hasDiffMarkers", () => {
  it("detects diff markup in html", () => {
    expect(hasDiffMarkers('<p><span class="diff-ins">x</span></p>')).toBe(true);
    expect(hasDiffMarkers('<div class="diff-table-del"><table></table></div>')).toBe(true);
    expect(hasDiffMarkers("<p>plain</p>")).toBe(false);
  });
});

describe("DIFF_CLASS_STYLES", () => {
  it("covers all diff classes used in the editor", () => {
    for (const cls of EDITOR_DIFF_CLASSES) {
      expect(DIFF_CLASS_STYLES[cls], `missing style for ${cls}`).toBeTruthy();
    }
  });
});

describe("sanitizeProseMirrorDom", () => {
  it("strips editor chrome and merge widgets", () => {
    const root = document.createElement("div");
    root.setAttribute("contenteditable", "true");
    root.className = "ProseMirror ProseMirror-hideselection";
    root.innerHTML = `
      <p class="diff-ins" data-diff-del="1">keep</p>
      <span class="merge-conflict"><button>ours</button></span>
      <span class="column-resize-handle"></span>
    `;
    sanitizeProseMirrorDom(root);
    expect(root.getAttribute("contenteditable")).toBeNull();
    expect(root.classList.contains("ProseMirror")).toBe(false);
    expect(root.querySelector(".merge-conflict")).toBeNull();
    expect(root.querySelector(".column-resize-handle")).toBeNull();
    expect(root.querySelector("[data-diff-del]")).toBeNull();
    expect(root.querySelector(".diff-ins")?.textContent).toBe("keep");
  });
});

describe("inlineDiffExportStyles", () => {
  it("inlines class styles onto diff spans", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <span class="diff-ins">added</span>
      <span class="diff-del">removed</span>
    `;
    inlineDiffExportStyles(root);
    const ins = root.querySelector(".diff-ins");
    const del = root.querySelector(".diff-del");
    expect(ins?.getAttribute("style")).toContain("hsla(142, 71%, 45%, 0.22)");
    expect(del?.getAttribute("style")).toContain("line-through");
  });

  it("styles nested table diff cells from ancestor context", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <table class="diff-table-ins">
        <tr><td><p>cell</p></td></tr>
      </table>
    `;
    inlineDiffExportStyles(root);
    const td = root.querySelector("td");
    const p = root.querySelector("p");
    expect(td?.getAttribute("style")).toContain("hsl(142, 77%, 73%)");
    expect(p?.getAttribute("style")).toContain("hsl(142, 77%, 73%)");
  });
});

describe("wrapStyledDiffHtml", () => {
  it("wraps body html with embedded diff css", () => {
    const wrapped = wrapStyledDiffHtml("<p class=\"diff-ins\">x</p>");
    expect(wrapped).toContain("<!DOCTYPE html>");
    expect(wrapped).toContain(".diff-ins");
    expect(wrapped).toContain("<p class=\"diff-ins\">x</p>");
  });
});

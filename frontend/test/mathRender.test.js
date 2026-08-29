import { describe, expect, it } from "vitest";
import {
  renderMathForExport,
  injectMathExportStylesIntoHtml,
  htmlHasRenderedMath,
  getMathExportEmbeddedCss,
} from "../src/mathRender.js";

describe("renderMathForExport", () => {
  it("wraps detected math for export", () => {
    const html = "<p>sin(x)</p>";
    const out = renderMathForExport(html);
    expect(out).toContain('class="render-latex"');
    if (document.compatMode === "CSS1Compat") {
      expect(htmlHasRenderedMath(out)).toBe(true);
      expect(out).toContain('class="katex"');
    }
  });

  it("leaves plain text unchanged when no math is detected", () => {
    const html = "<p>I have 3 apples.</p>";
    const out = renderMathForExport(html);
    expect(htmlHasRenderedMath(out)).toBe(false);
    expect(out).toBe(html);
  });
});

describe("injectMathExportStylesIntoHtml", () => {
  it("wraps fragments with KaTeX CSS", () => {
    expect(getMathExportEmbeddedCss().length).toBeGreaterThan(100);
    const html = '<p><span class="katex">x</span></p>';
    const out = injectMathExportStylesIntoHtml(html);
    expect(out).toContain("<style>");
    expect(out).toContain("cdn.jsdelivr.net/npm/katex@0.18.4/dist/fonts/");
    expect(out).toContain('class="katex"');
  });
});

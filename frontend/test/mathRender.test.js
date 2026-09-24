import { describe, expect, it } from "vitest";
import {
  renderMathForExport,
  injectMathExportStylesIntoHtml,
  htmlHasRenderedMath,
  getMathExportEmbeddedCss,
} from "../src/mathRender.js";

describe("renderMathForExport", () => {
  it("renders accepted math for export", () => {
    const html = '<p><span class="render-latex" data-kindred-math="sin(x)">sin(x)</span></p>';
    const out = renderMathForExport(html);
    expect(out).toContain('class="render-latex"');
    if (document.compatMode === "CSS1Compat") {
      expect(htmlHasRenderedMath(out)).toBe(true);
      expect(out).toContain('class="katex"');
    }
  });

  it("leaves unaccepted math as plain text", () => {
    const html = "<p>sin(x) and I have 3 apples.</p>";
    const out = renderMathForExport(html);
    expect(htmlHasRenderedMath(out)).toBe(false);
    expect(out).toBe(html);
  });

  it("does not classify plain text beside accepted math", () => {
    const html = '<p>sin(x) <span class="render-latex" data-kindred-math="x^2">x^2</span></p>';
    const out = renderMathForExport(html);
    expect(out.match(/class="render-latex"/g)).toHaveLength(1);
    expect(out).toContain("sin(x) ");
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

import { describe, expect, it } from "vitest";
import { blockToHtml, htmlToDoc, htmlToPlainText } from "../src/kindredSchema.js";
import { renderMathForExport } from "../src/mathRender.js";

describe("mathLive node storage", () => {
  it("stores ASCIIMath in an atomic inline node and preserves it as plain text", () => {
    const html = '<p>Before <span data-kindred-math="x^2">x^2</span> after</p>';
    const doc = htmlToDoc(html);
    const formula = doc.content[0].content[1];

    expect(formula).toMatchObject({
      type: "mathLive",
      attrs: { asciiMath: "x^2" },
    });
    expect(htmlToPlainText(html)).toBe("Before x^2 after");
    const exported = renderMathForExport(blockToHtml(doc.content[0]));
    expect(exported).toContain('class="render-latex"');
    if (document.compatMode === "CSS1Compat") {
      expect(exported).toContain('class="katex"');
    }
  });
});

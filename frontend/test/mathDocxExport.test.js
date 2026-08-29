import { describe, expect, it } from "vitest";
import { renderMathForExport } from "../src/mathRender.js";
import {
  extractMathmlFromKatex,
  prepareHtmlForDocxMath,
  replacePlaceholderWithOmml,
  patchDocxMath,
  mathPlaceholder,
} from "../src/mathDocxExport.js";
import { unzipSync, zipSync, strToU8 } from "fflate";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function minimalDocxXml(bodyInner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    ${bodyInner}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>`;
}

function zipMinimalDocx(bodyInner) {
  const files = {
    "word/document.xml": strToU8(minimalDocxXml(bodyInner)),
  };
  return new Blob([zipSync(files)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

describe("prepareHtmlForDocxMath", () => {
  it("replaces KaTeX with placeholders and collects OMML", () => {
    const rendered = renderMathForExport("<p>sin(x)</p>");
    if (document.compatMode !== "CSS1Compat") return;

    const { html, mathEntries } = prepareHtmlForDocxMath(rendered);
    expect(html).toContain(mathPlaceholder(0));
    expect(html).not.toContain('class="katex"');
    expect(mathEntries).toHaveLength(1);
    expect(mathEntries[0].placeholder).toBe(mathPlaceholder(0));
    expect(mathEntries[0].omml).toContain("m:oMath");
  });

  it("returns unchanged html when no KaTeX is present", () => {
    const html = "<p>plain text</p>";
    const result = prepareHtmlForDocxMath(html);
    expect(result.html).toBe(html);
    expect(result.mathEntries).toHaveLength(0);
  });
});

describe("extractMathmlFromKatex", () => {
  it("reads MathML from a rendered KaTeX element", () => {
    const rendered = renderMathForExport("<p>sin(x)</p>");
    if (document.compatMode !== "CSS1Compat") return;

    const doc = new DOMParser().parseFromString(`<div>${rendered}</div>`, "text/html");
    const katex = doc.querySelector(".katex");
    expect(katex).toBeTruthy();
    const mathml = extractMathmlFromKatex(katex);
    expect(mathml).toContain("<math");
    expect(mathml).toContain("sin");
  });
});

describe("replacePlaceholderWithOmml", () => {
  it("replaces a standalone placeholder run with OMML", () => {
    const placeholder = mathPlaceholder(0);
    const omml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>2+2=4</m:t></m:r></m:oMath>`;
    const xml = `<w:p><w:r><w:t>${placeholder}</w:t></w:r></w:p>`;

    const out = replacePlaceholderWithOmml(xml, placeholder, omml);
    expect(out).toContain("m:oMath");
    expect(out).not.toContain(placeholder);
  });

  it("splits a run when placeholder is embedded in text", () => {
    const placeholder = mathPlaceholder(0);
    const omml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>sin(x)</m:t></m:r></m:oMath>`;
    const xml = `<w:p><w:r><w:t>before ${placeholder} after</w:t></w:r></w:p>`;

    const out = replacePlaceholderWithOmml(xml, placeholder, omml);
    expect(out).toContain("m:oMath");
    expect(out).not.toContain(placeholder);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("replaces a placeholder run that includes w:rPr (docshift shape)", () => {
    const placeholder = mathPlaceholder(0);
    const omml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>a^2+b^2=c^2</m:t></m:r></m:oMath>`;
    const xml = `<w:p><w:r><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">so, the pythagorean theorem is </w:t></w:r><w:r><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${placeholder}</w:t></w:r></w:p>`;

    const out = replacePlaceholderWithOmml(xml, placeholder, omml);
    expect(out).toContain("m:oMath");
    expect(out).not.toContain(placeholder);
    expect(out).toContain("so, the pythagorean theorem is ");
  });
});

describe("patchDocxMath", () => {
  it("replaces placeholders in a minimal docx blob", async () => {
    const placeholder = mathPlaceholder(0);
    const omml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>2+2=4</m:t></m:r></m:oMath>`;
    const blob = zipMinimalDocx(`<w:p><w:r><w:t>${placeholder}</w:t></w:r></w:p>`);

    const patched = await patchDocxMath(blob, [{ placeholder, omml }]);
    const files = unzipSync(new Uint8Array(await patched.arrayBuffer()));
    const xml = new TextDecoder().decode(files["word/document.xml"]);

    expect(xml).toContain("m:oMath");
    expect(xml).not.toContain(placeholder);
  });
});

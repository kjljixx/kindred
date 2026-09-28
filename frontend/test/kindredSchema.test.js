import { describe, expect, it } from "vitest";

import {
  blockSignature,
  canonicalizeTextHtml,
  docToPlainText,
  htmlToDoc,
  prettyPrintHtml,
  projectDocument,
} from "../src/kindredSchema.js";
import { alignTwoWay } from "../src/docAlign.js";

describe("significant whitespace", () => {
  it("preserves trailing whitespace through HTML canonicalization", () => {
    expect(canonicalizeTextHtml("<p>Hello </p>")).toBe("<p>Hello&nbsp;</p>");
    expect(canonicalizeTextHtml("<pre>code \n</pre>")).toBe("<pre>code \n</pre>");
  });

  it("preserves trailing whitespace through HTML and document conversion", () => {
    const html = canonicalizeTextHtml("<p>Hello </p>");
    expect(docToPlainText(htmlToDoc(html))).toBe("Hello ");
  });

  it("preserves whitespace-only inline text while removing block formatting whitespace", () => {
    expect(canonicalizeTextHtml("<p><em>This</em><strong> </strong><em>can</em></p>"))
      .toBe("<p><em>This</em><strong> </strong><em>can</em></p>");
    expect(prettyPrintHtml("<p>First</p> \n <p>Second</p>"))
      .toBe("<p>First</p>\n<p>Second</p>");
    expect(prettyPrintHtml('<p data-note="a > b">First</p> \n <p>Second</p>'))
      .toBe('<p data-note="a > b">First</p>\n<p>Second</p>');
    expect(prettyPrintHtml("<p><span> </span><em>Next</em></p>"))
      .toBe("<p><span> </span><em>Next</em></p>");
  });

  it("preserves boundaries when projecting selected document blocks", () => {
    const content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "First paragraph." }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Second paragraph." }],
      },
    ];

    expect(docToPlainText({ type: "doc", content })).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("includes trailing whitespace in paragraph identity and alignment", () => {
    const base = htmlToDoc("<p>Hello</p>");
    const current = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Hello " }],
      }],
    };

    expect(blockSignature(base.content[0])).not.toBe(
      blockSignature(current.content[0]),
    );
    expect(alignTwoWay(base, current)[0].type).toBe("replace");
  });

  it("keeps formatting offsets aligned after empty paragraphs", () => {
    const projection = projectDocument(
      htmlToDoc(
        "<p>Before</p><p></p><p><strong>After</strong></p>",
      ),
    );

    expect(projection.text).toBe("Before\n\nAfter");
    expect(projection.marks).toContainEqual({
      from: 8,
      to: 13,
      type: "bold",
      attrs: {},
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  blockSignature,
  canonicalizeTextHtml,
  docToPlainText,
  htmlToDoc,
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

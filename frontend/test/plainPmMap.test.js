import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { plainOffsetsToPmRange } from "../src/tiptapEditor.js";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", group: "block" },
    text: { group: "inline" },
  },
});

describe("plainOffsetsToPmRange", () => {
  it("maps the end of a paragraph before the paragraph boundary", () => {
    const firstParagraph = "I preferred revising to";
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text(firstParagraph)),
      schema.node("paragraph", null, schema.text("Next paragraph")),
    ]);

    const range = plainOffsetsToPmRange(
      doc,
      firstParagraph.length,
      firstParagraph.length
    );

    expect(range.from).toBe(doc.child(0).nodeSize - 1);
  });
});

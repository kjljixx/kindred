import { describe, expect, it } from "vitest";
import { alignTwoWay } from "../src/docAlign.js";
import { htmlToDoc, docToPlainText } from "../src/kindredSchema.js";

function operationTexts(operation) {
  return {
    base: docToPlainText(operation.base || operation.ours),
    current: docToPlainText(operation.theirs || operation.node),
  };
}

describe("alignTwoWay", () => {
  it("pairs a lightly edited paragraph instead of the adjacent deleted paragraph", () => {
    const before = htmlToDoc(`
      <p>Curious and willing to follow ideas.</p>
      <p>Open-minded and learning primarily by listening to others'.</p>
      <p>8. Five years from now, where will you be?</p>
      <p>Five years from now, I expect to finish a CS degree.</p>
      <p>9. What have you read recently?</p>
    `);
    const after = htmlToDoc(`
      <p>Curious and willing to follow ideas.</p>
      <p>Open-minded and learning primarily by listening to others'</p>
      <p>Five years from now, I expect to finish a CS degree.</p>
      <p>9. What have you read recently?</p>
    `);

    const changed = alignTwoWay(before, after)
      .filter((operation) => operation.type !== "equal")
      .map((operation) => ({
        type: operation.type,
        ...operationTexts(operation),
      }));

    expect(changed).toEqual([
      {
        type: "replace",
        base: "Open-minded and learning primarily by listening to others'.",
        current: "Open-minded and learning primarily by listening to others'",
      },
      {
        type: "delete",
        base: "8. Five years from now, where will you be?",
        current: "",
      },
    ]);
  });

  it("does not pair unrelated adjacent paragraphs", () => {
    const before = htmlToDoc(`
      <p>Stable opening.</p>
      <p>My favorite course was English literature.</p>
      <p>Stable closing.</p>
    `);
    const after = htmlToDoc(`
      <p>Stable opening.</p>
      <p>I coach a robotics team on weekends.</p>
      <p>Stable closing.</p>
    `);

    const changed = alignTwoWay(before, after)
      .filter((operation) => operation.type !== "equal")
      .map((operation) => operation.type);

    expect(changed).toEqual(["delete", "insert"]);
  });
});

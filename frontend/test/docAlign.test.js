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
      <p>Placeholder intro line.</p>
      <p>Placeholder body text with a trailing period.</p>
      <p>Q1. Placeholder question about the future?</p>
      <p>Placeholder answer text that stays unchanged.</p>
      <p>Q2. Placeholder question about reading?</p>
    `);
    const after = htmlToDoc(`
      <p>Placeholder intro line.</p>
      <p>Placeholder body text with a trailing period</p>
      <p>Placeholder answer text that stays unchanged.</p>
      <p>Q2. Placeholder question about reading?</p>
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
        base: "Placeholder body text with a trailing period.",
        current: "Placeholder body text with a trailing period",
      },
      {
        type: "delete",
        base: "Q1. Placeholder question about the future?",
        current: "",
      },
    ]);
  });

  it("does not pair unrelated adjacent paragraphs", () => {
    const before = htmlToDoc(`
      <p>Stable opening.</p>
      <p>Alpha beta gamma delta epsilon.</p>
      <p>Stable closing.</p>
    `);
    const after = htmlToDoc(`
      <p>Stable opening.</p>
      <p>Unrelated words sharing nothing here.</p>
      <p>Stable closing.</p>
    `);

    const changed = alignTwoWay(before, after)
      .filter((operation) => operation.type !== "equal")
      .map((operation) => operation.type);

    expect(changed).toEqual(["delete", "insert"]);
  });

  it("keeps an insertion before the edited paragraph that follows it", () => {
    const edited = "Placeholder paragraph repeating several words across both versions of the document.";
    const inserted = "A brand new unrelated sentence appears just above it.";
    const before = htmlToDoc(`
      <p>Stable opening.</p>
      <p>(placeholder note)</p>
      <p>${edited} Second sentence mentions alpha and beta.</p>
      <p>Stable closing.</p>
    `);
    const after = htmlToDoc(`
      <p>Stable opening.</p>
      <p>(placeholder note)</p>
      <p>${inserted}</p>
      <p>${edited} Second sentence mentions alpha, beta, and gamma.</p>
      <p>Stable closing.</p>
    `);

    const changed = alignTwoWay(before, after)
      .filter((operation) => operation.type !== "equal")
      .map((operation) => ({
        type: operation.type,
        ...operationTexts(operation),
      }));

    expect(changed).toEqual([
      { type: "insert", base: "", current: inserted },
      {
        type: "replace",
        base: `${edited} Second sentence mentions alpha and beta.`,
        current: `${edited} Second sentence mentions alpha, beta, and gamma.`,
      },
    ]);
  });

  it("keeps current-document order when inserts sit between edited paragraphs before a deleted one", () => {
    const alpha = "Alpha paragraph opens with a long sentence about the first topic and its main supporting detail.";
    const beta = "Beta paragraph introduces the second topic with a different long sentence and another supporting detail.";
    const gamma = "Gamma paragraph describes the third topic using its own distinct wording and a closing detail.";
    const delta = "Delta paragraph explains the fourth topic with unique wording plus one more supporting detail.";
    const before = htmlToDoc(`
      <p>Stable opening.</p>
      <p>${alpha} Extra base sentence one.</p>
      <p>${beta} Extra base sentence two.</p>
      <p>${gamma} Extra base sentence three.</p>
      <p>${delta} Extra base sentence four.</p>
      <p>Final paragraph that is removed entirely from the new version.</p>
      <p>Stable prompt.</p>
    `);
    const after = htmlToDoc(`
      <p>Stable opening.</p>
      <p>${alpha}</p>
      <p>[Placeholder insert one.]</p>
      <p>[Placeholder insert two.]</p>
      <p>${beta}</p>
      <p>[Placeholder insert three.]</p>
      <p>${gamma}</p>
      <p>[Placeholder insert four.]</p>
      <p>${delta}</p>
      <p>[Placeholder insert five.]</p>
      <p>[Placeholder insert six.]</p>
      <p>Stable prompt.</p>
    `);

    const projected = alignTwoWay(before, after)
      .filter((operation) => operation.type !== "delete")
      .map((operation) => operationTexts(operation).current);

    expect(projected).toEqual([
      "Stable opening.",
      alpha,
      "[Placeholder insert one.]",
      "[Placeholder insert two.]",
      beta,
      "[Placeholder insert three.]",
      gamma,
      "[Placeholder insert four.]",
      delta,
      "[Placeholder insert five.]",
      "[Placeholder insert six.]",
      "Stable prompt.",
    ]);
  });
});

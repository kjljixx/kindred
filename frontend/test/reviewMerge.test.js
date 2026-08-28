import { describe, it, expect } from "vitest";
import { mergeHtmlViaAst } from "../src/docMerge.js";
import {
  mergeCleanEditsIntoMarked,
  parseConflictSegments,
  resolveBlockStateConflicts,
} from "../src/tiptapEditor.js";

describe("review deletion semantics", () => {
  it("represents a deleted paragraph as absence, not an empty paragraph", () => {
    const head = "<p>A</p><p>B</p><p>C</p>";
    const dirty = "<p>A</p><p>C</p>";
    const leafMerge = (_base, ours, theirs) => ({
      cleanMerge: false,
      mergedText:
        `<p><span data-kindred-text-conflict` +
        ` data-kindred-label-ours="HEAD" data-kindred-label-theirs="dirty"` +
        ` data-kindred-ours="${ours}" data-kindred-theirs="${theirs}"></span></p>`,
    });

    const result = mergeHtmlViaAst(
      head,
      head,
      dirty,
      "HEAD",
      "dirty",
      { review: true },
      leafMerge
    );
    const conflicts = parseConflictSegments(result.mergedText)
      .filter((segment) => segment.type === "conflict");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].theirs).toBe("");
    expect(conflicts[0].theirsState).toBe("deleted");
    expect(result.mergedText).not.toContain("data-kindred-theirs=\"&lt;p>&lt;/p>\"");
  });

  it("distinguishes an inserted blank paragraph from an absent block", () => {
    const head = "<p><strong>eee</strong></p>";
    const dirty =
      "<p></p><p><strong>eeeeee1</strong></p><p><mark>eeeeeeee</mark></p>";
    const result = mergeHtmlViaAst(
      head,
      head,
      dirty,
      "HEAD",
      "dirty",
      { review: true },
      () => ({ cleanMerge: false, mergedText: "" })
    );
    const conflicts = parseConflictSegments(result.mergedText)
      .filter((segment) => segment.type === "conflict");
    const insertedBlank = conflicts.find((segment) => segment.theirs === "<p></p>");

    expect(insertedBlank?.ours).toBe("");
    expect(insertedBlank?.oursState).toBe("deleted");
    expect(insertedBlank?.theirsState).toBe("");
  });

  it("preserves deletion state through editor conflict anchors", () => {
    const marked =
      `<p><span data-kindred-text-conflict data-kindred-label-ours="HEAD"` +
      ` data-kindred-label-theirs="dirty" data-kindred-ours="&lt;p>A&lt;/p>"` +
      ` data-kindred-theirs="" data-kindred-theirs-state="deleted"></span></p>`;
    const editorHtml = `<p><span data-kindred-conflict="0"></span></p>`;

    const merged = mergeCleanEditsIntoMarked(marked, editorHtml);
    const conflict = parseConflictSegments(merged)
      .find((segment) => segment.type === "conflict");

    expect(conflict?.theirsState).toBe("deleted");
  });

  it("resolves an inserted paragraph without nesting paragraph tags", () => {
    const head = "<p>A</p>";
    const dirty = "<p>A</p><p>B</p>";
    const result = mergeHtmlViaAst(
      head,
      head,
      dirty,
      "HEAD",
      "dirty",
      { review: true },
      () => ({ cleanMerge: false, mergedText: "" })
    );

    const resolved = resolveBlockStateConflicts(result.mergedText, "theirs");
    const doc = new DOMParser().parseFromString(resolved, "text/html");

    expect([...doc.body.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["A", "B"]);
    expect(resolved).not.toContain("<p><p>");
  });
});

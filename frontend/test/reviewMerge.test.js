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

const imageSrc = (hex) => `kindred-image:assets/${hex.repeat(64)}.png`;

function imageHtml(src, alt, title) {
  return `<img src="${src}" alt="${alt}" title="${title}">`;
}

function reviewImageMerge(base, current, incoming) {
  return mergeHtmlViaAst(
    base,
    current,
    incoming,
    "HEAD",
    "dirty",
    { review: true },
    () => ({ cleanMerge: false, mergedText: "" })
  );
}

function conflictImages(html) {
  const doc = new DOMParser().parseFromString(
    `<div>${html}</div>`,
    "text/html"
  );
  return [...doc.querySelectorAll("img")];
}

function expectImageSide(html, expected) {
  const images = conflictImages(html);
  expect(images).toHaveLength(1);
  expect(images[0].getAttribute("src")).toBe(expected.src);
  expect(images[0].getAttribute("alt")).toBe(expected.alt);
  expect(images[0].getAttribute("title")).toBe(expected.title);
}

describe("review image conflicts", () => {
  it("represents review image insertion as one atomic conflict", () => {
    const incoming = {
      src: imageSrc("a"),
      alt: "Incoming diagram",
      title: "Dirty diagram",
    };
    const result = reviewImageMerge(
      "<p>Before</p>",
      "<p>Before</p>",
      `<p>Before</p>${imageHtml(incoming.src, incoming.alt, incoming.title)}`
    );
    const conflicts = parseConflictSegments(result.mergedText).filter(
      (segment) => segment.type === "conflict"
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].oursState).toBe("deleted");
    expect(conflicts[0].theirsState).toBe("");
    expectImageSide(conflicts[0].theirs, incoming);
    expect(conflictImages(conflicts[0].ours)).toHaveLength(0);
  });

  it("represents review image deletion as one atomic conflict", () => {
    const current = {
      src: imageSrc("b"),
      alt: "Current chart",
      title: "HEAD chart",
    };
    const base = `<p>Before</p>${imageHtml(current.src, current.alt, current.title)}<p>After</p>`;
    const result = reviewImageMerge(
      base,
      base,
      "<p>Before</p><p>After</p>"
    );
    const conflicts = parseConflictSegments(result.mergedText).filter(
      (segment) => segment.type === "conflict"
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].oursState).toBe("");
    expect(conflicts[0].theirsState).toBe("deleted");
    expectImageSide(conflicts[0].ours, current);
    expect(conflictImages(conflicts[0].theirs)).toHaveLength(0);
  });

  it("represents review image replacement as one atomic conflict", () => {
    const original = {
      src: imageSrc("c"),
      alt: "Original photo",
      title: "Base photo",
    };
    const current = {
      src: imageSrc("d"),
      alt: "Current photo",
      title: "HEAD photo",
    };
    const incoming = {
      src: imageSrc("e"),
      alt: "Incoming photo",
      title: "Dirty photo",
    };
    const result = reviewImageMerge(
      imageHtml(original.src, original.alt, original.title),
      imageHtml(current.src, current.alt, current.title),
      imageHtml(incoming.src, incoming.alt, incoming.title)
    );
    const conflicts = parseConflictSegments(result.mergedText).filter(
      (segment) => segment.type === "conflict"
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].oursState).toBe("");
    expect(conflicts[0].theirsState).toBe("");
    expectImageSide(conflicts[0].ours, current);
    expectImageSide(conflicts[0].theirs, incoming);
  });

  it("preserves selected image HTML when resolving an image conflict", () => {
    const current = {
      src: imageSrc("f"),
      alt: "Current map",
      title: "HEAD map",
    };
    const base = `<p>Before</p>${imageHtml(current.src, current.alt, current.title)}<p>After</p>`;
    const result = reviewImageMerge(
      base,
      base,
      "<p>Before</p><p>After</p>"
    );
    const resolved = resolveBlockStateConflicts(result.mergedText, "ours");

    expectImageSide(resolved, current);
    expect(resolved).toContain("<p>Before</p>");
    expect(resolved).toContain("<p>After</p>");
  });

  it("removes an inserted image without leaving an empty paragraph", () => {
    const incoming = {
      src: imageSrc("a"),
      alt: "Dirty logo",
      title: "Incoming logo",
    };
    const result = reviewImageMerge(
      "<p>Before</p>",
      "<p>Before</p>",
      `<p>Before</p>${imageHtml(incoming.src, incoming.alt, incoming.title)}`
    );
    const resolved = resolveBlockStateConflicts(result.mergedText, "ours");
    const doc = new DOMParser().parseFromString(resolved, "text/html");

    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect([...doc.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual([
      "Before",
    ]);
    expect(resolved).not.toContain("<p></p>");
  });

  it("removes a deleted image without leaving an empty paragraph", () => {
    const current = {
      src: imageSrc("b"),
      alt: "Current logo",
      title: "HEAD logo",
    };
    const base = `<p>Before</p>${imageHtml(current.src, current.alt, current.title)}<p>After</p>`;
    const result = reviewImageMerge(
      base,
      base,
      "<p>Before</p><p>After</p>"
    );
    const resolved = resolveBlockStateConflicts(result.mergedText, "theirs");
    const doc = new DOMParser().parseFromString(resolved, "text/html");

    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect([...doc.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual([
      "Before",
      "After",
    ]);
    expect(resolved).not.toContain("<p></p>");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createGoogleDocument,
  initialGoogleDocsPushPhases,
  initialGoogleDocsPushProblems,
  pushGoogleDocument,
} from "../src/gdocsSync.js";
import { createKindredEditor } from "../src/tiptapEditor.js";

function documentFromHtml(html) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createKindredEditor({
    element,
    content: html,
    googleDocsCompatibility: {
      mergeAdjacentLists: () => true,
      preserveInitialTableParagraph: () => true,
      requireTableSeparatorParagraphs: () => true,
    },
  });
  const doc = editor.state.doc;
  editor.destroy();
  element.remove();
  return doc;
}

const requestTypes = (phases) => phases.map((phase) => phase.map((request) => Object.keys(request)[0]));

describe("initial push of a draft into a new Google Doc", () => {
  it("writes paragraphs with their text styles and no extra trailing paragraph", () => {
    const doc = documentFromHtml("<p>Hello <strong>bold</strong></p><p>World</p>");
    const phases = initialGoogleDocsPushPhases(doc);

    expect(phases).toHaveLength(1);
    expect(phases[0][0]).toEqual({ insertText: { location: { index: 1 }, text: "Hello bold\nWorld" } });
    expect(phases[0].slice(1).every((request) => request.updateTextStyle)).toBe(true);
    const bold = phases[0].find((request) => request.updateTextStyle?.range.startIndex === 7);
    expect(bold.updateTextStyle.textStyle.bold).toBe(true);
  });

  it("aligns paragraphs after inserting them", () => {
    const doc = documentFromHtml('<p>Left</p><p style="text-align: center">Middle</p>');
    const requests = initialGoogleDocsPushPhases(doc).flat();

    expect(requests.at(-1)).toEqual({ updateParagraphStyle: {
      range: { startIndex: 6, endIndex: 13 },
      paragraphStyle: { alignment: "CENTER" },
      fields: "alignment",
    } });
  });

  it("indents nested list items with tabs before creating bullets", () => {
    const doc = documentFromHtml("<ul><li><p>One</p><ul><li><p>Two</p></li></ul></li></ul>");
    const requests = initialGoogleDocsPushPhases(doc).flat();

    expect(requests[0]).toEqual({ insertText: { location: { index: 1 }, text: "One\n\tTwo" } });
    expect(requests.at(-1)).toEqual({ createParagraphBullets: {
      range: { startIndex: 1, endIndex: 10 },
      bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
    } });
    expect(requests[1].updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 4 });
    expect(requests[2].updateTextStyle.range).toEqual({ startIndex: 6, endIndex: 9 });
  });

  it("keeps a trailing empty paragraph when content follows a list", () => {
    const doc = documentFromHtml("<ol><li><p>One</p></li></ol><p>After</p>");
    const phases = initialGoogleDocsPushPhases(doc);

    expect(phases[0][0]).toEqual({ insertText: { location: { index: 1 }, text: "One\n" } });
    expect(phases[0].find((request) => request.createParagraphBullets).createParagraphBullets.range)
      .toEqual({ startIndex: 1, endIndex: 5 });
    expect(phases.flat().find((request) => request.insertText?.text === "After")).toBeTruthy();
  });

  it("inserts tables in their own phase before cell text", () => {
    const doc = documentFromHtml(
      "<p>Before</p><table><tr><td><p>A</p></td><td><p>B</p></td></tr></table><p>After</p>",
    );
    const phases = initialGoogleDocsPushPhases(doc);
    const types = requestTypes(phases);

    expect(types[0]).toContain("insertTable");
    expect(types.length).toBeGreaterThan(1);
    expect(phases.flat().filter((request) => request.insertTable)).toHaveLength(1);
    expect(phases.flat().find((request) => request.insertTable).insertTable)
      .toMatchObject({ rows: 1, columns: 2 });
    expect(phases.flat().map((request) => request.insertText?.text).filter(Boolean))
      .toEqual(expect.arrayContaining(["Before\n", "A", "B", "After"]));
  });

  it("reports content that cannot be copied yet", () => {
    const doc = documentFromHtml("<p>x</p><table><tr><td><p>A</p></td></tr></table>");
    expect(initialGoogleDocsPushProblems(doc)).toEqual(["table without a paragraph before and after"]);
    expect(() => initialGoogleDocsPushPhases(doc)).toThrow(/Cannot copy table without a paragraph/);
  });

  it("pushes nothing for an empty draft and keeps the created revision", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const doc = documentFromHtml("<p></p>");
      const next = await pushGoogleDocument(doc, { documentId: "doc-1", revisionId: "rev-1" });
      expect(next).toEqual({ documentId: "doc-1", revisionId: "rev-1" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("Google Doc creation", () => {
  it("posts the title and exposes the status on failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentId: "new-doc", revisionId: "r1" }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ detail: "401 sign in" }) });
    try {
      await expect(createGoogleDocument("My draft")).resolves.toEqual({ documentId: "new-doc", revisionId: "r1" });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: "My draft" });
      await expect(createGoogleDocument("x")).rejects.toMatchObject({ status: 401 });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

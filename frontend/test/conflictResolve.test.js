import { afterEach, describe, expect, it } from "vitest";
import { transactionToGoogleDocsBatchUpdateRequests } from "../src/gdocsSync.js";
import {
  conflictDisplayHtml,
  createKindredEditor,
  resolveAllConflictsToTheirs,
  resolveConflictInEditor,
} from "../src/tiptapEditor.js";

describe("resolveConflictInEditor", () => {
  let editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = "";
  });

  const createEditor = (content) => {
    const element = document.createElement("div");
    document.body.append(element);
    editor = createKindredEditor({ element, content });
  };

  it("replaces only the conflict anchor and keeps unrelated edits", () => {
    createEditor(
      `<p>start <span data-kindred-conflict="0"></span> mid <span data-kindred-conflict="1"></span> end</p>`
    );
    editor.commands.insertContentAt(1, "edited ");

    expect(resolveConflictInEditor(editor, 0, "<strong>chosen</strong>")).toBe(true);

    const html = editor.getHTML();
    expect(html).toContain("edited start");
    expect(html).toContain("<strong>chosen</strong>");
    expect(html).toContain('data-kindred-conflict="0"');
    expect(html).not.toContain('data-kindred-conflict="1"');
  });

  it("is a single undo step", () => {
    createEditor(`<p>a <span data-kindred-conflict="0"></span> b</p>`);
    resolveConflictInEditor(editor, 0, "X");
    editor.commands.undo();

    expect(editor.getHTML()).toContain('data-kindred-conflict="0"');
  });

  describe("Google Docs sync", () => {
    const resolveAndCollectRequests = (index, html, googleHtml) => {
      createEditor(`<p>a <span data-kindred-conflict="0"></span> b</p>`);
      const requests = [];
      editor.on("transaction", ({ transaction }) => {
        if (!transaction.docChanged || transaction.getMeta("skipGoogleDocsSync")) return;
        requests.push(...transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.before));
      });
      resolveConflictInEditor(editor, index, html, { googleHtml });
      return requests;
    };

    it("replaces the text Google already holds when the other side is chosen", () => {
      const requests = resolveAndCollectRequests(0, "OURS", "THEIRS");

      expect(requests.find((request) => request.deleteContentRange)).toBeTruthy();
      expect(requests.find((request) => request.insertText)?.insertText.text).toBe("OURS");
    });

    it("sends nothing when the side Google already holds is chosen", () => {
      expect(resolveAndCollectRequests(0, "THEIRS", "THEIRS")).toEqual([]);
    });

    it("sends nothing when Google's content is unknown", () => {
      expect(resolveAndCollectRequests(0, "OURS", undefined)).toEqual([]);
    });
  });

  it("returns false for an unknown conflict index", () => {
    createEditor("<p>plain</p>");

    expect(resolveConflictInEditor(editor, 0, "X")).toBe(false);
  });

  describe("resolveAllConflictsToTheirs", () => {
    const textMarker = ({ ours, theirs, oursState = "", theirsState = "" }) =>
      `<span data-kindred-text-conflict data-kindred-label-ours="HEAD" data-kindred-label-theirs="dirty"` +
      ` data-kindred-ours="${ours}" data-kindred-theirs="${theirs}"` +
      ` data-kindred-ours-state="${oursState}" data-kindred-theirs-state="${theirsState}"></span>`;

    const createMarkedEditor = (markedHtml) => createEditor(conflictDisplayHtml(markedHtml));

    it("replaces text conflicts with theirs and keeps the caret on its text", () => {
      const marked = `<p>start ${textMarker({ ours: "OURS", theirs: "THEIRS" })} end</p>`;
      createMarkedEditor(marked);
      editor.commands.setTextSelection(3);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toBe("<p>start THEIRS end</p>");
      expect(editor.state.selection.from).toBe(3);
    });

    it("removes a block deleted on the theirs side", () => {
      const marked =
        `<p>A</p><p>${textMarker({ ours: "&lt;p>B&lt;/p>", theirs: "", theirsState: "deleted" })}</p><p>C</p>`;
      createMarkedEditor(marked);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toBe("<p>A</p><p>C</p>");
    });

    it("inserts a block that only exists on the theirs side", () => {
      const marked =
        `<p>A</p><p>${textMarker({ ours: "", theirs: "&lt;p>B&lt;/p>", oursState: "deleted" })}</p><p>C</p>`;
      createMarkedEditor(marked);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toBe("<p>A</p><p>B</p><p>C</p>");
    });

    it("applies the theirs alignment", () => {
      const marked = `<p data-kindred-align-ours="left" data-kindred-align-theirs="center">x</p>`;
      createMarkedEditor(marked);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toContain("text-align: center");
      expect(editor.getHTML()).not.toContain("data-kindred-align");
    });

    it("replaces a conflicting table with theirs", () => {
      const cell = (text) => `<table><tbody><tr><td><p>${text}</p></td></tr></tbody></table>`;
      const attr = (html) => html.replaceAll("<", "&lt;");
      const marked =
        `<table data-kindred-table-ours="${attr(cell("O"))}" data-kindred-table-theirs="${attr(cell("T"))}">` +
        `<tbody><tr><td><p>O</p></td></tr></tbody></table>`;
      createMarkedEditor(marked);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toContain("<p>T</p>");
      expect(editor.getHTML()).not.toContain("data-kindred-table");
    });

    it("replaces a conflicting list with theirs", () => {
      const list = (text) => `<ul><li><p>${text}</p></li></ul>`;
      const attr = (html) => html.replaceAll("<", "&lt;");
      const marked =
        `<ul data-kindred-list-ours="${attr(list("O"))}" data-kindred-list-theirs="${attr(list("T"))}">` +
        `<li><p>O</p></li></ul>`;
      createMarkedEditor(marked);

      resolveAllConflictsToTheirs(editor, marked);

      expect(editor.getHTML()).toContain("<p>T</p>");
      expect(editor.getHTML()).not.toContain("data-kindred-list");
    });

    it("throws when an editor anchor has no matching conflict segment", () => {
      createEditor(`<p>a <span data-kindred-conflict="0"></span> b</p>`);

      expect(() => resolveAllConflictsToTheirs(editor, "<p>plain</p>")).toThrow(/no conflict segment/);
    });
  });
});

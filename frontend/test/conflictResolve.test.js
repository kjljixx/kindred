import { afterEach, describe, expect, it } from "vitest";
import { transactionToGoogleDocsBatchUpdateRequests } from "../src/gdocsSync.js";
import { createKindredEditor, resolveConflictInEditor } from "../src/tiptapEditor.js";

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
});

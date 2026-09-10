import { describe, expect, it, vi } from "vitest";
import {
  buildProseMirrorToGoogleDocsPositionMap,
  googleDocumentToKindredHtml,
  insertedPlainText,
  needsGoogleDocsAuthentication,
  pullGoogleDocument,
  pushGoogleDocsTransactions,
  transactionToGoogleDocsBatchUpdateRequests,
  transactionsToGoogleDocsBatchUpdatePhases,
} from "../src/gdocsSync.js";
import { bindToolbar, createKindredEditor, setHtml } from "../src/tiptapEditor.js";

describe("Google Docs pull", () => {
  it("preserves a permission response status for authentication handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ detail: "The caller does not have permission" }),
    }));

    const error = await pullGoogleDocument("document-id").catch((caught) => caught);

    expect(error.message).toBe("The caller does not have permission");
    expect(error.status).toBe(403);
    expect(needsGoogleDocsAuthentication(error)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("does not append a trailing paragraph when replacing content with a list", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Before</p>",
      googleDocsCompatibility: { disableTrailingNode: true },
    });
    setHtml(editor, "<ul><li><p>test1</p></li><li><p>test2</p></li></ul>", {
      source: "google-docs-pull",
    });

    expect(editor.getJSON().content.map((node) => node.type)).toEqual(["bulletList"]);
    const positionMap = buildProseMirrorToGoogleDocsPositionMap(editor.state.doc);
    expect(positionMap.mapPosition(editor.state.doc.content.size)).toBe(13);
    let transaction = null;
    editor.on("transaction", ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    });
    editor.commands.selectAll();
    editor.commands.deleteSelection();
    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.before)).toEqual([
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 13 } } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 12 } } },
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("preserves trailing paragraph spaces used by Google Docs positions", () => {
    const html = googleDocumentToKindredHtml({
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 7,
            paragraph: {
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              elements: [{
                startIndex: 1,
                endIndex: 7,
                textRun: { content: "test \n", textStyle: {} },
              }],
            },
          },
          {
            startIndex: 7,
            endIndex: 13,
            paragraph: {
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              elements: [{
                startIndex: 7,
                endIndex: 13,
                textRun: { content: "test2\n", textStyle: {} },
              }],
            },
          },
        ],
      },
    });

    expect(html).toBe("<p>test&nbsp;</p><p>test2</p>");

    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({ element: editorElement, content: html });
    const before = editor.state.doc;
    const transaction = editor.state.tr.insertText("3", before.content.size - 1);

    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, before)[0]).toEqual({
      insertText: { location: { index: 12 }, text: "3" },
    });

    editor.destroy();
    editorElement.remove();
  });

  it("keeps bold when Google supplies a normal font-family weight", () => {
    const html = googleDocumentToKindredHtml({
      body: {
        content: [{
          startIndex: 1,
          endIndex: 15,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{
              startIndex: 1,
              endIndex: 15,
              textRun: {
                content: "Unordered one\n",
                textStyle: {
                  bold: true,
                  weightedFontFamily: { fontFamily: "Times New Roman", weight: 400 },
                },
              },
            }],
          },
        }],
      },
    });

    expect(html).toContain("<strong>");
    expect(html).toContain("Unordered one");
  });

  it("uses the editor content font as the fallback for pulled fonts", () => {
    const html = googleDocumentToKindredHtml({
      body: {
        content: [{
          startIndex: 1,
          endIndex: 14,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{
              startIndex: 1,
              endIndex: 14,
              textRun: {
                content: "Calibri text\n",
                textStyle: {
                  weightedFontFamily: { fontFamily: "Calibri", weight: 400 },
                },
              },
            }],
          },
        }],
      },
    });

    expect(html).toContain("font-family: Calibri, var(--font-content)");
  });

  it("preserves formatting on linked text", () => {
    const html = googleDocumentToKindredHtml({
      body: {
        content: [{
          startIndex: 1,
          endIndex: 70,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{
              startIndex: 1,
              endIndex: 70,
              textRun: {
                content: "https://github.com/kjljixx/Aurora-Chess-Engine\n",
                textStyle: {
                  bold: true,
                  fontSize: { magnitude: 9, unit: "PT" },
                  link: { url: "https://github.com/kjljixx/Aurora-Chess-Engine" },
                  weightedFontFamily: { fontFamily: "Times New Roman", weight: 400 },
                },
              },
            }],
          },
        }],
      },
    });

    expect(html).toContain("<strong>");
    expect(html).toContain("font-size: 9pt");
    expect(html).toContain("Times New Roman");
    expect(html).toContain('href="https://github.com/kjljixx/Aurora-Chess-Engine"');
  });

  it("inverts pulled Google Docs text and highlight colors for the dark editor", () => {
    const html = googleDocumentToKindredHtml({
      body: {
        content: [{
          startIndex: 1,
          endIndex: 6,
          paragraph: {
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            elements: [{
              startIndex: 1,
              endIndex: 6,
              textRun: {
                content: "Link\n",
                textStyle: {
                  link: { url: "https://example.com" },
                  foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
                  backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                },
              },
            }],
          },
        }],
      },
    });

    expect(html).toContain("color: rgb(255, 255, 255)");
    expect(html).toContain("background-color: rgb(0, 0, 0)");
  });

  it("shows a pulled bare font family in the toolbar picker", () => {
    const editorElement = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.innerHTML = [
      '<select data-font-family>',
      '<option value="Arial, Helvetica, sans-serif">Arial</option>',
      '<option value="\'Noto Sans\', sans-serif">Noto Sans</option>',
      "</select>",
    ].join("");
    document.body.append(editorElement, toolbar);

    const editor = createKindredEditor({
      element: editorElement,
      content: '<p><span style="font-family: Arial">Arial text</span></p>',
    });
    const binding = bindToolbar(editor, toolbar);

    expect(toolbar.querySelector("[data-font-family]").value).toBe("Arial, Helvetica, sans-serif");

    binding.destroy();
    editor.destroy();
    editorElement.remove();
    toolbar.remove();
  });

  it("rounds fractional font sizes only in the toolbar display", () => {
    const editorElement = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.innerHTML = '<input type="number" data-font-size value="12">';
    document.body.append(editorElement, toolbar);

    const editor = createKindredEditor({
      element: editorElement,
      content: '<p><span style="font-size: 11.04pt">Fractional size</span></p>',
    });
    editor.commands.setTextSelection({ from: 1, to: 16 });
    const binding = bindToolbar(editor, toolbar);

    expect(toolbar.querySelector("[data-font-size]").value).toBe("11");
    expect(editor.getHTML()).toContain("font-size: 11.04pt");

    binding.destroy();
    editor.destroy();
    editorElement.remove();
    toolbar.remove();
  });

  it("applies the displayed whole font size after an explicit edit", () => {
    const editorElement = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.innerHTML = '<input type="number" data-font-size value="12">';
    document.body.append(editorElement, toolbar);

    const editor = createKindredEditor({
      element: editorElement,
      content: '<p><span style="font-size: 11.04pt">Fractional size</span></p>',
    });
    editor.commands.setTextSelection({ from: 1, to: 16 });
    const binding = bindToolbar(editor, toolbar);
    const input = toolbar.querySelector("[data-font-size]");

    input.dispatchEvent(new Event("focus"));
    input.value = "11";
    input.dispatchEvent(new Event("change"));

    expect(editor.getHTML()).toContain("font-size: 11pt");
    expect(editor.getHTML()).not.toContain("11.04pt");

    binding.destroy();
    editor.destroy();
    editorElement.remove();
    toolbar.remove();
  });
});

describe("Google Docs text push", () => {
  it("preserves the required final newline when all document text is deleted", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({ element: editorElement, content: "<p>Test</p>" });
    const before = editor.state.doc;
    const transaction = editor.state.tr.delete(0, before.content.size);

    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, before)).toEqual([
      { deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } },
    ]);

    editor.destroy();
    editorElement.remove();
  });

  it("preserves the required final newline when an entire list document is deleted", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({
      element: editorElement,
      content: "<ul><li><p>First</p></li><li><p>Second</p></li></ul><p></p>",
    });
    editor.commands.setTextSelection({ from: 0, to: editor.state.doc.content.size });
    const before = editor.state.doc;
    let transaction = null;
    editor.on("transaction", ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    });
    editor.commands.deleteSelection();

    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, before)).toEqual([
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 14 } } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 13 } } },
    ]);

    editor.destroy();
    editorElement.remove();
  });

  it("restores all document text without sending an empty deletion", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({ element: editorElement, content: "<p>Test</p>" });
    editor.commands.setTextSelection({ from: 0, to: editor.state.doc.content.size });
    editor.commands.deleteSelection();
    const before = editor.state.doc;
    let transaction = null;
    const captureTransaction = ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    };
    editor.on("transaction", captureTransaction);
    editor.commands.undo();
    editor.off("transaction", captureTransaction);

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests[0]).toEqual({ insertText: { location: { index: 1 }, text: "Test" } });
    expect(requests.some((request) => request.deleteContentRange)).toBe(false);

    editor.destroy();
    editorElement.remove();
  });
});

describe("Google Docs math push", () => {
  function createMathEditor(content) {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createKindredEditor({ element, content });
    return { editor, element };
  }

  it("maps text after a math atom to its raw ASCIIMath position", () => {
    const { editor, element } = createMathEditor('<p>A<span data-kindred-math="x+1"></span>B</p>');

    const positionMap = buildProseMirrorToGoogleDocsPositionMap(editor.state.doc);

    expect(positionMap.mapPosition(2)).toBe(2);
    expect(positionMap.mapPosition(3)).toBe(5);

    editor.destroy();
    element.remove();
  });

  it("inserts text after a trailing math atom after its raw ASCIIMath source", () => {
    const { editor, element } = createMathEditor('<p>A<span data-kindred-math="x+1"></span></p>');
    const before = editor.state.doc;
    const transaction = editor.state.tr.insertText("!", 3);

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests).toEqual([
      { insertText: { location: { index: 5 }, text: "!" } },
      expect.objectContaining({ updateTextStyle: expect.any(Object) }),
    ]);

    editor.destroy();
    element.remove();
  });

  it("inserts text in the paragraph after a math-only paragraph at its raw-text index", () => {
    const { editor, element } = createMathEditor(
      '<p><span data-kindred-math="x+1"></span></p><p>some text here</p>',
    );
    const before = editor.state.doc;
    const transaction = editor.state.tr.insertText("s", 13);

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests[0]).toEqual({ insertText: { location: { index: 14 }, text: "s" } });

    editor.destroy();
    element.remove();
  });

  it("replaces a math atom with its raw ASCIIMath text", () => {
    const { editor, element } = createMathEditor('<p>A<span data-kindred-math="x+1"></span>B</p>');
    const before = editor.state.doc;
    const transaction = editor.state.tr.setNodeMarkup(2, undefined, { asciiMath: "y^2" });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests).toEqual([
      { deleteContentRange: { range: { startIndex: 2, endIndex: 5 } } },
      { insertText: { location: { index: 2 }, text: "y^2" } },
    ]);

    editor.destroy();
    element.remove();
  });

  it("pushes the result appended by automatic math calculation", () => {
    const { editor, element } = createMathEditor("<p>ab</p>");
    const transaction = editor.state.tr
      .insertText("2+2=", 2)
      .setMeta("googleDocsTextInsertions", [{ position: 6, text: "4" }]);

    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.before)).toEqual([
      { insertText: { location: { index: 2 }, text: "2+2=" } },
      expect.objectContaining({ updateTextStyle: expect.any(Object) }),
      { insertText: { location: { index: 6 }, text: "4" } },
    ]);

    editor.destroy();
    element.remove();
  });
});

describe("Google Docs list push", () => {
  it("extracts restored list-item text instead of treating it as an empty split", () => {
    const beforeElement = document.createElement("div");
    const afterElement = document.createElement("div");
    document.body.append(beforeElement, afterElement);
    const before = createKindredEditor({
      element: beforeElement,
      content: "<ol><li><p>One</p></li></ol>",
    });
    const after = createKindredEditor({
      element: afterElement,
      content: "<ol><li><p>One</p></li><li><p>Two</p></li><li><p>Three</p></li></ol>",
    });

    expect(insertedPlainText(before.state.doc, after.state.doc)).toBe("\nTwo\nThree");

    before.destroy();
    after.destroy();
    beforeElement.remove();
    afterElement.remove();
  });

  it("keeps a text-preserving list split as a single newline", () => {
    const beforeElement = document.createElement("div");
    const afterElement = document.createElement("div");
    document.body.append(beforeElement, afterElement);
    const before = createKindredEditor({
      element: beforeElement,
      content: "<ol><li><p>OneTwo</p></li></ol>",
    });
    const after = createKindredEditor({
      element: afterElement,
      content: "<ol><li><p>One</p></li><li><p>Two</p></li></ol>",
    });

    expect(insertedPlainText(before.state.doc, after.state.doc)).toBe("\n");

    before.destroy();
    after.destroy();
    beforeElement.remove();
    afterElement.remove();
  });

  it("clears inherited formatting when typing after disabling a stored mark", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p><strong>Bold</strong></p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(5);
    editor.commands.toggleBold();
    editor.commands.insertContent(" plain");

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertText", "updateTextStyle"]);
    expect(requests[1].updateTextStyle).toMatchObject({
      textStyle: { bold: false },
    });
    expect(requests[1].updateTextStyle.fields.split(",")).toEqual(expect.arrayContaining([
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "link",
      "foregroundColor",
      "backgroundColor",
      "weightedFontFamily",
      "fontSize",
    ]));
    editor.destroy();
    editorElement.remove();
  });

  it("always sets the complete style of inserted text", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Plain</p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(6);
    editor.commands.insertContent(" text");

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertText", "updateTextStyle"]);
    expect(requests[1].updateTextStyle.textStyle).toEqual({
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      link: null,
      foregroundColor: null,
      backgroundColor: null,
      weightedFontFamily: null,
      fontSize: null,
    });
    editor.destroy();
    editorElement.remove();
  });

  it("inverts editor text color before pushing it to Google Docs", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({ element: editorElement, content: "<p>Color</p>" });
    const before = editor.state.doc;
    const transaction = editor.state.tr.addMark(
      1,
      6,
      editor.schema.marks.textStyle.create({ color: "#000000" }),
    );

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests).toEqual([{
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 6 },
        textStyle: {
          foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
        },
        fields: "foregroundColor",
      },
    }]);
    editor.destroy();
    editorElement.remove();
  });

  it("merges adjacent lists only in Google Docs compatibility mode", () => {
    const makeEditor = (enabled) => {
      const element = document.createElement("div");
      document.body.append(element);
      const editor = createKindredEditor({
        element,
        content: "<ol><li><p>One</p></li></ol><p>remove me</p><ol><li><p>Two</p></li></ol>",
        googleDocsCompatibility: {
          mergeAdjacentLists: () => enabled,
        },
      });
      const separatorStart = editor.state.doc.child(0).nodeSize;
      editor.view.dispatch(editor.state.tr.delete(
        separatorStart,
        separatorStart + editor.state.doc.child(1).nodeSize,
      ));
      return { editor, element };
    };
    const compatible = makeEditor(true);
    const regular = makeEditor(false);

    expect(compatible.editor.state.doc.childCount).toBe(2);
    expect(compatible.editor.state.doc.firstChild.childCount).toBe(2);
    expect(regular.editor.state.doc.childCount).toBe(3);

    compatible.editor.destroy();
    regular.editor.destroy();
    compatible.element.remove();
    regular.element.remove();
  });

  it("outdents a nested list item in Google Docs compatibility mode", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({
      element: editorElement,
      content: "<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul></li></ul>",
      googleDocsCompatibility: {
        mergeAdjacentLists: () => true,
      },
    });
    editor.commands.setTextSelection(10);

    const lifted = editor.commands.liftListItem("listItem");

    expect(lifted).toBe(true);
    expect(editor.getHTML()).toContain("<li><p>Parent</p></li><li><p>Child</p></li>");
    editor.destroy();
    editorElement.remove();
  });

});

describe("Google Docs table push", () => {
  it("deletes complete document blocks in reverse order around tables", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: [
        "<p>Before</p>",
        "<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>",
        "<p>After</p>",
      ].join(""),
    });
    editor.on("transaction", ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    });
    editor.commands.selectAll();
    editor.commands.deleteSelection();

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.before);

    expect(requests).toEqual([
      { deleteContentRange: { range: { startIndex: 17, endIndex: 22 } } },
      { deleteContentRange: { range: { startIndex: 8, endIndex: 17 } } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 8 } } },
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("deletes a table-only document using the exact table range", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>",
      googleDocsCompatibility: { disableTrailingNode: true },
    });
    editor.on("transaction", ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    });
    const before = editor.state.doc;
    const positionMap = buildProseMirrorToGoogleDocsPositionMap(before);
    editor.commands.selectAll();
    editor.commands.deleteSelection();

    expect(transactionToGoogleDocsBatchUpdateRequests(transaction, before)).toEqual([
      {
        deleteContentRange: {
          range: {
            startIndex: 1,
            endIndex: positionMap.mapPosition(before.content.size),
          },
        },
      },
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("generates a push for each of three consecutively inserted tables", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const transactions = [];
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>a</p>",
      googleDocsCompatibility: {
        requireTableSeparatorParagraphs: () => true,
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged && !transaction.getMeta("skipGoogleDocsSync")) {
          transactions.push({ transaction, before: transaction.before });
        }
      },
    });

    for (let index = 0; index < 3; index += 1) {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: false });
    }

    const requests = transactions.flatMap(({ transaction, before }) =>
      transactionToGoogleDocsBatchUpdateRequests(transaction, before),
    );
    expect(requests.filter((request) => request.insertTable)).toHaveLength(3);
    editor.destroy();
    editorElement.remove();
  });

  it("removes Google's preceding separator after inserting a table from an empty paragraph", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Plain one</p><p></p><p>Plain two</p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(12);
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);
    const phases = transactionsToGoogleDocsBatchUpdatePhases([{ transaction, before }]);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable", "deleteContentRange"]);
    expect(requests[0].insertTable.location.index).toBe(11);
    expect(requests[1].deleteContentRange.range).toEqual({ startIndex: 10, endIndex: 11 });
    expect(phases).toEqual([requests]);
    editor.destroy();
    editorElement.remove();
  });

  it("uses the same empty-paragraph cleanup before an existing table", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const table = "<table><tbody><tr><td><p></p></td></tr></tbody></table>";
    const editor = createKindredEditor({
      element: editorElement,
      content: `<p>Test</p><p></p>${table}<p></p>`,
      googleDocsCompatibility: {
        requireTableSeparatorParagraphs: () => true,
      },
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(7);
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable", "deleteContentRange"]);
    expect(requests[0].insertTable.location.index).toBe(6);
    expect(requests[1].deleteContentRange.range).toEqual({ startIndex: 5, endIndex: 6 });
    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual([
      "paragraph",
      "table",
      "paragraph",
      "table",
      "paragraph",
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("removes a paragraph separator before inserting a table at the end of a paragraph", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Plain one</p><p>Plain two</p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(10);
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["deleteContentRange", "insertTable"]);
    expect(requests[0].deleteContentRange.range).toEqual({ startIndex: 10, endIndex: 11 });
    expect(requests[1].insertTable.location.index).toBe(10);
    editor.destroy();
    editorElement.remove();
  });

  it("preserves the initial empty paragraph when inserting a table into an empty document", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const transactions = [];
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p></p>",
      googleDocsCompatibility: {
        preserveInitialTableParagraph: () => true,
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) transactions.push(transaction);
      },
    });
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].getMeta("skipGoogleDocsSync")).toBeUndefined();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual(["paragraph"]);
    editor.destroy();
    editorElement.remove();
  });

  it("uses normal table insertion when initial paragraph preservation is disabled", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p></p>",
      googleDocsCompatibility: {
        preserveInitialTableParagraph: () => false,
      },
    });
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    expect(editor.state.doc.firstChild.type.name).toBe("table");
    editor.destroy();
    editorElement.remove();
  });

  it("removes Google's preceding separator when appending a table from an empty paragraph", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const table = "<table><tbody><tr><td><p></p></td></tr></tbody></table>";
    const editor = createKindredEditor({
      element: editorElement,
      content: `${table}<p></p>`,
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable", "deleteContentRange"]);
    expect(requests[0].insertTable.location.index).toBe(6);
    expect(requests[1].deleteContentRange.range).toEqual({ startIndex: 5, endIndex: 6 });
    editor.destroy();
    editorElement.remove();
  });

  it("preserves the required separator when inserting before another table", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Plain one</p><table><tbody><tr><td><p></p></td></tr></tbody></table><p></p>",
      googleDocsCompatibility: {
        requireTableSeparatorParagraphs: () => true,
      },
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.setTextSelection(10);
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: false });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable"]);
    expect(requests[0].insertTable.location.index).toBe(10);
    expect(transaction.getMeta("skipGoogleDocsSync")).toBeUndefined();
    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual([
      "paragraph",
      "table",
      "paragraph",
      "table",
      "paragraph",
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("does not upsync deletion of a required table separator", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    const table = "<table><tbody><tr><td><p></p></td></tr></tbody></table>";
    const editor = createKindredEditor({
      element: editorElement,
      content: `${table}<p></p>${table}`,
      googleDocsCompatibility: {
        requireTableSeparatorParagraphs: () => true,
      },
      onTransaction: ({ transaction: nextTransaction }) => {
        if (nextTransaction.docChanged) transaction = nextTransaction;
      },
    });
    const separatorPosition = editor.state.doc.child(0).nodeSize;

    editor.view.dispatch(editor.state.tr.delete(
      separatorPosition,
      separatorPosition + editor.state.doc.child(1).nodeSize,
    ));

    expect(transaction.getMeta("skipGoogleDocsSync")).toBe("table-separator-repair");
    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual([
      "table",
      "paragraph",
      "table",
      "paragraph",
    ]);
    editor.destroy();
    editorElement.remove();
  });

  it("hydrates cells when a prefilled table is inserted", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Before</p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });

    editor.commands.insertContent({
      type: "table",
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Restored cell", marks: [{ type: "bold" }] }],
          }],
        }],
      }],
    });

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable", "insertText", "updateTextStyle"]);
    expect(requests[1].insertText.text).toBe("Restored cell");
    expect(requests[2].updateTextStyle.textStyle.bold).toBe(true);

    const phases = transactionsToGoogleDocsBatchUpdatePhases([{ transaction, before }]);
    expect(phases.map((phase) => phase.map((request) => Object.keys(request)[0]))).toEqual([
      ["insertTable"],
      ["insertText", "updateTextStyle"],
    ]);

    editor.destroy();
    editorElement.remove();
  });

  it("reads back the new revision before hydrating inserted cells", async () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<p>Before</p>",
      onTransaction: ({ transaction: nextTransaction }) => {
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });
    editor.commands.insertContent({
      type: "table",
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hydrate" }] }],
        }],
      }],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ document: {}, revisionId: "revision-2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ document: {}, revisionId: "revision-3" }) });

    const result = await pushGoogleDocsTransactions(
      [{ transaction, before }],
      { documentId: "document-1", revisionId: "revision-1" },
    );

    const firstPush = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondPush = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(firstPush.targetRevisionId).toBe("revision-1");
    expect(firstPush.requests.map((request) => Object.keys(request)[0])).toEqual(["insertTable"]);
    expect(secondPush.targetRevisionId).toBe("revision-2");
    expect(secondPush.requests.map((request) => Object.keys(request)[0])).toEqual(["insertText"]);
    expect(result.revisionId).toBe("revision-3");

    fetchMock.mockRestore();
    editor.destroy();
    editorElement.remove();
  });

  it("hydrates restored cells when undo inserts a deleted column", () => {
    const editorElement = document.createElement("div");
    document.body.append(editorElement);
    let transaction = null;
    let before = null;
    const editor = createKindredEditor({
      element: editorElement,
      content: "<table><tbody><tr><td><p>Keep</p></td><td><p>Restore</p></td></tr></tbody></table>",
      onTransaction: ({ transaction: nextTransaction }) => {
        if (!nextTransaction.docChanged) return;
        transaction = nextTransaction;
        before = nextTransaction.before;
      },
    });

    editor.commands.setTextSelection(12);
    editor.commands.deleteColumn();
    editor.commands.undo();

    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);

    expect(requests.map((request) => Object.keys(request)[0])).toEqual(["insertTableColumn", "insertText"]);
    expect(requests[1].insertText.text).toBe("Restore");

    editor.destroy();
    editorElement.remove();
  });
});

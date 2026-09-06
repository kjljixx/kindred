import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { SelectionUnits } from "../src/selectionUnits.js";

function createEditor(content) {
  return new Editor({
    content,
    extensions: [StarterKit, SelectionUnits],
  });
}

function range(editor) {
  const { from, to } = editor.state.selection;
  return { from, to };
}

describe("SelectionUnits", () => {
  it("loops paragraph selection back to the word at the original caret", () => {
    const editor = createEditor("<p>The quick brown fox.</p>");
    editor.commands.setTextSelection(12);

    editor.commands.expandSelectionUnit();
    expect(range(editor)).toEqual({ from: 11, to: 16 });

    editor.commands.expandSelectionUnit();
    expect(range(editor)).toEqual({ from: 1, to: 21 });

    editor.commands.expandSelectionUnit();
    expect(range(editor)).toEqual({ from: 11, to: 16 });

    editor.destroy();
  });

  it("moves the saved origin with an adjacent word selection", () => {
    const editor = createEditor("<p>extraordinary cat sleeps.</p>");
    editor.commands.setTextSelection(9);
    editor.commands.expandSelectionUnit();

    editor.commands.moveSelectionUnit(1);
    expect(range(editor)).toEqual({ from: 15, to: 18 });

    editor.commands.expandSelectionUnit();
    expect(range(editor)).toEqual({ from: 1, to: 26 });

    editor.commands.expandSelectionUnit();
    expect(range(editor)).toEqual({ from: 15, to: 18 });

    editor.destroy();
  });

  it("returns a Ctrl+L selection to its saved origin on Escape", () => {
    const editor = createEditor("<p>The quick brown fox.</p>");
    editor.commands.setTextSelection(12);
    editor.commands.expandSelectionUnit();
    editor.commands.expandSelectionUnit();

    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, new KeyboardEvent("keydown", { key: "Escape" }))
    );

    expect(range(editor)).toEqual({ from: 12, to: 12 });
    editor.destroy();
  });

  it("moves the saved origin with transposed content", () => {
    const editor = createEditor("<p>First.</p><p>Second.</p><p>Third.</p>");
    editor.commands.setTextSelection(12);
    editor.commands.expandSelectionUnit();
    editor.commands.expandSelectionUnit();

    editor.commands.transposeSelectionUnit(1);
    const moved = range(editor);
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, new KeyboardEvent("keydown", { key: "Escape" }))
    );

    expect(range(editor)).toEqual({
      from: moved.from + 3,
      to: moved.from + 3,
    });
    expect(editor.getText({ blockSeparator: "\n" })).toBe(
      "First.\nThird.\nSecond."
    );
    editor.destroy();
  });

  it("returns an ordinary backward selection to its anchor on Escape", () => {
    const editor = createEditor("<p>The quick brown fox.</p>");
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 16, 5))
    );

    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, new KeyboardEvent("keydown", { key: "Escape" }))
    );

    expect(range(editor)).toEqual({ from: 16, to: 16 });
    editor.destroy();
  });
});

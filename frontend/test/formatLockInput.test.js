import { afterEach, describe, expect, it } from "vitest";
import { bindToolbar, createKindredEditor } from "../src/tiptapEditor.js";

describe("format lock typing", () => {
  let editor;
  let binding;

  afterEach(() => {
    binding?.destroy();
    editor?.destroy();
    document.body.innerHTML = "";
  });

  it("replaces a selection once, then inserts subsequent characters at the caret", () => {
    document.body.innerHTML = '<div data-editor></div><div data-toolbar></div>';
    editor = createKindredEditor({
      element: document.querySelector("[data-editor]"),
      content: "<p>abcdef</p>",
    });
    binding = bindToolbar(editor, document.querySelector("[data-toolbar]"));
    binding.applyState({ formatLock: true, lockedMarks: [{ type: "bold" }] });
    editor.commands.setTextSelection({ from: 2, to: 5 });

    const type = (text) => {
      const { from, to } = editor.state.selection;
      editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, text)
      );
    };
    type("X");
    expect(editor.state.selection.empty).toBe(true);
    type("Y");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.getHTML()).toContain("<strong>XY</strong>");
    expect(editor.getText()).toBe("aXYef");
  });
});

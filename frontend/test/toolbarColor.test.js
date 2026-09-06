import { afterEach, describe, expect, it } from "vitest";
import { bindToolbar, createKindredEditor } from "../src/tiptapEditor.js";

describe("font color toolbar", () => {
  let editor;
  let binding;
  const waitForToolbarSync = () => new Promise((resolve) => setTimeout(resolve, 20));

  afterEach(() => {
    binding?.destroy();
    editor?.destroy();
    document.body.innerHTML = "";
  });

  it("returns to the default color when the caret leaves colored text", async () => {
    document.body.innerHTML = `
      <div data-editor></div>
      <div data-toolbar>
        <label class="toolbar-color">
          <span class="tb-color-swatch"></span>
          <input data-color-input data-default-color="#e4e4e7" value="#e4e4e7">
        </label>
      </div>
    `;
    editor = createKindredEditor({
      element: document.querySelector("[data-editor]"),
      content: '<p><span style="color: #ff0000">red</span></p><p>plain</p>',
    });
    const toolbar = document.querySelector("[data-toolbar]");
    const input = toolbar.querySelector("[data-color-input]");
    binding = bindToolbar(editor, toolbar);

    editor.commands.setTextSelection(2);
    await waitForToolbarSync();
    expect(input.value).toBe("#ff0000");

    editor.commands.setTextSelection(7);
    expect(editor.getAttributes("textStyle").color).toBeUndefined();
    await waitForToolbarSync();
    expect(input.value).toBe("#e4e4e7");
  });
});

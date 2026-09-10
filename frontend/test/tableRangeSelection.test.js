import { afterEach, describe, expect, it } from "vitest";
import { createKindredEditor } from "../src/tiptapEditor.js";

describe("table range selection", () => {
  let editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = "";
  });

  function createEditor() {
    document.body.innerHTML = '<div data-editor></div>';
    editor = createKindredEditor({
      element: document.querySelector("[data-editor]"),
      content: "<p>Before</p><table><tbody><tr><td><p>One</p></td><td><p>Two</p></td></tr></tbody></table><p>After</p>",
    });
  }

  it("highlights table cells when select-all crosses the table", () => {
    createEditor();

    editor.commands.selectAll();

    expect(
      document.querySelectorAll("td.range-selected-cell")
    ).toHaveLength(2);
  });

  it("does not highlight table cells for a selection outside the table", () => {
    createEditor();

    editor.commands.setTextSelection({ from: 1, to: 7 });

    expect(
      document.querySelectorAll("td.range-selected-cell")
    ).toHaveLength(0);
  });

  it("removes the highlight when the selection collapses", () => {
    createEditor();
    editor.commands.selectAll();

    editor.commands.setTextSelection(2);

    expect(
      document.querySelectorAll("td.range-selected-cell")
    ).toHaveLength(0);
  });
});

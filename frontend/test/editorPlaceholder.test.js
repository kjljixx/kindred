import { afterEach, describe, expect, it } from "vitest";
import { createKindredEditor } from "../src/tiptapEditor.js";

describe("editor placeholder", () => {
  let editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = "";
  });

  const createEditor = (content) => {
    const element = document.createElement("div");
    document.body.append(element);
    editor = createKindredEditor({ element, content, placeholder: "Placeholder" });
    editor.commands.selectAll();
    return element.querySelector("[data-placeholder]");
  };

  it("shows for a blank single-paragraph document after select all", () => {
    expect(createEditor("<p></p>")?.dataset.placeholder).toBe("Placeholder");
  });

  it("stays hidden for several empty paragraphs after select all", () => {
    expect(createEditor("<p></p><p></p>")?.dataset.placeholder).toBe("");
  });

  it("stays hidden when an empty table makes the document structurally non-empty", () => {
    const placeholderNode = createEditor(`
      <p></p>
      <table>
        <tbody>
          <tr><td><p></p></td></tr>
        </tbody>
      </table>
    `);

    expect(placeholderNode?.dataset.placeholder).toBe("");
  });
});

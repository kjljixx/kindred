import { describe, expect, it } from "vitest";
import { blockToHtml, htmlToDoc, htmlToPlainText } from "../src/kindredSchema.js";
import { createMathLiveNodeView } from "../src/mathLiveNodeView.js";
import { renderMathForExport } from "../src/mathRender.js";

describe("mathLive node storage", () => {
  it("stores ASCIIMath in an atomic inline node and preserves it as plain text", () => {
    const html = '<p>Before <span data-kindred-math="x^2">x^2</span> after</p>';
    const doc = htmlToDoc(html);
    const formula = doc.content[0].content[1];

    expect(formula).toMatchObject({
      type: "mathLive",
      attrs: { asciiMath: "x^2" },
    });
    expect(htmlToPlainText(html)).toBe("Before x^2 after");
    const exported = renderMathForExport(blockToHtml(doc.content[0]));
    expect(exported).toContain('class="render-latex"');
    if (document.compatMode === "CSS1Compat") {
      expect(exported).toContain('class="katex"');
    }
  });
});

describe("mathLive node editing", () => {
  it("selects an automatically calculated result", () => {
    const transactions = [];
    const nodeView = createMathLiveNodeView({
      node: {
        attrs: { asciiMath: "2+2" },
        nodeSize: 1,
      },
      view: {
        state: {
          tr: {
            setNodeMarkup: () => ({
              setMeta() {
                return this;
              },
            }),
          },
        },
        dispatch: (transaction) => transactions.push(transaction),
      },
      getPos: () => 1,
    });
    const field = nodeView.dom.querySelector("math-field");
    field.value = "2+2=";
    field.getValue = () => "2+2=";
    let position = 4;
    let selection = null;
    Object.defineProperties(field, {
      position: {
        get: () => position,
        set: (nextPosition) => {
          position = nextPosition === -1 && field.value.includes("4") ? 5 : 4;
        },
      },
      selection: {
        get: () => selection,
        set: (nextSelection) => {
          selection = nextSelection;
        },
      },
    });

    field.dispatchEvent(new InputEvent("input", {
      inputType: "insertText",
      data: "=",
      bubbles: true,
    }));

    expect(field.selection).toEqual({
      ranges: [[4, 5]],
      direction: "forward",
    });
    expect(transactions).toHaveLength(1);
    nodeView.destroy();
  });

  it.each(["ArrowLeft", "ArrowRight"])("leaves Shift+%s selection to MathLive", (key) => {
    const nodeView = createMathLiveNodeView({
      node: {
        attrs: { asciiMath: "abc" },
        nodeSize: 1,
      },
      view: {},
      getPos: () => 1,
    });
    const field = nodeView.dom.querySelector("math-field");
    const commands = [];
    field.executeCommand = (command) => commands.push(command);
    const event = new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(commands).toEqual([]);
    nodeView.destroy();
  });
});

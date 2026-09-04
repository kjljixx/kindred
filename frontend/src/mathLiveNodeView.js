import "mathlive";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { asciiMathToLatex } from "./mathRender.js";

function focusMathField(view, pos, command) {
  const nodeDom = view.nodeDOM(pos);
  const field = nodeDom?.querySelector?.("math-field");
  if (!field) return false;
  field.focus();
  field.executeCommand(command);
  return true;
}

/** ProseMirror node view that lets MathLive own formula-internal interaction. */
export function createMathLiveNodeView({ node, view, getPos }) {
  const dom = document.createElement("span");
  dom.className = "kindred-math-node";
  dom.contentEditable = "false";

  const field = document.createElement("math-field");
  field.className = "kindred-math-field";
  field.value = asciiMathToLatex(node.attrs.asciiMath);
  field.setAttribute("aria-label", `Formula: ${node.attrs.asciiMath}`);
  dom.append(field);

  let currentNode = node;
  let lastAsciiMath = node.attrs.asciiMath;

  const persist = () => {
    const nextAsciiMath = field.getValue("ascii-math");
    if (nextAsciiMath === lastAsciiMath) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    lastAsciiMath = nextAsciiMath;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...currentNode.attrs,
        asciiMath: nextAsciiMath,
      }),
    );
  };

  const moveOut = (event) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const direction = event.detail?.direction;
    const before = direction === "backward" || direction === "upward";
    const selectionPos = before ? pos : pos + currentNode.nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selectionPos)));
    view.focus();
  };

  field.addEventListener("input", persist);
  field.addEventListener("move-out", moveOut);

  return {
    dom,
    stopEvent: (event) => event.target.closest?.(".kindred-math-node") != null,
    ignoreMutation: () => true,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false;
      currentNode = nextNode;
      if (nextNode.attrs.asciiMath !== lastAsciiMath && document.activeElement !== field) {
        lastAsciiMath = nextNode.attrs.asciiMath;
        field.value = asciiMathToLatex(lastAsciiMath);
      }
      return true;
    },
    destroy() {
      field.removeEventListener("input", persist);
      field.removeEventListener("move-out", moveOut);
    },
  };
}

/** Move seamlessly between ordinary text and an inline MathLive formula. */
export const MathLiveNavigation = Extension.create({
  name: "mathLiveNavigation",
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (!view.state.selection.empty || event.shiftKey) return false;
          const { $from } = view.state.selection;
          const forward = event.key === "ArrowRight";
          const backward = event.key === "ArrowLeft";
          if (!forward && !backward) return false;

          const target = forward ? $from.nodeAfter : $from.nodeBefore;
          if (target?.type.name !== "mathLive") return false;

          const pos = forward ? $from.pos : $from.pos - target.nodeSize;
          const command = forward ? "moveToMathfieldStart" : "moveToMathfieldEnd";
          if (!focusMathField(view, pos, command)) return false;
          event.preventDefault();
          return true;
        },
      },
    })];
  },
});

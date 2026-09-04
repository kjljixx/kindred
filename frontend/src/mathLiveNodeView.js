import "mathlive";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { calculateTrailingEquals, isMathLiveEqualsInput } from "./mathCompute.js";
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
  let documentSelectionDrag = false;

  const persist = (event) => {
    let nextAsciiMath = field.getValue("ascii-math");
    const calculatedAsciiMath = isMathLiveEqualsInput(event)
      ? calculateTrailingEquals(nextAsciiMath)
      : null;
    if (calculatedAsciiMath && calculatedAsciiMath !== nextAsciiMath) {
      nextAsciiMath = calculatedAsciiMath;
      field.value = asciiMathToLatex(nextAsciiMath);
    }
    if (nextAsciiMath === lastAsciiMath) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    lastAsciiMath = nextAsciiMath;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...currentNode.attrs,
        asciiMath: nextAsciiMath,
      }).setMeta("mathNodeEditing", pos),
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

  const clearDocumentSelection = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const { selection } = view.state;
    if (selection.empty && selection.from === pos) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  };

  field.addEventListener("input", persist);
  field.addEventListener("move-out", moveOut);
  field.addEventListener("focus", clearDocumentSelection);

  const stopEvent = (event) => {
    if (!event.target.closest?.(".kindred-math-node")) return false;

    if (event.type === "mousemove" || event.type === "pointermove") {
      if (event.buttons) {
        documentSelectionDrag = true;
        return false;
      }
      return true;
    }

    if (event.type === "mouseup" || event.type === "pointerup") {
      if (documentSelectionDrag) {
        documentSelectionDrag = false;
        return false;
      }
      return true;
    }

    if (event.type === "mousedown" || event.type === "pointerdown") {
      documentSelectionDrag = false;
    }

    return true;
  };

  return {
    dom,
    stopEvent,
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
      field.removeEventListener("focus", clearDocumentSelection);
    },
  };
}

/** Move seamlessly between ordinary text and an inline MathLive formula. */
export const MathLiveNavigation = Extension.create({
  name: "mathLiveNavigation",
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        decorations(state) {
          const decorations = [];
          const { from, to } = state.selection;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "mathLive") return;
            if (from > pos || to < pos + node.nodeSize) return;
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: "kindred-math-selected",
              }),
            );
          });
          return DecorationSet.create(state.doc, decorations);
        },
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

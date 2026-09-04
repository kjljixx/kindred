import "mathlive";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { calculateTrailingEquals, isMathLiveEqualsInput } from "./mathCompute.js";
import { asciiMathToLatex } from "./mathRender.js";

function focusMathField(view, pos, commands) {
  const nodeDom = view.nodeDOM(pos);
  const field = nodeDom?.querySelector?.("math-field");
  if (!field) return false;
  field.focus();
  for (const command of commands) field.executeCommand(command);
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
  let handledMoveOut = false;

  const exitToDocument = (direction) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const before = direction === "backward" || direction === "upward";
    const selectionPos = before ? pos : pos + currentNode.nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selectionPos)));
    view.focus();
  };

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
    if (!String(nextAsciiMath).trim()) {
      const tr = view.state.tr.delete(pos, pos + currentNode.nodeSize);
      view.dispatch(
        tr.setSelection(TextSelection.create(tr.doc, pos)).setMeta("mathNodeEditing", pos),
      );
      view.focus();
      return;
    }
    lastAsciiMath = nextAsciiMath;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...currentNode.attrs,
        asciiMath: nextAsciiMath,
      }).setMeta("mathNodeEditing", pos),
    );
  };

  const moveOut = (event) => {
    handledMoveOut = true;
    event.preventDefault();
    exitToDocument(event.detail?.direction);
  };

  const moveWithinFormulaOrExit = (event) => {
    if (!field.selectionIsCollapsed) return;
    const forward = event.key === "ArrowRight";
    const backward = event.key === "ArrowLeft";
    if (!forward && !backward) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const command = forward ? "moveToNextChar" : "moveToPreviousChar";
    handledMoveOut = false;
    field.executeCommand(command);
    if (handledMoveOut) return;

    const positionAfterOneMove = field.position;
    field.executeCommand(command);
    if (!handledMoveOut) field.position = positionAfterOneMove;
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
  field.addEventListener("keydown", moveWithinFormulaOrExit, true);

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
      field.removeEventListener("keydown", moveWithinFormulaOrExit, true);
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
          if (
            !view.state.selection.empty ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          ) return false;
          const { $from } = view.state.selection;
          const forward = event.key === "ArrowRight";
          const left = event.key === "ArrowLeft";
          const backspace = event.key === "Backspace";
          if (!forward && !left && !backspace) return false;

          const target = forward ? $from.nodeAfter : $from.nodeBefore;
          if (target?.type.name !== "mathLive") return false;

          const pos = forward ? $from.pos : $from.pos - target.nodeSize;
          const commands = forward
            ? ["moveToMathfieldStart", "moveToNextChar"]
            : left
              ? ["moveToMathfieldEnd", "moveToPreviousChar"]
              : ["moveToMathfieldEnd", "deleteBackward"];
          if (!focusMathField(view, pos, commands)) return false;
          event.preventDefault();
          return true;
        },
      },
    })];
  },
});

import "mathlive";
import { convertAsciiMathToLatex } from "mathlive";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { calculateTrailingEquals, isMathLiveEqualsInput } from "./mathCompute.js";

/** MathLive-native ASCII→LaTeX so getValue("ascii-math") roundtrips (asciimath2tex uses \\lvert). */
function asciiMathForMathLive(source) {
  return convertAsciiMathToLatex(String(source || "").trim());
}

let activeMathField = null;
const mathFocusListeners = new Set();

export function getActiveMathField() {
  return activeMathField;
}

/** Subscribe to math-field focus changes. Listener gets the field or null. */
export function subscribeMathFocus(listener) {
  mathFocusListeners.add(listener);
  return () => mathFocusListeners.delete(listener);
}

function setActiveMathField(field) {
  if (activeMathField === field) return;
  activeMathField = field;
  for (const listener of mathFocusListeners) listener(field);
}

function shouldKeepMathFocus(field) {
  if (document.activeElement === field) return true;
  const active = document.activeElement;
  if (active?.closest?.("[data-math-tools]")) return true;
  if (active?.closest?.(".clr-picker")) return true;
  if (document.querySelector(".clr-picker.clr-open")) return true;
  return false;
}

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
  field.value = asciiMathForMathLive(node.attrs.asciiMath);
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
      field.value = asciiMathForMathLive(nextAsciiMath);
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

  const onFocus = () => {
    clearDocumentSelection();
    setActiveMathField(field);
  };

  const onBlur = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (shouldKeepMathFocus(field)) return;
        if (getActiveMathField() === field) setActiveMathField(null);
      });
    });
  };

  field.addEventListener("input", persist);
  field.addEventListener("move-out", moveOut);
  field.addEventListener("focus", onFocus);
  field.addEventListener("blur", onBlur);
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
        field.value = asciiMathForMathLive(lastAsciiMath);
      }
      return true;
    },
    destroy() {
      field.removeEventListener("input", persist);
      field.removeEventListener("move-out", moveOut);
      field.removeEventListener("focus", onFocus);
      field.removeEventListener("blur", onBlur);
      field.removeEventListener("keydown", moveWithinFormulaOrExit, true);
      if (getActiveMathField() === field) setActiveMathField(null);
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

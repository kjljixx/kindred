import "mathlive";
import { convertAsciiMathToLatex } from "mathlive";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { calculateTrailingEquals, isMathLiveEqualsInput } from "./mathCompute.js";

function parenthesizedLatex(source, start) {
  if (!source.startsWith("\\left(", start)) return null;
  let depth = 1;
  const bodyStart = start + "\\left(".length;
  for (let i = bodyStart; i < source.length;) {
    if (source.startsWith("\\left(", i)) {
      depth += 1;
      i += "\\left(".length;
    } else if (source.startsWith("\\right)", i)) {
      depth -= 1;
      if (!depth) return { body: source.slice(bodyStart, i), end: i + "\\right)".length };
      i += "\\right)".length;
    } else {
      i += 1;
    }
  }
  return null;
}

function restoreIndexedRoots(source) {
  let result = "";
  let cursor = 0;
  const root = /\broot(?=\\left\()/g;
  for (let match = root.exec(source); match; match = root.exec(source)) {
    const index = parenthesizedLatex(source, root.lastIndex);
    const radicand = index && parenthesizedLatex(source, index.end);
    if (!radicand) continue;
    result += source.slice(cursor, match.index);
    result += `\\sqrt[${restoreIndexedRoots(index.body)}]{${restoreIndexedRoots(radicand.body)}}`;
    cursor = radicand.end;
    root.lastIndex = cursor;
  }
  return result + source.slice(cursor);
}

/** MathLive-native ASCII→LaTeX so getValue("ascii-math") roundtrips (asciimath2tex uses \\lvert). */
function asciiMathForMathLive(source) {
  return restoreIndexedRoots(convertAsciiMathToLatex(String(source || "").trim()))
    .replace(/\*/g, "\\cdot ");
}

export function selectCalculatedSuffix(field, expression, calculation) {
  field.value = asciiMathForMathLive(expression);
  field.position = -1;
  const resultStart = field.position;
  field.value = asciiMathForMathLive(`${expression}${calculation}`);
  field.position = -1;
  field.selection = {
    ranges: [[resultStart, field.position]],
    direction: "forward",
  };
  field.dataset.autocalcResultSelected = "true";
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
    const calculatedResult = isMathLiveEqualsInput(event)
      ? calculateTrailingEquals(nextAsciiMath)
      : null;
    if (calculatedResult != null) {
      selectCalculatedSuffix(field, nextAsciiMath, calculatedResult);
      nextAsciiMath += calculatedResult;
    }
    if (nextAsciiMath === lastAsciiMath) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (!String(nextAsciiMath).trim()) {
      field.blur();
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
    event.preventDefault();
    exitToDocument(event.detail?.direction);
  };

  const exitAfterSelectedAutocalcResult = (event) => {
    if (event.shiftKey) return;
    if (event.key !== "ArrowRight" || field.dataset.autocalcResultSelected !== "true") return;
    delete field.dataset.autocalcResultSelected;
    event.preventDefault();
    event.stopImmediatePropagation();
    exitToDocument("forward");
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

  const copySelectionAsAsciiMath = (event) => {
    if (field.selectionIsCollapsed || !event.clipboardData) return;
    const selectedAsciiMath = field.getValue(field.selection, "ascii-math");
    if (!selectedAsciiMath) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedAsciiMath);
  };

  const clearAutocalcSelectionState = () => {
    delete field.dataset.autocalcResultSelected;
  };

  field.addEventListener("input", persist);
  field.addEventListener("move-out", moveOut);
  field.addEventListener("focus", onFocus);
  field.addEventListener("blur", onBlur);
  field.addEventListener("copy", copySelectionAsAsciiMath);
  field.addEventListener("selection-change", clearAutocalcSelectionState);
  field.addEventListener("keydown", exitAfterSelectedAutocalcResult, true);

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
        field.setAttribute("aria-label", `Formula: ${lastAsciiMath}`);
      }
      return true;
    },
    destroy() {
      field.removeEventListener("input", persist);
      field.removeEventListener("move-out", moveOut);
      field.removeEventListener("focus", onFocus);
      field.removeEventListener("blur", onBlur);
      field.removeEventListener("copy", copySelectionAsAsciiMath);
      field.removeEventListener("selection-change", clearAutocalcSelectionState);
      field.removeEventListener("keydown", exitAfterSelectedAutocalcResult, true);
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
          if (backspace) {
            event.preventDefault();
            const asciiMath = Array.from(target.attrs.asciiMath || "").slice(0, -1).join("");
            if (!asciiMath) {
              view.dispatch(view.state.tr.delete(pos, pos + target.nodeSize));
              return true;
            }
            view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {
              ...target.attrs,
              asciiMath,
            }));
            const nodeDom = view.nodeDOM(pos);
            const field = nodeDom?.querySelector?.("math-field");
            if (field) {
              field.focus();
              field.position = -1;
            }
            return true;
          }
          const commands = forward
            ? ["moveToMathfieldStart"]
            : ["moveToMathfieldEnd"];
          if (!focusMathField(view, pos, commands)) return false;
          event.preventDefault();
          return true;
        },
      },
    })];
  },
});

import { Extension } from "@tiptap/core";
import { evaluate } from "mathjs";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { overlayKey } from "./editorKeys.js";
import { classifyMath } from "./mathTextDetector.js";
import { createMathWidget } from "./mathRender.js";

const mathTextKey = new PluginKey("kindredMathText");
const mathAutoCalcKey = new PluginKey("kindredMathAutoCalc");

function getOverlayState(state) {
  const fromKey = overlayKey.getState(state);
  if (fromKey) return fromKey;
  for (const key of Object.getOwnPropertyNames(state)) {
    if (key.startsWith("kindredOverlay")) return state[key];
  }
  return null;
}

function overlayMathInputsChanged(oldState, newState) {
  const a = getOverlayState(oldState);
  const b = getOverlayState(newState);
  if (!a || !b) return a !== b;
  return (
    a.showDiffs !== b.showDiffs ||
    a.baseline !== b.baseline ||
    a.currentPlain !== b.currentPlain ||
    (a.formatHunks?.length || 0) !== (b.formatHunks?.length || 0)
  );
}

function isDiffOverlayActive(state) {
  const overlay = getOverlayState(state);
  if (!overlay?.showDiffs) return false;

  const baseline = overlay.baseline || "";
  const currentPlain = overlay.currentPlain || "";
  if (baseline !== currentPlain) return true;

  return (overlay.formatHunks?.length || 0) > 0;
}

const MATH_BLOCK_TYPES = new Set([
  "paragraph"
]);

function collectLinearText(node, blockPos) {
  const segments = [];
  let linearText = "";

  node.descendants((child, pos) => {
    if (!child.isText) return;
    const start = linearText.length;
    linearText += child.text;
    segments.push({ start, end: linearText.length, pmStart: blockPos + 1 + pos });
  });

  return { linearText, segments };
}

function pmPosForOffset(segments, offset) {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) {
      return segment.pmStart + (offset - segment.start);
    }
    if (offset === segment.end && segment.end > segment.start) {
      return segment.pmStart + (segment.end - segment.start);
    }
  }
  return null;
}

function linearOffsetForPmPos(segments, pmPos) {
  for (const segment of segments) {
    const length = segment.end - segment.start;
    const segPmEnd = segment.pmStart + length;
    if (pmPos >= segment.pmStart && pmPos <= segPmEnd) {
      return segment.start + (pmPos - segment.pmStart);
    }
  }
  return null;
}

/** True when a user transaction inserted "=" (not auto-calc or pure deletion). */
export function userInsertedEquals(transactions) {
  for (const tr of transactions) {
    if (!tr.docChanged || tr.getMeta("mathAutoCalc")) continue;

    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep)) continue;

      const inserted = step.slice.content.textBetween(
        0,
        step.slice.content.size,
        "",
      );
      if (inserted.includes("=")) return true;
    }
  }
  return false;
}

/** Evaluate a math run slice that ends with "="; null if not calculable. */
export function evaluateHangingEquals(slice) {
  if (!slice.endsWith("=")) return null;
  const expr = slice.slice(0, -1).trim();
  if (!expr) return null;
  try {
    const value = evaluate(expr);
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return String(value);
  } catch {
    return null;
  }
}

function findAutoCalcTransaction(state) {
  if (isDiffOverlayActive(state) || !state.selection.empty) return null;

  let transaction = null;

  state.doc.descendants((node, pos) => {
    if (transaction || !MATH_BLOCK_TYPES.has(node.type.name)) return;

    const { linearText, segments } = collectLinearText(node, pos);
    const cursorOffset = linearOffsetForPmPos(segments, state.selection.from);
    if (cursorOffset == null) return;

    for (const range of classifyMath(linearText).ranges) {
      if (range.end !== cursorOffset) continue;
      const result = evaluateHangingEquals(
        linearText.slice(range.start, range.end),
      );
      if (result == null) continue;
      const insertPos = pmPosForOffset(segments, range.end);
      if (insertPos == null) continue;
      transaction = state.tr
        .insertText(result, insertPos)
        .setMeta("mathAutoCalc", true);
      return false;
    }
  });

  return transaction;
}

function selectionOverlapsRange(selection, from, to) {
  if (selection.empty) {
    return selection.from > from && selection.from < to;
  }
  return selection.from < to && selection.to > from;
}

function createMathFakeCaret() {
  return () => {
    const el = document.createElement("span");
    el.className = "kindred-math-fake-caret";
    el.contentEditable = "false";
    el.setAttribute("aria-hidden", "true");
    return el;
  };
}

function mathCaretAtBoundary(selection, from, to) {
  if (!selection.empty) return null;
  if (selection.from === from) return { pos: from, side: -1 };
  if (selection.from === to) return { pos: to, side: 1 };
  return null;
}

function buildMathDecorations(doc, selection, state) {
  if (isDiffOverlayActive(state)) {
    return [];
  }

  const decorations = [];

  doc.descendants((node, pos) => {
    if (!MATH_BLOCK_TYPES.has(node.type.name)) return;

    const { linearText, segments } = collectLinearText(node, pos);
    if (!linearText.trim()) return;

    const result = classifyMath(linearText);

    for (const range of result.ranges) {
      const from = pmPosForOffset(segments, range.start);
      const to = pmPosForOffset(segments, range.end);
      if (from == null || to == null || from >= to) continue;
      if (selectionOverlapsRange(selection, from, to)) continue;

      const mathText = linearText.slice(range.start, range.end);
      const key = `math-${from}-${to}-${mathText}`;
      const caret = mathCaretAtBoundary(selection, from, to);

      if (caret) {
        decorations.push(
          Decoration.widget(caret.pos, createMathFakeCaret(), {
            side: caret.side,
            key: `${key}-caret`,
          }),
        );
      }

      decorations.push(
        Decoration.inline(from, to, { class: "kindred-math-source" }),
        Decoration.widget(from, createMathWidget(mathText), {
          side: -1,
          key,
        }),
      );
    }
  });

  return decorations;
}

export const MathAutoCalc = Extension.create({
  name: "mathAutoCalc",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mathAutoCalcKey,
        appendTransaction(transactions, _oldState, newState) {
          if (
            !transactions.some(
              (tr) => tr.docChanged && !tr.getMeta("mathAutoCalc"),
            )
          ) {
            return null;
          }
          if (!userInsertedEquals(transactions)) {
            return null;
          }
          return findAutoCalcTransaction(newState);
        },
      }),
    ];
  },
});

export const MathText = Extension.create({
  name: "mathText",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mathTextKey,
        state: {
          init: (_, state) =>
            DecorationSet.create(
              state.doc,
              buildMathDecorations(state.doc, state.selection, state),
            ),
          apply(tr, prev, oldState, newState) {
            const overlayChanged =
              Boolean(tr.getMeta(overlayKey)) ||
              overlayMathInputsChanged(oldState, newState);

            if (!tr.docChanged && !tr.selectionSet && !overlayChanged) {
              return prev.map(tr.mapping, tr.doc);
            }
            return DecorationSet.create(
              newState.doc,
              buildMathDecorations(newState.doc, newState.selection, newState),
            );
          },
        },
        props: {
          decorations(state) {
            return mathTextKey.getState(state);
          },
        },
      }),
    ];
  },
});

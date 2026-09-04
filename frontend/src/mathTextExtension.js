import { Extension } from "@tiptap/core";
import { evaluate } from "mathjs";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { overlayKey } from "./editorKeys.js";
import { classifyMath } from "./mathTextDetector.js";

const mathTextKey = new PluginKey("kindredMathText");
const mathAutoCalcKey = new PluginKey("kindredMathAutoCalc");
const MAX_CALC_DECIMAL_PLACES = 6;
const MATH_BLOCK_TYPES = new Set(["paragraph"]);

function getOverlayState(state) {
  const fromKey = overlayKey.getState(state);
  if (fromKey) return fromKey;
  for (const key of Object.getOwnPropertyNames(state)) {
    if (key.startsWith("kindredOverlay")) return state[key];
  }
  return null;
}

function isDiffOverlayActive(state) {
  const overlay = getOverlayState(state);
  if (!overlay?.showDiffs) return false;
  return (overlay.baseline || "") !== (overlay.currentPlain || "") || (overlay.formatHunks?.length || 0) > 0;
}

function collectLinearText(node, blockPos) {
  const segments = [];
  let linearText = "";

  node.descendants((child, pos) => {
    if (child.type.name === "mathLive") {
      linearText += "\uFFFC";
      return false;
    }
    if (!child.isText) return;
    const start = linearText.length;
    linearText += child.text;
    segments.push({ start, end: linearText.length, pmStart: blockPos + 1 + pos });
  });

  return { linearText, segments };
}

function pmPosForOffset(segments, offset) {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) return segment.pmStart + offset - segment.start;
    if (offset === segment.end && segment.end > segment.start) return segment.pmStart + segment.end - segment.start;
  }
  return null;
}

function linearOffsetForPmPos(segments, pmPos) {
  for (const segment of segments) {
    const end = segment.pmStart + segment.end - segment.start;
    if (pmPos >= segment.pmStart && pmPos <= end) return segment.start + pmPos - segment.pmStart;
  }
  return null;
}

function mathNodeTransaction(state) {
  if (isDiffOverlayActive(state)) return null;
  const replacements = [];

  state.doc.descendants((node, pos) => {
    if (!MATH_BLOCK_TYPES.has(node.type.name)) return;
    const { linearText, segments } = collectLinearText(node, pos);
    for (const range of classifyMath(linearText).ranges) {
      const from = pmPosForOffset(segments, range.start);
      const to = pmPosForOffset(segments, range.end);
      if (from == null || to == null || from >= to) continue;
      replacements.push({ from, to, asciiMath: linearText.slice(range.start, range.end) });
    }
  });

  if (!replacements.length) return null;
  let tr = state.tr;
  for (const replacement of replacements.reverse()) {
    const marks = tr.doc.resolve(replacement.from).marks();
    const mathNode = tr.doc.type.schema.nodes.mathLive.create(
      { asciiMath: replacement.asciiMath },
      null,
      marks,
    );
    tr = tr.replaceWith(replacement.from, replacement.to, mathNode);
  }
  return tr.setMeta("mathNodeConversion", true);
}

export function normalizeMathNodes(editor) {
  const tr = mathNodeTransaction(editor.state);
  if (tr) editor.view.dispatch(tr);
}

export function userInsertedEquals(transactions) {
  for (const tr of transactions) {
    if (!tr.docChanged || tr.getMeta("mathAutoCalc")) continue;
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep)) continue;
      if (step.slice.content.textBetween(0, step.slice.content.size, "").includes("=")) return true;
    }
  }
  return false;
}

export function evaluateHangingEquals(slice) {
  if (!slice.endsWith("=")) return null;
  const expr = slice.slice(0, -1).trim();
  if (!expr) return null;
  try {
    const value = evaluate(expr);
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return String(Number(value.toFixed(MAX_CALC_DECIMAL_PLACES)));
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
      const result = evaluateHangingEquals(linearText.slice(range.start, range.end));
      const insertPos = pmPosForOffset(segments, range.end);
      if (result == null || insertPos == null) continue;
      transaction = state.tr.insertText(result, insertPos).setMeta("mathAutoCalc", true);
      return false;
    }
  });
  return transaction;
}

export const MathAutoCalc = Extension.create({
  name: "mathAutoCalc",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: mathAutoCalcKey,
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged && !tr.getMeta("mathAutoCalc"))) return null;
        if (!userInsertedEquals(transactions)) return null;
        return findAutoCalcTransaction(newState);
      },
    })];
  },
});

export const MathText = Extension.create({
  name: "mathText",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: mathTextKey,
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged && !tr.getMeta("mathNodeConversion"))) return null;
        return mathNodeTransaction(newState);
      },
    })];
  },
});

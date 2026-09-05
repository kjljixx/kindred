import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { overlayKey } from "./editorKeys.js";
import { calculateTrailingEquals } from "./mathCompute.js";
import { classifyMath } from "./mathTextDetector.js";

const mathTextKey = new PluginKey("kindredMathText");
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
  return !!(overlay?.showDiffs && !overlay.conflicts);
}

function collectLinearText(node, blockPos) {
  const segments = [];
  let linearText = "";

  node.descendants((child, pos) => {
    if (child.type.name === "mathLive") {
      const start = linearText.length;
      linearText += child.attrs.asciiMath;
      segments.push({
        start,
        end: linearText.length,
        pmStart: blockPos + 1 + pos,
        pmEnd: blockPos + 1 + pos + child.nodeSize,
        mathNode: child,
      });
      return false;
    }
    if (!child.isText) return;
    const start = linearText.length;
    linearText += child.text;
    segments.push({
      start,
      end: linearText.length,
      pmStart: blockPos + 1 + pos,
      pmEnd: blockPos + 1 + pos + child.nodeSize,
      mathNode: null,
    });
  });

  return { linearText, segments };
}

function pmPosForOffset(segments, offset) {
  for (const segment of segments) {
    if (offset === segment.start) return segment.pmStart;
    if (offset === segment.end) return segment.pmEnd;
    if (!segment.mathNode && offset > segment.start && offset < segment.end) {
      return segment.pmStart + offset - segment.start;
    }
  }
  return null;
}

export function changedRangesInFinalDoc(transactions) {
  const ranges = [];
  transactions.forEach((transaction, transactionIndex) => {
    transaction.mapping.maps.forEach((stepMap, stepIndex) => {
      stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        let from = newStart;
        let to = newEnd;
        for (let i = stepIndex + 1; i < transaction.mapping.maps.length; i += 1) {
          from = transaction.mapping.maps[i].map(from, -1);
          to = transaction.mapping.maps[i].map(to, 1);
        }
        for (let i = transactionIndex + 1; i < transactions.length; i += 1) {
          from = transactions[i].mapping.map(from, -1);
          to = transactions[i].mapping.map(to, 1);
        }
        ranges.push({ from: Math.min(from, to), to: Math.max(from, to) });
      });
    });
  });
  return ranges;
}

function blockTouchesRanges(pos, node, ranges) {
  if (!ranges) return true;
  const end = pos + node.nodeSize;
  return ranges.some((range) => pos <= range.to && end >= range.from);
}

export function mathNodeTransaction(
  state,
  editingMathNodePos = null,
  calculateAfterEquals = false,
  changedRanges = null,
) {
  if (isDiffOverlayActive(state)) return null;
  const replacements = [];

  state.doc.descendants((node, pos) => {
    if (!MATH_BLOCK_TYPES.has(node.type.name) || !blockTouchesRanges(pos, node, changedRanges)) {
      return;
    }
    const { linearText, segments } = collectLinearText(node, pos);
    for (const range of classifyMath(linearText).ranges) {
      const from = pmPosForOffset(segments, range.start);
      const to = pmPosForOffset(segments, range.end);
      if (from == null || to == null || from >= to) continue;
      const asciiMath = linearText.slice(range.start, range.end);
      const includedMathNodes = segments.filter((segment) => (
        segment.mathNode &&
        segment.start >= range.start &&
        segment.end <= range.end
      ));
      const isUnchangedMathNode =
        includedMathNodes.length === 1 &&
        range.start === includedMathNodes[0].start &&
        range.end === includedMathNodes[0].end;
      const editsActiveMathNode = includedMathNodes.some(
        (segment) => segment.pmStart === editingMathNodePos,
      );
      if (isUnchangedMathNode || editsActiveMathNode) continue;
      replacements.push({ from, to, asciiMath });
    }
  });

  if (!replacements.length) return null;
  let tr = state.tr;
  for (const replacement of replacements.reverse()) {
    const marks = tr.doc.resolve(replacement.from).marks();
    const calculatedAsciiMath = calculateAfterEquals
      ? calculateTrailingEquals(replacement.asciiMath)
      : null;
    const mathNode = tr.doc.type.schema.nodes.mathLive.create(
      { asciiMath: calculatedAsciiMath || replacement.asciiMath },
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

/** Replace mathLive atoms with their asciiMath text (Diff / plain view). */
export function expandMathNodesToText(editor) {
  if (!editor?.state) return false;
  const { state } = editor;
  const replacements = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "mathLive") return;
    replacements.push({ pos, size: node.nodeSize, asciiMath: node.attrs.asciiMath || "", marks: node.marks });
  });
  if (!replacements.length) return false;
  let tr = state.tr;
  for (const replacement of replacements.reverse()) {
    const textNode = replacement.asciiMath
      ? state.schema.text(replacement.asciiMath, replacement.marks)
      : null;
    tr = textNode
      ? tr.replaceWith(replacement.pos, replacement.pos + replacement.size, textNode)
      : tr.delete(replacement.pos, replacement.pos + replacement.size);
  }
  editor.view.dispatch(
    tr.setMeta("addToHistory", false).setMeta("mathNodeConversion", true),
  );
  return true;
}

export function userInsertedEquals(transactions) {
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep)) continue;
      if (step.slice.content.textBetween(0, step.slice.content.size, "").includes("=")) return true;
    }
  }
  return false;
}

export function userInsertedMathDelimiter(transactions) {
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep)) continue;
      const insertedText = step.slice.content.textBetween(
        0,
        step.slice.content.size,
        "",
      );
      if (/[\s()^_=+\-*/<>]/u.test(insertedText)) return true;
    }
  }
  return false;
}
export const MathText = Extension.create({
  name: "mathText",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: mathTextKey,
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged && !tr.getMeta("mathNodeConversion"))) return null;
        if (!userInsertedMathDelimiter(transactions)) return null;
        const editingTransaction = [...transactions].reverse().find(
          (tr) => tr.getMeta("mathNodeEditing") != null,
        );
        return mathNodeTransaction(
          newState,
          editingTransaction?.getMeta("mathNodeEditing"),
          userInsertedEquals(transactions),
          changedRangesInFinalDoc(transactions),
        );
      },
    })];
  },
});

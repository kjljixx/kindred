import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { classifyMath } from "./mathTextDetector.js";
import { createMathWidget } from "./mathRender.js";

const mathTextKey = new PluginKey("kindredMathText");

const MATH_BLOCK_TYPES = new Set([
  "paragraph",
  "tableCell",
  "tableHeader",
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

function selectionOverlapsRange(selection, from, to) {
  if (selection.empty) {
    return selection.from > from && selection.from < to;
  }
  return selection.from < to && selection.to > from;
}

function buildMathDecorations(doc, selection) {
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
              buildMathDecorations(state.doc, state.selection),
            ),
          apply(tr, prev, _oldState, newState) {
            if (!tr.docChanged && !tr.selectionSet) {
              return prev.map(tr.mapping, tr.doc);
            }
            return DecorationSet.create(
              newState.doc,
              buildMathDecorations(newState.doc, newState.selection),
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

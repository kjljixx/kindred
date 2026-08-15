/**
 * Selection unit helpers + TipTap keybinds:
 * - Mod-L expands character → word → sentence → paragraph
 * - Alt-[ / Alt-] moves the caret/selection to the adjacent unit
 * - Alt-Up / Alt-Down swaps the selected unit with its neighbor (moves content)
 */
import { Extension } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/** @typedef {"character" | "word" | "sentence" | "paragraph"} SelectionUnit */
/** @typedef {{ from: number, to: number }} PosRange */

/**
 * Plain text of a textblock plus offset → PM position map.
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} blockStart
 * @param {number} blockEnd
 */
function blockPlain(doc, blockStart, blockEnd) {
  const chars = [];
  const posAt = [];
  doc.nodesBetween(blockStart, blockEnd, (node, pos) => {
    if (!node.isText) return;
    const text = node.text.replace(/\u00a0/g, " ");
    for (let i = 0; i < text.length; i++) {
      posAt.push(pos + i);
      chars.push(text[i]);
    }
  });
  return { text: chars.join(""), posAt, blockEnd };
}

/**
 * @param {{ text: string, posAt: number[], blockEnd: number }} block
 * @param {number} offset
 * @param {"start" | "end"} side
 */
function offsetToPos(block, offset, side) {
  const { posAt, blockEnd } = block;
  if (!posAt.length) return blockEnd;
  if (side === "start") {
    if (offset >= posAt.length) return blockEnd;
    return posAt[Math.max(0, offset)];
  }
  if (offset <= 0) return posAt[0];
  if (offset >= posAt.length) return blockEnd;
  return posAt[offset - 1] + 1;
}

/**
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} pos
 */
function textblockRangeAt(doc, pos) {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).isTextblock) {
      return { from: $pos.start(d), to: $pos.end(d) };
    }
  }
  return null;
}

/** @param {import("@tiptap/pm/model").Node} doc */
function paragraphRanges(doc) {
  /** @type {PosRange[]} */
  const ranges = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    ranges.push({ from: pos + 1, to: pos + 1 + node.content.size });
    return false;
  });
  return ranges;
}

/**
 * Word ranges in plain text (whitespace-separated, matches status counts).
 * @param {string} text
 * @returns {PosRange[]}
 */
function wordRangesInText(text) {
  /** @type {PosRange[]} */
  const ranges = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(text))) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

/**
 * Sentence ranges; split after .!? + whitespace (matches status counts).
 * @param {string} text
 * @returns {PosRange[]}
 */
function sentenceRangesInText(text) {
  /** @type {PosRange[]} */
  const ranges = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    let end = n;
    for (let j = i; j < n; j++) {
      if (/[.!?]/.test(text[j]) && (j + 1 >= n || /\s/.test(text[j + 1]))) {
        end = j + 1;
        break;
      }
    }
    ranges.push({ from: start, to: end });
    i = end;
  }
  return ranges;
}

/**
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {PosRange} block
 * @param {(text: string) => PosRange[]} rangeFn
 */
function unitRangesInBlock(doc, block, rangeFn) {
  const plain = blockPlain(doc, block.from, block.to);
  return rangeFn(plain.text).map((r) => ({
    from: offsetToPos(plain, r.from, "start"),
    to: offsetToPos(plain, r.to, "end"),
  }));
}

/** @param {import("@tiptap/pm/model").Node} doc */
function allWordRanges(doc) {
  return paragraphRanges(doc).flatMap((block) =>
    unitRangesInBlock(doc, block, wordRangesInText)
  );
}

/** @param {import("@tiptap/pm/model").Node} doc */
function allSentenceRanges(doc) {
  return paragraphRanges(doc).flatMap((block) =>
    unitRangesInBlock(doc, block, sentenceRangesInText)
  );
}

/**
 * @param {PosRange[]} ranges
 * @param {number} from
 * @param {number} to
 */
function coversExactUnits(ranges, from, to) {
  if (from >= to || !ranges.length) return false;
  const startIdx = ranges.findIndex((r) => r.from === from);
  const endIdx = ranges.findIndex((r) => r.to === to);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return false;
  for (let i = startIdx; i < endIdx; i++) {
    if (ranges[i].to > ranges[i + 1].from) return false;
  }
  return true;
}

/**
 * Detect the largest unit the current selection represents.
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} from
 * @param {number} to
 * @returns {SelectionUnit}
 */
export function detectSelectionUnit(doc, from, to) {
  if (from === to) return "character";
  if (coversExactUnits(paragraphRanges(doc), from, to)) return "paragraph";
  if (coversExactUnits(allSentenceRanges(doc), from, to)) return "sentence";
  if (coversExactUnits(allWordRanges(doc), from, to)) return "word";
  return "character";
}

/**
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {SelectionUnit} unit
 */
function listUnits(doc, unit) {
  if (unit === "paragraph") return paragraphRanges(doc);
  if (unit === "sentence") return allSentenceRanges(doc);
  if (unit === "word") return allWordRanges(doc);
  return [];
}

/**
 * @param {PosRange[]} ranges
 * @param {number} from
 * @param {number} to
 * @returns {{ startIdx: number, endIdx: number } | null}
 */
function selectionUnitIndices(ranges, from, to) {
  let startIdx = ranges.findIndex((r) => r.from === from);
  let endIdx = ranges.findIndex((r) => r.to === to);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    const hit = ranges.findIndex((r) => from >= r.from && from < r.to);
    if (hit < 0) return null;
    startIdx = hit;
    endIdx = hit;
  }
  return { startIdx, endIdx };
}

/**
 * Smallest range of `unit` that fully contains [from, to].
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} from
 * @param {number} to
 * @param {SelectionUnit} unit
 * @returns {PosRange | null}
 */
function containingUnitRange(doc, from, to, unit) {
  if (unit === "paragraph") {
    const startBlock = textblockRangeAt(doc, from);
    const endBlock = textblockRangeAt(doc, Math.max(from, to - 1));
    if (!startBlock || !endBlock) return null;
    return { from: startBlock.from, to: endBlock.to };
  }

  const ranges = listUnits(doc, unit);
  if (!ranges.length) return null;

  const anchor = from;
  let startIdx = ranges.findIndex((r) => anchor >= r.from && anchor < r.to);
  if (startIdx < 0) {
    startIdx = ranges.findIndex((r) => r.from >= anchor);
  }
  if (startIdx < 0 && ranges.length) {
    startIdx = ranges.length - 1;
  }
  if (startIdx < 0) return null;

  if (from === to) return ranges[startIdx];

  let endIdx = startIdx;
  for (let i = startIdx; i < ranges.length; i++) {
    if (ranges[i].from >= to) break;
    if (ranges[i].to > from) endIdx = i;
  }
  return { from: ranges[startIdx].from, to: ranges[endIdx].to };
}

/**
 * Expand selection to the next higher unit.
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} from
 * @param {number} to
 * @returns {PosRange | null}
 */
export function expandSelectionRange(doc, from, to) {
  const unit = detectSelectionUnit(doc, from, to);
  if (unit === "paragraph") return null;

  const nextUnit =
    unit === "character" ? "word" : unit === "word" ? "sentence" : "paragraph";
  const next = containingUnitRange(doc, from, to, nextUnit);
  if (!next) return null;
  if (next.from === from && next.to === to) {
    if (nextUnit === "paragraph") return null;
    const higher = nextUnit === "word" ? "sentence" : "paragraph";
    return containingUnitRange(doc, from, to, higher);
  }
  return next;
}

/**
 * Move the selection highlight to the adjacent unit (does not edit content).
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} from
 * @param {number} to
 * @param {-1 | 1} direction
 * @returns {PosRange | null}
 */
export function moveSelectionRange(doc, from, to, direction) {
  const unit = detectSelectionUnit(doc, from, to);
  const dir = direction < 0 ? -1 : 1;

  if (unit === "character") {
    const size = doc.content.size;
    if (from === to) {
      const next = Math.max(0, Math.min(size, from + dir));
      if (next === from) return null;
      return { from: next, to: next };
    }
    const len = to - from;
    const nextFrom = from + dir;
    const nextTo = nextFrom + len;
    if (nextFrom < 0 || nextTo > size) return null;
    return { from: nextFrom, to: nextTo };
  }

  const ranges = listUnits(doc, unit);
  if (!ranges.length) return null;
  const indices = selectionUnitIndices(ranges, from, to);
  if (!indices) return null;

  const nextStart = indices.startIdx + dir;
  const nextEnd = indices.endIdx + dir;
  if (nextStart < 0 || nextEnd >= ranges.length) return null;
  return { from: ranges[nextStart].from, to: ranges[nextEnd].to };
}

/**
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {PosRange} a
 * @param {PosRange} b
 */
function sameTextblock(doc, a, b) {
  const ba = textblockRangeAt(doc, a.from);
  const bb = textblockRangeAt(doc, b.from);
  return !!(ba && bb && ba.from === bb.from && ba.to === bb.to);
}

/**
 * Swap selected unit(s) with the neighbor unit in `direction` (edits content).
 * @param {import("@tiptap/pm/model").Node} doc
 * @param {number} from
 * @param {number} to
 * @param {-1 | 1} direction
 * @returns {{ spanFrom: number, spanTo: number, slice: import("@tiptap/pm/model").Slice, selection: PosRange } | null}
 */
export function transposeSelectionRange(doc, from, to, direction) {
  if (from === to) return null;

  const unit = detectSelectionUnit(doc, from, to);
  if (unit === "character") return null;

  const ranges = listUnits(doc, unit);
  const indices = selectionUnitIndices(ranges, from, to);
  if (!indices) return null;

  const dir = direction < 0 ? -1 : 1;
  const neighborIdx = dir < 0 ? indices.startIdx - 1 : indices.endIdx + 1;
  if (neighborIdx < 0 || neighborIdx >= ranges.length) return null;

  const neighbor = ranges[neighborIdx];
  const selStart = ranges[indices.startIdx];
  const selEnd = ranges[indices.endIdx];

  if (unit !== "paragraph" && !sameTextblock(doc, neighbor, selStart)) {
    return null;
  }

  if (unit === "paragraph") {
    const nodeStart = (r) => r.from - 1;
    const nodeEnd = (r) => r.to + 1;
    const neighborFrom = nodeStart(neighbor);
    const neighborTo = nodeEnd(neighbor);
    const selFrom = nodeStart(selStart);
    const selTo = nodeEnd(selEnd);

    if (dir < 0) {
      const spanFrom = neighborFrom;
      const spanTo = selTo;
      const moved = doc.slice(selFrom, selTo).content;
      const other = doc.slice(neighborFrom, neighborTo).content;
      const combined = moved.append(other);
      const selSize = selTo - selFrom;
      return {
        spanFrom,
        spanTo,
        slice: new Slice(combined, 0, 0),
        selection: { from: spanFrom + 1, to: spanFrom + selSize - 1 },
      };
    }

    const spanFrom = selFrom;
    const spanTo = neighborTo;
    const moved = doc.slice(selFrom, selTo).content;
    const other = doc.slice(neighborFrom, neighborTo).content;
    const combined = other.append(moved);
    const otherSize = neighborTo - neighborFrom;
    return {
      spanFrom,
      spanTo,
      slice: new Slice(combined, 0, 0),
      selection: {
        from: spanFrom + otherSize + 1,
        to: spanFrom + otherSize + (selTo - selFrom) - 1,
      },
    };
  }

  // Word / sentence: swap within a textblock, keep the gap between units.
  if (dir < 0) {
    const gapFrom = neighbor.to;
    const gapTo = selStart.from;
    const spanFrom = neighbor.from;
    const spanTo = selEnd.to;
    const other = doc.slice(neighbor.from, neighbor.to).content;
    const gap = doc.slice(gapFrom, gapTo).content;
    const moved = doc.slice(selStart.from, selEnd.to).content;
    const combined = moved.append(gap).append(other);
    const selSize = selEnd.to - selStart.from;
    return {
      spanFrom,
      spanTo,
      slice: new Slice(combined, 0, 0),
      selection: { from: spanFrom, to: spanFrom + selSize },
    };
  }

  const gapFrom = selEnd.to;
  const gapTo = neighbor.from;
  const spanFrom = selStart.from;
  const spanTo = neighbor.to;
  const moved = doc.slice(selStart.from, selEnd.to).content;
  const gap = doc.slice(gapFrom, gapTo).content;
  const other = doc.slice(neighbor.from, neighbor.to).content;
  const combined = other.append(gap).append(moved);
  const prefix = neighbor.to - neighbor.from + (gapTo - gapFrom);
  const selSize = selEnd.to - selStart.from;
  return {
    spanFrom,
    spanTo,
    slice: new Slice(combined, 0, 0),
    selection: { from: spanFrom + prefix, to: spanFrom + prefix + selSize },
  };
}

export const SelectionUnits = Extension.create({
  name: "selectionUnits",

  addCommands() {
    return {
      expandSelectionUnit:
        () =>
          ({ state, commands }) => {
            const { from, to } = state.selection;
            const next = expandSelectionRange(state.doc, from, to);
            if (!next) return false;
            return commands.setTextSelection(next);
          },
      moveSelectionUnit:
        (direction) =>
          ({ state, commands }) => {
            const { from, to } = state.selection;
            const next = moveSelectionRange(state.doc, from, to, direction);
            if (!next) return false;
            return commands.setTextSelection(next);
          },
      transposeSelectionUnit:
        (direction) =>
          ({ state, dispatch }) => {
            const { from, to } = state.selection;
            const plan = transposeSelectionRange(state.doc, from, to, direction);
            if (!plan) return false;
            if (dispatch) {
              const tr = state.tr.replace(plan.spanFrom, plan.spanTo, plan.slice);
              tr.setSelection(
                TextSelection.create(tr.doc, plan.selection.from, plan.selection.to)
              );
              dispatch(tr);
            }
            return true;
          },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-l": () => this.editor.commands.expandSelectionUnit(),
      "Alt-[": () => this.editor.commands.moveSelectionUnit(-1),
      "Alt-]": () => this.editor.commands.moveSelectionUnit(1),
      "Alt-ArrowUp": () => this.editor.commands.transposeSelectionUnit(-1),
      "Alt-ArrowDown": () => this.editor.commands.transposeSelectionUnit(1),
    };
  },
});

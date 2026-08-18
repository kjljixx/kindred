/**
 * Base-anchored 3-way tree aligner on TipTap/PM JSON (DocIR).
 * Emits typed ops with paths — Diff / Review / Merge all project the same list.
 */
import {
  blockFamily,
  blockSignature,
  blockToHtml,
  significantBlocks,
} from "./kindredSchema.js";
import { debugEvent, debugVerbose, summarizeAlignOp, summarizeBlock } from "./debug.js";

/**
 * LCS backtrack → ops: equal | a (only in a) | b (only in b).
 * Deterministic on ties (prefer deleting from a / consuming b when equal score).
 */
function alignSequences(aKeys, bKeys) {
  const n = aKeys.length;
  const m = bKeys.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        aKeys[i - 1] === bKeys[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aKeys[i - 1] === bKeys[j - 1]) {
      ops.push({ type: "equal", aIndex: i - 1, bIndex: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "b", bIndex: j - 1 });
      j--;
    } else {
      ops.push({ type: "a", aIndex: i - 1 });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Map a side onto base via LCS of signatures.
 * @returns {{ baseToSide: (number|null)[], inserts: { afterBase: number, sideIndex: number }[] }}
 */
function mapSideToBase(baseKeys, sideKeys) {
  const ops = alignSequences(baseKeys, sideKeys);
  const baseToSide = new Array(baseKeys.length).fill(null);
  const inserts = [];
  let lastBase = -1;
  for (const op of ops) {
    if (op.type === "equal") {
      baseToSide[op.aIndex] = op.bIndex;
      lastBase = op.aIndex;
    } else if (op.type === "a") {
      lastBase = op.aIndex;
    } else if (op.type === "b") {
      inserts.push({ afterBase: lastBase, sideIndex: op.bIndex });
    }
  }
  return { baseToSide, inserts };
}

function sameNode(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function nodesEqualHtml(a, b) {
  return blockToHtml(a) === blockToHtml(b);
}

/**
 * Align three docs → path-addressed ops.
 *
 * Op shapes:
 * - { type:'equal', path, level:'block', node }
 * - { type:'replace', path, level:'block', base, ours, theirs }
 * - { type:'insert', path, level:'block', side:'ours'|'theirs'|'both', node, ours?, theirs? }
 * - { type:'delete', path, level:'block', side:'ours'|'theirs'|'both', base, ours?, theirs? }
 */
export function alignDocs(baseDoc, oursDoc, theirsDoc, options = {}) {
  const review = !!options.review;
  const baseBlocks = significantBlocks(baseDoc);
  const oursBlocks = significantBlocks(oursDoc);
  const theirsBlocks = significantBlocks(theirsDoc);

  const summarize = (node) => summarizeBlock(node, {
    family: blockFamily(node),
    signature: blockSignature(node),
  });
  debugEvent("align", "start", {
    review,
    baseBlocks: baseBlocks.map(summarize),
    oursBlocks: oursBlocks.map(summarize),
    theirsBlocks: theirsBlocks.map(summarize),
  });
  debugVerbose("align", "documents", { baseDoc, oursDoc, theirsDoc });

  // Same length + same families by index → index align (edits stay replace, not
  // delete+insert). Length/family changes use base-anchored signature LCS.
  const canIndexAlign =
    baseBlocks.length === oursBlocks.length &&
    oursBlocks.length === theirsBlocks.length &&
    baseBlocks.every(
      (b, i) =>
        blockFamily(b) === blockFamily(oursBlocks[i]) &&
        blockFamily(b) === blockFamily(theirsBlocks[i])
    );

  debugEvent("align", "strategy", { type: canIndexAlign ? "index" : "lcs" });

  if (canIndexAlign) {
    const ops = [];
    for (let i = 0; i < baseBlocks.length; i++) {
      const base = baseBlocks[i];
      const ours = oursBlocks[i];
      const theirs = theirsBlocks[i];
      const path = `block/${i}`;
      if (
        sameNode(ours, theirs) ||
        (nodesEqualHtml(ours, theirs) &&
          blockFamily(ours) === blockFamily(theirs))
      ) {
        ops.push({
          type: "equal",
          path,
          level: "block",
          node: ours,
          base,
          ours,
          theirs,
          review,
        });
      } else {
        ops.push({
          type: "replace",
          path,
          level: "block",
          base,
          ours,
          theirs,
          review,
        });
      }
    }
    debugEvent("align", "result", {
      review,
      opCount: ops.length,
      ops: ops.map(summarizeAlignOp),
    });
    return ops;
  }

  const baseKeys = baseBlocks.map(blockSignature);
  const oursKeys = oursBlocks.map(blockSignature);
  const theirsKeys = theirsBlocks.map(blockSignature);

  const oursMap = mapSideToBase(baseKeys, oursKeys);
  const theirsMap = mapSideToBase(baseKeys, theirsKeys);

  debugEvent("align", "lcs-map", {
    baseKeys,
    oursKeys,
    theirsKeys,
    oursMap,
    theirsMap,
  });

  const ops = [];
  let pathCounter = 0;

  function nextPath(kind) {
    const p = `${kind}/${pathCounter}`;
    pathCounter += 1;
    return p;
  }

  function pushGapInserts(afterBase) {
    const oIns = oursMap.inserts.filter((x) => x.afterBase === afterBase);
    const tIns = theirsMap.inserts.filter((x) => x.afterBase === afterBase);
    const oKeys = oIns.map((x) => oursKeys[x.sideIndex]);
    const tKeys = tIns.map((x) => theirsKeys[x.sideIndex]);
    const gapOps = alignSequences(oKeys, tKeys);
    for (const g of gapOps) {
      if (g.type === "equal") {
        const ours = oursBlocks[oIns[g.aIndex].sideIndex];
        const theirs = theirsBlocks[tIns[g.bIndex].sideIndex];
        if (sameNode(ours, theirs) || nodesEqualHtml(ours, theirs)) {
          ops.push({
            type: "insert",
            path: nextPath("block"),
            level: "block",
            side: "both",
            node: ours,
            ours,
            theirs,
            review,
          });
        } else {
          ops.push({
            type: "replace",
            path: nextPath("block"),
            level: "block",
            base: null,
            ours,
            theirs,
            review,
          });
        }
      } else if (g.type === "a") {
        const ours = oursBlocks[oIns[g.aIndex].sideIndex];
        ops.push({
          type: "insert",
          path: nextPath("block"),
          level: "block",
          side: "ours",
          node: ours,
          ours,
          review,
        });
      } else {
        const theirs = theirsBlocks[tIns[g.bIndex].sideIndex];
        ops.push({
          type: "insert",
          path: nextPath("block"),
          level: "block",
          side: "theirs",
          node: theirs,
          theirs,
          review,
        });
      }
    }
  }

  pushGapInserts(-1);

  for (let bi = 0; bi < baseBlocks.length; bi++) {
    const base = baseBlocks[bi];
    const oi = oursMap.baseToSide[bi];
    const ti = theirsMap.baseToSide[bi];
    const ours = oi == null ? null : oursBlocks[oi];
    const theirs = ti == null ? null : theirsBlocks[ti];

    if (ours && theirs) {
      if (
        sameNode(ours, theirs) ||
        (nodesEqualHtml(ours, theirs) &&
          blockFamily(ours) === blockFamily(theirs))
      ) {
        ops.push({
          type: "equal",
          path: nextPath("block"),
          level: "block",
          node: ours,
          base,
          ours,
          theirs,
          review,
        });
      } else {
        ops.push({
          type: "replace",
          path: nextPath("block"),
          level: "block",
          base,
          ours,
          theirs,
          review,
        });
      }
    } else if (ours && !theirs) {
      ops.push({
        type: "delete",
        path: nextPath("block"),
        level: "block",
        side: "theirs",
        base,
        ours,
        review,
      });
    } else if (!ours && theirs) {
      ops.push({
        type: "delete",
        path: nextPath("block"),
        level: "block",
        side: "ours",
        base,
        theirs,
        review,
      });
    }

    pushGapInserts(bi);
  }

  debugEvent("align", "result", {
    review,
    opCount: ops.length,
    ops: ops.map(summarizeAlignOp),
  });
  return ops;
}

/** Two-way align (HEAD vs dirty) for Diff projection. */
export function alignTwoWay(headDoc, dirtyDoc) {
  return alignDocs(headDoc, headDoc, dirtyDoc, { review: true });
}

/**
 * Base-anchored 3-way tree aligner on TipTap/PM JSON (DocIR).
 * Emits typed ops with paths — Diff / Review / Merge all project the same list.
 */
import {
  blockFamily,
  blockSignature,
  blockToHtml,
  docToPlainText,
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

const PARAGRAPH_MATCH_THRESHOLD = 0.4;

function normalizedWords(node) {
  return docToPlainText(node)
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordPairs(words) {
  const pairs = [];
  for (let index = 1; index < words.length; index++) {
    pairs.push(`${words[index - 1]}\0${words[index]}`);
  }
  return pairs;
}

function diceSimilarity(before, after) {
  if (!before.length || !after.length) return 0;
  const remaining = new Map();
  for (const value of before) {
    remaining.set(value, (remaining.get(value) || 0) + 1);
  }
  let shared = 0;
  for (const value of after) {
    const count = remaining.get(value) || 0;
    if (!count) continue;
    shared += 1;
    remaining.set(value, count - 1);
  }
  return (2 * shared) / (before.length + after.length);
}

function paragraphSimilarity(before, after) {
  const beforeWords = normalizedWords(before);
  const afterWords = normalizedWords(after);
  if (!beforeWords.length || !afterWords.length) return 0;
  if (beforeWords.join("\0") === afterWords.join("\0")) return 1;
  const beforePairs = wordPairs(beforeWords);
  const afterPairs = wordPairs(afterWords);
  return beforePairs.length && afterPairs.length
    ? diceSimilarity(beforePairs, afterPairs)
    : diceSimilarity(beforeWords, afterWords);
}

function alignEditedParagraphs(baseBlocks, sideBlocks, baseIndexes, inserts) {
  const sideInserts = inserts.filter(
    (insert) => blockFamily(sideBlocks[insert.sideIndex]) === "p"
  );
  const rows = Array.from({ length: baseIndexes.length + 1 }, () =>
    new Array(sideInserts.length + 1).fill(0)
  );

  function matchWeight(baseOffset, sideOffset) {
    const similarity = paragraphSimilarity(
      baseBlocks[baseIndexes[baseOffset]],
      sideBlocks[sideInserts[sideOffset].sideIndex]
    );
    return similarity >= PARAGRAPH_MATCH_THRESHOLD
      ? similarity - PARAGRAPH_MATCH_THRESHOLD
      : Number.NEGATIVE_INFINITY;
  }

  for (let i = 1; i <= baseIndexes.length; i++) {
    for (let j = 1; j <= sideInserts.length; j++) {
      rows[i][j] = Math.max(
        rows[i - 1][j],
        rows[i][j - 1],
        rows[i - 1][j - 1] + matchWeight(i - 1, j - 1)
      );
    }
  }

  const matches = [];
  let i = baseIndexes.length;
  let j = sideInserts.length;
  while (i > 0 && j > 0) {
    const weight = matchWeight(i - 1, j - 1);
    if (
      Number.isFinite(weight) &&
      weight > 0 &&
      Math.abs(rows[i][j] - (rows[i - 1][j - 1] + weight)) < 1e-9
    ) {
      matches.push({
        baseIndex: baseIndexes[i - 1],
        insert: sideInserts[j - 1],
      });
      i -= 1;
      j -= 1;
    } else if (rows[i][j] === rows[i - 1][j]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return matches.reverse();
}

function hasTextContent(node) {
  if (typeof node?.text === "string" && node.text.length > 0) return true;
  return (node?.content || []).some(hasTextContent);
}

function reconcileEditedStructuralBlocks(baseBlocks, sideBlocks, mapping) {
  const mappedBaseIndexes = mapping.baseToSide
    .map((sideIndex, baseIndex) => sideIndex == null ? null : baseIndex)
    .filter((baseIndex) => baseIndex != null);
  const boundaries = [-1, ...mappedBaseIndexes, baseBlocks.length];

  for (let boundaryIndex = 1; boundaryIndex < boundaries.length; boundaryIndex++) {
    const previous = boundaries[boundaryIndex - 1];
    const next = boundaries[boundaryIndex];
    const baseIndexes = [];
    for (let baseIndex = previous + 1; baseIndex < next; baseIndex++) {
      if (blockFamily(baseBlocks[baseIndex]) === "p") baseIndexes.push(baseIndex);
    }
    const inserts = mapping.inserts.filter(
      (insert) => insert.afterBase >= previous && insert.afterBase < next
    );
    for (const match of alignEditedParagraphs(
      baseBlocks,
      sideBlocks,
      baseIndexes,
      inserts
    )) {
      mapping.baseToSide[match.baseIndex] = match.insert.sideIndex;
      const insertIndex = mapping.inserts.indexOf(match.insert);
      if (insertIndex >= 0) mapping.inserts.splice(insertIndex, 1);
    }
  }

  for (let baseIndex = 0; baseIndex < baseBlocks.length; baseIndex++) {
    if (mapping.baseToSide[baseIndex] != null) continue;
    const family = blockFamily(baseBlocks[baseIndex]);
    if (family === "p") continue;
    const isCandidate = (insert) => {
      const nearby =
        insert.afterBase === baseIndex || insert.afterBase === baseIndex - 1;
      return nearby && blockFamily(sideBlocks[insert.sideIndex]) === family;
    };
    const baseHasText = hasTextContent(baseBlocks[baseIndex]);
    let insertIndex = mapping.inserts.findIndex(
      (insert) =>
        isCandidate(insert) &&
        hasTextContent(sideBlocks[insert.sideIndex]) === baseHasText
    );
    if (insertIndex < 0) {
      insertIndex = mapping.inserts.findIndex(isCandidate);
    }
    if (insertIndex < 0) continue;
    mapping.baseToSide[baseIndex] = mapping.inserts[insertIndex].sideIndex;
    mapping.inserts.splice(insertIndex, 1);
  }
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

  debugEvent("align", "strategy", { type: "lcs-similarity" });

  const baseKeys = baseBlocks.map(blockSignature);
  const oursKeys = oursBlocks.map(blockSignature);
  const theirsKeys = theirsBlocks.map(blockSignature);

  const oursMap = mapSideToBase(baseKeys, oursKeys);
  const theirsMap = mapSideToBase(baseKeys, theirsKeys);
  reconcileEditedStructuralBlocks(baseBlocks, oursBlocks, oursMap);
  reconcileEditedStructuralBlocks(baseBlocks, theirsBlocks, theirsMap);

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

/**
 * Project aligner ops → merge/review HTML (conflict markers) or clean result.
 * Leaf paragraph content still uses the existing mark-aware flat merge.
 */
import { alignDocs } from "./docAlign.js";
import { blockToHtml, htmlToDoc, mergeAdjacentTopLevelLists, normalizeDoc } from "./kindredSchema.js";
import { debugEvent, debugVerbose, startTrace, summarizeAlignOp } from "./debug.js";
import {
  createTableReviewConflict,
  mergeTableWithDaff,
} from "./tableDaff.js";
import {
  createListReviewConflict,
  mergeListWithAlign,
} from "./listAlign.js";

function formatConflict(labelOurs, oursStr, labelTheirs, theirsStr) {
  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  return (
    `<span data-kindred-text-conflict` +
    ` data-kindred-label-ours="${esc(labelOurs)}"` +
    ` data-kindred-label-theirs="${esc(labelTheirs)}"` +
    ` data-kindred-ours="${esc(oursStr)}"` +
    ` data-kindred-theirs="${esc(theirsStr)}"` +
    `></span>`
  );
}

function wrapPara(innerHtml) {
  return `<p>${innerHtml || ""}</p>`;
}

function formatTableConflict(oursNode, theirsNode, labelOurs, labelTheirs) {
  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const oursHtml = oursNode ? blockToHtml(oursNode) : "";
  const theirsHtml = theirsNode ? blockToHtml(theirsNode) : "";
  const displayNode = oursNode || theirsNode;
  if (!displayNode) return "";

  let html = blockToHtml(displayNode);
  const attrs =
    ` data-kindred-table-ours="${esc(oursHtml)}"` +
    ` data-kindred-table-theirs="${esc(theirsHtml)}"` +
    ` data-kindred-table-label-ours="${esc(labelOurs)}"` +
    ` data-kindred-table-label-theirs="${esc(labelTheirs)}"`;

  return html.replace(/<table\b/i, `<table${attrs}`);
}

function formatListConflict(oursNode, theirsNode, labelOurs, labelTheirs) {
  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const oursHtml = oursNode ? blockToHtml(oursNode) : "";
  const theirsHtml = theirsNode ? blockToHtml(theirsNode) : "";
  const displayNode = oursNode || theirsNode;
  if (!displayNode) return "";

  let html = blockToHtml(displayNode);
  const tag = displayNode.type === "orderedList" ? "ol" : "ul";
  const attrs =
    ` data-kindred-list-ours="${esc(oursHtml)}"` +
    ` data-kindred-list-theirs="${esc(theirsHtml)}"` +
    ` data-kindred-list-label-ours="${esc(labelOurs)}"` +
    ` data-kindred-list-label-theirs="${esc(labelTheirs)}"`;

  return html.replace(new RegExp(`<${tag}\\b`, "i"), `<${tag}${attrs}`);
}

function isTableBlock(node) {
  return node?.type === "table";
}

function isListBlock(node) {
  return node?.type === "bulletList" || node?.type === "orderedList";
}

function isStructuralBlock(node) {
  return isTableBlock(node) || isListBlock(node);
}

function isAtomicBlock(node) {
  return node?.type === "image";
}

/**
 * @param {object} baseDoc
 * @param {object} oursDoc
 * @param {object} theirsDoc
 * @param {string} labelOurs
 * @param {string} labelTheirs
 * @param {{ review?: boolean }} options
 * @param {(baseHtml: string, oursHtml: string, theirsHtml: string, labelOurs: string, labelTheirs: string, options: object) => { cleanMerge: boolean, mergedText: string }} leafMerge
 *   Flat mark-aware merge for a single paragraph (or small HTML fragment).
 */
function mergeDocs(
  baseDoc,
  oursDoc,
  theirsDoc,
  labelOurs,
  labelTheirs,
  options,
  leafMerge
) {
  const review = !!options?.review;
  const ops = alignDocs(baseDoc, oursDoc, theirsDoc, { review });
  let cleanMerge = true;
  const parts = [];

  debugEvent("merge", "start", {
    review,
    labelOurs,
    labelTheirs,
    opCount: ops.length,
    ops: ops.map(summarizeAlignOp),
  });

  function logDecision(op, decision) {
    debugEvent("merge", "op", {
      ...summarizeAlignOp(op),
      decision,
    });
  }

  function leaf(baseHtml, oursHtml, theirsHtml) {
    debugEvent("merge", "leaf:start", { review, baseHtml, oursHtml, theirsHtml });
    const result = leafMerge(
      baseHtml || "<p></p>",
      oursHtml || "<p></p>",
      theirsHtml || "<p></p>",
      labelOurs,
      labelTheirs,
      { review, leaf: true }
    );
    if (!result.cleanMerge) cleanMerge = false;
    debugEvent("merge", "leaf:result", {
      cleanMerge: result.cleanMerge,
      mergedText: result.mergedText,
    });
    return result.mergedText || "<p></p>";
  }

  function conflictBlock(oursNode, theirsNode) {
    cleanMerge = false;
    const oursHtml = blockToHtml(oursNode);
    const theirsHtml = blockToHtml(theirsNode);
    // Whole-block conflict inside a paragraph shell for TipTap display.
    return wrapPara(
      formatConflict(labelOurs, oursHtml, labelTheirs, theirsHtml)
    );
  }

  function handleTableConflict(ours, theirs, base = null) {
    if (review && ours && theirs) {
      const granular = createTableReviewConflict(
        blockToHtml(ours),
        blockToHtml(theirs),
        labelOurs,
        labelTheirs
      );
      if (granular) {
        cleanMerge = false;
        return granular;
      }
    }
    if (!review && base && ours && theirs) {
      const merged = mergeTableWithDaff(
        blockToHtml(base),
        blockToHtml(ours),
        blockToHtml(theirs),
        labelOurs,
        labelTheirs
      );
      if (merged) {
        if (merged.conflictCount) cleanMerge = false;
        return merged.html;
      }
    }
    cleanMerge = false;
    return formatTableConflict(ours, theirs, labelOurs, labelTheirs);
  }

  function handleListConflict(ours, theirs, base = null) {
    if (review && ours && theirs) {
      const granular = createListReviewConflict(
        blockToHtml(ours),
        blockToHtml(theirs),
        labelOurs,
        labelTheirs,
        leafMerge
      );
      if (granular) {
        cleanMerge = false;
        return granular;
      }
    }
    if (!review && base && ours && theirs) {
      const merged = mergeListWithAlign(
        blockToHtml(base),
        blockToHtml(ours),
        blockToHtml(theirs),
        labelOurs,
        labelTheirs,
        leafMerge
      );
      if (merged) {
        if (merged.conflictCount) cleanMerge = false;
        return merged.html;
      }
    }
    cleanMerge = false;
    return formatListConflict(ours, theirs, labelOurs, labelTheirs);
  }

  function handleStructuralConflict(ours, theirs, base) {
    const display = ours || theirs || base;
    if (isTableBlock(display)) return handleTableConflict(ours, theirs, base);
    if (isListBlock(display)) return handleListConflict(ours, theirs, base);
    return conflictBlock(ours, theirs);
  }

  for (const op of ops) {
    if (op.type === "equal") {
      logDecision(op, "equal");
      parts.push(blockToHtml(op.node));
      continue;
    }

    if (op.type === "replace") {
      const baseHtml = op.base ? blockToHtml(op.base) : "<p></p>";
      const oursHtml = blockToHtml(op.ours);
      const theirsHtml = blockToHtml(op.theirs);
      // Same family paragraph → leaf mark/text merge.
      if (isStructuralBlock(op.ours) || isStructuralBlock(op.theirs) || isStructuralBlock(op.base)) {
        logDecision(op, isTableBlock(op.ours || op.theirs || op.base) ? "table-conflict" : "list-conflict");
        parts.push(handleStructuralConflict(op.ours, op.theirs, op.base));
      } else if (isAtomicBlock(op.ours) || isAtomicBlock(op.theirs) || isAtomicBlock(op.base)) {
        logDecision(op, "atomic-conflict");
        parts.push(conflictBlock(op.ours, op.theirs));
      } else if (
        op.ours?.type === "paragraph" &&
        op.theirs?.type === "paragraph" &&
        (!op.base || op.base.type === "paragraph")
      ) {
        logDecision(op, "leaf-merge");
        parts.push(leaf(baseHtml, oursHtml, theirsHtml));
      } else {
        logDecision(op, "block-conflict");
        parts.push(conflictBlock(op.ours, op.theirs));
      }
      continue;
    }

    if (op.type === "insert") {
      if (op.side === "both") {
        if (sameHtml(op.ours, op.theirs)) {
          logDecision(op, "accept-both-insert");
          parts.push(blockToHtml(op.node || op.ours));
        } else if (isStructuralBlock(op.ours) || isStructuralBlock(op.theirs)) {
          logDecision(op, isTableBlock(op.ours || op.theirs) ? "table-conflict" : "list-conflict");
          parts.push(handleStructuralConflict(op.ours, op.theirs));
        } else if (isAtomicBlock(op.ours) || isAtomicBlock(op.theirs)) {
          logDecision(op, "atomic-conflict");
          parts.push(conflictBlock(op.ours, op.theirs));
        } else {
          logDecision(op, "leaf-merge");
          parts.push(leaf("<p></p>", blockToHtml(op.ours), blockToHtml(op.theirs)));
        }
        continue;
      }
      if (op.side === "ours") {
        logDecision(op, review ? "review-insert-ours" : "accept-ours-insert");
        if (review) {
          if (isTableBlock(op.node)) {
            parts.push(handleTableConflict(op.node, null));
          } else if (isListBlock(op.node)) {
            parts.push(handleListConflict(op.node, null));
          } else if (isAtomicBlock(op.node)) {
            parts.push(conflictBlock(op.node, null));
          } else {
            parts.push(leaf("<p></p>", blockToHtml(op.node), "<p></p>"));
          }
        } else {
          parts.push(blockToHtml(op.node));
        }
        continue;
      }
      // theirs insert
      logDecision(op, review ? "review-insert-theirs" : "accept-theirs-insert");
      if (review) {
        if (isTableBlock(op.node)) {
          parts.push(handleTableConflict(null, op.node));
        } else if (isListBlock(op.node)) {
          parts.push(handleListConflict(null, op.node));
        } else if (isAtomicBlock(op.node)) {
          parts.push(conflictBlock(null, op.node));
        } else {
          parts.push(leaf("<p></p>", "<p></p>", blockToHtml(op.node)));
        }
      } else {
        parts.push(blockToHtml(op.node));
      }
      continue;
    }

    if (op.type === "delete") {
      logDecision(op, review ? "review-delete" : "merge-delete");
      // side = who deleted (missing on that side)
      if (op.side === "theirs") {
        // ours still has it, theirs deleted
        if (review) {
          if (isTableBlock(op.ours || op.base)) {
            parts.push(handleTableConflict(op.ours || op.base, null));
          } else if (isListBlock(op.ours || op.base)) {
            parts.push(handleListConflict(op.ours || op.base, null));
          } else if (isAtomicBlock(op.ours || op.base)) {
            parts.push(conflictBlock(op.ours || op.base, null));
          } else {
            parts.push(
              leaf(
                blockToHtml(op.base),
                blockToHtml(op.ours || op.base),
                "<p></p>"
              )
            );
          }
        } else if (nodesMatchBase(op.ours, op.base)) {
          logDecision(op, "drop-deleted-base");
          continue;
        } else {
          if (isTableBlock(op.ours || op.base)) {
            parts.push(handleTableConflict(op.ours || op.base, null));
          } else if (isListBlock(op.ours || op.base)) {
            parts.push(handleListConflict(op.ours || op.base, null));
          } else {
            parts.push(
              leaf(
                blockToHtml(op.base),
                blockToHtml(op.ours || op.base),
                "<p></p>"
              )
            );
          }
        }
        continue;
      }
      // ours deleted, theirs still has it
      if (review) {
        if (isTableBlock(op.theirs || op.base)) {
          parts.push(handleTableConflict(null, op.theirs || op.base));
        } else if (isListBlock(op.theirs || op.base)) {
          parts.push(handleListConflict(null, op.theirs || op.base));
        } else if (isAtomicBlock(op.theirs || op.base)) {
          parts.push(conflictBlock(null, op.theirs || op.base));
        } else {
          parts.push(
            leaf(
              blockToHtml(op.base),
              "<p></p>",
              blockToHtml(op.theirs || op.base)
            )
          );
        }
      } else if (nodesMatchBase(op.theirs, op.base)) {
        logDecision(op, "drop-deleted-base");
        continue;
      } else {
        if (isTableBlock(op.theirs || op.base)) {
          parts.push(handleTableConflict(null, op.theirs || op.base));
        } else if (isListBlock(op.theirs || op.base)) {
          parts.push(handleListConflict(null, op.theirs || op.base));
        } else {
          parts.push(
            leaf(
              blockToHtml(op.base),
              "<p></p>",
              blockToHtml(op.theirs || op.base)
            )
          );
        }
      }
    }
  }

  const mergedText = parts.filter(Boolean).join("\n") || "<p></p>";
  debugEvent("merge", "result", {
    review,
    cleanMerge,
    opCount: ops.length,
    outputHtml: mergedText,
  });
  return {
    cleanMerge,
    mergedText,
    ops,
  };
}

function sameHtml(a, b) {
  return blockToHtml(a) === blockToHtml(b);
}

function nodesMatchBase(node, base) {
  if (!node && !base) return true;
  if (!node || !base) return false;
  return blockToHtml(node) === blockToHtml(base);
}

/**
 * HTML 3-way merge via AST aligner + leaf callback.
 */
export function mergeHtmlViaAst(
  baseHtml,
  oursHtml,
  theirsHtml,
  labelOurs,
  labelTheirs,
  options,
  leafMerge
) {
  const review = !!options?.review;
  startTrace(review ? "review" : "merge", "calculate", {
    labelOurs,
    labelTheirs,
    baseHtml,
    oursHtml,
    theirsHtml,
  });
  debugVerbose("merge", "input-html", { baseHtml, oursHtml, theirsHtml });
  if (oursHtml === theirsHtml) {
    debugEvent("merge", "fast-path", { reason: "ours-equals-theirs" });
    return { cleanMerge: true, mergedText: oursHtml, ops: [] };
  }
  if (!review && oursHtml === baseHtml) {
    debugEvent("merge", "fast-path", { reason: "ours-equals-base" });
    return { cleanMerge: true, mergedText: theirsHtml, ops: [] };
  }
  if (theirsHtml === baseHtml) {
    debugEvent("merge", "fast-path", { reason: "theirs-equals-base" });
    return { cleanMerge: true, mergedText: oursHtml, ops: [] };
  }

  const baseDoc = mergeAdjacentTopLevelLists(normalizeDoc(htmlToDoc(baseHtml)));
  const oursDoc = mergeAdjacentTopLevelLists(normalizeDoc(htmlToDoc(oursHtml)));
  const theirsDoc = mergeAdjacentTopLevelLists(normalizeDoc(htmlToDoc(theirsHtml)));

  return mergeDocs(
    baseDoc,
    oursDoc,
    theirsDoc,
    labelOurs,
    labelTheirs,
    options,
    leafMerge
  );
}

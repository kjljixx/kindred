/**
 * Project aligner ops → merge/review HTML (conflict markers) or clean result.
 * Leaf paragraph content still uses the existing mark-aware flat merge.
 */
import { alignDocs } from "./docAlign.js";
import { blockToHtml, htmlToDoc } from "./kindredSchema.js";

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

  function leaf(baseHtml, oursHtml, theirsHtml) {
    const result = leafMerge(
      baseHtml || "<p></p>",
      oursHtml || "<p></p>",
      theirsHtml || "<p></p>",
      labelOurs,
      labelTheirs,
      { review, leaf: true }
    );
    if (!result.cleanMerge) cleanMerge = false;
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

  function isAtomicBlock(node) {
    return node?.type === "image";
  }

  for (const op of ops) {
    if (op.type === "equal") {
      parts.push(blockToHtml(op.node));
      continue;
    }

    if (op.type === "replace") {
      const baseHtml = op.base ? blockToHtml(op.base) : "<p></p>";
      const oursHtml = blockToHtml(op.ours);
      const theirsHtml = blockToHtml(op.theirs);
      // Same family paragraph → leaf mark/text merge.
      if (isAtomicBlock(op.ours) || isAtomicBlock(op.theirs) || isAtomicBlock(op.base)) {
        parts.push(conflictBlock(op.ours, op.theirs));
      } else if (
        op.ours?.type === "paragraph" &&
        op.theirs?.type === "paragraph" &&
        (!op.base || op.base.type === "paragraph")
      ) {
        parts.push(leaf(baseHtml, oursHtml, theirsHtml));
      } else {
        parts.push(conflictBlock(op.ours, op.theirs));
      }
      continue;
    }

    if (op.type === "insert") {
      if (op.side === "both") {
        if (sameHtml(op.ours, op.theirs)) {
          parts.push(blockToHtml(op.node || op.ours));
        } else if (isAtomicBlock(op.ours) || isAtomicBlock(op.theirs)) {
          parts.push(conflictBlock(op.ours, op.theirs));
        } else {
          parts.push(leaf("<p></p>", blockToHtml(op.ours), blockToHtml(op.theirs)));
        }
        continue;
      }
      if (op.side === "ours") {
        if (review) {
          parts.push(isAtomicBlock(op.node)
            ? conflictBlock(op.node, null)
            : leaf("<p></p>", blockToHtml(op.node), "<p></p>"));
        } else {
          parts.push(blockToHtml(op.node));
        }
        continue;
      }
      // theirs insert
      if (review) {
        parts.push(isAtomicBlock(op.node)
          ? conflictBlock(null, op.node)
          : leaf("<p></p>", "<p></p>", blockToHtml(op.node)));
      } else {
        parts.push(blockToHtml(op.node));
      }
      continue;
    }

    if (op.type === "delete") {
      // side = who deleted (missing on that side)
      if (op.side === "theirs") {
        // ours still has it, theirs deleted
        if (review) {
          parts.push(isAtomicBlock(op.ours || op.base)
            ? conflictBlock(op.ours || op.base, null)
            :
            leaf(
              blockToHtml(op.base),
              blockToHtml(op.ours || op.base),
              "<p></p>"
            ));
        } else if (nodesMatchBase(op.ours, op.base)) {
          continue;
        } else {
          parts.push(
            leaf(
              blockToHtml(op.base),
              blockToHtml(op.ours || op.base),
              "<p></p>"
            )
          );
        }
        continue;
      }
      // ours deleted, theirs still has it
      if (review) {
        parts.push(isAtomicBlock(op.theirs || op.base)
          ? conflictBlock(null, op.theirs || op.base)
          :
          leaf(
            blockToHtml(op.base),
            "<p></p>",
            blockToHtml(op.theirs || op.base)
          ));
      } else if (nodesMatchBase(op.theirs, op.base)) {
        continue;
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

  const mergedText = parts.filter(Boolean).join("\n") || "<p></p>";
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
  if (oursHtml === theirsHtml) {
    return { cleanMerge: true, mergedText: oursHtml, ops: [] };
  }
  if (!review && oursHtml === baseHtml) {
    return { cleanMerge: true, mergedText: theirsHtml, ops: [] };
  }
  if (theirsHtml === baseHtml) {
    return { cleanMerge: true, mergedText: oursHtml, ops: [] };
  }

  const baseDoc = htmlToDoc(baseHtml);
  const oursDoc = htmlToDoc(oursHtml);
  const theirsDoc = htmlToDoc(theirsHtml);

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

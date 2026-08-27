import {
  htmlToDoc,
  isListBlock as defaultIsListBlock,
  blockToHtml as defaultBlockToHtml,
  docToPlainText,
} from "./kindredSchema.js";

function children(node) {
  return Array.isArray(node?.content) ? node.content : [];
}

function ownListItemText(node) {
  return children(node)
    .filter((child) => child.type !== "bulletList" && child.type !== "orderedList")
    .map(docToPlainText)
    .join("");
}

export function flattenItems(listNode, depth = 0, path = [], out = []) {
  for (const [index, item] of children(listNode).entries()) {
    if (item.type !== "listItem") continue;
    const itemPath = [...path, index];
    out.push({
      index: out.length,
      depth,
      path: itemPath,
      text: ownListItemText(item),
      html: defaultBlockToHtml({
        ...item,
        content: children(item).filter(
          (child) => child.type !== "bulletList" && child.type !== "orderedList"
        ),
      }),
    });
    for (const child of children(item)) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        flattenItems(child, depth + 1, itemPath, out);
      }
    }
  }
  return out;
}

export function alignListItems(before, after) {
  function matchScore(oldItem, newItem, oldIndex, newIndex) {
    if (oldItem.text === newItem.text) return 4;
    const oldWords = oldItem.text.split(/\s+/).filter(Boolean);
    const newWords = newItem.text.split(/\s+/).filter(Boolean);
    const overlap = newWords.some((word) => oldWords.includes(word));
    if (overlap) return 1;
    return Math.abs(oldIndex - newIndex) <= 1 ? 1 : -2;
  }
  const rows = Array.from({ length: before.length + 1 }, () =>
    new Array(after.length + 1).fill(0)
  );
  for (let i = 1; i <= before.length; i++) {
    for (let j = 1; j <= after.length; j++) {
      const match = matchScore(before[i - 1], after[j - 1], i - 1, j - 1);
      rows[i][j] = Math.max(
        rows[i - 1][j],
        rows[i][j - 1],
        rows[i - 1][j - 1] + match
      );
    }
  }
  const pairs = [];
  let i = before.length;
  let j = after.length;
  while (i || j) {
    if (j && rows[i][j] === rows[i][j - 1]) {
      pairs.push({ before: null, after: after[j - 1] });
      j--;
    } else if (i && rows[i][j] === rows[i - 1][j]) {
      pairs.push({ before: before[i - 1], after: null });
      i--;
    } else if (
      i && j &&
      rows[i][j] === rows[i - 1][j - 1] +
        matchScore(before[i - 1], after[j - 1], i - 1, j - 1)
    ) {
      pairs.push({ before: before[i - 1], after: after[j - 1] });
      i--;
      j--;
    } else if (j) {
      pairs.push({ before: null, after: after[j - 1] });
      j--;
    } else {
      pairs.push({ before: before[i - 1], after: null });
      i--;
    }
  }
  return pairs.reverse();
}

export function diffList(oldNode, newNode) {
  const before = flattenItems(oldNode);
  const after = flattenItems(newNode);
  const items = alignListItems(before, after).map((pair) => {
    if (!pair.before) return { action: "insert", newIndex: pair.after.index, ...pair.after };
    if (!pair.after) return { action: "delete", oldIndex: pair.before.index, ...pair.before };
    const moved = pair.before.depth !== pair.after.depth;
    const edited = pair.before.text !== pair.after.text;
    return {
      action: moved ? (edited ? "move-edit" : "move") : edited ? "edit" : "equal",
      oldDepth: pair.before.depth,
      newDepth: pair.after.depth,
      oldText: pair.before.text,
      newText: pair.after.text,
      oldHtml: pair.before.html,
      newHtml: pair.after.html,
      oldPath: pair.before.path,
      newPath: pair.after.path,
      oldIndex: pair.before.index,
      newIndex: pair.after.index,
    };
  });
  const movedParents = [];
  for (const item of items) {
    if (item.action !== "move" && item.action !== "move-edit") continue;
    const descendant = movedParents.some(
      (parent) =>
        item.oldPath?.length > parent.oldPath.length &&
        item.newPath?.length > parent.newPath.length &&
        parent.oldPath.every((value, index) => item.oldPath[index] === value) &&
        parent.newPath.every((value, index) => item.newPath[index] === value)
    );
    if (descendant) item.action = "equal";
    else movedParents.push(item);
  }
  return { oldHtml: defaultBlockToHtml(oldNode), newHtml: defaultBlockToHtml(newNode), items };
}

export function listDiffsFromAlignOps(
  ops,
  { isListBlock = defaultIsListBlock, blockToHtml = defaultBlockToHtml } = {}
) {
  const added = [];
  const deleted = [];
  const replacements = [];

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];
    const next = ops[opIndex + 1];
    if (
      op.type === "delete" &&
      op.side === "theirs" &&
      isListBlock(op.base || op.ours) &&
      next?.type === "insert" &&
      next.side === "theirs" &&
      isListBlock(next.theirs || next.node)
    ) {
      replacements.push(
        diffList(op.base || op.ours, next.theirs || next.node)
      );
      opIndex++;
      continue;
    }
    if (op.type === "insert" && op.side === "theirs" && isListBlock(op.theirs || op.node)) {
      const node = op.theirs || op.node;
      const items = flattenItems(node).map((item) => ({
        action: "insert",
        newIndex: item.index,
        ...item,
      }));
      replacements.push({ oldHtml: "", newHtml: blockToHtml(node), items });
    } else if (op.type === "delete" && op.side === "theirs" && isListBlock(op.base || op.ours)) {
      const node = op.base || op.ours;
      const items = flattenItems(node).map((item) => ({
        action: "delete",
        oldIndex: item.index,
        ...item,
      }));
      replacements.push({ oldHtml: blockToHtml(node), newHtml: "", items });
    } else if (op.type === "replace" && (isListBlock(op.base) || isListBlock(op.theirs))) {
      const oldHtml = isListBlock(op.base) ? blockToHtml(op.base) : "";
      const newHtml = isListBlock(op.theirs) ? blockToHtml(op.theirs) : "";
      if (oldHtml && newHtml) {
        replacements.push(diffList(op.base, op.theirs));
      } else if (oldHtml) {
        replacements.push({
          oldHtml,
          newHtml: "",
          items: flattenItems(op.base).map((item) => ({
            action: "delete",
            oldIndex: item.index,
            ...item,
          })),
        });
      } else if (newHtml) {
        replacements.push({
          newHtml,
          oldHtml: "",
          items: flattenItems(op.theirs).map((item) => ({
            action: "insert",
            newIndex: item.index,
            ...item,
          })),
        });
      }
    }
  }

  return added.length || deleted.length || replacements.length
    ? { added, deleted, replacements }
    : null;
}

function listNodeFromDoc(html) {
  const doc = htmlToDoc(html);
  return doc.content.find(
    (node) => node.type === "bulletList" || node.type === "orderedList"
  );
}

function listTagName(listNode) {
  return listNode?.type === "orderedList" ? "ol" : "ul";
}

function listElementFromHtml(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  return parsed.querySelector("ul, ol");
}

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textConflictMarkup(labelOurs, oursHtml, labelTheirs, theirsHtml) {
  return (
    `<span data-kindred-text-conflict` +
    ` data-kindred-label-ours="${escapeAttr(labelOurs)}"` +
    ` data-kindred-label-theirs="${escapeAttr(labelTheirs)}"` +
    ` data-kindred-ours="${escapeAttr(oursHtml)}"` +
    ` data-kindred-theirs="${escapeAttr(theirsHtml)}"` +
    `></span>`
  );
}

function innerHtmlWithTextConflict(labelOurs, labelTheirs, oursHtml, theirsHtml) {
  const ours = String(oursHtml || "").trim() || "<p></p>";
  const theirs = String(theirsHtml || "").trim() || "<p></p>";
  return `<p>${textConflictMarkup(labelOurs, ours, labelTheirs, theirs)}</p>`;
}

function innerHtmlFromLeafMerge(
  leafMerge,
  { review = false },
  labelOurs,
  labelTheirs,
  baseHtml,
  oursHtml,
  theirsHtml
) {
  if (!leafMerge) {
    return innerHtmlWithTextConflict(labelOurs, labelTheirs, oursHtml, theirsHtml);
  }
  const result = leafMerge(
    baseHtml || "<p></p>",
    oursHtml || "<p></p>",
    theirsHtml || "<p></p>",
    labelOurs,
    labelTheirs,
    { review, leaf: true }
  );
  const merged = result?.mergedText || oursHtml || "<p></p>";
  return innerListItemHtml(merged) || merged;
}

function htmlHasTextConflictMarkers(html) {
  return String(html || "").includes("data-kindred-text-conflict");
}

function liAtPath(listElement, path) {
  if (!listElement || !path?.length) return null;
  let list = listElement;
  let li = null;
  for (let depth = 0; depth < path.length; depth++) {
    const items = Array.from(list.children).filter((child) => child.tagName === "LI");
    li = items[path[depth]];
    if (!li) return null;
    if (depth < path.length - 1) {
      list = li.querySelector(":scope > ul, :scope > ol");
      if (!list) return null;
    }
  }
  return li;
}

function innerListItemHtml(html) {
  const raw = String(html || "").trim();
  if (!raw) return "";
  const wrapped = raw.startsWith("<li") ? `<ul>${raw}</ul>` : `<div>${raw}</div>`;
  const parsed = new DOMParser().parseFromString(wrapped, "text/html");
  const li = parsed.querySelector("li");
  return li ? li.innerHTML.trim() : raw;
}

function fullLiHtml(listNode, path) {
  const listElement = listElementFromHtml(defaultBlockToHtml(listNode));
  const li = liAtPath(listElement, path);
  return li?.outerHTML || "";
}

function nestFlatItems(ownerDocument, listTag, items) {
  const root = ownerDocument.createElement(listTag);
  const lists = [root];
  for (const item of items) {
    const depth = item.depth ?? 0;
    const targetDepth = depth + 1;
    while (lists.length > targetDepth) lists.pop();
    while (lists.length < targetDepth) {
      const sub = ownerDocument.createElement(listTag);
      const parentList = lists[lists.length - 1];
      const lastLi = parentList.lastElementChild;
      if (lastLi) lastLi.appendChild(sub);
      else parentList.appendChild(sub);
      lists.push(sub);
    }
    const li = ownerDocument.createElement("li");
    li.innerHTML = item.innerHtml || "<p></p>";
    if (item.itemIndex != null) {
      li.setAttribute("data-kindred-list-item-index", String(item.itemIndex));
    }
    lists[lists.length - 1].appendChild(li);
  }
  return root;
}

function indexItemChanges(diff) {
  const byBase = new Map();
  const inserts = new Map();
  let gapIndex = 0;
  for (const item of diff.items) {
    if (item.action === "insert") {
      if (!inserts.has(gapIndex)) inserts.set(gapIndex, []);
      inserts.get(gapIndex).push(item);
      continue;
    }
    if (item.oldIndex != null) {
      byBase.set(item.oldIndex, item);
      gapIndex = item.oldIndex + 1;
    }
  }
  return { byBase, inserts };
}

function itemChanged(item) {
  return item && item.action !== "equal";
}

function sameListItemHtml(left, right) {
  return String(left || "").trim() === String(right || "").trim();
}

function indentConflictHtml(item, oursNode, theirsNode) {
  const oursLi = fullLiHtml(oursNode, item.oldPath);
  const theirsLi = fullLiHtml(theirsNode, item.newPath);
  const oursDeeper = item.oldDepth > item.newDepth;
  return {
    indentHtml: oursDeeper ? oursLi : theirsLi,
    outdentHtml: oursDeeper ? theirsLi : oursLi,
    oursDepth: item.oldDepth,
    theirsDepth: item.newDepth,
  };
}

function chosenIndentHtml(conflict, side) {
  if (side === "indent") return conflict.indentHtml || "";
  if (side === "outdent") return conflict.outdentHtml || "";
  const oursDeeper = conflict.oursDepth > conflict.theirsDepth;
  if (side === "theirs") {
    return oursDeeper ? conflict.outdentHtml : conflict.indentHtml;
  }
  return oursDeeper ? conflict.indentHtml : conflict.outdentHtml;
}

function displayDepthForItem(item) {
  return item.newDepth ?? item.oldDepth ?? item.depth ?? 0;
}

function displayInnerForItem(item) {
  if (item.action === "delete") {
    return innerListItemHtml(item.oldHtml || item.html || "<p></p>");
  }
  return innerListItemHtml(item.newHtml || item.oldHtml || item.html || "<p></p>");
}

export function parseListConflicts(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed?.conflicts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createListReviewConflict(
  currentHtml,
  dirtyHtml,
  currentLabel,
  dirtyLabel,
  leafMerge = null
) {
  const oursNode = listNodeFromDoc(currentHtml);
  const theirsNode = listNodeFromDoc(dirtyHtml);
  if (!oursNode || !theirsNode) return null;

  const diff = diffList(oursNode, theirsNode);
  const conflicts = [];
  const displayItems = [];
  let itemIndex = 0;
  let hasTextConflict = false;

  for (const item of diff.items) {
    if (item.action === "equal") {
      displayItems.push({
        depth: displayDepthForItem(item),
        innerHtml: displayInnerForItem(item),
        itemIndex,
      });
      itemIndex += 1;
      continue;
    }

    let innerHtml = displayInnerForItem(item);
    if (item.action === "edit" || item.action === "move-edit") {
      innerHtml = innerHtmlFromLeafMerge(
        leafMerge,
        { review: true },
        currentLabel,
        dirtyLabel,
        item.oldHtml,
        item.oldHtml,
        item.newHtml
      );
      if (htmlHasTextConflictMarkers(innerHtml)) hasTextConflict = true;
    }

    displayItems.push({
      depth: displayDepthForItem(item),
      innerHtml,
      itemIndex,
    });

    if (item.action === "move-edit") {
      conflicts.push({
        id: `indent-${itemIndex}`,
        kind: "indent",
        itemIndex,
        ...indentConflictHtml(item, oursNode, theirsNode),
      });
    } else if (item.action === "insert" || item.action === "delete") {
      conflicts.push({
        id: `item-${itemIndex}`,
        kind: "item",
        itemIndex,
        oursHtml: item.action === "delete" ? fullLiHtml(oursNode, item.oldPath || item.path) : "",
        theirsHtml: item.action === "insert" ? fullLiHtml(theirsNode, item.newPath || item.path) : "",
      });
    } else if (item.action === "move") {
      conflicts.push({
        id: `indent-${itemIndex}`,
        kind: "indent",
        itemIndex,
        ...indentConflictHtml(item, oursNode, theirsNode),
      });
    }

    itemIndex += 1;
  }

  if (!hasTextConflict && !conflicts.length) return null;

  const parsed = new DOMParser().parseFromString("<div></div>", "text/html");
  const list = nestFlatItems(parsed, listTagName(oursNode), displayItems);
  if (conflicts.length) {
    list.setAttribute(
      "data-kindred-list-conflicts",
      JSON.stringify({
        currentLabel,
        dirtyLabel,
        conflicts,
      })
    );
  }
  return list.outerHTML;
}

function mergedDisplayItem(baseItem, oursItem, theirsItem) {
  const depth =
    oursItem?.newDepth ??
    theirsItem?.newDepth ??
    baseItem?.depth ??
    0;
  const innerHtml = innerListItemHtml(
    oursItem?.newHtml ??
      theirsItem?.newHtml ??
      baseItem?.html ??
      "<p></p>"
  );
  return { depth, innerHtml };
}

function appendInsertedItems({
  gapIndex,
  oursIndex,
  theirsIndex,
  oursNode,
  theirsNode,
  displayItems,
  conflicts,
  itemIndexRef,
}) {
  const oursItems = oursIndex.inserts.get(gapIndex) || [];
  const theirsItems = theirsIndex.inserts.get(gapIndex) || [];
  const count = Math.max(oursItems.length, theirsItems.length);
  for (let index = 0; index < count; index++) {
    const oursItem = oursItems[index];
    const theirsItem = theirsItems[index];
    if (!oursItem || !theirsItem) {
      const chosen = oursItem || theirsItem;
      displayItems.push({
        ...mergedDisplayItem(null, chosen, null),
        itemIndex: itemIndexRef.value,
      });
      if (chosen.action === "insert") {
        conflicts.push({
          id: `item-${itemIndexRef.value}`,
          kind: "item",
          itemIndex: itemIndexRef.value,
          oursHtml: oursItem ? fullLiHtml(oursNode, oursItem.newPath) : "",
          theirsHtml: theirsItem ? fullLiHtml(theirsNode, theirsItem.newPath) : "",
        });
      }
      itemIndexRef.value += 1;
      continue;
    }

    const oursLi = fullLiHtml(oursNode, oursItem.newPath);
    const theirsLi = fullLiHtml(theirsNode, theirsItem.newPath);
    displayItems.push({
      depth: displayDepthForItem(theirsItem),
      innerHtml: displayInnerForItem(theirsItem),
      itemIndex: itemIndexRef.value,
    });
    if (!sameListItemHtml(oursLi, theirsLi)) {
      conflicts.push({
        id: `item-${itemIndexRef.value}`,
        kind: "item",
        itemIndex: itemIndexRef.value,
        oursHtml: oursLi,
        theirsHtml: theirsLi,
      });
    }
    itemIndexRef.value += 1;
  }
}

export function mergeListWithAlign(
  baseHtml,
  oursHtml,
  theirsHtml,
  oursLabel,
  theirsLabel,
  leafMerge = null
) {
  const baseNode = listNodeFromDoc(baseHtml);
  const oursNode = listNodeFromDoc(oursHtml);
  const theirsNode = listNodeFromDoc(theirsHtml);
  if (!baseNode || !oursNode || !theirsNode) return null;

  const baseItems = flattenItems(baseNode);
  const oursDiff = diffList(baseNode, oursNode);
  const theirsDiff = diffList(baseNode, theirsNode);
  const oursIndex = indexItemChanges(oursDiff);
  const theirsIndex = indexItemChanges(theirsDiff);
  const displayItems = [];
  const conflicts = [];
  const itemIndexRef = { value: 0 };

  for (let baseIndex = 0; baseIndex <= baseItems.length; baseIndex++) {
    appendInsertedItems({
      gapIndex: baseIndex,
      oursIndex,
      theirsIndex,
      oursNode,
      theirsNode,
      displayItems,
      conflicts,
      itemIndexRef,
    });
    if (baseIndex === baseItems.length) break;

    const oursItem = oursIndex.byBase.get(baseIndex);
    const theirsItem = theirsIndex.byBase.get(baseIndex);
    if (!oursItem || !theirsItem) return null;

    const baseItem = baseItems[baseIndex];
    const oursDeleted = oursItem.action === "delete";
    const theirsDeleted = theirsItem.action === "delete";
    if (oursDeleted && theirsDeleted) continue;

    if (oursDeleted || theirsDeleted) {
      const surviving = oursDeleted ? theirsItem : oursItem;
      if (!itemChanged(surviving)) continue;
      displayItems.push({
        ...mergedDisplayItem(baseItem, oursDeleted ? null : oursItem, theirsDeleted ? null : theirsItem),
        itemIndex: itemIndexRef.value,
      });
      conflicts.push({
        id: `item-${itemIndexRef.value}`,
        kind: "item",
        itemIndex: itemIndexRef.value,
        oursHtml: oursDeleted ? "" : fullLiHtml(oursNode, oursItem.oldPath),
        theirsHtml: theirsDeleted ? "" : fullLiHtml(theirsNode, theirsItem.newPath),
      });
      itemIndexRef.value += 1;
      continue;
    }

    const oursMoved = oursItem.action === "move" || oursItem.action === "move-edit";
    const theirsMoved = theirsItem.action === "move" || theirsItem.action === "move-edit";
    const oursEdited = oursItem.action === "edit" || oursItem.action === "move-edit";
    const theirsEdited = theirsItem.action === "edit" || theirsItem.action === "move-edit";

    if (oursMoved && theirsMoved && oursItem.newDepth !== theirsItem.newDepth) {
      displayItems.push({
        depth: displayDepthForItem(oursItem),
        innerHtml: displayInnerForItem(oursItem),
        itemIndex: itemIndexRef.value,
      });
      conflicts.push({
        id: `indent-${itemIndexRef.value}`,
        kind: "indent",
        itemIndex: itemIndexRef.value,
        ...indentConflictHtml(
          {
            oldPath: baseItem.path,
            newPath: oursItem.newPath,
            oldDepth: baseItem.depth,
            newDepth: oursItem.newDepth,
          },
          baseNode,
          oursNode
        ),
        oursDepth: oursItem.newDepth,
        theirsDepth: theirsItem.newDepth,
        indentHtml: fullLiHtml(
          oursItem.newDepth > theirsItem.newDepth ? oursNode : theirsNode,
          oursItem.newDepth > theirsItem.newDepth ? oursItem.newPath : theirsItem.newPath
        ),
        outdentHtml: fullLiHtml(
          oursItem.newDepth > theirsItem.newDepth ? theirsNode : oursNode,
          oursItem.newDepth > theirsItem.newDepth ? theirsItem.newPath : oursItem.newPath
        ),
      });
      itemIndexRef.value += 1;
      continue;
    }

    const mergedInner = mergedDisplayItem(baseItem, oursItem, theirsItem);
    displayItems.push({
      ...mergedInner,
      itemIndex: itemIndexRef.value,
    });

    if (
      oursEdited &&
      theirsEdited &&
      !sameListItemHtml(oursItem.newHtml, theirsItem.newHtml)
    ) {
      displayItems[displayItems.length - 1].innerHtml = innerHtmlFromLeafMerge(
        leafMerge,
        { review: false },
        oursLabel,
        theirsLabel,
        baseItem.html,
        oursItem.newHtml,
        theirsItem.newHtml
      );
    } else if (oursMoved || theirsMoved) {
      const movedItem = oursMoved ? oursItem : theirsItem;
      const movedNode = oursMoved ? oursNode : theirsNode;
      const indent = indentConflictHtml(
        {
          oldPath: baseItem.path,
          newPath: movedItem.newPath,
          oldDepth: baseItem.depth,
          newDepth: movedItem.newDepth,
        },
        baseNode,
        movedNode
      );
      if (
        (oursMoved && itemChanged(theirsItem)) ||
        (theirsMoved && itemChanged(oursItem))
      ) {
        conflicts.push({
          id: `indent-${itemIndexRef.value}`,
          kind: "indent",
          itemIndex: itemIndexRef.value,
          ...indent,
        });
      } else {
        displayItems[displayItems.length - 1] = {
          depth: movedItem.newDepth,
          innerHtml: innerListItemHtml(movedItem.newHtml || baseItem.html),
          itemIndex: itemIndexRef.value,
        };
      }
    } else if (oursEdited && theirsEdited) {
      displayItems[displayItems.length - 1].innerHtml = innerListItemHtml(
        oursItem.newHtml || theirsItem.newHtml || baseItem.html
      );
    } else if (oursEdited) {
      displayItems[displayItems.length - 1].innerHtml = innerListItemHtml(
        oursItem.newHtml || baseItem.html
      );
    } else if (theirsEdited) {
      displayItems[displayItems.length - 1].innerHtml = innerListItemHtml(
        theirsItem.newHtml || baseItem.html
      );
    }

    itemIndexRef.value += 1;
  }

  if (!displayItems.length) return null;

  const parsed = new DOMParser().parseFromString("<div></div>", "text/html");
  const list = nestFlatItems(parsed, listTagName(baseNode), displayItems);
  if (conflicts.length) {
    list.setAttribute(
      "data-kindred-list-conflicts",
      JSON.stringify({
        currentLabel: oursLabel,
        dirtyLabel: theirsLabel,
        conflicts,
      })
    );
  }
  return {
    html: list.outerHTML,
    conflictCount: conflicts.length,
  };
}

function findLiByItemIndex(listElement, itemIndex) {
  return listElement.querySelector(
    `[data-kindred-list-item-index="${itemIndex}"]`
  );
}

function reindexListConflicts(conflicts, removedIndex) {
  for (const remaining of conflicts) {
    if (remaining.itemIndex > removedIndex) remaining.itemIndex -= 1;
  }
}

function liFromHtml(ownerDocument, html) {
  const parsed = new DOMParser().parseFromString(
    `<ul>${html || ""}</ul>`,
    "text/html"
  );
  const li = parsed.querySelector("li");
  return li ? ownerDocument.importNode(li, true) : null;
}

function displayItemsFromListElement(listElement) {
  const items = [];
  function walk(list, depth) {
    for (const child of list.children) {
      if (child.tagName !== "LI") continue;
      const own = child.cloneNode(true);
      own.querySelectorAll("ul, ol").forEach((nested) => nested.remove());
      items.push({
        depth,
        innerHtml: own.innerHTML.trim() || "<p></p>",
        itemIndex: items.length,
      });
      for (const sub of child.children) {
        if (sub.tagName === "UL" || sub.tagName === "OL") walk(sub, depth + 1);
      }
    }
  }
  walk(listElement, 0);
  return items;
}

function indentDepthForSide(conflict, side) {
  const ours = conflict.oursDepth ?? 0;
  const theirs = conflict.theirsDepth ?? 0;
  if (side === "indent") return Math.max(ours, theirs);
  if (side === "outdent") return Math.min(ours, theirs);
  if (side === "theirs") return theirs;
  return ours;
}

function parentItemIndex(items, index) {
  const depth = items[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].depth < depth) return i;
  }
  return -1;
}

function isDescendantOf(items, ancestorIndex, index) {
  if (index <= ancestorIndex) return false;
  let current = index;
  while (current > ancestorIndex) {
    const parent = parentItemIndex(items, current);
    if (parent < 0) return false;
    if (parent === ancestorIndex) return true;
    current = parent;
  }
  return false;
}

function removeDisplayItemAt(items, removeIndex) {
  if (removeIndex < 0 || removeIndex >= items.length) return items;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (i === removeIndex) continue;
    const item = { ...items[i] };
    if (isDescendantOf(items, removeIndex, i)) {
      item.depth = Math.max(0, item.depth - 1);
    }
    item.itemIndex = out.length;
    out.push(item);
  }
  return out;
}

function rebuildListChildren(listElement, displayItems) {
  const built = nestFlatItems(
    listElement.ownerDocument,
    listElement.tagName.toLowerCase(),
    displayItems
  );
  listElement.innerHTML = built.innerHTML;
}

function applyListConflict(listElement, data, conflict, side) {
  if (conflict.kind !== "item" && conflict.kind !== "indent") return;

  if (conflict.kind === "indent") {
    const li = findLiByItemIndex(listElement, conflict.itemIndex);
    const bulkSide = side === "theirs" || side === "ours";
    if (bulkSide && li) return;
    const displayItems = displayItemsFromListElement(listElement);
    const item = displayItems[conflict.itemIndex];
    if (!item) return;
    item.depth = indentDepthForSide(conflict, side);
    rebuildListChildren(listElement, displayItems);
    return;
  }

  if (conflict.kind !== "item") return;

  const oursHtml = String(conflict.oursHtml || "").trim();
  const theirsHtml = String(conflict.theirsHtml || "").trim();
  const chosenHtml = side === "theirs" ? conflict.theirsHtml : conflict.oursHtml;
  const chosenTrimmed = String(chosenHtml || "").trim();
  const insertOnly = !oursHtml && theirsHtml;
  const deleteOnly = oursHtml && !theirsHtml;
  const keepChosen = chosenTrimmed.length > 0;

  if (!keepChosen) {
    const displayItems = displayItemsFromListElement(listElement);
    const newItems = removeDisplayItemAt(displayItems, conflict.itemIndex);
    rebuildListChildren(listElement, newItems);
    reindexListConflicts(data.conflicts, conflict.itemIndex);
    return;
  }

  const li = findLiByItemIndex(listElement, conflict.itemIndex);
  if (li) {
    const bulkSide = side === "theirs" || side === "ours";
    if (bulkSide && (insertOnly || deleteOnly)) return;
    const replacement = liFromHtml(listElement.ownerDocument, chosenHtml);
    if (replacement) {
      replacement.setAttribute(
        "data-kindred-list-item-index",
        String(conflict.itemIndex)
      );
      li.replaceWith(replacement);
    }
    return;
  }

  if (!keepChosen) return;
  const replacement = liFromHtml(listElement.ownerDocument, chosenHtml);
  if (!replacement) return;
  replacement.setAttribute(
    "data-kindred-list-item-index",
    String(conflict.itemIndex)
  );
  listElement.appendChild(replacement);
}

export function resolveListConflictHtml(listHtml, conflictId, side) {
  const parsed = new DOMParser().parseFromString(listHtml, "text/html");
  const list = parsed.querySelector("ul, ol");
  if (!list) return listHtml;
  const data = parseListConflicts(list.getAttribute("data-kindred-list-conflicts"));
  if (!data) return listHtml;
  const conflict = data.conflicts.find((item) => item.id === conflictId);
  if (!conflict) return listHtml;

  applyListConflict(list, data, conflict, side);
  data.conflicts = data.conflicts.filter((item) => item.id !== conflictId);
  if (data.conflicts.length) {
    list.setAttribute("data-kindred-list-conflicts", JSON.stringify(data));
  } else {
    list.removeAttribute("data-kindred-list-conflicts");
  }
  return list.outerHTML;
}

export function resolveAllListConflicts(html, side) {
  const parsed = new DOMParser().parseFromString(
    `<div id="__kindred_list_root">${html || ""}</div>`,
    "text/html"
  );
  const root = parsed.getElementById("__kindred_list_root");
  if (!root) return html || "";
  root.querySelectorAll("[data-kindred-list-conflicts]").forEach((list) => {
    const data = parseListConflicts(list.getAttribute("data-kindred-list-conflicts"));
    if (!data) return;
    for (const conflict of data.conflicts) {
      applyListConflict(list, data, conflict, side);
    }
    list.removeAttribute("data-kindred-list-conflicts");
  });
  return root.innerHTML;
}

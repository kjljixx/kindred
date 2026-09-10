import DOMPurify from "dompurify";
import { toHast } from "@googleworkspace/google-docs-hast";
import { unified } from "unified";
import rehypeStringify from "rehype-stringify";
import { blockToHtml, htmlToDoc } from "./kindredSchema.js";
import { debugEvent } from "./debug.js";
import { invertColorValue } from "./colorInvert.js";

function summarizeProseMirrorDocument(document) {
  const json = document?.toJSON?.() || document || {};
  const content = json.content || [];
  return {
    topLevelTypes: content.map((node) => node.type),
    textLength: JSON.stringify(json).match(/"text":"([^"]*)"/g)
      ?.reduce((length, entry) => length + entry.length, 0) || 0,
  };
}

function summarizeGoogleDocument(document) {
  const content = document?.body?.content || [];
  return {
    blockCount: content.length,
    paragraphTexts: content
      .filter((block) => block.paragraph)
      .map((block) => block.paragraph.elements
        .map((element) => element.textRun?.content || "")
        .join("").trim())
      .filter(Boolean)
      .slice(0, 12),
    tableCount: content.filter((block) => block.table).length,
  };
}

function linkedGoogleTextStyles(value, styles = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => linkedGoogleTextStyles(item, styles));
  } else if (value && typeof value === "object") {
    if (value.textRun?.textStyle?.link) styles.push(value.textRun.textStyle);
    Object.values(value).forEach((item) => linkedGoogleTextStyles(item, styles));
  }
  return styles;
}

function googleColorToCss(color) {
  const rgb = color?.color?.rgbColor || color?.rgbColor;
  if (!rgb) return null;
  const channel = (value = 0) => Math.round(value * 255);
  return invertColorValue(`rgb(${channel(rgb.red)}, ${channel(rgb.green)}, ${channel(rgb.blue)})`);
}

function addEditorFontFallback(source) {
  source.body.querySelectorAll("[style]").forEach((element) => {
    const family = element.style.fontFamily;
    if (!family || family.includes("var(--font-content)")) return;
    element.style.fontFamily = `${family}, var(--font-content)`;
  });
}

function restoreLinkedGoogleTextStyles(source, document) {
  const styles = linkedGoogleTextStyles(document);
  source.body.querySelectorAll("a").forEach((link, index) => {
    const textStyle = styles[index];
    if (!textStyle) return;

    const css = {};
    if (textStyle.backgroundColor) css.backgroundColor = googleColorToCss(textStyle.backgroundColor);
    if (textStyle.foregroundColor) css.color = googleColorToCss(textStyle.foregroundColor);
    if (textStyle.fontSize) {
      css.fontSize = `${textStyle.fontSize.magnitude}${String(textStyle.fontSize.unit).toLowerCase()}`;
    }
    if (textStyle.weightedFontFamily?.fontFamily) {
      css.fontFamily = textStyle.weightedFontFamily.fontFamily;
    }
    if (textStyle.weightedFontFamily?.weight) {
      css.fontWeight = String(textStyle.weightedFontFamily.weight);
    }
    if (Object.keys(css).length) {
      const span = source.createElement("span");
      Object.assign(span.style, css);
      link.replaceWith(span);
      span.append(link);
    }

    const wrappers = [
      [textStyle.bold, "strong"],
      [textStyle.italic, "i"],
      [textStyle.strikethrough, "s"],
      [textStyle.underline, "u"],
      [textStyle.baselineOffset === "SUPERSCRIPT", "sup"],
      [textStyle.baselineOffset === "SUBSCRIPT", "sub"],
    ];
    let outermost = link.parentElement?.tagName === "SPAN" ? link.parentElement : link;
    wrappers.forEach(([enabled, tagName]) => {
      if (!enabled) return;
      const wrapper = source.createElement(tagName);
      outermost.replaceWith(wrapper);
      wrapper.append(outermost);
      outermost = wrapper;
    });
  });
}

export function googleDocumentToKindredHtml(document) {
  const sourceHtml = unified().use(rehypeStringify).stringify(toHast(document));
  const source = new DOMParser().parseFromString(sourceHtml, "text/html");
  restoreLinkedGoogleTextStyles(source, document);
  addEditorFontFallback(source);
  source.body.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const paragraph = source.createElement("p");
    for (const attribute of heading.attributes) paragraph.setAttribute(attribute.name, attribute.value);
    paragraph.innerHTML = heading.innerHTML;
    heading.replaceWith(paragraph);
  });
  source.body.querySelectorAll("strong [style]").forEach((element) => {
    if (["400", "normal"].includes(element.style.fontWeight)) {
      element.style.removeProperty("font-weight");
    }
  });
  source.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6").forEach((block) => {
    const walker = source.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let finalText = null;
    while (walker.nextNode()) finalText = walker.currentNode;
    if (finalText) finalText.data = finalText.data.replace(/ +$/, (spaces) => "\u00a0".repeat(spaces.length));
  });
  const documentJson = htmlToDoc(DOMPurify.sanitize(source.body.innerHTML));
  return documentJson.content.map((block) => blockToHtml(block)).join("") || "<p></p>";
}

export async function pullGoogleDocumentHtml() {
  return (await pullGoogleDocument()).html;
}
 
export async function pullGoogleDocument(documentId) {
  const query = documentId ? `?documentId=${encodeURIComponent(documentId)}` : "";
  const response = await fetch(`/api/google-docs/document${query}`);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail || "Google Docs pull failed");
    error.status = response.status;
    throw error;
  }
  return {
    html: googleDocumentToKindredHtml(payload.document),
    revisionId: payload.revisionId,
  };
}

export async function fetchGoogleDocumentRevision(documentId) {
  const response = await fetch(`/api/google-docs/revision?documentId=${encodeURIComponent(documentId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "Google Docs revision check failed");
  return payload.revisionId;
}

export function needsGoogleDocsAuthentication(error) {
  return error?.status === 401 ||
    error?.status === 403 ||
    /\b(401|403)\b/.test(String(error?.message || error));
}

function nodeType(node) {
  return node?.type?.name || node?.type;
}

function nodeSize(node) {
  if (node?.nodeSize != null) return node.nodeSize;
  if (nodeType(node) === "text") return String(node.text || "").length;
  if (!node?.content?.length) return 1;
  return 2 + node.content.reduce((size, child) => size + nodeSize(child), 0);
}

function nodeChildren(node) {
  if (Array.isArray(node?.content)) return node.content;
  const children = [];
  node?.forEach?.((child) => children.push(child));
  return children;
}

function googleDocsPlainText(content) {
  return content.textBetween(0, content.size, "\n", (node) => (
    nodeType(node) === "mathLive" ? String(node.attrs?.asciiMath || "") : ""
  ));
}

function isGoogleDocsPlainTextContent(content) {
  return nodeChildren(content).every((node) => ["text", "mathLive"].includes(nodeType(node)));
}

/**
 * Map PM positions to Google Docs indexes using only PM document structure.
 * Google Docs and JavaScript both use UTF-16 offsets. Lists/styles/links add
 * no Docs index space; paragraphs add one newline; tables add one cell start.
 * Math atoms are represented in Docs by their raw ASCIIMath text.
 */
export function buildProseMirrorToGoogleDocsPositionMap(proseMirrorDoc) {
  const points = new Map();

  function visit(node, pmPosition, googlePosition) {
    const type = nodeType(node);
    points.set(pmPosition, googlePosition);
    if (type === "text") {
      const length = String(node.text || "").length;
      for (let offset = 1; offset <= length; offset += 1) {
        points.set(pmPosition + offset, googlePosition + offset);
      }
      return googlePosition + length;
    }
    if (type === "mathLive") {
      const rawTextLength = String(node.attrs?.asciiMath || "").length;
      points.set(pmPosition + nodeSize(node), googlePosition + rawTextLength);
      return googlePosition + rawTextLength;
    }
    if (type === "image" || type === "hardBreak") {
      points.set(pmPosition + 1, googlePosition + 1);
      return googlePosition + 1;
    }
    if (type === "table") {
      let rowPmPosition = pmPosition + 1;
      let tableGooglePosition = googlePosition + 3;
      const rows = nodeChildren(node);
      for (const [rowIndex, row] of rows.entries()) {
        points.set(rowPmPosition, tableGooglePosition);
        let cellPmPosition = rowPmPosition + 1;
        for (const cell of nodeChildren(row)) {
          tableGooglePosition = visit(cell, cellPmPosition, tableGooglePosition) + 1;
          cellPmPosition += nodeSize(cell);
        }
        points.set(rowPmPosition + nodeSize(row), tableGooglePosition);
        rowPmPosition += nodeSize(row);
        if (rowIndex < rows.length - 1) tableGooglePosition += 1;
      }
      points.set(pmPosition + nodeSize(node), tableGooglePosition);
      return tableGooglePosition;
    }

    let childPmPosition = pmPosition + (type === "doc" ? 0 : 1);
    let childGooglePosition = googlePosition;
    for (const child of nodeChildren(node)) {
      childGooglePosition = visit(child, childPmPosition, childGooglePosition);
      childPmPosition += nodeSize(child);
    }
    if (type === "paragraph") childGooglePosition += 1;
    points.set(pmPosition + nodeSize(node), childGooglePosition);
    return childGooglePosition;
  }

  visit(proseMirrorDoc, 0, 1);
  const positions = [...points.keys()].sort((a, b) => a - b);
  const mapPosition = (position) => {
    const target = Math.max(0, Number(position) || 0);
    let nearest = positions[0] ?? 0;
    for (const candidate of positions) {
      if (candidate > target) break;
      nearest = candidate;
    }
    return points.get(nearest) ?? 1;
  };
  return { mapPosition, points, entries: positions.map((position) => ({ position, index: points.get(position) })) };
}

export function mapProseMirrorPositionToGoogleDocsPosition(proseMirrorDoc, position) {
  return buildProseMirrorToGoogleDocsPositionMap(proseMirrorDoc).mapPosition(position);
}

export function insertedPlainText(before, after) {
  const beforeText = googleDocsPlainText(before.content);
  const afterText = googleDocsPlainText(after.content);
  let start = 0;
  while (
    start < beforeText.length &&
    start < afterText.length &&
    beforeText[start] === afterText[start]
  ) start += 1;
  let beforeEnd = beforeText.length;
  let afterEnd = afterText.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeText[beforeEnd - 1] === afterText[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return afterText.slice(start, afterEnd);
}

export function filterGoogleDocsTransactionSteps(transaction, positionMap) {
  return transaction.steps.filter((step) => {
    const json = step.toJSON();
    const isDeleteOnlyReplace =
      json.stepType === "replace" &&
      json.from < json.to &&
      !json.slice?.content?.length;
    if (!isDeleteOnlyReplace) return true;
    const mappedStart = positionMap.mapPosition(json.from);
    const mappedEnd = positionMap.mapPosition(json.to);
    if (mappedStart < mappedEnd) return true;
    debugEvent("gdocsSync", "transaction-path", {
      branch: "skipped-empty-delete",
      stepType: json.stepType,
      from: json.from,
      to: json.to,
      mappedStart,
      mappedEnd,
      requestTypes: [],
    });
    return false;
  });
}

function googleTextStyleForMark(mark, enabled = true, existingMark = null) {
  if (mark?.type === "link") return { textStyle: { link: enabled ? { url: mark.attrs?.href } : null }, fields: "link" };
  if (["bold", "italic", "underline", "strike"].includes(mark?.type)) {
    const field = mark.type === "strike" ? "strikethrough" : mark.type;
    return { textStyle: { [field]: enabled }, fields: field };
  }
  if (mark?.type === "highlight") {
    const color = enabled ? cssColorToGoogleColor(mark.attrs?.color) : null;
    return { textStyle: { backgroundColor: color }, fields: "backgroundColor" };
  }
  if (mark?.type === "textStyle") {
    const attrs = enabled ? (mark.attrs || {}) : (existingMark?.attrs || mark.attrs || {});
    const textStyle = {};
    const fields = [];
    if (attrs.color) {
      textStyle.foregroundColor = enabled ? cssColorToGoogleColor(attrs.color) : null;
      fields.push("foregroundColor");
    }
    if (attrs.fontFamily) {
      textStyle.weightedFontFamily = enabled && attrs.fontFamily
        ? { fontFamily: String(attrs.fontFamily).split(",")[0].trim().replace(/^['"]|['"]$/g, "") }
        : null;
      fields.push("weightedFontFamily");
    }
    if (attrs.fontSize) {
      textStyle.fontSize = enabled ? cssFontSizeToGoogleSize(attrs.fontSize) : null;
      fields.push("fontSize");
    }
    if (fields.length) return { textStyle, fields: fields.join(",") };
  }
  return null;
}

function insertedTextStyleRequests(json, startIndex, endIndex) {
  const insertedMarks = json.slice?.content
    ?.find((node) => node.type === "text")
    ?.marks || [];
  const markByType = new Map(insertedMarks.map((mark) => [mark.type, mark]));
  const textStyleMark = markByType.get("textStyle");
  const textStyle = {
    bold: markByType.has("bold"),
    italic: markByType.has("italic"),
    underline: markByType.has("underline"),
    strikethrough: markByType.has("strike"),
    link: markByType.has("link") ? { url: markByType.get("link").attrs?.href } : null,
    foregroundColor: textStyleMark?.attrs?.color
      ? cssColorToGoogleColor(textStyleMark.attrs.color)
      : null,
    backgroundColor: markByType.has("highlight")
      ? cssColorToGoogleColor(markByType.get("highlight").attrs?.color)
      : null,
    weightedFontFamily: textStyleMark?.attrs?.fontFamily
      ? {
          fontFamily: String(textStyleMark.attrs.fontFamily)
            .split(",")[0]
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        }
      : null,
    fontSize: textStyleMark?.attrs?.fontSize
      ? cssFontSizeToGoogleSize(textStyleMark.attrs.fontSize)
      : null,
  };
  return [{ updateTextStyle: {
    range: { startIndex, endIndex },
    textStyle,
    fields: Object.keys(textStyle).join(","),
  } }];
}

function cssColorToGoogleColor(value) {
  if (typeof value !== "string") return null;
  const input = invertColorValue(value.trim()).toLowerCase();
  let channels = null;
  if (input.startsWith("#")) {
    const hex = input.slice(1);
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((channel) => channel + channel).join("")
      : hex;
    if (/^[0-9a-f]{6,8}$/.test(expanded)) {
      channels = [expanded.slice(0, 2), expanded.slice(2, 4), expanded.slice(4, 6)].map((channel) => parseInt(channel, 16) / 255);
    }
  } else {
    const match = input.match(/^rgba?\(\s*([\d.]+)(%?)\s*,\s*([\d.]+)(%?)\s*,\s*([\d.]+)(%?)(?:\s*,\s*[\d.]+%?)?\s*\)$/);
    if (match) {
      channels = [1, 3, 5].map((index) => {
        const channel = Number(match[index]);
        return Math.max(0, Math.min(255, match[index + 1] ? channel * 2.55 : channel)) / 255;
      });
    }
  }
  return channels ? { color: { rgbColor: { red: channels[0], green: channels[1], blue: channels[2] } } } : null;
}

function cssFontSizeToGoogleSize(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*(pt|px)?$/i);
  if (!match) return null;
  const magnitude = Number(match[1]) * (match[2]?.toLowerCase() === "px" ? 0.75 : 1);
  return Number.isFinite(magnitude) ? { magnitude, unit: "PT" } : null;
}

const googleParagraphAlignment = {
  left: "START",
  center: "CENTER",
  right: "END",
  justify: "JUSTIFIED",
};

function tableInfos(document) {
  const tables = [];
  document.descendants((node, pos) => {
    if (node.type.name !== "table") return;
    const rows = node.content.content;
    let rowPosition = pos + 1;
    const rowInfos = rows.map((row, rowIndex) => {
      let cellPosition = rowPosition + 1;
      const cells = row.content.content.map((cell, columnIndex) => {
        const info = { node: cell, rowIndex, columnIndex, pos: cellPosition, end: cellPosition + cell.nodeSize };
        cellPosition += cell.nodeSize;
        return info;
      });
      const info = { node: row, rowIndex, pos: rowPosition, end: rowPosition + row.nodeSize, cells };
      rowPosition += row.nodeSize;
      return info;
    });
    tables.push({
      node,
      pos,
      end: pos + node.nodeSize,
      rows,
      rowInfos,
      rowCount: rows.length,
      columnCounts: rowInfos.map((row) => row.cells.length),
      columnCount: rowInfos[0]?.cells.length || 0,
    });
  });
  return tables;
}

function tableAtPosition(document, position) {
  return tableInfos(document).find((table) => position >= table.pos && position <= table.pos + table.node.nodeSize);
}

function rowIndexAtPosition(table, position) {
  let rowPosition = table.pos + 1;
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (position <= rowPosition + row.nodeSize) return index;
    rowPosition += row.nodeSize;
  }
  return Math.max(0, table.rows.length - 1);
}

function columnIndexAtPosition(table, position) {
  const rowIndex = rowIndexAtPosition(table, position);
  const row = table.rows[rowIndex];
  if (!row) return 0;
  let cellPosition = table.pos + 2;
  for (let index = 0; index < row.content.content.length; index += 1) {
    const cell = row.content.content[index];
    if (position <= cellPosition + cell.nodeSize) return index;
    cellPosition += cell.nodeSize;
  }
  return Math.max(0, row.content.content.length - 1);
}

function topologyChanged(before, after) {
  return before.rowCount !== after.rowCount || before.columnCounts.join(",") !== after.columnCounts.join(",");
}

function tableAtMappedPosition(tables, position) {
  return tables.find((table) => table.pos === position)
    || tables.find((table) => position >= table.pos && position <= table.end)
    || null;
}

function changedTableCoordinates(table, start, end, kind) {
  const entries = [];
  for (const row of table.rowInfos) {
    if (kind === "row") {
      if (start <= row.pos && end >= row.end) entries.push(row.rowIndex);
      continue;
    }
    for (const cell of row.cells) {
      if (start <= cell.pos && end >= cell.end) {
        entries.push(kind === "cell-row" ? cell.rowIndex : cell.columnIndex);
      }
    }
  }
  return entries;
}

function changedRanges(step) {
  const ranges = [];
  step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
    ranges.push({ oldStart, oldEnd, newStart, newEnd });
  });
  return ranges;
}

function tableRequestForOperation(operation) {
  if (operation.type === "delete-table") {
    return { deleteContentRange: { range: {
      startIndex: operation.googleTableStart,
      endIndex: operation.googleTableEnd,
    } } };
  }
  const location = {
    tableStartLocation: { index: operation.googleTableStart },
    rowIndex: operation.rowIndex,
    columnIndex: operation.columnIndex,
  };
  if (operation.type === "insert-row") return { insertTableRow: { tableCellLocation: location, insertBelow: operation.insertAfter } };
  if (operation.type === "delete-row") return { deleteTableRow: { tableCellLocation: location } };
  if (operation.type === "insert-column") return { insertTableColumn: { tableCellLocation: location, insertRight: operation.insertAfter } };
  return { deleteTableColumn: { tableCellLocation: location } };
}

function tableCellTextRequests(table, document, includeCell) {
  const positionMap = buildProseMirrorToGoogleDocsPositionMap(document);
  const insertions = [];
  const styleRequests = [];

  for (const row of table.rowInfos) {
    for (const cell of row.cells) {
      if (!includeCell(cell)) continue;
      const text = googleDocsPlainText(cell.node.content);
      if (!text) continue;
      insertions.push({
        index: positionMap.mapPosition(cell.pos + 1),
        request: { insertText: {
          location: { index: positionMap.mapPosition(cell.pos + 1) },
          text,
        } },
      });
      cell.node.descendants((node, position) => {
        if (!node.isText) return;
        const startIndex = positionMap.mapPosition(cell.pos + 1 + position);
        const endIndex = positionMap.mapPosition(cell.pos + 1 + position + node.nodeSize);
        for (const mark of node.marks) {
          const textStyle = googleTextStyleForMark(mark.toJSON());
          if (!textStyle || startIndex >= endIndex) continue;
          styleRequests.push({ updateTextStyle: {
            range: { startIndex, endIndex },
            ...textStyle,
          } });
        }
      });
    }
  }

  return insertions
    .sort((a, b) => b.index - a.index)
    .map(({ request }) => request)
    .concat(styleRequests);
}

function insertedTableCellTextRequests(operation, document) {
  if (!operation.type.startsWith("insert-")) return [];
  const table = tableAtMappedPosition(tableInfos(document), operation.finalTableStart);
  if (!table) return [];
  if (operation.type === "insert-row") {
    return tableCellTextRequests(table, document, (cell) => cell.rowIndex === operation.insertedRowIndex);
  }
  return tableCellTextRequests(table, document, (cell) => cell.columnIndex === operation.insertedColumnIndex);
}

/**
 * PM table commands compile to generic replace steps. Interpret their complete
 * stepped-through document sequence before emitting any Docs request, so cell
 * cleanup steps never become independent deleteContentRange requests.
 */
export function analyzeTableStructureChanges(transaction) {
  const trackers = tableInfos(transaction.docs?.[0] || transaction.before || transaction.doc)
    .map((table, id) => ({ id, currentStart: table.pos, fragments: [], stepIndexes: new Set(), unsupported: false }));
  const suppressedStepIndexes = new Set();
  const unsupportedStepIndexes = new Set();
  const operations = [];

  for (let stepIndex = 0; stepIndex < transaction.steps.length; stepIndex += 1) {
    const step = transaction.steps[stepIndex];
    const before = transaction.docs?.[stepIndex] || transaction.before;
    const after = transaction.docs?.[stepIndex + 1] || transaction.doc;
    if (!before || !after) continue;
    const beforeTables = tableInfos(before);
    const afterTables = tableInfos(after);
    const ranges = changedRanges(step);

    for (const tracker of trackers) {
      const beforeTable = tableAtMappedPosition(beforeTables, tracker.currentStart);
      const mappedStart = step.getMap().map(tracker.currentStart, 1);
      const afterTable = tableAtMappedPosition(afterTables, mappedStart);
      tracker.currentStart = mappedStart;
      if (!beforeTable) continue;
      if (!afterTable) {
        const exactTableDeletion = ranges.some((range) =>
          range.oldStart === beforeTable.pos
          && range.oldEnd === beforeTable.end
          && range.newStart === range.newEnd,
        );
        if (exactTableDeletion) {
          tracker.fragments.push({
            type: "delete-table",
            stepIndex,
            tableStart: beforeTable.pos,
            tableEnd: beforeTable.end,
          });
          tracker.stepIndexes.add(stepIndex);
        } else if (ranges.some((range) => range.oldEnd > beforeTable.pos && range.oldStart < beforeTable.end)) {
          tracker.unsupported = true;
          tracker.stepIndexes.add(stepIndex);
        }
        continue;
      }
      if (!topologyChanged(beforeTable, afterTable)) continue;

      const rowDelta = afterTable.rowCount - beforeTable.rowCount;
      const changedRows = new Set();
      const changedColumns = new Set();
      for (const range of ranges) {
        const oldRows = changedTableCoordinates(beforeTable, range.oldStart, range.oldEnd, "row");
        const newRows = changedTableCoordinates(afterTable, range.newStart, range.newEnd, "row");
        oldRows.concat(newRows,
          changedTableCoordinates(beforeTable, range.oldStart, range.oldEnd, "cell-row"),
          changedTableCoordinates(afterTable, range.newStart, range.newEnd, "cell-row")
        ).forEach((row) => changedRows.add(row));
        changedTableCoordinates(beforeTable, range.oldStart, range.oldEnd, "cell").forEach((column) => changedColumns.add(column));
        changedTableCoordinates(afterTable, range.newStart, range.newEnd, "cell").forEach((column) => changedColumns.add(column));
      }
      const changedRow = changedRows.values().next().value
        ?? rowIndexAtPosition(beforeTable, step.from ?? beforeTable.pos + 1);
      const changedColumn = changedColumns.values().next().value
        ?? columnIndexAtPosition(beforeTable, step.from ?? beforeTable.pos + 2);
      const rowWidthsChanged = beforeTable.columnCounts.join(",") !== afterTable.columnCounts.join(",");
      const commonRowCount = Math.min(beforeTable.rowCount, afterTable.rowCount);
      const commonWidthsChanged = beforeTable.columnCounts.slice(0, commonRowCount).join(",")
        !== afterTable.columnCounts.slice(0, commonRowCount).join(",");
      const columnDeltas = afterTable.columnCounts.map((count, index) => count - (beforeTable.columnCounts[index] ?? 0));
      const columnDelta = columnDeltas.find((delta) => delta !== 0) || 0;
      const type = rowDelta > 0 ? "insert-row"
        : rowDelta < 0 ? "delete-row"
          : rowWidthsChanged && columnDelta > 0 ? "insert-column"
            : rowWidthsChanged && columnDelta < 0 ? "delete-column"
              : null;
      if (!type || (rowDelta && commonWidthsChanged)) {
        tracker.unsupported = true;
        tracker.stepIndexes.add(stepIndex);
        continue;
      }
      tracker.fragments.push({
        type,
        stepIndex,
        tableStart: beforeTable.pos,
        rowIndex: changedRow,
        columnIndex: changedColumn,
        insertedRowIndex: type === "insert-row" ? changedRow : null,
        insertedColumnIndex: type === "insert-column" ? changedColumn : null,
        rowDelta,
        columnDeltas,
      });
      tracker.stepIndexes.add(stepIndex);
    }
  }

  for (const tracker of trackers) {
    if (tracker.unsupported) {
      tracker.stepIndexes.forEach((index) => unsupportedStepIndexes.add(index));
      debugEvent("gdocsSync", "unsupported-table-structure", {
        tableId: tracker.id,
        stepIndexes: [...tracker.stepIndexes],
      });
      continue;
    }
    const groups = new Map();
    for (const fragment of tracker.fragments) {
      const key = fragment.type.endsWith("column")
        ? `${fragment.type}:${fragment.columnIndex}`
        : `${fragment.type}:${fragment.rowIndex}`;
      const group = groups.get(key) || { ...fragment, fragments: [] };
      group.fragments.push(fragment);
      groups.set(key, group);
    }
    for (const operation of groups.values()) {
      const first = operation.fragments[0];
      const operationDocument = transaction.docs?.[first.stepIndex] || transaction.before;
      if (!operationDocument) continue;
      operation.googleTableStart = buildProseMirrorToGoogleDocsPositionMap(operationDocument)
        .mapPosition(first.tableStart);
      if (operation.type === "delete-table") {
        operation.googleTableEnd = buildProseMirrorToGoogleDocsPositionMap(operationDocument)
          .mapPosition(first.tableEnd);
      }
      if (operation.type === "insert-row") {
        operation.insertAfter = operation.rowIndex > 0;
        operation.rowIndex = Math.max(0, operation.rowIndex - 1);
      }
      if (operation.type === "insert-column") {
        operation.insertAfter = operation.columnIndex > 0;
        operation.columnIndex = Math.max(0, operation.columnIndex - 1);
      }
      operation.finalTableStart = tracker.currentStart;
      operations.push(operation);
      operation.fragments.forEach((fragment) => suppressedStepIndexes.add(fragment.stepIndex));
    }
  }
  return { operations, suppressedStepIndexes, unsupportedStepIndexes };
}

export function transactionToGoogleDocsBatchUpdateRequests(transaction, proseMirrorDoc) {
  const positionMap = buildProseMirrorToGoogleDocsPositionMap(proseMirrorDoc);
  const resultingPositionMap = buildProseMirrorToGoogleDocsPositionMap(transaction.doc);
  const tableStructure = analyzeTableStructureChanges(transaction);
  const tableRequestsByStep = new Map();
  for (const operation of tableStructure.operations) {
    const firstStepIndex = operation.fragments[0].stepIndex;
    const requests = tableRequestsByStep.get(firstStepIndex) || [];
    requests.push(
      tableRequestForOperation(operation),
      ...insertedTableCellTextRequests(operation, transaction.doc),
    );
    tableRequestsByStep.set(firstStepIndex, requests);
  }
  const filteredSteps = new Set(filterGoogleDocsTransactionSteps(transaction, positionMap));
  const requests = transaction.steps.flatMap((step, stepIndex) => {
    if (!filteredSteps.has(step)) return [];
    const stepDocument = transaction.docs?.[stepIndex] || proseMirrorDoc;
    const stepPositionMap = buildProseMirrorToGoogleDocsPositionMap(stepDocument);
    const json = step.toJSON();
    const nextDoc = step.apply(stepDocument).doc;
    const mappedStart = stepPositionMap.mapPosition(json.from);
    const mappedEnd = stepPositionMap.mapPosition(json.to);
    const mappedDocumentEnd = stepPositionMap.mapPosition(stepDocument.content.size);
    const deletesAllContent =
      nextDoc.childCount === 1 &&
      nextDoc.firstChild?.type?.name === "paragraph" &&
      nextDoc.firstChild.content.size === 0;
    let deletesListContent = false;
    if (deletesAllContent) {
      stepDocument.descendants((node) => {
        if (["bulletList", "orderedList"].includes(node.type.name)) {
          deletesListContent = true;
          return false;
        }
        return true;
      });
    }
    const deleteContentRequest = (startIndex, endIndex) => {
      const preservesFinalNewline = endIndex === mappedDocumentEnd || deletesAllContent;
      const safeEndIndex = preservesFinalNewline ? endIndex - 1 : endIndex;
      if (startIndex >= safeEndIndex) return null;
      return { deleteContentRange: { range: { startIndex, endIndex: safeEndIndex } } };
    };
    const deleteContentRequests = (startIndex, endIndex) => {
      const deletionRequest = deleteContentRequest(startIndex, endIndex);
      if (!deletionRequest) return [];
      return [
        ...(deletesListContent ? [{
          deleteParagraphBullets: { range: { startIndex, endIndex } },
        }] : []),
        deletionRequest,
      ];
    };
    const finish = (branch, requests, extra = {}) => {
      debugEvent("gdocsSync", "transaction-path", {
        branch,
        stepType: json.stepType,
        from: json.from,
        to: json.to,
        mappedStart,
        mappedEnd,
        requestTypes: requests.map((request) => Object.keys(request)[0]),
        ...extra,
      });
      return requests;
    };
    const insertedNode = json.slice?.content?.[0];
    const insertedContent = step.slice?.content;
    const text = insertedContent && isGoogleDocsPlainTextContent(insertedContent)
      ? googleDocsPlainText(insertedContent)
      : null;
    const existingTextStyle = stepDocument.resolve(json.from).marks()
      .find((mark) => mark.type?.name === "textStyle");
    const textStyle = ["addMark", "removeMark"].includes(json.stepType)
      ? googleTextStyleForMark(json.mark, json.stepType === "addMark", existingTextStyle)
      : null;
    const deletedTables = tableInfos(stepDocument);
    if (json.stepType === "replace" && deletesAllContent && deletedTables.length) {
      const blocks = [];
      stepDocument.forEach((node, position) => {
        blocks.push({
          node,
          startIndex: stepPositionMap.mapPosition(position),
          endIndex: stepPositionMap.mapPosition(position + node.nodeSize),
        });
      });
      const requests = deletesListContent ? [{
        deleteParagraphBullets: {
          range: { startIndex: mappedStart, endIndex: mappedEnd },
        },
      }] : [];
      blocks.reverse().forEach(({ node, startIndex, endIndex }, reverseIndex) => {
        const preservesFinalNewline =
          reverseIndex === 0 &&
          node.type.name !== "table";
        const safeEndIndex = preservesFinalNewline ? endIndex - 1 : endIndex;
        if (startIndex >= safeEndIndex) return;
        requests.push({
          deleteContentRange: {
            range: { startIndex, endIndex: safeEndIndex },
          },
        });
      });
      return finish("delete-all-with-tables", requests, {
        tableCount: deletedTables.length,
      });
    }
    const tableRequests = tableRequestsByStep.get(stepIndex);
    if (tableRequests?.length) {
      return finish("table-structure", tableRequests, {
        operations: tableStructure.operations
          .filter((operation) => operation.fragments[0].stepIndex === stepIndex)
          .map((operation) => operation.type),
      });
    }
    if (tableStructure.suppressedStepIndexes.has(stepIndex)) {
      return finish("table-structure-fragment", []);
    }
    if (textStyle) {
      return finish("text-style", [{ updateTextStyle: {
        range: { startIndex: mappedStart, endIndex: mappedEnd },
        ...textStyle,
      } }], { fields: textStyle.fields });
    }
    if (
      json.stepType === "replaceAround" &&
      json.insert === 1 &&
      json.slice?.content?.length === 2 &&
      json.slice.content.every((node) => ["bulletList", "orderedList"].includes(node.type))
    ) {
      return finish("exit-list", [{ deleteParagraphBullets: {
        range: { startIndex: mappedStart, endIndex: mappedEnd },
      } }]);
    }
    if (json.stepType === "replaceAround" && json.insert === 0 && json.gapFrom > json.from) {
      return finish("remove-list", [{ deleteParagraphBullets: {
        range: { startIndex: mappedStart, endIndex: mappedEnd },
      } }]);
    }
    if (
      json.stepType === "replaceAround" &&
      [1, 2].includes(json.insert) &&
      insertedNode?.type === "listItem"
    ) {
      const affectedStart = json.from;
      const affectedEnd = json.to;
      const resolvedStart = stepDocument.resolve(affectedStart + 1);
      let listDepth = 0;
      for (let depth = 1; depth <= resolvedStart.depth; depth += 1) {
        if (["bulletList", "orderedList"].includes(resolvedStart.node(depth).type.name)) {
          listDepth = depth;
          break;
        }
      }
      if (!listDepth) return finish("adjacent-list-normalization", []);
      const listStart = resolvedStart.before(listDepth);
      const list = resolvedStart.node(listDepth);
      const listEnd = listStart + list.nodeSize;
      const nestingDelta = json.gapTo === json.to ? 1 : -1;
      const range = {
        startIndex: stepPositionMap.mapPosition(listStart),
        endIndex: stepPositionMap.mapPosition(listEnd),
      };
      const tabInsertions = [];
      stepDocument.nodesBetween(listStart, listEnd, (node, position) => {
        if (node.type.name !== "paragraph") return;
        let paragraphListDepth = 0;
        const resolved = stepDocument.resolve(position + 1);
        for (let depth = 0; depth <= resolved.depth; depth += 1) {
          if (["bulletList", "orderedList"].includes(resolved.node(depth).type.name)) paragraphListDepth += 1;
        }
        const isAffected = position >= affectedStart && position < affectedEnd;
        const tabCount = paragraphListDepth - 1 + (isAffected ? nestingDelta : 0);
        if (!tabCount) return;
        tabInsertions.push({
          index: stepPositionMap.mapPosition(position + 1),
          text: "\t".repeat(tabCount),
        });
      });
      return finish(nestingDelta > 0 ? "indent-list-item" : "outdent-list-item", [
        { deleteParagraphBullets: { range } },
        { updateParagraphStyle: {
          range,
          paragraphStyle: { indentStart: null, indentFirstLine: null },
          fields: "indentStart,indentFirstLine",
        } },
        ...tabInsertions.reverse().map(({ index, text }) => ({ insertText: {
          location: { index },
          text,
        } })),
        { createParagraphBullets: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex + tabInsertions.reduce((total, insertion) => total + insertion.text.length, 0) },
          bulletPreset: list.type.name === "orderedList"
            ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
            : "BULLET_DISC_CIRCLE_SQUARE",
        } },
      ]);
    }
    if (
      json.stepType === "replaceAround" &&
      json.insert === 1 &&
      json.slice?.openStart === 1 &&
      ["bulletList", "orderedList"].includes(insertedNode?.type)
    ) {
      return finish("remove-list-item", [{ deleteParagraphBullets: {
        range: { startIndex: mappedStart, endIndex: mappedEnd },
      } }]);
    }
    if (json.stepType === "replaceAround" && ["bulletList", "orderedList"].includes(insertedNode?.type)) {
      const bulletPreset = insertedNode.type === "orderedList"
        ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
        : "BULLET_DISC_CIRCLE_SQUARE";
      if (json.insert === 1) {
        const list = stepDocument.nodeAt(json.from);
        const ranges = [];
        list?.forEach((item, itemOffset) => {
          const paragraph = item.firstChild;
          if (paragraph?.type?.name !== "paragraph") return;
          const paragraphStart = json.from + itemOffset + 2;
          const range = {
            startIndex: stepPositionMap.mapPosition(paragraphStart),
            endIndex: stepPositionMap.mapPosition(paragraphStart + paragraph.nodeSize),
          };
          const previous = ranges.at(-1);
          if (previous?.endIndex === range.startIndex) previous.endIndex = range.endIndex;
          else ranges.push(range);
        });
        return finish("switch-list", [
          ...ranges.map((range) => ({ deleteParagraphBullets: { range } })),
          ...ranges.map((range) => ({ createParagraphBullets: { range, bulletPreset } })),
        ]);
      }
      const range = { startIndex: mappedStart, endIndex: mappedEnd };
      return finish("create-list", [{ createParagraphBullets: {
        range,
        bulletPreset,
      } }]);
    }
    const alignment = json.stepType === "replaceAround" && insertedNode?.type === "paragraph"
      ? googleParagraphAlignment[insertedNode.attrs?.textAlign]
      : null;
    if (alignment) {
      return finish("paragraph-alignment", [{ updateParagraphStyle: {
        range: { startIndex: mappedStart, endIndex: mappedEnd },
        paragraphStyle: { alignment },
        fields: "alignment",
      } }], { alignment });
    }
    if (json.stepType === "replace" && json.from === json.to && insertedNode?.type === "paragraph") {
      const paragraphText = googleDocsPlainText(step.slice.content);
      return finish("insert-paragraph", [{ insertText: {
        location: { index: mappedStart },
        text: `${paragraphText}\n`,
      } }]);
    }
    if (
      json.stepType === "replace" &&
      json.from < json.to &&
      json.slice?.content?.length &&
      json.slice?.content?.every((node) => node.type === "paragraph")
    ) {
      const paragraphText = googleDocsPlainText(step.slice.content);
      const replacesDocumentEnd = mappedEnd === mappedDocumentEnd;
      const replacementText = replacesDocumentEnd ? paragraphText : `${paragraphText}\n`;
      const replacementRequests = deleteContentRequests(mappedStart, mappedEnd);
      if (replacementText) {
        replacementRequests.push({
          insertText: { location: { index: mappedStart }, text: replacementText },
        });
      }
      return finish("replace-paragraphs", [
        ...replacementRequests,
      ]);
    }
    if (
      json.stepType === "replace" &&
      json.from === json.to &&
      json.slice?.content?.length >= 2 &&
      json.slice.openStart === 2 &&
      json.slice.openEnd === 2 &&
      json.slice.content.every((node) => node.type === "listItem")
    ) {
      const restoredText = insertedPlainText(stepDocument, nextDoc);
      return finish(restoredText === "\n" ? "split-list-item" : "restore-list-items", [{ insertText: {
        location: { index: mappedStart },
        text: restoredText || "\n",
      } }], { restoredText });
    }
    if (
      json.stepType === "replace" &&
      json.from === json.to &&
      json.slice?.content?.length === 2 &&
      json.slice.content.every((node) => node.type === "paragraph")
    ) {
      return finish("paragraph-break", [{ insertText: { location: { index: mappedStart }, text: "\n" } }]);
    }
    if (json.stepType === "replace" && json.from === json.to && insertedNode?.type === "hardBreak") {
      return finish("hard-break", [{ insertText: { location: { index: mappedStart }, text: "\n" } }]);
    }
    if (json.stepType === "replace" && json.from === json.to && insertedNode?.type === "image") {
      return finish("inline-image", [{ insertInlineImage: {
        location: { index: mappedStart },
        uri: json.slice.content[0].attrs?.src,
      } }]);
    }
    if (json.stepType === "replace" && insertedNode?.type === "table") {
      const table = transaction.doc.nodeAt(json.from);
      const tableInfo = tableAtMappedPosition(tableInfos(transaction.doc), json.from);
      const replacedBlock = stepDocument.nodeAt(json.from);
      const replacesEmptyParagraph =
        replacedBlock?.type?.name === "paragraph"
        && replacedBlock.content.size === 0;
      const insertsAtBlockBoundary = stepDocument.resolve(json.from).depth === 0 && mappedStart > 1;
      const replacesTerminalParagraph =
        replacedBlock?.type?.name === "paragraph"
        && Math.max(mappedStart, mappedEnd) === stepPositionMap.mapPosition(stepDocument.content.size);
      const canReplaceParagraphSeparator =
        insertsAtBlockBoundary
        && replacedBlock?.type?.name === "paragraph"
        && !replacesEmptyParagraph
        && !replacesTerminalParagraph;
      const tableInsertionIndex = replacesEmptyParagraph
        ? mappedStart
        : insertsAtBlockBoundary && !replacesTerminalParagraph
          ? mappedStart - 1
          : mappedStart;
      const requests = [];
      if (canReplaceParagraphSeparator) {
        requests.push({ deleteContentRange: {
          range: { startIndex: tableInsertionIndex, endIndex: Math.max(mappedStart, mappedEnd) },
        } });
      }
      requests.push({ insertTable: {
        location: { index: tableInsertionIndex },
        rows: insertedNode.content.length,
        columns: insertedNode.content[0]?.content?.length || 0,
      } });
      if (replacesEmptyParagraph && tableInsertionIndex > 1) {
        requests.push({ deleteContentRange: {
          range: { startIndex: mappedStart - 1, endIndex: mappedStart },
        } });
      }
      if (table?.type.name === "table" && tableInfo) {
        requests.push(...tableCellTextRequests(tableInfo, transaction.doc, () => true));
      }
      return finish("table-insert", requests);
    }
    if (json.stepType !== "replace") return finish("skipped-non-replace", []);
    if (json.from < json.to && !json.slice?.content?.length) {
      return finish("delete-content", deleteContentRequests(mappedStart, mappedEnd));
    }
    if (json.from !== json.to && text !== null) {
      const requests = deleteContentRequests(mappedStart, mappedEnd);
      if (text) requests.push({ insertText: { location: { index: mappedStart }, text } });
      return finish("replace-plain-text", requests);
    }
    if (json.from !== json.to || !text) return finish("skipped-noop", []);
    return finish("insert-text", [
      { insertText: { location: { index: mappedStart }, text } },
      ...insertedTextStyleRequests(json, mappedStart, mappedStart + text.length),
    ]);
  });
  const calculatedTextRequests = (transaction.getMeta?.("googleDocsTextInsertions") || [])
    .map(({ position, text }) => ({
      insertText: {
        location: { index: resultingPositionMap.mapPosition(position) },
        text,
      },
    }));
  return [...requests, ...calculatedTextRequests];
}

export function transactionsToGoogleDocsBatchUpdateRequests(transactions) {
  return transactions.flatMap(({ transaction, before }) =>
    transactionToGoogleDocsBatchUpdateRequests(transaction, before),
  );
}

const GOOGLE_DOCS_STRUCTURE_INSERT_REQUESTS = new Set([
  "insertTable",
  "insertTableRow",
  "insertTableColumn",
]);

export function transactionsToGoogleDocsBatchUpdatePhases(transactions) {
  const phases = [];
  let currentPhase = [];
  for (const { transaction, before } of transactions) {
    const requests = transactionToGoogleDocsBatchUpdateRequests(transaction, before);
    let lastStructureInsert = requests.reduce((lastIndex, request, index) => (
      GOOGLE_DOCS_STRUCTURE_INSERT_REQUESTS.has(Object.keys(request)[0]) ? index : lastIndex
    ), -1);
    if (
      requests[lastStructureInsert]?.insertTable
      && requests[lastStructureInsert + 1]?.deleteContentRange
    ) {
      lastStructureInsert += 1;
    }
    if (lastStructureInsert < 0) {
      currentPhase.push(...requests);
      continue;
    }

    currentPhase.push(...requests.slice(0, lastStructureInsert + 1));
    if (currentPhase.length) phases.push(currentPhase);
    currentPhase = requests.slice(lastStructureInsert + 1);
  }
  if (currentPhase.length) phases.push(currentPhase);
  return phases;
}

export async function pushGoogleDocsTransactions(transactions, syncState) {
  const phases = transactionsToGoogleDocsBatchUpdatePhases(transactions);
  debugEvent("gdocsSync", "push-start", {
    transactions: transactions.map(({ transaction, before }) => ({
      previousDocument: summarizeProseMirrorDocument(before),
      nextDocument: summarizeProseMirrorDocument(transaction.doc),
    })),
    phases,
  });
  let nextSyncState = syncState;
  for (const requests of phases) {
    window.dispatchEvent(new CustomEvent("kindred:google-docs-push", { detail: { requests } }));
    const response = await fetch("/api/google-docs/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: nextSyncState.documentId,
        targetRevisionId: nextSyncState.revisionId,
        requests,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "Google Docs push failed");

    const documentResponse = await fetch(`/api/google-docs/document?documentId=${encodeURIComponent(nextSyncState.documentId)}`);
    const documentPayload = await documentResponse.json();
    if (!documentResponse.ok) throw new Error(documentPayload.detail || "Google Docs readback failed");
    debugEvent("gdocsSync", "push-readback", {
      document: summarizeGoogleDocument(documentPayload.document),
      revisionId: documentPayload.revisionId,
    });
    nextSyncState = { ...nextSyncState, revisionId: documentPayload.revisionId };
  }
  return nextSyncState;
}

export async function pushGoogleDocsTransaction(transaction, proseMirrorDoc, syncState) {
  return pushGoogleDocsTransactions([{ transaction, before: proseMirrorDoc }], syncState);
}

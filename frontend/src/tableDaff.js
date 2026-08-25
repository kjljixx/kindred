import daff from "daff/lib/core.js";

function buildTableGrid(table) {
  const rows = table ? Array.from(table.rows) : [];
  const grid = Array.from({ length: rows.length }, () => []);
  for (const [rowIndex, row] of rows.entries()) {
    let columnIndex = 0;
    for (const [physicalIndex, cell] of Array.from(row.cells).entries()) {
      while (grid[rowIndex][columnIndex] !== undefined) columnIndex += 1;
      const colspan = Math.max(1, Number(cell.getAttribute("colspan")) || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute("rowspan")) || 1);
      for (
        let coveredRow = rowIndex;
        coveredRow < Math.min(rows.length, rowIndex + rowspan);
        coveredRow++
      ) {
        for (
          let coveredColumn = columnIndex;
          coveredColumn < columnIndex + colspan;
          coveredColumn++
        ) {
          grid[coveredRow][coveredColumn] = {
            cell,
            anchor: coveredRow === rowIndex && coveredColumn === columnIndex,
            physicalIndex,
          };
        }
      }
      columnIndex += colspan;
    }
  }
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return { rows, grid, width };
}

export function tableHtmlToDaffData(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const table = parsed.querySelector("table");
  const { rows, grid, width } = buildTableGrid(table);
  const header = Array.from({ length: width }, (_, index) => index + 1);
  const body = rows.map((_, rowIndex) =>
    Array.from({ length: width }, (unused, columnIndex) => {
      const slot = grid[rowIndex][columnIndex];
      return slot?.anchor ? slot.cell.innerHTML : null;
    })
  );
  return [header, ...body];
}

function parseTable(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const table = parsed.querySelector("table");
  const { rows, grid, width } = buildTableGrid(table);
  return {
    data: tableHtmlToDaffData(html).slice(1),
    rows: rows.map((row, rowIndex) => ({
      html: row.outerHTML,
      cells: Array.from({ length: width }, (unused, columnIndex) => {
        const slot = grid[rowIndex][columnIndex];
        return slot?.anchor ? slot.cell.outerHTML : "";
      }),
      covered: Array.from(
        { length: width },
        (unused, columnIndex) => grid[rowIndex][columnIndex]?.anchor === false
      ),
      physicalIndexes: Array.from(
        { length: width },
        (unused, columnIndex) =>
          grid[rowIndex][columnIndex]?.anchor
            ? grid[rowIndex][columnIndex].physicalIndex
            : null
      ),
    })),
  };
}

function columnValues(table, columnIndex) {
  return table.data.map((row) => row[columnIndex] ?? null);
}

function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function columnSimilarity(before, after) {
  const left = before.filter((value) => value != null);
  const right = after.filter((value) => value != null);
  const size = Math.max(left.length, right.length);
  return size ? lcsLength(left, right) / size : 1;
}

function alignColumns(beforeTable, afterTable) {
  const beforeWidth = beforeTable.data.reduce(
    (width, row) => Math.max(width, row.length),
    0
  );
  const afterWidth = afterTable.data.reduce(
    (width, row) => Math.max(width, row.length),
    0
  );
  const beforeColumns = Array.from({ length: beforeWidth }, (_, index) =>
    columnValues(beforeTable, index)
  );
  const afterColumns = Array.from({ length: afterWidth }, (_, index) =>
    columnValues(afterTable, index)
  );
  const gapPenalty = 0.35;
  const dp = Array.from({ length: beforeWidth + 1 }, () =>
    new Array(afterWidth + 1).fill(0)
  );
  for (let i = 1; i <= beforeWidth; i++) dp[i][0] = -i * gapPenalty;
  for (let j = 1; j <= afterWidth; j++) dp[0][j] = -j * gapPenalty;
  for (let i = 1; i <= beforeWidth; i++) {
    for (let j = 1; j <= afterWidth; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + columnSimilarity(beforeColumns[i - 1], afterColumns[j - 1]),
        dp[i - 1][j] - gapPenalty,
        dp[i][j - 1] - gapPenalty
      );
    }
  }

  const columns = [];
  let i = beforeWidth;
  let j = afterWidth;
  while (i > 0 || j > 0) {
    const matchScore =
      i > 0 && j > 0
        ? dp[i - 1][j - 1] + columnSimilarity(beforeColumns[i - 1], afterColumns[j - 1])
        : Number.NEGATIVE_INFINITY;
    if (i > 0 && j > 0 && Math.abs(dp[i][j] - matchScore) < 1e-9) {
      columns.push({ action: "equal", beforeIndex: i - 1, afterIndex: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && Math.abs(dp[i][j] - (dp[i - 1][j] - gapPenalty)) < 1e-9) {
      columns.push({
        action: "delete",
        beforeIndex: i - 1,
        afterIndex: null,
        insertAt: j,
      });
      i -= 1;
    } else {
      columns.push({ action: "insert", beforeIndex: null, afterIndex: j - 1 });
      j -= 1;
    }
  }
  columns.reverse();
  return columns;
}

function alignedRowValues(table, rowIndex, columns, side) {
  const row = table.data[rowIndex] || [];
  return columns.map((column) => {
    const index = side === "before" ? column.beforeIndex : column.afterIndex;
    return index == null ? null : row[index] ?? null;
  });
}

function cellText(value) {
  if (value == null) return "";
  const parsed = new DOMParser().parseFromString(String(value), "text/html");
  return (parsed.body.textContent || "").trim();
}

function cellSimilarity(before, after) {
  if (before === after) return 1;
  const beforeText = cellText(before);
  const afterText = cellText(after);
  if (!beforeText || !afterText) return 0;
  if (beforeText === afterText) return 0.9;
  return 0.8 * lcsLength(beforeText, afterText) /
    Math.max(beforeText.length, afterText.length);
}

function rowSimilarity(beforeTable, afterTable, beforeIndex, afterIndex, columns) {
  const comparable = columns.filter((column) => column.action === "equal");
  if (!comparable.length) return 0;
  const beforeRow = beforeTable.data[beforeIndex] || [];
  const afterRow = afterTable.data[afterIndex] || [];
  const score = comparable.reduce(
    (total, column) =>
      total +
      cellSimilarity(
        beforeRow[column.beforeIndex] ?? null,
        afterRow[column.afterIndex] ?? null
      ),
    0
  );
  return score / comparable.length;
}

function alignRows(beforeTable, afterTable, columns) {
  const beforeCount = beforeTable.rows.length;
  const afterCount = afterTable.rows.length;
  const gapPenalty = 0.45;
  const dp = Array.from({ length: beforeCount + 1 }, () =>
    new Array(afterCount + 1).fill(0)
  );
  for (let i = 1; i <= beforeCount; i++) dp[i][0] = -i * gapPenalty;
  for (let j = 1; j <= afterCount; j++) dp[0][j] = -j * gapPenalty;
  for (let i = 1; i <= beforeCount; i++) {
    for (let j = 1; j <= afterCount; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] +
          rowSimilarity(beforeTable, afterTable, i - 1, j - 1, columns),
        dp[i - 1][j] - gapPenalty,
        dp[i][j - 1] - gapPenalty
      );
    }
  }

  const rows = [];
  let i = beforeCount;
  let j = afterCount;
  while (i > 0 || j > 0) {
    const matchScore =
      i > 0 && j > 0
        ? dp[i - 1][j - 1] +
          rowSimilarity(beforeTable, afterTable, i - 1, j - 1, columns)
        : Number.NEGATIVE_INFINITY;
    if (i > 0 && j > 0 && Math.abs(dp[i][j] - matchScore) < 1e-9) {
      rows.push({ action: "match", beforeIndex: i - 1, afterIndex: j - 1 });
      i -= 1;
      j -= 1;
    } else if (
      i > 0 &&
      Math.abs(dp[i][j] - (dp[i - 1][j] - gapPenalty)) < 1e-9
    ) {
      rows.push({
        action: "delete",
        beforeIndex: i - 1,
        afterIndex: null,
        insertAt: j,
      });
      i -= 1;
    } else {
      rows.push({
        action: "insert",
        beforeIndex: null,
        afterIndex: j - 1,
        insertAt: i,
      });
      j -= 1;
    }
  }
  rows.reverse();
  return rows;
}

function diffMatchedRow(beforeTable, afterTable, row, columns) {
  const header = Array.from(
    { length: columns.length + 1 },
    (_, index) => index + 1
  );
  const rowId = `row-${row.beforeIndex}-${row.afterIndex}`;
  const before = new daff.TableView([
    header,
    [
      ...alignedRowValues(beforeTable, row.beforeIndex, columns, "before"),
      rowId,
    ],
  ]);
  const after = new daff.TableView([
    header,
    [
      ...alignedRowValues(afterTable, row.afterIndex, columns, "after"),
      rowId,
    ],
  ]);
  const flags = new daff.CompareFlags();
  flags.ids = [columns.length + 1];
  flags.allow_nested_cells = true;
  flags.show_unchanged = true;
  flags.show_unchanged_columns = true;
  const alignment = daff.compareTables(before, after, flags).align();
  const output = [];
  new daff.TableDiff(alignment, flags).hilite(new daff.TableView(output));
  const headerIndex = output.findIndex((outputRow) => outputRow[0] === "@@");
  const outputRow = headerIndex < 0 ? null : output[headerIndex + 1];
  if (!outputRow) return [];

  const changes = [];
  for (let columnIndex = 1; columnIndex < outputRow.length; columnIndex++) {
    const cell = outputRow[columnIndex];
    if (!cell || typeof cell !== "object" || !("before" in cell)) continue;
    const column = columns[columnIndex - 1];
    if (!column || column.action !== "equal") continue;
    changes.push({
      rowIndex: row.afterIndex,
      columnIndex:
        afterTable.rows[row.afterIndex]?.physicalIndexes[column.afterIndex] ??
        column.afterIndex,
      beforeRowIndex: row.beforeIndex,
      afterRowIndex: row.afterIndex,
      beforeColumnIndex: column.beforeIndex,
      afterColumnIndex: column.afterIndex,
      beforeHtml: String(cell.before ?? ""),
      afterHtml: String(cell.after ?? ""),
    });
  }
  return changes;
}

export function diffTable(beforeHtml, afterHtml) {
  const beforeTable = parseTable(beforeHtml);
  const afterTable = parseTable(afterHtml);
  const columns = alignColumns(beforeTable, afterTable);
  const cells = [];
  const rows = [];
  for (const row of alignRows(beforeTable, afterTable, columns)) {
    if (row.action === "delete") {
      rows.push({
        action: "delete",
        beforeIndex: row.beforeIndex,
        afterIndex: null,
        insertAt: row.insertAt,
        beforeHtml: beforeTable.rows[row.beforeIndex]?.html || "",
      });
      continue;
    }
    if (row.action === "insert") {
      rows.push({
        action: "insert",
        beforeIndex: null,
        afterIndex: row.afterIndex,
        insertAt: row.insertAt,
        afterHtml: afterTable.rows[row.afterIndex]?.html || "",
      });
      continue;
    }

    const rowChanges = diffMatchedRow(beforeTable, afterTable, row, columns);
    cells.push(...rowChanges);
    rows.push({
      action: rowChanges.length ? "update" : "equal",
      beforeIndex: row.beforeIndex,
      afterIndex: row.afterIndex,
    });
  }
  for (const column of columns) {
    if (column.action !== "delete") continue;
    column.beforeCellsHtml = beforeTable.rows.map(
      (row) => row.cells[column.beforeIndex] || ""
    );
  }
  return { cells, columns, rows };
}

export function diffTableCells(beforeHtml, afterHtml) {
  return diffTable(beforeHtml, afterHtml).cells;
}

export function parseTableConflicts(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed?.conflicts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createTableReviewConflict(
  currentHtml,
  dirtyHtml,
  currentLabel,
  dirtyLabel
) {
  const tableDiff = diffTable(currentHtml, dirtyHtml);

  const parsed = new DOMParser().parseFromString(currentHtml, "text/html");
  const table = parsed.querySelector("table");
  const dirtyParsed = new DOMParser().parseFromString(dirtyHtml, "text/html");
  const dirtyTable = dirtyParsed.querySelector("table");
  if (!table || !dirtyTable || table.tBodies.length !== 1) return null;

  const currentModel = parseTable(currentHtml);
  const dirtyModel = parseTable(dirtyHtml);
  const emptyCell = (row) => {
    const tag = row?.cells[0]?.tagName === "TH" ? "th" : "td";
    const cell = parsed.createElement(tag);
    cell.innerHTML = "<p></p>";
    return cell;
  };
  const alignedRow = (rowIndex, side) => {
    if (rowIndex == null) return null;
    const model = side === "ours" ? currentModel : dirtyModel;
    const sourceRow = model.rows[rowIndex];
    if (!sourceRow) return null;
    const aligned = rowElementFromHtml(parsed, sourceRow.html);
    if (!aligned) return null;
    const cells = tableDiff.columns.map((column) => {
      const sourceIndex =
        side === "ours" ? column.beforeIndex : column.afterIndex;
      const sourceHtml =
        sourceIndex == null ? "" : sourceRow.cells[sourceIndex] || "";
      const source = sourceHtml
        ? tableCellFromHtml(parsed, sourceHtml)
        : null;
      if (source) return source;
      if (sourceIndex != null && sourceRow.covered[sourceIndex]) return null;
      return emptyCell(aligned);
    });
    aligned.replaceChildren(...cells.filter(Boolean));
    aligned.kindredLogicalCells = cells;
    return aligned;
  };
  const displayRows = [];
  const conflicts = [];

  for (const [columnIndex, column] of tableDiff.columns.entries()) {
    if (column.action === "equal") continue;
    conflicts.push({
      id: `column-${columnIndex}`,
      kind: "column",
      columnIndex,
      oursExists: column.beforeIndex != null,
      theirsExists: column.afterIndex != null,
      oursCellsHtml: tableDiff.rows.map((row) =>
        row.beforeIndex == null || column.beforeIndex == null
          ? ""
          : currentModel.rows[row.beforeIndex]?.cells[column.beforeIndex] || ""
      ),
      theirsCellsHtml: tableDiff.rows.map((row) =>
        row.afterIndex == null || column.afterIndex == null
          ? ""
          : dirtyModel.rows[row.afterIndex]?.cells[column.afterIndex] || ""
      ),
    });
  }

  for (const [rowIndex, row] of tableDiff.rows.entries()) {
    const oursRow =
      row.beforeIndex == null
        ? null
        : alignedRow(row.beforeIndex, "ours");
    const theirsRow =
      row.afterIndex == null
        ? null
        : alignedRow(row.afterIndex, "theirs");
    const displayRow = oursRow || theirsRow;
    if (!displayRow) return null;
    displayRows.push(displayRow);

    if (row.action === "insert" || row.action === "delete") {
      conflicts.push({
        id: `row-${rowIndex}`,
        kind: "row",
        rowIndex,
        oursHtml: oursRow?.outerHTML || "",
        theirsHtml: theirsRow?.outerHTML || "",
      });
      continue;
    }
    for (const cell of tableDiff.cells) {
      if (cell.beforeRowIndex !== row.beforeIndex) continue;
      const columnIndex = tableDiff.columns.findIndex(
        (column) =>
          column.beforeIndex === cell.beforeColumnIndex &&
          column.afterIndex === cell.afterColumnIndex
      );
      if (columnIndex < 0) continue;
      const displayCell = displayRow.kindredLogicalCells[columnIndex];
      if (!displayCell) continue;
      conflicts.push({
        id: `cell-${rowIndex}-${columnIndex}`,
        kind: "cell",
        rowIndex,
        columnIndex: Array.from(displayRow.cells).indexOf(displayCell),
        oursHtml: cell.beforeHtml,
        theirsHtml: cell.afterHtml,
      });
    }
  }
  if (!conflicts.length) return null;

  table.tBodies[0].replaceChildren(...displayRows);
  const currentColgroup = table.querySelector(":scope > colgroup");
  const dirtyColgroup = dirtyTable.querySelector(":scope > colgroup");
  if (currentColgroup || dirtyColgroup) {
    const displayColgroup = currentColgroup || parsed.createElement("colgroup");
    const currentCols = currentColgroup
      ? Array.from(currentColgroup.children)
      : [];
    const dirtyCols = dirtyColgroup ? Array.from(dirtyColgroup.children) : [];
    const displayCols = tableDiff.columns.map((column) => {
      const source =
        column.beforeIndex == null
          ? dirtyCols[column.afterIndex]
          : currentCols[column.beforeIndex];
      return source
        ? parsed.importNode(source, true)
        : parsed.createElement("col");
    });
    displayColgroup.replaceChildren(...displayCols);
    if (!currentColgroup) table.prepend(displayColgroup);
  }
  table.setAttribute(
    "data-kindred-table-conflicts",
    JSON.stringify({
      currentLabel,
      dirtyLabel,
      conflicts,
    })
  );
  return table.outerHTML;
}

function rowMergeWithDaff(base, ours, theirs, rowId) {
  if (ours.length !== base.length || theirs.length !== base.length) return null;
  const width = base.length;
  const header = Array.from({ length: width + 1 }, (_, index) => index + 1);
  const addRowId = (row) => [...row, rowId];
  const merged = [header, addRowId(ours)];
  const flags = new daff.CompareFlags();
  flags.allow_nested_cells = true;
  flags.ids = [width + 1];
  const merger = new daff.Merger(
    new daff.TableView([header, addRowId(base)]),
    new daff.TableView(merged),
    new daff.TableView([header, addRowId(theirs)]),
    flags
  );
  merger.apply();
  return {
    values: merged[1].slice(0, width),
    conflicts: merger.getConflictInfos(),
  };
}

function rowElementFromHtml(ownerDocument, html) {
  const parsed = new DOMParser().parseFromString(
    `<table><tbody>${html}</tbody></table>`,
    "text/html"
  );
  const row = parsed.querySelector("tr");
  return row ? ownerDocument.importNode(row, true) : null;
}

function indexRowChanges(tableDiff) {
  const byBase = new Map();
  const inserts = new Map();
  for (const row of tableDiff.rows) {
    if (row.beforeIndex != null) {
      byBase.set(row.beforeIndex, row);
      continue;
    }
    const at = row.insertAt ?? 0;
    if (!inserts.has(at)) inserts.set(at, []);
    inserts.get(at).push(row);
  }
  return { byBase, inserts };
}

function indexColumnChanges(tableDiff) {
  const byBase = new Map();
  const inserts = new Map();
  let gapIndex = 0;
  for (const column of tableDiff.columns) {
    if (column.beforeIndex != null) {
      byBase.set(column.beforeIndex, column);
      gapIndex = column.beforeIndex + 1;
      continue;
    }
    if (!inserts.has(gapIndex)) inserts.set(gapIndex, []);
    inserts.get(gapIndex).push(column);
  }
  return { byBase, inserts };
}

function columnWasEdited(tableDiff, baseColumnIndex) {
  return tableDiff.cells.some(
    (cell) => cell.beforeColumnIndex === baseColumnIndex
  );
}

function sameColumn(table, leftIndex, rightTable, rightIndex) {
  return table.data.every(
    (row, rowIndex) =>
      (row[leftIndex] ?? null) ===
      (rightTable.data[rowIndex]?.[rightIndex] ?? null)
  ) && table.data.length === rightTable.data.length;
}

function planMergedColumns(
  baseTable,
  oursTable,
  theirsTable,
  oursDiff,
  theirsDiff
) {
  const oursIndex = indexColumnChanges(oursDiff);
  const theirsIndex = indexColumnChanges(theirsDiff);
  const columns = [];
  const appendInsertedColumns = (gapIndex) => {
    const oursColumns = oursIndex.inserts.get(gapIndex) || [];
    const theirsColumns = theirsIndex.inserts.get(gapIndex) || [];
    const count = Math.max(oursColumns.length, theirsColumns.length);
    for (let index = 0; index < count; index++) {
      const oursColumn = oursColumns[index];
      const theirsColumn = theirsColumns[index];
      const oursColumnIndex = oursColumn?.afterIndex ?? null;
      const theirsColumnIndex = theirsColumn?.afterIndex ?? null;
      const sameInsertion =
        oursColumnIndex != null &&
        theirsColumnIndex != null &&
        sameColumn(
          oursTable,
          oursColumnIndex,
          theirsTable,
          theirsColumnIndex
        );
      columns.push({
        baseIndex: null,
        oursIndex: oursColumnIndex,
        theirsIndex: theirsColumnIndex,
        conflict:
          oursColumnIndex != null &&
          theirsColumnIndex != null &&
          !sameInsertion,
      });
    }
  };

  const baseWidth = baseTable.data.reduce(
    (width, row) => Math.max(width, row.length),
    0
  );
  for (let baseIndex = 0; baseIndex <= baseWidth; baseIndex++) {
    appendInsertedColumns(baseIndex);
    if (baseIndex === baseWidth) break;
    const oursColumn = oursIndex.byBase.get(baseIndex);
    const theirsColumn = theirsIndex.byBase.get(baseIndex);
    if (!oursColumn || !theirsColumn) return null;
    const oursColumnIndex = oursColumn.afterIndex;
    const theirsColumnIndex = theirsColumn.afterIndex;
    if (oursColumnIndex == null && theirsColumnIndex == null) continue;
    if (oursColumnIndex == null || theirsColumnIndex == null) {
      const survivingDiff =
        oursColumnIndex == null ? theirsDiff : oursDiff;
      if (!columnWasEdited(survivingDiff, baseIndex)) continue;
    }
    columns.push({
      baseIndex,
      oursIndex: oursColumnIndex,
      theirsIndex: theirsColumnIndex,
      conflict: oursColumnIndex == null || theirsColumnIndex == null,
    });
  }
  return columns;
}

function cellOuterHtml(table, rowIndex, columnIndex) {
  if (rowIndex == null || columnIndex == null) return "";
  return table.rows[rowIndex]?.cells[columnIndex] || "";
}

function alignedMergeRow(
  ownerDocument,
  oursTable,
  theirsTable,
  columns,
  oursRowIndex,
  theirsRowIndex
) {
  const template =
    oursTable.rows[oursRowIndex] || theirsTable.rows[theirsRowIndex];
  if (!template) return null;
  const row = rowElementFromHtml(ownerDocument, template.html);
  if (!row) return null;
  const cells = columns.map((column) => {
    const oursCovered =
      oursRowIndex != null &&
      column.oursIndex != null &&
      oursTable.rows[oursRowIndex]?.covered[column.oursIndex];
    const theirsCovered =
      theirsRowIndex != null &&
      column.theirsIndex != null &&
      theirsTable.rows[theirsRowIndex]?.covered[column.theirsIndex];
    const sourceHtml =
      cellOuterHtml(oursTable, oursRowIndex, column.oursIndex) ||
      cellOuterHtml(theirsTable, theirsRowIndex, column.theirsIndex);
    const source = sourceHtml
      ? tableCellFromHtml(ownerDocument, sourceHtml)
      : null;
    if (source) return source;
    if (oursCovered || theirsCovered) return null;
    const tag = row.cells[0]?.tagName === "TH" ? "th" : "td";
    const empty = ownerDocument.createElement(tag);
    empty.innerHTML = "<p></p>";
    return empty;
  });
  row.replaceChildren(...cells.filter(Boolean));
  row.kindredLogicalCells = cells;
  return row;
}

export function mergeTableWithDaff(
  baseHtml,
  oursHtml,
  theirsHtml,
  oursLabel,
  theirsLabel
) {
  const baseTable = parseTable(baseHtml);
  const oursTable = parseTable(oursHtml);
  const theirsTable = parseTable(theirsHtml);
  const oursDiff = diffTable(baseHtml, oursHtml);
  const theirsDiff = diffTable(baseHtml, theirsHtml);
  const columns = planMergedColumns(
    baseTable,
    oursTable,
    theirsTable,
    oursDiff,
    theirsDiff
  );
  if (!columns?.length) return null;
  const parsed = new DOMParser().parseFromString(oursHtml, "text/html");
  const table = parsed.querySelector("table");
  if (!table || table.tBodies.length !== 1) return null;
  const oursIndex = indexRowChanges(oursDiff);
  const theirsIndex = indexRowChanges(theirsDiff);
  const displayRows = [];
  const displaySources = [];
  const conflicts = [];

  const appendRow = (oursRowIndex, theirsRowIndex) => {
    const row = alignedMergeRow(
      parsed,
      oursTable,
      theirsTable,
      columns,
      oursRowIndex,
      theirsRowIndex
    );
    if (!row) return null;
    displayRows.push(row);
    displaySources.push({ oursRowIndex, theirsRowIndex });
    return row;
  };
  const appendRowConflict = (oursRowIndex, theirsRowIndex) => {
    const rowIndex = displayRows.length;
    const oursRow = alignedMergeRow(
      parsed,
      oursTable,
      theirsTable,
      columns,
      oursRowIndex,
      null
    );
    const theirsRow = alignedMergeRow(
      parsed,
      oursTable,
      theirsTable,
      columns,
      null,
      theirsRowIndex
    );
    if (!appendRow(oursRowIndex, theirsRowIndex)) return false;
    conflicts.push({
      id: `row-${conflicts.length}`,
      kind: "row",
      rowIndex,
      oursHtml: oursRow?.outerHTML || "",
      theirsHtml: theirsRow?.outerHTML || "",
    });
    return true;
  };
  const appendInsertedRows = (gapIndex) => {
    const oursRows = oursIndex.inserts.get(gapIndex) || [];
    const theirsRows = theirsIndex.inserts.get(gapIndex) || [];
    const count = Math.max(oursRows.length, theirsRows.length);
    for (let index = 0; index < count; index++) {
      const oursRow = oursRows[index];
      const theirsRow = theirsRows[index];
      const oursRowHtml = oursRow?.afterHtml || "";
      const theirsRowHtml = theirsRow?.afterHtml || "";
      if (!oursRow || !theirsRow) {
        if (!appendRow(oursRow?.afterIndex, theirsRow?.afterIndex)) return false;
      } else if (oursRowHtml === theirsRowHtml) {
        if (!appendRow(oursRow.afterIndex, theirsRow.afterIndex)) return false;
      } else if (
        !appendRowConflict(oursRow.afterIndex, theirsRow.afterIndex)
      ) {
        return false;
      }
    }
    return true;
  };

  for (let baseIndex = 0; baseIndex <= baseTable.rows.length; baseIndex++) {
    if (!appendInsertedRows(baseIndex)) return null;
    if (baseIndex === baseTable.rows.length) break;
    const oursRow = oursIndex.byBase.get(baseIndex);
    const theirsRow = theirsIndex.byBase.get(baseIndex);
    if (!oursRow || !theirsRow) return null;
    const oursExists = oursRow.afterIndex != null;
    const theirsExists = theirsRow.afterIndex != null;
    if (!oursExists && !theirsExists) continue;
    if (!oursExists || !theirsExists) {
      const existingRow = oursExists ? oursRow : theirsRow;
      if (existingRow.action === "equal") continue;
      const oursRowHtml = oursExists
        ? oursTable.rows[oursRow.afterIndex]?.html || ""
        : "";
      const theirsRowHtml = theirsExists
        ? theirsTable.rows[theirsRow.afterIndex]?.html || ""
        : "";
      if (
        !appendRowConflict(
          oursRowHtml ? oursRow.afterIndex : null,
          theirsRowHtml ? theirsRow.afterIndex : null
        )
      ) return null;
      continue;
    }

    const mergeColumns = columns.filter(
      (column) =>
        column.baseIndex != null &&
        column.oursIndex != null &&
        column.theirsIndex != null &&
        !column.conflict
    );
    const rowMerge = rowMergeWithDaff(
      mergeColumns.map(
        (column) => baseTable.data[baseIndex]?.[column.baseIndex] ?? null
      ),
      mergeColumns.map(
        (column) =>
          oursTable.data[oursRow.afterIndex]?.[column.oursIndex] ?? null
      ),
      mergeColumns.map(
        (column) =>
          theirsTable.data[theirsRow.afterIndex]?.[column.theirsIndex] ?? null
      ),
      `base-row-${baseIndex}`
    );
    if (!rowMerge) return null;
    const rowIndex = displayRows.length;
    const displayRow = appendRow(oursRow.afterIndex, theirsRow.afterIndex);
    if (!displayRow) return null;
    const conflictColumns = new Set(
      rowMerge.conflicts.map((conflict) => conflict.col)
    );
    for (let mergeIndex = 0; mergeIndex < mergeColumns.length; mergeIndex++) {
      if (conflictColumns.has(mergeIndex)) continue;
      const columnIndex = columns.indexOf(mergeColumns[mergeIndex]);
      const displayCell = displayRow.kindredLogicalCells[columnIndex];
      if (displayCell) {
        displayCell.innerHTML = String(rowMerge.values[mergeIndex] ?? "");
      }
    }
    for (const conflict of rowMerge.conflicts) {
      const logicalColumnIndex = columns.indexOf(mergeColumns[conflict.col]);
      const displayCell = displayRow.kindredLogicalCells[logicalColumnIndex];
      if (!displayCell) continue;
      conflicts.push({
        id: `cell-${conflicts.length}`,
        kind: "cell",
        rowIndex,
        columnIndex: Array.from(displayRow.cells).indexOf(displayCell),
        oursHtml: String(conflict.lvalue ?? ""),
        theirsHtml: String(conflict.rvalue ?? ""),
      });
    }
  }

  if (!displayRows.length) return null;
  table.tBodies[0].replaceChildren(...displayRows);
  for (const [columnIndex, column] of columns.entries()) {
    if (!column.conflict) continue;
    conflicts.push({
      id: `column-${conflicts.length}`,
      kind: "column",
      columnIndex,
      oursExists: column.oursIndex != null,
      theirsExists: column.theirsIndex != null,
      oursCellsHtml: displaySources.map(({ oursRowIndex }) =>
        cellOuterHtml(oursTable, oursRowIndex, column.oursIndex)
      ),
      theirsCellsHtml: displaySources.map(({ theirsRowIndex }) =>
        cellOuterHtml(theirsTable, theirsRowIndex, column.theirsIndex)
      ),
    });
  }
  const oursColgroup = table.querySelector(":scope > colgroup");
  const theirsParsed = new DOMParser().parseFromString(theirsHtml, "text/html");
  const theirsColgroup = theirsParsed.querySelector("table > colgroup");
  if (oursColgroup || theirsColgroup) {
    const colgroup = oursColgroup || parsed.createElement("colgroup");
    const oursCols = oursColgroup ? Array.from(oursColgroup.children) : [];
    const theirsCols = theirsColgroup
      ? Array.from(theirsColgroup.children)
      : [];
    colgroup.replaceChildren(
      ...columns.map((column) => {
        const source =
          oursCols[column.oursIndex] || theirsCols[column.theirsIndex];
        return source
          ? parsed.importNode(source, true)
          : parsed.createElement("col");
      })
    );
    if (!oursColgroup) table.prepend(colgroup);
  }
  if (conflicts.length) {
    table.setAttribute(
      "data-kindred-table-conflicts",
      JSON.stringify({
        currentLabel: oursLabel,
        dirtyLabel: theirsLabel,
        conflicts,
      })
    );
  } else {
    table.removeAttribute("data-kindred-table-conflicts");
  }
  return {
    html: table.outerHTML,
    conflictCount: conflicts.length,
  };
}

function tableCellFromHtml(ownerDocument, html) {
  const parsed = new DOMParser().parseFromString(
    `<table><tbody><tr>${html}</tr></tbody></table>`,
    "text/html"
  );
  const cell = parsed.querySelector("td, th");
  return cell ? ownerDocument.importNode(cell, true) : null;
}

function rowWithoutColumn(html, columnIndex) {
  if (!html) return "";
  const parsed = new DOMParser().parseFromString(
    `<table><tbody>${html}</tbody></table>`,
    "text/html"
  );
  const row = parsed.querySelector("tr");
  row?.cells[columnIndex]?.remove();
  return row?.outerHTML || html;
}

function applyTableConflict(table, data, conflict, side) {
  const chosenHtml =
    side === "theirs" ? conflict.theirsHtml : conflict.oursHtml;
  if (conflict.kind === "column") {
    const exists =
      side === "theirs" ? conflict.theirsExists : conflict.oursExists;
    const chosenCells =
      side === "theirs"
        ? conflict.theirsCellsHtml
        : conflict.oursCellsHtml;
    if (exists) {
      Array.from(table.rows).forEach((row, rowIndex) => {
        const chosenCell = tableCellFromHtml(
          table.ownerDocument,
          chosenCells[rowIndex]
        );
        if (chosenCell && row.cells[conflict.columnIndex]) {
          row.cells[conflict.columnIndex].replaceWith(chosenCell);
        }
      });
      return;
    }

    Array.from(table.rows).forEach((row) => {
      row.cells[conflict.columnIndex]?.remove();
    });
    const colgroup = table.querySelector(":scope > colgroup");
    colgroup?.children[conflict.columnIndex]?.remove();
    for (const remaining of data.conflicts) {
      if (remaining.id === conflict.id) continue;
      if (
        (remaining.kind === "cell" || remaining.kind === "column") &&
        remaining.columnIndex > conflict.columnIndex
      ) {
        remaining.columnIndex -= 1;
      }
      if (remaining.kind === "row") {
        remaining.oursHtml = rowWithoutColumn(
          remaining.oursHtml,
          conflict.columnIndex
        );
        remaining.theirsHtml = rowWithoutColumn(
          remaining.theirsHtml,
          conflict.columnIndex
        );
      }
    }
    return;
  }
  if (conflict.kind === "cell") {
    const row = table.rows[conflict.rowIndex];
    const cell = row?.cells[conflict.columnIndex];
    if (cell) cell.innerHTML = chosenHtml;
    return;
  }
  if (conflict.kind !== "row") return;
  const row = table.rows[conflict.rowIndex];
  if (!row) return;
  if (chosenHtml) {
    const parsed = new DOMParser().parseFromString(
      `<table><tbody>${chosenHtml}</tbody></table>`,
      "text/html"
    );
    const chosenRow = parsed.querySelector("tr");
    if (chosenRow) row.replaceWith(table.ownerDocument.importNode(chosenRow, true));
    return;
  }

  row.remove();
  for (const remaining of data.conflicts) {
    if (remaining.kind === "column") {
      remaining.oursCellsHtml.splice(conflict.rowIndex, 1);
      remaining.theirsCellsHtml.splice(conflict.rowIndex, 1);
    }
    if (
      remaining.id !== conflict.id &&
      remaining.rowIndex > conflict.rowIndex
    ) {
      remaining.rowIndex -= 1;
    }
  }
}

export function resolveTableConflictHtml(tableHtml, conflictId, side) {
  const parsed = new DOMParser().parseFromString(tableHtml, "text/html");
  const table = parsed.querySelector("table");
  if (!table) return tableHtml;
  const data = parseTableConflicts(
    table.getAttribute("data-kindred-table-conflicts")
  );
  if (!data) return tableHtml;
  const conflict = data.conflicts.find((item) => item.id === conflictId);
  if (!conflict) return tableHtml;

  applyTableConflict(table, data, conflict, side);
  data.conflicts = data.conflicts.filter((item) => item.id !== conflictId);
  if (data.conflicts.length) {
    table.setAttribute("data-kindred-table-conflicts", JSON.stringify(data));
  } else {
    table.removeAttribute("data-kindred-table-conflicts");
  }
  return table.outerHTML;
}

export function resolveAllTableConflicts(html, side) {
  const parsed = new DOMParser().parseFromString(
    `<div id="__kindred_table_root">${html || ""}</div>`,
    "text/html"
  );
  const root = parsed.getElementById("__kindred_table_root");
  if (!root) return html || "";
  root.querySelectorAll("table[data-kindred-table-conflicts]").forEach((table) => {
    const data = parseTableConflicts(
      table.getAttribute("data-kindred-table-conflicts")
    );
    if (!data) return;
    for (const conflict of data.conflicts) {
      applyTableConflict(table, data, conflict, side);
    }
    table.removeAttribute("data-kindred-table-conflicts");
  });
  return root.innerHTML;
}

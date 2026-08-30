import { debugEvent, debugVerbose } from './debug.js'

const SUPPORTED_TEXT_STYLE_FIELDS = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
])

function operationCounts(requests) {
  return requests.reduce((counts, request) => {
    const operation = Object.keys(request || {})[0] || 'unknown'
    counts[operation] = (counts[operation] || 0) + 1
    return counts
  }, {})
}

function tableSummary(table) {
  const rows = tableRows(table)
  const columns = rows[0] ? tableCells(rows[0]).length : 0
  const summary = {
    startIndex: Number.isInteger(table?.startIndex) ? table.startIndex : null,
    endIndex: Number.isInteger(table?.endIndex) ? table.endIndex : null,
    rows: rows.length,
    columns,
  }
  debugVerbose('gdocs-planner', 'table-detail', {
    ...summary,
    cells: rows.map((row) => tableCells(row).map((cell) => ({
      shape: cellShape(cell?.tiptap || cell),
      contentLength: nodeText(cell?.tiptap || cell).length,
      attrs: normalizedAttrs((cell?.tiptap || cell)?.attrs) || null,
    }))),
  })
  return summary
}

function topologySummary(documentOrDoc) {
  const elements = Array.isArray(documentOrDoc?.elements)
    ? documentOrDoc.elements
    : topLevelNodes(documentOrDoc)
  return {
    elementCount: elements.length,
    kinds: elements.map((element) => element.kind || element.type?.name || null),
    indexedRanges: elements.map((element) => ({
      startIndex: Number.isInteger(element.startIndex) ? element.startIndex : null,
      endIndex: Number.isInteger(element.endIndex) ? element.endIndex : null,
    })),
    tableCount: elements.filter((element) => element.kind === 'table' || element.type?.name === 'table').length,
  }
}

function plannerError(message, details = {}) {
  debugEvent('gdocs-planner', 'rejected', { reason: message, ...details })
  return new Error(message)
}

function plannerResult(classification, requests, details = {}) {
  debugEvent('gdocs-planner', 'classification', {
    classification,
    requestCount: requests.length,
    operationCounts: operationCounts(requests),
    ...details,
  })
  return { classification, requests }
}

function requestPlan(requests, classification, details = {}) {
  debugEvent('gdocs-planner', 'request-plan', {
    classification,
    requestCount: requests.length,
    operationCounts: operationCounts(requests),
    ...details,
  })
  return requests
}

function plannerMismatchError(message, {
  stage,
  baseDocument,
  localDoc,
  insertionIntents = [],
  matchedIndexes = [],
  location,
  reason,
}) {
  debugEvent('gdocs-planner', 'mismatch', {
    stage,
    baseTopology: topologySummary(baseDocument),
    localTopology: topologySummary(localDoc),
    insertionIntents: insertionIntents.map(summarizeIntent),
    matchedIndexes: [...matchedIndexes],
    mismatch: { location, reason },
  })
  return new Error(message)
}

function summarizeIntent(intent) {
  return {
    axis: intent?.axis || null,
    action: intent?.action || null,
    tableOrdinal: Number.isInteger(intent?.tableOrdinal) ? intent.tableOrdinal : null,
    index: Number.isInteger(intent?.index) ? intent.index : null,
    anchor: intent?.anchor ? {
      baseElementIndex: intent.anchor.baseElementIndex,
      offset: intent.anchor.offset,
      index: intent.anchor.index,
    } : null,
    dimensions: intent?.dimensions || null,
  }
}

function baseParagraphIndexForGoogleIndex(baseDocument, googleIndex) {
  if (!Number.isInteger(googleIndex)) return -1
  const elements = baseDocument?.elements || []
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (element.kind !== 'paragraph' ||
      !Number.isInteger(element.startIndex) ||
      !Number.isInteger(element.endIndex) ||
      googleIndex < element.startIndex ||
      googleIndex >= element.endIndex) continue
    return index
  }
  return -1
}

export function relaxedParagraphIndexesFromLegacyRequests(baseDocument, legacyRequests = []) {
  const indexes = new Set()
  for (const request of legacyRequests) {
    const range = request.deleteContentRange?.range
    if (range) {
      const index = baseParagraphIndexForGoogleIndex(baseDocument, range.startIndex)
      if (index >= 0) indexes.add(index)
    }
    const location = request.insertText?.location?.index
    if (Number.isInteger(location)) {
      const index = baseParagraphIndexForGoogleIndex(baseDocument, location)
      if (index >= 0) indexes.add(index)
    }
  }
  return indexes
}

export function legacyRequestsAreTopLevelParagraphEdits(baseDocument, legacyRequests = []) {
  if (!legacyRequests.length) return false
  const elements = baseDocument?.elements || []
  for (const request of legacyRequests) {
    const googleIndexes = []
    const range = request.deleteContentRange?.range
    if (range) googleIndexes.push(range.startIndex, range.endIndex)
    const location = request.insertText?.location?.index
    if (Number.isInteger(location)) googleIndexes.push(location)
    for (const googleIndex of googleIndexes) {
      const paragraph = elements.find((element) => (
        element.kind === 'paragraph' &&
        Number.isInteger(element.startIndex) &&
        Number.isInteger(element.endIndex) &&
        googleIndex >= element.startIndex &&
        googleIndex < element.endIndex
      ))
      if (!paragraph) return false
    }
  }
  return true
}

export function tableInsertionIntentsOnly(structuralIntents = []) {
  return structuralIntents.length > 0 && structuralIntents.every((intent) => (
    intent.axis === 'table' && intent.action === 'insert'
  ))
}

function googleRequestSortIndex(request) {
  const operation = Object.keys(request || {})[0]
  const payload = request?.[operation]
  if (payload?.range?.startIndex != null) return payload.range.startIndex
  if (payload?.location?.index != null) return payload.location.index
  if (payload?.tableCellLocation?.tableStartLocation?.index != null) {
    return payload.tableCellLocation.tableStartLocation.index
  }
  return 0
}

export function sortGoogleDocsRequestsDescending(requests = []) {
  return [...requests].sort((left, right) => (
    googleRequestSortIndex(right) - googleRequestSortIndex(left)
  ))
}

export function survivingParagraphTextRequests(baseDocument, localDoc, structuralIntents = []) {
  const requests = []
  const baseElements = baseDocument?.elements || []
  const baseParagraphs = baseElements.filter((element) => element.kind === 'paragraph')
  const localParagraphs = topLevelNodes(localDoc).filter((node) => (
    node.type.name === 'paragraph'
  ))
  let localIndex = 0
  for (const baseElement of baseParagraphs) {
    const baseText = nodeText(baseElement.tiptap)
    let combined = ''
    while (localIndex < localParagraphs.length && combined.length < baseText.length) {
      combined += localParagraphs[localIndex].textContent || ''
      localIndex += 1
    }
    if (combined === baseText) continue
    if (combined.startsWith(baseText) && combined.length > baseText.length) {
      requests.push({
        insertText: {
          location: { index: baseElement.endIndex - 1 },
          text: combined.slice(baseText.length),
        },
      })
      continue
    }
    if (baseText.startsWith(combined)) continue
    if (!Number.isInteger(baseElement.startIndex) || !Number.isInteger(baseElement.endIndex)) {
      throw plannerError('table insertion structure changed', { stage: 'surviving-paragraph-index' })
    }
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: baseElement.startIndex,
          endIndex: baseElement.endIndex - 1,
        },
      },
    })
    requests.push({
      insertText: {
        location: { index: baseElement.startIndex },
        text: combined,
      },
    })
  }
  if (localIndex < localParagraphs.length) {
    debugEvent('gdocs-planner', 'surviving-paragraph-tail', {
      intentCount: structuralIntents.length,
      remainingParagraphs: localParagraphs.length - localIndex,
    })
  }
  return requests
}

export function relaxedSurvivingParagraphIndexes(baseDocument, localDoc) {
  const indexes = new Set()
  const baseElements = baseDocument?.elements || []
  const baseParagraphs = baseElements.filter((element) => element.kind === 'paragraph')
  const localParagraphs = topLevelNodes(localDoc).filter((node) => (
    node.type.name === 'paragraph'
  ))
  let localIndex = 0
  for (const baseElement of baseParagraphs) {
    const baseText = nodeText(baseElement.tiptap)
    let combined = ''
    while (localIndex < localParagraphs.length && combined.length < baseText.length) {
      combined += localParagraphs[localIndex].textContent || ''
      localIndex += 1
    }
    if (combined !== baseText) {
      indexes.add(baseElements.indexOf(baseElement))
    }
  }
  return indexes
}

export function transactionOnlyTouchesTopLevelParagraphs(transaction) {
  if (!transaction?.docChanged) return false
  let currentDoc = transaction.before
  for (const step of transaction.steps || []) {
    if (positionIsInsideTable(currentDoc, step.from) ||
      positionIsInsideTable(currentDoc, step.to)) {
      return false
    }
    const result = step.apply(currentDoc)
    currentDoc = result.doc || currentDoc
  }
  return true
}

function pmPosToDocsIndex(doc, pos) {
  if (!doc || pos <= 1) return 1
  const clamped = Math.min(pos, doc.content.size)
  const textBefore = doc.textBetween(0, clamped, '\n')
  return 1 + textBefore.length
}

function textStyleForMark(mark) {
  const markName = mark.type?.name || mark.type || mark
  const field = markName === 'strike' ? 'strikethrough' : markName
  if (markName === 'textStyle') {
    const foregroundColor = googleRgbColor(mark.attrs?.color)
    const fontSize = googleFontSize(mark.attrs?.fontSize)
    const weightedFontFamily = googleFontFamily(mark.attrs?.fontFamily)
    const textStyle = {
      ...(foregroundColor ? { foregroundColor } : {}),
      ...(fontSize ? { fontSize } : {}),
      ...(weightedFontFamily ? { weightedFontFamily } : {}),
    }
    const fields = Object.keys(textStyle)
    return fields.length ? { fields, textStyle } : null
  }
  if (markName === 'highlight') {
    const backgroundColor = googleRgbColor(mark.attrs?.color)
    return backgroundColor
      ? { fields: ['backgroundColor'], textStyle: { backgroundColor } }
      : null
  }
  if (markName === 'link' && mark.attrs?.href) {
    return { fields: ['link'], textStyle: { link: { url: mark.attrs.href } } }
  }
  if (!SUPPORTED_TEXT_STYLE_FIELDS.has(field)) return null
  return { fields: [field], textStyle: { [field]: true } }
}

function googleFontSize(fontSize) {
  const match = String(fontSize || '').trim().match(/^(\d+(?:\.\d+)?)px$/)
  if (!match) return null
  return { magnitude: Number(match[1]) * 0.75, unit: 'PT' }
}

function googleFontFamily(fontFamily) {
  const name = String(fontFamily || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '')
  return name ? { fontFamily: name } : null
}

function googleParagraphAlignment(textAlign) {
  return {
    center: 'CENTER',
    right: 'END',
    justify: 'JUSTIFIED',
    left: 'START',
  }[textAlign] || null
}

const LIST_PRESETS = {
  bulletList: 'BULLET_DISC_CIRCLE_SQUARE',
  orderedList: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
}

function listParagraphs(doc) {
  const paragraphs = []

  function visit(node, startPos, listContext = null, rootListPos = null) {
    node.forEach((child, offset) => {
      const childPos = startPos + 1 + offset
      const type = child.type?.name

      if (type === 'bulletList' || type === 'orderedList') {
        visit(child, childPos, {
          type,
          depth: listContext ? listContext.depth + 1 : 0,
        }, rootListPos ?? childPos)
        return
      }

      if (type === 'paragraph' && listContext) {
        paragraphs.push({
          depth: listContext.depth,
          listType: listContext.type,
          node: child,
          pos: childPos,
          rootListPos,
        })
        return
      }

      visit(child, childPos, listContext, rootListPos)
    })
  }

  visit(doc, -1)
  return paragraphs
}

function pmParagraphStartToDocsIndex(doc, pos) {
  const textBefore = doc.textBetween(0, pos, '\n')
  const needsSeparator = Boolean(textBefore && !textBefore.endsWith('\n'))
  return 1 + textBefore.length + (needsSeparator ? 1 : 0)
}

function paragraphEndToDocsIndex(doc, paragraph) {
  return pmParagraphStartToDocsIndex(doc, paragraph.pos) + paragraph.node.textContent.length + 1
}

function clearListIndentStyle(range) {
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: {
        indentStart: { magnitude: 0, unit: 'PT' },
        indentFirstLine: { magnitude: 0, unit: 'PT' },
      },
      fields: 'indentStart,indentFirstLine',
    },
  }
}

export function listNestingRequests(doc, nextDoc) {
  const before = listParagraphs(doc)
  const after = listParagraphs(nextDoc)
  if (before.length !== after.length) return []

  const changed = after
    .map((paragraph, index) => ({ paragraph, previous: before[index] }))
    .filter(({ paragraph, previous }) => (
      previous &&
      paragraph.listType === previous.listType &&
      paragraph.depth !== previous.depth
    ))
  if (!changed.length) return []

  const roots = [...new Set(changed.map(({ paragraph }) => paragraph.rootListPos))]
  const requests = []

  for (const rootListPos of roots) {
    const rootIndices = before
      .map((paragraph, index) => ({ paragraph, index }))
      .filter(({ paragraph }) => paragraph.rootListPos === rootListPos)
      .map(({ index }) => index)
    const rootBefore = rootIndices.map((index) => before[index])
    const rootAfter = rootIndices.map((index) => after[index])
    const firstIndex = rootIndices[0]
    const lastIndex = rootIndices.at(-1)
    const first = rootBefore[0]
    const last = rootBefore.at(-1)
    const listRange = {
      startIndex: pmParagraphStartToDocsIndex(doc, first.pos),
      endIndex: paragraphEndToDocsIndex(doc, last),
    }

    requests.push({ deleteParagraphBullets: { range: listRange } })
    requests.push(clearListIndentStyle(listRange))

    const tabEdits = rootAfter
      .flatMap((paragraph, rootIndex) => {
        if (paragraph.depth === 0) return []
        const paragraphIndex = rootIndices[rootIndex]
        const startIndex = pmParagraphStartToDocsIndex(doc, before[paragraphIndex].pos)
        return [{ startIndex, text: '\t'.repeat(paragraph.depth) }]
      })
      .sort((left, right) => right.startIndex - left.startIndex)

    for (const edit of tabEdits) {
      requests.push({
        insertText: { location: { index: edit.startIndex }, text: edit.text },
      })
    }

    const offsetAt = (index, includeAtIndex) => tabEdits.reduce(
      (offset, edit) => (
        edit.startIndex < index || (includeAtIndex && edit.startIndex === index)
          ? offset + edit.text.length
          : offset
      ),
      0,
    )

    const strippedRange = listRange

    requests.push({
      createParagraphBullets: {
        range: {
          startIndex: strippedRange.startIndex + offsetAt(strippedRange.startIndex, false),
          endIndex: strippedRange.endIndex + offsetAt(strippedRange.endIndex, false),
        },
        bulletPreset: LIST_PRESETS[first.listType],
      },
    })
  }

  return requests
}

function googleRgbColor(color) {
  const value = String(color || '').trim()
  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}(?:[0-9a-f]{2})?)$/i)
  const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  const channels = hex
    ? (hex[1].length <= 4
      ? [...hex[1].slice(0, 3)].map((channel) => parseInt(channel + channel, 16))
      : [0, 2, 4].map((start) => parseInt(hex[1].slice(start, start + 2), 16)))
    : rgb
      ? rgb.slice(1, 4).map(Number)
      : null
  if (!channels || channels.some((channel) => channel < 0 || channel > 255)) return null
  return {
    color: {
      rgbColor: {
        red: channels[0] / 255,
        green: channels[1] / 255,
        blue: channels[2] / 255,
      },
    },
  }
}

function insertedTextStyleRequests(doc, from, to) {
  const requests = []

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return

    const markedFields = new Set(
      node.marks.map(textStyleForMark).filter(Boolean).flatMap(({ fields }) => fields),
    )
    const textStyle = Object.fromEntries(
      [...SUPPORTED_TEXT_STYLE_FIELDS].map((field) => [field, markedFields.has(field)]),
    )
    const colorMark = node.marks.find((mark) => mark.type?.name === 'textStyle')
    const foregroundColor = googleRgbColor(colorMark?.attrs?.color)
    if (foregroundColor) textStyle.foregroundColor = foregroundColor
    const highlightMark = node.marks.find((mark) => mark.type?.name === 'highlight')
    const backgroundColor = googleRgbColor(highlightMark?.attrs?.color)
    if (backgroundColor) textStyle.backgroundColor = backgroundColor
    const fontSize = googleFontSize(colorMark?.attrs?.fontSize)
    if (fontSize) textStyle.fontSize = fontSize
    const weightedFontFamily = googleFontFamily(colorMark?.attrs?.fontFamily)
    if (weightedFontFamily) textStyle.weightedFontFamily = weightedFontFamily
    const linkMark = node.marks.find((mark) => mark.type?.name === 'link')
    if (linkMark?.attrs?.href) textStyle.link = { url: linkMark.attrs.href }
    const fields = [
      ...SUPPORTED_TEXT_STYLE_FIELDS,
      'foregroundColor',
      'backgroundColor',
      'fontSize',
      'weightedFontFamily',
      'link',
    ]

    requests.push({
      updateTextStyle: {
        range: {
          startIndex: pmPosToDocsIndex(doc, pos),
          endIndex: pmPosToDocsIndex(doc, pos + node.nodeSize),
        },
        textStyle,
        fields: fields.join(','),
      },
    })
  })

  return requests
}

function childNodes(node) {
  const content = Array.isArray(node?.content) ? node.content : node
  if (Array.isArray(content)) return content
  const children = []
  content?.forEach?.((child) => children.push(child))
  return children
}

function nodeText(node) {
  if (!node) return ''
  if (typeof node.textContent === 'string') return node.textContent
  if ((node.type?.name || node.type) === 'text') return String(node.text || '')
  return childNodes(node).map(nodeText).join('')
}

function cellText(cell) {
  return childNodes(cell).map(nodeText).join('\n')
}

function serializeCellParagraphs(cell) {
  const paragraphs = childNodes(cell)
  if (!paragraphs.length || paragraphs.some((paragraph) => (
    (paragraph?.type?.name || paragraph?.type) !== 'paragraph'
  ))) return null
  for (const paragraph of paragraphs) {
    if (childNodes(paragraph).some((node) => (
      (node?.type?.name || node?.type) !== 'text' ||
      (node.marks || []).some((mark) => !textStyleForMark(mark))
    ))) return null
  }
  return paragraphs.map(nodeText).join('\n')
}

function cellShape(node) {
  const attrs = node?.attrs || {}
  return [
    node?.type?.name || node?.type || null,
    Number(attrs.colspan) || 1,
    Number(attrs.rowspan) || 1,
  ].join(':')
}

function normalizedAttrs(attrs) {
  const meaningful = Object.entries(attrs || {}).filter(([key, value]) => (
    value !== null &&
    value !== undefined &&
    key !== 'colwidth' &&
    !(key === 'textAlign' && value === 'left') &&
    !((key === 'colspan' || key === 'rowspan') && value === 1)
  ))
  if (!meaningful.length) return undefined
  return Object.fromEntries(meaningful.sort(([left], [right]) => left.localeCompare(right)))
}

function normalizedTipTapNode(node) {
  const normalized = { type: node?.type?.name || node?.type }
  const attrs = normalizedAttrs(node?.attrs)
  if (attrs) normalized.attrs = attrs
  if (typeof node?.text === 'string') normalized.text = node.text
  const marks = node?.marks?.map((mark) => ({
    type: mark.type?.name || mark.type,
    ...(normalizedAttrs(mark.attrs) ? { attrs: normalizedAttrs(mark.attrs) } : {}),
  }))
  if (marks?.length) normalized.marks = marks
  const content = childNodes(node).map(normalizedTipTapNode)
  if (content.length) normalized.content = content
  return normalized
}

function contentShapeNode(node) {
  const type = node?.type?.name || node?.type
  const normalized = { type }
  const attrs = normalizedAttrs(node?.attrs)
  if (attrs) normalized.attrs = attrs
  const marks = node?.marks?.map((mark) => ({
    type: mark.type?.name || mark.type,
    ...(normalizedAttrs(mark.attrs) ? { attrs: normalizedAttrs(mark.attrs) } : {}),
  }))
  if (type === 'text') return marks?.length ? { type, marks } : null
  if (marks?.length) normalized.marks = marks
  const content = childNodes(node).map(contentShapeNode).filter(Boolean)
  if (content.length) normalized.content = content
  return normalized
}

function cellContentShape(cell) {
  return childNodes(cell).map(contentShapeNode)
}

function contentStructureShapeNode(node) {
  const type = node?.type?.name || node?.type
  const normalized = { type }
  const attrs = normalizedAttrs(node?.attrs)
  if (attrs) normalized.attrs = attrs
  if (type === 'text') return normalized
  const content = childNodes(node).map(contentStructureShapeNode)
  if (content.length) normalized.content = content
  return normalized
}

function cellContentStructureShape(cell) {
  return childNodes(cell).map(contentStructureShapeNode)
}

function collectTextRuns(node, startIndex, runs) {
  if ((node?.type?.name || node?.type) === 'text') {
    const text = String(node.text || '')
    runs.push({ node, startIndex, endIndex: startIndex + text.length })
    return
  }
  let childIndex = startIndex
  for (const child of childNodes(node)) {
    collectTextRuns(child, childIndex, runs)
    childIndex += nodeText(child).length
  }
}

function collectCellTextRuns(cell, startIndex, runs) {
  let childIndex = startIndex
  const paragraphs = childNodes(cell)
  paragraphs.forEach((paragraph, paragraphIndex) => {
    collectTextRuns(paragraph, childIndex, runs)
    childIndex += nodeText(paragraph).length
    if (paragraphIndex < paragraphs.length - 1) childIndex += 1
  })
}

function hasTextMarks(node) {
  if ((node?.type?.name || node?.type) === 'text') return Boolean(node.marks?.length)
  return childNodes(node).some(hasTextMarks)
}

function supportedMarkStyles(node) {
  const styles = {}
  for (const mark of node?.marks || []) {
    const mapped = textStyleForMark(mark)
    if (!mapped || mapped.fields.some((field) => !SUPPORTED_TEXT_STYLE_FIELDS.has(field))) {
      return null
    }
    Object.assign(styles, mapped.textStyle)
  }
  return styles
}

function markOnlyTextStyleRequests(baseCell, localCell) {
  const baseNode = baseCell?.tiptap || baseCell
  if (cellText(baseNode) !== cellText(localCell) ||
    JSON.stringify(cellContentStructureShape(baseNode)) !==
    JSON.stringify(cellContentStructureShape(localCell))) return null

  const baseRuns = []
  for (const content of baseCell?.content || []) {
    collectTextRuns(content?.tiptap || content, content.startIndex, baseRuns)
  }
  const localRuns = []
  collectTextRuns(localCell, 0, localRuns)
  if (baseRuns.length !== localRuns.length) return null

  const requests = []
  for (let runIndex = 0; runIndex < baseRuns.length; runIndex += 1) {
    const baseRun = baseRuns[runIndex]
    const localRun = localRuns[runIndex]
    if (nodeText(baseRun.node) !== nodeText(localRun.node)) return null
    const baseStyles = supportedMarkStyles(baseRun.node)
    const localStyles = supportedMarkStyles(localRun.node)
    if (!baseStyles || !localStyles) return null
    const fields = [...new Set([...Object.keys(baseStyles), ...Object.keys(localStyles)])]
      .filter((field) => baseStyles[field] !== localStyles[field])
    if (!fields.length) continue
    requests.push({
      updateTextStyle: {
        range: { startIndex: baseRun.startIndex, endIndex: baseRun.endIndex },
        textStyle: Object.fromEntries(fields.map((field) => [
          field,
          localStyles[field] ?? false,
        ])),
        fields: fields.join(','),
      },
    })
  }
  return requests.length ? requests : null
}

function insertedCellTextStyleRequests(localCell, startIndex) {
  const runs = []
  collectCellTextRuns(localCell, startIndex, runs)
  const fields = [
    ...SUPPORTED_TEXT_STYLE_FIELDS,
    'foregroundColor',
    'backgroundColor',
    'fontSize',
    'weightedFontFamily',
    'link',
  ]
  const requests = []
  for (const run of runs) {
    const styles = {}
    for (const mark of run.node.marks || []) {
      const mapped = textStyleForMark(mark)
      if (!mapped) return null
      Object.assign(styles, mapped.textStyle)
    }
    const textStyle = Object.fromEntries(
      [...SUPPORTED_TEXT_STYLE_FIELDS].map((field) => [field, Boolean(styles[field])]),
    )
    for (const field of fields) {
      if (!SUPPORTED_TEXT_STYLE_FIELDS.has(field) && styles[field] !== undefined) {
        textStyle[field] = styles[field]
      }
    }
    requests.push({
      updateTextStyle: {
        range: { startIndex: run.startIndex, endIndex: run.endIndex },
        textStyle,
        fields: fields.join(','),
      },
    })
  }
  return requests
}

function tableRows(table) {
  if (Array.isArray(table?.rows)) return table.rows
  return childNodes(table)
}

function tableCells(row) {
  if (Array.isArray(row?.cells)) return row.cells
  return childNodes(row)
}

function rowsMatch(baseRow, localRow) {
  const baseCells = tableCells(baseRow)
  const localCells = tableCells(localRow)
  if (baseCells.length !== localCells.length) return false
  return baseCells.every((baseCell, cellIndex) => {
    const localCell = localCells[cellIndex]
    return cellShape(baseCell?.tiptap || baseCell) === cellShape(localCell) &&
      JSON.stringify(cellContentShape(baseCell?.tiptap || baseCell)) ===
        JSON.stringify(cellContentShape(localCell)) &&
      cellText(baseCell?.tiptap || baseCell) === cellText(localCell)
  })
}

function topLevelTables(doc) {
  const tables = []
  doc?.forEach?.((node) => {
    if (node.type.name === 'table') tables.push(node)
  })
  return tables
}

function tablesDiffer(baseDocument, localDoc) {
  const baseTables = baseDocument?.elements?.filter((element) => element.kind === 'table') || []
  const localTables = topLevelTables(localDoc)
  if (baseTables.length !== localTables.length) return true
  return baseTables.some((baseTable, tableIndex) => (
    JSON.stringify(normalizedTipTapNode(baseTable.tiptap)) !==
    JSON.stringify(normalizedTipTapNode(localTables[tableIndex]))
  ))
}

function positionIsInsideTable(doc, position) {
  if (!Number.isFinite(position)) return false
  const resolvedPosition = doc.resolve(Math.min(position, doc.content.size))
  for (let depth = resolvedPosition.depth; depth >= 0; depth -= 1) {
    if (resolvedPosition.node(depth).type.name === 'table') return true
  }
  return false
}

function tableContextAt(doc, position) {
  if (!doc || !Number.isFinite(position)) return null
  const resolved = doc.resolve(Math.min(Math.max(position, 0), doc.content.size))
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    if (resolved.node(depth).type.name !== 'table') continue
    const table = resolved.node(depth)
    let tableOrdinal = -1
    let tableCount = 0
    doc.forEach((node) => {
      if (node.type.name !== 'table') return
      if (node === table) tableOrdinal = tableCount
      tableCount += 1
    })
    if (tableOrdinal < 0) return null
    return { resolved, tableDepth: depth, tableOrdinal }
  }
  return null
}

function structuralIntentForStep(doc, step) {
  if (step?.toJSON?.().stepType !== 'replace' ||
    (step.from === step.to && !step.slice?.content?.childCount)) {
    return null
  }
  const from = tableContextAt(doc, step.from)
  if (!from) return null
  const sliceNode = step.slice.content.firstChild
  const fromResolved = from.resolved
  const tableDepth = from.tableDepth
  if (step.from === step.to && sliceNode.type.name === 'tableRow' &&
    fromResolved.depth === tableDepth) {
    return {
      tableOrdinal: from.tableOrdinal,
      axis: 'row',
      action: 'insert',
      index: fromResolved.index(tableDepth),
    }
  }
  if (step.from === step.to && sliceNode.type.name === 'tableCell' &&
    fromResolved.depth === tableDepth + 1 &&
    fromResolved.parent.type.name === 'tableRow') {
    return {
      tableOrdinal: from.tableOrdinal,
      axis: 'column',
      action: 'insert',
      index: fromResolved.index(tableDepth + 1),
    }
  }
  if (step.from >= step.to) return null
  const to = tableContextAt(doc, step.to)
  if (!to || to.tableOrdinal !== from.tableOrdinal) return null
  const toResolved = to.resolved
  if (fromResolved.depth === tableDepth && toResolved.depth === tableDepth &&
    toResolved.index(tableDepth) === fromResolved.index(tableDepth) + 1) {
    return {
      tableOrdinal: from.tableOrdinal,
      axis: 'row',
      action: 'delete',
      index: fromResolved.index(tableDepth),
    }
  }
  if (fromResolved.depth === tableDepth + 1 && toResolved.depth === tableDepth + 1 &&
    fromResolved.parent.type.name === 'tableRow' &&
    toResolved.parent.type.name === 'tableRow' &&
    toResolved.index(tableDepth + 1) === fromResolved.index(tableDepth + 1) + 1) {
    return {
      tableOrdinal: from.tableOrdinal,
      axis: 'column',
      action: 'delete',
      index: fromResolved.index(tableDepth + 1),
    }
  }
  return null
}

function topLevelNodes(doc) {
  const nodes = []
  doc?.forEach?.((node) => nodes.push(node))
  return nodes
}

function topLevelNodeAtPosition(doc, position) {
  let found = null
  let last = null
  let start = 0
  for (const node of topLevelNodes(doc)) {
    const end = start + node.nodeSize
    last = { node, start, end }
    if (position >= start && position <= end) {
      found = { node, start, end }
      break
    }
    start = end
  }
  return found || last
}

function topLevelTableNodes(doc) {
  return topLevelNodes(doc).filter((node) => node.type.name === 'table')
}

function insertedTopLevelTables(beforeDoc, afterDoc, step) {
  const sliceTables = []
  step?.slice?.content?.descendants?.((node) => {
    if (node.type.name === 'table') sliceTables.push(node)
  })
  if (!sliceTables.length) return []
  const source = topLevelNodeAtPosition(beforeDoc, step.from)
  const sourceIndex = source ? topLevelNodes(beforeDoc).indexOf(source.node) : 0
  return topLevelNodes(afterDoc)
    .map((node, index) => ({ node, index }))
    .filter(({ node, index }) => node.type.name === 'table' && index >= sourceIndex)
    .slice(0, sliceTables.length)
}

function baseElementIndexForNode(doc, node, baseDocument, pendingIntents = []) {
  const baseElements = baseDocument?.elements || []
  const exactMatches = baseElements.flatMap((element, index) => {
    if (!element.tiptap || element.kind !== (node.type.name === 'table' ? 'table' : 'paragraph')) {
      return []
    }
    return JSON.stringify(normalizedTipTapNode(element.tiptap)) ===
      JSON.stringify(normalizedTipTapNode(node)) ? [index] : []
  })
  if (exactMatches.length === 1) return exactMatches[0]

  const nodes = topLevelNodes(doc)
  const nodeIndex = nodes.indexOf(node)
  const adjacentIntent = pendingIntents.find((intent) => {
    if (intent.axis !== 'table' || intent.action !== 'insert') return false
    if (intent.localTable && !nodes.includes(intent.localTable)) return false
    const tableIndex = intent.localTable ? nodes.indexOf(intent.localTable) : -1
    return tableIndex === nodeIndex - 1 || tableIndex === nodeIndex + 1
  })
  if (adjacentIntent) return adjacentIntent.anchor.baseElementIndex

  let nonPendingIndex = 0
  for (const currentNode of nodes) {
    const isPendingTable = pendingIntents.some((intent) => (
      intent.localTable === currentNode
    ))
    if (currentNode === node) return nonPendingIndex
    if (!isPendingTable) nonPendingIndex += 1
  }
  return -1
}

function tableDimensions(table) {
  const rows = tableRows(table)
  const columns = rows[0] ? tableCells(rows[0]).length : 0
  if (!Number.isInteger(rows.length) || rows.length < 1 ||
    !Number.isInteger(columns) || columns < 1 ||
    rows.some((row) => tableCells(row).length !== columns)) return null
  return { rows: rows.length, columns }
}

function paragraphMarkSignature(mark) {
  return JSON.stringify({
    type: mark?.type?.name || mark?.type,
    attrs: normalizedAttrs(mark?.attrs),
  })
}

function paragraphRuns(paragraph) {
  const runs = []
  const visit = (node) => {
    if ((node?.type?.name || node?.type) === 'text') {
      runs.push({
        text: String(node.text || ''),
        marks: (node.marks || []).map(paragraphMarkSignature),
      })
      return
    }
    const children = childNodes(node)
    if (!children.length && (node?.type?.name || node?.type) !== 'paragraph') {
      runs.push({ text: nodeText(node), marks: [`node:${node?.type?.name || node?.type}`] })
      return
    }
    children.forEach(visit)
  }
  visit(paragraph)
  return runs
}

function paragraphFormattingMatches(baseParagraph, localParagraphs) {
  const baseAttrs = JSON.stringify(normalizedAttrs(baseParagraph?.attrs))
  if (localParagraphs.some((paragraph) => (
    JSON.stringify(normalizedAttrs(paragraph?.attrs)) !== baseAttrs
  ))) return false
  const baseRuns = paragraphRuns(baseParagraph)
  const localRuns = localParagraphs.flatMap(paragraphRuns)
  const baseCharacters = baseRuns.flatMap((run) => [...run.text].map((text) => ({
    text,
    marks: run.marks,
  })))
  const localCharacters = localRuns.flatMap((run) => [...run.text].map((text) => ({
    text,
    marks: run.marks,
  })))
  if (baseCharacters.length !== localCharacters.length) return false
  return baseCharacters.every((character, index) => (
    character.text === localCharacters[index].text &&
    JSON.stringify(character.marks) === JSON.stringify(localCharacters[index].marks)
  ))
}

function tableInsertionIntents(transaction, {
  baseDocument = null,
  pendingIntents = [],
} = {}) {
  if (!baseDocument) return []
  debugEvent('gdocs-intent', 'extract-start', {
    stepCount: transaction?.steps?.length || 0,
    base: topologySummary(baseDocument),
  })
  let currentDoc = transaction?.before
  const intents = []
  for (const [stepIndex, step] of (transaction?.steps || []).entries()) {
    const result = step.apply(currentDoc)
    const nextDoc = result.doc || currentDoc
    const insertedTables = insertedTopLevelTables(currentDoc, nextDoc, step)
    debugVerbose('gdocs-intent', 'step', {
      stepIndex,
      stepType: step.toJSON?.().stepType || null,
      from: step.from,
      to: step.to,
      beforeTableCount: topLevelTableNodes(currentDoc).length,
      afterTableCount: topLevelTableNodes(nextDoc).length,
      insertedTableCount: insertedTables.length,
    })
    if (step.toJSON?.().stepType === 'replace' && insertedTables.length) {
      const source = topLevelNodes(currentDoc)
        .map((node, index, nodes) => ({
          node,
          start: nodes.slice(0, index).reduce((offset, item) => offset + item.nodeSize, 0),
          end: nodes.slice(0, index).reduce((offset, item) => offset + item.nodeSize, 0) + node.nodeSize,
        }))
        .find(({ node, start }) => step.to > step.from &&
          start === step.from && node.type.name === 'paragraph') ||
        topLevelNodeAtPosition(currentDoc, step.from)
      if (!source || source.node.type.name !== 'paragraph' || step.to > source.end) {
        throw plannerError('table insertion structure changed', { stage: 'anchor-source' })
      }
      const baseElementIndex = baseElementIndexForNode(
        currentDoc,
        source.node,
        baseDocument,
        pendingIntents,
      )
      const baseElement = baseDocument.elements?.[baseElementIndex]
      const sourceText = nodeText(source.node)
      const offset = Math.max(0, Math.min(sourceText.length, step.from - source.start - 1))
      if (!baseElement || baseElement.kind !== 'paragraph' ||
        !Number.isInteger(baseElement.startIndex) ||
        !Number.isInteger(baseElement.endIndex) ||
        baseElement.endIndex <= baseElement.startIndex ||
        offset > nodeText(baseElement.tiptap)) {
        throw plannerError('table insertion structure changed', { stage: 'anchor-base-element' })
      }
      const dimensionsByTable = insertedTables.map(({ node, index }) => ({
        table: node,
        tableIndex: index,
        dimensions: tableDimensions(node),
      }))
      if (dimensionsByTable.some(({ dimensions }) => !dimensions)) {
        throw plannerError('table insertion structure changed', { stage: 'inserted-table-shape' })
      }
      const anchor = {
        baseElementIndex,
        offset,
        index: baseElement.startIndex + offset,
        sourceText: nodeText(baseElement.tiptap),
      }
      dimensionsByTable.forEach(({ table, tableIndex, dimensions }) => {
        const tableOrdinal = topLevelNodes(nextDoc)
          .slice(0, tableIndex + 1)
          .filter((node) => node.type.name === 'table').length - 1
        intents.push({
          axis: 'table',
          action: 'insert',
          tableOrdinal,
          localTableIndex: tableIndex,
          localTable: table,
          dimensions,
          anchor,
        })
      })
    }
    currentDoc = nextDoc
  }
  debugEvent('gdocs-intent', 'extract-complete', {
    intentCount: intents.length,
    intents: intents.map(summarizeIntent),
  })
  return intents
}

export function tableStructuralIntents(transaction, options = {}) {
  let currentDoc = transaction?.before
  const intents = []
  for (const step of transaction?.steps || []) {
    const intent = structuralIntentForStep(currentDoc, step)
    if (intent) {
      const previous = intents.at(-1)
      const isRepeatedColumnStep = previous &&
        intent.axis === 'column' &&
        previous.tableOrdinal === intent.tableOrdinal &&
        previous.axis === intent.axis &&
        previous.action === intent.action &&
        previous.index === intent.index
      if (!isRepeatedColumnStep) intents.push(intent)
    }
    const result = step.apply(currentDoc)
    if (result.doc) currentDoc = result.doc
  }
  debugEvent('gdocs-intent', 'structural-summary', {
    stepCount: transaction?.steps?.length || 0,
    intentCount: intents.length,
    intents: intents.map(summarizeIntent),
  })
  return [...intents, ...tableInsertionIntents(transaction, options)]
}

function topLevelTableCount(doc) {
  let count = 0
  doc?.forEach?.((node) => {
    if (node.type.name === 'table') count += 1
  })
  return count
}

export function transactionTouchesTable(transaction) {
  if (!transaction?.docChanged) return false
  let currentDoc = transaction.before
  let touchesTable = false
  for (const step of transaction.steps) {
    const touchesExistingTable = (
      positionIsInsideTable(currentDoc, step.from) ||
      positionIsInsideTable(currentDoc, step.to)
    )
    const result = step.apply(currentDoc)
    const nextDoc = result.doc || currentDoc
    touchesTable = touchesTable || touchesExistingTable ||
      topLevelTableCount(currentDoc) !== topLevelTableCount(nextDoc)
    currentDoc = nextDoc
  }
  return touchesTable
}

function structuralCellMatches(baseCell, localCell) {
  const baseNode = baseCell?.tiptap || baseCell
  return cellShape(baseNode) === cellShape(localCell) &&
    JSON.stringify(cellContentStructureShape(baseNode)) ===
    JSON.stringify(cellContentStructureShape(localCell))
}

function structuralRowToken(row) {
  return {
    source: row,
    cells: tableCells(row).map((cell) => ({
      source: cell,
      shape: cellShape(cell?.tiptap || cell),
    })),
  }
}

function structuralPlaceholderRow(cells) {
  return {
    source: null,
    cells: cells.map((cell) => ({ source: null, shape: cell.shape })),
  }
}

function structuralSnapshotMatches(rows, localRows) {
  if (rows.length !== localRows.length) return false
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const tokenRow = rows[rowIndex]
    const localCells = tableCells(localRows[rowIndex])
    if (tokenRow.cells.length !== localCells.length) return false
    for (let cellIndex = 0; cellIndex < tokenRow.cells.length; cellIndex += 1) {
      const tokenCell = tokenRow.cells[cellIndex]
      const localCell = localCells[cellIndex]
      if (tokenCell.source) {
        if (!structuralCellMatches(tokenCell.source, localCell)) return false
      } else if (cellShape(localCell) !== tokenCell.shape) {
        return false
      }
    }
  }
  return true
}

function structuralModelMatchesBase(rows, baseRows) {
  if (rows.length !== baseRows.length) return false
  return rows.every((row, rowIndex) => (
    row.source === baseRows[rowIndex] &&
    row.cells.every((cell, cellIndex) => cell.source === tableCells(baseRows[rowIndex])[cellIndex])
  ))
}

function replayStructuralIntents(baseTable, localTable, structuralIntents) {
  const baseRows = tableRows(baseTable)
  const localRows = tableRows(localTable)
  const rows = baseRows.map(structuralRowToken)
  const requests = []
  const startIndex = baseTable.startIndex
  debugEvent('gdocs-planner', 'structural-replay-start', {
    base: tableSummary(baseTable),
    local: tableSummary(localTable),
    intentCount: structuralIntents.length,
  })
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw plannerError('table structure has no indexed table start', { stage: 'structural-replay' })
  }

  for (const intent of structuralIntents) {
    if (intent.axis === 'row') {
      if (!Number.isInteger(intent.index)) throw plannerError('table row structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
      if (intent.action === 'delete') {
        if (intent.index < 0 || intent.index >= rows.length || rows.length < 2) {
          throw plannerError('table row structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
        }
        rows.splice(intent.index, 1)
        requests.push({
          deleteTableRow: {
            tableCellLocation: {
              tableStartLocation: { index: startIndex },
              rowIndex: intent.index,
              columnIndex: 0,
            },
          },
        })
      } else if (intent.action === 'insert') {
        if (intent.index < 0 || intent.index > rows.length || !rows.length) {
          throw plannerError('table row structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
        }
        rows.splice(intent.index, 0, structuralPlaceholderRow(rows[0].cells))
        requests.push({
          insertTableRow: {
            tableCellLocation: {
              tableStartLocation: { index: startIndex },
              rowIndex: intent.index === 0 ? 0 : intent.index - 1,
              columnIndex: 0,
            },
            insertBelow: intent.index > 0,
          },
        })
      }
    } else if (intent.axis === 'column') {
      if (!Number.isInteger(intent.index) || !rows.length) {
        throw plannerError('table column structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
      }
      if (intent.action === 'delete') {
        if (intent.index < 0 || intent.index >= rows[0].cells.length ||
          rows[0].cells.length < 2) {
          throw plannerError('table column structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
        }
        for (const row of rows) row.cells.splice(intent.index, 1)
        requests.push({
          deleteTableColumn: {
            tableCellLocation: {
              tableStartLocation: { index: startIndex },
              rowIndex: 0,
              columnIndex: intent.index,
            },
          },
        })
      } else if (intent.action === 'insert') {
        if (intent.index < 0 || intent.index > rows[0].cells.length) {
          throw plannerError('table column structure changed', { stage: 'structural-replay', intent: summarizeIntent(intent) })
        }
        for (const row of rows) {
          const reference = row.cells[intent.index > 0 ? intent.index - 1 : 0]
          row.cells.splice(intent.index, 0, { source: null, shape: reference.shape })
        }
        requests.push({
          insertTableColumn: {
            tableCellLocation: {
              tableStartLocation: { index: startIndex },
              rowIndex: 0,
              columnIndex: intent.index === 0 ? 0 : intent.index - 1,
            },
            insertRight: intent.index > 0,
          },
        })
      }
    }
  }

  if (!structuralSnapshotMatches(rows, localRows)) {
    throw plannerError('table structure changed', { stage: 'structural-replay-snapshot' })
  }
  if (structuralModelMatchesBase(rows, baseRows)) {
    debugEvent('gdocs-planner', 'structural-replay-noop', { intentCount: structuralIntents.length })
    return null
  }
  debugEvent('gdocs-planner', 'structural-replay-complete', {
    requestCount: requests.length,
    operationCounts: operationCounts(requests),
  })
  return requests
}

export function tableUpsyncRequests(baseTable, localTable, { structuralIntents = [] } = {}) {
  const baseRows = tableRows(baseTable)
  const localRows = tableRows(localTable)
  debugEvent('gdocs-planner', 'table-start', {
    base: tableSummary(baseTable),
    local: tableSummary(localTable),
    intentCount: structuralIntents.length,
  })
  const changedCells = []
  if (structuralIntents.length) {
    const structuralRequests = replayStructuralIntents(baseTable, localTable, structuralIntents)
    if (structuralRequests) {
      return plannerResult('row/column structural', structuralRequests)
    }
  }
  if (baseRows.length !== localRows.length) {
    const rowDelta = localRows.length - baseRows.length
    if ((![-1, 1].includes(rowDelta)) || !baseRows.length ||
      (rowDelta === -1 && !localRows.length)) {
      throw plannerError('table row structure changed', { stage: 'row-delta', rowDelta })
    }
    if (rowDelta === -1) {
      const rowIntent = structuralIntents.find((intent) => (
        intent.axis === 'row' && intent.action === 'delete'
      ))
      const deletedRows = []
      const candidateRows = Number.isInteger(rowIntent?.index)
        ? [rowIntent.index]
        : Array.from({ length: baseRows.length }, (_, index) => index)
      for (const deletedRowIndex of candidateRows) {
        if (deletedRowIndex < 0 || deletedRowIndex >= baseRows.length) continue
        const matches = localRows.every((localRow, localRowIndex) => (
          rowsMatch(baseRows[localRowIndex + (localRowIndex >= deletedRowIndex ? 1 : 0)], localRow)
        ))
        if (matches) deletedRows.push(deletedRowIndex)
      }
      if (deletedRows.length !== 1) {
        throw plannerError('table row structure changed', {
          stage: 'row-delete-alignment',
          candidateCount: deletedRows.length,
        })
      }
      if (!Number.isFinite(baseTable.startIndex)) {
        throw plannerError('table row structure has no indexed table start', { stage: 'row-delete-index' })
      }
      return plannerResult('row/column structural', [{
        deleteTableRow: {
          tableCellLocation: {
            tableStartLocation: { index: baseTable.startIndex },
            rowIndex: deletedRows[0],
            columnIndex: 0,
          },
        },
      }])
    }
    const appendPrefixMatches = baseRows.every((baseRow, rowIndex) => (
      rowsMatch(baseRow, localRows[rowIndex])
    ))
    const rowIntent = structuralIntents.find((intent) => (
      intent.axis === 'row' && intent.action === 'insert'
    ))
    const insertedRows = []
    const candidateRows = Number.isInteger(rowIntent?.index)
      ? [rowIntent.index]
      : Array.from({ length: baseRows.length + 1 }, (_, index) => index)
    for (const insertionIndex of candidateRows) {
      const matches = baseRows.every((baseRow, baseRowIndex) => (
        rowsMatch(baseRow, localRows[baseRowIndex + (baseRowIndex >= insertionIndex ? 1 : 0)])
      ))
      if (matches && !(insertionIndex === 0 && appendPrefixMatches)) {
        insertedRows.push(insertionIndex)
      }
    }
    if (insertedRows.length !== 1) {
      throw plannerError('table row structure changed', {
        stage: 'row-insert-alignment',
        candidateCount: insertedRows.length,
      })
    }
    const insertionIndex = insertedRows[0]
    const insertedCells = tableCells(localRows[insertionIndex])
    const referenceCells = tableCells(baseRows[0])
    if (insertedCells.length !== referenceCells.length) {
      throw plannerError('table cell structure changed', { stage: 'row-insert-cell-count' })
    }
    for (let cellIndex = 0; cellIndex < insertedCells.length; cellIndex += 1) {
      if (cellShape(referenceCells[cellIndex]?.tiptap || referenceCells[cellIndex]) !==
        cellShape(insertedCells[cellIndex])) {
        throw plannerError('table cell shape changed', {
          stage: 'row-insert-cell-shape',
          rowIndex: insertionIndex,
          columnIndex: cellIndex,
        })
      }
    }
    if (!Number.isFinite(baseTable.startIndex)) {
      throw plannerError('table row structure has no indexed table start', { stage: 'row-insert-index' })
    }
    return plannerResult('row/column structural', [{
      insertTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: baseTable.startIndex },
          rowIndex: insertionIndex === 0 ? 0 : insertionIndex - 1,
          columnIndex: 0,
        },
        insertBelow: insertionIndex > 0,
      },
    }])
  }

  const baseColumnCount = baseRows[0] ? tableCells(baseRows[0]).length : 0
  const localColumnCount = localRows[0] ? tableCells(localRows[0]).length : 0
  if (localColumnCount === baseColumnCount + 1 && baseColumnCount > 0) {
    const insertionColumns = []
    const columnIntent = structuralIntents.find((intent) => (
      intent.axis === 'column' && intent.action === 'insert'
    ))
    const candidateColumns = Number.isInteger(columnIntent?.index)
      ? [columnIntent.index]
      : Array.from({ length: baseColumnCount + 1 }, (_, index) => index)
    for (const insertionColumn of candidateColumns) {
      const matches = baseRows.every((baseRow, rowIndex) => {
        const baseCells = tableCells(baseRow)
        const localCells = tableCells(localRows[rowIndex])
        if (localCells.length !== baseCells.length + 1) return false
        return baseCells.every((baseCell, cellIndex) => {
          const localCell = localCells[cellIndex + (cellIndex >= insertionColumn ? 1 : 0)]
          const baseNode = baseCell?.tiptap || baseCell
          return cellShape(baseNode) === cellShape(localCell) &&
            JSON.stringify(cellContentShape(baseNode)) ===
            JSON.stringify(cellContentShape(localCell)) &&
            cellText(baseNode) === cellText(localCell)
        })
      })
      if (matches) insertionColumns.push(insertionColumn)
    }
    if (insertionColumns.length !== 1) {
      throw plannerError('table column structure changed', {
        stage: 'column-insert-alignment',
        candidateCount: insertionColumns.length,
      })
    }
    const insertionColumn = insertionColumns[0]
    for (let rowIndex = 0; rowIndex < baseRows.length; rowIndex += 1) {
      const baseCells = tableCells(baseRows[rowIndex])
      const localCells = tableCells(localRows[rowIndex])
      const referenceCell = baseCells[insertionColumn > 0 ? insertionColumn - 1 : 0]
      const insertedCell = localCells[insertionColumn]
      if (cellShape(referenceCell?.tiptap || referenceCell) !== cellShape(insertedCell)) {
        throw plannerError('table cell shape changed', {
          stage: 'column-insert-cell-shape',
          rowIndex,
          columnIndex: insertionColumn,
        })
      }
    }
    if (!Number.isFinite(baseTable.startIndex)) {
      throw plannerError('table column structure has no indexed table start', { stage: 'column-insert-index' })
    }
    return plannerResult('row/column structural', [{
      insertTableColumn: {
        tableCellLocation: {
          tableStartLocation: { index: baseTable.startIndex },
          rowIndex: 0,
          columnIndex: insertionColumn === 0 ? 0 : insertionColumn - 1,
        },
        insertRight: insertionColumn > 0,
      },
    }])
  }

  if (localColumnCount === 0 && baseColumnCount > 0) {
    throw plannerError('table column structure changed', { stage: 'column-zero' })
  }
  if (localColumnCount === baseColumnCount - 1 && localColumnCount > 0) {
    const deletionColumns = []
    const columnIntent = structuralIntents.find((intent) => (
      intent.axis === 'column' && intent.action === 'delete'
    ))
    const candidateColumns = Number.isInteger(columnIntent?.index)
      ? [columnIntent.index]
      : Array.from({ length: baseColumnCount }, (_, index) => index)
    for (const deletionColumn of candidateColumns) {
      const matches = baseRows.every((baseRow, rowIndex) => {
        const baseCells = tableCells(baseRow)
        const localCells = tableCells(localRows[rowIndex])
        if (localCells.length !== baseCells.length - 1) return false
        return localCells.every((localCell, cellIndex) => {
          const baseCell = baseCells[cellIndex + (cellIndex >= deletionColumn ? 1 : 0)]
          const baseNode = baseCell?.tiptap || baseCell
          return cellShape(baseNode) === cellShape(localCell) &&
            JSON.stringify(cellContentShape(baseNode)) ===
            JSON.stringify(cellContentShape(localCell)) &&
            nodeText(baseNode) === nodeText(localCell)
        })
      })
      if (matches) deletionColumns.push(deletionColumn)
    }
    if (deletionColumns.length !== 1) {
      throw plannerError('table column structure changed', {
        stage: 'column-delete-alignment',
        candidateCount: deletionColumns.length,
      })
    }
    const deletionColumn = deletionColumns[0]
    if (!Number.isFinite(baseTable.startIndex)) {
      throw plannerError('table column structure has no indexed table start', { stage: 'column-delete-index' })
    }
    return plannerResult('row/column structural', [{
      deleteTableColumn: {
        tableCellLocation: {
          tableStartLocation: { index: baseTable.startIndex },
          rowIndex: 0,
          columnIndex: deletionColumn,
        },
      },
    }])
  }

  for (let rowIndex = 0; rowIndex < baseRows.length; rowIndex += 1) {
    const baseCells = tableCells(baseRows[rowIndex])
    const localCells = tableCells(localRows[rowIndex])
    if (baseCells.length !== localCells.length) {
      throw plannerError('table cell structure changed', {
        stage: 'cell-count',
        rowIndex,
      })
    }

    for (let cellIndex = 0; cellIndex < baseCells.length; cellIndex += 1) {
      const baseCell = baseCells[cellIndex]
      const localCell = localCells[cellIndex]
      if (cellShape(baseCell?.tiptap || baseCell) !== cellShape(localCell)) {
        throw plannerError('table cell shape changed', {
          stage: 'cell-shape',
          rowIndex,
          columnIndex: cellIndex,
        })
      }
      if (JSON.stringify(cellContentShape(baseCell?.tiptap || baseCell)) !==
        JSON.stringify(cellContentShape(localCell))) {
        const textChanged = cellText(baseCell?.tiptap || baseCell) !== cellText(localCell)
        if (textChanged) {
          const serializedText = serializeCellParagraphs(localCell)
          if (serializedText !== null &&
            serializedText !== cellText(baseCell?.tiptap || baseCell)) {
            const contentStartIndex = baseCell.content?.[0]?.startIndex
            const textStyleRequests = hasTextMarks(localCell) && Number.isFinite(contentStartIndex)
              ? insertedCellTextStyleRequests(localCell, contentStartIndex)
              : null
            if (hasTextMarks(localCell) && !textStyleRequests) {
              throw plannerError('table cell content shape changed', {
                stage: 'cell-mark-style',
                rowIndex,
                columnIndex: cellIndex,
              })
            }
            changedCells.push({ baseCell, localCell, serializedText, textStyleRequests })
            continue
          }
          if (JSON.stringify(cellContentStructureShape(baseCell?.tiptap || baseCell)) !==
            JSON.stringify(cellContentStructureShape(localCell))) {
            throw plannerError('table cell content shape changed', {
              stage: 'cell-content-structure',
              rowIndex,
              columnIndex: cellIndex,
            })
          }
          const contentStartIndex = baseCell.content?.[0]?.startIndex
          const textStyleRequests = Number.isFinite(contentStartIndex)
            ? insertedCellTextStyleRequests(localCell, contentStartIndex)
            : null
          if (!textStyleRequests) {
            throw plannerError('table cell content shape changed', {
              stage: 'cell-text-style',
              rowIndex,
              columnIndex: cellIndex,
            })
          }
          changedCells.push({ baseCell, localCell, textStyleRequests })
        } else {
          const markRequests = markOnlyTextStyleRequests(baseCell, localCell)
          if (!markRequests) {
            throw plannerError('table cell content shape changed', {
              stage: 'cell-mark-diff',
              rowIndex,
              columnIndex: cellIndex,
            })
          }
          changedCells.push({ markRequests })
        }
      } else if (cellText(baseCell?.tiptap || baseCell) !== cellText(localCell)) {
        changedCells.push({ baseCell, localCell })
      }
    }
  }

  if (!changedCells.length) {
    throw plannerError('expected exactly one changed table cell', { stage: 'cell-diff' })
  }

  const indexedChanges = changedCells.filter(({ baseCell }) => baseCell).map(({
    baseCell,
    localCell,
    serializedText,
    textStyleRequests,
  }) => {
    const content = baseCell.content || []
    const range = {
      startIndex: content[0]?.startIndex,
      endIndex: content.at(-1)?.endIndex - 1,
    }
    if (!Number.isFinite(range.startIndex) || !Number.isFinite(range.endIndex)) {
      throw plannerError('changed table cell has no indexed content', { stage: 'cell-index' })
    }
    return { localCell, range, serializedText, textStyleRequests }
  }).sort((left, right) => right.range.startIndex - left.range.startIndex)

  const requests = []
  for (const { markRequests } of changedCells) {
    if (markRequests) requests.push(...markRequests)
  }
  for (const { localCell, range, serializedText, textStyleRequests } of indexedChanges) {
    if (range.endIndex > range.startIndex) {
      requests.push({ deleteContentRange: { range } })
    }
    const text = serializedText ?? cellText(localCell)
    if (text) {
      requests.push({
        insertText: {
          location: { index: range.startIndex },
          text,
        },
      })
    }
    if (textStyleRequests) requests.push(...textStyleRequests)
  }
  return plannerResult('cell-content-only', requests, {
    changedCellCount: changedCells.length,
  })
}

function validateInsertedTableIntents(
  baseDocument,
  localDoc,
  structuralIntents,
  { relaxedParagraphBaseIndexes = null } = {},
) {
  const baseElements = baseDocument?.elements || []
  const localNodes = topLevelNodes(localDoc)
  const localTables = topLevelTableNodes(localDoc)
  const insertionIntents = structuralIntents.filter((intent) => (
    intent.axis === 'table' && intent.action === 'insert'
  ))
  if (!insertionIntents.length) return null

  const seenAnchors = new Set()
  const matchedTableIndexes = new Set()
  const requests = []
  const reject = (stage, location, reason) => plannerMismatchError(
    'table insertion structure changed',
    {
      stage,
      baseDocument,
      localDoc,
      insertionIntents,
      matchedIndexes: matchedTableIndexes,
      location,
      reason,
    },
  )
  for (const intent of insertionIntents) {
    const baseElement = baseElements[intent.anchor?.baseElementIndex]
    const { index, offset, sourceText } = intent.anchor || {}
    if (!baseElement || baseElement.kind !== 'paragraph' ||
      !Number.isInteger(baseElement.startIndex) ||
      !Number.isInteger(baseElement.endIndex) ||
      baseElement.endIndex <= baseElement.startIndex ||
      !Number.isInteger(offset) || offset < 0 ||
      offset > String(sourceText || '').length ||
      !Number.isInteger(index) || index !== baseElement.startIndex + offset ||
      index < baseElement.startIndex || index >= baseElement.endIndex) {
      throw reject('inserted-table-anchor', 'anchor', 'invalid or missing anchor')
    }
    if (seenAnchors.has(index)) {
      throw reject('inserted-table-anchor-duplicate', `anchor:${index}`, 'duplicate anchor')
    }
    seenAnchors.add(index)

    let localTableIndex = intent.localTableIndex
    if (!Number.isInteger(localTableIndex) ||
      localNodes[localTableIndex]?.type.name !== 'table') {
      localTableIndex = topLevelNodes(localDoc).indexOf(localTables[intent.tableOrdinal])
    }
    const localTable = localNodes[localTableIndex]
    const dimensions = tableDimensions(localTable)
    if (!localTable || !dimensions ||
      dimensions.rows !== intent.dimensions?.rows ||
      dimensions.columns !== intent.dimensions?.columns ||
      matchedTableIndexes.has(localTableIndex)) {
      throw reject('inserted-table-validation', `table:${localTableIndex}`, 'inserted table shape mismatch')
    }
    matchedTableIndexes.add(localTableIndex)
    requests.push({
      index,
      request: {
        insertTable: {
          rows: dimensions.rows,
          columns: dimensions.columns,
          location: { index },
        },
      },
    })
  }

  const remainingBaseElements = baseElements.filter((element) => element.kind !== 'table')
  const remainingLocalNodes = localNodes.filter((node) => node.type.name !== 'table')
  if (remainingLocalNodes.some((node) => node.type.name !== 'paragraph') ||
    remainingBaseElements.some((element) => element.kind !== 'paragraph')) {
    throw reject('inserted-paragraph-validation', 'paragraph-topology', 'non-paragraph survivor')
  }
  const localParagraphs = remainingLocalNodes
  const baseParagraphs = remainingBaseElements.map((element, index) => ({
    element,
    baseElementIndex: baseElements.indexOf(element),
    index,
  }))
  let localParagraphIndex = 0
  const allowedMissingParagraphs = new Set(insertionIntents
    .filter((intent) => intent.anchor?.sourceText === '')
    .map((intent) => intent.anchor.baseElementIndex))
  for (const { element, baseElementIndex } of baseParagraphs) {
    const baseParagraph = element.tiptap
    const baseText = nodeText(baseParagraph)
    const fragments = []
    let combined = ''
    if (baseText.length === 0 && localParagraphs[localParagraphIndex]?.textContent === '') {
      fragments.push(localParagraphs[localParagraphIndex])
      localParagraphIndex += 1
    }
    while (combined.length < baseText.length && localParagraphIndex < localParagraphs.length) {
      const paragraph = localParagraphs[localParagraphIndex]
      fragments.push(paragraph)
      combined += paragraph.textContent || ''
      localParagraphIndex += 1
    }
    const paragraphRelaxed = relaxedParagraphBaseIndexes?.has?.(baseElementIndex)
    if (combined !== baseText && !(baseText.length === 0 &&
      allowedMissingParagraphs.has(baseElementIndex)) &&
      !paragraphRelaxed) {
      throw reject(`inserted-paragraph:${baseElementIndex}`, 'paragraph-content', 'text or paragraph alignment mismatch')
    }
    if (!paragraphRelaxed && combined === baseText &&
      !paragraphFormattingMatches(baseParagraph, fragments)) {
      throw reject(`inserted-paragraph:${baseElementIndex}`, 'paragraph-formatting', 'paragraph attrs or marks mismatch')
    }
  }
  if (localParagraphIndex < localParagraphs.length) {
    throw reject('inserted-survivor-validation', 'paragraph-tail', 'unmatched local paragraph')
  }

  const baseTables = baseElements.filter((element) => element.kind === 'table')
  const remainingLocalTables = localNodes
    .filter((node, index) => node.type.name === 'table' && !matchedTableIndexes.has(index))
  if (baseTables.length !== remainingLocalTables.length || baseTables.some((element, index) => (
    JSON.stringify(normalizedTipTapNode(element.tiptap)) !==
    JSON.stringify(normalizedTipTapNode(remainingLocalTables[index]))
  ))) {
    throw reject('inserted-survivor-validation', 'table-survivors', 'surviving table mismatch')
  }
  return requests
    .sort((left, right) => right.index - left.index)
    .map(({ request }) => request)
}

export function buildGoogleDocsSyncRequests({
  baseDocument,
  localDoc,
  structuralIntents = [],
  relaxedParagraphBaseIndexes = null,
} = {}) {
  const baseTables = baseDocument?.elements?.filter((element) => element.kind === 'table') || []
  const localTables = topLevelTables(localDoc)
  debugEvent('gdocs-planner', 'topology', {
    base: topologySummary(baseDocument),
    local: topologySummary(localDoc),
    baseTableCount: baseTables.length,
    localTableCount: localTables.length,
    intentCount: structuralIntents.length,
  })
  if (baseTables.length > localTables.length) {
    const mappings = []
    const findMappings = (baseIndex, localIndex, mapping) => {
      if (mappings.length > 1) return
      if (localIndex === localTables.length) {
        mappings.push(mapping)
        return
      }
      for (let candidate = baseIndex; candidate < baseTables.length; candidate += 1) {
        if (JSON.stringify(normalizedTipTapNode(baseTables[candidate].tiptap)) !==
          JSON.stringify(normalizedTipTapNode(localTables[localIndex]))) continue
        findMappings(candidate + 1, localIndex + 1, [...mapping, candidate])
      }
    }
    findMappings(0, 0, [])
    if (mappings.length !== 1) {
      throw plannerError('table count changed', {
        stage: 'table-deletion-alignment',
        candidateCount: mappings.length,
      })
    }
    const mappedTables = new Set(mappings[0])
    const deletedTables = baseTables
      .map((table, tableIndex) => ({ table, tableIndex }))
      .filter(({ tableIndex }) => !mappedTables.has(tableIndex))
      .map(({ table }) => table)
    for (const { startIndex, endIndex } of deletedTables) {
      if (!Number.isInteger(startIndex) || startIndex < 0 ||
        !Number.isInteger(endIndex) || endIndex <= startIndex) {
        throw plannerError('table range has invalid indexes', { stage: 'table-deletion-range' })
      }
    }
    return requestPlan(deletedTables
      .sort((left, right) => right.startIndex - left.startIndex)
      .map(({ startIndex, endIndex }) => ({
        deleteContentRange: { range: { startIndex, endIndex } },
      })), 'table deletion', { deletedTableCount: deletedTables.length })
  }
  if (localTables.length > baseTables.length) {
    const insertionRequests = validateInsertedTableIntents(
      baseDocument,
      localDoc,
      structuralIntents,
      { relaxedParagraphBaseIndexes },
    )
    if (insertionRequests) return requestPlan(insertionRequests, 'table insertion')
    const baseElements = baseDocument?.elements || []
    const localElements = []
    localDoc?.forEach?.((node) => localElements.push(node))
    const alignments = []
    const findAlignments = (baseIndex, localIndex, mapping) => {
      if (alignments.length > 1) return
      if (baseIndex === baseElements.length) {
        if (localElements.slice(localIndex).every((node) => node.type.name === 'table')) {
          alignments.push(mapping)
        }
        return
      }
      for (let candidate = localIndex; candidate < localElements.length; candidate += 1) {
        if (!localElements.slice(localIndex, candidate).every((node) => node.type.name === 'table')) {
          continue
        }
        if (JSON.stringify(normalizedTipTapNode(baseElements[baseIndex].tiptap)) !==
          JSON.stringify(normalizedTipTapNode(localElements[candidate]))) continue
        findAlignments(baseIndex + 1, candidate + 1, [...mapping, candidate])
      }
    }
    findAlignments(0, 0, [])
    if (alignments.length !== 1) {
      throw plannerError('table insertion structure changed', {
        stage: 'table-insertion-alignment',
        candidateCount: alignments.length,
      })
    }
    const matchedLocalIndexes = new Set(alignments[0])
    const insertions = []
    let precedingBaseIndex = -1
    for (let localIndex = 0; localIndex < localElements.length; localIndex += 1) {
      if (matchedLocalIndexes.has(localIndex)) {
        precedingBaseIndex += 1
        continue
      }
      const localTable = localElements[localIndex]
      const precedingParagraph = precedingBaseIndex >= 0
        ? baseElements[precedingBaseIndex]
        : null
      const location = precedingBaseIndex < 0 ? 1 : precedingParagraph?.endIndex - 1
      const rows = tableRows(localTable)
      const columns = rows[0] ? tableCells(rows[0]).length : 0
      if ((precedingBaseIndex >= 0 && precedingParagraph?.kind !== 'paragraph') ||
        !Number.isInteger(location) || location < 0 ||
        !Number.isInteger(rows.length) || rows.length < 1 ||
        !Number.isInteger(columns) || columns < 1 ||
        rows.some((row) => tableCells(row).length !== columns)) {
        throw plannerError('table insertion structure changed', { stage: 'table-insertion-anchor' })
      }
      insertions.push({ location, rows: rows.length, columns })
    }
    if (new Set(insertions.map(({ location }) => location)).size !== insertions.length) {
      throw plannerError('table insertion structure changed', { stage: 'table-insertion-shape' })
    }
    return requestPlan(insertions
      .sort((left, right) => right.location - left.location)
      .map(({ rows, columns, location }) => ({
        insertTable: { rows, columns, location: { index: location } },
      })), 'table insertion', { insertedTableCount: insertions.length })
  }
  if (baseTables.length !== localTables.length) {
    throw plannerError('table count changed', { stage: 'table-count' })
  }

  const changedTables = baseTables.flatMap((baseTable, tableIndex) => {
    const localTable = localTables[tableIndex]
    return JSON.stringify(normalizedTipTapNode(baseTable.tiptap)) ===
      JSON.stringify(normalizedTipTapNode(localTable))
      ? []
      : [{ baseTable, localTable }]
  })
  if (!changedTables.length) return requestPlan([], 'unchanged')
  changedTables.sort((left, right) => right.baseTable.startIndex - left.baseTable.startIndex)
  const requests = changedTables.flatMap(({ baseTable, localTable }) => (
    tableUpsyncRequests(baseTable, localTable, {
      structuralIntents: structuralIntents.filter((intent) => (
        intent.tableOrdinal === baseTables.indexOf(baseTable)
      )),
    }).requests
  ))
  return requestPlan(requests, 'table content/structure', { changedTableCount: changedTables.length })
}

export function createGoogleDocsSyncQueue() {
  let baseDocument = null
  let tableDirty = false
  let structuralIntents = []

  return {
    setBaseDocument(nextBaseDocument) {
      baseDocument = nextBaseDocument
      tableDirty = false
      structuralIntents = []
      debugEvent('gdocs-queue', 'base-set', { topology: topologySummary(nextBaseDocument) })
    },
    acknowledgeBaseDocument(nextBaseDocument, localDoc) {
      baseDocument = nextBaseDocument
      if (localDoc) tableDirty = tablesDiffer(baseDocument, localDoc)
      if (!tableDirty) structuralIntents = []
      debugEvent('gdocs-queue', 'base-acknowledged', {
        topology: topologySummary(nextBaseDocument),
        local: topologySummary(localDoc),
        tableDirty,
        structuralIntentCount: structuralIntents.length,
      })
      return tableDirty
    },
    recordTransaction(transaction, nextStructuralIntents = []) {
      const touchesTable = transactionTouchesTable(transaction)
      if (touchesTable) {
        tableDirty = true
        structuralIntents.push(...nextStructuralIntents)
      }
      debugEvent('gdocs-queue', 'transaction-recorded', {
        touchesTable,
        stepCount: transaction?.steps?.length || 0,
        structuralIntentCount: nextStructuralIntents.length,
        tableDirty,
      })
      return touchesTable
    },
    getPendingRequests(localDoc, { relaxedParagraphBaseIndexes = null } = {}) {
      if (!tableDirty || !baseDocument) return []
      const requests = buildGoogleDocsSyncRequests({
        baseDocument,
        localDoc,
        structuralIntents,
        relaxedParagraphBaseIndexes,
      })
      debugEvent('gdocs-queue', 'pending-read', {
        requestCount: requests.length,
        operationCounts: operationCounts(requests),
      })
      return requests
    },
    getStructuralIntents() {
      return [...structuralIntents]
    },
    clear() {
      tableDirty = false
      structuralIntents = []
      debugEvent('gdocs-queue', 'cleared')
    },
  }
}

/**
 * Maps ProseMirror transaction step to Google Docs batchUpdate requests.
 */
export function stepToGoogleDocsRequests(step, doc, { baseTable, baseDocument } = {}) {
  if (baseTable || baseDocument) {
    const nextDoc = step.apply(doc).doc
    let localTable = null
    const position = Math.min(step.from, nextDoc.content.size)
    const resolvedPosition = nextDoc.resolve(position)
    for (let depth = resolvedPosition.depth; depth >= 0; depth -= 1) {
      const node = resolvedPosition.node(depth)
      if (node.type.name === 'table') {
        localTable = node
        break
      }
    }
    if (localTable) {
      let tableOrdinal = -1
      let tableCount = 0
      nextDoc.forEach((node) => {
        if (node.type.name !== 'table') return
        if (node === localTable) tableOrdinal = tableCount
        tableCount += 1
      })
      const parsedTable = baseTable || baseDocument?.elements
        ?.filter((element) => element.kind === 'table')[tableOrdinal]
      if (parsedTable) return tableUpsyncRequests(parsedTable, localTable).requests
    }
  }

  const requests = []
  const json = step.toJSON()

  if (json.stepType === 'replace') {
    const { from, to } = step
    const nextDoc = step.apply(doc).doc
    const newEnd = nextDoc.content.size - (doc.content.size - to)
    const insertedText = nextDoc.textBetween(from, newEnd, '\n')
    const startIndex = pmPosToDocsIndex(doc, from)
    const endIndex = pmPosToDocsIndex(doc, to) - (to >= doc.content.size ? 1 : 0)
    let removesList = false
    doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'bulletList' || node.type.name === 'orderedList') removesList = true
    })

    if (endIndex > startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex, endIndex },
        },
      })
      if (removesList && !insertedText) {
        requests.push({
          deleteParagraphBullets: {
            range: { startIndex: 1, endIndex: 2 },
          },
        })
      }
    }

    if (insertedText.length > 0) {
      requests.push({
        insertText: {
          location: { index: startIndex },
          text: insertedText,
        },
      })
      requests.push(...insertedTextStyleRequests(nextDoc, from, newEnd))
    }
  }

  if (json.stepType === 'addMark' || json.stepType === 'removeMark') {
    const { from, to, mark } = step
    const style = textStyleForMark(mark)

    if (to > from && style) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: pmPosToDocsIndex(doc, from),
            endIndex: pmPosToDocsIndex(doc, to),
          },
          textStyle: json.stepType === 'addMark'
            ? style.textStyle
            : Object.fromEntries(
              style.fields
                .filter((field) => SUPPORTED_TEXT_STYLE_FIELDS.has(field))
                .map((field) => [field, false]),
            ),
          fields: style.fields.join(','),
        },
      })
    }
  }

  if (json.stepType === 'replaceAround') {
    const nextDoc = step.apply(doc).doc
    const previousNode = doc.nodeAt(step.from)
    const nextNode = nextDoc.nodeAt(step.from)
    const alignment = googleParagraphAlignment(nextNode?.attrs?.textAlign)

    const listType = json.slice?.content?.[0]?.type
    const bulletPreset = LIST_PRESETS[listType] || null
    const parentListType = doc.resolve(step.from).parent.type.name
    const removesEmptyListItem = previousNode?.type.name === 'listItem' &&
      previousNode.textContent === '' &&
      (parentListType === 'bulletList' || parentListType === 'orderedList') &&
      listType === parentListType
    const indentRequests = listNestingRequests(doc, nextDoc)
    if (indentRequests.length) {
      requests.push(...indentRequests)
    } else if (bulletPreset && nextNode?.type.name === listType) {
      requests.push({
        createParagraphBullets: {
          range: {
            startIndex: pmPosToDocsIndex(doc, step.from),
            endIndex: pmPosToDocsIndex(doc, step.to),
          },
          bulletPreset,
        },
      })
    } else if (removesEmptyListItem || (
      (previousNode?.type.name === 'bulletList' || previousNode?.type.name === 'orderedList') &&
      nextNode?.type.name !== previousNode.type.name
    )) {
      const listStartIndex = pmPosToDocsIndex(doc, step.from) + (removesEmptyListItem ? 1 : 0)
      const listEndIndex = pmPosToDocsIndex(doc, step.to) + (removesEmptyListItem ? 1 : 0)
      if (listStartIndex < listEndIndex) {
        requests.push({
          deleteParagraphBullets: {
            range: {
              startIndex: listStartIndex,
              endIndex: listEndIndex,
            },
          },
        })
      }
    }
    const startIndex = pmPosToDocsIndex(doc, step.from) + (step.from > 0 ? 1 : 0)
    const endIndex = startIndex + (nextNode?.textContent.length || 0)

    if (alignment && alignment !== googleParagraphAlignment(previousNode?.attrs?.textAlign)) {
      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex,
            endIndex,
          },
          paragraphStyle: { alignment },
          fields: 'alignment',
        },
      })
    }
  }

  return requests
}

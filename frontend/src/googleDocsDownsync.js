import { fontFamilyCssValue } from './fontCatalog.js'
import { debugEvent } from './debug.js'

function documentIdSummary(documentId) {
  const value = String(documentId || '').trim()
  return {
    documentIdLength: value.length,
    documentIdSuffix: value ? value.slice(-6) : null,
  }
}

function syncElementCounts(elements = []) {
  const counts = {
    elementCount: elements.length,
    paragraphCount: 0,
    tableCount: 0,
    listCount: 0,
  }
  for (const element of elements) {
    if (element.kind === 'table') counts.tableCount += 1
    else if (element.kind === 'paragraph') counts.paragraphCount += 1
    else if (element.kind === 'bulletList' || element.kind === 'orderedList') counts.listCount += 1
  }
  return counts
}

function syncStateSummary(syncState) {
  return syncElementCounts(syncState?.baseDocument?.elements || [])
}

function operationCounts(requests = []) {
  const counts = {}
  for (const request of requests) {
    const operation = Object.keys(request || {})[0] || 'unknown'
    counts[operation] = (counts[operation] || 0) + 1
  }
  return counts
}

function errorSummary(error) {
  return {
    errorType: error?.name || 'Error',
    batchAccepted: error?.batchAccepted === true,
  }
}

function cssColorFromGoogle(color) {
  const rgb = color?.color?.rgbColor
  if (!rgb) return null
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value || 0)) * 255)
  return `rgb(${channel(rgb.red)}, ${channel(rgb.green)}, ${channel(rgb.blue)})`
}

function cssFontSizeFromGoogle(fontSize) {
  if (fontSize?.unit !== 'PT' || !Number.isFinite(fontSize.magnitude)) return null
  return `${fontSize.magnitude * (4 / 3)}px`
}

function cssFontFamilyFromGoogle(weightedFontFamily) {
  const fontFamily = weightedFontFamily?.fontFamily?.trim()
  return fontFamily ? fontFamilyCssValue(fontFamily) : null
}

function cssTextAlignFromGoogle(alignment) {
  return {
    CENTER: 'center',
    END: 'right',
    JUSTIFIED: 'justify',
    START: 'left',
  }[alignment] || null
}

function googleDocListType(googleDoc, bullet, nestingLevel) {
  const glyphType = googleDoc.lists?.[bullet?.listId]?.listProperties?.nestingLevels?.[nestingLevel]?.glyphType
  return glyphType ? 'orderedList' : 'bulletList'
}

export function stripListTabs(text) {
  return String(text || '').replace(/^\t+/, '')
}

function textRunToTipTap(textRun, stripLeadingTabs) {
  let text = textRun.content.replace(/\n$/, '')
  if (stripLeadingTabs) text = stripListTabs(text)
  if (!text) return null

  const style = textRun.textStyle || {}
  const marks = []
  if (style.bold) marks.push({ type: 'bold' })
  if (style.italic) marks.push({ type: 'italic' })
  if (style.underline) marks.push({ type: 'underline' })
  if (style.strikethrough) marks.push({ type: 'strike' })
  const color = cssColorFromGoogle(style.foregroundColor)
  const fontSize = cssFontSizeFromGoogle(style.fontSize)
  const fontFamily = cssFontFamilyFromGoogle(style.weightedFontFamily)
  const textStyle = {
    ...(color ? { color } : {}),
    ...(fontSize ? { fontSize } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  }
  if (Object.keys(textStyle).length) marks.push({ type: 'textStyle', attrs: textStyle })
  if (style.link?.url) marks.push({ type: 'link', attrs: { href: style.link.url } })
  const highlight = cssColorFromGoogle(style.backgroundColor)
  if (highlight) marks.push({ type: 'highlight', attrs: { color: highlight } })

  return { type: 'text', text, ...(marks.length ? { marks } : {}) }
}

export function parseParagraphElement(element, googleDoc) {
  const paragraphContent = []
  let stripLeadingTabs = true

  for (const part of element.paragraph.elements || []) {
    const textRun = part.textRun
    if (!textRun) continue

    const node = textRunToTipTap(textRun, stripLeadingTabs)
    stripLeadingTabs = false
    if (node) paragraphContent.push(node)
  }

  const textAlign = cssTextAlignFromGoogle(element.paragraph.paragraphStyle?.alignment)
  const paragraph = {
    type: 'paragraph',
    ...(textAlign ? { attrs: { textAlign } } : {}),
    ...(paragraphContent.length ? { content: paragraphContent } : {}),
  }
  const bullet = element.paragraph.bullet
  const nestingLevel = bullet?.nestingLevel || 0
  const listType = bullet ? googleDocListType(googleDoc, bullet, nestingLevel) : null

  return { paragraph, bullet, nestingLevel, listType }
}

export function buildNestedLists(bulletParagraphs) {
  if (!bulletParagraphs.length) return []

  const roots = []
  const stack = []

  for (const para of bulletParagraphs) {
    const level = para.nestingLevel
    const listType = para.listType

    if (level === 0 && roots.length > 0 && stack[0]?.listType !== listType) {
      stack.length = 0
    }

    while (stack.length > level + 1) {
      stack.pop()
    }

    while (stack.length <= level) {
      const depth = stack.length
      if (depth > 0) {
        const parentList = stack[depth - 1].listNode
        if (!parentList.content.length) {
          parentList.content.push({ type: 'listItem', content: [{ type: 'paragraph' }] })
        }
      }

      const newList = { type: listType, content: [] }
      if (depth === 0) {
        roots.push(newList)
      } else {
        const parentItem = stack[depth - 1].listNode.content.at(-1)
        parentItem.content.push(newList)
      }
      stack[depth] = { listNode: newList, listType }
      stack.length = depth + 1
    }

    if (stack[level].listType !== listType) {
      stack[level].listType = listType
      stack[level].listNode.type = listType
    }

    stack[level].listNode.content.push({
      type: 'listItem',
      content: [para.paragraph],
    })
  }

  return roots
}

function googleIndexes(element) {
  const indexes = {}
  if (Number.isFinite(element?.startIndex)) indexes.startIndex = element.startIndex
  if (Number.isFinite(element?.endIndex)) indexes.endIndex = element.endIndex
  return indexes
}

function ensureTableCellContent(content) {
  return content.length ? content : [{ type: 'paragraph' }]
}

function tableCellAttrs(cell) {
  const attrs = {}
  if (cell.columnSpan > 1) attrs.colspan = cell.columnSpan
  if (cell.rowSpan > 1) attrs.rowspan = cell.rowSpan
  return Object.keys(attrs).length ? attrs : undefined
}

export function googleCellToTipTap(cell, googleDoc) {
  const content = parseStructuralElements(cell.content || [], googleDoc)
  return {
    type: 'tableCell',
    ...(tableCellAttrs(cell) ? { attrs: tableCellAttrs(cell) } : {}),
    content: ensureTableCellContent(content),
  }
}

export function googleTableToTipTap(table, googleDoc) {
  return {
    type: 'table',
    content: (table.tableRows || []).map((row) => ({
      type: 'tableRow',
      content: (row.tableCells || []).map((cell) => googleCellToTipTap(cell, googleDoc)),
    })),
  }
}

export function parseGoogleCell(cell, googleDoc) {
  return {
    ...googleIndexes(cell),
    content: parseGoogleStructuralElements(cell.content || [], googleDoc),
    tiptap: googleCellToTipTap(cell, googleDoc),
  }
}

export function parseGoogleTableElement(element, googleDoc) {
  const table = element.table || {}
  return {
    kind: 'table',
    ...googleIndexes(element),
    rows: (table.tableRows || []).map((row) => ({
      ...googleIndexes(row),
      cells: (row.tableCells || []).map((cell) => parseGoogleCell(cell, googleDoc)),
    })),
    tiptap: googleTableToTipTap(table, googleDoc),
  }
}

function parseGoogleParagraphElement(element, googleDoc) {
  const parsed = parseParagraphElement(element, googleDoc)
  return {
    kind: 'paragraph',
    ...googleIndexes(element),
    bullet: parsed.bullet || null,
    nestingLevel: parsed.nestingLevel,
    listType: parsed.listType,
    tiptap: parsed.paragraph,
  }
}

export function parseGoogleStructuralElements(elements, googleDoc) {
  const parsed = []
  let bulletRun = []

  const flushBulletRun = () => {
    if (!bulletRun.length) return
    const lists = buildNestedLists(bulletRun.map((item) => ({
      paragraph: item.tiptap,
      nestingLevel: item.nestingLevel,
      listType: item.listType,
    })))
    for (const list of lists) {
      parsed.push({
        kind: list.type,
        tiptap: list,
      })
    }
    bulletRun = []
  }

  for (const element of elements) {
    if (element.paragraph) {
      const item = parseGoogleParagraphElement(element, googleDoc)
      if (item.bullet) {
        bulletRun.push(item)
      } else {
        flushBulletRun()
        parsed.push(item)
      }
    } else if (element.table) {
      flushBulletRun()
      parsed.push(parseGoogleTableElement(element, googleDoc))
    }
  }
  flushBulletRun()

  return parsed
}

export function parseStructuralElements(elements, googleDoc) {
  return parseGoogleStructuralElements(elements, googleDoc).map((item) => item.tiptap)
}

export function parseGoogleDocument(googleDoc) {
  const sourceElements = googleDoc.body?.content || []
  const elements = parseGoogleStructuralElements(sourceElements, googleDoc)
  debugEvent('gdocs-downsync', 'parse-document', {
    sourceElementCount: sourceElements.length,
    ...syncElementCounts(elements),
  })
  return { elements }
}

export function buildGoogleDocsSyncState(googleDoc) {
  const baseDocument = parseGoogleDocument(googleDoc)
  const syncState = {
    baseDocument,
    tiptapDocument: {
      type: 'doc',
      content: baseDocument.elements.map((element) => element.tiptap),
    },
  }
  debugEvent('gdocs-downsync', 'state-built', syncStateSummary(syncState))
  return syncState
}

export function applyGoogleDocsSyncState({
  googleDocument,
  editor,
  buildState = buildGoogleDocsSyncState,
}) {
  const syncState = buildState(googleDocument)
  debugEvent('gdocs-downsync', 'state-apply-start', syncStateSummary(syncState))
  editor.commands.setContent(syncState.tiptapDocument)
  editor.setGoogleDocsBaseDocument(syncState.baseDocument)
  debugEvent('gdocs-downsync', 'state-applied', syncStateSummary(syncState))
  return syncState
}

function googleDocsSyncError(message, batchAccepted = false) {
  const error = new Error(message)
  error.batchAccepted = batchAccepted
  return error
}

function acceptedBatchError(error, acceptedRevisionId = null) {
  if (error?.batchAccepted) return error
  const wrapped = googleDocsSyncError(
    error instanceof Error ? error.message : String(error),
    true,
  )
  wrapped.acceptedRevisionId = acceptedRevisionId
  wrapped.cause = error
  return wrapped
}

export async function refetchGoogleDocsBaseAndAcknowledge({
  documentId,
  fetchImpl = fetch,
  editor,
  buildState = buildGoogleDocsSyncState,
}) {
  const normalizedDocumentId = String(documentId || '').trim()
  if (!normalizedDocumentId) throw googleDocsSyncError('Google Docs document ID is required')
  let phase = 'request'
  debugEvent('gdocs-downsync', 'metadata-refetch-start', {
    ...documentIdSummary(normalizedDocumentId),
  })
  try {
    const documentResponse = await fetchImpl(
      `/api/google-docs/document?documentId=${encodeURIComponent(normalizedDocumentId)}`,
      { method: 'GET' },
    )
    phase = 'response'
    debugEvent('gdocs-downsync', 'metadata-refetch-response', {
      ...documentIdSummary(normalizedDocumentId),
      ok: documentResponse.ok,
      status: documentResponse.status || null,
    })
    if (!documentResponse.ok) {
      const error = await documentResponse.json().catch(() => ({}))
      throw googleDocsSyncError(error.detail || 'Google Docs refetch failed')
    }
    let documentResult
    try {
      documentResult = await documentResponse.json()
    } catch {
      throw googleDocsSyncError('Google Docs refetch response is invalid')
    }
    if (!documentResult.revisionId || !documentResult.document) {
      throw googleDocsSyncError('Google Docs refetch response is incomplete')
    }

    phase = 'state-build'
    const syncState = buildState(documentResult.document)
    debugEvent('gdocs-downsync', 'metadata-refetch-state-built', {
      ...syncStateSummary(syncState),
      hasRevisionId: Boolean(documentResult.revisionId),
    })
    phase = 'acknowledge'
    editor.acknowledgeGoogleDocsBaseDocument(syncState.baseDocument)
    debugEvent('gdocs-downsync', 'metadata-refetch-acknowledged', {
      ...syncStateSummary(syncState),
      hasRevisionId: Boolean(documentResult.revisionId),
    })
    return { revisionId: documentResult.revisionId }
  } catch (error) {
    debugEvent('gdocs-downsync', 'metadata-refetch-failed', {
      ...documentIdSummary(normalizedDocumentId),
      phase,
      ...errorSummary(error),
    })
    if (error?.batchAccepted === false) throw error
    const wrapped = googleDocsSyncError(
      error instanceof Error ? error.message : String(error),
    )
    wrapped.cause = error
    throw wrapped
  }
}

export async function pushGoogleDocsBatchAndAcknowledge({
  documentId,
  requests,
  targetRevisionId = null,
  fetchImpl = fetch,
  editor,
  buildState = buildGoogleDocsSyncState,
}) {
  const normalizedDocumentId = String(documentId || '').trim()
  if (!normalizedDocumentId) throw googleDocsSyncError('Google Docs document ID is required')
  const body = {
    documentId: normalizedDocumentId,
    requests,
    ...(targetRevisionId ? { targetRevisionId } : {}),
  }
  debugEvent('gdocs-downsync', 'batch-post-start', {
    ...documentIdSummary(normalizedDocumentId),
    requestCount: requests.length,
    operationCounts: operationCounts(requests),
    hasTargetRevision: Boolean(targetRevisionId),
  })
  let batchResponse
  try {
    batchResponse = await fetchImpl('/api/google-docs/batch-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    debugEvent('gdocs-downsync', 'batch-post-rejected', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      ...errorSummary(error),
    })
    throw error
  }
  debugEvent('gdocs-downsync', 'batch-post-response', {
    ...documentIdSummary(normalizedDocumentId),
    ok: batchResponse.ok,
    status: batchResponse.status || null,
  })
  if (!batchResponse.ok) {
    const error = await batchResponse.json().catch(() => ({}))
    debugEvent('gdocs-downsync', 'batch-post-rejected', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      batchAccepted: false,
    })
    throw googleDocsSyncError(error.detail || 'Google Docs sync failed')
  }
  let batchResult
  try {
    batchResult = await batchResponse.json()
  } catch {
    debugEvent('gdocs-downsync', 'batch-post-rejected', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      batchAccepted: true,
      reason: 'invalid-response',
    })
    throw googleDocsSyncError('Google Docs sync response is invalid', true)
  }
  if (!batchResult.writeControl?.requiredRevisionId) {
    debugEvent('gdocs-downsync', 'batch-post-rejected', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      batchAccepted: true,
      reason: 'missing-revision',
    })
    throw googleDocsSyncError('Google Docs sync response has no revision', true)
  }
  debugEvent('gdocs-downsync', 'batch-post-accepted', {
    ...documentIdSummary(normalizedDocumentId),
    requestCount: requests.length,
    operationCounts: operationCounts(requests),
    hasRevision: true,
  })

  try {
    const result = await refetchGoogleDocsBaseAndAcknowledge({
      documentId: normalizedDocumentId,
      fetchImpl,
      editor,
      buildState,
    })
    debugEvent('gdocs-downsync', 'batch-acknowledged', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      hasRevision: Boolean(result.revisionId),
    })
    return result
  } catch (error) {
    debugEvent('gdocs-downsync', 'batch-acknowledge-failed', {
      ...documentIdSummary(normalizedDocumentId),
      requestCount: requests.length,
      ...errorSummary(error),
    })
    throw acceptedBatchError(error, batchResult.writeControl.requiredRevisionId)
  }
}

export function googleDocsToTipTap(googleDoc) {
  return buildGoogleDocsSyncState(googleDoc).tiptapDocument
}

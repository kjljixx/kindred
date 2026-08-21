import { docToPlainText } from "./kindredSchema"

function pmPosToDocsIndex(doc, pos) {
  if (!doc || pos <= 1) return 1
  const clamped = Math.min(pos, doc.content.size)
  const textBefore = doc.textBetween(0, clamped, '\n')
  return 1 + textBefore.length
}

/**
 * Maps ProseMirror transaction step to Google Docs batchUpdate request.
 */
export function stepToGoogleDocsRequests(step, doc) {
  const requests = []
  const json = step.toJSON ? step.toJSON() : step
  console.log('stepToGoogleDocsRequests', json)
  
  if (json.stepType === 'replace') {
    const { from, to, slice } = json
    let insertedText = docToPlainText(slice?.content)

    console.log('replace step', { from, to, slice, insertedText })
    if (!insertedText && slice?.openStart > 0 && slice?.openEnd > 0 && slice?.content?.length > 1) {
      insertedText = '\n'
    }

    // ProseMirror pos 1 inside paragraph maps to Docs index 1
    const startIndex = pmPosToDocsIndex(doc, from)
    const endIndex = pmPosToDocsIndex(doc, to)

    if (endIndex > startIndex) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex,
            endIndex,
          },
        },
      })
    }

    if (insertedText.length > 0) {
      requests.push({
        insertText: {
          location: { index: startIndex },
          text: insertedText,
        },
      })
    }
  }

  if (json.stepType === 'addMark') {
    const { from, to, mark } = json
    const { textStyle, fields } = mapMarkToDocsStyle(mark)
    if (fields && to > from) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: Math.max(1, from),
            endIndex: Math.max(1, to),
          },
          textStyle,
          fields,
        },
      })
    }
  }

  if (json.stepType === 'removeMark') {
    const { from, to, mark } = json
    const { textStyle, fields } = mapMarkRemovalToDocsStyle(mark)
    if (fields && to > from) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: Math.max(1, from),
            endIndex: Math.max(1, to),
          },
          textStyle,
          fields,
        },
      })
    }
  }

  return requests
}

function mapMarkToDocsStyle(mark) {
  const type = mark.type || mark
  switch (type) {
    case 'bold':
      return { textStyle: { bold: true }, fields: 'bold' }
    case 'italic':
      return { textStyle: { italic: true }, fields: 'italic' }
    case 'underline':
      return { textStyle: { underline: true }, fields: 'underline' }
    case 'strike':
      return { textStyle: { strikethrough: true }, fields: 'strikethrough' }
    default:
      return { textStyle: {}, fields: null }
  }
}

function mapMarkRemovalToDocsStyle(mark) {
  const type = mark.type || mark
  switch (type) {
    case 'bold':
      return { textStyle: { bold: false }, fields: 'bold' }
    case 'italic':
      return { textStyle: { italic: false }, fields: 'italic' }
    case 'underline':
      return { textStyle: { underline: false }, fields: 'underline' }
    case 'strike':
      return { textStyle: { strikethrough: false }, fields: 'strikethrough' }
    default:
      return { textStyle: {}, fields: null }
  }
}
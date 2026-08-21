import { docToPlainText } from "./kindredSchema"

/**
 * Maps ProseMirror transaction steps to Google Docs batchUpdate requests.
 */
export function stepsToGoogleDocsRequests(steps) {
  const requests = []

  for (const step of steps) {
    const json = step.toJSON ? step.toJSON() : step

    if (json.stepType === 'replace') {
      const { from, to, slice } = json
      const insertedText = docToPlainText(slice?.content)

      // Ignore structural root paragraph setup (e.g., 0 -> 2)
      if (from === 0 && to <= 2 && !insertedText) {
        continue
      }

      // ProseMirror pos 1 inside paragraph maps to Docs index 1
      const startIndex = Math.max(1, from)
      const endIndex = Math.max(startIndex, to)

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
  }

  return requests
}

function extractSliceText(slice) {
  if (!slice?.content) return ''
  return slice.content
    .map((node) => {
      if (node.text) return node.text
      if (node.type === 'paragraph') return '\n'
      return ''
    })
    .join('')
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
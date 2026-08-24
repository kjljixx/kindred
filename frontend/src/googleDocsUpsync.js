const SUPPORTED_TEXT_STYLE_FIELDS = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
])

function pmPosToDocsIndex(doc, pos) {
  if (!doc || pos <= 1) return 1
  const clamped = Math.min(pos, doc.content.size)
  const textBefore = doc.textBetween(0, clamped, '\n')
  return 1 + textBefore.length
}

function textStyleForMark(mark) {
  const markName = mark.type?.name || mark.type || mark
  const field = markName === 'strike' ? 'strikethrough' : markName
  if (!SUPPORTED_TEXT_STYLE_FIELDS.has(field)) return null
  return { field, textStyle: { [field]: true } }
}

function insertedTextStyleRequests(doc, from, to) {
  const requests = []

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return

    const markedFields = new Set(
      node.marks.map(textStyleForMark).filter(Boolean).map(({ field }) => field),
    )
    const textStyle = Object.fromEntries(
      [...SUPPORTED_TEXT_STYLE_FIELDS].map((field) => [field, markedFields.has(field)]),
    )

    requests.push({
      updateTextStyle: {
        range: {
          startIndex: pmPosToDocsIndex(doc, pos),
          endIndex: pmPosToDocsIndex(doc, pos + node.nodeSize),
        },
        textStyle,
        fields: [...SUPPORTED_TEXT_STYLE_FIELDS].join(','),
      },
    })
  })

  return requests
}

/**
 * Maps ProseMirror transaction step to Google Docs batchUpdate requests.
 */
export function stepToGoogleDocsRequests(step, doc) {
  const requests = []
  const json = step.toJSON()

  if (json.stepType === 'replace') {
    const { from, to } = step
    const nextDoc = step.apply(doc).doc
    const newEnd = nextDoc.content.size - (doc.content.size - to)
    const insertedText = nextDoc.textBetween(from, newEnd, '\n')
    const startIndex = pmPosToDocsIndex(doc, from)
    const endIndex = pmPosToDocsIndex(doc, to)

    if (endIndex > startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex, endIndex },
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
          textStyle: { [style.field]: json.stepType === 'addMark' },
          fields: style.field,
        },
      })
    }
  }

  return requests
}

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
    const fields = [
      ...SUPPORTED_TEXT_STYLE_FIELDS,
      'foregroundColor',
      'backgroundColor',
      'fontSize',
      'weightedFontFamily',
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

  return requests
}

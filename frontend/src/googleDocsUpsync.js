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

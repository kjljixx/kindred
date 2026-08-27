import { fontFamilyCssValue } from './fontCatalog.js'

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

export function googleDocsToTipTap(googleDoc) {
  const content = []
  let bulletRun = []

  const flushBulletRun = () => {
    if (!bulletRun.length) return
    content.push(...buildNestedLists(bulletRun))
    bulletRun = []
  }

  for (const element of googleDoc.body?.content || []) {
    if (!element.paragraph) continue

    const parsed = parseParagraphElement(element, googleDoc)
    if (parsed.bullet) {
      bulletRun.push(parsed)
    } else {
      flushBulletRun()
      content.push(parsed.paragraph)
    }
  }
  flushBulletRun()

  return { type: 'doc', content }
}

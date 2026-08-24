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

export function googleDocsToTipTap(googleDoc) {
  const content = [];

  for (const element of googleDoc.body?.content || []) {
    if (!element.paragraph) continue;

    const paragraphContent = [];
    for (const part of element.paragraph.elements || []) {
      const textRun = part.textRun;
      if (!textRun) continue;

      const text = textRun.content.replace(/\n$/, "");
      if (!text) continue;

      const style = textRun.textStyle || {};
      const marks = [];
      if (style.bold) marks.push({ type: "bold" });
      if (style.italic) marks.push({ type: "italic" });
      if (style.underline) marks.push({ type: "underline" });
      if (style.strikethrough) marks.push({ type: "strike" });
      const color = cssColorFromGoogle(style.foregroundColor)
      const fontSize = cssFontSizeFromGoogle(style.fontSize)
      const textStyle = {
        ...(color ? { color } : {}),
        ...(fontSize ? { fontSize } : {}),
      }
      if (Object.keys(textStyle).length) marks.push({ type: "textStyle", attrs: textStyle });
      const highlight = cssColorFromGoogle(style.backgroundColor)
      if (highlight) marks.push({ type: "highlight", attrs: { color: highlight } });

      paragraphContent.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
    }

    content.push({ type: "paragraph", ...(paragraphContent.length ? { content: paragraphContent } : {}) });
  }

  return { type: "doc", content };
}

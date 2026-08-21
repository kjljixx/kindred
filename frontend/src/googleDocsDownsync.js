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

      paragraphContent.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
    }

    content.push({ type: "paragraph", ...(paragraphContent.length ? { content: paragraphContent } : {}) });
  }

  return { type: "doc", content };
}

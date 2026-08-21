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
   const json = step.toJSON();
   console.log('Mapping step to Google Docs requests:', step)
   // 1. Text Insertions and Deletions
   if (json.stepType === 'replace') {
     const { from, to } = step
     const nextDoc = step.apply(doc).doc
 
     // Read inserted text directly from the new document using native textBetween
     const newEnd = nextDoc.content.size - (doc.content.size - to)
     const insertedText = nextDoc.textBetween(from, newEnd, '\n')
 
     const startIndex = pmPosToDocsIndex(doc, from)
     const endIndex = pmPosToDocsIndex(doc, to)
     console.log(`Replace step: from ${from} to ${to}, startIndex ${startIndex}, endIndex ${endIndex}, insertedText: "${insertedText}"`)
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
     }
   }
 
   // 2. Mark Additions (Formatting)
   if (json.stepType === 'addMark') {
     const { from, to, mark } = step
     const markName = mark.type?.name || mark.type
     const field = markName === 'strike' ? 'strikethrough' : markName
 
     if (to > from && ['bold', 'italic', 'underline', 'strikethrough'].includes(field)) {
       requests.push({
         updateTextStyle: {
           range: {
             startIndex: pmPosToDocsIndex(doc, from),
             endIndex: pmPosToDocsIndex(doc, to),
           },
           textStyle: { [field]: true },
           fields: field,
         },
       })
     }
   }
 
   // 3. Mark Removals
   if (json.stepType === 'removeMark') {
     const { from, to, mark } = step
     const markName = mark.type?.name || mark.type
     const field = markName === 'strike' ? 'strikethrough' : markName
 
     if (to > from && ['bold', 'italic', 'underline', 'strikethrough'].includes(field)) {
       requests.push({
         updateTextStyle: {
           range: {
             startIndex: pmPosToDocsIndex(doc, from),
             endIndex: pmPosToDocsIndex(doc, to),
           },
           textStyle: { [field]: false },
           fields: field,
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
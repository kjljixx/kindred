import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from '@tiptap/pm/tables'
import { kindredContentExtensions } from '../src/kindredSchema.js'
import {
  applyGoogleDocsSyncState,
  buildGoogleDocsSyncState,
  pushGoogleDocsBatchAndAcknowledge,
} from '../src/googleDocsDownsync.js'
import {
  buildGoogleDocsSyncRequests,
  tableStructuralIntents,
} from '../src/googleDocsUpsync.js'
import * as googleDocsDownsync from '../src/googleDocsDownsync.js'
import * as tiptapEditor from '../src/tiptapEditor.js'

const schema = getSchema(kindredContentExtensions())

function emptyGoogleTable(startIndex, paragraphStyle = null) {
  return {
    startIndex,
    endIndex: startIndex + 5,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: startIndex + 1,
        endIndex: startIndex + 4,
        tableCells: [{
          startIndex: startIndex + 2,
          endIndex: startIndex + 4,
          content: [{
            startIndex: startIndex + 3,
            endIndex: startIndex + 4,
            paragraph: {
              ...(paragraphStyle ? { paragraphStyle } : {}),
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }],
      }],
    },
  }
}

function googleTableWithText(startIndex, text, paragraphStyle = null) {
  const table = emptyGoogleTable(startIndex, paragraphStyle)
  const textLength = text.length
  table.endIndex += textLength
  table.table.tableRows[0].endIndex += textLength
  table.table.tableRows[0].tableCells[0].endIndex += textLength
  table.table.tableRows[0].tableCells[0].content[0].endIndex += textLength
  table.table.tableRows[0].tableCells[0].content[0].paragraph.elements = [{
    textRun: { content: `${text}\n` },
  }]
  return table
}

function twoRowEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const table = emptyGoogleTable(startIndex, paragraphStyle)
  const secondRowStartIndex = startIndex + 4
  table.endIndex += 3
  table.table.rows = 2
  table.table.tableRows.push({
    startIndex: secondRowStartIndex,
    endIndex: secondRowStartIndex + 3,
    tableCells: [{
      startIndex: secondRowStartIndex + 1,
      endIndex: secondRowStartIndex + 3,
      content: [{
        startIndex: secondRowStartIndex + 2,
        endIndex: secondRowStartIndex + 3,
        paragraph: {
          ...(paragraphStyle ? { paragraphStyle } : {}),
          elements: [{ textRun: { content: '\n' } }],
        },
      }],
    }],
  })
  return table
}

function threeRowEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const table = twoRowEmptyGoogleTable(startIndex, paragraphStyle)
  const thirdRowStartIndex = startIndex + 7
  table.endIndex += 3
  table.table.rows = 3
  table.table.tableRows.push({
    startIndex: thirdRowStartIndex,
    endIndex: thirdRowStartIndex + 3,
    tableCells: [{
      startIndex: thirdRowStartIndex + 1,
      endIndex: thirdRowStartIndex + 3,
      content: [{
        startIndex: thirdRowStartIndex + 2,
        endIndex: thirdRowStartIndex + 3,
        paragraph: {
          ...(paragraphStyle ? { paragraphStyle } : {}),
          elements: [{ textRun: { content: '\n' } }],
        },
      }],
    }],
  })
  return table
}

function fourRowEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const table = threeRowEmptyGoogleTable(startIndex, paragraphStyle)
  const fourthRowStartIndex = startIndex + 10
  table.endIndex += 3
  table.table.rows = 4
  table.table.tableRows.push({
    startIndex: fourthRowStartIndex,
    endIndex: fourthRowStartIndex + 3,
    tableCells: [{
      startIndex: fourthRowStartIndex + 1,
      endIndex: fourthRowStartIndex + 3,
      content: [{
        startIndex: fourthRowStartIndex + 2,
        endIndex: fourthRowStartIndex + 3,
        paragraph: {
          ...(paragraphStyle ? { paragraphStyle } : {}),
          elements: [{ textRun: { content: '\n' } }],
        },
      }],
    }],
  })
  return table
}

function threeColumnEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const paragraph = (contentStartIndex) => ({
    startIndex: contentStartIndex,
    endIndex: contentStartIndex + 1,
    paragraph: {
      ...(paragraphStyle ? { paragraphStyle } : {}),
      elements: [{ textRun: { content: '\n' } }],
    },
  })
  const cell = (cellStartIndex, contentStartIndex) => ({
    startIndex: cellStartIndex,
    endIndex: cellStartIndex + 2,
    content: [paragraph(contentStartIndex)],
  })
  return {
    startIndex,
    endIndex: startIndex + 9,
    table: {
      rows: 1,
      columns: 3,
      tableRows: [{
        startIndex: startIndex + 1,
        endIndex: startIndex + 8,
        tableCells: [
          cell(startIndex + 2, startIndex + 3),
          cell(startIndex + 4, startIndex + 5),
          cell(startIndex + 6, startIndex + 7),
        ],
      }],
    },
  }
}

function fourColumnEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const table = threeColumnEmptyGoogleTable(startIndex, paragraphStyle)
  const row = table.table.tableRows[0]
  const cellStartIndex = startIndex + 8
  row.endIndex += 2
  table.endIndex += 2
  table.table.columns = 4
  row.tableCells.push({
    startIndex: cellStartIndex,
    endIndex: cellStartIndex + 2,
    content: [{
      startIndex: cellStartIndex + 1,
      endIndex: cellStartIndex + 2,
      paragraph: {
        ...(paragraphStyle ? { paragraphStyle } : {}),
        elements: [{ textRun: { content: '\n' } }],
      },
    }],
  })
  return table
}

function threeByThreeEmptyGoogleTable(startIndex, paragraphStyle = null) {
  const tableRows = Array.from({ length: 3 }, (_, rowIndex) => {
    const rowStartIndex = startIndex + 1 + rowIndex * 7
    return {
      startIndex: rowStartIndex,
      endIndex: rowStartIndex + 7,
      tableCells: Array.from({ length: 3 }, (_, columnIndex) => {
        const cellStartIndex = rowStartIndex + 1 + columnIndex * 2
        return {
          startIndex: cellStartIndex,
          endIndex: cellStartIndex + 2,
          content: [{
            startIndex: cellStartIndex + 1,
            endIndex: cellStartIndex + 2,
            paragraph: {
              ...(paragraphStyle ? { paragraphStyle } : {}),
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }
      }),
    }
  })
  return {
    startIndex,
    endIndex: startIndex + 23,
    table: {
      rows: 3,
      columns: 3,
      tableRows,
    },
  }
}

function tiptapTable(rows = 3, columns = 3, firstCellText = null) {
  return schema.nodeFromJSON({
    type: 'table',
    content: Array.from({ length: rows }, (_, rowIndex) => ({
      type: 'tableRow',
      content: Array.from({ length: columns }, (_, columnIndex) => ({
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          ...(rowIndex === 0 && columnIndex === 0 && firstCellText
            ? { content: [{ type: 'text', text: firstCellText }] }
            : {}),
        }],
      })),
    })),
  })
}

function resizeFirstTableCellTransaction(pulledState) {
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  let cellPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' && cellPosition === null) {
      cellPosition = pos
    }
  })
  const cell = initialDoc.nodeAt(cellPosition)
  return EditorState.create({ doc: initialDoc }).tr.setNodeMarkup(
    cellPosition,
    null,
    { ...cell.attrs, colwidth: [120] },
  )
}

test('Google pull applies one indexed sync state to the editor', () => {
  const googleDocument = {
    body: { content: [emptyGoogleTable(10)] },
  }
  let builtState = null
  const buildCalls = []
  const contentCalls = []
  const baseDocumentCalls = []
  const editor = {
    commands: {
      setContent(content) {
        contentCalls.push(content)
        editor.content = content
      },
    },
    setGoogleDocsBaseDocument(baseDocument) {
      baseDocumentCalls.push(baseDocument)
      editor.baseDocument = baseDocument
    },
  }

  applyGoogleDocsSyncState({
    googleDocument,
    editor,
    buildState(document) {
      buildCalls.push(document)
      builtState = buildGoogleDocsSyncState(document)
      return builtState
    },
  })

  assert.equal(buildCalls.length, 1)
  assert.strictEqual(buildCalls[0], googleDocument)
  assert.equal(contentCalls.length, 1)
  assert.strictEqual(contentCalls[0], builtState.tiptapDocument)
  assert.equal(baseDocumentCalls.length, 1)
  assert.strictEqual(baseDocumentCalls[0], builtState.baseDocument)
  assert.strictEqual(editor.baseDocument, builtState.baseDocument)
  assert.strictEqual(editor.content, builtState.tiptapDocument)
  assert.strictEqual(
    editor.baseDocument.elements[0].tiptap,
    editor.content.content[0],
  )
  assert.equal(editor.baseDocument.elements[0].startIndex, 10)
})

test('recorder preserves a pulled cell split as a cell-scoped paragraph rewrite', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 2,
      endIndex: 12,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: 3,
          endIndex: 11,
          tableCells: [{
            startIndex: 4,
            endIndex: 11,
            content: [{
              startIndex: 5,
              endIndex: 11,
              paragraph: {
                paragraphStyle: { alignment: 'START' },
                elements: [{ textRun: { content: 'Alpha\n' } }],
              },
            }],
          }],
        }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  let textStart = null
  initialDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'Alpha') textStart = pos
  })
  assert.notEqual(textStart, null)

  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, textStart + 2),
  })
  const transaction = initialEditorState.tr.split(textStart + 2)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 10 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'Al\npha',
      },
    },
  ])
})

test('table cell resize emits no Google request or structural intent', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(2, 'Keep', { alignment: 'START' })] },
  })
  const transaction = resizeFirstTableCellTransaction(pulledState)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(tableStructuralIntents(transaction), [])
  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [])
})

test('table cell resize followed by text edit emits only cell-content requests', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(2, 'Keep', { alignment: 'START' })] },
  })
  const resizeTransaction = resizeFirstTableCellTransaction(pulledState)
  let textPosition = null
  resizeTransaction.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'Keep') textPosition = pos
  })
  assert.notEqual(textPosition, null)
  const textTransaction = EditorState.create({
    doc: resizeTransaction.doc,
    selection: TextSelection.create(resizeTransaction.doc, textPosition + 4),
  }).tr.insertText('!')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, resizeTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, textTransaction)

  assert.deepEqual(recorder.getPendingRequests(textTransaction.doc), [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 9 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'Keep!',
      },
    },
  ])
})

test('recorder plans a first table insertion after an indexed paragraph', () => {
  const baseDocument = {
    elements: [{
      kind: 'paragraph',
      startIndex: 1,
      endIndex: 2,
      tiptap: { type: 'paragraph' },
    }],
  }
  const initialDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  })
  const table = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }],
  })
  const initialEditorState = EditorState.create({ doc: initialDoc })
  const transaction = initialEditorState.tr.insert(initialDoc.content.size, table)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertTable: {
      rows: 1,
      columns: 1,
      location: { index: 1 },
    },
  }])
})

test('actual insertTable replaces a pulled empty paragraph at index 1', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 2,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: '\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()
  let emptyParagraphPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && !node.textContent) {
      emptyParagraphPosition = pos
    }
  })
  assert.notEqual(emptyParagraphPosition, null)
  assert.equal(editor.chain()
    .setTextSelection(emptyParagraphPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)

  assert.equal(editor.state.doc.childCount, 1)
  assert.equal(editor.state.doc.child(0).type.name, 'table')
  assert.equal(editor.state.doc.child(0).childCount, 3)
  assert.equal(editor.state.doc.child(0).firstChild.childCount, 3)
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 1 },
    },
  }])
  editor.destroy()
})

test('actual insertTable in a pulled final empty paragraph uses its Google start', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 4,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: '\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()
  let emptyParagraphPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && !node.textContent) {
      emptyParagraphPosition = pos
    }
  })
  assert.notEqual(emptyParagraphPosition, null)
  assert.equal(editor.chain()
    .setTextSelection(emptyParagraphPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)

  assert.equal(editor.state.doc.childCount, 2)
  assert.equal(editor.state.doc.child(0).textContent, 'A')
  assert.equal(editor.state.doc.child(1).type.name, 'table')
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 3 },
    },
  }])
  editor.destroy()
})

test('actual insertTable in a pulled middle empty paragraph preserves both neighbors', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 4,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: '\n' } }],
      },
    }, {
      startIndex: 4,
      endIndex: 6,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()
  let emptyParagraphPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && !node.textContent) {
      emptyParagraphPosition = pos
    }
  })
  assert.notEqual(emptyParagraphPosition, null)
  assert.equal(editor.chain()
    .setTextSelection(emptyParagraphPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)

  assert.equal(editor.state.doc.childCount, 3)
  assert.equal(editor.state.doc.child(0).textContent, 'A')
  assert.equal(editor.state.doc.child(1).type.name, 'table')
  assert.equal(editor.state.doc.child(2).textContent, 'B')
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 3 },
    },
  }])
  editor.destroy()
})

test('actual insertTable at a pulled paragraph end preserves the paragraph and repopulates a cell', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 7,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'Alpha\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  const table = tiptapTable(3, 3, 'New')
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, initialDoc.content.size - 1),
  })
  const transaction = initialEditorState.tr.replaceSelectionWith(table)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.equal(transaction.doc.childCount, 2)
  assert.equal(transaction.doc.child(0).type.name, 'paragraph')
  assert.equal(transaction.doc.child(0).textContent, 'Alpha')
  assert.equal(transaction.doc.child(1).type.name, 'table')
  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 6 },
    },
  }])

  recorder.clear()
  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 7,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'Alpha\n' } }],
      },
    }, threeByThreeEmptyGoogleTable(7, { alignment: 'START' })] },
  })
  recorder.acknowledgeBaseDocument(refetchedState.baseDocument, transaction.doc)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertText: {
      location: { index: 10 },
      text: 'New',
    },
  }])
})

test('actual insertTable in a pulled paragraph splits the paragraph around the table', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 7,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'Alpha\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  const table = tiptapTable()
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, 3),
  })
  const transaction = initialEditorState.tr.replaceSelectionWith(table)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.equal(transaction.steps.length, 1)
  const step = transaction.steps[0].toJSON()
  assert.equal(step.stepType, 'replace')
  assert.equal(step.from, 3)
  assert.equal(step.to, 3)
  assert.equal(step.slice.openStart, 1)
  assert.equal(step.slice.openEnd, 1)
  assert.equal(step.slice.content.length, 3)
  assert.equal(transaction.doc.childCount, 3)
  assert.equal(transaction.doc.child(0).type.name, 'paragraph')
  assert.equal(transaction.doc.child(0).textContent, 'Al')
  assert.equal(transaction.doc.child(1).type.name, 'table')
  assert.equal(transaction.doc.child(1).childCount, 3)
  assert.equal(transaction.doc.child(2).type.name, 'paragraph')
  assert.equal(transaction.doc.child(2).textContent, 'pha')
  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 3 },
    },
  }])
})

test('recorder batches actual table insertions after two distinct paragraphs in descending Google order', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  const table = tiptapTable(1, 1)
  let firstTextPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.notEqual(firstTextPosition, null)
  const firstEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, firstTextPosition + 1),
  })
  const firstTransaction = firstEditorState.tr.replaceSelectionWith(table)
  let secondTextPosition = null
  firstTransaction.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'B') secondTextPosition = pos
  })
  assert.notEqual(secondTextPosition, null)
  const secondEditorState = EditorState.create({
    doc: firstTransaction.doc,
    selection: TextSelection.create(firstTransaction.doc, secondTextPosition + 1),
  })
  const secondTransaction = secondEditorState.tr.replaceSelectionWith(table)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, firstTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, secondTransaction)

  assert.equal(secondTransaction.doc.childCount, 4)
  assert.equal(secondTransaction.doc.child(0).textContent, 'A')
  assert.equal(secondTransaction.doc.child(1).type.name, 'table')
  assert.equal(secondTransaction.doc.child(2).textContent, 'B')
  assert.equal(secondTransaction.doc.child(3).type.name, 'table')
  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [
    { insertTable: { rows: 1, columns: 1, location: { index: 4 } } },
    { insertTable: { rows: 1, columns: 1, location: { index: 2 } } },
  ])
})

test('actual insertTable after A in pulled A\\nB records runtime intent and boundary request', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()

  let firstTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.notEqual(firstTextPosition, null)

  let tableTransaction = null
  const captureTableTransaction = ({ transaction }) => {
    if (transaction.docChanged) tableTransaction = transaction
  }
  editor.on('transaction', captureTableTransaction)
  assert.equal(editor.chain()
    .setTextSelection(firstTextPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)
  editor.off('transaction', captureTableTransaction)

  assert.ok(tableTransaction)
  assert.equal(tableTransaction.steps.length, 1)
  const tableStep = tableTransaction.steps[0].toJSON()
  assert.equal(tableStep.stepType, 'replace')
  assert.equal(tableStep.from, 3)
  assert.equal(tableStep.to, 3)
  assert.deepEqual(
    tableStructuralIntents(tableTransaction, {
      baseDocument: pulledState.baseDocument,
    }).map((intent) => ({
      axis: intent.axis,
      action: intent.action,
      tableOrdinal: intent.tableOrdinal,
      localTableIndex: intent.localTableIndex,
      dimensions: intent.dimensions,
      anchor: intent.anchor,
    })),
    [{
    axis: 'table',
    action: 'insert',
    tableOrdinal: 0,
    localTableIndex: 1,
    dimensions: { rows: 3, columns: 3 },
    anchor: {
      baseElementIndex: 0,
      offset: 1,
      index: 2,
      sourceText: 'A',
    },
  }])
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 2 },
    },
  }])
  editor.destroy()
})

test('actual insertTable after A in pulled A\\nB refetches and preserves indexed table ranges', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()

  let firstTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.equal(editor.chain()
    .setTextSelection(firstTextPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: { rows: 3, columns: 3, location: { index: 2 } },
  }])
  editor.clearPendingSyncEditorSteps()

  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, threeByThreeEmptyGoogleTable(3, { alignment: 'START' }), {
      startIndex: 26,
      endIndex: 27,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: '\n' } }],
      },
    }, {
      startIndex: 27,
      endIndex: 29,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  editor.acknowledgeGoogleDocsBaseDocument(refetchedState.baseDocument)

  assert.equal(editor.state.doc.childCount, 3)
  assert.equal(editor.state.doc.child(0).textContent, 'A')
  assert.equal(editor.state.doc.child(1).type.name, 'table')
  assert.equal(editor.state.doc.child(2).textContent, 'B')
  const refetchedTable = refetchedState.baseDocument.elements.find((element) => (
    element.kind === 'table'
  ))
  assert.equal(refetchedTable.startIndex, 3)
  assert.equal(refetchedTable.endIndex, 26)
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [])
  editor.destroy()
})

test('actual insertTable after A and B in pulled A\\nB batches descending insertTable requests', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()

  let firstTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.equal(editor.chain()
    .setTextSelection(firstTextPosition + 1)
    .insertTable({ rows: 1, cols: 1, withHeaderRow: false })
    .run(), true)

  let secondTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'B') secondTextPosition = pos
  })
  assert.equal(editor.chain()
    .setTextSelection(secondTextPosition + 1)
    .insertTable({ rows: 1, cols: 1, withHeaderRow: false })
    .run(), true)

  assert.equal(editor.state.doc.childCount, 4)
  assert.equal(editor.state.doc.child(0).textContent, 'A')
  assert.equal(editor.state.doc.child(1).type.name, 'table')
  assert.equal(editor.state.doc.child(2).textContent, 'B')
  assert.equal(editor.state.doc.child(3).type.name, 'table')
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [
    { insertTable: { rows: 1, columns: 1, location: { index: 4 } } },
    { insertTable: { rows: 1, columns: 1, location: { index: 2 } } },
  ])
  editor.destroy()
})

test('table insertion after A tolerates surviving paragraph text edits in the same batch', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''

  let tableTransaction = null
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) tableTransaction = transaction
  })

  let firstTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.equal(editor.chain()
    .setTextSelection(firstTextPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)
  assert.ok(tableTransaction)

  const afterTableDoc = tableTransaction.doc
  let secondTextPosition = null
  afterTableDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'B') secondTextPosition = pos
  })
  const textTransaction = EditorState.create({
    doc: afterTableDoc,
    selection: TextSelection.create(afterTableDoc, secondTextPosition + 1),
  }).tr.insertText('!', secondTextPosition + 1, secondTextPosition + 1)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, tableTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, textTransaction)

  assert.deepEqual(recorder.getPendingRequests(textTransaction.doc), [
    { insertText: { location: { index: 4 }, text: '!' } },
    { insertTable: { rows: 3, columns: 3, location: { index: 2 } } },
  ])
  editor.destroy()
})

test('table insertion rejects retained paragraph formatting changes', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 7,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'Alpha\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  const bold = schema.marks.bold.create()
  const prefix = schema.nodes.paragraph.create(
    { textAlign: 'right' },
    [schema.text('Al', [bold])],
  )
  const suffix = schema.nodes.paragraph.create(
    { textAlign: 'right' },
    [schema.text('pha')],
  )
  const slice = new Slice(
    Fragment.fromArray([prefix, tiptapTable(1, 1), suffix]),
    1,
    1,
  )
  const transaction = EditorState.create({ doc: initialDoc }).tr.step(
    new ReplaceStep(1, 6, slice),
  )
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)

  assert.throws(() => {
    tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)
    recorder.getPendingRequests(transaction.doc)
  }, /table insertion structure changed/)
})

test('table insertion rejects replacing two pulled empty paragraphs', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 2,
      paragraph: {
        elements: [{ textRun: { content: '\n' } }],
      },
    }, {
      startIndex: 2,
      endIndex: 3,
      paragraph: {
        elements: [{ textRun: { content: '\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  const transaction = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, 1, 3),
  }).tr.replaceSelectionWith(tiptapTable(1, 1))
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)

  assert.throws(() => {
    tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)
  }, /table insertion structure changed/)
})

test('table insertion rejects a changed surviving table before polling', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 2,
      paragraph: {
        elements: [{ textRun: { content: '\n' } }],
      },
    }, emptyGoogleTable(2, { alignment: 'START' }), {
      startIndex: 7,
      endIndex: 12,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'Tail\n' } }],
      },
    }] },
  })
  const initialDoc = schema.nodeFromJSON(pulledState.tiptapDocument)
  let tailTextPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'Tail') tailTextPosition = pos
  })
  assert.notEqual(tailTextPosition, null)
  const newTableTransaction = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, tailTextPosition + 4),
  }).tr.replaceSelectionWith(tiptapTable(1, 1))
  const tableParagraphPositions = []
  newTableTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') tableParagraphPositions.push(pos)
  })
  const changedTableTransaction = EditorState.create({
    doc: newTableTransaction.doc,
    selection: TextSelection.create(newTableTransaction.doc, tableParagraphPositions[1] + 1),
  }).tr.insertText('Changed')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(pulledState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, newTableTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, changedTableTransaction)

  assert.throws(() => {
    recorder.getPendingRequests(changedTableTransaction.doc)
  }, /table insertion structure changed/)
})

test('table insertion mismatch emits structured diagnostics', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, emptyGoogleTable(3, { alignment: 'START' }), {
      startIndex: 8,
      endIndex: 10,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
      tiptapTable(1, 1, 'Changed').toJSON(),
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      tiptapTable(1, 1).toJSON(),
    ],
  })
  const structuralIntents = [{
    axis: 'table',
    action: 'insert',
    tableOrdinal: 1,
    localTableIndex: 3,
    dimensions: { rows: 1, columns: 1 },
    anchor: {
      baseElementIndex: 2,
      offset: 1,
      index: 9,
      sourceText: 'B',
    },
  }]
  const records = []
  const originalDebug = console.debug
  console.debug = (...args) => {
    const data = args.find((arg) => arg && typeof arg === 'object')
    if (data) records.push(data)
  }
  try {
    assert.throws(() => {
      buildGoogleDocsSyncRequests({
        baseDocument: pulledState.baseDocument,
        localDoc,
        structuralIntents,
      })
    }, /table insertion structure changed/)
  } finally {
    console.debug = originalDebug
  }

  const diagnostic = records.find((record) => (
    record.stage &&
    record.baseTopology &&
    record.localTopology &&
    Array.isArray(record.insertionIntents) &&
    Array.isArray(record.matchedIndexes) &&
    record.mismatch
  ))
  assert.ok(diagnostic)
  assert.equal(diagnostic.stage, 'inserted-survivor-validation')
  assert.deepEqual(diagnostic.baseTopology.kinds, ['paragraph', 'table', 'paragraph'])
  assert.deepEqual(diagnostic.localTopology.kinds, ['paragraph', 'table', 'paragraph', 'table'])
  assert.deepEqual(diagnostic.insertionIntents[0], {
    axis: 'table',
    action: 'insert',
    tableOrdinal: 1,
    index: null,
    anchor: { baseElementIndex: 2, offset: 1, index: 9 },
    dimensions: { rows: 1, columns: 1 },
  })
  assert.deepEqual(diagnostic.matchedIndexes, [3])
  assert.deepEqual(diagnostic.mismatch, {
    location: 'table-survivors',
    reason: 'surviving table mismatch',
  })
})

test('first table insertion clears then repopulates its new cell from refetched indexes', () => {
  const baseDocument = {
    elements: [{
      kind: 'paragraph',
      startIndex: 1,
      endIndex: 2,
      tiptap: { type: 'paragraph' },
    }],
  }
  const initialDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  })
  const table = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'New' }],
        }],
      }],
    }],
  })
  const initialEditorState = EditorState.create({ doc: initialDoc })
  const transaction = initialEditorState.tr.insert(initialDoc.content.size, table)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertTable: {
      rows: 1,
      columns: 1,
      location: { index: 1 },
    },
  }])
  recorder.clear()

  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 2,
      paragraph: {
        elements: [{ textRun: { content: '\n' } }],
      },
    }, {
      startIndex: 2,
      endIndex: 7,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: 3,
          endIndex: 6,
          tableCells: [{
            startIndex: 4,
            endIndex: 6,
            content: [{
              startIndex: 5,
              endIndex: 6,
              paragraph: {
                elements: [{ textRun: { content: '\n' } }],
              },
            }],
          }],
        }],
      },
    }] },
  })
  recorder.acknowledgeBaseDocument(refetchedState.baseDocument, transaction.doc)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    insertText: {
      location: { index: 5 },
      text: 'New',
    },
  }])
})

test('second table insertion uses shifted paragraph indexes after refetch', () => {
  const pulledState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, {
      startIndex: 3,
      endIndex: 5,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  const editor = tiptapEditor.createKindredEditor({
    content: pulledState.tiptapDocument,
  })
  editor.getHTML = () => ''
  editor.setGoogleDocsBaseDocument(pulledState.baseDocument)
  editor.startRecordingEditorSteps()
  let firstTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'A') firstTextPosition = pos
  })
  assert.notEqual(firstTextPosition, null)
  assert.equal(editor.chain()
    .setTextSelection(firstTextPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)
  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 2 },
    },
  }])
  editor.clearPendingSyncEditorSteps()

  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 1,
      endIndex: 3,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'A\n' } }],
      },
    }, threeByThreeEmptyGoogleTable(3, { alignment: 'START' }), {
      startIndex: 26,
      endIndex: 27,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: '\n' } }],
      },
    }, {
      startIndex: 27,
      endIndex: 29,
      paragraph: {
        paragraphStyle: { alignment: 'START' },
        elements: [{ textRun: { content: 'B\n' } }],
      },
    }] },
  })
  editor.acknowledgeGoogleDocsBaseDocument(refetchedState.baseDocument)

  let secondTextPosition = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === 'B') secondTextPosition = pos
  })
  assert.notEqual(secondTextPosition, null)
  assert.equal(editor.chain()
    .setTextSelection(secondTextPosition + 1)
    .insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    .run(), true)

  assert.deepEqual(editor.getPendingSyncEditorSteps(), [{
    insertTable: {
      rows: 3,
      columns: 3,
      location: { index: 28 },
    },
  }])
  editor.destroy()
})

test('row insertion clears then repopulates the new row from refetched indexes', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [emptyGoogleTable(2, { alignment: 'START' })] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let paragraphPos = null
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPos = pos
  })
  assert.notEqual(paragraphPos, null)
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPos + 1),
  })
  let rowTransaction = null
  assert.equal(addRowAfter(initialEditorState, (transaction) => {
    rowTransaction = transaction
  }), true)
  assert.notEqual(rowTransaction, null)
  let insertedRowParagraphPos = null
  rowTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') insertedRowParagraphPos = pos
  })
  assert.notEqual(insertedRowParagraphPos, null)
  const populationTransaction = EditorState.create({
    doc: rowTransaction.doc,
    selection: TextSelection.create(rowTransaction.doc, insertedRowParagraphPos + 1),
  }).tr.insertText('New')
  const localDoc = populationTransaction.doc
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, rowTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, populationTransaction)

  assert.deepEqual(recorder.getPendingRequests(localDoc), [{
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  }])
  recorder.clear()

  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [twoRowEmptyGoogleTable(2, { alignment: 'START' })] },
  })
  recorder.acknowledgeBaseDocument(refetchedState.baseDocument, localDoc)

  assert.deepEqual(recorder.getPendingRequests(localDoc), [{
    insertText: {
      location: { index: 8 },
      text: 'New',
    },
  }])
})

test('column insertion clears then repopulates the new column from refetched indexes', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(2, 'Keep', { alignment: 'START' })] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let paragraphPos = null
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPos = pos
  })
  assert.notEqual(paragraphPos, null)
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPos + 1),
  })
  let columnTransaction = null
  assert.equal(addColumnAfter(initialEditorState, (transaction) => {
    columnTransaction = transaction
  }), true)
  assert.notEqual(columnTransaction, null)
  let insertedColumnParagraphPos = null
  columnTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') insertedColumnParagraphPos = pos
  })
  assert.notEqual(insertedColumnParagraphPos, null)
  const populationTransaction = EditorState.create({
    doc: columnTransaction.doc,
    selection: TextSelection.create(columnTransaction.doc, insertedColumnParagraphPos + 1),
  }).tr.insertText('New')
  const localDoc = populationTransaction.doc
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, columnTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, populationTransaction)

  assert.deepEqual(recorder.getPendingRequests(localDoc), [{
    insertTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertRight: true,
    },
  }])
  recorder.clear()

  const refetchedState = buildGoogleDocsSyncState({
    body: { content: [{
      startIndex: 2,
      endIndex: 13,
      table: {
        rows: 1,
        columns: 2,
        tableRows: [{
          startIndex: 3,
          endIndex: 12,
          tableCells: [{
            startIndex: 4,
            endIndex: 10,
            content: [{
              startIndex: 5,
              endIndex: 10,
              paragraph: {
                paragraphStyle: { alignment: 'START' },
                elements: [{ textRun: { content: 'Keep\n' } }],
              },
            }],
          }, {
            startIndex: 10,
            endIndex: 12,
            content: [{
              startIndex: 11,
              endIndex: 12,
              paragraph: {
                elements: [{ textRun: { content: '\n' } }],
              },
            }],
          }],
        }],
      },
    }] },
  })
  recorder.acknowledgeBaseDocument(refetchedState.baseDocument, localDoc)

  assert.deepEqual(recorder.getPendingRequests(localDoc), [{
    insertText: {
      location: { index: 11 },
      text: 'New',
    },
  }])
})

test('recorder preserves selected middle row identity for identical empty rows', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [threeRowEmptyGoogleTable(2, { alignment: 'START' })] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  const paragraphPositions = []
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPositions.push(pos)
  })
  assert.equal(paragraphPositions.length, 3)
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPositions[1] + 1),
  })
  let transaction = null
  assert.equal(deleteRow(initialEditorState, (nextTransaction) => {
    transaction = nextTransaction
  }), true)
  assert.notEqual(transaction, null)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 1,
        columnIndex: 0,
      },
    },
  }])
})

test('recorder preserves selected middle column identity for identical empty columns', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [threeColumnEmptyGoogleTable(2, { alignment: 'START' })] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  const paragraphPositions = []
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPositions.push(pos)
  })
  assert.equal(paragraphPositions.length, 3)
  const initialEditorState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPositions[1] + 1),
  })
  let transaction = null
  assert.equal(deleteColumn(initialEditorState, (nextTransaction) => {
    transaction = nextTransaction
  }), true)
  assert.notEqual(transaction, null)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [{
    deleteTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 1,
      },
    },
  }])
})

test('recorder retires an applied row intent before later selected deletion', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [threeRowEmptyGoogleTable(2)] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  const paragraphPositions = []
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPositions.push(pos)
  })
  assert.equal(paragraphPositions.length, 3)
  const firstState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPositions[1] + 1),
  })
  let firstTransaction = null
  assert.equal(deleteRow(firstState, (transaction) => {
    firstTransaction = transaction
  }), true)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, firstTransaction)
  const acknowledgedState = buildGoogleDocsSyncState({
    body: { content: [twoRowEmptyGoogleTable(2)] },
  })
  recorder.acknowledgeBaseDocument(acknowledgedState.baseDocument, firstTransaction.doc)

  const remainingParagraphPositions = []
  firstTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') remainingParagraphPositions.push(pos)
  })
  const secondState = EditorState.create({
    doc: firstTransaction.doc,
    selection: TextSelection.create(firstTransaction.doc, remainingParagraphPositions[0] + 1),
  })
  let secondTransaction = null
  assert.equal(deleteRow(secondState, (transaction) => {
    secondTransaction = transaction
  }), true)
  tiptapEditor.recordGoogleDocsTransaction(recorder, secondTransaction)

  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [{
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
    },
  }])
})

test('recorder leaves a mixed transaction out of both sync queues', () => {
  const syncState = buildGoogleDocsSyncState({
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 2,
          paragraph: { elements: [{ textRun: { content: '\n' } }] },
        },
        emptyGoogleTable(2),
      ],
    },
  })
  const doc = schema.nodeFromJSON(syncState.tiptapDocument)
  let tableParagraphPos = null
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const resolved = doc.resolve(pos)
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      if (resolved.node(depth).type.name === 'table') tableParagraphPos = pos
    }
  })
  assert.notEqual(tableParagraphPos, null)
  const transaction = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
  }).tr.insertText('p')
  const tableState = EditorState.create({
    doc: transaction.doc,
    selection: TextSelection.create(
      transaction.doc,
      transaction.mapping.map(tableParagraphPos) + 1,
    ),
  })
  let rowTransaction = null
  assert.equal(addRowAfter(tableState, (nextTransaction) => {
    rowTransaction = nextTransaction
  }), true)
  for (const step of rowTransaction.steps) transaction.step(step)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(syncState.baseDocument)
  assert.throws(
    () => tiptapEditor.recordGoogleDocsTransaction(recorder, transaction),
    /mixed table and non-table edits are unsupported/,
  )
  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [])
})

test('recorder emits two selected middle-row deletes in transaction order', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [fourRowEmptyGoogleTable(2)] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  const paragraphPositions = []
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPositions.push(pos)
  })
  assert.equal(paragraphPositions.length, 4)
  const firstState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPositions[1] + 1),
  })
  let firstTransaction = null
  assert.equal(deleteRow(firstState, (transaction) => {
    firstTransaction = transaction
  }), true)
  const remainingParagraphPositions = []
  firstTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') remainingParagraphPositions.push(pos)
  })
  const secondState = EditorState.create({
    doc: firstTransaction.doc,
    selection: TextSelection.create(firstTransaction.doc, remainingParagraphPositions[1] + 1),
  })
  let secondTransaction = null
  assert.equal(deleteRow(secondState, (transaction) => {
    secondTransaction = transaction
  }), true)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, firstTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, secondTransaction)

  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [
    {
      deleteTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: 2 },
          rowIndex: 1,
          columnIndex: 0,
        },
      },
    },
    {
      deleteTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: 2 },
          rowIndex: 1,
          columnIndex: 0,
        },
      },
    },
  ])
})

test('recorder emits two selected middle-column deletes in transaction order', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [fourColumnEmptyGoogleTable(2)] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  const paragraphPositions = []
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPositions.push(pos)
  })
  assert.equal(paragraphPositions.length, 4)
  const firstState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPositions[1] + 1),
  })
  let firstTransaction = null
  assert.equal(deleteColumn(firstState, (transaction) => {
    firstTransaction = transaction
  }), true)
  const remainingParagraphPositions = []
  firstTransaction.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') remainingParagraphPositions.push(pos)
  })
  const secondState = EditorState.create({
    doc: firstTransaction.doc,
    selection: TextSelection.create(firstTransaction.doc, remainingParagraphPositions[1] + 1),
  })
  let secondTransaction = null
  assert.equal(deleteColumn(secondState, (transaction) => {
    secondTransaction = transaction
  }), true)
  assert.equal(initialState.baseDocument.elements[0].rows[0].cells.length, 4)
  let remainingColumnCount = null
  secondTransaction.doc.descendants((node) => {
    if (node.type.name === 'table') remainingColumnCount = node.firstChild.childCount
  })
  assert.equal(remainingColumnCount, 2)

  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, firstTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, secondTransaction)

  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [
    {
      deleteTableColumn: {
        tableCellLocation: {
          tableStartLocation: { index: 2 },
          rowIndex: 0,
          columnIndex: 1,
        },
      },
    },
    {
      deleteTableColumn: {
        tableCellLocation: {
          tableStartLocation: { index: 2 },
          rowIndex: 0,
          columnIndex: 1,
        },
      },
    },
  ])
})

test('push acknowledgment rebases the in-flight table snapshot without dropping newer edits', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [emptyGoogleTable(10)] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let paragraphPos = null
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPos = pos
  })
  const firstState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, paragraphPos + 1),
  })
  const afterT = firstState.tr.insertText('t').doc
  const secondState = EditorState.create({
    doc: afterT,
    selection: TextSelection.create(afterT, paragraphPos + 2),
  })
  const afterTe = secondState.tr.insertText('e').doc
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  const firstBatch = (() => {
    tiptapEditor.recordGoogleDocsTransaction(recorder, firstState.tr.insertText('t'))
    tiptapEditor.recordGoogleDocsTransaction(recorder, secondState.tr.insertText('e'))
    return recorder.getPendingRequests(afterTe)
  })()
  assert.deepEqual(firstBatch, [{
    insertText: {
      location: { index: 13 },
      text: 'te',
    },
  }])
  recorder.clear()

  const xState = EditorState.create({
    doc: afterTe,
    selection: TextSelection.create(afterTe, paragraphPos + 3),
  })
  const xTransaction = xState.tr.insertText('x')
  tiptapEditor.recordGoogleDocsTransaction(recorder, xTransaction)
  const acknowledgedState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(20, 'te')] },
  })
  recorder.acknowledgeBaseDocument(acknowledgedState.baseDocument)

  assert.deepEqual(recorder.getPendingRequests(xTransaction.doc), [
    {
      deleteContentRange: {
        range: { startIndex: 23, endIndex: 25 },
      },
    },
    {
      insertText: {
        location: { index: 23 },
        text: 'tex',
      },
    },
  ])
})

test('push success refetch acknowledges the new base without replacing local content', async () => {
  const googleDocument = {
    body: { content: [googleTableWithText(20, 'te')] },
  }
  const requests = [{ insertText: { location: { index: 13 }, text: 'te' } }]
  const fetchCalls = []
  let builtState = null
  const buildCalls = []
  const contentCalls = []
  const baseDocumentCalls = []
  const localContent = { marker: 'in-flight-local-content' }
  const editor = {
    commands: {
      setContent(content) {
        contentCalls.push(content)
      },
    },
    acknowledgeGoogleDocsBaseDocument(baseDocument) {
      baseDocumentCalls.push(baseDocument)
    },
    content: localContent,
  }

  const result = await pushGoogleDocsBatchAndAcknowledge({
    documentId: 'doc-1',
    requests,
    targetRevisionId: 'rev-1',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options })
      if (url === '/api/google-docs/batch-update') {
        return {
          ok: true,
          async json() {
            return { writeControl: { requiredRevisionId: 'rev-2' } }
          },
        }
      }
      if (url === '/api/google-docs/document?documentId=doc-1') {
        return {
          ok: true,
          async json() {
            return { revisionId: 'rev-2', document: googleDocument }
          },
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    },
    editor,
    buildState(document) {
      buildCalls.push(document)
      builtState = buildGoogleDocsSyncState(document)
      return builtState
    },
  })

  assert.deepEqual(fetchCalls.map(({ url, options }) => ({
    url,
    method: options.method,
  })), [
    { url: '/api/google-docs/batch-update', method: 'POST' },
    { url: '/api/google-docs/document?documentId=doc-1', method: 'GET' },
  ])
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    documentId: 'doc-1',
    requests,
    targetRevisionId: 'rev-1',
  })
  assert.equal(result.revisionId, 'rev-2')
  assert.equal(buildCalls.length, 1)
  assert.strictEqual(buildCalls[0], googleDocument)
  assert.equal(contentCalls.length, 0)
  assert.strictEqual(editor.content, localContent)
  assert.equal(baseDocumentCalls.length, 1)
  assert.strictEqual(baseDocumentCalls[0], builtState.baseDocument)
  assert.equal(baseDocumentCalls[0].elements[0].startIndex, 20)
})

test('accepted push with failed refetch marks the batch accepted without acknowledging or resending', async () => {
  const fetchCalls = []
  const baseDocumentCalls = []
  const editor = {
    acknowledgeGoogleDocsBaseDocument(baseDocument) {
      baseDocumentCalls.push(baseDocument)
    },
  }

  await assert.rejects(
    pushGoogleDocsBatchAndAcknowledge({
      documentId: 'doc-1',
      requests: [{ insertText: { location: { index: 13 }, text: 'te' } }],
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options })
        if (url === '/api/google-docs/batch-update') {
          return {
            ok: true,
            async json() {
              return { writeControl: { requiredRevisionId: 'rev-2' } }
            },
          }
        }
        if (url === '/api/google-docs/document?documentId=doc-1') {
          throw new Error('refetch network failure')
        }
        throw new Error(`Unexpected fetch: ${url}`)
      },
      editor,
    }),
    (error) => {
      assert.equal(error.batchAccepted, true)
      assert.equal(error.acceptedRevisionId, 'rev-2')
      return true
    },
  )

  assert.deepEqual(fetchCalls.map(({ url, options }) => ({
    url,
    method: options.method,
  })), [
    { url: '/api/google-docs/batch-update', method: 'POST' },
    { url: '/api/google-docs/document?documentId=doc-1', method: 'GET' },
  ])
  assert.equal(baseDocumentCalls.length, 0)
})

test('stale base defers a local cell edit until fresh-base acknowledgment', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(10, 'te')] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let textPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'te') textPosition = pos
  })
  assert.notEqual(textPosition, null)
  const transaction = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, textPosition + 2),
  }).tr.insertText('x')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  recorder.clear()
  recorder.markBaseDocumentStale()
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [])

  const freshState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(20, 'te')] },
  })
  recorder.acknowledgeBaseDocument(freshState.baseDocument, transaction.doc)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [
    {
      deleteContentRange: {
        range: { startIndex: 23, endIndex: 25 },
      },
    },
    {
      insertText: {
        location: { index: 23 },
        text: 'tex',
      },
    },
  ])
})

test('accepted-refetch race defers an already-recorded local edit until fresh acknowledgment', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(10, 'te')] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let textPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.isText && node.text === 'te') textPosition = pos
  })
  assert.notEqual(textPosition, null)
  const transaction = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, textPosition + 2),
  }).tr.insertText('x')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  recorder.clear()
  tiptapEditor.recordGoogleDocsTransaction(recorder, transaction)
  recorder.markBaseDocumentStale()

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [])

  const freshState = buildGoogleDocsSyncState({
    body: { content: [googleTableWithText(20, 'te')] },
  })
  recorder.acknowledgeBaseDocument(freshState.baseDocument, transaction.doc)

  assert.deepEqual(recorder.getPendingRequests(transaction.doc), [
    {
      deleteContentRange: {
        range: { startIndex: 23, endIndex: 25 },
      },
    },
    {
      insertText: {
        location: { index: 23 },
        text: 'tex',
      },
    },
  ])
})

test('stale base defers a row insertion until fresh-base acknowledgment', () => {
  const initialState = buildGoogleDocsSyncState({
    body: { content: [emptyGoogleTable(20, { alignment: 'START' })] },
  })
  const initialDoc = schema.nodeFromJSON(initialState.tiptapDocument)
  let paragraphPosition = null
  initialDoc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPosition = pos
  })
  assert.notEqual(paragraphPosition, null)
  let rowTransaction = null
  assert.equal(addRowAfter(
    EditorState.create({
      doc: initialDoc,
      selection: TextSelection.create(initialDoc, paragraphPosition + 1),
    }),
    (transaction) => {
      rowTransaction = transaction
    },
  ), true)
  assert.notEqual(rowTransaction, null)
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(initialState.baseDocument)
  recorder.clear()
  recorder.markBaseDocumentStale()
  tiptapEditor.recordGoogleDocsTransaction(recorder, rowTransaction)

  assert.deepEqual(recorder.getPendingRequests(rowTransaction.doc), [])

  const freshState = buildGoogleDocsSyncState({
    body: { content: [emptyGoogleTable(30, { alignment: 'START' })] },
  })
  recorder.acknowledgeBaseDocument(freshState.baseDocument, rowTransaction.doc)

  assert.deepEqual(recorder.getPendingRequests(rowTransaction.doc), [{
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 30 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  }])
})

test('recovery refetch acknowledges the new base without replacing local content', async () => {
  const googleDocument = {
    body: { content: [googleTableWithText(20, 'te')] },
  }
  const fetchCalls = []
  const buildCalls = []
  const baseDocumentCalls = []
  const contentCalls = []
  let builtState = null
  const localContent = { marker: 'in-flight-local-content' }
  const editor = {
    commands: {
      setContent(content) {
        contentCalls.push(content)
      },
    },
    acknowledgeGoogleDocsBaseDocument(baseDocument) {
      baseDocumentCalls.push(baseDocument)
    },
    content: localContent,
  }

  const result = await googleDocsDownsync.refetchGoogleDocsBaseAndAcknowledge({
    documentId: 'doc-1',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options })
      return {
        ok: true,
        async json() {
          return { revisionId: 'rev-2', document: googleDocument }
        },
      }
    },
    editor,
    buildState(document) {
      buildCalls.push(document)
      builtState = buildGoogleDocsSyncState(document)
      return builtState
    },
  })

  assert.deepEqual(fetchCalls.map(({ url, options }) => ({
    url,
    method: options.method,
  })), [{
    url: '/api/google-docs/document?documentId=doc-1',
    method: 'GET',
  }])
  assert.equal(result.revisionId, 'rev-2')
  assert.deepEqual(buildCalls, [googleDocument])
  assert.equal(contentCalls.length, 0)
  assert.equal(baseDocumentCalls.length, 1)
  assert.strictEqual(baseDocumentCalls[0], builtState.baseDocument)
  assert.strictEqual(editor.content, localContent)
})

test('recovery refetch failure is typed and leaves editor state untouched', async () => {
  const fetchCalls = []
  const buildCalls = []
  const baseDocumentCalls = []
  const contentCalls = []
  const editor = {
    commands: {
      setContent(content) {
        contentCalls.push(content)
      },
    },
    acknowledgeGoogleDocsBaseDocument(baseDocument) {
      baseDocumentCalls.push(baseDocument)
    },
  }

  await assert.rejects(
    googleDocsDownsync.refetchGoogleDocsBaseAndAcknowledge({
      documentId: 'doc-1',
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options })
        throw new Error('recovery refetch network failure')
      },
      editor,
      buildState(document) {
        buildCalls.push(document)
        return buildGoogleDocsSyncState(document)
      },
    }),
    (error) => {
      assert.equal(error instanceof Error, true)
      assert.equal(error.batchAccepted, false)
      return true
    },
  )

  assert.deepEqual(fetchCalls.map(({ url, options }) => ({
    url,
    method: options.method,
  })), [{
    url: '/api/google-docs/document?documentId=doc-1',
    method: 'GET',
  }])
  assert.equal(buildCalls.length, 0)
  assert.equal(baseDocumentCalls.length, 0)
  assert.equal(contentCalls.length, 0)
})

test('editor sync recorder coalesces rapid table transactions at the cell index', () => {
  const syncState = buildGoogleDocsSyncState({
    body: { content: [emptyGoogleTable(10)] },
  })
  const doc = schema.nodeFromJSON(syncState.tiptapDocument)
  let paragraphPos = null
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPos = pos
  })
  const firstState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphPos + 1),
  })
  const firstTransaction = firstState.tr.insertText('t')
  const secondState = EditorState.create({
    doc: firstTransaction.doc,
    selection: TextSelection.create(firstTransaction.doc, paragraphPos + 2),
  })
  const secondTransaction = secondState.tr.insertText('e')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(syncState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, firstTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, secondTransaction)

  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [{
    insertText: {
      location: { index: 13 },
      text: 'te',
    },
  }])

  recorder.clear()
  assert.deepEqual(recorder.getPendingRequests(secondTransaction.doc), [])
})

test('editor sync recorder rejects mixed table and non-table transactions explicitly', () => {
  const syncState = buildGoogleDocsSyncState({
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 2,
          paragraph: { elements: [{ textRun: { content: '\n' } }] },
        },
        emptyGoogleTable(2),
      ],
    },
  })
  const doc = schema.nodeFromJSON(syncState.tiptapDocument)
  let tableParagraphPos = null
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const resolved = doc.resolve(pos)
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      if (resolved.node(depth).type.name === 'table') tableParagraphPos = pos
    }
  })
  assert.notEqual(tableParagraphPos, null)
  const plainTransaction = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
  }).tr.insertText('p')
  const tableParagraphPosAfterPlain = plainTransaction.mapping.map(tableParagraphPos)
  const tableTransaction = EditorState.create({
    doc: plainTransaction.doc,
    selection: TextSelection.create(plainTransaction.doc, tableParagraphPosAfterPlain + 1),
  }).tr.insertText('t')
  const recorder = tiptapEditor.createGoogleDocsSyncRecorder()
  recorder.setBaseDocument(syncState.baseDocument)
  tiptapEditor.recordGoogleDocsTransaction(recorder, plainTransaction)
  tiptapEditor.recordGoogleDocsTransaction(recorder, tableTransaction)

  assert.throws(
    () => recorder.getPendingRequests(tableTransaction.doc),
    /mixed table and non-table edits are unsupported/,
  )
})

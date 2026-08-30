import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list'
import { kindredContentExtensions } from '../src/kindredSchema.js'
import {
  listNestingRequests,
  stepToGoogleDocsRequests,
} from '../src/googleDocsUpsync.js'
import * as googleDocsUpsync from '../src/googleDocsUpsync.js'
import { parseGoogleTableElement } from '../src/googleDocsDownsync.js'
import * as googleDocsDownsync from '../src/googleDocsDownsync.js'

const schema = getSchema(kindredContentExtensions())

function listDoc(items, type = 'bulletList') {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type,
      content: items.map((text) => ({
        type: 'listItem',
        content: [{
          type: 'paragraph',
          ...(text ? { content: [{ type: 'text', text }] } : {}),
        }],
      })),
    }],
  })
}

function indentStep(doc, text) {
  let textPos = null
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) textPos = pos
  })
  assert.notEqual(textPos, null)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPos),
  })
  let transaction = null
  const applied = sinkListItem(schema.nodes.listItem)(state, (nextTransaction) => {
    transaction = nextTransaction
  })
  assert.equal(applied, true)
  assert.equal(transaction.steps.length, 1)
  return { doc, step: transaction.steps[0], nextDoc: transaction.doc }
}

function outdentStep(doc, text) {
  let textPos = null
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) textPos = pos
  })
  assert.notEqual(textPos, null)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPos),
  })
  let transaction = null
  const applied = liftListItem(schema.nodes.listItem)(state, (nextTransaction) => {
    transaction = nextTransaction
  })
  assert.equal(applied, true)
  assert.equal(transaction.steps.length, 1)
  return { doc, step: transaction.steps[0], nextDoc: transaction.doc }
}

function indentEmptyItemStep(doc) {
  let paragraphPos = null
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && !node.textContent) paragraphPos = pos
  })
  assert.notEqual(paragraphPos, null)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphPos + 1),
  })
  let transaction = null
  const applied = sinkListItem(schema.nodes.listItem)(state, (nextTransaction) => {
    transaction = nextTransaction
  })
  assert.equal(applied, true)
  assert.equal(transaction.steps.length, 1)
  return { doc, step: transaction.steps[0], nextDoc: transaction.doc }
}

function preIndentedDoc(items, textToIndent, type = 'bulletList') {
  const baseDoc = listDoc(items, type)
  const { nextDoc } = indentStep(baseDoc, textToIndent)
  return nextDoc
}

function requestKinds(requests) {
  return requests.map((request) => Object.keys(request)[0])
}

const CLEAR_INDENT_STYLE = {
  paragraphStyle: {
    indentStart: { magnitude: 0, unit: 'PT' },
    indentFirstLine: { magnitude: 0, unit: 'PT' },
  },
  fields: 'indentStart,indentFirstLine',
}

test('list nesting: single indent emits four-step rewrite over full list', () => {
  const { doc, step } = indentStep(listDoc(['one', 'two']), 'two')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[0].deleteParagraphBullets.range, { startIndex: 1, endIndex: 9 })
  assert.deepEqual(requests[1].updateParagraphStyle, {
    range: { startIndex: 1, endIndex: 9 },
    ...CLEAR_INDENT_STYLE,
  })
  assert.deepEqual(requests[2], {
    insertText: {
      location: { index: 5 },
      text: '\t',
    },
  })
  assert.deepEqual(requests[3], {
    createParagraphBullets: {
      range: { startIndex: 1, endIndex: 10 },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    },
  })
})

test('list nesting: outdent emits four-step rewrite without tab edits when depth goes to zero', () => {
  const doc = preIndentedDoc(['one', 'two'], 'two')
  const { step } = outdentStep(doc, 'two')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[2].createParagraphBullets, {
    range: { startIndex: 1, endIndex: 9 },
    bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
  })
})

test('list nesting: outdent sibling re-inserts tabs for unchanged nested items (outdent3)', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'ONE' }] },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TWO' }] }],
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'THREE' }] }],
              },
            ],
          },
        ],
      }],
    }],
  })
  const { step } = outdentStep(doc, 'THREE')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[2].insertText, {
    location: { index: 5 },
    text: '\t',
  })
  assert.deepEqual(requests[0].deleteParagraphBullets.range, { startIndex: 1, endIndex: 15 })
  assert.deepEqual(requests[3].createParagraphBullets.range, {
    startIndex: 1,
    endIndex: 16,
  })
})

test('list nesting: outdent test3 rewrites whole list (outdent4)', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'test' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test' }] }],
              }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'test' }] },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test123' }] }],
                },
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test2' }] }],
                },
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test3' }] }],
                },
              ],
            },
          ],
        },
      ],
    }],
  })
  const { step } = outdentStep(doc, 'test3')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'insertText',
    'insertText',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[0].deleteParagraphBullets.range, { startIndex: 1, endIndex: 36 })
  assert.deepEqual(
    requests.slice(2, 5).map((request) => request.insertText.location.index),
    [24, 16, 6],
  )
  assert.deepEqual(requests[5].createParagraphBullets.range, { startIndex: 1, endIndex: 39 })
})

test('list nesting: subtree indent inserts tabs at each affected paragraph', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parent' }] }],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'child' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'grandchild' }] }],
              }],
            },
          ],
        },
      ],
    }],
  })
  const { step } = indentStep(doc, 'child')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'insertText',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(
    requests.filter((request) => request.insertText).map((request) => request.insertText.text),
    ['\t\t', '\t'],
  )
})

test('list nesting: ordered list keeps numbered preset', () => {
  const doc = listDoc(['one', 'two'], 'orderedList')
  const { step } = indentStep(doc, 'two')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.equal(requests.at(-1).createParagraphBullets.bulletPreset, 'NUMBERED_DECIMAL_ALPHA_ROMAN')
})

test('list nesting: empty item tab lands at empty paragraph start', () => {
  const doc = listDoc(['one', ''])
  const { step } = indentEmptyItemStep(doc)
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requests[2], {
    insertText: {
      location: { index: 5 },
      text: '\t',
    },
  })
  assert.deepEqual(requests[3].createParagraphBullets.range, {
    startIndex: 1,
    endIndex: 7,
  })
})

test('list nesting: empty nested descendant gets tab at correct index', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parent' }] }],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'child' }] },
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
            },
          ],
        },
      ],
    }],
  })
  const { step } = indentStep(doc, 'child')
  const requests = stepToGoogleDocsRequests(step, doc)
  const tabInserts = requests.filter((request) => request.insertText)

  assert.equal(tabInserts.length, 2)
  assert.deepEqual(tabInserts.map((request) => request.insertText.text), ['\t\t', '\t'])
  assert.deepEqual(tabInserts.map((request) => request.insertText.location.index), [14, 8])
})

test('list nesting: subtree outdent re-inserts tabs for remaining nested items', () => {
  const baseDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parent' }] }],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'child' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'grandchild' }] }],
              }],
            },
          ],
        },
      ],
    }],
  })
  const { nextDoc: doc } = indentStep(baseDoc, 'child')
  const { step } = outdentStep(doc, 'child')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'updateParagraphStyle',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[2].insertText, {
    location: { index: 14 },
    text: '\t',
  })
})

test('list nesting: paragraph count mismatch returns no requests', () => {
  const before = listDoc(['one', 'two'])
  const after = listDoc(['one'])
  assert.deepEqual(listNestingRequests(before, after), [])
})

test('table upsync: changed cell content preserves table structure and scopes requests to that cell', () => {
  const baseCell = {
    startIndex: 12,
    endIndex: 19,
    content: [{
      kind: 'paragraph',
      startIndex: 13,
      endIndex: 19,
      tiptap: {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Alpha' }],
      },
    }],
    tiptap: {
      type: 'tableCell',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Alpha' }],
      }],
    },
  }
  const baseTable = {
    kind: 'table',
    startIndex: 10,
    endIndex: 20,
    rows: [{
      startIndex: 11,
      endIndex: 19,
      cells: [baseCell],
    }],
    tiptap: {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [baseCell.tiptap],
      }],
    },
  }
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Bravo' }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 13, endIndex: 18 },
      },
    },
    {
      insertText: {
        location: { index: 13 },
        text: 'Bravo',
      },
    },
  ])
})

test('table upsync: changed cell content shape is rejected instead of flattened to text', () => {
  const baseCell = {
    startIndex: 12,
    endIndex: 19,
    content: [{
      kind: 'paragraph',
      startIndex: 13,
      endIndex: 19,
      tiptap: {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Alpha' }],
      },
    }],
    tiptap: {
      type: 'tableCell',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Alpha' }],
      }],
    },
  }
  const baseTable = {
    kind: 'table',
    startIndex: 10,
    endIndex: 20,
    rows: [{
      startIndex: 11,
      endIndex: 19,
      cells: [baseCell],
    }],
    tiptap: {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [baseCell.tiptap],
      }],
    },
  }
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Bravo' }],
            }],
          }],
        }],
      }],
    }],
  })

  assert.throws(
    () => googleDocsUpsync.tableUpsyncRequests(baseTable, localTable),
    /table cell content shape changed/,
  )
})

test.skip('table upsync: plain cell becomes a flat bullet list with cell-scoped requests', {
  skip: 'list-cell upsync is next phase',
}, () => {
  const baseTable = parseGoogleTableElement({
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
              elements: [{ textRun: { content: 'Alpha\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'One' }],
              }],
            },
            {
              type: 'listItem',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Two' }],
              }],
            },
          ],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 10 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'One\nTwo',
      },
    },
    {
      createParagraphBullets: {
        range: { startIndex: 5, endIndex: 13 },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    },
  ])
})

test('table upsync: mark-only cell change updates text style', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 8,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 7,
        tableCells: [{
          startIndex: 4,
          endIndex: 7,
          content: [{
            startIndex: 5,
            endIndex: 7,
            paragraph: {
              elements: [{ textRun: { content: 't\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 't',
            marks: [{ type: 'bold' }],
          }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [{
    updateTextStyle: {
      range: { startIndex: 5, endIndex: 6 },
      textStyle: { bold: true },
      fields: 'bold',
    },
  }])
})

test('table upsync: text replacement with marks updates content and text style', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 8,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 7,
        tableCells: [{
          startIndex: 4,
          endIndex: 7,
          content: [{
            startIndex: 5,
            endIndex: 7,
            paragraph: {
              elements: [{ textRun: { content: 'a\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 'b',
            marks: [{ type: 'bold' }],
          }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 6 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'b',
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 6 },
        textStyle: {
          bold: true,
          italic: false,
          underline: false,
          strikethrough: false,
        },
        fields: 'bold,italic,underline,strikethrough,foregroundColor,backgroundColor,fontSize,weightedFontFamily,link',
      },
    },
  ])
})

test('table upsync: multi-paragraph cell content stays cell-scoped', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 8,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 7,
        tableCells: [{
          startIndex: 4,
          endIndex: 7,
          content: [{
            startIndex: 5,
            endIndex: 7,
            paragraph: {
              elements: [{ textRun: { content: 'A\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'A' }],
        }, {
          type: 'paragraph',
          content: [{ type: 'text', text: 'B' }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 6 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'A\nB',
      },
    },
  ])
})

test('table upsync: marked multi-paragraph cell preserves inserted text styles', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 11,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 10,
        tableCells: [{
          startIndex: 4,
          endIndex: 9,
          content: [{
            startIndex: 5,
            endIndex: 7,
            paragraph: {
              elements: [{ textRun: { content: 'A\n' } }],
            },
          }, {
            startIndex: 7,
            endIndex: 9,
            paragraph: {
              elements: [{ textRun: { content: 'C\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'A' }],
        }, {
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 'B',
            marks: [{ type: 'bold' }],
          }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 5, endIndex: 8 },
      },
    },
    {
      insertText: {
        location: { index: 5 },
        text: 'A\nB',
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 6 },
        textStyle: {
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
        },
        fields: 'bold,italic,underline,strikethrough,foregroundColor,backgroundColor,fontSize,weightedFontFamily,link',
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: 7, endIndex: 8 },
        textStyle: {
          bold: true,
          italic: false,
          underline: false,
          strikethrough: false,
        },
        fields: 'bold,italic,underline,strikethrough,foregroundColor,backgroundColor,fontSize,weightedFontFamily,link',
      },
    },
  ])
})

test('table upsync: multiple changed cells remain cell-content-only and patch in descending index order', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 10,
    endIndex: 27,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [{
        startIndex: 11,
        endIndex: 26,
        tableCells: [{
          startIndex: 12,
          endIndex: 19,
          content: [{
            startIndex: 13,
            endIndex: 19,
            paragraph: {
              elements: [{ textRun: { content: 'Alpha\n' } }],
            },
          }],
        }, {
          startIndex: 19,
          endIndex: 26,
          content: [{
            startIndex: 20,
            endIndex: 26,
            paragraph: {
              elements: [{ textRun: { content: 'Beta\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'A' }],
        }],
      }, {
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Beta plus' }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'cell-content-only')
  assert.deepEqual(result.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 20, endIndex: 25 },
      },
    },
    {
      insertText: {
        location: { index: 20 },
        text: 'Beta plus',
      },
    },
    {
      deleteContentRange: {
        range: { startIndex: 13, endIndex: 18 },
      },
    },
    {
      insertText: {
        location: { index: 13 },
        text: 'A',
      },
    },
  ])
})

test('table upsync planner: multiple changed tables aggregate one descending-index batch', () => {
  const baseTable = (startIndex, text) => {
    const contentStartIndex = startIndex + 3
    const contentEndIndex = contentStartIndex + text.length + 1
    return parseGoogleTableElement({
      startIndex,
      endIndex: contentEndIndex + 1,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: startIndex + 1,
          endIndex: contentEndIndex,
          tableCells: [{
            startIndex: startIndex + 2,
            endIndex: contentEndIndex,
            content: [{
              startIndex: contentStartIndex,
              endIndex: contentEndIndex,
              paragraph: {
                elements: [{ textRun: { content: `${text}\n` } }],
              },
            }],
          }],
        }],
      },
    }, {})
  }
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'A' }],
          }],
        }],
      }],
    }, {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'BetaPlus' }],
          }],
        }],
      }],
    }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [baseTable(10, 'Alpha'), baseTable(40, 'Beta')],
      },
      localDoc,
    }),
    [
      {
        deleteContentRange: {
          range: { startIndex: 43, endIndex: 47 },
        },
      },
      {
        insertText: {
          location: { index: 43 },
          text: 'BetaPlus',
        },
      },
      {
        deleteContentRange: {
          range: { startIndex: 13, endIndex: 18 },
        },
      },
      {
        insertText: {
          location: { index: 13 },
          text: 'A',
        },
      },
    ],
  )
})

test('table upsync planner: deleting a whole table removes its indexed range', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 11,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 10,
        tableCells: [{
          startIndex: 4,
          endIndex: 10,
          content: [{
            startIndex: 5,
            endIndex: 10,
            paragraph: {
              elements: [{ textRun: { content: 'Keep\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: { elements: [baseTable] },
      localDoc,
    }),
    [{
      deleteContentRange: {
        range: { startIndex: 2, endIndex: 11 },
      },
    }],
  )
})

test('table upsync planner: deleting one table preserves the later table', () => {
  const indexedTable = (startIndex, text) => {
    const contentStartIndex = startIndex + 3
    const contentEndIndex = contentStartIndex + text.length + 1
    return parseGoogleTableElement({
      startIndex,
      endIndex: contentEndIndex + 1,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: startIndex + 1,
          endIndex: contentEndIndex,
          tableCells: [{
            startIndex: startIndex + 2,
            endIndex: contentEndIndex,
            content: [{
              startIndex: contentStartIndex,
              endIndex: contentEndIndex,
              paragraph: {
                elements: [{ textRun: { content: `${text}\n` } }],
              },
            }],
          }],
        }],
      },
    }, {})
  }
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'Other' }],
          }],
        }],
      }],
    }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [indexedTable(2, 'Keep'), indexedTable(20, 'Other')],
      },
      localDoc,
    }),
    [{
      deleteContentRange: {
        range: { startIndex: 2, endIndex: 11 },
      },
    }],
  )
})

test('table upsync planner: deleting multiple tables emits descending ranges', () => {
  const indexedTable = (startIndex, text) => {
    const contentStartIndex = startIndex + 3
    const contentEndIndex = contentStartIndex + text.length + 1
    return parseGoogleTableElement({
      startIndex,
      endIndex: contentEndIndex + 1,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: startIndex + 1,
          endIndex: contentEndIndex,
          tableCells: [{
            startIndex: startIndex + 2,
            endIndex: contentEndIndex,
            content: [{
              startIndex: contentStartIndex,
              endIndex: contentEndIndex,
              paragraph: {
                elements: [{ textRun: { content: `${text}\n` } }],
              },
            }],
          }],
        }],
      },
    }, {})
  }
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'Other' }],
          }],
        }],
      }],
    }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [
          indexedTable(2, 'Keep'),
          indexedTable(20, 'Other'),
          indexedTable(40, 'Third'),
        ],
      },
      localDoc,
    }),
    [
      { deleteContentRange: { range: { startIndex: 40, endIndex: 50 } } },
      { deleteContentRange: { range: { startIndex: 2, endIndex: 11 } } },
    ],
  )
})

test('table upsync planner: inserting a new table after an indexed paragraph', () => {
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'paragraph',
    }, {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{ type: 'paragraph' }],
        }],
      }],
    }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [{
          kind: 'paragraph',
          startIndex: 1,
          endIndex: 2,
          tiptap: { type: 'paragraph' },
        }],
      },
      localDoc,
    }),
    [{
      insertTable: {
        rows: 1,
        columns: 1,
        location: { index: 1 },
      },
    }],
  )
})

test('table upsync planner: inserting a table after an existing table', () => {
  const emptyTable = () => ({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }],
  })
  const baseDocument = {
    elements: [
      {
        kind: 'paragraph',
        startIndex: 1,
        endIndex: 2,
        tiptap: { type: 'paragraph' },
      },
      parseGoogleTableElement(emptyGoogleTable(2), {}),
      {
        kind: 'paragraph',
        startIndex: 7,
        endIndex: 8,
        tiptap: { type: 'paragraph' },
      },
    ],
  }
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph' },
      emptyTable(),
      { type: 'paragraph' },
      emptyTable(),
    ],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({ baseDocument, localDoc }),
    [{
      insertTable: {
        rows: 1,
        columns: 1,
        location: { index: 7 },
      },
    }],
  )
})

test('table upsync planner: inserting a table before the first paragraph', () => {
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{ type: 'paragraph' }],
        }],
      }],
    }, {
      type: 'paragraph',
    }],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [{
          kind: 'paragraph',
          startIndex: 1,
          endIndex: 2,
          tiptap: { type: 'paragraph' },
        }],
      },
      localDoc,
    }),
    [{
      insertTable: {
        rows: 1,
        columns: 1,
        location: { index: 1 },
      },
    }],
  )
})

test('table upsync planner: inserting two tables after distinct paragraphs', () => {
  const emptyTable = () => ({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }],
  })
  const paragraph = (text, startIndex, endIndex) => ({
    kind: 'paragraph',
    startIndex,
    endIndex,
    tiptap: {
      type: 'paragraph',
      content: [{ type: 'text', text }],
    },
  })
  const localDoc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'A' }],
    }, emptyTable(), {
      type: 'paragraph',
      content: [{ type: 'text', text: 'B' }],
    }, emptyTable()],
  })

  assert.deepEqual(
    googleDocsUpsync.buildGoogleDocsSyncRequests({
      baseDocument: {
        elements: [paragraph('A', 1, 3), paragraph('B', 3, 5)],
      },
      localDoc,
    }),
    [
      { insertTable: { rows: 1, columns: 1, location: { index: 4 } } },
      { insertTable: { rows: 1, columns: 1, location: { index: 2 } } },
    ],
  )
})

test('table upsync: inserted row uses the native Google table row request', () => {
  const baseTable = parseGoogleTableElement(emptyGoogleTable(2), {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }, {
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  }])
})

test('table upsync: deleted row uses the native Google table row request', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 20,
    table: {
      rows: 2,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 10,
        tableCells: [{
          startIndex: 4,
          endIndex: 10,
          content: [{
            startIndex: 5,
            endIndex: 10,
            paragraph: {
              elements: [{ textRun: { content: 'Keep\n' } }],
            },
          }],
        }],
      }, {
        startIndex: 10,
        endIndex: 19,
        tableCells: [{
          startIndex: 11,
          endIndex: 19,
          content: [{
            startIndex: 12,
            endIndex: 19,
            paragraph: {
              elements: [{ textRun: { content: 'Delete\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep' }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 1,
        columnIndex: 0,
      },
    },
  }])
})

test('table upsync: deleted middle row targets its original Google row index', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 28,
    table: {
      rows: 3,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 9,
        tableCells: [{
          startIndex: 4,
          endIndex: 9,
          content: [{
            startIndex: 5,
            endIndex: 9,
            paragraph: {
              elements: [{ textRun: { content: 'Top\n' } }],
            },
          }],
        }],
      }, {
        startIndex: 9,
        endIndex: 18,
        tableCells: [{
          startIndex: 10,
          endIndex: 18,
          content: [{
            startIndex: 11,
            endIndex: 18,
            paragraph: {
              elements: [{ textRun: { content: 'Remove\n' } }],
            },
          }],
        }],
      }, {
        startIndex: 18,
        endIndex: 27,
        tableCells: [{
          startIndex: 19,
          endIndex: 27,
          content: [{
            startIndex: 20,
            endIndex: 27,
            paragraph: {
              elements: [{ textRun: { content: 'Bottom\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: ['Top', 'Bottom'].map((text) => ({
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }],
      }],
    })),
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 1,
        columnIndex: 0,
      },
    },
  }])
})

test('table upsync: inserted middle row targets its preceding Google row index', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 19,
    table: {
      rows: 2,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 9,
        tableCells: [{
          startIndex: 4,
          endIndex: 9,
          content: [{
            startIndex: 5,
            endIndex: 9,
            paragraph: {
              elements: [{ textRun: { content: 'Top\n' } }],
            },
          }],
        }],
      }, {
        startIndex: 9,
        endIndex: 18,
        tableCells: [{
          startIndex: 10,
          endIndex: 18,
          content: [{
            startIndex: 11,
            endIndex: 18,
            paragraph: {
              elements: [{ textRun: { content: 'Bottom\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: ['Top', 'New', 'Bottom'].map((text) => ({
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }],
      }],
    })),
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  }])
})

test('table upsync: appended column uses the native Google table column request', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 11,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 3,
        endIndex: 10,
        tableCells: [{
          startIndex: 4,
          endIndex: 10,
          content: [{
            startIndex: 5,
            endIndex: 10,
            paragraph: {
              elements: [{ textRun: { content: 'Keep\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep' }],
        }],
      }, {
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    insertTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertRight: true,
    },
  }])
})

test('table upsync: inserted middle column targets its preceding Google column index', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 19,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [{
        startIndex: 3,
        endIndex: 18,
        tableCells: [{
          startIndex: 4,
          endIndex: 10,
          content: [{
            startIndex: 5,
            endIndex: 10,
            paragraph: {
              elements: [{ textRun: { content: 'Left\n' } }],
            },
          }],
        }, {
          startIndex: 10,
          endIndex: 17,
          content: [{
            startIndex: 11,
            endIndex: 17,
            paragraph: {
              elements: [{ textRun: { content: 'Right\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: ['Left', 'New', 'Right'].map((text) => ({
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }],
      })),
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    insertTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 0,
      },
      insertRight: true,
    },
  }])
})

test('table upsync: deleted trailing column uses the native Google table column request', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 20,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [{
        startIndex: 3,
        endIndex: 19,
        tableCells: [{
          startIndex: 4,
          endIndex: 10,
          content: [{
            startIndex: 5,
            endIndex: 10,
            paragraph: {
              elements: [{ textRun: { content: 'Keep\n' } }],
            },
          }],
        }, {
          startIndex: 10,
          endIndex: 18,
          content: [{
            startIndex: 11,
            endIndex: 18,
            paragraph: {
              elements: [{ textRun: { content: 'Delete\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep' }],
        }],
      }],
    }],
  })

  const result = googleDocsUpsync.tableUpsyncRequests(baseTable, localTable)

  assert.equal(result.classification, 'row/column structural')
  assert.deepEqual(result.requests, [{
    deleteTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: 2 },
        rowIndex: 0,
        columnIndex: 1,
      },
    },
  }])
})

test('table upsync: ambiguous identical-column insertion is rejected', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 10,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [{
        startIndex: 3,
        endIndex: 9,
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
        }, {
          startIndex: 6,
          endIndex: 8,
          content: [{
            startIndex: 7,
            endIndex: 8,
            paragraph: {
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: Array.from({ length: 3 }, () => ({
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      })),
    }],
  })

  assert.throws(
    () => googleDocsUpsync.tableUpsyncRequests(baseTable, localTable),
    /table column structure changed/,
  )
})

test('table upsync: ambiguous identical-row insertion is rejected', () => {
  const baseTable = parseGoogleTableElement({
    startIndex: 2,
    endIndex: 10,
    table: {
      rows: 2,
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
      }, {
        startIndex: 6,
        endIndex: 9,
        tableCells: [{
          startIndex: 7,
          endIndex: 9,
          content: [{
            startIndex: 8,
            endIndex: 9,
            paragraph: {
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})
  const localTable = schema.nodeFromJSON({
    type: 'table',
    content: Array.from({ length: 3 }, () => ({
      type: 'tableRow',
      content: [{
        type: 'tableCell',
        content: [{ type: 'paragraph' }],
      }],
    })),
  })

  assert.throws(
    () => googleDocsUpsync.tableUpsyncRequests(baseTable, localTable),
    /table row structure changed/,
  )
})

test('table upsync: empty cell insertion uses parsed cell paragraph index', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{ type: 'paragraph' }],
        }],
      }],
    }, {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{ type: 'paragraph' }],
        }],
      }],
    }],
  })
  let paragraphPos = null
  let tableCount = 0
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') tableCount += 1
    if (node.type.name === 'paragraph' && tableCount === 2) paragraphPos = pos
  })
  assert.equal(tableCount, 2)
  assert.notEqual(paragraphPos, null)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphPos + 1),
  })
  const step = state.tr.insertText('t').steps[0]
  const baseTable = parseGoogleTableElement({
    startIndex: 10,
    endIndex: 15,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{
        startIndex: 11,
        endIndex: 14,
        tableCells: [{
          startIndex: 12,
          endIndex: 14,
          content: [{
            startIndex: 13,
            endIndex: 14,
            paragraph: {
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }],
      }],
    },
  }, {})

  const requests = stepToGoogleDocsRequests(step, doc, { baseTable })

  assert.deepEqual(requests, [{
    insertText: {
      location: { index: 13 },
      text: 't',
    },
  }])
})

function emptyGoogleTable(startIndex) {
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
              elements: [{ textRun: { content: '\n' } }],
            },
          }],
        }],
      }],
    },
  }
}

test('table upsync planner: pulled metadata routes a second-table transaction by position', () => {
  const googleDocument = {
    body: {
      content: [emptyGoogleTable(2), emptyGoogleTable(10)],
    },
  }
  const syncState = googleDocsDownsync.buildGoogleDocsSyncState(googleDocument)
  const doc = schema.nodeFromJSON(syncState.tiptapDocument)
  let paragraphPos = null
  let tableCount = 0
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') tableCount += 1
    if (node.type.name === 'paragraph' && tableCount === 2) paragraphPos = pos
  })
  assert.equal(tableCount, 2)
  assert.notEqual(paragraphPos, null)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphPos + 1),
  })
  const step = state.tr.insertText('t').steps[0]

  const requests = stepToGoogleDocsRequests(step, doc, {
    baseDocument: syncState.baseDocument,
  })

  assert.deepEqual(requests, [{
    insertText: {
      location: { index: 13 },
      text: 't',
    },
  }])
})

test('table upsync planner: rapid typing coalesces against the pulled cell base', () => {
  const googleDocument = {
    body: {
      content: [emptyGoogleTable(10)],
    },
  }
  const syncState = googleDocsDownsync.buildGoogleDocsSyncState(googleDocument)
  const doc = schema.nodeFromJSON(syncState.tiptapDocument)
  let paragraphPos = null
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') paragraphPos = pos
  })
  const firstState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphPos + 1),
  })
  const afterFirst = firstState.tr.insertText('t').doc
  const secondState = EditorState.create({
    doc: afterFirst,
    selection: TextSelection.create(afterFirst, paragraphPos + 2),
  })
  const localDoc = secondState.tr.insertText('e').doc

  assert.equal(localDoc.textContent, 'te')
  const requests = googleDocsUpsync.buildGoogleDocsSyncRequests({
    baseDocument: syncState.baseDocument,
    localDoc,
  })

  assert.deepEqual(requests, [{
    insertText: {
      location: { index: 13 },
      text: 'te',
    },
  }])
})

test('table upsync queue: rapid transactions produce one pending cell plan', () => {
  const googleDocument = {
    body: {
      content: [emptyGoogleTable(10)],
    },
  }
  const syncState = googleDocsDownsync.buildGoogleDocsSyncState(googleDocument)
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
  const queue = googleDocsUpsync.createGoogleDocsSyncQueue()
  queue.setBaseDocument(syncState.baseDocument)
  queue.recordTransaction(firstTransaction)
  queue.recordTransaction(secondTransaction)

  assert.deepEqual(queue.getPendingRequests(secondTransaction.doc), [{
    insertText: {
      location: { index: 13 },
      text: 'te',
    },
  }])

  queue.clear()
  assert.deepEqual(queue.getPendingRequests(secondTransaction.doc), [])
})

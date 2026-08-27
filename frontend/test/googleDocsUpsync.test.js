import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list'
import { kindredContentExtensions } from '../src/kindredSchema.js'
import { listNestingRequests, stepToGoogleDocsRequests } from '../src/googleDocsUpsync.js'

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

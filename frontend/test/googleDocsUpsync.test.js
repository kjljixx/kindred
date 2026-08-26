import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { sinkListItem } from '@tiptap/pm/schema-list'
import { kindredContentExtensions } from '../src/kindredSchema.js'
import { stepToGoogleDocsRequests } from '../src/googleDocsUpsync.js'

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
  return { step: transaction.steps[0] }
}

function requestKinds(requests) {
  return requests.map((request) => Object.keys(request)[0])
}

test('indent inserts temporary tab then creates bullets over affected paragraphs', () => {
  const { doc, step } = indentStep(listDoc(['one', 'two']), 'two')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requestKinds(requests), [
    'deleteParagraphBullets',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests[0], {
    deleteParagraphBullets: {
      range: { startIndex: 1, endIndex: 9 },
    },
  })
  assert.deepEqual(requests[1], {
    insertText: {
      location: { index: 5 },
      text: '\t',
    },
  })
  assert.deepEqual(requests[2], {
    createParagraphBullets: {
      range: { startIndex: 1, endIndex: 10 },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    },
  })
})

test('indent moves existing nested subtree with one-tab depth deltas', () => {
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
    'insertText',
    'insertText',
    'createParagraphBullets',
  ])
  assert.deepEqual(requests.slice(1, 3).map((request) => request.insertText.text), ['\t', '\t'])
  assert.deepEqual(requests[3], {
    createParagraphBullets: {
      range: { startIndex: 1, endIndex: 27 },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    },
  })
})

test('indent preserves ordered-list preset', () => {
  const doc = listDoc(['one', 'two'], 'orderedList')
  const { step } = indentStep(doc, 'two')
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.equal(requests.at(-1).createParagraphBullets.bulletPreset, 'NUMBERED_DECIMAL_ALPHA_ROMAN')
})

test('indent places empty item tab at empty paragraph start', () => {
  const doc = listDoc(['one', ''])
  const { step } = indentEmptyItemStep(doc)
  const requests = stepToGoogleDocsRequests(step, doc)

  assert.deepEqual(requests[1], {
    insertText: {
      location: { index: 5 },
      text: '\t',
    },
  })
  assert.deepEqual(requests[2].createParagraphBullets.range, {
    startIndex: 1,
    endIndex: 7,
  })
})

test('indent maps empty nested descendant after subtree move', () => {
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

  assert.deepEqual(requests.slice(1, 3), [
    { insertText: { location: { index: 14 }, text: '\t' } },
    { insertText: { location: { index: 8 }, text: '\t' } },
  ])
})

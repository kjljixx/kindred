import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildNestedLists,
  googleDocsToTipTap,
  parseParagraphElement,
  stripListTabs,
} from '../src/googleDocsDownsync.js'

const LIST_ID = 'kix.list'

function nestingLevels(orderedDepths = []) {
  const levels = orderedDepths.map(() => ({ glyphType: 'DECIMAL' }))
  while (levels.length < 9) levels.push({})
  return levels
}

function bulletBlock(text, nestingLevel, { ordered = false } = {}) {
  return {
    paragraph: {
      elements: [{ textRun: { content: `${text}\n` } }],
      bullet: { listId: LIST_ID, nestingLevel },
    },
    _ordered: ordered,
  }
}

function plainBlock(text) {
  return {
    paragraph: {
      elements: [{ textRun: { content: `${text}\n` } }],
    },
  }
}

function googleDocFromBlocks(blocks) {
  const orderedDepths = blocks
    .map((block, index) => (block._ordered ? index : null))
    .filter((value) => value !== null)
  const content = blocks.map(({ paragraph }) => ({ paragraph }))
  return {
    body: { content },
    lists: {
      [LIST_ID]: {
        listProperties: {
          nestingLevels: nestingLevels(orderedDepths.length ? [0] : []),
        },
      },
    },
  }
}

function googleDocWithOrderedRoot(blocks) {
  return {
    body: {
      content: blocks.map((block) => (
        block.paragraph ? { paragraph: block.paragraph } : block
      )),
    },
    lists: {
      [LIST_ID]: {
        listProperties: {
          nestingLevels: nestingLevels([0]),
        },
      },
    },
  }
}

function paragraphWithText(text) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  }
}

test('stripListTabs removes leading tabs only', () => {
  assert.equal(stripListTabs('\t\titem'), 'item')
  assert.equal(stripListTabs('item'), 'item')
  assert.equal(stripListTabs('\tone\ttwo'), 'one\ttwo')
})

test('downsync: flat bullet list', () => {
  const googleDoc = googleDocFromBlocks([
    bulletBlock('one', 0),
    bulletBlock('two', 0),
  ])
  const result = googleDocsToTipTap(googleDoc)

  assert.deepEqual(result, {
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraphWithText('one')] },
        { type: 'listItem', content: [paragraphWithText('two')] },
      ],
    }],
  })
})

test('downsync: flat ordered list', () => {
  const googleDoc = googleDocWithOrderedRoot([
    {
      paragraph: {
        elements: [{ textRun: { content: 'one\n' } }],
        bullet: { listId: LIST_ID, nestingLevel: 0 },
      },
    },
    {
      paragraph: {
        elements: [{ textRun: { content: 'two\n' } }],
        bullet: { listId: LIST_ID, nestingLevel: 0 },
      },
    },
  ])
  const result = googleDocsToTipTap(googleDoc)

  assert.equal(result.content[0].type, 'orderedList')
  assert.deepEqual(
    result.content[0].content.map((item) => item.content[0].content[0].text),
    ['one', 'two'],
  )
})

test('downsync: simple nested indent (outdent2)', () => {
  const googleDoc = googleDocFromBlocks([
    bulletBlock('ONE', 0),
    bulletBlock('\tTWO', 1),
    bulletBlock('\t\tTHREE', 2),
  ])
  const result = googleDocsToTipTap(googleDoc)

  assert.deepEqual(result.content[0], {
    type: 'bulletList',
    content: [{
      type: 'listItem',
      content: [
        paragraphWithText('ONE'),
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [
              paragraphWithText('TWO'),
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem',
                  content: [paragraphWithText('THREE')],
                }],
              },
            ],
          }],
        },
      ],
    }],
  })
})

test('downsync: outdent sibling case (outdent3)', () => {
  const googleDoc = googleDocFromBlocks([
    bulletBlock('ONE', 0),
    bulletBlock('\tTWO', 1),
    bulletBlock('\tTHREE', 1),
  ])
  const result = googleDocsToTipTap(googleDoc)

  assert.deepEqual(result.content[0], {
    type: 'bulletList',
    content: [{
      type: 'listItem',
      content: [
        paragraphWithText('ONE'),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraphWithText('TWO')] },
            { type: 'listItem', content: [paragraphWithText('THREE')] },
          ],
        },
      ],
    }],
  })
})

test('downsync: multi-level subtree (outdent4-style)', () => {
  const entries = [
    { text: 'test', level: 0 },
    { text: 'test', level: 1 },
    { text: 'test', level: 2 },
    { text: 'test123', level: 0 },
    { text: 'test2', level: 1 },
    { text: 'test3', level: 2 },
  ]
  const googleDoc = googleDocFromBlocks(
    entries.map(({ text, level }) => bulletBlock('\t'.repeat(level) + text, level)),
  )
  const result = googleDocsToTipTap(googleDoc)

  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'bulletList')
  assert.equal(result.content[0].content.length, 2)
  assert.equal(result.content[0].content[0].content.length, 2)
  assert.equal(result.content[0].content[0].content[1].type, 'bulletList')
  assert.equal(result.content[0].content[1].content.length, 2)
  assert.equal(result.content[0].content[1].content[1].type, 'bulletList')
})

test('downsync: leading tabs stripped from display text', () => {
  const element = {
    paragraph: {
      elements: [{ textRun: { content: '\t\titem\n' } }],
      bullet: { listId: LIST_ID, nestingLevel: 2 },
    },
  }
  const googleDoc = {
    lists: { [LIST_ID]: { listProperties: { nestingLevels: nestingLevels() } } },
  }
  const parsed = parseParagraphElement(element, googleDoc)

  assert.equal(parsed.paragraph.content[0].text, 'item')
})

test('downsync: empty nested list item keeps paragraph', () => {
  const element = {
    paragraph: {
      elements: [],
      bullet: { listId: LIST_ID, nestingLevel: 1 },
    },
  }
  const googleDoc = {
    lists: { [LIST_ID]: { listProperties: { nestingLevels: nestingLevels() } } },
  }
  const parsed = parseParagraphElement(element, googleDoc)
  const lists = buildNestedLists([parsed])

  assert.deepEqual(lists, [{
    type: 'bulletList',
    content: [{
      type: 'listItem',
      content: [
        { type: 'paragraph' },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{ type: 'paragraph' }],
          }],
        },
      ],
    }],
  }])
})

test('downsync: list break inserts plain paragraph between root lists', () => {
  const googleDoc = googleDocFromBlocks([
    bulletBlock('one', 0),
    bulletBlock('two', 0),
    plainBlock('break'),
    bulletBlock('three', 0),
    bulletBlock('four', 0),
  ])
  const result = googleDocsToTipTap(googleDoc)

  assert.equal(result.content.length, 3)
  assert.equal(result.content[0].type, 'bulletList')
  assert.equal(result.content[1].type, 'paragraph')
  assert.equal(result.content[1].content[0].text, 'break')
  assert.equal(result.content[2].type, 'bulletList')
  assert.deepEqual(
    result.content[2].content.map((item) => item.content[0].content[0].text),
    ['three', 'four'],
  )
})

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/fixtures',
)

function loadProbeFixture(name) {
  const raw = readFileSync(path.join(fixtureDir, `${name}_doc.json`), 'utf8').replace(/^\uFEFF/, '')
  const payload = JSON.parse(raw)
  const listIds = new Set()
  for (const block of payload.body?.content || []) {
    const listId = block.paragraph?.bullet?.listId
    if (listId) listIds.add(listId)
  }
  const lists = Object.fromEntries(
    [...listIds].map((listId) => [listId, { listProperties: { nestingLevels: [{}, {}, {}] } }]),
  )
  return { body: payload.body, lists }
}

test('downsync: probe fixture outdent2 builds nested tree', () => {
  const result = googleDocsToTipTap(loadProbeFixture('outdent2'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'bulletList')
  assert.equal(result.content[0].content[0].content[1].type, 'bulletList')
  assert.equal(
    result.content[0].content[0].content[1].content[0].content[1].type,
    'bulletList',
  )
})

test('downsync: probe fixture outdent3 keeps TWO nested under ONE', () => {
  const result = googleDocsToTipTap(loadProbeFixture('outdent3'))
  const root = result.content[0]
  assert.equal(root.type, 'bulletList')
  assert.equal(root.content[0].content[0].content[0].text, 'ONE')
  assert.equal(root.content[0].content[1].type, 'bulletList')
  assert.equal(root.content[0].content[1].content[0].content[0].content[0].text, 'TWO')
})

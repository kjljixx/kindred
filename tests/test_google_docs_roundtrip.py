"""Headless Google Docs Push -> Pull round-trip contract tests.

Run with ``RUN_GOOGLE_DOCS_E2E=1 pytest tests/test_google_docs_roundtrip.py -q``.
"""

from __future__ import annotations

import json
import os

import pytest

from google_docs_harness import run_google_docs_harness
from test_google_docs_pull import _document, _docs_request, _token


LIST_FIXTURE_LINES = [
  "Plain one",
  "Plain two",
  "Ordered one",
  "Ordered two",
  "Between lists",
  "Unordered one",
  "Unordered two",
  "\tNested bullet",
  "Tail paragraph",
]


class RoundTripContentMismatch(AssertionError):
  """The Push completed, but pulling it produced different editor content."""


def _paragraph_text(block: dict) -> str:
  return "".join(
    element.get("textRun", {}).get("content", "")
    for element in block.get("paragraph", {}).get("elements", [])
  ).rstrip("\n")


def _paragraph(document: dict, needle: str) -> dict:
  matches = [
    block
    for block in document.get("body", {}).get("content", [])
    if "paragraph" in block and _paragraph_text(block).lstrip("\t") == needle
  ]
  if len(matches) != 1:
    raise AssertionError(f"Fixture paragraph {needle!r} resolved {len(matches)} times")
  return matches[0]


def _reset_list_fixture(token: str) -> dict:
  current = _document(token)
  tables = [block for block in current["body"]["content"] if "table" in block]
  for block in reversed(tables):
    _docs_request(token, [
      {"deleteTableRow": {"tableCellLocation": {
        "tableStartLocation": {"index": block["startIndex"]},
        "rowIndex": 0,
        "columnIndex": 0,
      }}}
      for _ in block["table"]["tableRows"]
    ])

  current = _document(token)
  end_index = current["body"]["content"][-1]["endIndex"] - 1
  requests = []
  if end_index > 1:
    requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index}}})
  requests.append({"insertText": {
    "location": {"index": 1},
    "text": "\n".join(LIST_FIXTURE_LINES),
  }})
  _docs_request(token, requests)

  inserted = _document(token)
  fixture_end = inserted["body"]["content"][-1]["endIndex"] - 1
  _docs_request(token, [{"deleteParagraphBullets": {
    "range": {"startIndex": 1, "endIndex": fixture_end},
  }}])
  inserted = _document(token)
  ordered_start = _paragraph(inserted, "Ordered one")["startIndex"]
  ordered_end = _paragraph(inserted, "Ordered two")["endIndex"] - 1
  unordered_start = _paragraph(inserted, "Unordered one")["startIndex"]
  unordered_end = _paragraph(inserted, "Nested bullet")["endIndex"] - 1
  _docs_request(token, [
    {"createParagraphBullets": {
      "range": {"startIndex": ordered_start, "endIndex": ordered_end},
      "bulletPreset": "NUMBERED_DECIMAL_ALPHA_ROMAN",
    }},
    {"createParagraphBullets": {
      "range": {"startIndex": unordered_start, "endIndex": unordered_end},
      "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
    }},
  ])

  document = _document(token)
  ordered = _paragraph(document, "Ordered one")["paragraph"].get("bullet")
  unordered = _paragraph(document, "Unordered one")["paragraph"].get("bullet")
  nested = _paragraph(document, "Nested bullet")["paragraph"].get("bullet")
  tail = _paragraph(document, "Tail paragraph")["paragraph"].get("bullet")
  if not ordered or not unordered or not nested or nested.get("nestingLevel") != 1 or tail:
    raise AssertionError(
      "Google Docs list fixture did not acquire the expected structure: "
      f"ordered={ordered}, unordered={unordered}, nested={nested}, tail={tail}"
    )
  return document


def _expected_failure(*values, id: str):
  return pytest.param(
    *values,
    id=id,
    marks=pytest.mark.xfail(
      strict=True,
      raises=RoundTripContentMismatch,
      reason="list structural upsync is not implemented",
    ),
  )


def _state(text: str, list_type: str | None, nesting_level: int | None = None) -> dict:
  return {"text": text, "listType": list_type, "nestingLevel": nesting_level}


LIST_CASES = [
  pytest.param(
    "edits_existing_item_text",
    [{"type": "insert-text", "needle": "Ordered one", "cursor": "end", "text": "!"}],
    [_state("Ordered one!", "ordered", 0)],
    id="edits-existing-item-text",
  ),
  pytest.param(
    "deletes_existing_item_text",
    [{"type": "delete-selection", "needle": "Ordered"}],
    [_state(" one", "ordered", 0)],
    id="deletes-existing-item-text",
  ),
  pytest.param(
    "creates_single_bullet_item",
    [{"type": "bullet", "needle": "Plain one", "paragraph": True}],
    [_state("Plain one", "bullet", 0)],
    id="creates-single-bullet-item",
  ),
  pytest.param(
    "creates_single_ordered_item",
    [{"type": "ordered", "needle": "Plain one", "paragraph": True}],
    [_state("Plain one", "ordered", 0)],
    id="creates-single-ordered-item",
  ),
  pytest.param(
    "creates_multi_item_list",
    [{"type": "bullet", "needle": "Plain one", "lastParagraph": "Plain two", "paragraph": True}],
    [_state("Plain one", "bullet", 0), _state("Plain two", "bullet", 0)],
    id="creates-multi-item-list",
  ),
  pytest.param(
    "removes_single_item_from_list",
    [{"type": "lift", "needle": "Ordered one", "cursor": "start"}],
    [_state("Ordered one", None)],
    id="removes-single-item-from-list",
  ),
  pytest.param(
    "removes_multi_item_list",
    [{"type": "ordered", "needle": "Ordered one", "lastParagraph": "Ordered two", "paragraph": True}],
    [_state("Ordered one", None), _state("Ordered two", None)],
    id="removes-multi-item-list",
  ),
  pytest.param(
    "switches_bullet_list_to_ordered",
    [{"type": "ordered", "needle": "Unordered one", "cursor": "start"}],
    [_state("Unordered one", "ordered", 0)],
    id="switches-bullet-list-to-ordered",
  ),
  pytest.param(
    "switches_ordered_list_to_bullet",
    [{"type": "bullet", "needle": "Ordered one", "cursor": "start"}],
    [_state("Ordered one", "bullet", 0)],
    id="switches-ordered-list-to-bullet",
  ),
  pytest.param(
    "splits_item_in_the_middle",
    [{"type": "split", "needle": "Unordered", "cursor": "end"}],
    [_state("Unordered", "bullet", 0), _state(" one", "bullet", 0)],
    id="splits-item-in-the-middle",
  ),
  pytest.param(
    "creates_empty_item_at_list_end",
    [{"type": "split", "needle": "Ordered one", "cursor": "end"}],
    [_state("", "ordered", 0)],
    id="creates-empty-item-at-list-end",
  ),
  pytest.param(
    "exits_list_from_empty_item",
    [
      {"type": "split", "needle": "Ordered one", "cursor": "end"},
      {"type": "enter", "useCurrentSelection": True},
    ],
    [_state("", None)],
    id="exits-list-from-empty-item",
  ),
  pytest.param(
    "lifts_item_with_first_backspace_behavior",
    [{"type": "lift", "needle": "Ordered two", "cursor": "start"}],
    [_state("Ordered two", None)],
    id="lifts-item-with-first-backspace-behavior",
  ),
  pytest.param(
    "merges_following_paragraph_with_previous_item",
    [
      {"type": "backspace", "needle": "Between lists", "cursor": "start"},
      {"type": "backspace", "needle": "Between lists", "cursor": "start"},
    ],
    [_state("Ordered twoBetween lists", "ordered", 0)],
    id="merges-following-paragraph-with-previous-item",
  ),
  pytest.param(
    "indents_list_item",
    [{"type": "sink", "needle": "Unordered two", "cursor": "start"}],
    [_state("Unordered two", "bullet", 1)],
    id="indents-list-item",
  ),
  pytest.param(
    "outdents_nested_list_item",
    [{"type": "lift", "needle": "Nested bullet", "cursor": "start"}],
    [_state("Nested bullet", "bullet", 0)],
    id="outdents-nested-list-item",
  ),
  _expected_failure(
    "pastes_multiple_items_into_list",
    [{
      "type": "paste-paragraphs",
      "needle": "Unordered one",
      "cursor": "end",
      "paragraphs": ["Pasted one", "Pasted two"],
    }],
    [_state("Pasted one", "bullet", 0), _state("Pasted two", "bullet", 0)],
    id="pastes-multiple-items-into-list",
  ),
  pytest.param(
    "deletes_whole_list_item",
    [{"type": "delete-list-item", "needle": "Unordered two", "listItem": True}],
    [{"absent": "Unordered two"}, _state("Unordered one", "bullet", 0)],
    id="deletes-whole-list-item",
  ),
]


def _assert_editor_outcome(paragraphs: list[dict], expected: list[dict]) -> None:
  for expectation in expected:
    if "absent" in expectation:
      if any(paragraph["text"] == expectation["absent"] for paragraph in paragraphs):
        raise AssertionError(f"Headless editor still contains {expectation['absent']!r}")
      continue
    if expectation not in paragraphs:
      raise AssertionError(
        f"Headless editor did not produce {expectation}; paragraphs={paragraphs}"
      )


def _print_push_debug(name: str, pushed: dict) -> None:
  print(f"[{name}] PM={json.dumps(pushed['transactions'], separators=(',', ':'))}")
  print(f"[{name}] Docs={json.dumps(pushed['requestSummary'], separators=(',', ':'))}")


@pytest.mark.google_docs
@pytest.mark.parametrize(("name", "operations", "expected"), LIST_CASES)
def test_google_docs_list_push_pull_round_trip(name: str, operations: list[dict], expected: list[dict]):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")

  token = _token()
  source = _reset_list_fixture(token)
  pushed = run_google_docs_harness({
    "action": "list-operations",
    "googleDocument": source,
    "operations": operations,
  })
  _assert_editor_outcome(pushed["afterParagraphs"], expected)
  _print_push_debug(name, pushed)

  if pushed["requests"]:
    _docs_request(token, pushed["requests"])
  pulled = run_google_docs_harness({"action": "pull", "googleDocument": _document(token)})

  if pulled["document"] != pushed["after"]:
    raise RoundTripContentMismatch(
      f"Pulled paragraphs differ: expected={pushed['afterParagraphs']}; actual={pulled['paragraphs']}"
    )

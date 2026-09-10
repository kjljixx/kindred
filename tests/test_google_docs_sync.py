"""Python assertions for headless Google Docs sync scenarios."""

from __future__ import annotations

import pytest

from google_docs_harness import run_google_docs_harness


def _text(value: str, marks: list[dict] | None = None) -> dict:
  return {"type": "text", "text": value, **({"marks": marks} if marks else {})}


def _paragraph(*content: dict) -> dict:
  return {"type": "paragraph", "content": list(content)}


def test_google_docs_position_mapping_across_supported_content():
  document = {
    "type": "doc",
    "content": [
      _paragraph(_text("Plain paragraph")),
      _paragraph(_text("Bold", [{"type": "bold"}]), _text(" and italic", [{"type": "italic"}])),
      {"type": "orderedList", "content": [{"type": "listItem", "content": [_paragraph(_text("Ordered one"))]}]},
      _paragraph(_text("Break"), {"type": "hardBreak"}, _text("after")),
      {"type": "image", "attrs": {"src": "https://example.com/image.png"}},
    ],
  }
  result = run_google_docs_harness({"action": "position-map", "document": document, "positions": [1]})

  assert result["pointCount"] > 20
  assert result["positions"] == [1]
  assert result["pointValues"] == sorted(result["pointValues"])


def test_google_docs_position_mapping_uses_nearest_preceding_boundary():
  document = {"type": "doc", "content": [_paragraph(_text("abcd"))]}
  result = run_google_docs_harness({
    "action": "position-map",
    "document": document,
    "positions": [],
    "nearestPositions": [3, 4],
  })

  assert result["nearestPositions"] == [3, 4]


def test_google_docs_position_mapping_counts_breaks_tables_and_images():
  document = {
    "type": "doc",
    "content": [
      _paragraph(_text("Break"), {"type": "hardBreak"}, _text("after")),
      {"type": "table", "content": [{"type": "tableRow", "content": [
        {"type": "tableCell", "content": [_paragraph(_text("A"))]},
        {"type": "tableCell", "content": [_paragraph(_text("B"))]},
      ]}]},
      {"type": "image", "attrs": {"src": "https://example.com/image.png"}},
    ],
  }
  result = run_google_docs_harness({
    "action": "position-map",
    "document": document,
    "positions": [6, 7, 17, 22, 27],
  })

  assert result["positions"] == [6, 7, 16, 19, 22]


def test_google_docs_position_mapping_maps_table_start():
  document = {
    "type": "doc",
    "content": [
      _paragraph(_text("before")),
      {"type": "table", "content": [{"type": "tableRow", "content": [
        {"type": "tableCell", "content": [_paragraph(_text("cell"))]},
      ]}]},
    ],
  }
  result = run_google_docs_harness({"action": "position-map", "document": document, "positions": [8]})

  assert result["positions"] == [8]


@pytest.mark.parametrize(
  ("command", "operation", "request_type"),
  [
    ("addRowAfter", "insert-row", "insertTableRow"),
    ("deleteRow", "delete-row", "deleteTableRow"),
    ("addColumnAfter", "insert-column", "insertTableColumn"),
    ("deleteColumn", "delete-column", "deleteTableColumn"),
  ],
)
def test_google_docs_table_structure_push(command: str, operation: str, request_type: str):
  result = run_google_docs_harness({"action": "unit", "scenario": f"table:{command}"})

  assert result["operationTypes"] == [operation]
  assert result["suppressedStepCount"] == result["stepCount"]
  assert len(result["requests"]) == 1
  assert request_type in result["requests"][0]


def test_google_docs_delete_table_push():
  result = run_google_docs_harness({"action": "unit", "scenario": "table:deleteTable"})

  assert result["operationTypes"] == ["delete-table"]
  assert list(result["requests"][0]) == ["deleteContentRange"]


def test_google_docs_delete_column_suppresses_helper_steps():
  result = run_google_docs_harness({"action": "unit", "scenario": "table:deleteColumn"})

  assert result["stepCount"] > 1
  assert result["suppressedStepCount"] == result["stepCount"]
  assert list(result["requests"][0]) == ["deleteTableColumn"]


def test_google_docs_center_alignment_push():
  result = run_google_docs_harness({"action": "unit", "scenario": "alignment:center"})

  assert result["requests"] == [{
    "updateParagraphStyle": {
      "range": {"startIndex": 1, "endIndex": 11},
      "paragraphStyle": {"alignment": "CENTER"},
      "fields": "alignment",
    },
  }]


def test_google_docs_right_alignment_push():
  result = run_google_docs_harness({"action": "unit", "scenario": "alignment:right"})

  assert [request["updateParagraphStyle"]["paragraphStyle"]["alignment"] for request in result["requests"]] == ["END", "END"]
  assert [request["updateParagraphStyle"]["range"] for request in result["requests"]] == [
    {"startIndex": 7, "endIndex": 14},
    {"startIndex": 1, "endIndex": 7},
  ]


def test_google_docs_queued_transactions_push_in_order():
  result = run_google_docs_harness({"action": "unit", "scenario": "queued-transactions"})

  assert result["requests"] == [
    {"insertText": {"location": {"index": 1}, "text": "A"}},
    {"insertText": {"location": {"index": 2}, "text": "B"}},
  ]

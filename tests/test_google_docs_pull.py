"""Google Docs -> Kindred pull contract test.

Run with ``RUN_GOOGLE_DOCS_E2E=1 pytest tests/test_google_docs_pull.py -q``.
The test uses ADC credentials, so normal local/CI test runs skip it.
"""

from __future__ import annotations

import os
from pathlib import Path
import httpx
import pytest
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest
from selenium.webdriver.common.by import By


DOCUMENT_ID = "1sADU8OrbDmZW1VyuaARqjVNjmWLHl2wWl3R71WkCEDI"
IMAGE_URL = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png"
FIXTURE_TEXT = (
  "Plain paragraph\nStyled paragraph\nOrdered one\nOrdered two\n"
  "Unordered one\nUnordered two\nNested bullet\nBreak before this\n"
  "Linked text\n"
)


def _token() -> str:
  environment = Path(__file__).resolve().parents[1] / ".env"
  if environment.exists() and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    for line in environment.read_text(encoding="utf-8").splitlines():
      key, separator, value = line.partition("=")
      if key.strip() == "GOOGLE_APPLICATION_CREDENTIALS" and separator:
        os.environ[key.strip()] = value.strip().strip('"').strip("'")
        break
  credentials, _ = google_auth_default(scopes=["https://www.googleapis.com/auth/documents"])
  if not credentials.valid:
    credentials.refresh(GoogleAuthRequest())
  return credentials.token


def _docs_request(token: str, requests: list[dict]) -> dict:
  response = httpx.post(
    f"https://docs.googleapis.com/v1/documents/{DOCUMENT_ID}:batchUpdate",
    headers={"Authorization": f"Bearer {token}"},
    json={"requests": requests},
    timeout=30,
  )
  if response.is_error:
    raise AssertionError(f"Google Docs batchUpdate failed: {response.text}")
  response.raise_for_status()
  return response.json()


def _document(token: str) -> dict:
  response = httpx.get(
    f"https://docs.googleapis.com/v1/documents/{DOCUMENT_ID}",
    headers={"Authorization": f"Bearer {token}"},
    timeout=30,
  )
  response.raise_for_status()
  return response.json()


def reset_and_populate_google_doc(token: str) -> dict:
  """Reset shared fixture doc, then add every supported pull element."""
  current = _document(token)
  tables = [block for block in current["body"]["content"] if "table" in block]
  for block in reversed(tables):
    table_start = block["startIndex"]
    _docs_request(token, [
      {"deleteTableRow": {"tableCellLocation": {
        "tableStartLocation": {"index": table_start}, "rowIndex": 0, "columnIndex": 0,
      }}}
      for _ in block["table"]["tableRows"]
    ])
  current = _document(token)
  end = current["body"]["content"][-1]["endIndex"] - 1
  requests: list[dict] = [{"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end}}}]
  requests.append({"insertText": {"location": {"index": 1}, "text": FIXTURE_TEXT}})

  # Newlines cover the Google Docs paragraph/break boundary; no headings are created.
  requests.extend([
    {"updateTextStyle": {"range": {"startIndex": 1, "endIndex": 17}, "textStyle": {"bold": True}, "fields": "bold"}},
    {"updateTextStyle": {"range": {"startIndex": 18, "endIndex": 35}, "textStyle": {"italic": True, "foregroundColor": {"color": {"rgbColor": {"red": 0.8}}}}, "fields": "italic,foregroundColor"}},
    {"updateTextStyle": {"range": {"startIndex": 119, "endIndex": 131}, "textStyle": {"link": {"url": "https://example.com/kindred"}}, "fields": "link"}},
    {"createParagraphBullets": {"range": {"startIndex": 36, "endIndex": 58}, "bulletPreset": "NUMBERED_DECIMAL_ALPHA_ROMAN"}},
    {"createParagraphBullets": {"range": {"startIndex": 59, "endIndex": 104}, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}},
    {"updateParagraphStyle": {"range": {"startIndex": 104, "endIndex": 121}, "paragraphStyle": {"indentStart": {"magnitude": 36, "unit": "PT"}}, "fields": "indentStart"}},
  ])
  _docs_request(token, requests)

  # Structural elements inserted at document start keep fixture text stable.
  _docs_request(token, [{"insertTable": {"location": {"index": 1}, "rows": 2, "columns": 2}}])
  table = next(block["table"] for block in _document(token)["body"]["content"] if "table" in block)
  cells = [
    cell
    for row in table["tableRows"]
    for cell in row["tableCells"]
  ]
  _docs_request(token, [
    {"insertText": {"location": {"index": cell["content"][0]["startIndex"]}, "text": f"Table {index}"}}
    for index, cell in reversed(list(enumerate(cells, start=1)))
  ])
  image_index = _document(token)["body"]["content"][-1]["endIndex"] - 1
  _docs_request(token, [{"insertInlineImage": {"location": {"index": image_index}, "uri": IMAGE_URL, "objectSize": {"height": {"magnitude": 24, "unit": "PT"}, "width": {"magnitude": 24, "unit": "PT"}}}}])
  return _document(token)


def _click_pull(driver) -> None:
  button = driver.find_elements(By.CSS_SELECTOR, "#google-pull-btn")
  if not button:
    raise AssertionError("Pull button not found")
  driver.execute_script("arguments[0].click()", button[0])


def _prose_mirror_text_positions(node: dict, start: int = 0) -> list[tuple[str, int]]:
  if node.get("type") == "text":
    return [(node.get("text", ""), start)]
  position = start if node.get("type") == "doc" else start + 1
  positions: list[tuple[str, int]] = []
  for child in node.get("content", []):
    positions.extend(_prose_mirror_text_positions(child, position))
    position += _prose_mirror_node_size(child)
  return positions


def _prose_mirror_text_position(document: dict, needle: str) -> int:
  units = [
    (character, position + offset)
    for text, position in _prose_mirror_text_positions(document)
    for offset, character in enumerate(text)
  ]
  text = "".join(character for character, _ in units)
  offset = text.find(needle)
  if offset < 0:
    raise AssertionError(f"ProseMirror text not found: {needle}")
  return units[offset][1]


def _prose_mirror_node_position(node: dict, node_type: str, start: int = 0) -> int | None:
  if node.get("type") == node_type:
    return start
  position = start if node.get("type") == "doc" else start + 1
  for child in node.get("content", []):
    found = _prose_mirror_node_position(child, node_type, position)
    if found is not None:
      return found
    position += _prose_mirror_node_size(child)
  return None


def _prose_mirror_node_size(node: dict) -> int:
  if node.get("type") == "text":
    return len(node.get("text", ""))
  if not node.get("content"):
    return 1
  return 2 + sum(_prose_mirror_node_size(child) for child in node["content"])


def _google_text_index(document: dict, needle: str) -> int:
  def blocks(content: list[dict]) -> list[tuple[str, int]]:
    units: list[tuple[str, int]] = []
    for block in content:
      for element in block.get("paragraph", {}).get("elements", []):
        text = element.get("textRun", {}).get("content", "")
        units.extend((character, element["startIndex"] + offset) for offset, character in enumerate(text))
      for row in block.get("table", {}).get("tableRows", []):
        for cell in row["tableCells"]:
          units.extend(blocks(cell["content"]))
    return units

  units = blocks(document["body"]["content"])
  text = "".join(character for character, _ in units)
  offset = text.find(needle)
  if offset < 0:
    raise AssertionError(f"Google Docs text not found: {needle}")
  return units[offset][1]


def _google_document_text(document: dict) -> str:
  def blocks(content: list[dict]) -> str:
    text = ""
    for block in content:
      for element in block.get("paragraph", {}).get("elements", []):
        text += element.get("textRun", {}).get("content", "")
      for row in block.get("table", {}).get("tableRows", []):
        for cell in row["tableCells"]:
          text += blocks(cell["content"])
    return text

  return blocks(document["body"]["content"])


def _google_paragraph(document: dict, needle: str) -> dict:
  for block in document["body"]["content"]:
    paragraph = block.get("paragraph")
    if paragraph:
      text = "".join(element.get("textRun", {}).get("content", "") for element in paragraph["elements"])
      if needle in text:
        return paragraph
  raise AssertionError(f"Google Docs paragraph not found: {needle}")


def _google_list_glyph(document: dict, needle: str) -> str:
  paragraph = _google_paragraph(document, needle)
  list_id = paragraph.get("bullet", {}).get("listId")
  level = document.get("lists", {}).get(list_id, {}).get("listProperties", {}).get("nestingLevels", [{}])[0]
  return level.get("glyphFormat", level.get("glyphType", ""))


def _google_text_style(document: dict, needle: str) -> dict:
  paragraph = _google_paragraph(document, needle)
  offset = 0
  for element in paragraph.get("elements", []):
    text_run = element.get("textRun", {})
    content = text_run.get("content", "")
    if "".join(item.get("textRun", {}).get("content", "") for item in paragraph.get("elements", [])).find(needle) in range(offset, offset + len(content)):
      return text_run.get("textStyle", {})
    offset += len(content)
  raise AssertionError(f"Google Doc text style not found for {needle!r}")


def _google_table_dimensions(document: dict) -> list[tuple[int, int]]:
  return [
    (len(block["table"]["tableRows"]), len(block["table"]["tableRows"][0]["tableCells"]))
    for block in document["body"]["content"]
    if "table" in block
  ]


@pytest.mark.google_docs
def test_google_doc_pull_renders_supported_elements(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  try:
    token = _token()
  except Exception as exc:  # noqa: BLE001 - environment-dependent integration test
    pytest.skip(f"Google ADC unavailable: {exc}")

  try:
    source = reset_and_populate_google_doc(token)
  except httpx.HTTPStatusError as exc:
    if exc.response.status_code in (401, 403):
      pytest.skip(f"Google credential cannot edit fixture document: {exc.response.status_code}")
    raise
  kindred.driver.execute_script(
    "window.__googleDocsPullResult = null;"
    "window.addEventListener('kindred:google-docs-pulled', (event) => {"
    "window.__googleDocsPullResult = event.detail; }, { once: true });"
  )
  _click_pull(kindred.driver)
  kindred.wait.until(lambda driver: "Plain paragraph" in kindred.editor_body_text())
  html = kindred.editor_html()
  body_text = kindred.editor_body_text()

  assert "Plain paragraph" in body_text
  assert "Styled paragraph" in body_text
  assert "Ordered one" in body_text and "Ordered two" in body_text
  assert "Unordered one" in body_text and "Nested bullet" in body_text
  assert "Break before this" in body_text
  assert "<ol" in html and "<ul" in html
  assert html.count("<li") >= 5
  assert "<em" in html and "rgb(204, 0, 0)" in html
  assert 'href="https://example.com/kindred"' in html
  assert "<table" in html and "<td" in html
  assert "<img" in html
  assert "heading" not in html.lower()

  # Source response must contain structural objects test intentionally exercises.
  source_text = "".join(
    element.get("textRun", {}).get("content", "")
    for block in source["body"]["content"]
    for element in block.get("paragraph", {}).get("elements", [])
  )
  assert "Plain paragraph" in source_text
  for text in ("Styled paragraph", "Ordered one", "Unordered one", "Nested bullet", "Break before this", "Linked text"):
    assert text in source_text
    assert text in body_text
  assert any("table" in block for block in source["body"]["content"])
  assert any("inlineObjectElement" in element for block in source["body"]["content"] for element in block.get("paragraph", {}).get("elements", []))
  source_styles = [
    element.get("textRun", {}).get("textStyle", {})
    for block in source["body"]["content"]
    for element in block.get("paragraph", {}).get("elements", [])
  ]
  assert any(style.get("bold") for style in source_styles)
  assert any(style.get("italic") for style in source_styles)
  assert any(style.get("link", {}).get("url") == "https://example.com/kindred" for style in source_styles)

  pulled = kindred.driver.execute_script("return window.__googleDocsPullResult")
  assert pulled, "Pull did not emit ProseMirror position map"
  position_map = {entry["position"]: entry["index"] for entry in pulled["positionMap"]}
  for marker in ("Plain paragraph", "Styled paragraph", "Ordered one", "Unordered one", "Nested bullet", "Break before this", "Linked text", "Table 1"):
    pm_position = _prose_mirror_text_position(pulled["proseMirrorDocument"], marker)
    assert position_map[pm_position] == _google_text_index(source, marker)
  table_pm_position = _prose_mirror_node_position(pulled["proseMirrorDocument"], "table")
  assert table_pm_position is not None
  assert position_map[table_pm_position] == _google_top_level_table_start(source, 2, 2)

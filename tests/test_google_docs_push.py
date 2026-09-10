"""Kindred editor -> Google Docs push contract tests.

Run with ``RUN_GOOGLE_DOCS_E2E=1 pytest tests/test_google_docs_push.py -vv``.
Each test prints emitted request summaries and Google Docs readback summaries.
"""

from __future__ import annotations

import os
import json

import pytest
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys



from test_google_docs_pull import (
  IMAGE_URL,
  _click_pull,
  _document,
  _google_document_text,
  _google_list_glyph,
  _google_paragraph,
  _google_table_dimensions,
  _google_text_style,
  _token,
  reset_and_populate_google_doc,
)


@pytest.fixture(autouse=True)
def push_debug(kindred):
  kindred.driver.execute_script(
    "window.__googleDocsPushDebug = { pulls: [], pushes: [], batchUpdates: [], sync: [] };"
    "if (!window.__googleDocsFetchWrapped) {"
    "  const fetch = window.fetch.bind(window);"
    "  window.fetch = (...args) => {"
    "    const url = String(args[0]);"
    "    if (!url.includes('/api/google-docs/batch-update')) return fetch(...args);"
    "    const id = window.__googleDocsPushDebug.batchUpdates.length;"
    "    window.__googleDocsPushDebug.batchUpdates.push({ id, state: 'pending' });"
    "    return fetch(...args).then(response => {"
    "      window.__googleDocsPushDebug.batchUpdates[id] = { id, state: 'fulfilled', status: response.status };"
    "      return response;"
    "    }, error => {"
    "      window.__googleDocsPushDebug.batchUpdates[id] = { id, state: 'rejected', error: String(error) };"
    "      throw error;"
    "    });"
    "  };"
    "  window.__googleDocsFetchWrapped = true;"
    "}"
    "if (!window.__googleDocsPushDebugListeners) {"
    "  window.addEventListener('kindred:google-docs-pulled', (event) => {"
    "    window.__googleDocsPushDebug.pulls.push({ revisionId: event.detail.revisionId }); });"
    "  window.addEventListener('kindred:google-docs-push', (event) => {"
    "    window.__googleDocsPushDebug.pushes.push(event.detail.requests.map(request => Object.keys(request)[0])); });"
    "  window.addEventListener('kindred:google-docs-sync', (event) => {"
    "    const { event: name, transactionId, docChanged, skipReason, revisionId, steps, error } = event.detail;"
    "    const stepSummary = (steps || []).map((step) => ({"
    "      stepType: step.stepType, from: step.from, to: step.to, mark: step.mark?.type,"
    "      insertedTypes: step.slice?.content?.map(node => node.type),"
    "    }));"
    "    window.__googleDocsPushDebug.sync.push({ name, transactionId, docChanged, skipReason, revisionId, steps: stepSummary, error }); });"
    "  window.__googleDocsPushDebugListeners = true;"
    "}"
  )
  yield
  debug = kindred.driver.execute_script("return window.__googleDocsPushDebug")
  editor = kindred.driver.execute_script(
    "const editor = document.querySelector('.ProseMirror');"
    "const selection = window.getSelection();"
    "return { html: editor?.innerHTML, selection: selection?.toString() };"
  )
  print(f"[Google Docs Push] pull lifecycle: {json.dumps(debug['pulls'])}")
  print(f"[Google Docs Push] emitted requests: {json.dumps(debug['pushes'])}")
  print(f"[Google Docs Push] batch-update lifecycle: {json.dumps(debug['batchUpdates'])}")
  print(f"[Google Docs Push] ProseMirror push lifecycle: {json.dumps(debug['sync'])}")
  print(f"[Google Docs Push] final editor state: {json.dumps(editor)}")
  token = getattr(kindred, "google_docs_token", None)
  if token:
    _readback(token, "final Google Docs state")


def _readback(token: str, label: str) -> dict:
  document = _document(token)
  print(
    f"[Google Docs Push] {label}: "
    f"text={_google_document_text(document)!r}, "
    f"tables={_google_table_dimensions(document)}"
  )
  return document


def _prepare_push_test(kindred) -> str:
  token = _token()
  kindred.google_docs_token = token
  reset_and_populate_google_doc(token)
  _readback(token, "after fixture reset")
  _click_pull(kindred.driver)
  kindred.wait.until(lambda driver: "Plain paragraph" in kindred.editor_body_text())
  print(f"[Google Docs Push] after pull editor HTML: {kindred.editor_html()}")
  return token


def _log_editor_state(kindred, label: str) -> None:
  state = kindred.driver.execute_script(
    "const editor = document.querySelector('.ProseMirror');"
    "const selection = window.getSelection();"
    "return { html: editor?.innerHTML, selection: selection?.toString() };"
  )
  print(f"[Google Docs Push] {label}: {json.dumps(state)}")


def _begin_push(kindred) -> int:
  return kindred.driver.execute_script(
    "return window.__googleDocsPushDebug.sync.length"
  )


def _wait_for_push(kindred, token: str, baseline: int, predicate, label: str) -> None:
  kindred.wait.until(lambda driver: predicate(_document(token)))
  kindred.wait.until(lambda driver: _push_settled(driver, baseline))
  print(f"[Google Docs Push] settled: {label}")


def _push_settled(driver, baseline: int) -> bool:
  sync_events = driver.execute_script(
    "return window.__googleDocsPushDebug.sync"
  )
  events = sync_events[baseline:]
  if not events:
    return False
  transaction_ids = {event["transactionId"] for event in events if event["name"] == "queued"}
  if not transaction_ids:
    return False
  return all(
    any(event["name"] == "settled" and event["transactionId"] == transaction_id for event in events)
    for transaction_id in transaction_ids
  )


def _click_toolbar_button(kindred, command: str) -> None:
  kindred.driver.find_element(By.CSS_SELECTOR, f"[data-cmd='{command}']").click()


def _select_first_word(driver, paragraph) -> None:
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(driver).key_down(Keys.SHIFT).key_down(Keys.CONTROL).send_keys(Keys.ARROW_RIGHT).key_up(Keys.CONTROL).key_up(Keys.SHIFT).perform()


def _google_inline_image_count(document: dict) -> int:
  count = 0

  def walk(content: list[dict]) -> None:
    nonlocal count
    for block in content:
      for element in block.get("paragraph", {}).get("elements", []):
        if "inlineObjectElement" in element:
          count += 1
      for row in block.get("table", {}).get("tableRows", []):
        for cell in row["tableCells"]:
          walk(cell["content"])

  walk(document["body"]["content"])
  return count


def _google_inline_image_indices(document: dict) -> list[int]:
  indices: list[int] = []

  def walk(content: list[dict]) -> None:
    for block in content:
      for element in block.get("paragraph", {}).get("elements", []):
        if "inlineObjectElement" in element:
          indices.append(element["startIndex"])
      for row in block.get("table", {}).get("tableRows", []):
        for cell in row["tableCells"]:
          walk(cell["content"])

  walk(document["body"]["content"])
  return indices


def _google_inline_image_locations(document: dict) -> list[tuple[str, int]]:
  locations: list[tuple[str, int]] = []

  def walk(content: list[dict]) -> None:
    for block in content:
      for element in block.get("paragraph", {}).get("elements", []):
        image = element.get("inlineObjectElement")
        if image:
          locations.append((image["inlineObjectId"], element["startIndex"]))
      for row in block.get("table", {}).get("tableRows", []):
        for cell in row["tableCells"]:
          walk(cell["content"])

  walk(document["body"]["content"])
  return locations


def _google_paragraph_start(document: dict, needle: str) -> int:
  for block in document["body"]["content"]:
    paragraph = block.get("paragraph")
    if paragraph:
      text = "".join(element.get("textRun", {}).get("content", "") for element in paragraph["elements"])
      if needle in text:
        return block["startIndex"]
  raise AssertionError(f"Google Docs paragraph not found: {needle}")


def _google_list_nesting_level(document: dict, needle: str) -> int:
  paragraph = _google_paragraph(document, needle)
  return paragraph.get("bullet", {}).get("nestingLevel", 0)


def _google_paragraph_text(document: dict, needle: str) -> str:
  paragraph = _google_paragraph(document, needle)
  return "".join(
    element.get("textRun", {}).get("content", "")
    for element in paragraph.get("elements", [])
  )


def _google_top_level_table_start(document: dict, rows: int, columns: int) -> int:
  for block in document["body"]["content"]:
    table = block.get("table")
    if table and len(table["tableRows"]) == rows and len(table["tableRows"][0]["tableCells"]) == columns:
      return block["startIndex"]
  raise AssertionError(f"Google Docs table not found: {rows}x{columns}")


def _google_top_level_table_cell_text(document: dict, row: int, column: int) -> str:
  for block in document["body"]["content"]:
    table = block.get("table")
    if table:
      cell = table["tableRows"][row]["tableCells"][column]
      return "".join(
        element.get("textRun", {}).get("content", "")
        for paragraph_block in cell["content"]
        for element in paragraph_block.get("paragraph", {}).get("elements", [])
      )
  raise AssertionError("Google Docs table not found")


@pytest.mark.google_docs
def test_google_doc_pushes_editor_text_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  push = _begin_push(kindred)
  paragraph.send_keys(Keys.END, "!")
  _log_editor_state(kindred, "after text insert action")

  expected_after_insert = "Plain paragraph!"
  _wait_for_push(kindred, token, push, lambda document: expected_after_insert in _google_document_text(document), "text insert")
  assert expected_after_insert in _google_document_text(_readback(token, "after text insert"))

  push = _begin_push(kindred)
  paragraph.send_keys(Keys.BACKSPACE)
  _log_editor_state(kindred, "after text delete action")
  _wait_for_push(kindred, token, push, lambda document: expected_after_insert not in _google_document_text(document), "text delete")
  assert "Plain paragraph\n" in _google_document_text(_readback(token, "after text delete"))


@pytest.mark.google_docs
def test_google_doc_pushes_unordered_list_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  kindred.driver.execute_script("document.querySelector('[data-cmd=bulletList]').click()")
  _log_editor_state(kindred, "after unordered-list action")

  kindred.wait.until(lambda driver: "bullet" in _google_paragraph(_document(token), "Plain paragraph"))
  assert "bullet" in _google_paragraph(_readback(token, "after unordered list"), "Plain paragraph")


@pytest.mark.google_docs
def test_google_doc_pushes_ordered_list_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  kindred.driver.execute_script("document.querySelector('[data-cmd=orderedList]').click()")
  _log_editor_state(kindred, "after ordered-list action")

  kindred.wait.until(lambda driver: _google_list_glyph(_document(token), "Plain paragraph") == "%0.")
  assert _google_list_glyph(_readback(token, "after ordered list"), "Plain paragraph") == "%0."


@pytest.mark.google_docs
def test_google_doc_removes_list_formatting_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  _click_toolbar_button(kindred, "bulletList")
  kindred.wait.until(lambda driver: "bullet" in _google_paragraph(_document(token), "Plain paragraph"))
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "bulletList")
  _log_editor_state(kindred, "after list-removal action")

  _wait_for_push(kindred, token, push, lambda document: "bullet" not in _google_paragraph(document, "Plain paragraph"), "list removal")
  assert "bullet" not in _google_paragraph(_readback(token, "after list removal"), "Plain paragraph")


@pytest.mark.google_docs
def test_google_doc_removes_multi_item_list_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraphs = kindred.driver.find_elements(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p")
  first, second = paragraphs[0], paragraphs[1]
  first.click()
  first.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).click(second).key_up(Keys.SHIFT).perform()
  _click_toolbar_button(kindred, "bulletList")
  kindred.wait.until(lambda driver: "bullet" in _google_paragraph(_document(token), "Plain paragraph"))
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "bulletList")
  _log_editor_state(kindred, "after multi-item-list-removal action")

  _wait_for_push(kindred, token, push, lambda document: all(
    "bullet" not in _google_paragraph(document, needle)
    for needle in ("Plain paragraph", "Styled paragraph")
  ), "multi-item list removal")
  document = _readback(token, "after multi-item list removal")
  assert "bullet" not in _google_paragraph(document, "Plain paragraph")
  assert "bullet" not in _google_paragraph(document, "Styled paragraph")


@pytest.mark.google_docs
def test_google_doc_switches_list_type_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  _click_toolbar_button(kindred, "bulletList")
  kindred.wait.until(lambda driver: "bullet" in _google_paragraph(_document(token), "Plain paragraph"))
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "orderedList")
  _log_editor_state(kindred, "after list-type-switch action")

  _wait_for_push(kindred, token, push, lambda document: _google_list_glyph(document, "Plain paragraph") == "%0.", "list type switch")
  assert _google_list_glyph(_readback(token, "after list type switch"), "Plain paragraph") == "%0."


@pytest.mark.google_docs
@pytest.mark.parametrize(
  ("command", "list_selector", "expected_glyph"),
  [
    ("bulletList", "ul", "bullet"),
    ("orderedList", "ol", "%0."),
  ],
)
def test_google_doc_pushes_nested_list_transaction_and_reads_back(
  kindred,
  command: str,
  list_selector: str,
  expected_glyph: str,
):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraphs = kindred.driver.find_elements(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p")
  first, second = paragraphs[0], paragraphs[1]
  first.click()
  first.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).click(second).key_up(Keys.SHIFT).perform()
  _click_toolbar_button(kindred, command)
  kindred.wait.until(lambda driver: _google_list_glyph(_document(token), "Plain paragraph") == expected_glyph)

  second_item = kindred.driver.find_element(
    By.CSS_SELECTOR,
    f".ProseMirror {list_selector} > li:nth-child(2) > p",
  )
  second_item.click()
  push = _begin_push(kindred)
  second_item.send_keys(Keys.TAB)
  _log_editor_state(kindred, f"after nested {command} action")
  _wait_for_push(
    kindred,
    token,
    push,
    lambda document: _google_list_nesting_level(document, "Styled paragraph") == 1,
    f"nested {command}",
  )
  document = _readback(token, f"after nested {command}")
  assert _google_list_nesting_level(document, "Styled paragraph") == 1
  assert not _google_paragraph_text(document, "Styled paragraph").startswith("\t")


@pytest.mark.google_docs
def test_google_doc_pushes_new_bullet_item_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  item = kindred.driver.find_element(
    By.XPATH,
    "//div[contains(@class, 'ProseMirror')]//li[contains(., 'Unordered one')]/p",
  )
  item.click()
  item.send_keys(Keys.END)
  push = _begin_push(kindred)
  item.send_keys(Keys.ENTER, "New bullet")
  _log_editor_state(kindred, "after new-bullet action")

  _wait_for_push(
    kindred,
    token,
    push,
    lambda document: "New bullet" in _google_document_text(document)
      and "bullet" in _google_paragraph(document, "New bullet"),
    "new bullet item",
  )
  document = _readback(token, "after new bullet item")
  assert "New bullet" in _google_document_text(document)
  assert "bullet" in _google_paragraph(document, "New bullet")


@pytest.mark.google_docs
def test_google_doc_pushes_second_list_backspace_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  item = kindred.driver.find_element(
    By.XPATH,
    "//div[contains(@class, 'ProseMirror')]//li[contains(., 'Unordered two')]/p",
  )
  item.click()
  first_push = _begin_push(kindred)
  item.send_keys(Keys.HOME, Keys.BACKSPACE)
  _wait_for_push(
    kindred,
    token,
    first_push,
    lambda document: "bullet" not in _google_paragraph(document, "Unordered two"),
    "first list backspace",
  )

  item = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]//p[contains(., 'Unordered two')]")
  item.click()
  item.send_keys(Keys.HOME)
  push = _begin_push(kindred)
  item.send_keys(Keys.BACKSPACE)
  _log_editor_state(kindred, "after second list backspace action")

  _wait_for_push(kindred, token, push, lambda document: "Unordered two" in _google_document_text(document), "second list backspace")
  document = _readback(token, "after second list backspace")
  assert "Unordered two" in _google_document_text(document)
  assert "bullet" not in _google_paragraph(document, "Unordered two")


@pytest.mark.google_docs
def test_google_doc_pushes_text_style_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  kindred.wait.until(lambda driver: "Styled paragraph" in kindred.editor_body_text())
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Styled paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "bold")
  _log_editor_state(kindred, "after bold-add action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Styled").get("bold") is True, "bold add")
  assert _google_text_style(_readback(token, "after bold add"), "Styled").get("bold") is True


@pytest.mark.google_docs
def test_google_doc_removes_text_style_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Styled paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "bold")
  _log_editor_state(kindred, "after bold-add action before remove")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Styled").get("bold") is True, "bold add before remove")

  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "bold")
  _log_editor_state(kindred, "after bold-remove action")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Styled").get("bold") is not True, "bold remove")
  assert _google_text_style(_readback(token, "after bold remove"), "Styled").get("bold") is not True


@pytest.mark.google_docs
def test_google_doc_pushes_link_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  kindred.driver.execute_script("window.prompt = () => 'https://example.com/pushed-link'")
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "link")
  _log_editor_state(kindred, "after link action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("link", {}).get("url") == "https://example.com/pushed-link", "link add")
  assert _google_text_style(_readback(token, "after link add"), "Plain").get("link", {}).get("url") == "https://example.com/pushed-link"


@pytest.mark.google_docs
def test_google_doc_pushes_paragraph_alignment_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  push = _begin_push(kindred)
  kindred.driver.execute_script("document.querySelector('[data-cmd=alignCenter]').click()")
  _log_editor_state(kindred, "after paragraph alignment action")

  _wait_for_push(kindred, token, push, lambda document: _google_paragraph(document, "Plain").get("paragraphStyle", {}).get("alignment") == "CENTER", "paragraph alignment")
  assert _google_paragraph(_readback(token, "after paragraph alignment")).get("paragraphStyle", {}).get("alignment") == "CENTER"


@pytest.mark.google_docs
def test_google_doc_pushes_table_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  kindred.driver.execute_script("document.querySelector('[data-cmd=table]').click()")
  _log_editor_state(kindred, "after table action")

  kindred.wait.until(lambda driver: (3, 3) in _google_table_dimensions(_document(token)))
  assert _google_table_dimensions(_readback(token, "after table insert")).count((3, 3)) == 1


@pytest.mark.google_docs
def test_google_doc_deletes_table_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  table_cell = kindred.driver.find_element(By.CSS_SELECTOR, ".ProseMirror table td")
  table_cell.click()
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "deleteTable")
  _log_editor_state(kindred, "after table delete action")

  _wait_for_push(kindred, token, push, lambda document: not _google_table_dimensions(document), "table delete")
  document = _readback(token, "after table delete")
  assert not _google_table_dimensions(document)
  assert "Plain paragraph" in _google_document_text(document)
  assert "Linked text" in _google_document_text(document)


@pytest.mark.google_docs
def test_google_doc_pushes_hard_break_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.END)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT).perform()
  paragraph.send_keys("Hard break tail")
  _log_editor_state(kindred, "after hard-break action")

  expected = "Plain paragraph\nHard break tail"
  kindred.wait.until(lambda driver: "<br" in paragraph.get_attribute("innerHTML"))
  kindred.wait.until(lambda driver: expected in _google_document_text(_document(token)))
  document = _readback(token, "after hard break")
  assert expected in _google_document_text(document)
  assert "Plain paragraph\n" == "".join(element.get("textRun", {}).get("content", "") for element in _google_paragraph(document, "Plain paragraph").get("elements", []))
  assert "Hard break tail\n" == "".join(element.get("textRun", {}).get("content", "") for element in _google_paragraph(document, "Hard break tail").get("elements", []))


@pytest.mark.google_docs
def test_google_doc_pushes_italic_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "italic")
  _log_editor_state(kindred, "after italic-add action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("italic") is True, "italic add")
  assert _google_text_style(_readback(token, "after italic add"), "Plain").get("italic") is True


@pytest.mark.google_docs
def test_google_doc_removes_italic_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "italic")
  _log_editor_state(kindred, "after italic-add action before remove")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("italic") is True, "italic add before remove")

  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "italic")
  _log_editor_state(kindred, "after italic-remove action")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("italic") is not True, "italic remove")
  assert _google_text_style(_readback(token, "after italic remove"), "Plain").get("italic") is not True


@pytest.mark.google_docs
def test_google_doc_pushes_underline_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "underline")
  _log_editor_state(kindred, "after underline action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("underline") is True, "underline add")
  assert _google_text_style(_readback(token, "after underline add"), "Plain").get("underline") is True


@pytest.mark.google_docs
def test_google_doc_pushes_foreground_color_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  kindred.driver.execute_script(
    "const input = document.querySelector('[data-color-input]');"
    "input.value = '#ff0000';"
    "input.dispatchEvent(new Event('input', { bubbles: true }));"
  )
  _log_editor_state(kindred, "after foreground-color action")

  def has_expected_foreground_color(document: dict) -> bool:
    rgb_color = _google_text_style(document, "Plain").get("foregroundColor", {}).get("color", {}).get("rgbColor", {})
    return all(rgb_color.get(channel, 0) == value for channel, value in {"red": 1, "green": 0, "blue": 0}.items())

  _wait_for_push(kindred, token, push, has_expected_foreground_color, "foreground color")
  assert has_expected_foreground_color(_readback(token, "after foreground color"))


def _set_toolbar_value(driver, selector: str, value: str, event_name: str) -> None:
  driver.execute_script(
    "const input = document.querySelector(arguments[0]);"
    "input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));"
    "input.value = arguments[1];"
    "input.dispatchEvent(new Event(arguments[2], { bubbles: true }));",
    selector,
    value,
    event_name,
  )


def _pick_font_family(driver, name: str) -> None:
  driver.find_element(By.CSS_SELECTOR, "[data-font-family-trigger]").click()
  driver.find_element(
    By.XPATH,
    f"//*[@data-font-family-panel]//*[@role='option' and normalize-space()='{name}']",
  ).click()


def _set_font_size(driver, value: str) -> None:
  driver.execute_script(
    "const input = document.querySelector('[data-font-size]');"
    "input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));"
    "input.value = arguments[0];"
    "input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));",
    value,
  )


@pytest.mark.google_docs
def test_google_doc_pushes_highlight_and_removal_transactions_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _set_toolbar_value(kindred.driver, "[data-highlight-input]", "#ffff00", "input")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("backgroundColor"), "highlight add")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  kindred.driver.find_element(By.CSS_SELECTOR, "[data-highlight-btn]").click()
  _wait_for_push(kindred, token, push, lambda document: not _google_text_style(document, "Plain").get("backgroundColor"), "highlight remove")


@pytest.mark.google_docs
def test_google_doc_pushes_font_family_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _pick_font_family(kindred.driver, "Verdana")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("weightedFontFamily", {}).get("fontFamily") == "Verdana", "font family")


@pytest.mark.google_docs
def test_google_doc_resets_font_family_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _pick_font_family(kindred.driver, "Verdana")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("weightedFontFamily", {}).get("fontFamily") == "Verdana", "font family add before reset")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _pick_font_family(kindred.driver, "Noto Sans")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("weightedFontFamily", {}).get("fontFamily") != "Verdana", "font family reset")


@pytest.mark.google_docs
def test_google_doc_pushes_font_size_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _set_font_size(kindred.driver, "20")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("fontSize", {}).get("magnitude") == 20, "font size")


@pytest.mark.google_docs
def test_google_doc_pushes_font_size_across_styled_list_items_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  first = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]//ol//p[contains(., 'Ordered one')]")
  second = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]//ol//p[contains(., 'Ordered two')]")
  first.click()
  first.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).click(second).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  color_push = _begin_push(kindred)
  _set_toolbar_value(kindred.driver, "[data-color-input]", "#ff0000", "input")
  _wait_for_push(kindred, token, color_push, lambda document: all(
    _google_text_style(document, needle).get("foregroundColor", {}).get("color", {}).get("rgbColor", {}).get("red") == 1
    for needle in ("Ordered one", "Ordered two")
  ), "list item foreground color")
  first.click()
  first.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).click(second).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  push = _begin_push(kindred)
  _set_font_size(kindred.driver, "20")
  _wait_for_push(kindred, token, push, lambda document: all(
    _google_list_glyph(document, needle) == "%0." and
    _google_text_style(document, needle).get("fontSize", {}).get("magnitude") == 20 and
    _google_text_style(document, needle).get("foregroundColor", {}).get("color", {}).get("rgbColor", {}).get("red") == 1
    for needle in ("Ordered one", "Ordered two")
  ), "font size across styled list items")
  document = _readback(token, "after font size across styled list items")
  for needle in ("Ordered one", "Ordered two"):
    assert _google_list_glyph(document, needle) == "%0."
    assert _google_text_style(document, needle).get("fontSize", {}).get("magnitude") == 20
    assert _google_text_style(document, needle).get("foregroundColor", {}).get("color", {}).get("rgbColor", {}).get("red") == 1


@pytest.mark.google_docs
def test_google_doc_resets_font_size_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _set_font_size(kindred.driver, "20")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("fontSize", {}).get("magnitude") == 20, "font size add before reset")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _set_font_size(kindred.driver, "12")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("fontSize", {}).get("magnitude") != 20, "font size reset")


@pytest.mark.google_docs
def test_google_doc_pushes_strike_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "strike")
  _log_editor_state(kindred, "after strike action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("strikethrough") is True, "strike add")
  assert _google_text_style(_readback(token, "after strike add"), "Plain").get("strikethrough") is True


@pytest.mark.google_docs
def test_google_doc_removes_underline_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "underline")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("underline") is True, "underline add before remove")

  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "underline")
  _log_editor_state(kindred, "after underline-remove action")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("underline") is not True, "underline remove")
  assert _google_text_style(_readback(token, "after underline remove"), "Plain").get("underline") is not True


@pytest.mark.google_docs
def test_google_doc_removes_strike_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "strike")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("strikethrough") is True, "strike add before remove")

  _select_first_word(kindred.driver, paragraph)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "strike")
  _log_editor_state(kindred, "after strike-remove action")
  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Plain").get("strikethrough") is not True, "strike remove")
  assert _google_text_style(_readback(token, "after strike remove"), "Plain").get("strikethrough") is not True


@pytest.mark.google_docs
def test_google_doc_replaces_link_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Linked text')]")
  _select_first_word(kindred.driver, paragraph)
  kindred.driver.execute_script("window.prompt = () => 'https://example.com/replaced-link'")
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "link")
  _log_editor_state(kindred, "after link-replace action")

  _wait_for_push(kindred, token, push, lambda document: _google_text_style(document, "Linked").get("link", {}).get("url") == "https://example.com/replaced-link", "link replace")
  assert _google_text_style(_readback(token, "after link replace"), "Linked").get("link", {}).get("url") == "https://example.com/replaced-link"


@pytest.mark.google_docs
def test_google_doc_pushes_table_cell_text_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  cell = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]//td[contains(., 'Table 1')]")
  cell.click()
  push = _begin_push(kindred)
  cell.send_keys(Keys.END, " edited")
  _log_editor_state(kindred, "after table-cell edit action")

  expected = "Table 1 edited"
  _wait_for_push(kindred, token, push, lambda document: expected in _google_top_level_table_cell_text(document, 0, 0), "table cell edit")
  assert expected in _google_top_level_table_cell_text(_readback(token, "after table cell edit"), 0, 0)


@pytest.mark.google_docs
def test_google_doc_inserts_table_at_editor_position_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  baseline_tables = _google_table_dimensions(_document(token)).count((3, 3))
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.END)
  push = _begin_push(kindred)
  kindred.driver.execute_script("document.querySelector('[data-cmd=table]').click()")
  _log_editor_state(kindred, "after positioned-table action")

  _wait_for_push(kindred, token, push, lambda document: _google_table_dimensions(document).count((3, 3)) > baseline_tables, "positioned table insert")
  document = _readback(token, "after positioned table insert")
  assert _google_table_dimensions(document).count((3, 3)) == baseline_tables + 1
  table_start = _google_top_level_table_start(document, 3, 3)
  assert _google_paragraph_start(document, "Plain paragraph") < table_start < _google_paragraph_start(document, "Styled paragraph")


def _prepare_table_structure_push(kindred, row=0, column=0):
  token = _prepare_push_test(kindred)
  cell = kindred.driver.find_element(
    By.CSS_SELECTOR,
    f"#editor .ProseMirror table tr:nth-child({row + 1}) td:nth-child({column + 1})",
  )
  cell.click()
  return token


@pytest.mark.google_docs
def test_google_doc_adds_table_row_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_table_structure_push(kindred)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "addRowAfter")
  _wait_for_push(kindred, token, push, lambda document: (3, 2) in _google_table_dimensions(document), "table row add")
  document = _readback(token, "after table row add")
  assert (3, 2) in _google_table_dimensions(document)
  assert "Table 1" in _google_top_level_table_cell_text(document, 0, 0)


@pytest.mark.google_docs
def test_google_doc_deletes_table_row_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_table_structure_push(kindred, row=1)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "deleteRow")
  _wait_for_push(kindred, token, push, lambda document: (1, 2) in _google_table_dimensions(document), "table row delete")
  document = _readback(token, "after table row delete")
  assert (1, 2) in _google_table_dimensions(document)
  assert "Table 1" in _google_top_level_table_cell_text(document, 0, 0)
  assert "Table 2" in _google_top_level_table_cell_text(document, 0, 1)


@pytest.mark.google_docs
def test_google_doc_adds_table_column_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_table_structure_push(kindred)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "addColumnAfter")
  _wait_for_push(kindred, token, push, lambda document: (2, 3) in _google_table_dimensions(document), "table column add")
  document = _readback(token, "after table column add")
  assert (2, 3) in _google_table_dimensions(document)
  assert "Table 1" in _google_top_level_table_cell_text(document, 0, 0)
  assert "Table 2" in _google_top_level_table_cell_text(document, 0, 1)


@pytest.mark.google_docs
def test_google_doc_deletes_table_column_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_table_structure_push(kindred, column=1)
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "deleteColumn")
  _wait_for_push(kindred, token, push, lambda document: (2, 1) in _google_table_dimensions(document), "table column delete")
  document = _readback(token, "after table column delete")
  assert (2, 1) in _google_table_dimensions(document)
  assert "Table 1" in _google_top_level_table_cell_text(document, 0, 0)
  assert "Table 3" in _google_top_level_table_cell_text(document, 1, 0)


@pytest.mark.google_docs
def test_google_doc_places_image_at_editor_position_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  baseline = _document(token)
  baseline_images = {image_id for image_id, _ in _google_inline_image_locations(baseline)}
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.END)
  push = _begin_push(kindred)
  kindred.paste_html(f'<img src="{IMAGE_URL}" alt="positioned">')
  _log_editor_state(kindred, "after positioned-image action")

  _wait_for_push(kindred, token, push, lambda document: len(_google_inline_image_locations(document)) > len(baseline_images), "positioned image insert")
  document = _readback(token, "after positioned image insert")
  new_images = [index for image_id, index in _google_inline_image_locations(document) if image_id not in baseline_images]
  assert new_images
  assert _google_paragraph_start(document, "Plain paragraph") < new_images[0] < _google_paragraph_start(document, "Styled paragraph")


@pytest.mark.google_docs
def test_google_doc_deletes_one_paragraph_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.HOME)
  ActionChains(kindred.driver).key_down(Keys.SHIFT).send_keys(Keys.END).key_up(Keys.SHIFT).perform()
  push = _begin_push(kindred)
  paragraph.send_keys(Keys.BACKSPACE)
  _log_editor_state(kindred, "after paragraph-delete action")

  _wait_for_push(kindred, token, push, lambda document: "Plain paragraph" not in _google_document_text(document), "paragraph delete")
  document = _readback(token, "after paragraph delete")
  assert "Plain paragraph" not in _google_document_text(document)
  assert "Styled paragraph" in _google_document_text(document)


@pytest.mark.google_docs
def test_google_doc_removes_link_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  kindred.wait.until(lambda driver: "Linked text" in kindred.editor_body_text())
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Linked text')]")
  _select_first_word(kindred.driver, paragraph)
  kindred.driver.execute_script("window.prompt = () => ''")
  push = _begin_push(kindred)
  _click_toolbar_button(kindred, "link")
  _log_editor_state(kindred, "after link-remove action")

  _wait_for_push(kindred, token, push, lambda document: not _google_text_style(document, "Linked").get("link"), "link remove")
  assert not _google_text_style(_readback(token, "after link remove"), "Linked").get("link")


@pytest.mark.google_docs
def test_google_doc_pushes_paragraph_break_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.END)
  push = _begin_push(kindred)
  paragraph.send_keys(Keys.ENTER)
  paragraph.send_keys("Second paragraph")
  _log_editor_state(kindred, "after paragraph-break action")

  expected = "Plain paragraph\nSecond paragraph"
  _wait_for_push(kindred, token, push, lambda document: expected in _google_document_text(document), "paragraph break")
  document = _readback(token, "after paragraph break")
  assert expected in _google_document_text(document)
  assert "Second paragraph\n" == "".join(element.get("textRun", {}).get("content", "") for element in _google_paragraph(document, "Second paragraph").get("elements", []))


@pytest.mark.google_docs
def test_google_doc_pushes_image_transaction_and_reads_back(kindred):
  if os.environ.get("RUN_GOOGLE_DOCS_E2E") != "1":
    pytest.skip("set RUN_GOOGLE_DOCS_E2E=1 to run shared Google Docs fixture")
  token = _prepare_push_test(kindred)
  baseline_images = _google_inline_image_count(_document(token))
  paragraph = kindred.driver.find_element(By.XPATH, "//div[contains(@class, 'ProseMirror')]/p[contains(., 'Plain paragraph')]")
  paragraph.click()
  paragraph.send_keys(Keys.END)
  push = _begin_push(kindred)
  kindred.paste_html(f'<img src="{IMAGE_URL}" alt="pushed">')
  _log_editor_state(kindred, "after image action")

  _wait_for_push(
    kindred,
    token,
    push,
    lambda document: _google_inline_image_count(document) > baseline_images,
    "image insert",
  )
  assert _google_inline_image_count(_readback(token, "after image insert")) > baseline_images

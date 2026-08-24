from __future__ import annotations

import os
from dataclasses import dataclass

import httpx
import pytest
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest
from dotenv import load_dotenv
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

from pages.kindred import KindredPage


load_dotenv()
pytestmark = pytest.mark.integration

DOC_ID = os.environ.get(
  "GOOGLE_DOCS_DOCUMENT_ID",
  "1sADU8OrbDmZW1VyuaARqjVNjmWLHl2wWl3R71WkCEDI",
)
DOCS_URL = "https://docs.googleapis.com/v1/documents"


@dataclass
class GoogleDocsTestClient:
  document_id: str = DOC_ID

  def _headers(self) -> dict[str, str]:
    credentials, _ = google_auth_default(
      scopes=["https://www.googleapis.com/auth/documents"]
    )
    if not credentials.valid:
      credentials.refresh(GoogleAuthRequest())
    return {"Authorization": f"Bearer {credentials.token}"}

  def document(self) -> dict:
    response = httpx.get(
      f"{DOCS_URL}/{self.document_id}", headers=self._headers(), timeout=30
    )
    response.raise_for_status()
    return response.json()

  def revision_id(self) -> str:
    return self.document()["revisionId"]

  def text(self) -> str:
    parts = []
    for block in self.document().get("body", {}).get("content", []):
      for element in block.get("paragraph", {}).get("elements", []):
        parts.append(element.get("textRun", {}).get("content", ""))
    return "".join(parts).rstrip("\n")

  def text_has_style(self, text: str, style_name: str, expected: bool = True) -> bool:
    characters: list[tuple[str, dict]] = []
    for block in self.document().get("body", {}).get("content", []):
      for element in block.get("paragraph", {}).get("elements", []):
        run = element.get("textRun", {})
        style = run.get("textStyle", {})
        characters.extend((character, style) for character in run.get("content", ""))

    document_text = "".join(character for character, _ in characters)
    start = document_text.find(text)
    if start < 0:
      raise AssertionError(f"text not found: {text!r}")

    return all(
      style.get(style_name) is True if expected else not style.get(style_name)
      for _, style in characters[start:start + len(text)]
    )

  def text_has_foreground_color(
    self,
    text: str,
    expected: dict[str, float] | None,
  ) -> bool:
    characters: list[tuple[str, dict | None]] = []
    for block in self.document().get("body", {}).get("content", []):
      for element in block.get("paragraph", {}).get("elements", []):
        run = element.get("textRun", {})
        color = (
          run.get("textStyle", {})
          .get("foregroundColor", {})
          .get("color", {})
          .get("rgbColor")
        )
        characters.extend((character, color) for character in run.get("content", ""))

    document_text = "".join(character for character, _ in characters)
    start = document_text.find(text)
    if start < 0:
      raise AssertionError(f"text not found: {text!r}")
    return all(
      color is None if expected is None else all(
        color is not None and color.get(channel, 0) == value
        for channel, value in expected.items()
      )
      for _, color in characters[start:start + len(text)]
    )

  def set_text(self, text: str) -> str:
    document = self.document()
    end_index = document["body"]["content"][-1]["endIndex"]
    requests = []
    if end_index > 2:
      requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index - 1}}})
    requests.append({"insertText": {"location": {"index": 1}, "text": f"{text}\n"}})
    response = httpx.post(
      f"{DOCS_URL}/{self.document_id}:batchUpdate",
      headers={**self._headers(), "Content-Type": "application/json"},
      json={"requests": requests},
      timeout=30,
    )
    response.raise_for_status()
    return response.json().get("writeControl", {}).get("requiredRevisionId", self.revision_id())

  def insert_text(self, *, index: int, text: str) -> str:
    response = httpx.post(
      f"{DOCS_URL}/{self.document_id}:batchUpdate",
      headers={**self._headers(), "Content-Type": "application/json"},
      json={"requests": [{"insertText": {"location": {"index": index}, "text": text}}]},
      timeout=30,
    )
    response.raise_for_status()
    return response.json().get("writeControl", {}).get("requiredRevisionId", self.revision_id())

  def set_text_with_foreground_color(
    self,
    text: str,
    colored_text: str,
    color: dict[str, float],
  ) -> str:
    document = self.document()
    end_index = document["body"]["content"][-1]["endIndex"]
    color_start = text.index(colored_text) + 1
    color_end = color_start + len(colored_text)
    requests = []
    if end_index > 2:
      requests.append(
        {"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index - 1}}}
      )
    requests.extend(
      [
        {"insertText": {"location": {"index": 1}, "text": f"{text}\n"}},
        {
          "updateTextStyle": {
            "range": {"startIndex": color_start, "endIndex": color_end},
            "textStyle": {"foregroundColor": {"color": {"rgbColor": color}}},
            "fields": "foregroundColor",
          }
        },
      ]
    )
    response = httpx.post(
      f"{DOCS_URL}/{self.document_id}:batchUpdate",
      headers={**self._headers(), "Content-Type": "application/json"},
      json={"requests": requests},
      timeout=30,
    )
    response.raise_for_status()
    return response.json().get("writeControl", {}).get("requiredRevisionId", self.revision_id())


@pytest.fixture
def google_docs() -> GoogleDocsTestClient:
  return GoogleDocsTestClient()


def wait_for_editor_text(kindred: KindredPage, text: str) -> None:
  try:
    kindred.wait_until_editor_body_text(text)
  except Exception as error:
    actual = kindred.editor_text()
    state = kindred.sync_state()
    raise AssertionError(
      f"TipTap baseline did not load: expected={text!r}, actual={actual!r}, state={state}"
    ) from error


def wait_for_sync_idle(kindred: KindredPage) -> None:
  kindred.wait_for_sync_idle()


def establish_concurrent_state(
  kindred: KindredPage,
  google_docs: GoogleDocsTestClient,
) -> tuple[str, str]:
  google_docs.set_text("AAA BBB CCC")
  base_revision = google_docs.revision_id()

  kindred.open()
  kindred.wait_until_ready()
  wait_for_editor_text(kindred, "AAA BBB CCC")
  wait_for_sync_idle(kindred)
  assert kindred.sync_state()["baseRevisionId"] == base_revision

  kindred.pause_sync()
  assert kindred.sync_state()["paused"] is True
  kindred.insert_text_before("BBB", "LOCAL ")
  assert kindred.sync_state()["localDirty"] is True
  assert kindred.sync_state()["baseRevisionId"] == base_revision

  remote_revision = google_docs.insert_text(index=9, text="REMOTE ")
  assert remote_revision != base_revision
  assert "LOCAL" not in google_docs.text()
  return base_revision, remote_revision


def finish_and_assert_merge(
  kindred: KindredPage,
  google_docs: GoogleDocsTestClient,
  expected: str,
  base_revision: str,
  remote_revision: str,
) -> None:
  kindred.resume_sync()
  WebDriverWait(kindred.driver, 30).until(
    lambda _: not kindred.sync_state().get("localDirty")
  )
  wait_for_sync_idle(kindred)
  wait_for_editor_text(kindred, expected)
  assert kindred.editor_text() == expected
  assert google_docs.text() == expected
  final_revision = google_docs.revision_id()
  assert final_revision not in {base_revision, remote_revision}
  assert kindred.sync_state()["baseRevisionId"] == final_revision


def test_concurrent_non_overlapping_inserts_merge(kindred, google_docs):
  base, remote = establish_concurrent_state(kindred, google_docs)
  state = kindred.sync_state()
  assert state["localDirty"] is True
  assert "LOCAL" in kindred.editor_text()
  assert "REMOTE" in google_docs.text()
  finish_and_assert_merge(kindred, google_docs, "AAA LOCAL BBB REMOTE CCC", base, remote)


@pytest.mark.parametrize(
  ("command", "google_style"),
  [
    ("bold", "bold"),
    ("italic", "italic"),
    ("underline", "underline"),
    ("strike", "strikethrough"),
  ],
)
def test_typed_text_style_syncs_to_google_docs(kindred, google_docs, command, google_style):
  kindred.open()
  kindred.wait_until_ready()
  kindred.paste_text("seed")
  kindred.wait_until_draft_active()
  kindred.wait_for_sync_idle()
  google_docs.set_text("base")
  wait_for_editor_text(kindred, "base")
  kindred.wait_for_sync_idle()
  kindred.pause_sync()
  kindred.press_keys(Keys.END)
  kindred.toolbar_click(command)
  typed_text = f" {command} text"
  kindred.driver.switch_to.active_element.send_keys(typed_text)
  kindred.toolbar_click(command)
  plain_text = f" plain {command} text"
  kindred.driver.switch_to.active_element.send_keys(plain_text)
  kindred.resume_sync()
  kindred.wait_for_sync_idle()
  assert google_docs.text_has_style(typed_text, google_style)
  assert google_docs.text_has_style(plain_text, google_style, expected=False)


def test_typed_font_color_syncs_to_google_docs(kindred, google_docs):
  kindred.open()
  kindred.wait_until_ready()
  kindred.replace_editor_text("seed")
  kindred.wait_until_draft_active()
  kindred.wait_for_sync_idle()
  google_docs.set_text("base")
  wait_for_editor_text(kindred, "base")
  kindred.wait_for_sync_idle()
  kindred.pause_sync()
  kindred.press_keys(Keys.END)
  kindred.set_font_color("#ff0000")
  kindred.driver.switch_to.active_element.send_keys(" red text")
  kindred.resume_sync()
  kindred.wait_for_sync_idle()
  red = {"red": 1, "green": 0, "blue": 0}
  assert google_docs.text_has_foreground_color(" red text", red)
  assert google_docs.text_has_foreground_color("base", None)


def test_google_docs_font_color_downsyncs_to_kindred(kindred, google_docs):
  kindred.open()
  kindred.wait_until_ready()
  kindred.replace_editor_text("seed")
  kindred.wait_until_draft_active()
  kindred.wait_for_sync_idle()
  google_docs.set_text_with_foreground_color(
    "plain red text plain",
    "red text",
    {"red": 1, "green": 0, "blue": 0},
  )
  wait_for_editor_text(kindred, "plain red text plain")
  kindred.wait_for_sync_idle()
  assert (
    '<p>plain <span style="color: rgb(255, 0, 0);">red text</span> plain</p>'
    in kindred.editor_html()
  )


@pytest.mark.parametrize(
  ("base", "local_marker", "local_text", "remote_index", "remote_text", "expected_markers"),
  [
    ("abcdef", "c", "LOCAL", 5, "REMOTE ", ("LOCAL", "REMOTE")),
    ("AAA BBB CCC", "BBB", "LOCAL ", 9, "REMOTE ", ("LOCAL", "REMOTE")),
    ("AAA BBB CCC", "CCC", "LOCAL ", 5, "REMOTE ", ("LOCAL", "REMOTE")),
    ("AAA BBB CCC", "BBB", "LOCAL2 ", 9, "REMOTE ", ("LOCAL2", "REMOTE")),
  ],
)
def test_concurrent_edit_matrix(
  kindred,
  google_docs,
  base,
  local_marker,
  local_text,
  remote_index,
  remote_text,
  expected_markers,
):
  google_docs.set_text(base)
  base_revision = google_docs.revision_id()
  kindred.open()
  kindred.wait_until_ready()
  wait_for_editor_text(kindred, base)
  wait_for_sync_idle(kindred)
  kindred.pause_sync()
  kindred.insert_text_before(local_marker, local_text)
  remote_revision = google_docs.insert_text(index=remote_index, text=remote_text)
  assert remote_revision != base_revision
  kindred.resume_sync()
  WebDriverWait(kindred.driver, 30).until(lambda _: not kindred.sync_state().get("localDirty"))
  wait_for_sync_idle(kindred)
  wait_for_editor_text(kindred, google_docs.text())
  final_text = kindred.editor_text()
  merged_text = google_docs.text()
  for marker in expected_markers:
    assert marker in final_text
    assert marker in merged_text
  assert final_text == merged_text

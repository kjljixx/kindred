from __future__ import annotations

import os
from dataclasses import dataclass

import httpx
import pytest
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest
from dotenv import load_dotenv
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
  final_text = kindred.editor_text()
  merged_text = google_docs.text()
  for marker in expected_markers:
    assert marker in final_text
    assert marker in merged_text
  assert final_text == merged_text

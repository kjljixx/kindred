import asyncio

import pytest
from fastapi import HTTPException

from kindred import server
from kindred.server import FolderDraft, FolderOption

FOLDERS = [
  FolderOption(id="f1", path="College apps"),
  FolderOption(id="f2", path="College apps / Essays"),
]


def fake_jev(monkeypatch, answer, *, is_error=False, status_code=200):
  sent = {}

  class Response:
    pass

  Response.is_error = is_error
  Response.status_code = status_code
  Response.json = staticmethod(lambda: {"answers": {"folder": answer}})

  class Client:
    async def post(self, url, **kwargs):
      sent["url"] = url
      sent["json"] = kwargs["json"]
      return Response()

  monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
  monkeypatch.setattr(server, "get_http_client", lambda: Client())
  return sent


def suggest(folders=FOLDERS, text="Common App essay"):
  return asyncio.run(server.suggest_folder_with_jev(FolderDraft(title="Essay", text=text), folders))


def test_folder_suggestion_sends_one_choice_question_with_paths_as_criteria(monkeypatch):
  sent = fake_jev(monkeypatch, {
    "choice": "College apps / Essays",
    "probabilities": {"College apps / Essays": 0.9, "College apps": 0.1, "none": 0},
  })

  suggest()

  assert sent["url"] == "https://openrouter.ai/api/alpha/decisions"
  assert sent["json"]["model"] == "~typesafe/jev-latest"
  assert sent["json"]["state"].startswith("Essay\n\nCommon App essay")
  assert sent["json"]["questions"]["folder"]["type"] == "choice"
  assert sent["json"]["questions"]["folder"]["criteria"] == {
    "none": "none of the folders",
    "College apps": "College apps",
    "College apps / Essays": "College apps / Essays",
  }


def test_folder_suggestion_maps_confident_choice_to_folder_id(monkeypatch):
  fake_jev(monkeypatch, {
    "choice": "College apps / Essays",
    "probabilities": {"College apps / Essays": 0.9, "College apps": 0.1, "none": 0},
  })

  assert suggest() == {
    "folderId": "f2",
    "probabilities": {"f2": 0.9, "f1": 0.1, "none": 0},
  }


@pytest.mark.parametrize("choice,probability", [("none", 1), ("College apps", 0.69)])
def test_folder_suggestion_leaves_draft_unfiled_when_unsure(monkeypatch, choice, probability):
  fake_jev(monkeypatch, {"choice": choice, "probabilities": {choice: probability}})

  assert suggest()["folderId"] is None


def test_folder_suggestion_ignores_choice_it_did_not_offer(monkeypatch):
  fake_jev(monkeypatch, {"choice": "Invented", "probabilities": {"Invented": 1}})

  assert suggest()["folderId"] is None


def test_folder_suggestion_disambiguates_duplicate_paths_and_reserved_none(monkeypatch):
  sent = fake_jev(monkeypatch, {"choice": "Notes (2)", "probabilities": {"Notes (2)": 1}})
  folders = [
    FolderOption(id="a", path="Notes"),
    FolderOption(id="b", path="Notes"),
    FolderOption(id="c", path="none"),
  ]

  result = suggest(folders)

  assert list(sent["json"]["questions"]["folder"]["criteria"]) == [
    "none", "Notes", "Notes (2)", "none (2)",
  ]
  assert result["folderId"] == "b"


def test_folder_suggestion_sends_only_the_first_thousand_words(monkeypatch):
  sent = fake_jev(monkeypatch, {"choice": "none", "probabilities": {"none": 1}})

  suggest(text="\n".join(f"word{i}" for i in range(1500)))

  words = sent["json"]["state"].removeprefix("Essay\n\n").split()
  assert len(words) == server.FOLDER_SUGGEST_MAX_WORDS
  assert words[0] == "word0"
  assert words[-1] == "word999"


def test_folder_suggestion_skips_provider_without_folders(monkeypatch):
  monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
  monkeypatch.setattr(server, "get_http_client", lambda: pytest.fail("provider called"))

  assert suggest(folders=[]) == {"folderId": None, "probabilities": {}}


def test_folder_suggestion_reports_provider_failure(monkeypatch):
  fake_jev(monkeypatch, {}, is_error=True, status_code=500)

  with pytest.raises(HTTPException) as error:
    suggest()

  assert error.value.status_code == 502


def test_folder_suggestion_requires_api_key(monkeypatch):
  monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

  with pytest.raises(HTTPException) as error:
    suggest()

  assert error.value.status_code == 503

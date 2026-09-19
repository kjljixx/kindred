import asyncio

import pytest
from fastapi import HTTPException

from kindred import server


def test_math_detection_candidates_keep_math_syntax_and_split_sentences():
  text = "Try sin(x), x^2 and v=a*t. Then x. y"

  assert server.math_detection_candidates(text) == [
    {"start": 0, "end": 3, "text": "Try"},
    {"start": 4, "end": 10, "text": "sin(x)"},
    {"start": 12, "end": 15, "text": "x^2"},
    {"start": 16, "end": 19, "text": "and"},
    {"start": 20, "end": 25, "text": "v=a*t"},
    {"start": 27, "end": 31, "text": "Then"},
    {"start": 32, "end": 33, "text": "x"},
    {"start": 35, "end": 36, "text": "y"},
  ]


def test_jev_detection_returns_only_confident_ranges(monkeypatch):
  monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

  class Response:
    is_error = False

    @staticmethod
    def json():
      return {
        "answers": {
          "candidate_0": {"noul": 0.01},
          "candidate_1": {"noul": 0.2},
          "candidate_2": {"noul": 0.99},
        }
      }

  class Client:
    async def post(self, url, **kwargs):
      assert url == "https://openrouter.ai/api/alpha/decisions"
      assert kwargs["json"]["model"] == "~typesafe/jev-latest"
      return Response()

  monkeypatch.setattr(server, "get_http_client", lambda: Client())

  assert asyncio.run(server.detect_math_with_jev("There are 3")) == [
    {"start": 10, "end": 11, "text": "3"},
  ]


def test_jev_detection_uses_supplied_detector_ranges(monkeypatch):
  monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

  class Response:
    is_error = False

    @staticmethod
    def json():
      return {"answers": {"candidate_0": {"noul": 0.01}}}

  class Client:
    async def post(self, _url, **kwargs):
      assert kwargs["json"]["state"]["candidates"] == [
        {"start": 12, "end": 21, "text": "2026-2027"},
      ]
      assert "'2026-2027' at source offsets 12:21" in (
        kwargs["json"]["questions"]["candidate_0"]["instructions"]
      )
      return Response()

  monkeypatch.setattr(server, "get_http_client", lambda: Client())

  ranges = asyncio.run(server.detect_math_with_jev(
    "School year 2026-2027",
    [{"start": 12, "end": 21}],
  ))

  assert ranges == []


def test_jev_detection_requires_api_key(monkeypatch):
  monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

  with pytest.raises(HTTPException) as error:
    asyncio.run(server.detect_math_with_jev("x^2"))

  assert error.value.status_code == 503

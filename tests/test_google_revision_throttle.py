from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from kindred import server


def test_revision_deadline_resets_when_tab_becomes_active(monkeypatch):
  clock = [1000.0]
  monkeypatch.setattr(server.time, "perf_counter", lambda: clock[0])
  monkeypatch.setattr(server, "_read_times", {})
  monkeypatch.setattr(server, "_revision_tabs", {})

  async def reserve(background: bool, idle_seconds: float) -> bool:
    return await server.reserve_revision_read("user", "doc", "tab", background, idle_seconds)

  assert asyncio.run(reserve(False, 0))
  clock[0] += 1
  assert not asyncio.run(reserve(True, 100))
  assert asyncio.run(reserve(False, 0))
  clock[0] += 0.0001
  assert not asyncio.run(reserve(False, 0))
  clock[0] += 5
  assert asyncio.run(reserve(False, 0))


def test_revision_endpoint_distinguishes_skipped_checks(monkeypatch):
  clock = [1000.0]
  monkeypatch.setattr(server.time, "perf_counter", lambda: clock[0])
  monkeypatch.setattr(server, "_read_times", {})
  monkeypatch.setattr(server, "_revision_tabs", {})
  monkeypatch.setattr(server, "require_google_session", lambda _request: "user")
  calls = []

  async def fetch_revision(_session_id: str, _document_id: str) -> str:
    calls.append(True)
    return "revision-1"

  monkeypatch.setattr(server, "fetch_google_revision", fetch_revision)
  client = TestClient(server.app)
  params = {"documentId": "doc", "tabId": "tab", "background": "true"}
  assert client.get("/api/google-docs/revision", params=params).json() == {
    "checked": True, "revisionId": "revision-1",
  }
  assert client.get("/api/google-docs/revision", params=params).json() == {
    "checked": False, "revisionId": None,
  }
  clock[0] += 1
  params["background"] = "false"
  assert client.get("/api/google-docs/revision", params=params).json() == {
    "checked": True, "revisionId": "revision-1",
  }
  assert len(calls) == 2


def test_read_budget_is_separate_from_write_budget():
  now = 1000.0
  assert server.earliest_read_time([now] * 300, now) == now + 60
  assert server.revision_extra_delay(False, 0) == 0
  assert server.revision_extra_delay(False, 130) == 3
  assert server.revision_extra_delay(True, 0) == 5

from __future__ import annotations

import asyncio
import sqlite3
from urllib.parse import parse_qs, urlparse

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from kindred.google_sessions import GoogleSessionStore, OAUTH_STATE_MAX_AGE_S
from kindred import server


class FakeGoogleResponse:
  def __init__(self, body: dict[str, str], status_code: int = 200):
    self.body = body
    self.status_code = status_code
    self.text = str(body)

  @property
  def is_error(self) -> bool:
    return self.status_code >= 400

  def json(self) -> dict[str, str]:
    return self.body


class FakeOAuthClient:
  def __init__(self):
    self.token_exchanges: list[str] = []

  async def post(self, _url: str, *, data: dict[str, str]) -> FakeGoogleResponse:
    if data["grant_type"] == "authorization_code":
      return FakeGoogleResponse({"refresh_token": f"refresh-{data['code']}"})
    self.token_exchanges.append(data["refresh_token"])
    return FakeGoogleResponse({
      "access_token": f"access-{data['refresh_token']}-{len(self.token_exchanges)}",
      "expires_in": "3600",
    })


def oauth_state(response) -> str:
  return parse_qs(urlparse(response.headers["location"]).query)["state"][0]


def test_oauth_state_is_session_bound_expiring_and_single_use(tmp_path):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  session_a = store.create_session(now=100)
  session_b = store.create_session(now=100)

  state = store.create_oauth_attempt(session_a, now=100)

  assert not store.consume_oauth_attempt(session_b, state, now=101)
  assert store.consume_oauth_attempt(session_a, state, now=101)
  assert not store.consume_oauth_attempt(session_a, state, now=101)

  expired_state = store.create_oauth_attempt(session_a, now=200)
  assert not store.consume_oauth_attempt(
    session_a, expired_state, now=200 + OAUTH_STATE_MAX_AGE_S
  )


def test_refresh_tokens_are_encrypted_and_isolated_by_browser_session(
  tmp_path, monkeypatch
):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  monkeypatch.setattr(server, "_google_session_store", store)
  oauth_client = FakeOAuthClient()
  monkeypatch.setattr(server, "get_http_client", lambda: oauth_client)
  monkeypatch.setattr(server, "_google_access_tokens", {})
  monkeypatch.setattr(server, "_google_access_token_locks", {})
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client")
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")

  client_a = TestClient(server.app)
  client_b = TestClient(server.app)
  start_a = client_a.get("/api/google-docs/oauth/start", follow_redirects=False)
  start_b = client_b.get("/api/google-docs/oauth/start", follow_redirects=False)

  callback_a = client_a.get(
    "/api/google-docs/oauth/callback",
    params={"code": "alice", "state": oauth_state(start_a)},
  )
  callback_b = client_b.get(
    "/api/google-docs/oauth/callback",
    params={"code": "bob", "state": oauth_state(start_b)},
  )

  assert callback_a.status_code == 200
  assert callback_b.status_code == 200
  session_a = client_a.cookies[server.GOOGLE_SESSION_COOKIE]
  session_b = client_b.cookies[server.GOOGLE_SESSION_COOKIE]
  assert session_a != session_b
  assert store.get_refresh_token(session_a) == "refresh-alice"
  assert store.get_refresh_token(session_b) == "refresh-bob"

  assert asyncio.run(server.get_access_token(session_a)) == "access-refresh-alice-1"
  assert asyncio.run(server.get_access_token(session_b)) == "access-refresh-bob-2"
  assert oauth_client.token_exchanges == ["refresh-alice", "refresh-bob"]

  with sqlite3.connect(store.database_path) as connection:
    encrypted_tokens = [
      row[0] for row in connection.execute(
        "SELECT encrypted_refresh_token FROM browser_sessions"
      ).fetchall()
    ]
  assert all(b"refresh-alice" not in token for token in encrypted_tokens)
  assert all(b"refresh-bob" not in token for token in encrypted_tokens)


def test_access_token_is_reused_until_expiry_and_concurrent_refresh_is_deduplicated(
  tmp_path, monkeypatch
):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  session_id = store.create_session()
  store.save_refresh_token(session_id, "refresh-alice")
  oauth_client = FakeOAuthClient()
  monkeypatch.setattr(server, "_google_session_store", store)
  monkeypatch.setattr(server, "get_http_client", lambda: oauth_client)
  monkeypatch.setattr(server, "_google_access_tokens", {})
  monkeypatch.setattr(server, "_google_access_token_locks", {})
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client")
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")

  async def get_tokens() -> list[str]:
    return await asyncio.gather(
      server.get_access_token(session_id),
      server.get_access_token(session_id),
      server.get_access_token(session_id),
    )

  assert asyncio.run(get_tokens()) == ["access-refresh-alice-1"] * 3
  assert asyncio.run(server.get_access_token(session_id)) == "access-refresh-alice-1"
  assert oauth_client.token_exchanges == ["refresh-alice"]

  server._google_access_tokens[session_id] = ("expired", 0)
  assert asyncio.run(server.get_access_token(session_id)) == "access-refresh-alice-2"
  assert oauth_client.token_exchanges == ["refresh-alice", "refresh-alice"]


def test_oauth_callback_clears_cached_access_token(tmp_path, monkeypatch):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  oauth_client = FakeOAuthClient()
  monkeypatch.setattr(server, "_google_session_store", store)
  monkeypatch.setattr(server, "get_http_client", lambda: oauth_client)
  monkeypatch.setattr(server, "_google_access_tokens", {})
  monkeypatch.setattr(server, "_google_access_token_locks", {})
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client")
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")

  client = TestClient(server.app)
  start = client.get("/api/google-docs/oauth/start", follow_redirects=False)
  session_id = client.cookies[server.GOOGLE_SESSION_COOKIE]
  server._google_access_tokens[session_id] = ("stale", float("inf"))

  callback = client.get(
    "/api/google-docs/oauth/callback",
    params={"code": "alice", "state": oauth_state(start)},
  )

  assert callback.status_code == 200
  assert session_id not in server._google_access_tokens


def test_oauth_callback_rejects_another_browsers_state(tmp_path, monkeypatch):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  monkeypatch.setattr(server, "_google_session_store", store)
  monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client")

  client_a = TestClient(server.app)
  client_b = TestClient(server.app)
  start_a = client_a.get("/api/google-docs/oauth/start", follow_redirects=False)
  client_b.get("/api/google-docs/oauth/start", follow_redirects=False)

  response = client_b.get(
    "/api/google-docs/oauth/callback",
    params={"code": "stolen", "state": oauth_state(start_a)},
  )

  assert response.status_code == 400
  assert response.json()["detail"] == "Invalid OAuth state"


def test_google_api_requires_this_browsers_authorization(tmp_path, monkeypatch):
  store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  monkeypatch.setattr(server, "_google_session_store", store)

  response = TestClient(server.app).get("/api/google-docs/document")

  assert response.status_code == 401
  assert "401" in response.json()["detail"]

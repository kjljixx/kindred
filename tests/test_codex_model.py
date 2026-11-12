from __future__ import annotations

import base64
import json
import sqlite3

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from kindred import server
from kindred.chat import CODEX_MODEL, DEFAULT_MODEL
from kindred.google_sessions import GoogleSessionStore

ALLOWED_EMAIL = "allowed@gmail.com"


def make_id_token(claims: dict) -> str:
  payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
  return f"header.{payload}.signature"


@pytest.fixture
def store(tmp_path, monkeypatch):
  session_store = GoogleSessionStore(tmp_path / "sessions.sqlite3", Fernet.generate_key())
  monkeypatch.setattr(server, "_google_session_store", session_store)
  monkeypatch.setattr(server, "CODEX_ALLOWED_EMAILS", frozenset({ALLOWED_EMAIL}))
  monkeypatch.setattr(server, "require_codex_login", lambda _model: None)
  return session_store


def client_with_email(store: GoogleSessionStore, email: str | None) -> TestClient:
  client = TestClient(server.app)
  session_id = store.create_session()
  if email:
    store.save_email(session_id, email)
  client.cookies.set(server.GOOGLE_SESSION_COOKIE, session_id)
  return client


def test_store_lowercases_email_and_migrates_old_databases(tmp_path):
  database_path = tmp_path / "old.sqlite3"
  with sqlite3.connect(database_path) as connection:
    connection.execute(
      "CREATE TABLE browser_sessions (session_hash TEXT PRIMARY KEY, "
      "encrypted_refresh_token BLOB, created_at REAL NOT NULL, expires_at REAL NOT NULL)"
    )
  store = GoogleSessionStore(database_path, Fernet.generate_key())
  session_id = store.create_session()
  assert store.get_email(session_id) is None
  store.save_email(session_id, "  Mixed.Case@Gmail.com ")
  assert store.get_email(session_id) == "mixed.case@gmail.com"


def test_id_token_email_requires_verification():
  assert server.verified_email_from_id_token(None) is None
  assert server.verified_email_from_id_token(
    make_id_token({"email": "A@gmail.com", "email_verified": False})
  ) is None
  assert server.verified_email_from_id_token(
    make_id_token({"email": "A@gmail.com", "email_verified": True})
  ) == "a@gmail.com"


def test_allowlisted_account_gets_codex_model(store):
  client = client_with_email(store, ALLOWED_EMAIL)
  assert client.get("/api/chat/model").json() == {"model": CODEX_MODEL}


@pytest.mark.parametrize("email", [None, "other@gmail.com"])
def test_other_accounts_keep_default_model(store, email):
  client = client_with_email(store, email)
  assert client.get("/api/chat/model").json() == {"model": DEFAULT_MODEL}


def test_codex_model_request_is_rejected_for_other_accounts(store):
  client = client_with_email(store, "other@gmail.com")
  response = client.post("/api/chat", json={"model": CODEX_MODEL, "message": "hi"})
  assert response.status_code == 403


def test_chat_uses_codex_model_and_reports_it(store, monkeypatch):
  seen_models = []

  def fake_stream(**kwargs):
    seen_models.append(kwargs["model"])
    yield "text", "hello"

  monkeypatch.setattr(server, "chat_draft_stream", fake_stream)
  client = client_with_email(store, ALLOWED_EMAIL)
  response = client.post("/api/chat", json={"model": DEFAULT_MODEL, "message": "hi"})
  events = [json.loads(line) for line in response.text.splitlines() if line]
  assert seen_models == [CODEX_MODEL]
  assert events[-1]["type"] == "done"
  assert events[-1]["model"] == CODEX_MODEL

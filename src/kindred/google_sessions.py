from __future__ import annotations

import base64
import hashlib
import os
import secrets
import sqlite3
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

SESSION_MAX_AGE_S = 60 * 60 * 24 * 365
OAUTH_STATE_MAX_AGE_S = 60 * 10


def _hash_secret(value: str) -> str:
  return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _default_data_dir() -> Path:
  configured = os.environ.get("KINDRED_DATA_DIR")
  return Path(configured).expanduser() if configured else Path.home() / ".kindred"


def _load_encryption_key(data_dir: Path) -> bytes:
  configured = os.environ.get("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY")
  if configured:
    try:
      key = base64.urlsafe_b64decode(configured.encode("ascii"))
    except Exception as exc:
      raise RuntimeError(
        "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY must be URL-safe base64"
      ) from exc
    if len(key) != 32:
      raise RuntimeError(
        "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes"
      )
    return base64.urlsafe_b64encode(key)

  data_dir.mkdir(parents=True, exist_ok=True)
  key_path = data_dir / "google-sessions.key"
  try:
    return key_path.read_bytes()
  except FileNotFoundError:
    key = Fernet.generate_key()
    descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as key_file:
      key_file.write(key)
    return key


class GoogleSessionStore:
  def __init__(self, database_path: Path | None = None, encryption_key: bytes | None = None):
    data_dir = _default_data_dir()
    self.database_path = database_path or data_dir / "google-sessions.sqlite3"
    self.database_path.parent.mkdir(parents=True, exist_ok=True)
    self.cipher = Fernet(encryption_key or _load_encryption_key(data_dir))
    self._initialize()

  def _connect(self) -> sqlite3.Connection:
    connection = sqlite3.connect(self.database_path)
    connection.execute("PRAGMA journal_mode = WAL")
    return connection

  def _initialize(self) -> None:
    with self._connect() as connection:
      connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS browser_sessions (
          session_hash TEXT PRIMARY KEY,
          encrypted_refresh_token BLOB,
          created_at REAL NOT NULL,
          expires_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_attempts (
          state_hash TEXT PRIMARY KEY,
          session_hash TEXT NOT NULL,
          expires_at REAL NOT NULL
        );
        """
      )

  def create_session(self, now: float | None = None) -> str:
    created_at = now if now is not None else time.time()
    session_id = secrets.token_urlsafe(32)
    with self._connect() as connection:
      connection.execute("DELETE FROM oauth_attempts WHERE expires_at <= ?", (created_at,))
      connection.execute("DELETE FROM browser_sessions WHERE expires_at <= ?", (created_at,))
      connection.execute(
        """
        INSERT INTO browser_sessions (session_hash, created_at, expires_at)
        VALUES (?, ?, ?)
        """,
        (_hash_secret(session_id), created_at, created_at + SESSION_MAX_AGE_S),
      )
    return session_id

  def session_exists(self, session_id: str, now: float | None = None) -> bool:
    current_time = now if now is not None else time.time()
    with self._connect() as connection:
      row = connection.execute(
        """
        SELECT 1 FROM browser_sessions
        WHERE session_hash = ? AND expires_at > ?
        """,
        (_hash_secret(session_id), current_time),
      ).fetchone()
    return row is not None

  def create_oauth_attempt(self, session_id: str, now: float | None = None) -> str:
    current_time = now if now is not None else time.time()
    state = secrets.token_urlsafe(32)
    session_hash = _hash_secret(session_id)
    with self._connect() as connection:
      connection.execute("DELETE FROM oauth_attempts WHERE expires_at <= ?", (current_time,))
      connection.execute(
        """
        INSERT INTO oauth_attempts (state_hash, session_hash, expires_at)
        VALUES (?, ?, ?)
        """,
        (_hash_secret(state), session_hash, current_time + OAUTH_STATE_MAX_AGE_S),
      )
    return state

  def consume_oauth_attempt(
    self, session_id: str, state: str, now: float | None = None
  ) -> bool:
    current_time = now if now is not None else time.time()
    with self._connect() as connection:
      cursor = connection.execute(
        """
        DELETE FROM oauth_attempts
        WHERE state_hash = ? AND session_hash = ? AND expires_at > ?
        """,
        (_hash_secret(state), _hash_secret(session_id), current_time),
      )
    return cursor.rowcount == 1

  def save_refresh_token(self, session_id: str, refresh_token: str) -> None:
    encrypted_token = self.cipher.encrypt(refresh_token.encode("utf-8"))
    with self._connect() as connection:
      cursor = connection.execute(
        """
        UPDATE browser_sessions
        SET encrypted_refresh_token = ?
        WHERE session_hash = ? AND expires_at > ?
        """,
        (encrypted_token, _hash_secret(session_id), time.time()),
      )
    if cursor.rowcount != 1:
      raise ValueError("Browser session is missing or expired")

  def get_refresh_token(self, session_id: str) -> str | None:
    with self._connect() as connection:
      row = connection.execute(
        """
        SELECT encrypted_refresh_token FROM browser_sessions
        WHERE session_hash = ? AND expires_at > ?
        """,
        (_hash_secret(session_id), time.time()),
      ).fetchone()
    if row is None or row[0] is None:
      return None
    try:
      return self.cipher.decrypt(row[0]).decode("utf-8")
    except InvalidToken as exc:
      raise RuntimeError("Stored Google credential could not be decrypted") from exc

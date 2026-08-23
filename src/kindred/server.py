from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from urllib.parse import urlencode
from collections import deque
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
import httpx
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest
from pydantic import BaseModel, Field

from kindred.chat import DEFAULT_MODEL, chat_draft_stream
from kindred.tracing import configure_tracing

STATIC_DIR = Path(__file__).resolve().parent / "static" / "dist"

app = FastAPI(title="kindred", docs_url=None, redoc_url=None)

_credentials = None
_auth_request = GoogleAuthRequest()
_http_client: httpx.AsyncClient | None = None
_oauth_states: set[str] = set()
_google_refresh_token: str | None = None
GOOGLE_OAUTH_REDIRECT_URI = os.environ.get(
  "GOOGLE_OAUTH_REDIRECT_URI",
  "https://kindred.kjljixx.com/api/google-docs/oauth/callback",
)


def get_access_token() -> str:
  global _credentials
  if _google_refresh_token:
    return get_refresh_access_token()
  if _credentials is None:
    _credentials, _ = google_auth_default(
      scopes=["https://www.googleapis.com/auth/documents"]
    )
  if not _credentials.valid:
    _credentials.refresh(_auth_request)
  return _credentials.token


def get_refresh_access_token() -> str:
  global _google_refresh_token
  response = httpx.post(
    "https://oauth2.googleapis.com/token",
    data={
      "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
      "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
      "refresh_token": _google_refresh_token,
      "grant_type": "refresh_token",
    },
    timeout=15.0,
  )
  response.raise_for_status()
  return response.json()["access_token"]


def get_http_client() -> httpx.AsyncClient:
  global _http_client
  if _http_client is None or _http_client.is_closed:
    _http_client = httpx.AsyncClient(timeout=15.0)
  return _http_client


WRITE_RATE_WINDOW_S = 60.0

_write_times: deque[float] = deque()
_write_slot_lock = asyncio.Lock()


def earliest_write_time(
  times: Iterable[float], now: float, window_s: float = WRITE_RATE_WINDOW_S
) -> float:
  earliest = now
  covered = 1
  for r in sorted((t for t in times if t > now - window_s and t <= now), reverse=True):
    candidate = r + covered * covered / window_s
    if candidate > earliest:
      earliest = candidate
    covered += 1
  return earliest


async def acquire_write_slot() -> float:
  """Wait until the square-root write budget allows another send; returns seconds waited."""
  async with _write_slot_lock:
    arrived = time.perf_counter()
    send_at = earliest_write_time(_write_times, arrived)
    if send_at > arrived:
      await asyncio.sleep(send_at - arrived)
    sent_at = time.perf_counter()
    _write_times.append(sent_at)
    cutoff = sent_at - WRITE_RATE_WINDOW_S
    while _write_times[0] <= cutoff:
      _write_times.popleft()
    return sent_at - arrived


class SelectionOffsets(BaseModel):
  from_: int = Field(default=0, alias="from")
  to: int = 0

  model_config = {"populate_by_name": True}


class ChatMessage(BaseModel):
  role: str
  content: str
  draft_text: str = ""
  selection: SelectionOffsets | None = None


class ChatRequest(BaseModel):
  model: str = DEFAULT_MODEL
  messages: list[ChatMessage] = Field(default_factory=list)
  message: str
  draft_text: str = ""
  selection: SelectionOffsets | None = None
  conflict_context: str = ""


class GoogleDocsBatchUpdateRequest(BaseModel):
  document_id: str = Field(alias="documentId")
  requests: list[dict[str, Any]] = Field(default_factory=list)
  target_revision_id: str | None = Field(default=None, alias="targetRevisionId")

  model_config = {"populate_by_name": True}


GOOGLE_DOCS_DOCUMENT_ID = "1sADU8OrbDmZW1VyuaARqjVNjmWLHl2wWl3R71WkCEDI"


@app.get("/api/google-docs/oauth/start")
async def google_oauth_start() -> RedirectResponse:
  state = secrets.token_urlsafe(24)
  _oauth_states.add(state)
  query = urlencode({
    "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
    "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
    "response_type": "code",
    "access_type": "offline",
    "prompt": "consent",
    "scope": "https://www.googleapis.com/auth/documents",
    "state": state,
  })
  return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")


@app.get("/api/google-docs/oauth/callback")
async def google_oauth_callback(code: str, state: str) -> str:
  global _google_refresh_token
  if state not in _oauth_states:
    raise HTTPException(status_code=400, detail="Invalid OAuth state")
  _oauth_states.remove(state)
  response = await get_http_client().post(
    "https://oauth2.googleapis.com/token",
    data={
      "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
      "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
      "code": code,
      "grant_type": "authorization_code",
      "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
    },
  )
  if response.is_error:
    raise HTTPException(status_code=response.status_code, detail=response.text)
  _google_refresh_token = response.json().get("refresh_token")
  return "Google Docs connected. You can close this window."


async def fetch_google_document(document_id: str = GOOGLE_DOCS_DOCUMENT_ID) -> dict[str, Any]:
  token = get_access_token()
  response = await get_http_client().get(
    f"https://docs.googleapis.com/v1/documents/{document_id}",
    headers={"Authorization": f"Bearer {token}"},
  )
  if response.is_error:
    try:
      detail = response.json().get("error", {}).get("message", response.text)
    except Exception:
      detail = response.text
    raise HTTPException(status_code=response.status_code, detail=detail)
  return response.json()


async def fetch_google_revision(document_id: str = GOOGLE_DOCS_DOCUMENT_ID) -> str | None:
  token = get_access_token()
  response = await get_http_client().get(
    f"https://docs.googleapis.com/v1/documents/{document_id}",
    params={"fields": "revisionId"},
    headers={"Authorization": f"Bearer {token}"},
  )
  if response.is_error:
    try:
      detail = response.json().get("error", {}).get("message", response.text)
    except Exception:
      detail = response.text
    raise HTTPException(status_code=response.status_code, detail=detail)
  return response.json().get("revisionId")


@app.get("/api/google-docs/document")
async def api_google_docs_document(documentId: str = GOOGLE_DOCS_DOCUMENT_ID) -> dict[str, Any]:
  try:
    document = await fetch_google_document(documentId)
    return {"revisionId": document.get("revisionId"), "document": document}
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/google-docs/revision")
async def api_google_docs_revision(documentId: str = GOOGLE_DOCS_DOCUMENT_ID) -> dict[str, str | None]:
  try:
    return {"revisionId": await fetch_google_revision(documentId)}
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/chat")
async def api_chat(body: ChatRequest) -> StreamingResponse:
  message = body.message.strip()
  if not message:
    raise HTTPException(status_code=400, detail="message is required")

  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
  loop = asyncio.get_running_loop()

  def emit(event: dict[str, Any]) -> None:
    loop.call_soon_threadsafe(queue.put_nowait, event)

  def run() -> None:
    try:
      prior = []
      for m in body.messages:
        item: dict[str, Any] = {
          "role": m.role,
          "content": m.content,
          "draft_text": m.draft_text,
        }
        if m.selection is not None:
          item["selection"] = {"from": m.selection.from_, "to": m.selection.to}
        prior.append(item)
      sel = None
      if body.selection is not None:
        sel = {"from": body.selection.from_, "to": body.selection.to}
      cost_out: dict[str, float] = {}
      summary_out: dict[str, str | None] = {}
      reply = ""
      for kind, delta in chat_draft_stream(
        draft_text=body.draft_text,
        message=message,
        messages=prior,
        selection=sel,
        conflict_context=body.conflict_context,
        model=body.model,
        _cost_out=cost_out,
        _summary_out=summary_out,
      ):
        if kind == "thinking":
          emit({"type": "thinking_delta", "delta": delta})
        elif kind == "text":
          reply += delta
          emit({"type": "delta", "delta": delta})

      cost = float(cost_out.get("cost", 0.0))
      summary = summary_out.get("summary")
      emit({"type": "done", "reply": reply, "cost": cost, "reasoning_summary": summary})
    except Exception as exc:  # noqa: BLE001 — surface LM/runtime errors to UI
      emit({"type": "error", "detail": str(exc)})

  async def generate():
    task = asyncio.create_task(asyncio.to_thread(run))
    try:
      while True:
        event = await queue.get()
        yield json.dumps(event) + "\n"
        if event.get("type") in ("done", "error"):
          break
    finally:
      await task

  return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/api/google-docs/batch-update")
async def api_google_docs_batch_update(body: GoogleDocsBatchUpdateRequest) -> dict[str, Any]:
  if not body.document_id:
    raise HTTPException(status_code=400, detail="documentId is required")
  if not body.requests:
    return {"status": "ok", "message": "No requests to process"}

  t_start = time.perf_counter()

  try:
    token = get_access_token()
    client = get_http_client()

    url = f"https://docs.googleapis.com/v1/documents/{body.document_id}:batchUpdate"
    headers = {
      "Authorization": f"Bearer {token}",
      "Content-Type": "application/json",
    }

    t_gate_start = time.perf_counter()
    rate_waited = await acquire_write_slot()
    t_req_start = time.perf_counter()
    google_body: dict[str, Any] = {"requests": body.requests}
    if body.target_revision_id:
      google_body["writeControl"] = {"targetRevisionId": body.target_revision_id}
    response = await client.post(url, json=google_body, headers=headers)
    t_req_done = time.perf_counter()

    print(
      f"[GDocs Sync BE] Total: {(t_req_done - t_start)*1000:.1f}ms | "
      f"Token Check: {(t_gate_start - t_start)*1000:.1f}ms | "
      f"Rate Wait: {rate_waited*1000:.1f}ms | "
      f"Google REST API: {(t_req_done - t_req_start)*1000:.1f}ms"
    )

    if response.is_error:
      try:
        err_detail = response.json().get("error", {}).get("message", response.text)
      except Exception:
        err_detail = response.text
      raise HTTPException(status_code=response.status_code, detail=err_detail)

    return response.json()
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
  index_path = STATIC_DIR / "index.html"
  if not index_path.is_file():
    raise HTTPException(status_code=404, detail="UI not found")
  index_html = index_path.read_text(encoding="utf-8")
  stylesheet = re.search(r'<link rel="stylesheet" crossorigin href="([^"]+\.css)">', index_html)
  headers = {}
  if stylesheet:
    headers["Link"] = f'<{stylesheet.group(1)}>; rel=preload; as=style; fetchpriority=high'
  return FileResponse(index_path, headers=headers)


if STATIC_DIR.is_dir():
  app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def run_server(*, host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
  import threading
  import time
  import webbrowser

  import uvicorn

  load_dotenv()
  configure_tracing()

  if open_browser:
    def _open() -> None:
      time.sleep(0.6)
      webbrowser.open(f"http://{host}:{port}/")

    threading.Thread(target=_open, daemon=True).start()

  uvicorn.run(app, host=host, port=port, log_level="info")

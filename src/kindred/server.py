from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from kindred.chat import chat_unit
from kindred.review import DEFAULT_MAX_WORKERS, DEFAULT_MODEL, review
from kindred.tracing import configure_tracing

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="kindred", docs_url=None, redoc_url=None)


class ReviewRequest(BaseModel):
  text: str
  model: str = DEFAULT_MODEL
  max_workers: int = Field(default=DEFAULT_MAX_WORKERS, ge=1, le=64)


class ChatMessage(BaseModel):
  role: str
  content: str


class ChatRequest(BaseModel):
  text: str
  model: str = DEFAULT_MODEL
  scope: str
  unit_text: str = ""
  unit_feedback: str = ""
  text_current: str = ""
  unit_text_current: str = ""
  messages: list[ChatMessage] = Field(default_factory=list)
  message: str


@app.post("/api/review")
async def api_review(body: ReviewRequest) -> StreamingResponse:
  text = body.text.strip()
  if not text:
    raise HTTPException(status_code=400, detail="text is required")

  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
  loop = asyncio.get_running_loop()

  def on_progress(event: dict[str, Any]) -> None:
    loop.call_soon_threadsafe(queue.put_nowait, event)

  def run() -> None:
    try:
      result = review(
        text,
        model=body.model,
        max_workers=body.max_workers,
        on_progress=on_progress,
      )
      on_progress({"type": "done", "result": result.to_dict()})
    except Exception as exc:  # noqa: BLE001 — surface LM/runtime errors to UI
      on_progress({"type": "error", "detail": str(exc)})

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


@app.post("/api/chat")
async def api_chat(body: ChatRequest) -> StreamingResponse:
  text = body.text.strip()
  message = body.message.strip()
  if not text:
    raise HTTPException(status_code=400, detail="text is required")
  if not message:
    raise HTTPException(status_code=400, detail="message is required")
  if body.scope not in ("text", "sentence", "paragraph"):
    raise HTTPException(status_code=400, detail="invalid scope")

  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
  loop = asyncio.get_running_loop()

  def emit(event: dict[str, Any]) -> None:
    loop.call_soon_threadsafe(queue.put_nowait, event)

  def run() -> None:
    try:
      reply, cost = chat_unit(
        text=text,
        scope=body.scope,  # type: ignore[arg-type]
        unit_text=body.unit_text,
        unit_feedback=body.unit_feedback,
        text_current=body.text_current,
        unit_text_current=body.unit_text_current,
        messages=[m.model_dump() for m in body.messages],
        message=message,
        model=body.model,
      )
      emit({"type": "done", "reply": reply, "cost": cost})
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


@app.get("/")
def index() -> FileResponse:
  index_path = STATIC_DIR / "index.html"
  if not index_path.is_file():
    raise HTTPException(status_code=404, detail="UI not found")
  return FileResponse(index_path)


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

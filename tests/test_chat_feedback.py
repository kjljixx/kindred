"""Feedback-chat tests use fake streams; they never call a model provider."""

import asyncio
import json

import pytest
from fastapi import HTTPException

from kindred import chat, lm, server
from kindred.prompts import annotate_draft


def test_default_chat_model_is_openrouter_free():
  assert chat.DEFAULT_MODEL == "openrouter/free"
  assert server.ChatRequest(message="Help me revise this").model == chat.DEFAULT_MODEL


def test_litellm_model_preserves_openrouter_free_router_id():
  assert lm.litellm_model("openrouter/free") == "openrouter/openrouter/free"
  assert lm.litellm_model("openrouter/google/gemini-3.7-flash") == (
    "openrouter/google/gemini-3.7-flash"
  )


def test_streaming_endpoint_emits_deltas_and_done(monkeypatch):
  received = {}

  def fake_stream(**kwargs):
    received.update(kwargs)
    yield "text", "A draft "
    yield "text", "reply."

  monkeypatch.setattr(server, "chat_draft_stream", fake_stream)
  body = server.ChatRequest(
    message="Help me revise this",
    draft_text="A draft",
    conflict_context="Conflict 1: current / incoming",
  )

  async def collect():
    response = await server.api_chat(body)
    return "".join([chunk async for chunk in response.body_iterator])

  events = [json.loads(line) for line in asyncio.run(collect()).splitlines()]
  assert events == [
    {"type": "delta", "delta": "A draft "},
    {"type": "delta", "delta": "reply."},
    {"type": "done", "reply": "A draft reply.", "cost": 0.0, "reasoning_summary": None},
  ]
  assert received["conflict_context"] == "Conflict 1: current / incoming"


def test_chat_endpoint_rejects_non_free_model_when_restricted(monkeypatch):
  monkeypatch.setattr(server, "REQUIRE_OPENROUTER_FREE_MODEL", True)
  body = server.ChatRequest(message="Help me revise this", model="openai/gpt-5.6-luna")

  async def request():
    await server.api_chat(body)

  with pytest.raises(HTTPException, match="Only the openrouter/free model is allowed") as exc:
    asyncio.run(request())

  assert exc.value.status_code == 403


def test_stream_prompt_includes_conflicts_and_action_protocol(monkeypatch):
  captured = {}

  def fake_reflect_stream(**kwargs):
    captured.update(kwargs)
    yield (
      "text",
      '<mention start="0" end="8"><original>A senten</original>'
      "<prefix></prefix><suffix>ce.</suffix></mention>",
    )

  monkeypatch.setattr(chat, "reflect_chat_stream", fake_reflect_stream)
  assert list(chat.chat_draft_stream(
    draft_text="A sentence.",
    message="Improve it",
    messages=[],
    conflict_context="Conflict 1: Current: A; Incoming: B",
  )) == [(
    "text",
    '<mention start="0" end="8"><original>A senten</original>'
    "<prefix></prefix><suffix>ce.</suffix></mention>",
  )]
  prompt = captured["prompt"]
  assert "XML text anchor" in prompt[0]["content"]
  assert '<mention start="' in prompt[0]["content"]
  assert '<suggestion start="' in prompt[0]["content"]
  assert "Unresolved merge-conflict context" in prompt[-1]["content"]


def test_draft_annotation_only_adds_focus_markers():
  assert annotate_draft("Hello, world!", 0, 0) == (
    "<caret>Hello, world!"
  )

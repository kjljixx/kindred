"""Feedback-chat tests use fake streams; they never call a model provider."""

import asyncio
import json

from kindred import chat, server
from kindred.prompts import annotate_draft


def test_streaming_endpoint_emits_deltas_and_done(monkeypatch):
  received = {}

  def fake_stream(**kwargs):
    received.update(kwargs)
    yield "A draft "
    yield "reply."

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
    {"type": "done", "reply": "A draft reply.", "cost": 0.0},
  ]
  assert received["conflict_context"] == "Conflict 1: current / incoming"


def test_stream_prompt_includes_conflicts_and_action_protocol(monkeypatch):
  captured = {}

  def fake_reflect_stream(**kwargs):
    captured.update(kwargs)
    yield "[[mention:0:8]]"

  monkeypatch.setattr(chat, "reflect_chat_stream", fake_reflect_stream)
  assert list(chat.chat_draft_stream(
    draft_text="A sentence.",
    message="Improve it",
    messages=[],
    conflict_context="Conflict 1: Current: A; Incoming: B",
  )) == ["[[mention:0:8]]"]
  prompt = captured["prompt"]
  assert "[[mention:start:end]]" in prompt[0]["content"]
  assert "Unresolved merge-conflict context" in prompt[-1]["content"]


def test_draft_annotation_includes_every_50_character_offset():
  annotated = annotate_draft("x" * 101, 0, 0)
  assert "<offset>50</offset>" in annotated
  assert "<offset>100</offset>" in annotated


def test_draft_annotation_adds_offset_after_punctuation():
  assert annotate_draft("Hello, world!", 0, 0) == (
    "<caret>Hello,<offset>6</offset> world!<offset>13</offset>"
  )
  assert "<offset>6</offset>" not in annotate_draft("Hello; world", 0, 0)

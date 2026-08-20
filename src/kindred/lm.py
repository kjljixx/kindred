from __future__ import annotations

from cmath import log
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import litellm

from kindred.tracing import (
  configure_tracing,
  litellm_metadata,
  observe,
  record_reasoning_summary,
)

HUMAN_MODEL = "human"
END_SENTINEL = "END"
_HUMAN_PROMPT_LOCK = threading.Lock()
_RESPONSE_LOG_LOCK = threading.Lock()
_REASONING_MODEL_RE = re.compile(
  r"(?:^|/)(?:gpt-5|o1|o3|o4)(?:[-./]|$)",
  re.IGNORECASE,
)
DEFAULT_REASONING_EFFORT: dict[str, str] = {"effort": "medium", "summary": "auto"}
RESPONSE_LOG_PATH = Path(
  os.getenv("KINDRED_RESPONSE_LOG", "kindred_responses.log")
)


def is_human_model(model: str) -> bool:
  return model.strip().lower() == HUMAN_MODEL


def is_reasoning_model(model: str) -> bool:
  """True for OpenAI-style reasoning model ids (gpt-5*, o1*, o3*, o4*)."""
  return bool(_REASONING_MODEL_RE.search(model.strip()))


def resolve_reasoning_effort(
  model: str,
  reasoning_effort: str | dict[str, Any] | None = None,
) -> str | dict[str, Any] | None:
  """
  Return the reasoning_effort to send to LiteLLM.

  Explicit values win. Otherwise reasoning models get a default that requests
  a summary (requires an OpenAI-verified org for ``summary``).
  """
  if reasoning_effort is not None:
    return reasoning_effort
  if is_reasoning_model(model):
    return dict(DEFAULT_REASONING_EFFORT)
  return None


@observe(as_type="task", name="kindred.complete_chat")
def complete_chat(
  *,
  model: str,
  system: str,
  user: str,
  temperature: float | None = None,
  max_tokens: int = 40000,
  purpose: str = "chat",
  metadata: dict[str, Any] | None = None,
  reasoning_effort: str | dict[str, Any] | None = None,
  _cost_out: dict[str, float] | None = None,
) -> str:
  """
  Single-turn completion via LiteLLM Responses API, or interactive human input.

  Returns final assistant text only. Reasoning / summaries (when requested)
  stay on the provider response for OpenLLMetry to export; they are not mixed
  into the returned string.
  """
  if is_human_model(model):
    if _cost_out is not None:
      _cost_out["cost"] = 0.0
    return _human_chat_completion(system=system, user=user, role="task")

  configure_tracing()
  kwargs: dict[str, Any] = {
    "model": model,
    "instructions": system,
    "input": user,
    "max_output_tokens": max_tokens,
    "metadata": litellm_metadata(
      generation_name=f"kindred.{purpose}",
      tags=["kindred", purpose],
      extra=metadata,
    ),
  }
  if temperature is not None:
    kwargs["temperature"] = temperature

  resolved = resolve_reasoning_effort(model, reasoning_effort)
  request_summary: str | None = None
  if resolved is not None:
    if isinstance(resolved, dict):
      kwargs["reasoning"] = resolved
      summary_mode = resolved.get("summary")
      if summary_mode is not None:
        request_summary = str(summary_mode)
    else:
      kwargs["reasoning"] = {"effort": resolved, "summary": "auto"}
      request_summary = "auto"

  kwargs["tools"] = [{
    "type": "web_search_preview"
  }]

  response = litellm.responses(**kwargs)
  _log_full_response(
    purpose=purpose,
    model=model,
    request_summary=request_summary,
    response=response,
    kwargs=kwargs,
  )
  record_reasoning_summary(response, request_summary=request_summary)
  if _cost_out is not None:
    try:
      _cost_out["cost"] = float(
        litellm.completion_cost(completion_response=response) or 0.0
      )
    except Exception:
      _cost_out["cost"] = 0.0
  return _responses_output_text(response)


def _response_to_loggable(response: Any) -> Any:
  """Best-effort JSON-serializable dump of a LiteLLM / OpenAI response object."""
  for attr in ("model_dump", "dict"):
    method = getattr(response, attr, None)
    if callable(method):
      try:
        return method()
      except TypeError:
        try:
          return method(mode="json")
        except Exception:
          pass
      except Exception:
        pass
  if hasattr(response, "json") and callable(response.json):
    try:
      raw = response.json()
      return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
      pass
  try:
    return json.loads(json.dumps(response, default=str))
  except Exception:
    return {"repr": repr(response)}


def _log_full_response(
  *,
  purpose: str,
  model: str,
  request_summary: str | None,
  response: Any,
  kwargs: dict[str, Any],
) -> None:
  """Append the full Responses API payload to KINDRED_RESPONSE_LOG."""
  record = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "purpose": purpose,
    "model": model,
    "request_summary": request_summary,
    "request": {
      "instructions": kwargs.get("instructions"),
      "input": kwargs.get("input"),
      "reasoning": kwargs.get("reasoning"),
      "max_output_tokens": kwargs.get("max_output_tokens"),
      "temperature": kwargs.get("temperature"),
      "metadata": kwargs.get("metadata"),
    },
    "response": _response_to_loggable(response),
  }
  line = json.dumps(record, default=str, ensure_ascii=False)
  try:
    with _RESPONSE_LOG_LOCK:
      RESPONSE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
      with RESPONSE_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
  except Exception as exc:
    print(f"kindred: failed to write {RESPONSE_LOG_PATH}: {exc}", file=sys.stderr)


def _responses_output_text(response: Any) -> str:
  """Extract final assistant text from a LiteLLM / OpenAI Responses payload."""
  output_text = getattr(response, "output_text", None)
  if output_text:
    return str(output_text).strip()

  if isinstance(response, dict) and response.get("output_text"):
    return str(response["output_text"]).strip()

  output = getattr(response, "output", None)
  if output is None and isinstance(response, dict):
    output = response.get("output")
  if output:
    parts: list[str] = []
    for item in output:
      item_type = getattr(item, "type", None) or (
        item.get("type") if isinstance(item, dict) else None
      )
      if item_type != "message":
        continue
      content = getattr(item, "content", None)
      if content is None and isinstance(item, dict):
        content = item.get("content")
      if not content:
        continue
      for part in content:
        part_type = getattr(part, "type", None) or (
          part.get("type") if isinstance(part, dict) else None
        )
        if part_type != "output_text":
          continue
        text = getattr(part, "text", None)
        if text is None and isinstance(part, dict):
          text = part.get("text")
        if text:
          parts.append(str(text))
    if parts:
      return "\n".join(parts).strip()

  try:
    content = response.choices[0].message.content
  except Exception:
    content = None
  if content:
    return str(content).strip()
  return ""


@observe(as_type="task", name="kindred.reflect")
def reflect_chat(
  *,
  model: str,
  prompt: str | list[dict[str, Any]],
  temperature: float | None = None,
  max_tokens: int = 40000,
  purpose: str = "reflection",
  reasoning_effort: str | dict[str, Any] | None = None,
  _cost_out: dict[str, float] | None = None,
) -> str:
  """Multi-turn chat completion via LiteLLM Responses (traced like complete_chat)."""
  if is_human_model(model):
    if _cost_out is not None:
      _cost_out["cost"] = 0.0
    return _prompt_human(_format_prompt_payload(prompt), role="chat")

  configure_tracing()
  instructions, input_payload = _prompt_to_responses_io(prompt)
  kwargs: dict[str, Any] = {
    "model": model,
    "input": input_payload,
    "max_output_tokens": max_tokens,
    "metadata": litellm_metadata(
      generation_name=f"kindred.{purpose}",
      tags=["kindred", purpose],
    ),
  }
  if instructions:
    kwargs["instructions"] = instructions
  if temperature is not None:
    kwargs["temperature"] = temperature

  resolved = resolve_reasoning_effort(model, reasoning_effort)
  request_summary: str | None = None
  if resolved is not None:
    if isinstance(resolved, dict):
      kwargs["reasoning"] = resolved
      summary_mode = resolved.get("summary")
      if summary_mode is not None:
        request_summary = str(summary_mode)
    else:
      kwargs["reasoning"] = {"effort": resolved, "summary": "auto"}
      request_summary = "auto"

  kwargs["tools"] = [{
    "type": "web_search_preview"
  }]

  response = litellm.responses(**kwargs)
  _log_full_response(
    purpose=purpose,
    model=model,
    request_summary=request_summary,
    response=response,
    kwargs=kwargs,
  )
  record_reasoning_summary(response, request_summary=request_summary)
  if _cost_out is not None:
    try:
      _cost_out["cost"] = float(
        litellm.completion_cost(completion_response=response) or 0.0
      )
    except Exception:
      _cost_out["cost"] = 0.0
  return _responses_output_text(response)


def reflect_chat_stream(
  *,
  model: str,
  prompt: str | list[dict[str, Any]],
  temperature: float | None = None,
  max_tokens: int = 40000,
  purpose: str = "reflection",
  reasoning_effort: str | dict[str, Any] | None = None,
  _cost_out: dict[str, float] | None = None,
  _summary_out: dict[str, str | None] | None = None,
) -> Any:
  if is_human_model(model):
    if _cost_out is not None:
      _cost_out["cost"] = 0.0
    yield "text", _prompt_human(_format_prompt_payload(prompt), role="chat")
    return

  configure_tracing()
  instructions, input_payload = _prompt_to_responses_io(prompt)
  kwargs: dict[str, Any] = {
    "model": model,
    "input": input_payload,
    "max_output_tokens": max_tokens,
    "stream": True,
    "text": {"format": {"type": "text"}},
    "metadata": litellm_metadata(
      generation_name=f"kindred.{purpose}", tags=["kindred", purpose]
    ),
  }
  if instructions:
    kwargs["instructions"] = instructions
  if temperature is not None:
    kwargs["temperature"] = temperature

  resolved = resolve_reasoning_effort(model, reasoning_effort)
  request_summary: str | None = None
  if resolved is not None:
    if isinstance(resolved, dict):
      kwargs["reasoning"] = resolved
      summary_mode = resolved.get("summary")
      if summary_mode is not None:
        request_summary = str(summary_mode)
    else:
      kwargs["reasoning"] = {"effort": resolved, "summary": "auto"}
      request_summary = "auto"

  final_response: Any = None
  for event in litellm.responses(**kwargs):
    event_type_str = str(
      event.get("type", "") if isinstance(event, dict) else getattr(event, "type", "")
    ).lower()

    if (
      "completed" in event_type_str
      or "response_done" in event_type_str
      or "response.done" in event_type_str
    ):
      final_response = (
        event.get("response") if isinstance(event, dict) else getattr(event, "response", None)
      ) or event

    delta_type, delta_text = _response_stream_delta(event)
    if delta_text:
      yield delta_type, delta_text

  if final_response is not None:
    _log_full_response(
      purpose=purpose,
      model=model,
      request_summary=request_summary,
      response=final_response,
      kwargs=kwargs,
    )
    record_reasoning_summary(final_response, request_summary=request_summary)
    if _summary_out is not None:
      from kindred.tracing import extract_reasoning_summary
      _summary_out["summary"] = extract_reasoning_summary(final_response)

  if _cost_out is not None:
    cost = 0.0
    if final_response is not None:
      try:
        cost = float(litellm.completion_cost(completion_response=final_response) or 0.0)
      except Exception:
        cost = 0.0
    _cost_out["cost"] = cost


def _response_stream_delta(event: Any) -> tuple[str, str]:
  """Extract (kind, text) from a LiteLLM / Responses stream event."""
  choices = getattr(event, "choices", None) if not isinstance(event, dict) else event.get("choices")
  if choices and len(choices) > 0:
    choice_delta = getattr(choices[0], "delta", None) if not isinstance(choices[0], dict) else choices[0].get("delta")
    if choice_delta:
      r_content = getattr(choice_delta, "reasoning_content", None) if not isinstance(choice_delta, dict) else choice_delta.get("reasoning_content")
      if r_content:
        return "thinking", str(r_content)
      content = getattr(choice_delta, "content", None) if not isinstance(choice_delta, dict) else choice_delta.get("content")
      if content:
        return "text", str(content)

  if isinstance(event, dict):
    raw_kind = str(event.get("type", ""))
    delta = event.get("delta")
  else:
    raw_kind = str(getattr(event, "type", ""))
    delta = getattr(event, "delta", None)

  kind = raw_kind.lower()

  if (
    kind.endswith((".done", "_done", ".completed", "_completed"))
    or "item_done" in kind
    or "part_done" in kind
  ):
    return "", ""

  text = ""
  if isinstance(delta, str):
    text = delta
  elif isinstance(delta, dict):
    text = str(delta.get("text", "") or delta.get("content", "") or "")
  elif hasattr(delta, "text"):
    text = str(getattr(delta, "text", "") or "")

  if not text:
    return "", ""

  if "reasoning" in kind:
    return "thinking", text
  if "output_text" in kind or "text_delta" in kind or "text.delta" in kind or kind == "":
    return "text", text

  return "", ""


def _message_content_as_text(content: Any) -> str:
  if isinstance(content, str):
    return content
  if isinstance(content, list):
    texts: list[str] = []
    for item in content:
      if isinstance(item, dict) and item.get("type") == "text":
        texts.append(str(item.get("text", "")))
      else:
        texts.append(str(item))
    return "\n".join(texts)
  return str(content) if content is not None else ""


def _prompt_to_responses_io(
  prompt: str | list[dict[str, Any]],
) -> tuple[str | None, Any]:
  """Map a chat prompt to Responses ``instructions`` + ``input``."""
  if isinstance(prompt, str):
    return None, prompt

  instructions_parts: list[str] = []
  rest: list[dict[str, Any]] = []
  for message in prompt:
    role = str(message.get("role", "user"))
    content = message.get("content", "")
    if role == "system":
      text = _message_content_as_text(content).strip()
      if text:
        instructions_parts.append(text)
      continue
    rest.append({"role": role, "content": content})

  instructions = "\n\n".join(instructions_parts) or None
  if not rest:
    return instructions, ""
  if (
    len(rest) == 1
    and rest[0].get("role") == "user"
    and isinstance(rest[0].get("content"), str)
  ):
    return instructions, rest[0]["content"]
  return instructions, rest


def _human_chat_completion(*, system: str, user: str, role: str) -> str:
  rendered = (
    f"[SYSTEM]\n{system.strip()}\n\n"
    f"[USER]\n{user.strip()}"
  )
  return _prompt_human(rendered, role=role)


def _format_prompt_payload(prompt: str | list[dict[str, Any]]) -> str:
  if isinstance(prompt, str):
    return prompt
  parts: list[str] = []
  for message in prompt:
    role = str(message.get("role", "message")).upper()
    content = message.get("content", "")
    if isinstance(content, list):
      texts = []
      for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
          texts.append(str(item.get("text", "")))
        else:
          texts.append(str(item))
      content = "\n".join(texts)
    parts.append(f"[{role}]\n{content}")
  return "\n\n".join(parts)


def _prompt_human(rendered: str, *, role: str) -> str:
  # Serialize prompts so parallel callers never interleave stdin/stdout.
  with _HUMAN_PROMPT_LOCK:
    banner = f"kindred - human {role} model"
    sep = "=" * len(banner)
    print(f"\n{sep}\n{banner}\n{sep}", file=sys.stderr)
    print(rendered, file=sys.stderr)
    print(
      f"\n--- Enter your response. Finish with a line containing only: {END_SENTINEL} ---",
      file=sys.stderr,
    )
    lines: list[str] = []
    while True:
      try:
        line = sys.stdin.readline()
      except KeyboardInterrupt as exc:
        raise EOFError("Human model input interrupted") from exc
      if line == "":
        break
      if line.rstrip("\r\n") == END_SENTINEL:
        break
      lines.append(line)
    return "".join(lines).strip()

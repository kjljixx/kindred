from __future__ import annotations

from typing import Any, Literal

from kindred import prompts
from kindred.lm import reflect_chat
from kindred.review import DEFAULT_MODEL

ChatScope = Literal["text", "sentence", "paragraph"]


def chat_unit(
  *,
  text: str,
  scope: ChatScope,
  unit_text: str,
  unit_feedback: str,
  messages: list[dict[str, str]],
  message: str,
  text_current: str = "",
  unit_text_current: str = "",
  model: str = DEFAULT_MODEL,
  temperature: float | None = None,
  max_tokens: int = 40000,
) -> tuple[str, float]:
  """Continue a per-unit post-review conversation. Returns (reply, cost)."""
  text = text.strip()
  if not text:
    raise ValueError("chat_unit() requires non-empty text")
  user_message = message.strip()
  if not user_message:
    raise ValueError("chat_unit() requires a non-empty message")
  if scope not in ("text", "sentence", "paragraph"):
    raise ValueError(f"invalid chat scope: {scope!r}")

  prompt: list[dict[str, Any]] = [
    {"role": "system", "content": prompts.CHAT_SYSTEM},
    {
      "role": "user",
      "content": prompts.chat_context_user(
        text=text,
        scope=scope,
        unit_text=unit_text or "",
        unit_feedback=unit_feedback or "",
        text_current=text_current or "",
        unit_text_current=unit_text_current or "",
      ),
    },
    {
      "role": "assistant",
      "content": (
        "I have the text and my earlier feedback for this unit. "
        "Ask your follow-up whenever you're ready."
      ),
    },
  ]
  for prior in messages:
    role = str(prior.get("role", "")).strip()
    content = str(prior.get("content", "")).strip()
    if role not in ("user", "assistant") or not content:
      continue
    prompt.append({"role": role, "content": content})
  prompt.append({"role": "user", "content": user_message})

  cost_out: dict[str, float] = {}
  reply = reflect_chat(
    model=model,
    prompt=prompt,
    temperature=temperature,
    max_tokens=max_tokens,
    purpose="review_chat",
    _cost_out=cost_out,
  )
  return reply, float(cost_out.get("cost", 0.0))

from __future__ import annotations

from typing import Any

from kindred.lm import complete_chat


def complete(
  *,
  model: str,
  system: str,
  user: str,
  temperature: float | None = None,
  max_tokens: int = 40000,
  purpose: str = "chat",
  reasoning_effort: str | dict[str, Any] | None = None,
  _cost_out: dict[str, float] | None = None,
) -> str:
  """Single-turn chat completion (LiteLLM or interactive human)."""
  return complete_chat(
    model=model,
    system=system,
    user=user,
    temperature=temperature,
    max_tokens=max_tokens,
    purpose=purpose,
    reasoning_effort=reasoning_effort,
    _cost_out=_cost_out,
  )

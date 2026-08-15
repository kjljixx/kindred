from __future__ import annotations

from typing import Any

from kindred import prompts
from kindred.lm import reflect_chat, reflect_chat_stream

DEFAULT_MODEL = "openai/gpt-5.6-luna"


def _selection_offsets(selection: dict[str, Any] | None) -> tuple[int, int]:
  if not selection or not isinstance(selection, dict):
    return 0, 0
  try:
    start = int(selection.get("from", 0))
    end = int(selection.get("to", start))
  except (TypeError, ValueError):
    return 0, 0
  return start, end


def chat_draft(
  *,
  draft_text: str,
  message: str,
  messages: list[dict[str, Any]],
  selection: dict[str, Any] | None = None,
  conflict_context: str = "",
  model: str = DEFAULT_MODEL,
  temperature: float | None = None,
  max_tokens: int = 40000,
) -> tuple[str, float]:
  """Continue a draft-scoped chat. Returns (reply, cost)."""
  user_message = message.strip()
  if not user_message:
    raise ValueError("chat_draft() requires a non-empty message")

  sel_from, sel_to = _selection_offsets(selection)
  prompt: list[dict[str, Any]] = [
    {"role": "system", "content": prompts.CHAT_SYSTEM},
  ]

  for prior in messages:
    role = str(prior.get("role", "")).strip()
    content = str(prior.get("content", "")).strip()
    if role not in ("user", "assistant") or not content:
      continue
    if role == "assistant":
      prompt.append({"role": "assistant", "content": content})
      continue
    prior_draft = str(prior.get("draft_text", "") or "")
    p_from, p_to = _selection_offsets(prior.get("selection"))
    prompt.append(
      {
        "role": "user",
        "content": prompts.chat_user_turn(
          draft_text=prior_draft,
          selection_from=p_from,
          selection_to=p_to,
          message=content,
          conflict_context=str(prior.get("conflict_context", "") or ""),
        ),
      }
    )

  prompt.append(
    {
      "role": "user",
      "content": prompts.chat_user_turn(
        draft_text=str(draft_text or ""),
        selection_from=sel_from,
        selection_to=sel_to,
        message=user_message,
        conflict_context=conflict_context,
      ),
    }
  )

  cost_out: dict[str, float] = {}
  reply = reflect_chat(
    model=model,
    prompt=prompt,
    temperature=temperature,
    max_tokens=max_tokens,
    purpose="draft_chat",
    _cost_out=cost_out,
  )
  return reply, float(cost_out.get("cost", 0.0))


def chat_draft_stream(
  *,
  draft_text: str,
  message: str,
  messages: list[dict[str, Any]],
  selection: dict[str, Any] | None = None,
  conflict_context: str = "",
  model: str = DEFAULT_MODEL,
  temperature: float | None = None,
  max_tokens: int = 40000,
  _cost_out: dict[str, float] | None = None,
):
  """Yield a draft-scoped response as model text becomes available."""
  user_message = message.strip()
  if not user_message:
    raise ValueError("chat_draft_stream() requires a non-empty message")
  sel_from, sel_to = _selection_offsets(selection)
  prompt: list[dict[str, Any]] = [{"role": "system", "content": prompts.CHAT_SYSTEM}]
  for prior in messages:
    role = str(prior.get("role", "")).strip()
    content = str(prior.get("content", "")).strip()
    if role not in ("user", "assistant") or not content:
      continue
    if role == "assistant":
      prompt.append({"role": "assistant", "content": content})
    else:
      p_from, p_to = _selection_offsets(prior.get("selection"))
      prompt.append({"role": "user", "content": prompts.chat_user_turn(
        draft_text=str(prior.get("draft_text", "") or ""), selection_from=p_from,
        selection_to=p_to, message=content,
        conflict_context=str(prior.get("conflict_context", "") or ""),
      )})
  prompt.append({"role": "user", "content": prompts.chat_user_turn(
    draft_text=str(draft_text or ""), selection_from=sel_from, selection_to=sel_to,
    message=user_message, conflict_context=conflict_context,
  )})
  yield from reflect_chat_stream(
    model=model, prompt=prompt, temperature=temperature, max_tokens=max_tokens,
    purpose="draft_chat",
    _cost_out=_cost_out,
  )

from __future__ import annotations

CHAT_SYSTEM = (
  "You are a writing coach. Help the user improve their draft. "
  "Prioritize scannability when formatting your response. "
  "The draft may include <caret> (collapsed cursor) or <selection>…</selection> "
  "markers showing where the user was focused; treat those as context, not as "
  "literal text to quote back."
)


def annotate_draft(draft_text: str, selection_from: int, selection_to: int) -> str:
  """Escape angle brackets, then insert caret/selection markers at plain offsets."""
  text = str(draft_text or "")
  n = len(text)
  start = max(0, min(int(selection_from), n))
  end = max(0, min(int(selection_to), n))
  if end < start:
    start, end = end, start

  def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

  if start == end:
    return f"{esc(text[:start])}<caret>{esc(text[start:])}"
  return (
    f"{esc(text[:start])}<selection>{esc(text[start:end])}</selection>"
    f"{esc(text[end:])}"
  )


def chat_user_turn(*, draft_text: str, selection_from: int, selection_to: int, message: str) -> str:
  annotated = annotate_draft(draft_text, selection_from, selection_to)
  return (
    f"Draft (with focus markers):\n{annotated}\n\n"
    f"Question:\n{message.strip()}"
  )

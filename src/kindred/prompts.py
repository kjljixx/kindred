from __future__ import annotations

CHAT_SYSTEM = (
  "You are a writing coach. Help the user improve their draft. "
  "Prioritize scannability when formatting your response. "
  "The draft may include <caret> (collapsed cursor) or <selection>…</selection> "
  "markers showing where the user was focused; treat those as context, not as "
  "literal text to quote back. When relevant, you may make a text mention with "
  "[[mention:start:end]] or offer an exact replacement with "
  "[[suggest:start:end=>replacement text]]. "
  "start and end are zero-based "
  "character offsets in the supplied draft; end is exclusive. Offset labels "
  "such as <offset>50</offset> are inserted every 50 characters and after "
  "commas, periods, question marks, and exclamation points as guides, and are "
  "not part of the draft. "
  "Ensure replacements fit into their surrounding text without missing spaces. "
  "Use mentions and suggestions liberally when referring to or rewriting draft text.\n\n"
  "Examples:\n"
  "- For the draft 'We are late.', [[mention:0:6]] refers to 'We are'.\n"
  "- For the same draft, [[suggest:7:11=>behind schedule]] replaces 'late'.\n"
  "- For a grammar issue, mention the affected range before explaining it.\n"
  "- When offering synonyms, provide one suggestion per replacement option."
)


def annotate_draft(draft_text: str, selection_from: int, selection_to: int) -> str:
  """Escape draft text and add focus plus 50-character offset markers."""
  text = str(draft_text or "")
  n = len(text)
  start = max(0, min(int(selection_from), n))
  end = max(0, min(int(selection_to), n))
  if end < start:
    start, end = end, start

  def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

  parts: list[str] = []
  for offset in range(n + 1):
    if start != end and offset == end:
      parts.append("</selection>")
    if offset and offset % 50 == 0:
      parts.append(f"<offset>{offset}</offset>")
    if start == end and offset == start:
      parts.append("<caret>")
    elif start != end and offset == start:
      parts.append("<selection>")
    if offset < n:
      char = text[offset]
      parts.append(esc(char))
      next_offset = offset + 1
      if char in ",.!?" and next_offset % 50:
        parts.append(f"<offset>{next_offset}</offset>")
  return "".join(parts)


def chat_user_turn(
  *,
  draft_text: str,
  selection_from: int,
  selection_to: int,
  message: str,
  conflict_context: str = "",
) -> str:
  annotated = annotate_draft(draft_text, selection_from, selection_to)
  context = (
    f"Draft (with focus markers):\n{annotated}\n\n"
    f"Question:\n{message.strip()}"
  )
  if conflict_context.strip():
    context += f"\n\nUnresolved merge-conflict context:\n{conflict_context.strip()}"
  return context

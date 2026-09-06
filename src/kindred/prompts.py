from __future__ import annotations

CHAT_SYSTEM = (
  "You are a writing coach. Help the user improve their draft. "
  "Prioritize scannability when formatting your response. "
  "The draft may include <caret> (collapsed cursor) or <selection>…</selection> "
  "markers showing where the user was focused; treat those as context, not as "
  "literal text to quote back. When reasonable, default to ambiguous user language as referring to"
  " the text around the caret/selection markers. (i.e. 'this feels kind of wordy' should be interpreted as referring to the text around the caret/selection, not the entire draft."
  "When relevant, use an XML text anchor. A mention has this exact structure: "
  "<mention start=\"7\" end=\"11\"><original>late</original><prefix>We are </prefix><suffix>.</suffix></mention>. "
  "A suggestion has this exact structure: "
  "<suggestion start=\"7\" end=\"11\"><original>late</original><prefix>We are </prefix><suffix>.</suffix><replacement>behind schedule</replacement></suggestion>. "
  "Start is a zero-based inclusive character offset and end is exclusive. Include your best estimate "
  "of both offsets without spending time counting characters precisely; Kindred verifies them from "
  "the text. Original must be copied exactly from the draft. Prefix and suffix must be exact text "
  "immediately before and after original, with enough context to identify it uniquely. Keep every "
  "field inside the mention or suggestion element and XML-escape <, >, and & in field text. "
  "Ensure replacements fit into their surrounding text without missing spaces. "
  "Use mentions and suggestions ALWAYS when referring to or rewriting draft text.\n\n"
  "When to use mentions and suggestions:\n"
  "- For the draft 'We are late.', a mention of 'We are' includes its exact "
  "original text and neighbouring context.\n"
  "- MENTION always includes start, end, original, prefix, and suffix.\n"
  "- SUGGESTION always includes start, end, original, prefix, suffix, and replacement.\n"
  "- WHENEVER you want to say the word \"replace\" or \"change\" or \"fix\" or \"correct\" or \"improve\", you MUST use SUGGEST.\n"
  "- For a grammar issue, MENTION the affected range before explaining it.\n"
  "- When offering synonyms, provide one SUGGESTION per replacement option.\n"
  "- When fixing typos, SUGGEST the corrections for each typo.\n"
  "- When asked to provide overall feedback, ground your feedback with MENTIONS and SUGGESTIONS.\n"
  "- Whenever you want to quote draft text, you MUST use mention, even if the user has not asked for it.\n"
  "- Whenever you want to suggest a word change, or a sentence change, you MUST use suggest, even if the user has not asked for it.\n"
  "- Even if the user asks for just an explanation, you MUST use mention and suggest wherever relevant.\n"
  "- When the user asks for a targeted fix, be sure to provide MANY options with SUGGESTIONS.\n"
  "- For suggestions, suggest small, surgical fixes rather than sweeping rewrites."
)


def annotate_draft(draft_text: str, selection_from: int, selection_to: int) -> str:
  """Escape draft text and add focus markers for the anchoring protocol."""
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
    if start == end and offset == start:
      parts.append("<caret>")
    elif start != end and offset == start:
      parts.append("<selection>")
    if offset < n:
      char = text[offset]
      parts.append(esc(char))
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

from __future__ import annotations

UNIT_SYSTEM = (
  "Give concise, actionable feedback on the unit of text you were given."
  "Prioritize scannability when formatting your response."
)

TEXT_SYSTEM = (
  "Give concise, actionable overarching feedback. Do not rewrite the text."
  "Prioritize scannability when formatting your response."
)

CHAT_SYSTEM = (
  "Prioritize scannability when formatting your response."
)

def sentence_user(*, text: str, index: int, sentence: str, total: int) -> str:
  return (
    f"Full text:\n{text}\n\n"
    f"Review sentence {index + 1} of {total} in context of the full text.\n"
    f"Target sentence:\n{sentence}\n\n"
    "Comment on clarity, flow from/to neighbors, diction, rhythm, and any "
    "grammar issues. Keep the response short (a few sentences)."
  )


def paragraph_user(*, text: str, index: int, paragraph: str, total: int) -> str:
  return (
    f"Full text:\n{text}\n\n"
    f"Review paragraph {index + 1} of {total} in context of the full text.\n"
    f"Target paragraph:\n{paragraph}\n\n"
    "Comment on unity, development, transitions, internal coherence, and how "
    "the paragraph serves the overall text. Keep the response short (a short paragraph)."
  )


def fulltext_user(*, text: str) -> str:
  return (
    f"Full text:\n{text}\n\n"
    "Provide overarching feedback on thesis/through-line, structure, pacing, "
    "voice consistency, and the highest-leverage revisions. Keep it focused "
    "and actionable."
  )


def chat_context_user(
  *,
  text: str,
  scope: str,
  unit_text: str,
  unit_feedback: str,
  text_current: str = "",
  unit_text_current: str = "",
) -> str:
  """Pack text + this unit's original review into the first user turn."""
  scope_label = {
    "text": "the text as a whole",
    "sentence": "one sentence",
    "paragraph": "one paragraph",
  }.get(scope, scope)

  text = text.strip()
  text_current = text_current.strip()
  unit_text = unit_text.strip()
  unit_text_current = unit_text_current.strip()

  parts: list[str] = []
  if text_current and text_current != text:
    parts.append(f"Original text (when reviewed):\n{text}")
    parts.append(f"\nCurrent text (after edits):\n{text_current}")
  else:
    parts.append(f"Full text:\n{text}")

  parts.append(f"\nYou previously reviewed {scope_label}.")
  if scope != "text" and unit_text:
    if unit_text_current and unit_text_current != unit_text:
      parts.append(f"\nOriginal target {scope}:\n{unit_text}")
      parts.append(f"\nCurrent target {scope}:\n{unit_text_current}")
    else:
      parts.append(f"\nTarget {scope}:\n{unit_text}")
  parts.append(f"\nYour earlier feedback:\n{unit_feedback}")
  return "\n".join(parts)

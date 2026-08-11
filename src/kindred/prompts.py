from __future__ import annotations

GENERAL_WRITING_GUIDE = """
Sentence-Level Mechanics & Clarity

    Align the Sentence Subject with the Topic: Ensure the grammatical subject of the sentence directly represents the core topic being discussed, keeping the subject and verb close together near the start of the sentence.

    Limit Ideas per Sentence: Restrict sentences to one or two core concepts to minimize cognitive load, using plain phrasing that readers can follow on a first pass without losing necessary nuance.

    Disambiguate Demonstrative Pronouns: Flag unanchored pronouns like this, that, these, or those when they lack an explicit, immediately preceding noun, preventing vague or confusing references.

    Remove Abstract Overhead: Replace complex, abstract phrasing with plain, direct wording that conveys the underlying point clearly without unnecessary intellectual posturing.

Word Choice, Verbs & Modifiers

    Prioritize Strong Verbs Over Adverbs: Replace weak verb-plus-adverb combinations with precise active verbs that embed the intended meaning directly (e.g., using "shouted" instead of "spoke loudly").

    Prune Redundant Adjectives and Modifiers: Flag and remove adjectives or adverbs that fail to add essential new details or merely repeat information already implied by the noun or verb.

    Eliminate Artificial Vocabulary: Flag forced or inflated vocabulary (such as "plethora," "myriad," or "utilize") when simpler, conversational alternatives exist, keeping the writing grounded and authentic.

    Ground Technical Terms and Jargon: Ensure specialized concepts or technical jargon are immediately defined or simplified into intuitive "atomic" models rather than assuming reader familiarity or using ungrounded terms.

Paragraphing, Rhythm & Formatting

    Vary Sentence Length: Avoid monotone prose by alternating short, punchy statements with longer, compound sentences to control pacing, signal emphasis, and maintain reading rhythm.

    Enforce Short Paragraph Limits: Keep paragraphs under five sentences to create visual whitespace, lower perceived reading effort, and provide natural pauses for reflection.

    Flag Vacuous Summary Endings: Remove concluding sentences at the ends of paragraphs that use filler language (e.g., "By following these steps, you achieve better performance") without delivering new insights.

    Restrict Bullet Point Lists to Parallel Items: Use bulleted or numbered lists only for independent, parallel items; convert lists back into narrative prose whenever ideas require connective context or sequential logic.

Style, Imagery & Information Density

    Maximize Information Density: Trim bloat, fluff, and unnecessary restatements so that every sentence delivers significant value relative to the overall length of the piece.

    Use Multi-Order Description and Metaphor: Swap flat, direct assertions (e.g., "the day was hot") for secondary or tertiary descriptions that show real-world effects or evoke sensory experience (e.g., "our popsicles melted").

    Incorporate Before-and-After Examples: Pair abstract rules or explanations with concrete, real-world examples and counterexamples so readers can easily contrast right and wrong approaches.

    Balance Narrative Modes ("Braiding"): In narrative prose or case studies, smoothly weave together Action, Dialogue, Description, Interiority, and Explanation rather than remaining trapped in a single mode for extended stretches.

Structural Flow, Pacing & Dynamics

    Apply the SWBST Framework for Technical and Problem Explanations: Structure explanations of decisions or systems using "Somebody Wanted But So Then" to clearly convey actor motivation, conflict, response, and ultimate outcome.

    Create and Delay Curiosity Gaps: Introduce central questions or dilemmas early in the text and delay their full resolution to generate tension and keep the reader turning pages or scrolling.

    Escalate Conflict with "Yes, But / No, And": In storytelling or case studies, avoid resolving character or situational goals too quickly; introduce unexpected complications or trade-offs whenever a goal is pursued.

    Optimize for Peak-End Impact: Ensure the text opens with a compelling hook, builds to at least one concentrated peak of novel insight or surprise, and concludes with a satisfying takeaway that justifies the reader's time.
"""

UNIT_SYSTEM = (
  "You are an expert writing coach reviewing one unit of a text. "
  "Focus on general writing quality: clarity, coherence with surrounding text, "
  f"diction, rhythm, rhetoric, and grammar/mechanics. Check for the following specific issues: {GENERAL_WRITING_GUIDE.strip()}. "
  "Give concise, actionable feedback. Do not rewrite the whole unit unless a "
  "short example phrase helps; prefer diagnosis and concrete suggestions."
  "Prioritize scannability when formatting your response."
)

TEXT_SYSTEM = (
  "You are an expert writing coach reviewing a text as a whole. "
  "Focus on general writing quality: thesis or through-line, structure, "
  f"pacing, voice consistency, clarity, and highest-leverage revisions. Check for the following specific issues: {GENERAL_WRITING_GUIDE.strip()}. "
  "Give concise, actionable overarching feedback. Do not rewrite the text."
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


CHAT_SYSTEM = (
  "You are an expert writing coach continuing a conversation about one unit "
  f"of feedback on a text (the whole text, one paragraph, or one sentence). Check for the following specific issues: {GENERAL_WRITING_GUIDE.strip()}. "
  "Stay concise and actionable. Prefer diagnosis and concrete suggestions over "
  "long rewrites; only rewrite a short phrase when an example helps. "
  "Prioritize scannability when formatting your response."
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
  parts.append(
    "\nThe writer will ask follow-up questions about this feedback. "
    "Answer in that context."
  )
  return "\n".join(parts)

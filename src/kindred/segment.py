from __future__ import annotations

import re
from dataclasses import dataclass

_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> list[str]:
  return [s.strip() for s in _SENTENCE_SPLIT.split(text.strip()) if s.strip()]


@dataclass(frozen=True)
class TextSpan:
  text: str
  start: int
  end: int


def split_paragraphs(text: str) -> list[str]:
  """Split text into author paragraphs on blank lines."""
  return [span.text for span in paragraph_spans(text)]


def paragraph_spans(text: str) -> list[TextSpan]:
  """Paragraphs with character offsets into `text` (caller should strip first)."""
  if not text:
    return []
  parts = [p for p in _PARAGRAPH_SPLIT.split(text) if p.strip()]
  if not parts:
    return [TextSpan(text=text, start=0, end=len(text))]
  return _locate_spans(text, [p.strip() for p in parts])


def sentence_spans(text: str) -> list[TextSpan]:
  """Sentences with character offsets into `text` (caller should strip first)."""
  if not text:
    return []
  sentences = split_sentences(text)
  if not sentences:
    return []
  return _locate_spans(text, sentences)


def segment_text(text: str) -> tuple[list[str], list[str]]:
  """Return (paragraphs, sentences) for an text."""
  paragraphs = split_paragraphs(text)
  sentences = split_sentences(text)
  return paragraphs, sentences


def segment_text_spans(text: str) -> tuple[list[TextSpan], list[TextSpan]]:
  """Return (paragraph spans, sentence spans) for an text."""
  return paragraph_spans(text), sentence_spans(text)


def _locate_spans(text: str, units: list[str]) -> list[TextSpan]:
  spans: list[TextSpan] = []
  search_from = 0
  for unit in units:
    idx = text.find(unit, search_from)
    if idx < 0:
      idx = text.find(unit)
    if idx < 0:
      idx = search_from
      end = min(idx + len(unit), len(text))
    else:
      end = idx + len(unit)
    spans.append(TextSpan(text=unit, start=idx, end=end))
    search_from = end
  return spans

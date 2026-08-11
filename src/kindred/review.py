from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Callable
from typing import Any

from kindred import prompts
from kindred.generate import complete
from kindred.segment import TextSpan, segment_text_spans
from kindred.types import ReviewResult, UnitFeedback

DEFAULT_MODEL = "openai/gpt-5.6-luna"
DEFAULT_MAX_WORKERS = 8

ProgressCallback = Callable[[dict[str, Any]], None]


def _complete_priced(**kwargs: Any) -> tuple[str, float]:
  cost_out: dict[str, float] = {}
  text = complete(**kwargs, _cost_out=cost_out)
  return text, float(cost_out.get("cost", 0.0))


def review(
  text: str,
  *,
  model: str = DEFAULT_MODEL,
  max_workers: int = DEFAULT_MAX_WORKERS,
  temperature: float | None = None,
  max_tokens: int = 40000,
  on_progress: ProgressCallback | None = None,
) -> ReviewResult:
  """Analyze writing quality at sentence, paragraph, and text levels."""
  text = text.strip()
  if not text:
    raise ValueError("review() requires non-empty text")

  paragraph_spans, sentence_spans = segment_text_spans(text)
  complete_kwargs: dict[str, Any] = {
    "model": model,
    "temperature": temperature,
    "max_tokens": max_tokens,
  }

  sentences_total = len(sentence_spans)
  paragraphs_total = len(paragraph_spans)
  text_total = 1
  sentences_done = 0
  paragraphs_done = 0
  text_done = 0

  def emit_progress() -> None:
    if on_progress is None:
      return
    on_progress(
      {
        "type": "progress",
        "sentences_done": sentences_done,
        "sentences_total": sentences_total,
        "paragraphs_done": paragraphs_done,
        "paragraphs_total": paragraphs_total,
        "text_done": text_done,
        "text_total": text_total,
      }
    )

  sentence_feedback: list[UnitFeedback | None] = [None] * sentences_total
  paragraph_feedback: list[UnitFeedback | None] = [None] * paragraphs_total
  text_feedback = ""
  sentence_cost = 0.0
  paragraph_cost = 0.0
  text_cost = 0.0

  emit_progress()

  with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
    futures = {}

    for i, span in enumerate(sentence_spans):
      futures[
        pool.submit(
          _complete_priced,
          system=prompts.UNIT_SYSTEM,
          user=prompts.sentence_user(
            text=text,
            index=i,
            sentence=span.text,
            total=sentences_total,
          ),
          purpose="review_sentence",
          **complete_kwargs,
        )
      ] = ("sentence", i, span)

    for i, span in enumerate(paragraph_spans):
      futures[
        pool.submit(
          _complete_priced,
          system=prompts.UNIT_SYSTEM,
          user=prompts.paragraph_user(
            text=text,
            index=i,
            paragraph=span.text,
            total=paragraphs_total,
          ),
          purpose="review_paragraph",
          **complete_kwargs,
        )
      ] = ("paragraph", i, span)

    text_future = pool.submit(
      _complete_priced,
      system=prompts.TEXT_SYSTEM,
      user=prompts.fulltext_user(text=text),
      purpose="review_text",
      **complete_kwargs,
    )
    futures[text_future] = ("text", -1, None)

    for future in as_completed(futures):
      kind, index, span = futures[future]
      feedback, cost = future.result()
      if kind == "sentence":
        assert isinstance(span, TextSpan)
        sentence_cost += cost
        sentence_feedback[index] = UnitFeedback(
          index=index,
          text=span.text,
          feedback=feedback,
          start=span.start,
          end=span.end,
        )
        sentences_done += 1
      elif kind == "paragraph":
        assert isinstance(span, TextSpan)
        paragraph_cost += cost
        paragraph_feedback[index] = UnitFeedback(
          index=index,
          text=span.text,
          feedback=feedback,
          start=span.start,
          end=span.end,
        )
        paragraphs_done += 1
      else:
        text_cost += cost
        text_feedback = feedback
        text_done = 1
      emit_progress()

  return ReviewResult(
    sentences=[u for u in sentence_feedback if u is not None],
    paragraphs=[u for u in paragraph_feedback if u is not None],
    text=text_feedback,
    model=model,
    sentence_cost=sentence_cost,
    paragraph_cost=paragraph_cost,
    text_cost=text_cost,
  )

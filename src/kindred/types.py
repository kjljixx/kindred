from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class UnitFeedback:
  index: int
  text: str
  feedback: str
  start: int
  end: int


@dataclass(frozen=True)
class ReviewResult:
  sentences: list[UnitFeedback]
  paragraphs: list[UnitFeedback]
  text: str
  model: str = ""
  sentence_cost: float = 0.0
  paragraph_cost: float = 0.0
  text_cost: float = 0.0

  @property
  def total_cost(self) -> float:
    return self.sentence_cost + self.paragraph_cost + self.text_cost

  def to_dict(self) -> dict:
    return {
      "sentences": [asdict(u) for u in self.sentences],
      "paragraphs": [asdict(u) for u in self.paragraphs],
      "text": self.text,
      "model": self.model,
      "sentence_cost": self.sentence_cost,
      "paragraph_cost": self.paragraph_cost,
      "text_cost": self.text_cost,
      "total_cost": self.total_cost,
    }

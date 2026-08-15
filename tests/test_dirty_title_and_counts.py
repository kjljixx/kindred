from __future__ import annotations

from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage

# Distinct committed vs dirty strings so history cannot accidentally match.
COMMITTED = "Committed alpha text here"
DIRTY = "Dirty omega text here now"
LIVE = "Dirty title line with four more words"
PINNED = "Pinned Name"
REVIEW_BASE = "Review base paragraph one"
REVIEW_DIRTY = "Review dirty paragraph two"


def expected_word_char_counts(text: str) -> tuple[int, int]:
  """Mirror app.js countStats for a single-paragraph plain body."""
  raw = text or ""
  trimmed = raw.strip()
  chars = len(raw)
  words = len([w for w in trimmed.split() if w]) if trimmed else 0
  return words, chars


def test_live_dirty_drives_title_and_counts(kindred: KindredPage) -> None:
  kindred.paste_text(LIVE)
  kindred.wait_until_draft_active()
  kindred.wait_until_header_title(LIVE)
  words, chars = expected_word_char_counts(LIVE)
  kindred.wait_until_word_char_counts(words, chars)


def test_viewing_old_commit_keeps_dirty_title_and_counts(kindred: KindredPage) -> None:
  kindred.paste_text(COMMITTED)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.replace_editor_text(DIRTY)
  kindred.wait_until_header_title(DIRTY)
  dirty_words, dirty_chars = expected_word_char_counts(DIRTY)
  kindred.wait_until_word_char_counts(dirty_words, dirty_chars)

  # Only one commit; viewing it shows HEAD snapshot while WT stays dirty.
  kindred.view_commit_at(0)

  assert "viewing old commit" in kindred.status_text()
  assert kindred.header_title() == DIRTY
  assert kindred.word_char_counts() == (dirty_words, dirty_chars)
  assert kindred.editor_text() == COMMITTED


def test_manual_title_sticky_counts_still_dirty(kindred: KindredPage) -> None:
  kindred.paste_text(COMMITTED)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.rename_header_title(PINNED)
  kindred.replace_editor_text(DIRTY)
  dirty_words, dirty_chars = expected_word_char_counts(DIRTY)
  kindred.wait_until_word_char_counts(dirty_words, dirty_chars)
  assert kindred.header_title() == PINNED

  kindred.view_commit_at(0)

  assert "viewing old commit" in kindred.status_text()
  assert kindred.header_title() == PINNED
  assert kindred.word_char_counts() == (dirty_words, dirty_chars)


def test_dirty_review_keeps_dirty_title_and_counts(kindred: KindredPage) -> None:
  kindred.paste_text(REVIEW_BASE)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.replace_editor_text(REVIEW_DIRTY)
  kindred.wait_until_header_title(REVIEW_DIRTY)
  dirty_words, dirty_chars = expected_word_char_counts(REVIEW_DIRTY)
  kindred.wait_until_word_char_counts(dirty_words, dirty_chars)

  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  assert kindred.header_title() == REVIEW_DIRTY
  assert kindred.word_char_counts() == (dirty_words, dirty_chars)


def test_document_counts_ignore_empty_blocks_and_normalize_nonbreaking_spaces(
  kindred: KindredPage,
) -> None:
  kindred.wait_until_word_char_counts(0, 0)
  kindred.paste_text("Alpha\u00a0bravo.")
  kindred.wait_until_draft_active()
  kindred.press_keys(Keys.END, Keys.ENTER)
  kindred.type_text("Charlie!")
  kindred.wait_until_word_char_counts(3, len("Alpha bravo.\n\nCharlie!"))
  assert "2 sentences" in kindred.status_text()
  assert "2 paragraphs" in kindred.status_text()


def test_selection_counts_show_selected_over_total(kindred: KindredPage) -> None:
  text = "Alpha bravo. Charlie!"
  kindred.paste_text(text)
  kindred.wait_until_draft_active()
  kindred.select_editor_text(0, len("Alpha bravo."))
  kindred.wait_until_status_contains(
    "2/3 words · 12/20 chars · 1/2 sentences · 1/1 paragraph"
  )

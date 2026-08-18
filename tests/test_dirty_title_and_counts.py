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


def test_viewing_old_commit_keeps_dirty_title(kindred: KindredPage) -> None:
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
  kindred.wait_until_word_char_counts(3, len("Alpha bravo.Charlie!"))
  assert "2 sentences" in kindred.status_text()
  assert "2 paragraphs" in kindred.status_text()


def test_selection_counts_show_selected_over_total(kindred: KindredPage) -> None:
  text = "Alpha bravo. Charlie!"
  kindred.paste_text(text)
  kindred.wait_until_draft_active()
  kindred.select_editor_text(0, len("Alpha bravo."))
  kindred.wait_until_status_contains(
    "2/3 words · 12/21 chars · 1/2 sentences · 1/1 paragraph"
  )


def expected_table_counts() -> tuple[int, int, int, int]:
  """Expected words, chars, sentences, paragraphs for a 2x2 table.
  
  Table structure:
    <tr><td><p>Alpha</p></td><td><p>Bravo</p></td></tr>
    <tr><td><p>Charlie delta</p></td><td><p>Echo</p></td></tr>
  
  nodePlainText(table) joins cells with \n\n -> "Alpha\n\nBravo\n\nCharlie delta\n\nEcho"
  statsCharacterBlocksOf strips \t and \n -> "AlphaBravoCharlie deltaEcho" = 27 chars
  Words: Alpha, Bravo, Charlie, delta, Echo = 5
  Sentences: split on \n\n -> 4 (each cell treated as sentence)
  Paragraphs: split on \n\n -> 4
  """
  return 5, 27, 4, 4


def test_table_character_counts(kindred: KindredPage) -> None:
  """Test that table cell text is counted without structural newlines/tabs."""
  table_html = (
    "<table><tbody>"
    "<tr><td><p>Alpha</p></td><td><p>Bravo</p></td></tr>"
    "<tr><td><p>Charlie delta</p></td><td><p>Echo</p></td></tr>"
    "</tbody></table>"
  )
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  words, chars, sentences, paragraphs = expected_table_counts()
  kindred.wait_until_word_char_counts(words, chars)
  assert f"{sentences} sentences" in kindred.status_text()
  assert f"{paragraphs} paragraphs" in kindred.status_text()


def test_table_with_text_combined_counts(kindred: KindredPage) -> None:
  """Test counts when document has both table and regular paragraphs."""
  table_html = (
    "<table><tbody>"
    "<tr><td><p>Cell one</p></td><td><p>Cell two</p></td></tr>"
    "</tbody></table>"
  )
  text = "Intro paragraph."
  # Paste text first, then table
  kindred.paste_text(text)
  kindred.wait_until_draft_active()
  kindred.press_keys(Keys.END, Keys.ENTER)
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  
  # "Intro paragraph." = 2 words, 16 chars, 1 sentence, 1 paragraph
  # Table: "Cell one\n\nCell two" = 4 words, 16 chars (no newlines), 2 sentences, 2 paragraphs
  # Combined: 6 words, 32 chars, 3 sentences, 3 paragraphs
  kindred.wait_until_word_char_counts(6, 32)
  assert "3 sentences" in kindred.status_text()
  assert "3 paragraphs" in kindred.status_text()


def test_table_selection_counts(kindred: KindredPage) -> None:
  """Test selection counts work inside a table."""
  table_html = (
    "<table><tbody>"
    "<tr><td><p>Alpha bravo</p></td><td><p>Charlie delta</p></td></tr>"
    "</tbody></table>"
  )
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  # Select "Alpha bravo" (first cell, 11 chars, 2 words, 1 sentence, 1 paragraph)
  # Total: "Alpha bravo\n\nCharlie delta" -> 4 words, 24 chars, 2 sentences, 2 paragraphs
  kindred.select_editor_text(0, len("Alpha bravo"))
  kindred.wait_until_status_contains(
    "2/4 words · 11/24 chars · 1/2 sentences · 1/2 paragraph"
  )

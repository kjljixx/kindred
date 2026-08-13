"""Diff-mode tests (paragraph / inline only — no lists or tables).

Diff is word-granularity and available even when the working tree is clean.
"""

from __future__ import annotations

from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage


def _commit_then_edit(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_text(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text(dirty)
  kindred.wait_until_editor_text(dirty)


def test_d1_clean_working_tree_keeps_diff_available(kindred: KindredPage) -> None:
  kindred.paste_text("Clean head only")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  assert kindred.dirty_mode_enabled("diff")
  kindred.enter_dirty_diff()
  assert kindred.dirty_mode_active("diff")
  assert kindred.diff_ins_texts() == []
  assert kindred.diff_del_texts() == []


def test_d2_insert_at_end_paints_green(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "Hello", "Hello world")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "world" in ins
  assert "Hello" not in ins


def test_d3_insert_word_in_middle(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "red blue", "red green blue")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "green" in ins
  assert "red" not in ins
  assert "blue" not in ins


def test_d4_delete_word_shows_red(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "Hello world", "Hello")
  kindred.enter_dirty_diff()
  deleted = "".join(kindred.diff_del_texts())
  assert "world" in deleted


def test_d5_replace_word(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "cat", "dog")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  deleted = "".join(kindred.diff_del_texts())
  assert "dog" in ins or "dog" in kindred.editor_body_text()
  assert "cat" in deleted


def test_d6_new_paragraph_insert(kindred: KindredPage) -> None:
  kindred.paste_text("First")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.press_keys(Keys.END, Keys.ENTER)
  kindred.type_text("Second")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "Second" in ins
  assert "First" not in ins


def test_d7_delete_paragraph_shows_delete_chrome(kindred: KindredPage) -> None:
  kindred.paste_text("Keep\n\nDrop")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("Keep")
  kindred.wait_until_editor_text("Keep")
  kindred.enter_dirty_diff()
  deleted = "".join(kindred.diff_del_texts())
  assert "Drop" in deleted


def test_d8_edits_in_two_paragraphs_scope_paint(kindred: KindredPage) -> None:
  kindred.paste_text("Alpha one\n\nBravo two")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("Alpha extra\n\nBravo more")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "extra" in ins and "more" in ins
  assert "Alpha" not in ins
  assert "Bravo" not in ins


def test_d9_format_only_bold_does_not_invent_text_moves(kindred: KindredPage) -> None:
  kindred.paste_text("sameletters")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "sameletters" not in ins


def test_d10_align_change_keeps_text(kindred: KindredPage) -> None:
  kindred.paste_text("Align me")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.toolbar_click("alignCenter")
  assert kindred.paragraph_text_align(0) == "center"
  assert kindred.editor_text() == "Align me"
  kindred.enter_dirty_diff()
  assert kindred.editor_body_text() == "Align me"


def test_d11_backspace_in_diff_can_clear_text(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "ab", "a")
  kindred.enter_dirty_diff()
  kindred.select_all_in_editor()
  kindred.press_keys(Keys.BACK_SPACE)
  kindred.wait_until_editor_body_text("")


def test_d12_type_while_diff_on(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "Hi", "Hi there")
  kindred.enter_dirty_diff()
  kindred.press_keys(Keys.END)
  kindred.type_text(" now")
  assert "now" in kindred.editor_body_text()
  ins = "".join(kindred.diff_ins_texts())
  assert "there" in ins or "now" in ins


def test_d13_diff_text_diff_round_trip(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "Stable", "Stable extra")
  kindred.enter_dirty_diff()
  assert kindred.dirty_mode_active("diff")
  kindred.enter_dirty_text()
  assert kindred.dirty_mode_active("text")
  assert kindred.editor_body_text() == "Stable extra"
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  assert "extra" in ins


def test_d14_commit_clears_diff_chrome_keeps_diff_available(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "Before", "After")
  kindred.enter_dirty_diff()
  kindred.commit()
  assert kindred.dirty_mode_enabled("diff")
  assert kindred.editor_text() == "After"
  kindred.enter_dirty_diff()
  assert kindred.diff_ins_texts() == []
  assert kindred.diff_del_texts() == []


def test_d15_less_than_in_diff(kindred: KindredPage) -> None:
  _commit_then_edit(kindred, "a < b", "a << b")
  kindred.enter_dirty_diff()
  assert "<" in kindred.editor_text()
  ins = "".join(kindred.diff_ins_texts())
  deleted = "".join(kindred.diff_del_texts())
  assert "&lt;" not in ins and "&lt;" not in deleted

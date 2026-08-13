"""Dirty Review mode tests (paragraph / inline only — no lists or tables)."""

from __future__ import annotations

from pages.kindred import KindredPage


def _commit_then_dirty(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_text(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text(dirty)
  kindred.wait_until_editor_text(dirty)


def test_r1_clean_working_tree_disables_review(kindred: KindredPage) -> None:
  kindred.paste_text("Nothing dirty")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  assert not kindred.dirty_mode_enabled("review")
  assert kindred.dirty_mode_enabled("diff")


def test_r2_insert_only_shows_conflict(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "Hello", "Hello world")
  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  ours, theirs = kindred.conflict_button_texts()
  assert "world" in theirs or "Hello world" in theirs


def test_r3_delete_only_shows_conflict(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "Hello world", "Hello")
  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  ours, theirs = kindred.conflict_button_texts()
  labels = {ours.strip(), theirs.strip()}
  assert any("world" in x for x in labels) or "" in labels


def test_r4_replace_shows_both_sides(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "cat", "dog")
  kindred.enter_dirty_review()
  ours, theirs = kindred.conflict_button_texts()
  assert "cat" in ours
  assert "dog" in theirs


def test_r5_keep_dirty(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "cat", "dog")
  kindred.enter_dirty_review()
  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "dog"


def test_r6_keep_current_head(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "cat", "dog")
  kindred.enter_dirty_review()
  kindred.click_conflict_keep_ours(0)
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "cat"


def test_r7_leave_review_to_text_keeps_dirty(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "base line", "dirty line")
  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  kindred.enter_dirty_text()
  assert not kindred.has_merge_conflict_ui()
  assert kindred.editor_body_text() == "dirty line"


def test_r8_leave_review_to_diff_matches_dirty(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "base", "base extra")
  kindred.enter_dirty_review()
  kindred.enter_dirty_diff()
  kindred.wait_until_editor_body_text("base extra")
  ins = "".join(kindred.diff_ins_texts())
  assert "extra" in ins


def test_r9_multi_hunk_two_conflicts(kindred: KindredPage) -> None:
  kindred.paste_text("one\n\ntwo")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("ONE\n\nTWO")
  kindred.enter_dirty_review()
  assert kindred.conflict_count() >= 1
  kindred.enter_dirty_text()
  text = kindred.editor_body_text()
  assert "ONE" in text and "TWO" in text


def test_r10_format_only_review_or_clean(kindred: KindredPage) -> None:
  kindred.paste_text("format")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  if not kindred.dirty_mode_enabled("review"):
    assert "format" in kindred.editor_text()
    return
  kindred.enter_dirty_review(expect_conflicts=False)
  # Format-only may clean-merge (no widgets) or show mark conflict.
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "format"


def test_r11_align_conflict_in_review(kindred: KindredPage) -> None:
  kindred.paste_text("Align conflict")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.toolbar_click("alignCenter")
  if not kindred.dirty_mode_enabled("review"):
    assert kindred.paragraph_text_align(0) == "center"
    return
  kindred.enter_dirty_review(expect_conflicts=False)
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "Align conflict"


def test_r12_less_than_on_conflict_buttons(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "<<", "<<<")
  kindred.enter_dirty_review()
  ours, theirs = kindred.conflict_button_texts()
  assert "&lt;" not in ours and "&lt;" not in theirs
  assert "<" in ours or "<" in theirs


def test_r13_review_then_commit_keeps_dirty(kindred: KindredPage) -> None:
  _commit_then_dirty(kindred, "old", "new")
  kindred.enter_dirty_review()
  kindred.commit()
  assert kindred.editor_body_text() == "new"
  assert not kindred.dirty_mode_enabled("review")
  assert kindred.dirty_mode_enabled("diff")

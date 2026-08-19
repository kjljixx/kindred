"""Cross-mode transitions (paragraph / inline only — no lists or tables)."""

from __future__ import annotations

from pages.kindred import KindredPage


def _dirty_from_head(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_text(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text(dirty)
  kindred.wait_until_editor_text(dirty)


def test_x1_text_diff_text_preserves_body(kindred: KindredPage) -> None:
  _dirty_from_head(kindred, "Head", "Head dirty")
  kindred.enter_dirty_diff()
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "Head dirty"
  assert not kindred.has_merge_conflict_ui()


def test_x2_text_review_text_keeps_dirty(kindred: KindredPage) -> None:
  _dirty_from_head(kindred, "Head", "Dirty body")
  kindred.enter_dirty_review()
  kindred.enter_dirty_text()
  assert kindred.editor_body_text() == "Dirty body"
  assert not kindred.has_merge_conflict_ui()


def test_x3_diff_review_diff_consistent(kindred: KindredPage) -> None:
  _dirty_from_head(kindred, "base", "base extra")
  kindred.enter_dirty_diff()
  assert "extra" in "".join(kindred.diff_ins_texts())
  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  kindred.enter_dirty_diff()
  kindred.wait_until_editor_body_text("base extra")
  assert "extra" in "".join(kindred.diff_ins_texts())


def test_x4_review_diff_review(kindred: KindredPage) -> None:
  _dirty_from_head(kindred, "one", "two")
  kindred.enter_dirty_review()
  kindred.enter_dirty_diff()
  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  ours, theirs = kindred.conflict_button_texts()
  assert "one" in ours and "two" in theirs


def test_x5_history_view_then_dirty_text(kindred: KindredPage) -> None:
  kindred.paste_text("Committed snapshot")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("Live dirty now")
  kindred.wait_until_editor_text("Live dirty now")
  kindred.view_commit_at(0)
  assert "viewing old commit" in kindred.status_text()
  assert kindred.editor_text() == "Committed snapshot"
  kindred.exit_to_dirty_text()
  assert kindred.editor_body_text() == "Live dirty now"


def test_x6_live_merge_locks_dirty_modes(kindred: KindredPage) -> None:
  kindred.paste_text("Hello")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("Hello feature")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("Hello main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert not kindred.dirty_mode_enabled("diff")
  assert not kindred.dirty_mode_enabled("review")

from selenium.webdriver.common.keys import Keys

def test_x7_nested_leave_review(kindred: KindredPage) -> None:
  table_html = (
    """<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>tes</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>"""
  )
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  table_html = (
    """<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>test</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>"""
  )
  kindred.delete_table()
  kindred.paste_html(table_html)
  kindred.enter_dirty_review()
  kindred.enter_dirty_diff()
  kindred.enter_dirty_review()
  kindred.exit_to_dirty_text()
  assert not "conflict" in kindred.status_text()
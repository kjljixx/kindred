from __future__ import annotations

from pages.kindred import KindredPage

COMMIT_FOCUS = "Commit message focus test"
TITLE_FOCUS = "Title focus test"
DIFF_FOCUS_BASE = "Diff focus base text"
DIFF_FOCUS_EDIT = "Diff focus edited text"
RENAMED_TITLE = "Renamed Focus Title"


def test_commit_message_refocuses_editor(kindred: KindredPage) -> None:
  kindred.paste_text(COMMIT_FOCUS)
  kindred.wait_until_draft_active()
  kindred.click_commit()
  kindred.finish_commit_message_rename()
  kindred.wait_until_editor_focused()


def test_title_rename_refocuses_editor(kindred: KindredPage) -> None:
  kindred.paste_text(TITLE_FOCUS)
  kindred.wait_until_draft_active()
  kindred.rename_header_title(RENAMED_TITLE)
  kindred.wait_until_editor_focused()


def test_view_mode_refocuses_editor(kindred: KindredPage) -> None:
  kindred.paste_text(DIFF_FOCUS_BASE)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text(DIFF_FOCUS_EDIT)
  kindred.wait_until_draft_active()
  kindred.enter_dirty_diff()
  kindred.wait_until_editor_focused()

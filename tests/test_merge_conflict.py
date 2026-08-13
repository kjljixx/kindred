from __future__ import annotations

from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage

ALIGN_ATTR_HTML = (
  '<p data-kindred-align-ours="left" data-kindred-align-theirs="center" '
  'data-kindred-align-label-ours="main" data-kindred-align-label-theirs="feature">'
  "Hello</p>"
)


def test_merge_conflict_buttons_show_real_less_than(kindred: KindredPage) -> None:
  kindred.paste_text("<<")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("test")
  kindred.press_keys(Keys.END, "<")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.press_keys(Keys.END, Keys.BACK_SPACE)
  kindred.commit()

  kindred.merge_branch("test")

  ours, theirs = kindred.conflict_button_texts()
  labels = {ours, theirs}
  assert labels == {"<", "<<<"}
  assert "&lt;" not in ours
  assert "&lt;" not in theirs
  assert not kindred.dirty_mode_enabled("diff")
  assert not kindred.dirty_mode_enabled("review")


def test_pasted_align_attrs_are_not_a_merge_conflict(kindred: KindredPage) -> None:
  kindred.paste_html(ALIGN_ATTR_HTML)
  kindred.wait_until_draft_active()

  assert not kindred.has_merge_conflict_ui()
  assert "merge conflict" not in kindred.status_text().lower()

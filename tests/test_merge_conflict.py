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


def test_clean_merge_does_not_auto_commit(kindred: KindredPage) -> None:
  kindred.paste_text("base")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.press_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  before = kindred.commit_count()

  kindred.merge_branch("feature", expect_conflicts=False)

  assert not kindred.has_merge_conflict_ui()
  assert kindred.commit_count() == before
  assert kindred.commit_button_label() == "Merge"
  assert "merge ready" in kindred.status_text().lower()
  assert kindred.dirty_mode_enabled("diff")
  assert kindred.dirty_mode_enabled("review")

  kindred.enter_dirty_diff()
  assert "active" in (
    kindred.driver.find_element(*kindred.DIRTY_DIFF_BTN).get_attribute("class") or ""
  )

  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()
  assert "merge ready" in kindred.status_text().lower()
  assert "merge conflict" not in kindred.status_text().lower()

  kindred.enter_dirty_text()
  assert not kindred.has_merge_conflict_ui()
  assert "active" in (
    kindred.driver.find_element(*kindred.DIRTY_TEXT_BTN).get_attribute("class") or ""
  )
  assert "merge ready" in kindred.status_text().lower()

  kindred.enter_dirty_review()
  assert kindred.has_merge_conflict_ui()

  kindred.commit()
  assert kindred.commit_count() > before
  assert kindred.commit_button_label() == "Commit"
  assert "merge ready" not in kindred.status_text().lower()

"""Live branch merge tests (paragraph / inline only — no lists or tables)."""

from __future__ import annotations

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage


def test_m1_clean_merge_non_overlapping(kindred: KindredPage) -> None:
  # Separate paragraphs so 3-way merge does not treat edits as one conflicting span.
  kindred.paste_text("Shared start\n\nTail")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("Shared start\n\nTail feature")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("Main Shared start\n\nTail")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  text = kindred.editor_body_text()
  assert "Main" in text and "Shared start" in text and "feature" in text


def test_m2_text_conflict_on_same_span(kindred: KindredPage) -> None:
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
  assert kindred.has_merge_conflict_ui()
  assert not kindred.dirty_mode_enabled("diff")
  assert not kindred.dirty_mode_enabled("review")


def test_m3_resolve_keep_ours(kindred: KindredPage) -> None:
  kindred.paste_text("base")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("theirs")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("ours")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  kindred.click_conflict_keep_ours(0)
  assert "ours" in kindred.editor_text()
  assert not kindred.has_merge_conflict_ui() or kindred.conflict_count() == 0


def test_m4_resolve_keep_theirs(kindred: KindredPage) -> None:
  kindred.paste_text("base")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("theirs")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("ours")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  kindred.click_conflict_keep_theirs(0)
  assert "theirs" in kindred.editor_text()


def test_m5_keep_both_when_available(kindred: KindredPage) -> None:
  kindred.paste_text("base")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("left")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("right")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  both = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .merge-conflict-btn.merge-conflict-both",
  )
  if not both:
    # Product may hide Both for some conflict shapes.
    kindred.click_conflict_keep_theirs(0)
    return
  kindred.click_conflict_keep_both(0)
  text = kindred.editor_text()
  assert "left" in text and "right" in text


def test_m6_finish_merge_after_resolve(kindred: KindredPage) -> None:
  kindred.paste_text("base")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  kindred.replace_editor_text("feature body")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.replace_editor_text("main body")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  kindred.click_conflict_keep_theirs(0)
  assert kindred.commit_button_label() == "Merge"
  kindred.commit()
  assert kindred.commit_button_label() == "Commit"
  assert "feature body" in kindred.editor_text()


def test_m7_less_than_in_merge_conflict_buttons(kindred: KindredPage) -> None:
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

  kindred.merge_branch("test", expect_conflicts=True)
  ours, theirs = kindred.conflict_button_texts()
  assert "&lt;" not in ours and "&lt;" not in theirs

from __future__ import annotations

import time

from pages.kindred import KindredPage


def test_can_delete_main_when_not_current(kindred: KindredPage) -> None:
  kindred.paste_text("delete main branch")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  assert kindred.branch_has_delete_button("main")
  assert not kindred.branch_has_delete_button("feature")

  kindred.delete_branch("main")
  assert kindred.branch_names() == ["feature"]


def test_branches_sort_by_access_time(kindred: KindredPage) -> None:
  kindred.paste_text("branch access order")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("a")
  time.sleep(0.05)
  kindred.create_branch("b")
  assert kindred.branch_names() == ["b", "a", "main"]

  time.sleep(0.05)
  kindred.checkout_branch("main")
  assert kindred.branch_names() == ["main", "b", "a"]

  time.sleep(0.05)
  kindred.checkout_branch("a")
  assert kindred.branch_names() == ["a", "main", "b"]

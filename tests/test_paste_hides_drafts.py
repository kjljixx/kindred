from __future__ import annotations

from pages.kindred import KindredPage

PASTE_TEXT = "Hello from the paste test."


def test_paste_hides_drafts_pane(kindred: KindredPage) -> None:
  assert kindred.drafts_pane_visible()

  kindred.paste_text(PASTE_TEXT)
  kindred.wait_until_drafts_pane_hidden()

  assert not kindred.drafts_pane_visible()

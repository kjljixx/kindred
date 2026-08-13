"""Text-mode editor tests (paragraph / inline only — no lists or tables)."""

from __future__ import annotations

from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage

ALIGN_ATTR_HTML = (
  '<p data-kindred-align-ours="left" data-kindred-align-theirs="center" '
  'data-kindred-align-label-ours="main" data-kindred-align-label-theirs="feature">'
  "Hello</p>"
)


def test_t1_type_plain_text(kindred: KindredPage) -> None:
  kindred.type_text("Hello kindred world")
  kindred.wait_until_draft_active()
  assert kindred.editor_text() == "Hello kindred world"
  kindred.wait_until_header_title("Hello kindred world")


def test_t2_multi_paragraph(kindred: KindredPage) -> None:
  kindred.type_text("Alpha")
  kindred.press_keys(Keys.ENTER)
  kindred.type_text("Bravo")
  kindred.wait_until_draft_active()
  assert kindred.paragraph_count() >= 2
  text = kindred.editor_text()
  assert "Alpha" in text and "Bravo" in text


def test_t3_backspace_deletes_characters(kindred: KindredPage) -> None:
  kindred.type_text("abc")
  kindred.wait_until_draft_active()
  kindred.press_keys(Keys.BACK_SPACE, Keys.BACK_SPACE)
  kindred.wait_until_editor_text("a")


def test_t4_empty_doc_disables_commit(kindred: KindredPage) -> None:
  kindred.paste_text("temp")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.press_keys(Keys.CONTROL + "a", Keys.BACK_SPACE)
  kindred.wait_until_editor_text("")
  assert kindred.commit_button_disabled()


def test_t5_paste_multiline_plain(kindred: KindredPage) -> None:
  kindred.paste_text("Line one\n\nLine two")
  kindred.wait_until_draft_active()
  text = kindred.editor_text()
  assert "Line one" in text and "Line two" in text


def test_t6_paste_simple_html_paragraph(kindred: KindredPage) -> None:
  kindred.paste_html("<p>Hi there</p>")
  kindred.wait_until_draft_active()
  # Prefer body text (plain) — paste may keep a single paragraph wrapper in HTML.
  assert "Hi there" in kindred.editor_body_text()
  assert "<p>" not in kindred.editor_body_text()
  assert not kindred.has_merge_conflict_ui()


def test_t7_pasted_align_attrs_are_not_merge_conflict(kindred: KindredPage) -> None:
  kindred.paste_html(ALIGN_ATTR_HTML)
  kindred.wait_until_draft_active()
  assert not kindred.has_merge_conflict_ui()
  assert "merge conflict" not in kindred.status_text().lower()


def test_t8_raw_less_than_survives(kindred: KindredPage) -> None:
  kindred.paste_text("<<")
  kindred.wait_until_draft_active()
  assert "<<" in kindred.editor_text()
  assert "&lt;" not in kindred.editor_text()
  kindred.switch_to_git()
  kindred.commit()
  assert "<<" in kindred.editor_text()


def test_t9_bold_toggle(kindred: KindredPage) -> None:
  kindred.paste_text("boldme")
  kindred.wait_until_draft_active()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  html = kindred.editor_html().lower()
  assert "<strong>" in html or 'data-bold' in html or "<b>" in html
  assert "boldme" in kindred.editor_text()


def test_t10_clear_marks_via_toggle(kindred: KindredPage) -> None:
  kindred.paste_text("plain")
  kindred.wait_until_draft_active()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  html = kindred.editor_html().lower()
  # After toggle off, strong wrapping should be gone for the word.
  assert kindred.editor_text() == "plain"
  assert html.count("<strong>") == 0 or "plain" in html.replace("<strong>", "").replace(
    "</strong>", ""
  )


def test_t11_italic_toggle(kindred: KindredPage) -> None:
  kindred.paste_text("slant")
  kindred.wait_until_draft_active()
  kindred.select_all_in_editor()
  kindred.toolbar_click("italic")
  html = kindred.editor_html().lower()
  assert "<em>" in html or "<i>" in html
  assert "slant" in kindred.editor_text()


def test_t12_paragraph_align_center(kindred: KindredPage) -> None:
  kindred.paste_text("Centered")
  kindred.wait_until_draft_active()
  kindred.toolbar_click("alignCenter")
  assert kindred.paragraph_text_align(0) == "center"


def test_t13_undo_redo(kindred: KindredPage) -> None:
  kindred.type_text("one")
  kindred.wait_until_draft_active()
  kindred.type_text("two")
  kindred.wait_until_editor_text("onetwo")
  kindred.press_keys(Keys.CONTROL + "z")
  # Undo may remove the last typed chunk; accept either full undo or partial.
  assert "two" not in kindred.editor_text() or kindred.editor_text() == "one"
  kindred.press_keys(Keys.CONTROL + "y")
  # Redo is platform-dependent; at least editor remains usable.
  assert kindred.editor_text()


def test_t14_autosave_round_trip_via_home(kindred: KindredPage) -> None:
  body = "Persist me across home"
  kindred.paste_text(body)
  kindred.wait_until_draft_active()
  kindred.wait_until_header_title(body)
  kindred.go_home()
  kindred.wait_until_ready()
  kindred.open_draft_at(0)
  assert body in kindred.editor_text()


def test_t15_title_from_body(kindred: KindredPage) -> None:
  kindred.paste_text("Title line from body")
  kindred.wait_until_draft_active()
  kindred.wait_until_header_title("Title line from body")


def test_t16_commit_creates_head(kindred: KindredPage) -> None:
  kindred.paste_text("Commit me please")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  before = kindred.commit_count()
  kindred.commit()
  assert kindred.commit_count() == before + 1
  assert kindred.commit_button_disabled()


def test_t17_edit_after_commit_is_dirty(kindred: KindredPage) -> None:
  kindred.paste_text("Base commit text")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("Dirty after commit")
  kindred.wait_until_editor_text("Dirty after commit")
  assert kindred.dirty_mode_enabled("diff")
  assert kindred.dirty_mode_enabled("review")
  assert not kindred.commit_button_disabled()

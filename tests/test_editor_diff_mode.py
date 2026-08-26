"""Diff-mode tests for paragraphs, inline edits, lists, and tables.

Diff is word-granularity and available even when the working tree is clean.
"""

from __future__ import annotations
from io import BytesIO
import re
from turtle import delay

from PIL import Image
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage


def _commit_then_edit(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_text(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text(dirty)


def _commit_then_edit_html(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_html(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.press_keys(Keys.CONTROL + "a")
  kindred.paste_html(dirty)
  expected = re.sub(r"<[^>]+>", "", dirty)
  kindred.wait_until_editor_body_text(expected)


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


def test_d_list_text_edit_keeps_unchanged_bullets_plain(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>Keep</p></li><li><p>old milk</p></li></ul>",
    "<ul><li><p>Keep</p></li><li><p>new oat milk</p></li></ul>",
  )
  kindred.enter_dirty_diff()
  assert len(kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-ins")) == 0
  assert "new oat" in "".join(kindred.diff_ins_texts())
  assert "old" in "".join(kindred.diff_del_texts())
  assert "Keep" not in "".join(kindred.diff_ins_texts())


def test_d_list_item_add_only_marks_added_item(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>Keep</p></li><li><p>End</p></li></ul>",
    "<ul><li><p>Keep</p></li><li><p>Added</p></li><li><p>End</p></li></ul>",
  )
  kindred.enter_dirty_diff()
  added = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-ins")
  assert len(added) == 1
  assert added[0].text.strip() == "Added"
  assert not kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-ins")


def test_d_list_item_remove_leaves_red_item_ghost(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>Keep</p></li><li><p>Drop</p></li><li><p>End</p></li></ul>",
    "<ul><li><p>Keep</p></li><li><p>End</p></li></ul>",
  )
  kindred.enter_dirty_diff()
  removed = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-del")
  assert len(removed) == 1
  assert removed[0].text.strip() == "Drop"


def test_d_duplicate_list_item_backspace_shows_one_deleted_row(kindred: KindredPage) -> None:
  kindred.paste_html("<ul><li><p>test</p></li><li><p>test</p></li></ul>")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  second = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror li:nth-child(2) > p",
  )
  second.click()
  second.send_keys(Keys.END)
  for _ in range(5):
    kindred.driver.switch_to.active_element.send_keys(Keys.BACKSPACE)
  kindred.wait_until_editor_body_text("test")
  kindred.driver.switch_to.active_element.send_keys(Keys.BACKSPACE)
  kindred.wait.until(
    lambda driver: len(driver.find_elements(By.CSS_SELECTOR, "#editor .ProseMirror li")) == 1
  )
  assert len(kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .ProseMirror li")) == 1
  kindred.enter_dirty_diff()

  removed = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-del")
  assert len(removed) == 1
  assert removed[0].text.strip() == "test"
  rows = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .ProseMirror > ul > li")
  assert len(rows) == 2
  assert "diff-list-item-del" not in (rows[0].get_attribute("class") or "")
  assert "diff-list-item-del" in (rows[1].get_attribute("class") or "")
  assert not kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-ins")
  assert not kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-del")


def test_d_list_indent_shows_old_and_new_item_lines(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>A</p></li><li><p>B</p></li><li><p>C</p></li></ul>",
    "<ul><li><p>A</p><ul><li><p>B</p></li></ul></li><li><p>C</p></li></ul>",
  )
  kindred.enter_dirty_diff()
  inserted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-ins")
  deleted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-del")
  assert len(inserted) == 1
  assert inserted[0].text.strip() == "B"
  assert len(deleted) == 1
  assert deleted[0].text.strip() == "B"
  assert deleted[0].value_of_css_property("margin-left") == "0px"


def test_d_list_move_and_text_edit_keeps_both_signals(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>A</p></li><li><p>old B</p></li></ul>",
    "<ul><li><p>A</p><ul><li><p>new B</p></li></ul></li></ul>",
  )
  kindred.enter_dirty_diff()
  inserted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-ins")
  deleted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-del")
  assert len(inserted) == 1
  assert len(deleted) == 1
  assert kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > ul > li.diff-list-item-del",
  )
  assert kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > ul > li > ul > li > p.diff-list-item-ins",
  )
  assert "new" in "".join(kindred.diff_ins_texts())
  assert "old" in "".join(kindred.diff_del_texts())


def test_d_nested_duplicate_list_add_marks_only_new_deepest_item(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>test</p><ul><li><p>test</p></li></ul></li></ul>",
    "<ul><li><p>test</p><ul><li><p>test</p><ul><li><p>test</p></li></ul></li></ul></li></ul>",
  )
  kindred.enter_dirty_diff()
  inserted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-ins")
  deleted = kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-list-item-del")
  assert len(inserted) == 1
  assert len(deleted) == 0
  assert inserted[0].text.strip() == "test"
  assert kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > ul > li > ul > li > ul > li > p.diff-list-item-ins",
  )


def test_d8a_history_diff_scopes_an_edited_paragraph(kindred: KindredPage) -> None:
  kindred.paste_text("Alpha one\n\nBravo two")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.replace_editor_text("Alpha changed\n\nBravo two")
  kindred.commit()
  kindred.view_commit_at(0)
  kindred.enter_dirty_diff()

  assert "changed" in "".join(kindred.diff_ins_texts())
  assert "one" in "".join(kindred.diff_del_texts())
  assert "Bravo" not in "".join(kindred.diff_ins_texts())
  assert "Bravo" not in "".join(kindred.diff_del_texts())

def test_d8b_internal_empty_paragraphs_do_not_shift_diff_offsets(
  kindred: KindredPage,
) -> None:
  """Regression: authored empty paragraphs must remain in Diff coordinates."""

  kindred.paste_text("old")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.replace_editor_text("test")
  kindred.wait_until_editor_text("test")

  for _ in range(5):
    kindred.press_keys(Keys.END, Keys.ENTER, Keys.ENTER)
    kindred.type_text("test")

  kindred.enter_dirty_diff()

  ins = "".join(kindred.diff_ins_texts())
  deleted = "".join(kindred.diff_del_texts())

  assert ins.count("test") == 6
  assert "old" in deleted

def test_d9_format_only_bold_does_not_invent_text_moves(kindred: KindredPage) -> None:
  kindred.paste_text("sameletters")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  deleted = "".join(kindred.diff_del_texts())
  assert "sameletters" in ins
  assert "sameletters" in deleted
  assert kindred.editor_body_text() == "sameletters"


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


def _commit_then_bold(kindred: KindredPage) -> None:
  kindred.paste_text("hello")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.select_all_in_editor()
  kindred.toolbar_click("bold")
  kindred.wait.until(
    lambda d: kindred.editor_has_tag("strong") or kindred.editor_has_tag("b")
  )
  kindred.driver.find_element(*KindredPage.CHAT_TAB).click()
  kindred.switch_to_git()
  kindred.wait.until(lambda d: kindred.dirty_mode_enabled("review"))


def test_d_format_only_bold_paints_chrome(kindred: KindredPage) -> None:
  """Bold-only dirty → Diff green current + red HEAD widget."""
  _commit_then_bold(kindred)
  kindred.enter_dirty_diff()
  ins = "".join(kindred.diff_ins_texts())
  deleted = "".join(kindred.diff_del_texts())
  assert "hello" in ins
  assert "hello" in deleted

from selenium.webdriver.common.keys import Keys

def test_d_multi_table(kindred: KindredPage) -> None:
  table_html = (
    """<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>test</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>
<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>second</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>
    """
  )
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.delete_table()
  kindred.delete_table()
  table_html = (
    """<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>again</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>
<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>second</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>
    """
  )
  kindred.paste_html(table_html)
  kindred.enter_dirty_diff()
  tables = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table",
  )
  assert len(tables) == 2
  assert [
    cell.text.strip()
    for cell in tables[0].find_elements(
      By.CSS_SELECTOR,
      ".diff-table-cell-del",
    )
  ] == ["test"]
  assert [
    cell.text.strip()
    for cell in tables[0].find_elements(
      By.CSS_SELECTOR,
      ".diff-table-cell-ins",
    )
  ] == ["again"]
  assert not tables[1].find_elements(
    By.CSS_SELECTOR,
    ".diff-table-cell-del, .diff-table-cell-ins",
  )
  assert tables[1].find_element(
    By.CSS_SELECTOR,
    "tr:first-child td:first-child",
  ).text.strip() == "second"


def test_d_replacing_text_with_table_renders_deleted_text_before_table(
  kindred: KindredPage,
) -> None:
  kindred.paste_text("e")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.select_all_in_editor()
  kindred.press_keys(Keys.BACK_SPACE)
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p></p></td><td><p></p></td></tr>
    <tr><td><p></p></td><td><p></p></td></tr>
    </tbody></table>"""
  )
  kindred.enter_dirty_diff()

  assert kindred.driver.execute_script(
    """
    const deleted = document.querySelector('#editor .diff-del');
    const table = document.querySelector(
      '#editor .tableWrapper.diff-table-ins'
    );
    if (!deleted || !table) return null;
    const deletedRect = deleted.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    return {
      text: (deleted.textContent || '').trim(),
      insideTable: table.contains(deleted),
      beforeTable: Boolean(
        deleted.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      overlapsTable: !(
        deletedRect.bottom <= tableRect.top || deletedRect.top >= tableRect.bottom
      ),
    };
    """
  ) == {
    "text": "e",
    "insideTable": False,
    "beforeTable": True,
    "overlapsTable": False,
  }


def test_d_table_cell_edit_marks_only_changed_cell(kindred: KindredPage) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>Alpha</p></td><td><p>Beta</p></td></tr>
    <tr><td><p>Gamma</p></td><td><p>Delta</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  target = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
  )
  target.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, "!")
  kindred.wait.until(lambda d: "Beta!" in kindred.editor_body_text())
  kindred.enter_dirty_diff()

  inserted = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .diff-table-cell-ins",
  )
  deleted = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .diff-table-cell-del",
  )
  assert [cell.text.strip() for cell in inserted] == ["Beta!"]
  assert [cell.text.strip() for cell in deleted] == ["Beta"]
  assert not kindred.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-table-ins")


def test_d_table_middle_row_delete_stays_between_neighbors(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>Top</p></td></tr>
    <tr><td><p>Middle</p></td></tr>
    <tr><td><p>Bottom</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td",
  )
  middle.click()
  kindred.toolbar_click("deleteRow")
  kindred.wait.until(
    lambda d: [
      cell.text.strip()
      for cell in kindred.driver.find_elements(
        By.CSS_SELECTOR,
        "#editor .ProseMirror table td",
      )
    ] == ["Top", "Bottom"]
  )
  kindred.enter_dirty_diff()

  rows = kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => ({
        text: (row.textContent || '').trim(),
        deleted: row.classList.contains('diff-table-row-del'),
      }));
    """
  )
  assert rows == [
    {"text": "Top", "deleted": False},
    {"text": "Middle", "deleted": True},
    {"text": "Bottom", "deleted": False},
  ]


def test_d_table_middle_row_insert_stays_between_neighbors(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>Top</p></td></tr>
    <tr><td><p>Bottom</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  top = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td",
  )
  top.click()
  kindred.toolbar_click("addRowAfter")
  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td p",
  )
  middle.click()
  kindred.driver.switch_to.active_element.send_keys("Middle")
  kindred.wait.until(
    lambda d: [
      cell.text.strip()
      for cell in kindred.driver.find_elements(
        By.CSS_SELECTOR,
        "#editor .ProseMirror table td",
      )
    ] == ["Top", "Middle", "Bottom"]
  )
  kindred.enter_dirty_diff()

  rows = kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => ({
        text: (row.textContent || '').trim(),
        inserted: row.classList.contains('diff-table-row-ins'),
      }));
    """
  )
  assert rows == [
    {"text": "Top", "inserted": False},
    {"text": "Middle", "inserted": True},
    {"text": "Bottom", "inserted": False},
  ]
  inserted_row_edges = kindred.driver.execute_script(
    """
    const cell = document.querySelector('#editor tr.diff-table-row-ins > td');
    const style = getComputedStyle(cell);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-success-300)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { topStyle: style.borderTopStyle, topColor: style.borderTopColor, expected };
    """
  )
  assert inserted_row_edges == {
    "topStyle": "solid",
    "topColor": inserted_row_edges["expected"],
    "expected": inserted_row_edges["expected"],
  }


def test_d_table_middle_column_delete_stays_between_neighbors(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>E</p></td><td><p>F</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2)",
  )
  middle.click()
  kindred.toolbar_click("deleteColumn")
  kindred.wait.until(
    lambda d: [
      cell.text.strip()
      for cell in kindred.driver.find_elements(
        By.CSS_SELECTOR,
        "#editor .ProseMirror table td",
      )
    ] == ["A", "C", "D", "F"]
  )
  kindred.enter_dirty_diff()

  rows = kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => Array.from(row.cells, (cell) => ({
        text: (cell.textContent || '').trim(),
        deleted: cell.classList.contains('diff-table-column-del'),
      })));
    """
  )
  assert rows == [
    [
      {"text": "A", "deleted": False},
      {"text": "B", "deleted": True},
      {"text": "C", "deleted": False},
    ],
    [
      {"text": "D", "deleted": False},
      {"text": "E", "deleted": True},
      {"text": "F", "deleted": False},
    ],
  ]


def test_d_deleted_middle_column_keeps_delete_color_on_every_edge(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>E</p></td><td><p>F</p></td></tr>
    <tr><td><p>G</p></td><td><p>H</p></td><td><p>I</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2)",
  )
  middle.click()
  kindred.toolbar_click("deleteColumn")
  kindred.enter_dirty_diff()

  deleted_cells = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror td.diff-table-column-del",
  )
  assert len(deleted_cells) == 3
  for cell in deleted_cells:
    image = Image.open(BytesIO(cell.screenshot_as_png)).convert("RGB")
    center_x = image.width // 2
    center_y = image.height // 2
    css_color = cell.value_of_css_property("color")
    border_color = tuple(
      int(component.strip())
      for component in css_color[css_color.index("(") + 1:css_color.index(")")]
      .split(",")[:3]
    )
    assert border_color != image.getpixel((center_x, center_y))
    border_widths = kindred.driver.execute_script(
      """
      const cell = arguments[0];
      const native = getComputedStyle(cell);
      return [
        native.borderTopWidth, native.borderRightWidth,
        native.borderBottomWidth, native.borderLeftWidth,
      ];
      """,
      cell,
    )
    assert border_widths == ["1px"] * 4, border_widths


def test_d_table_middle_column_insert_stays_between_neighbors(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>F</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  first = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:first-child",
  )
  first.click()
  kindred.toolbar_click("addColumnAfter")
  inserted = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror td:nth-child(2) p",
  )
  inserted[0].click()
  kindred.driver.switch_to.active_element.send_keys("B")
  inserted[1].click()
  kindred.driver.switch_to.active_element.send_keys("E")
  kindred.wait.until(
    lambda d: [
      cell.text.strip()
      for cell in kindred.driver.find_elements(
        By.CSS_SELECTOR,
        "#editor .ProseMirror table td",
      )
    ] == ["A", "B", "C", "D", "E", "F"]
  )
  kindred.enter_dirty_diff()

  rows = kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => Array.from(row.cells, (cell) => ({
        text: (cell.textContent || '').trim(),
        inserted: cell.classList.contains('diff-table-column-ins'),
      })));
    """
  )
  assert rows == [
    [
      {"text": "A", "inserted": False},
      {"text": "B", "inserted": True},
      {"text": "C", "inserted": False},
    ],
    [
      {"text": "D", "inserted": False},
      {"text": "E", "inserted": True},
      {"text": "F", "inserted": False},
    ],
  ]
  inserted_column_edges = kindred.driver.execute_script(
    """
    const cell = document.querySelector('#editor td.diff-table-column-ins');
    const style = getComputedStyle(cell);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-success-300)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return {
      leftStyle: style.borderLeftStyle,
      leftWidth: style.borderLeftWidth,
      leftColor: style.borderLeftColor,
      expected,
    };
    """
  )
  assert inserted_column_edges == {
    "leftStyle": "solid",
    "leftWidth": "1px",
    "leftColor": inserted_column_edges["expected"],
    "expected": inserted_column_edges["expected"],
  }


def test_d_table_rowspan_edit_marks_logical_cell_without_phantom_cells(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td rowspan="2"><p>Left</p></td><td><p>Top</p></td></tr>
    <tr><td><p>Bottom</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  bottom = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td p",
  )
  bottom.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " dirty")
  kindred.enter_dirty_diff()

  rows = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table tr",
  )
  assert [len(row.find_elements(By.CSS_SELECTOR, ":scope > td")) for row in rows] == [2, 1]
  assert not rows[0].find_elements(By.CSS_SELECTOR, ".diff-table-cell-ins")
  assert len(rows[1].find_elements(By.CSS_SELECTOR, ".diff-table-cell-ins")) == 1
  assert rows[1].find_element(
    By.CSS_SELECTOR,
    ".diff-table-cell-ins",
  ).text.strip() == "Bottom dirty"


def test_d_coalesce_short_equals_punctuation_preserves_projection(
  kindred: KindredPage,
) -> None:
  """Regression: coalescing edit runs across punctuation must not drop characters or cause AST mismatch."""
  head = (
    "test,again"
  )
  dirty = (
    "again,"
  )
  _commit_then_edit(kindred, head, dirty)
  kindred.enter_dirty_diff()

  assert "ast doc mismatch" not in kindred.status_text().lower() and not "cannot read properties of null" in kindred.status_text().lower()
  ins = "".join(kindred.diff_ins_texts())
  assert "again," in ins
  assert "test" not in ins


def test_d_table_inserted_row_keeps_alignment_when_column_is_deleted(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>E</p></td><td><p>F</p></td></tr>
    <tr><td><p>G</p></td><td><p>H</p></td><td><p>I</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:first-child",
  ).click()
  kindred.toolbar_click("addRowAfter")
  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2)",
  ).click()
  kindred.toolbar_click("deleteColumn")
  kindred.enter_dirty_diff()

  geometry = kindred.driver.execute_script(
    """
    const rows = Array.from(document.querySelectorAll('#editor .ProseMirror table tr'));
    const cells = rows.map((row) => Array.from(row.cells).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
    return { counts: cells.map((row) => row.length), cells };
    """
  )
  assert geometry["counts"] == [3, 3, 3, 3]
  first_row = geometry["cells"][0]
  for row in geometry["cells"][1:]:
    assert [round(cell["left"]) for cell in row] == [
      round(cell["left"]) for cell in first_row
    ]
    assert [round(cell["right"]) for cell in row] == [
      round(cell["right"]) for cell in first_row
    ]

  conflict = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor tr.diff-table-row-ins td.diff-table-column-del",
  )
  conflict_style = kindred.driver.execute_script(
    """
    const cell = arguments[0];
    const style = getComputedStyle(cell);
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--color-danger-bg)';
    probe.style.color = 'var(--accent-danger-300)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const result = {
      background: style.backgroundColor,
      border: style.borderTopColor,
      color: style.color,
      decoration: style.textDecorationLine,
      expectedBackground: expected.backgroundColor,
      expectedColor: expected.color,
    };
    probe.remove();
    return result;
    """,
    conflict,
  )
  assert conflict_style["background"] == conflict_style["expectedBackground"]
  assert conflict_style["border"] == conflict_style["expectedColor"]
  assert conflict_style["color"] == conflict_style["expectedColor"]
  assert conflict_style["decoration"] == "line-through"

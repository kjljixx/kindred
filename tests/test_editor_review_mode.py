"""Dirty Review mode tests (paragraphs, lists, tables)."""

from __future__ import annotations

import re

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage
from pages.table_visuals import vertical_border_thicknesses


def _commit_then_edit_html(kindred: KindredPage, head: str, dirty: str) -> None:
  kindred.paste_html(head)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.press_keys(Keys.CONTROL + "a")
  kindred.paste_html(dirty)
  expected = re.sub(r"<[^>]+>", "", dirty)
  kindred.wait_until_editor_body_text(expected)


def _list_top_level_item_texts(kindred: KindredPage) -> list[str]:
  return [
    item.text.strip()
    for item in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror > ul > li > p",
    )
  ]


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
  kindred.driver.find_element(*KindredPage.CHAT_TAB).click()
  kindred.switch_to_git()
  kindred.wait.until(lambda d: kindred.dirty_mode_enabled("review"))
  kindred.enter_dirty_review()
  assert kindred.conflict_count() == 1
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


def test_r_format_only_bold_conflict(kindred: KindredPage) -> None:
  """Bold-only dirty → Review format conflict (orange/blue, no Keep Both)."""
  _commit_then_bold(kindred)
  kindred.enter_dirty_review()
  assert kindred.conflict_count() == 1
  ours, theirs = kindred.conflict_button_texts()
  assert "hello" in ours
  assert "hello" in theirs
  _, theirs_html = kindred.conflict_button_html()
  assert "strong" in theirs_html.lower() or "b>" in theirs_html.lower()
  assert not kindred.has_keep_both_button()
  kindred.click_conflict_keep_theirs()
  kindred.enter_dirty_text()
  assert kindred.editor_has_tag("strong") or kindred.editor_has_tag("b")


def test_r_format_only_bold_keep_head(kindred: KindredPage) -> None:
  """Keep HEAD on a bold-only Review hunk restores plain text."""
  _commit_then_bold(kindred)
  kindred.enter_dirty_review()
  kindred.click_conflict_keep_ours()
  kindred.enter_dirty_text()
  assert not kindred.editor_has_tag("strong")
  assert not kindred.editor_has_tag("b")
  assert "hello" in kindred.editor_body_text()

def test_r_format_table_conflict(kindred: KindredPage) -> None:
  table_html = (
    """<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>test</p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr><tr><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td><td colspan="1" rowspan="1"><p><br class="ProseMirror-trailingBreak"></p></td></tr></tbody></table>"""
  )
  kindred.paste_html(table_html)
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.delete_table()
  kindred.enter_dirty_review(expect_conflicts=True)
  assert kindred.has_merge_conflict_ui()
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-conflict > button",
    )
  ] == ["Keep", "Remove"]
  kindred.click_conflict_keep_theirs()
  kindred.exit_to_dirty_text()
  assert not "test" in kindred.status_text()


def test_r_table_cell_conflicts_resolve_independently(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td></tr>
    <tr><td><p>C</p></td><td><p>D</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  changed = [
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
    "#editor .ProseMirror tr:nth-child(2) td:first-child p",
  ]
  for selector in changed:
    cell = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    cell.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, "!")
  kindred.wait.until(
    lambda d: [
      cell.text.strip()
      for cell in kindred.driver.find_elements(
        By.CSS_SELECTOR,
        "#editor .ProseMirror table td p",
      )
    ] == ["A", "B!", "C!", "D"]
  )

  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 2

  kindred.click_conflict_keep_ours(0)
  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "B", "C!", "D"]


def test_r_table_middle_row_delete_resolves_in_place(
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
  kindred.enter_dirty_review()

  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict > button",
    )
  ] == ["Keep", "Remove"]
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Middle", "Bottom"]

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Bottom"]


def test_r_row_conflict_buttons_render_left_without_overlapping_blocks(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<p>Before table</p><table><tbody>
    <tr><td><p>Top</p></td></tr>
    <tr><td><p>X</p></td></tr>
    <tr><td><p>Bottom</p></td></tr>
    </tbody></table><p>After table</p>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table tr:nth-child(2) td",
  )
  middle.click()
  kindred.toolbar_click("deleteRow")
  kindred.enter_dirty_review()

  geometry = kindred.driver.execute_script(
    """
    const editor = document.querySelector('#editor .ProseMirror');
    const table = editor.querySelector('table');
    const wrapper = table.closest('.tableWrapper');
    const row = table.rows[1];
    const marker = editor.querySelector('.merge-table-row-conflict');
    const buttons = Array.from(marker.children);
    const blocks = Array.from(editor.children);
    const before = blocks.find((block) => block.textContent.includes('Before table'));
    const after = blocks.find((block) => block.textContent.includes('After table'));
    const rect = (node) => node.getBoundingClientRect();
    const visible = (node) => {
      const box = rect(node);
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      return node === hit || node.contains(hit);
    };
    return {
      table: rect(table),
      wrapper: rect(wrapper),
      row: rect(row),
      marker: rect(marker),
      buttons: buttons.map(rect),
      buttonsVisible: buttons.map(visible),
      before: rect(before),
      after: rect(after),
    };
    """
  )
  assert geometry["marker"]["right"] <= geometry["table"]["left"]
  assert geometry["buttons"][0]["bottom"] <= geometry["buttons"][1]["top"]
  assert geometry["buttons"][1]["top"] - geometry["buttons"][0]["bottom"] > 0
  assert geometry["buttonsVisible"] == [True, True]
  assert geometry["row"]["height"] >= geometry["marker"]["height"]
  assert geometry["before"]["bottom"] <= geometry["wrapper"]["top"]
  assert geometry["wrapper"]["bottom"] <= geometry["after"]["top"]


def test_r_table_middle_column_delete_resolves_in_place(
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
  kindred.enter_dirty_review()

  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict > button",
    )
  ] == ["Keep", "Remove"]
  conflict_cells = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .kindred-table-column-conflict-node",
  )
  assert len(conflict_cells) == 2
  border_thicknesses = [
    vertical_border_thicknesses(kindred.driver, cell, expected_side="ours")
    for cell in conflict_cells
  ]
  assert all(left == right for left, right in border_thicknesses), border_thicknesses
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "B", "C", "D", "E", "F"]

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "C", "D", "F"]


def test_r_table_inserted_row_and_later_cell_resolve_independently(
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
  bottom = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(3) td p",
  )
  bottom.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, "!")
  kindred.enter_dirty_review()

  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict > button",
    )
  ] == ["Remove", "Keep"]
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 1
  assert kindred.driver.execute_script(
    """
    const row = document.querySelector(
      '#editor tr.kindred-table-row-conflict-node'
    );
    const cell = document.querySelector(
      '#editor td.kindred-table-cell-conflict-node'
    );
    return {
      rowIsDirty: row?.classList.contains('kindred-table-side-theirs') || false,
      rowBackground: getComputedStyle(row?.cells[0]).backgroundColor,
      cellBackground: getComputedStyle(cell).backgroundColor,
    };
    """
  ) == {
    "rowIsDirty": True,
    "rowBackground": "rgba(60, 131, 246, 0.18)",
    "cellBackground": "rgba(0, 0, 0, 0)",
  }

  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .merge-table-row-conflict .merge-conflict-ours",
  ).click()
  kindred.wait.until(
    lambda d: not kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  )
  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .merge-table-cell-conflict .merge-conflict-theirs",
  ).click()
  kindred.wait.until(lambda d: not kindred.has_merge_conflict_ui())
  kindred.enter_dirty_text()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Bottom!"]


def test_r_table_inserted_column_uses_semantic_action_labels(
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
  kindred.enter_dirty_review()

  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict > button",
    )
  ] == ["Remove", "Keep"]
  assert kindred.driver.execute_script(
    """
    const cells = Array.from(document.querySelectorAll(
      '#editor td.kindred-table-column-conflict-node'
    ));
    return {
      dirty: cells.length > 0 && cells.every((cell) =>
        cell.classList.contains('kindred-table-side-theirs')
      ),
      background: cells[0]
        ? getComputedStyle(cells[0]).backgroundColor
        : null,
    };
    """
  ) == {
    "dirty": True,
    "background": "rgba(60, 131, 246, 0.18)",
  }

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert all(
    len(row.find_elements(By.CSS_SELECTOR, ":scope > td")) == 3
    for row in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table tr",
    )
  )


def test_r_table_row_color_precedes_column_color_and_borders_stay_uniform(
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
  kindred.enter_dirty_review()

  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  ) == 1
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  ) == 1
  intersection = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor tr.kindred-table-row-conflict-node td.kindred-table-column-conflict-node",
  )
  assert kindred.driver.execute_script(
    """
    const cell = arguments[0];
    const style = getComputedStyle(cell);
    return {
      rowSide: cell.parentElement.classList.contains('kindred-table-side-theirs'),
      columnSide: cell.classList.contains('kindred-table-side-ours'),
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      borders: [style.borderTopWidth, style.borderRightWidth,
        style.borderBottomWidth, style.borderLeftWidth],
    };
    """,
    intersection,
  ) == {
    "rowSide": True,
    "columnSide": True,
    "background": "rgba(60, 131, 246, 0.18)",
    "borderRadius": "0px",
    "borders": ["1px", "1px", "1px", "1px"],
  }


def test_r_column_conflict_buttons_render_above_without_overlapping_blocks(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<ul><li><p>Before list</p></li></ul><table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>E</p></td><td><p>F</p></td></tr>
    </tbody></table><p>After table</p>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table tr:first-child td:nth-child(2)",
  )
  middle.click()
  kindred.toolbar_click("deleteColumn")
  kindred.enter_dirty_review()

  geometry = kindred.driver.execute_script(
    """
    const editor = document.querySelector('#editor .ProseMirror');
    const table = editor.querySelector('table');
    const wrapper = table.closest('.tableWrapper');
    const cell = table.rows[0].cells[1];
    const marker = editor.querySelector('.merge-table-column-conflict');
    const buttons = Array.from(marker.children);
    const blocks = Array.from(editor.children);
    const before = blocks.find((block) => block.textContent.includes('Before list'));
    const after = blocks.find((block) => block.textContent.includes('After table'));
    const rect = (node) => node.getBoundingClientRect();
    const visible = (node) => {
      const box = rect(node);
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      return node === hit || node.contains(hit);
    };
    return {
      table: rect(table),
      wrapper: rect(wrapper),
      cell: rect(cell),
      marker: rect(marker),
      buttons: buttons.map(rect),
      buttonsVisible: buttons.map(visible),
      before: rect(before),
      after: rect(after),
    };
    """
  )
  assert geometry["marker"]["bottom"] <= geometry["table"]["top"]
  assert geometry["buttons"][0]["right"] <= geometry["buttons"][1]["left"]
  assert abs(
    (
      geometry["buttons"][0]["top"] + geometry["buttons"][0]["bottom"]
    ) / 2 - (
      geometry["buttons"][1]["top"] + geometry["buttons"][1]["bottom"]
    ) / 2
  ) <= 1
  assert geometry["cell"]["left"] <= (
    geometry["marker"]["left"] + geometry["marker"]["right"]
  ) / 2 <= geometry["cell"]["right"]
  assert geometry["buttonsVisible"] == [True, True]
  assert geometry["before"]["bottom"] <= geometry["wrapper"]["top"]
  assert geometry["wrapper"]["bottom"] <= geometry["after"]["top"]


def test_r_table_rowspan_cell_resolves_by_logical_column(
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
  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 1

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  rows = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table tr",
  )
  assert [len(row.find_elements(By.CSS_SELECTOR, ":scope > td")) for row in rows] == [2, 1]
  assert rows[0].find_element(By.CSS_SELECTOR, ":scope > td").get_attribute(
    "rowspan"
  ) == "2"
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Left", "Top", "Bottom dirty"]


def test_r_whole_table_insert_can_keep_dirty_table(
  kindred: KindredPage,
) -> None:
  kindred.paste_text("Anchor")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  anchor = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > p",
  )
  anchor.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END)
  kindred.paste_html(
    """<table><tbody><tr><td><p>Added</p></td></tr></tbody></table>"""
  )
  kindred.enter_dirty_review(expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-conflict:not(.merge-table-cell-conflict):not(.merge-table-row-conflict):not(.merge-table-column-conflict)",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-conflict > button",
    )
  ] == ["Remove", "Keep"]

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert not kindred.has_merge_conflict_ui()
  assert kindred.driver.execute_script(
    """
    const tables = document.querySelectorAll('#editor .ProseMirror table');
    return {
      tableCount: tables.length,
      rows: tables[0]?.rows.length || 0,
      cells: tables[0]?.rows[0]?.cells.length || 0,
      text: tables[0]?.textContent.trim() || '',
    };
    """
  ) == {"tableCount": 1, "rows": 1, "cells": 1, "text": "Added"}


def test_r_list_two_item_edits_two_widgets(kindred: KindredPage) -> None:
  kindred.paste_html(
    """<ul><li><p>Alpha</p></li><li><p>Bravo</p></li><li><p>Charlie</p></li></ul>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  changed = [
    "#editor .ProseMirror > ul > li:nth-child(2) > p",
    "#editor .ProseMirror > ul > li:nth-child(3) > p",
  ]
  for selector in changed:
    item = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    item.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, "!")
  kindred.wait.until(
    lambda d: _list_top_level_item_texts(kindred) == ["Alpha", "Bravo!", "Charlie!"]
  )

  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror > ul .merge-conflict:not(.merge-list-item-conflict):not(.merge-list-indent-conflict)",
    )
  ) == 2
  assert not kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .merge-list-conflict:not(.merge-list-item-conflict)",
  )


def test_r_list_middle_item_delete_keep_remove(kindred: KindredPage) -> None:
  kindred.paste_html(
    """<ul><li><p>Top</p></li><li><p>Middle</p></li><li><p>Bottom</p></li></ul>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > ul > li:nth-child(2) > p",
  )
  middle.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END)
  for _ in range(len("Middle")):
    kindred.driver.switch_to.active_element.send_keys(Keys.BACKSPACE)
  kindred.driver.switch_to.active_element.send_keys(Keys.BACKSPACE)
  kindred.driver.switch_to.active_element.send_keys(Keys.BACKSPACE)
  kindred.wait.until(
    lambda d: _list_top_level_item_texts(kindred) == ["Top", "Bottom"]
  )

  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-list-item-conflict:not(.merge-list-indent-conflict)",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-list-item-conflict:not(.merge-list-indent-conflict) > button",
    )
  ] == ["Keep", "Remove"]
  assert _list_top_level_item_texts(kindred) == ["Top", "Middle", "Bottom"]

  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert _list_top_level_item_texts(kindred) == ["Top", "Bottom"]


def test_r_list_indent_shows_indent_outdent(kindred: KindredPage) -> None:
  _commit_then_edit_html(
    kindred,
    "<ul><li><p>A</p></li><li><p>B</p></li><li><p>C</p></li></ul>",
    "<ul><li><p>A</p><ul><li><p>B</p></li></ul></li><li><p>C</p></li></ul>",
  )
  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-list-indent-conflict",
    )
  ) == 1
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-list-indent-conflict > button",
    )
  ] == ["Outdent", "Indent"]


def test_r_list_resolve_two_edits_independently(kindred: KindredPage) -> None:
  kindred.paste_html(
    """<ul><li><p>Alpha</p></li><li><p>Bravo</p></li><li><p>Charlie</p></li></ul>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  changed = [
    "#editor .ProseMirror > ul > li:nth-child(2) > p",
    "#editor .ProseMirror > ul > li:nth-child(3) > p",
  ]
  for selector in changed:
    item = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    item.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, "!")
  kindred.wait.until(
    lambda d: _list_top_level_item_texts(kindred) == ["Alpha", "Bravo!", "Charlie!"]
  )

  kindred.enter_dirty_review()
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror > ul .merge-conflict:not(.merge-list-item-conflict):not(.merge-list-indent-conflict)",
    )
  ) == 2

  kindred.click_conflict_keep_ours(0)
  kindred.click_conflict_keep_theirs(0)
  kindred.enter_dirty_text()
  assert _list_top_level_item_texts(kindred) == ["Alpha", "Bravo", "Charlie!"]

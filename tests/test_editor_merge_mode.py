"""Live branch merge tests (paragraph / inline only — no lists or tables)."""

from __future__ import annotations

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from pages.kindred import KindredPage
from pages.table_visuals import vertical_border_thicknesses


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


def test_m_table_non_overlapping_cells_auto_merge(kindred: KindredPage) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td></tr>
    <tr><td><p>C</p></td><td><p>D</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  feature_cell = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td:nth-child(2) p",
  )
  feature_cell.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_cell = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:first-child p",
  )
  main_cell.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A main", "B", "C", "D feature"]


def test_m_table_overlapping_cells_resolve_independently(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  for selector in (
    "#editor .ProseMirror td:first-child p",
    "#editor .ProseMirror td:nth-child(2) p",
  ):
    cell = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    cell.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  for selector in (
    "#editor .ProseMirror td:first-child p",
    "#editor .ProseMirror td:nth-child(2) p",
  ):
    cell = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    cell.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, " main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 2

  kindred.click_conflict_keep_ours(0)
  kindred.click_conflict_keep_theirs(0)
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A main", "B feature"]


def test_m_table_delete_vs_edit_is_one_row_conflict(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<p>Before row table</p><table><tbody>
    <tr><td><p>Top</p></td></tr>
    <tr><td><p>Middle</p></td></tr>
    <tr><td><p>Bottom</p></td></tr>
    </tbody></table><p>After row table</p>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  feature_middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td p",
  )
  feature_middle.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td",
  )
  main_middle.click()
  kindred.toolbar_click("deleteRow")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  ) == 1
  assert not kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .merge-table-conflict:not(.merge-table-row-conflict)",
  )
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict > button",
    )
  ] == ["Remove", "Keep"]
  assert kindred.driver.execute_script(
    """
    const editor = document.querySelector('#editor .ProseMirror');
    const table = editor.querySelector('table');
    const wrapper = table.closest('.tableWrapper');
    const row = table.rows[1];
    const marker = editor.querySelector('.merge-table-row-conflict');
    const buttons = Array.from(marker.children, (button) =>
      button.getBoundingClientRect()
    );
    const before = Array.from(editor.children).find((block) =>
      block.textContent.includes('Before row table')
    ).getBoundingClientRect();
    const after = Array.from(editor.children).find((block) =>
      block.textContent.includes('After row table')
    ).getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const buttonsVisible = Array.from(marker.children).every((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      return button === hit || button.contains(hit);
    });
    return markerRect.right <= tableRect.left &&
      buttons[0].bottom <= buttons[1].top &&
      row.getBoundingClientRect().height >= markerRect.height &&
      buttonsVisible &&
      before.bottom <= wrapperRect.top && wrapperRect.bottom <= after.top;
    """
  )

  kindred.click_conflict_keep_theirs(0)
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Middle feature", "Bottom"]


def test_m_table_delete_vs_edit_is_one_column_conflict(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<p>Before column table</p><table><tbody>
    <tr><td><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>
    <tr><td><p>D</p></td><td><p>E</p></td><td><p>F</p></td></tr>
    </tbody></table><p>After column table</p>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  for selector in (
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
    "#editor .ProseMirror tr:nth-child(2) td:nth-child(2) p",
  ):
    cell = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    cell.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2)",
  )
  main_middle.click()
  kindred.toolbar_click("deleteColumn")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  ) == 1
  assert not kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .merge-table-conflict:not(.merge-table-column-conflict)",
  )
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict > button",
    )
  ] == ["Remove", "Keep"]
  assert kindred.driver.execute_script(
    """
    const editor = document.querySelector('#editor .ProseMirror');
    const table = editor.querySelector('table');
    const wrapper = table.closest('.tableWrapper');
    const cell = table.rows[0].cells[1];
    const marker = editor.querySelector('.merge-table-column-conflict');
    const buttons = Array.from(marker.children, (button) =>
      button.getBoundingClientRect()
    );
    const before = Array.from(editor.children).find((block) =>
      block.textContent.includes('Before column table')
    ).getBoundingClientRect();
    const after = Array.from(editor.children).find((block) =>
      block.textContent.includes('After column table')
    ).getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const buttonsVisible = Array.from(marker.children).every((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      return button === hit || button.contains(hit);
    });
    return markerRect.bottom <= tableRect.top &&
      buttons[0].right <= buttons[1].left &&
      Math.abs(
        (buttons[0].top + buttons[0].bottom) / 2 -
        (buttons[1].top + buttons[1].bottom) / 2
      ) <= 1 &&
      cellRect.left <= (markerRect.left + markerRect.right) / 2 &&
      (markerRect.left + markerRect.right) / 2 <= cellRect.right &&
      buttonsVisible &&
      before.bottom <= wrapperRect.top && wrapperRect.bottom <= after.top;
    """
  )
  conflict_cells = kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .kindred-table-column-conflict-node",
  )
  assert len(conflict_cells) == 2
  border_thicknesses = [
    vertical_border_thicknesses(kindred.driver, cell, expected_side="theirs")
    for cell in conflict_cells
  ]
  assert all(left == right for left, right in border_thicknesses), border_thicknesses

  kindred.click_conflict_keep_theirs(0)
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "B feature", "C", "D", "E feature", "F"]


def test_m_table_inserted_middle_row_and_cell_edit_auto_merge(
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

  kindred.create_branch("feature")
  feature_bottom = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td p",
  )
  feature_bottom.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
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
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Middle", "Bottom feature"]


def test_m_table_inserted_middle_column_and_cell_edit_auto_merge(
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

  kindred.create_branch("feature")
  feature_last = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td:nth-child(2) p",
  )
  feature_last.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
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
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "B", "C", "D", "E", "F feature"]


def test_m_table_rich_cell_conflict_preserves_chosen_markup(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody><tr><td><p>A</p></td></tr></tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  def select_cell_text() -> None:
    kindred.driver.execute_script(
      """
      const text = document.querySelector(
        '#editor .ProseMirror table td p'
      ).firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      """
    )

  kindred.create_branch("feature")
  select_cell_text()
  kindred.toolbar_click("italic")
  kindred.commit()

  kindred.checkout_branch("main")
  select_cell_text()
  kindred.toolbar_click("bold")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 1

  kindred.click_conflict_keep_theirs(0)
  paragraph = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table td p",
  )
  assert paragraph.get_attribute("innerHTML") == "<em>A</em>"


def test_m_table_same_position_row_inserts_are_one_row_conflict(
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

  def insert_middle(text: str) -> None:
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
    kindred.driver.switch_to.active_element.send_keys(text)

  kindred.create_branch("feature")
  insert_middle("Feature")
  kindred.commit()

  kindred.checkout_branch("main")
  insert_middle("Main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-row-conflict",
    )
  ) == 1

  kindred.click_conflict_keep_ours(0)
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["Top", "Main", "Bottom"]


def test_m_table_same_position_column_inserts_are_one_column_conflict(
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

  def insert_middle(top_text: str, bottom_text: str) -> None:
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
    kindred.driver.switch_to.active_element.send_keys(top_text)
    inserted[1].click()
    kindred.driver.switch_to.active_element.send_keys(bottom_text)

  kindred.create_branch("feature")
  insert_middle("Feature B", "Feature E")
  kindred.commit()

  kindred.checkout_branch("main")
  insert_middle("Main B", "Main E")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  ) == 1

  kindred.click_conflict_keep_theirs(0)
  assert [
    cell.text.strip()
    for cell in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .ProseMirror table td p",
    )
  ] == ["A", "Feature B", "C", "D", "Feature E", "F"]


def test_m_table_rowspan_cells_merge_by_logical_column(
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

  kindred.create_branch("feature")
  feature_top = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
  )
  feature_top.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_bottom = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td p",
  )
  main_bottom.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
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
  ] == ["Left", "Top feature", "Bottom main"]


def test_m_table_middle_delete_with_duplicates_and_empty_cell_auto_merges(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<table><tbody>
    <tr><td><p>Same</p></td><td><p></p></td></tr>
    <tr><td><p>Same</p></td><td><p>Middle</p></td></tr>
    <tr><td><p>Tail</p></td><td><p></p></td></tr>
    </tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  feature_empty = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(3) td:nth-child(2) p",
  )
  feature_empty.click()
  kindred.driver.switch_to.active_element.send_keys("Feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:nth-child(2) td",
  )
  main_middle.click()
  kindred.toolbar_click("deleteRow")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
  assert kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => Array.from(row.cells, (cell) =>
        (cell.textContent || '').trim()
      ));
    """
  ) == [["Same", ""], ["Tail", "Feature"]]


def test_m_whole_table_delete_vs_edit_is_one_table_conflict(
  kindred: KindredPage,
) -> None:
  kindred.paste_html(
    """<p>Anchor</p>
    <table><tbody><tr><td><p>Base</p></td></tr></tbody></table>"""
  )
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  feature_cell = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror table td p",
  )
  feature_cell.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  kindred.delete_table()
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-conflict:not(.merge-table-cell-conflict):not(.merge-table-row-conflict):not(.merge-table-column-conflict)",
    )
  ) == 1
  assert not kindred.driver.find_elements(
    By.CSS_SELECTOR,
    "#editor .merge-table-cell-conflict, #editor .merge-table-row-conflict, #editor .merge-table-column-conflict",
  )
  assert [
    button.text
    for button in kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-conflict > button",
    )
  ] == ["Remove", "Keep"]

  kindred.click_conflict_keep_theirs(0)
  assert not kindred.has_merge_conflict_ui()
  assert kindred.driver.execute_script(
    """
    const tables = document.querySelectorAll('#editor .ProseMirror table');
    return {
      tableCount: tables.length,
      rows: tables[0]?.rows.length || 0,
      cells: tables[0]?.rows[0]?.cells.length || 0,
      text: tables[0]?.rows[0]?.cells[0]?.textContent.trim() || '',
    };
    """
  ) == {
    "tableCount": 1,
    "rows": 1,
    "cells": 1,
    "text": "Base feature",
  }


def test_m_table_column_delete_reindexes_later_cell_conflict(
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

  kindred.create_branch("feature")
  for selector in (
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
    "#editor .ProseMirror tr:nth-child(2) td:nth-child(2) p",
    "#editor .ProseMirror tr:first-child td:nth-child(3) p",
  ):
    cell = kindred.driver.find_element(By.CSS_SELECTOR, selector)
    cell.click()
    kindred.driver.switch_to.active_element.send_keys(Keys.END, " feature")
  kindred.commit()

  kindred.checkout_branch("main")
  main_middle = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2)",
  )
  main_middle.click()
  kindred.toolbar_click("deleteColumn")
  main_last = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror tr:first-child td:nth-child(2) p",
  )
  main_last.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=True)
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  ) == 1
  assert len(
    kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-cell-conflict",
    )
  ) == 1

  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .merge-table-column-conflict .merge-conflict-ours",
  ).click()
  kindred.wait.until(
    lambda d: not kindred.driver.find_elements(
      By.CSS_SELECTOR,
      "#editor .merge-table-column-conflict",
    )
  )
  kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .merge-table-cell-conflict .merge-conflict-theirs",
  ).click()
  kindred.wait.until(lambda d: not kindred.has_merge_conflict_ui())
  assert kindred.driver.execute_script(
    """
    return Array.from(document.querySelectorAll('#editor .ProseMirror table tr'))
      .map((row) => Array.from(row.cells, (cell) =>
        (cell.textContent || '').trim()
      ));
    """
  ) == [["A", "C feature"], ["D", "F"]]


def test_m_whole_table_insert_and_paragraph_edit_auto_merge(
  kindred: KindredPage,
) -> None:
  kindred.paste_text("Anchor")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()

  kindred.create_branch("feature")
  feature_anchor = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > p",
  )
  feature_anchor.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END)
  kindred.paste_html(
    """<table><tbody><tr><td><p>Added</p></td></tr></tbody></table>"""
  )
  kindred.commit()

  kindred.checkout_branch("main")
  main_anchor = kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > p",
  )
  main_anchor.click()
  kindred.driver.switch_to.active_element.send_keys(Keys.END, " main")
  kindred.commit()

  kindred.merge_branch("feature", expect_conflicts=False)
  assert not kindred.has_merge_conflict_ui()
  assert kindred.driver.find_element(
    By.CSS_SELECTOR,
    "#editor .ProseMirror > p",
  ).text.strip() == "Anchor main"
  assert kindred.driver.execute_script(
    """
    return Array.from(document.querySelector('#editor .ProseMirror').children)
      .filter((element) =>
        element.matches('p:not(.is-empty), .tableWrapper')
      )
      .map((element) => element.matches('p') ? 'paragraph' : 'table');
    """
  ) == ["paragraph", "table"]
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

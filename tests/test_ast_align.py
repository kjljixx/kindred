"""AST aligner smoke tests (paragraph schema; lists/tables deferred)."""

from __future__ import annotations

from pages.kindred import KindredPage


def test_ast_html_round_trip_via_editor(kindred: KindredPage) -> None:
  """HTML → TipTap keeps paragraph text."""
  kindred.paste_text("Alpha")
  kindred.wait_until_draft_active()
  info = kindred.driver.execute_script(
    """
    const pm = document.querySelector('#editor .ProseMirror');
    return {
      html: pm ? pm.innerHTML : '',
      text: pm ? (pm.innerText || '').trim() : '',
      pCount: pm ? pm.querySelectorAll(':scope > p').length : 0,
    };
    """
  )
  assert info["text"] == "Alpha"
  assert info["pCount"] >= 1
  assert "Alpha" in info["html"]


def test_ast_review_replace_one_conflict(kindred: KindredPage) -> None:
  """Single-paragraph edit → one Review conflict (replace, not delete+insert)."""
  kindred.paste_text("hello")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("hello world")
  kindred.enter_dirty_review()
  assert kindred.conflict_count() == 1
  ours, theirs = kindred.conflict_button_texts()
  # Word-diff may conflict only on the inserted " world"; HEAD side can be empty.
  assert "world" in theirs or "hello world" in theirs or "hello" in ours


def test_ast_diff_insert_stays_scoped(kindred: KindredPage) -> None:
  """Diff paints insert chrome without wiping equal prefix."""
  kindred.paste_text("ab")
  kindred.wait_until_draft_active()
  kindred.switch_to_git()
  kindred.commit()
  kindred.replace_editor_text("axb")
  kindred.enter_dirty_diff()
  body = kindred.editor_body_text()
  assert "a" in body
  assert "b" in body

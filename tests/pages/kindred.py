from __future__ import annotations

import re
import time

from selenium.common.exceptions import (
  NoAlertPresentException,
  NoSuchElementException,
  StaleElementReferenceException,
  TimeoutException,
)
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

DEFAULT_TIMEOUT = 15

_STATUS_COUNTS_RE = re.compile(
  r"^(?P<words>\d+)\s+words?\s+·\s+(?P<chars>\d+)\s+chars?",
  re.IGNORECASE,
)


class KindredPage:
  """UI helpers for the Kindred GUI. Extend with actions/assertions as tests grow."""

  EDITOR = (By.CSS_SELECTOR, "#editor .ProseMirror")
  DRAFT_LIST = (By.ID, "draft-list")
  DRAFTS_HEADING = (By.ID, "drafts-heading")
  HOME_BTN = (By.ID, "home-btn")
  COMMIT_BTN = (By.ID, "commit-btn")
  CHAT_TAB = (By.CSS_SELECTOR, '#pane-mode-cluster .tab[data-pane="chat"]')
  CHAT_LIST = (By.ID, "chat-list")
  NEW_CHAT_BTN = (By.ID, "new-chat-btn")
  DRAFT_HEADER_TITLE = (By.ID, "draft-header-title")
  DRAFT_HEADER_TITLE_INPUT = (By.ID, "draft-header-title-input")
  STATUS = (By.ID, "status")
  PANE_MODE_CLUSTER = (By.ID, "pane-mode-cluster")
  GIT_TAB = (By.CSS_SELECTOR, '#pane-mode-cluster .tab[data-pane="git"]')
  GIT_PANE = (By.ID, "git-pane")
  GIT_NEW_BRANCH = (By.ID, "git-new-branch")
  GIT_BRANCH_LIST = (By.ID, "git-branch-list")
  GIT_COMMIT_LIST = (By.ID, "git-commit-list")
  GIT_COMMIT_ROWS = (By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="view"]')
  DIRTY_ROW = (By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="dirty"]')
  DIRTY_TEXT_BTN = (By.CSS_SELECTOR, '#git-dirty-modes [data-git="dirty-text"]')
  DIRTY_DIFF_BTN = (By.CSS_SELECTOR, '#git-dirty-modes [data-git="dirty-diff"]')
  DIRTY_REVIEW_BTN = (By.CSS_SELECTOR, '#git-dirty-modes [data-git="dirty-review"]')
  MERGE_CONFLICT = (By.CSS_SELECTOR, "#editor .merge-conflict")
  CONFLICT_OURS = (By.CSS_SELECTOR, "#editor .merge-conflict-btn.merge-conflict-ours")
  CONFLICT_THEIRS = (By.CSS_SELECTOR, "#editor .merge-conflict-btn.merge-conflict-theirs")

  def __init__(self, driver: WebDriver, base_url: str, timeout: float = DEFAULT_TIMEOUT):
    self.driver = driver
    self.base_url = base_url.rstrip("/") + "/"
    self.timeout = timeout

  @property
  def wait(self) -> WebDriverWait:
    return WebDriverWait(self.driver, self.timeout)

  def open(self) -> None:
    self.driver.get(self.base_url)

  def wait_until_ready(self) -> None:
    self.wait.until(EC.visibility_of_element_located(self.DRAFT_LIST))
    self.wait.until(EC.presence_of_element_located(self.EDITOR))

  def paste_text(self, text: str) -> None:
    """Paste plain text into the TipTap editor (exercises handlePaste)."""
    self.wait.until(EC.presence_of_element_located(self.EDITOR))
    self.driver.execute_script(
      """
      const text = arguments[0];
      const el = document.querySelector('#editor .ProseMirror');
      if (!el) throw new Error('editor not found');
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }));
      """,
      text,
    )

  def paste_html(self, html: str) -> None:
    """Paste HTML into the TipTap editor (text/html + plain fallback)."""
    self.wait.until(EC.presence_of_element_located(self.EDITOR))
    self.driver.execute_script(
      """
      const html = arguments[0];
      const el = document.querySelector('#editor .ProseMirror');
      if (!el) throw new Error('editor not found');
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      dt.setData('text/plain', (tmp.textContent || '').replace(/\\u00a0/g, ' '));
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }));
      """,
      html,
    )

  def status_text(self) -> str:
    return (self.driver.find_element(*self.STATUS).text or "").replace("\xa0", " ")

  def header_title(self) -> str:
    el = self.driver.find_element(*self.DRAFT_HEADER_TITLE)
    if el.get_attribute("hidden") is not None:
      return ""
    return (el.text or "").replace("\xa0", " ").strip()

  def rename_header_title(self, name: str) -> None:
    btn = self.wait.until(EC.element_to_be_clickable(self.DRAFT_HEADER_TITLE))
    btn.click()
    inp = self.wait.until(EC.visibility_of_element_located(self.DRAFT_HEADER_TITLE_INPUT))
    inp.send_keys(Keys.CONTROL + "a")
    inp.send_keys(name)
    inp.send_keys(Keys.ENTER)
    self.wait.until(EC.invisibility_of_element_located(self.DRAFT_HEADER_TITLE_INPUT))
    self.wait.until(lambda d: self.header_title() == name)

  def word_char_counts(self) -> tuple[int, int]:
    text = self.status_text()
    m = _STATUS_COUNTS_RE.match(text)
    if not m:
      raise AssertionError(f"could not parse word/char counts from status: {text!r}")
    return int(m.group("words")), int(m.group("chars"))

  def wait_until_status_contains(self, needle: str) -> None:
    self.wait.until(lambda d: needle in self.status_text())

  def wait_until_word_char_counts(self, words: int, chars: int) -> None:
    self.wait.until(lambda d: self.word_char_counts() == (words, chars))

  def wait_until_header_title(self, title: str) -> None:
    self.wait.until(lambda d: self.header_title() == title)

  def replace_editor_text(self, text: str) -> None:
    """Select all editor content and paste replacement plain text."""
    self.press_keys(Keys.CONTROL + "a")
    self.paste_text(text)

  def view_commit_at(self, index: int) -> None:
    """Click a commit row. List is newest-first (0 = newest)."""
    self.wait.until(lambda d: len(d.find_elements(*self.GIT_COMMIT_ROWS)) > index)
    rows = self.driver.find_elements(*self.GIT_COMMIT_ROWS)
    rows[index].click()
    self.wait_until_status_contains("viewing old commit")

  def exit_to_dirty_text(self) -> None:
    row = self.wait.until(EC.element_to_be_clickable(self.DIRTY_ROW))
    row.click()
    self.wait.until(lambda d: "viewing old commit" not in self.status_text())

  def enter_dirty_review(self, *, expect_conflicts: bool = True) -> None:
    self._click_dirty_mode("review")
    if expect_conflicts:
      self.wait_for_conflicts()
    self._wait_git_idle()

  def enter_dirty_text(self) -> None:
    self._click_dirty_mode("text")
    self.wait.until(lambda d: self.dirty_mode_active("text"))
    self.wait.until(lambda d: not self.has_merge_conflict_ui())
    self._wait_git_idle()

  def enter_dirty_diff(self) -> None:
    self._click_dirty_mode("diff")
    self.wait.until(lambda d: self.dirty_mode_active("diff"))
    self.wait.until(lambda d: not self.has_merge_conflict_ui())
    self._wait_git_idle()

  def _dirty_mode_selector(self, mode: str) -> str:
    return {
      "text": '#git-dirty-modes [data-git="dirty-text"]',
      "diff": '#git-dirty-modes [data-git="dirty-diff"]',
      "review": '#git-dirty-modes [data-git="dirty-review"]',
    }[mode]

  def _click_dirty_mode(self, mode: str) -> None:
    sel = self._dirty_mode_selector(mode)
    last_err: Exception | None = None
    for _ in range(8):
      try:
        self._wait_git_idle()
        # During live merge with unresolved conflicts, mode tabs stay disabled —
        # still allow Review leave via Text/Diff only when those tabs are enabled.
        clicked = self.driver.execute_script(
          """
          const sel = arguments[0];
          const btn = document.querySelector(sel);
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
          """,
          sel,
        )
        if clicked:
          return
        time.sleep(0.1)
      except StaleElementReferenceException as err:
        last_err = err
        time.sleep(0.1)
    if last_err is not None:
      raise last_err
    raise TimeoutException(f"could not click dirty mode {mode!r}")

  def _wait_git_idle(self) -> None:
    """Wait until runGit finished (gitBusy cleared).

    Do not infer idle from Text/Diff tab enabled — pending merge with
    unresolved conflicts intentionally disables those tabs while git is idle.
    """

    def idle(driver) -> bool:
      return bool(
        driver.execute_script(
          """
          const newBranch = document.getElementById('git-new-branch');
          if (!newBranch) return true;
          // new-branch is disabled while gitBusy OR when there are no commits.
          // If any commit row exists, disabled means busy.
          const hasCommits = !!document.querySelector(
            '#git-commit-list .git-row[data-git="view"]'
          );
          if (!hasCommits) return true;
          return !newBranch.disabled;
          """
        )
      )

    self.wait.until(idle)

  def wait_until_commit_clickable(self) -> None:
    self.wait.until(
      lambda d: bool(
        d.execute_script(
          """
          const btn = document.getElementById('commit-btn');
          return !!(btn && !btn.hidden && !btn.disabled);
          """
        )
      )
    )

  def dirty_mode_enabled(self, mode: str) -> bool:
    sel = self._dirty_mode_selector(mode)
    return bool(
      self.driver.execute_script(
        """
        const btn = document.querySelector(arguments[0]);
        return !!(btn && !btn.disabled);
        """,
        sel,
      )
    )

  def dirty_mode_active(self, mode: str) -> bool:
    """Re-query via JS each call — mode tabs are remounted often (avoid stale refs)."""
    sel = self._dirty_mode_selector(mode)
    try:
      return bool(
        self.driver.execute_script(
          """
          const btn = document.querySelector(arguments[0]);
          return !!(btn && btn.classList.contains('active'));
          """,
          sel,
        )
      )
    except StaleElementReferenceException:
      return False

  def has_merge_conflict_ui(self) -> bool:
    return bool(self.driver.find_elements(*self.MERGE_CONFLICT))

  def editor_body_text(self) -> str:
    """Visible editor text without conflict/diff chrome widgets."""
    return (
      self.driver.execute_script(
        """
        const pm = document.querySelector('#editor .ProseMirror');
        if (!pm) return '';
        const clone = pm.cloneNode(true);
        clone.querySelectorAll('.merge-conflict, .diff-del, [data-diff-del]').forEach((el) => el.remove());
        return (clone.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
        """
      )
      or ""
    )

  def wait_until_editor_body_text(self, text: str) -> None:
    want = (text or "").replace("\xa0", " ").strip()
    self.wait.until(lambda d: self.editor_body_text() == want)

  def type_text(self, text: str) -> None:
    editor = self.wait.until(EC.presence_of_element_located(self.EDITOR))
    editor.click()
    editor.send_keys(text)

  def press_keys(self, *keys: str) -> None:
    editor = self.wait.until(EC.presence_of_element_located(self.EDITOR))
    editor.click()
    editor.send_keys(*keys)

  def editor_text(self) -> str:
    editor = self.driver.find_element(*self.EDITOR)
    return (editor.text or "").replace("\xa0", " ").strip()

  def editor_html(self) -> str:
    """Current TipTap / ProseMirror innerHTML."""
    return self.driver.execute_script(
      """
      const el = document.querySelector('#editor .ProseMirror');
      return el ? el.innerHTML : '';
      """
    ) or ""

  def dump_fs_tree(self, root: str = "/") -> dict:
    """Readable LightningFS tree via window.__kindredDebug (text files as strings)."""
    return self.driver.execute_async_script(
      """
      const root = arguments[0];
      const done = arguments[arguments.length - 1];
      const dbg = window.__kindredDebug;
      if (!dbg || typeof dbg.dumpFsTree !== 'function') {
        done({ error: 'window.__kindredDebug.dumpFsTree unavailable; rebuild frontend' });
        return;
      }
      dbg.dumpFsTree(root).then(done).catch((err) => done({ error: String(err && err.message || err) }));
      """,
      root,
    )

  def drafts_pane_visible(self) -> bool:
    draft_list = self.driver.find_element(*self.DRAFT_LIST)
    heading = self.driver.find_element(*self.DRAFTS_HEADING)
    return draft_list.is_displayed() and heading.is_displayed()

  def wait_until_drafts_pane_hidden(self) -> None:
    self.wait.until(EC.invisibility_of_element_located(self.DRAFT_LIST))
    self.wait.until(
      lambda d: d.find_element(*self.DRAFTS_HEADING).get_attribute("hidden") is not None
    )

  def go_home(self) -> None:
    self.driver.find_element(*self.HOME_BTN).click()
    self.wait.until(EC.visibility_of_element_located(self.DRAFT_LIST))

  def wait_until_draft_active(self) -> None:
    self.wait_until_drafts_pane_hidden()
    self.wait.until(EC.visibility_of_element_located(self.PANE_MODE_CLUSTER))
    self.wait.until(EC.visibility_of_element_located(self.CHAT_TAB))

  def switch_to_git(self) -> None:
    self.wait_until_draft_active()
    self.driver.find_element(*self.GIT_TAB).click()
    self.wait.until(EC.visibility_of_element_located(self.GIT_PANE))
    self.wait.until(EC.visibility_of_element_located(self.COMMIT_BTN))
    self.wait.until(lambda d: d.find_element(*self.COMMIT_BTN).text in ("Commit", "Merge"))

  def _accept_alert_if_present(self) -> None:
    try:
      alert = self.driver.switch_to.alert
      alert.accept()
    except NoAlertPresentException:
      pass

  def commit(self) -> None:
    self.switch_to_git()
    self._wait_git_idle()
    self.wait_until_commit_clickable()
    label = self.commit_button_label()
    if label not in ("Commit", "Merge"):
      raise AssertionError(f"expected Commit/Merge button, got {label!r}")
    before = len(self.driver.find_elements(By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="view"]'))
    clicked = self.driver.execute_script(
      """
      const btn = document.getElementById('commit-btn');
      if (!btn || btn.disabled || btn.hidden) return false;
      btn.click();
      return true;
      """
    )
    if not clicked:
      raise TimeoutException("commit button not clickable")
    self.wait.until(
      lambda d: len(d.find_elements(By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="view"]'))
      > before
    )
    self._wait_git_idle()
    # Dismiss post-commit message rename so later actions aren't blocked
    try:
      inp = self.driver.find_element(By.CSS_SELECTOR, "#git-commit-list .git-row-title-input")
      inp.send_keys(Keys.ESCAPE)
    except NoSuchElementException:
      pass

  def create_branch(self, name: str) -> None:
    btn = self.wait.until(EC.element_to_be_clickable(self.GIT_NEW_BRANCH))
    btn.click()
    sel = "#git-branch-list .git-row.active .git-row-title-input"
    self.wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, sel)))
    # Avoid clear(): it can blur to body and cancel inline rename (empty finish).
    last_err: Exception | None = None
    for _ in range(3):
      try:
        inp = self.driver.find_element(By.CSS_SELECTOR, sel)
        inp.send_keys(Keys.CONTROL + "a")
        inp.send_keys(name)
        inp.send_keys(Keys.ENTER)
        last_err = None
        break
      except StaleElementReferenceException as err:
        last_err = err
    if last_err is not None:
      raise last_err
    self.wait.until(
      lambda d: d.find_element(
        By.CSS_SELECTOR, "#git-branch-list .git-row.active .git-row-title"
      ).text
      == name
    )

  def checkout_branch(self, name: str) -> None:
    row = self.wait.until(
      EC.element_to_be_clickable(
        (By.CSS_SELECTOR, f'#git-branch-list .git-row[data-git="checkout"][data-branch="{name}"]')
      )
    )
    row.click()
    try:
      WebDriverWait(self.driver, 1).until(EC.alert_is_present())
      self.driver.switch_to.alert.accept()
    except TimeoutException:
      pass
    self.wait.until(
      lambda d: "active"
      in (
        d.find_element(
          By.CSS_SELECTOR, f'#git-branch-list .git-row[data-branch="{name}"]'
        ).get_attribute("class")
        or ""
      )
    )

  def merge_branch(self, name: str, *, expect_conflicts: bool = True) -> None:
    row = self.wait.until(
      EC.presence_of_element_located(
        (By.CSS_SELECTOR, f'#git-branch-list .git-row[data-branch="{name}"]')
      )
    )
    ActionChains(self.driver).move_to_element(row).perform()
    merge_btn = self.wait.until(
      EC.element_to_be_clickable(
        (
          By.CSS_SELECTOR,
          f'#git-branch-list button[data-git="merge"][data-branch="{name}"]',
        )
      )
    )
    merge_btn.click()
    if expect_conflicts:
      self.wait_for_conflicts()
    else:
      self.wait_until_status_contains("merge ready")

  def commit_count(self) -> int:
    return len(self.driver.find_elements(*self.GIT_COMMIT_ROWS))

  def commit_button_label(self) -> str:
    btn = self.wait.until(EC.visibility_of_element_located(self.COMMIT_BTN))
    return (btn.text or "").strip()

  def branch_names(self) -> list[str]:
    rows = self.driver.find_elements(By.CSS_SELECTOR, "#git-branch-list .git-row[data-branch]")
    return [r.get_attribute("data-branch") or "" for r in rows]

  def branch_has_delete_button(self, name: str) -> bool:
    row = self.wait.until(
      EC.presence_of_element_located(
        (By.CSS_SELECTOR, f'#git-branch-list .git-row[data-branch="{name}"]')
      )
    )
    ActionChains(self.driver).move_to_element(row).perform()
    return bool(
      self.driver.find_elements(
        By.CSS_SELECTOR,
        f'#git-branch-list button[data-git="delete"][data-branch="{name}"]',
      )
    )

  def delete_branch(self, name: str) -> None:
    row = self.wait.until(
      EC.presence_of_element_located(
        (By.CSS_SELECTOR, f'#git-branch-list .git-row[data-branch="{name}"]')
      )
    )
    ActionChains(self.driver).move_to_element(row).perform()
    btn = self.wait.until(
      EC.element_to_be_clickable(
        (
          By.CSS_SELECTOR,
          f'#git-branch-list button[data-git="delete"][data-branch="{name}"]',
        )
      )
    )
    btn.click()
    alert = self.wait.until(EC.alert_is_present())
    alert.accept()
    self.wait.until(
      lambda d: not d.find_elements(
        By.CSS_SELECTOR, f'#git-branch-list .git-row[data-branch="{name}"]'
      )
    )

  def open_draft_at(self, index: int = 0) -> None:
    """Open a draft from the home list (0 = first row)."""
    self.wait.until(EC.visibility_of_element_located(self.DRAFT_LIST))
    self.wait.until(
      lambda d: len(d.find_elements(By.CSS_SELECTOR, "#draft-list .draft-item[data-id]"))
      > index
    )
    rows = self.driver.find_elements(By.CSS_SELECTOR, "#draft-list .draft-item[data-id]")
    rows[index].click()
    self.wait_until_draft_active()

  def wait_for_conflicts(self) -> None:
    self.wait.until(EC.presence_of_element_located(self.MERGE_CONFLICT))

  def conflict_button_texts(self) -> tuple[str, str]:
    ours = self.wait.until(EC.presence_of_element_located(self.CONFLICT_OURS))
    theirs = self.driver.find_element(*self.CONFLICT_THEIRS)
    return (ours.text or "").replace("\xa0", " "), (theirs.text or "").replace("\xa0", " ")

  def conflict_button_html(self) -> tuple[str, str]:
    ours = self.wait.until(EC.presence_of_element_located(self.CONFLICT_OURS))
    theirs = self.driver.find_element(*self.CONFLICT_THEIRS)
    return (ours.get_attribute("innerHTML") or "", theirs.get_attribute("innerHTML") or "")

  def has_keep_both_button(self) -> bool:
    return bool(
      self.driver.find_elements(
        By.CSS_SELECTOR, "#editor .merge-conflict-btn.merge-conflict-both"
      )
    )

  def conflict_count(self) -> int:
    return len(self.driver.find_elements(*self.MERGE_CONFLICT))

  def click_conflict_keep_ours(self, index: int = 0) -> None:
    self._click_conflict_btn(self.CONFLICT_OURS, index)

  def click_conflict_keep_theirs(self, index: int = 0) -> None:
    self._click_conflict_btn(self.CONFLICT_THEIRS, index)

  def click_conflict_keep_both(self, index: int = 0) -> None:
    both = (By.CSS_SELECTOR, "#editor .merge-conflict-btn.merge-conflict-both")
    self._click_conflict_btn(both, index)

  def _click_conflict_btn(self, loc: tuple, index: int) -> None:
    last_err: Exception | None = None
    for _ in range(5):
      try:
        before = self.conflict_count()
        btns = self.driver.find_elements(*loc)
        if index >= len(btns):
          raise AssertionError(
            f"no conflict button at index {index} for {loc} (have {len(btns)})"
          )
        btns[index].click()
        self.wait.until(
          lambda d: self.conflict_count() < before or not self.has_merge_conflict_ui()
        )
        self._wait_git_idle()
        # After last conflict in a live merge, Merge must become clickable.
        if not self.has_merge_conflict_ui() and self.commit_button_label() == "Merge":
          self.wait_until_commit_clickable()
        return
      except StaleElementReferenceException as err:
        last_err = err
    if last_err is not None:
      raise last_err

  def diff_ins_texts(self) -> list[str]:
    els = self.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-ins")
    return [(e.text or "").replace("\xa0", " ") for e in els]

  def diff_del_texts(self) -> list[str]:
    els = self.driver.find_elements(By.CSS_SELECTOR, "#editor .diff-del")
    return [(e.text or "").replace("\xa0", " ") for e in els]

  def commit_button_disabled(self) -> bool:
    btn = self.wait.until(EC.visibility_of_element_located(self.COMMIT_BTN))
    return not btn.is_enabled()

  def wait_until_editor_text(self, text: str) -> None:
    want = (text or "").replace("\xa0", " ").strip()
    self.wait.until(lambda d: self.editor_text() == want)

  def paragraph_count(self) -> int:
    return int(
      self.driver.execute_script(
        """
        const pm = document.querySelector('#editor .ProseMirror');
        if (!pm) return 0;
        return pm.querySelectorAll(':scope > p').length;
        """
      )
      or 0
    )

  def editor_has_tag(self, tag: str) -> bool:
    tag = tag.lower()
    return bool(
      self.driver.execute_script(
        """
        const tag = arguments[0];
        const pm = document.querySelector('#editor .ProseMirror');
        return !!(pm && pm.querySelector(tag));
        """,
        tag,
      )
    )

  def toolbar_click(self, cmd: str) -> None:
    btn = self.wait.until(
      EC.element_to_be_clickable(
        (By.CSS_SELECTOR, f'#editor-toolbar button[data-cmd="{cmd}"]')
      )
    )
    btn.click()

  def select_all_in_editor(self) -> None:
    self.press_keys(Keys.CONTROL + "a")

  def paragraph_text_align(self, index: int = 0) -> str:
    return (
      self.driver.execute_script(
        """
        const i = arguments[0];
        const pm = document.querySelector('#editor .ProseMirror');
        const p = pm && pm.querySelectorAll(':scope > p')[i];
        if (!p) return '';
        return (p.style && p.style.textAlign) || '';
        """,
        index,
      )
      or ""
    )

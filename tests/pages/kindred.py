from __future__ import annotations

import re

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
  ANALYZE_BTN = (By.ID, "analyze-btn")
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
    """Paste HTML into the TipTap editor (text/html clipboard only)."""
    self.wait.until(EC.presence_of_element_located(self.EDITOR))
    self.driver.execute_script(
      """
      const html = arguments[0];
      const el = document.querySelector('#editor .ProseMirror');
      if (!el) throw new Error('editor not found');
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
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

  def enter_dirty_review(self) -> None:
    btn = self.wait.until(EC.element_to_be_clickable(self.DIRTY_REVIEW_BTN))
    btn.click()
    self.wait_for_conflicts()

  def has_merge_conflict_ui(self) -> bool:
    return bool(self.driver.find_elements(*self.MERGE_CONFLICT))

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
    self.wait.until(EC.visibility_of_element_located(self.ANALYZE_BTN))

  def switch_to_git(self) -> None:
    self.wait_until_draft_active()
    self.driver.find_element(*self.GIT_TAB).click()
    self.wait.until(EC.visibility_of_element_located(self.GIT_PANE))
    self.wait.until(lambda d: d.find_element(*self.ANALYZE_BTN).text in ("Commit", "Merge"))

  def _accept_alert_if_present(self) -> None:
    try:
      alert = self.driver.switch_to.alert
      alert.accept()
    except NoAlertPresentException:
      pass

  def commit(self) -> None:
    btn = self.wait.until(EC.element_to_be_clickable(self.ANALYZE_BTN))
    label = btn.text
    if label not in ("Commit", "Merge"):
      raise AssertionError(f"expected Commit/Merge button, got {label!r}")
    before = len(self.driver.find_elements(By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="view"]'))
    btn.click()
    self.wait.until(
      lambda d: len(d.find_elements(By.CSS_SELECTOR, '#git-commit-list .git-row[data-git="view"]'))
      > before
    )
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

  def merge_branch(self, name: str) -> None:
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
    self.wait_for_conflicts()

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

  def wait_for_conflicts(self) -> None:
    self.wait.until(EC.presence_of_element_located(self.MERGE_CONFLICT))

  def conflict_button_texts(self) -> tuple[str, str]:
    ours = self.wait.until(EC.presence_of_element_located(self.CONFLICT_OURS))
    theirs = self.driver.find_element(*self.CONFLICT_THEIRS)
    return (ours.text or "").replace("\xa0", " "), (theirs.text or "").replace("\xa0", " ")

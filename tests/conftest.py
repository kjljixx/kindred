from __future__ import annotations

import socket
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

from debug_dump import save_failure_artifacts
from pages.kindred import KindredPage


def _free_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    return int(sock.getsockname()[1])


def _wait_for_server(url: str, timeout: float = 15.0) -> None:
  deadline = time.monotonic() + timeout
  last_err: Exception | None = None
  while time.monotonic() < deadline:
    try:
      with urllib.request.urlopen(url, timeout=1) as resp:
        if resp.status == 200:
          return
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
      last_err = err
      time.sleep(0.1)
  raise RuntimeError(f"server did not become ready at {url}") from last_err


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
  outcome = yield
  rep = outcome.get_result()
  setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(scope="session")
def base_url() -> str:
  """Session-scoped Kindred GUI server. Reuse across tests."""
  from kindred.server import app

  host = "127.0.0.1"
  port = _free_port()
  config = uvicorn.Config(app, host=host, port=port, log_level="warning")
  server = uvicorn.Server(config)
  thread = threading.Thread(target=server.run, daemon=True)
  thread.start()

  url = f"http://{host}:{port}/"
  try:
    _wait_for_server(url)
    yield url
  finally:
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def driver():
  """Fresh headless Chrome per test (empty IndexedDB / home pane)."""
  options = Options()
  options.add_argument("--headless=new")
  options.add_argument("--disable-gpu")
  options.add_argument("--window-size=1280,800")
  options.add_argument("--no-sandbox")
  options.add_argument("--incognito")

  browser = webdriver.Chrome(options=options)
  try:
    yield browser
  finally:
    browser.quit()


@pytest.fixture
def kindred(driver, base_url: str, request) -> KindredPage:
  """Page object on a loaded home screen. Prefer this in new tests."""
  page = KindredPage(driver, base_url)
  page.open()
  page.wait_until_ready()
  yield page
  rep = getattr(request.node, "rep_call", None)
  if rep is not None and rep.failed:
    out = save_failure_artifacts(page, request.node.nodeid)
    print(f"\nSaved failure artifacts to {out}")

from __future__ import annotations

import json
import re
from pathlib import Path

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


def _safe_name(nodeid: str) -> str:
  name = nodeid.replace("/", "_").replace("::", "__").replace("\\", "_")
  return re.sub(r"[^\w.\-]+", "_", name)[:180]


def save_failure_artifacts(page, nodeid: str) -> Path:
  """Write screenshot, LightningFS tree, and editor HTML for a failed test."""
  out = ARTIFACTS_DIR / _safe_name(nodeid)
  out.mkdir(parents=True, exist_ok=True)

  try:
    page.driver.save_screenshot(str(out / "screenshot.png"))
  except Exception as err:  # noqa: BLE001 — best-effort diagnostics
    (out / "screenshot_error.txt").write_text(str(err), encoding="utf-8")

  try:
    html = page.editor_html()
  except Exception as err:  # noqa: BLE001 — best-effort diagnostics
    html = f"<!-- editor_html failed: {err} -->"
  (out / "editor.html").write_text(html, encoding="utf-8")

  try:
    fs_tree = page.dump_fs_tree()
  except Exception as err:  # noqa: BLE001
    fs_tree = {"error": str(err)}
  (out / "fs_tree.json").write_text(
    json.dumps(fs_tree, indent=2, default=str),
    encoding="utf-8",
  )

  try:
    (out / "page_source.html").write_text(page.driver.page_source or "", encoding="utf-8")
  except Exception as err:  # noqa: BLE001
    (out / "page_source.html").write_text(f"<!-- page_source failed: {err} -->", encoding="utf-8")

  return out

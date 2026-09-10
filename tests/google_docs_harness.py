from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "frontend" / "test" / "googleDocsRoundTripHarness.mjs"


def run_google_docs_harness(payload: dict) -> dict:
  result = subprocess.run(
    ["node", str(HARNESS)],
    cwd=ROOT / "frontend",
    input=json.dumps(payload),
    text=True,
    capture_output=True,
    check=False,
  )
  if result.returncode:
    raise AssertionError(
      "Google Docs harness failed:\n"
      f"stdout: {result.stdout}\n"
      f"stderr: {result.stderr}"
    )
  return json.loads(result.stdout)

#!/usr/bin/env python3
"""Apply Google Docs batch-update requests from JSON and print resulting document."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest


DOCS_URL = "https://docs.googleapis.com/v1/documents"


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
    "requests_file",
    type=Path,
    help="JSON file containing a request array or {\"requests\": [...]} object",
  )
  parser.add_argument(
    "--document-id",
    default=os.environ.get("GOOGLE_DOCS_DOCUMENT_ID"),
    required=not os.environ.get("GOOGLE_DOCS_DOCUMENT_ID"),
    help="Google document ID; defaults to GOOGLE_DOCS_DOCUMENT_ID",
  )
  return parser.parse_args()


def load_requests(path: Path) -> list[dict]:
  payload = json.loads(path.read_text(encoding="utf-8"))
  requests = payload.get("requests") if isinstance(payload, dict) else payload
  if not isinstance(requests, list) or not all(isinstance(item, dict) for item in requests):
    raise ValueError("JSON must contain a request array or an object with a 'requests' array")
  return requests


def auth_headers() -> dict[str, str]:
  credentials, _ = google_auth_default(
    scopes=["https://www.googleapis.com/auth/documents"]
  )
  if not credentials.valid:
    credentials.refresh(GoogleAuthRequest())
  return {
    "Authorization": f"Bearer {credentials.token}",
    "Content-Type": "application/json",
  }


def get_document(document_id: str, headers: dict[str, str]) -> dict:
  response = httpx.get(
    f"{DOCS_URL}/{document_id}",
    headers=headers,
    timeout=30,
  )
  response.raise_for_status()
  return response.json()


def batch_update(document_id: str, headers: dict[str, str], requests: list[dict]) -> None:
  response = httpx.post(
    f"{DOCS_URL}/{document_id}:batchUpdate",
    headers=headers,
    json={"requests": requests},
    timeout=30,
  )
  response.raise_for_status()


def reset_body(document_id: str, headers: dict[str, str]) -> dict[str, int | bool]:
  document = get_document(document_id, headers)
  content = document.get("body", {}).get("content", [])
  bullet_requests = [
    {
      "deleteParagraphBullets": {
        "range": {
          "startIndex": block["startIndex"],
          "endIndex": block["endIndex"],
        },
      },
    }
    for block in content
    if block.get("paragraph", {}).get("bullet")
  ]
  if bullet_requests:
    batch_update(document_id, headers, bullet_requests)

  document = get_document(document_id, headers)
  content = document.get("body", {}).get("content", [])
  end_index = content[-1].get("endIndex", 2) if content else 2
  if end_index <= 2:
    return {
      "paragraphBulletsDeleted": len(bullet_requests),
      "bodyContentDeleted": False,
    }
  batch_update(document_id, headers, [{
    "deleteContentRange": {
      "range": {"startIndex": 1, "endIndex": end_index - 1},
    },
  }])
  return {
    "paragraphBulletsDeleted": len(bullet_requests),
    "bodyContentDeleted": True,
  }


def main() -> int:
  repo_root = Path(__file__).resolve().parents[1]
  load_dotenv(repo_root / ".env")
  args = parse_args()
  requests = load_requests(args.requests_file)
  headers = auth_headers()
  print({
    "documentId": args.document_id,
    "requestsFile": str(args.requests_file),
    "requestCount": len(requests),
  }, file=sys.stderr)

  reset = reset_body(args.document_id, headers)
  print({"resetBody": reset}, file=sys.stderr)
  batch_update(args.document_id, headers, requests)

  result = get_document(args.document_id, headers)
  print(json.dumps({
    "documentId": result.get("documentId"),
    "revisionId": result.get("revisionId"),
    "suggestionsViewMode": result.get("suggestionsViewMode"),
    "body": {
      "content": result.get("body", {}).get("content", []),
    },
  }, indent=2, ensure_ascii=False))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())

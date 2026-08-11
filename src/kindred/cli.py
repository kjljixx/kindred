from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer
from dotenv import load_dotenv

from kindred.lm import HUMAN_MODEL, is_human_model
from kindred.review import DEFAULT_MAX_WORKERS, DEFAULT_MODEL, review
from kindred.tracing import configure_tracing, flush_tracing, is_tracing_enabled
from kindred.types import ReviewResult

app = typer.Typer(
  name="kindred",
  help="Review writing quality at sentence, paragraph, and full text levels.",
  add_completion=False,
  invoke_without_command=True,
)


def _format_result(result: ReviewResult) -> str:
  sections: list[str] = []

  if result.sentences:
    sections.append("## Sentences\n")
    for unit in result.sentences:
      sections.append(f"### Sentence {unit.index + 1}\n")
      sections.append(f"> {unit.text}\n")
      sections.append(f"{unit.feedback}\n")

  if result.paragraphs:
    sections.append("## Paragraphs\n")
    for unit in result.paragraphs:
      sections.append(f"### Paragraph {unit.index + 1}\n")
      sections.append(f"> {unit.text}\n")
      sections.append(f"{unit.feedback}\n")

  sections.append("## Full Text\n")
  sections.append(f"{result.essay}\n")
  return "\n".join(sections)


@app.callback(invoke_without_command=True)
def main(
  ctx: typer.Context,
  path: Optional[Path] = typer.Argument(
    None,
    help="Path to a .txt/.md text file (omit with --gui)",
  ),
  model: str = typer.Option(
    DEFAULT_MODEL,
    "--model",
    "-m",
    help=f"LiteLLM model string, or '{HUMAN_MODEL}' for interactive you",
  ),
  workers: int = typer.Option(
    DEFAULT_MAX_WORKERS,
    "--workers",
    "-w",
    help="Max parallel LM calls",
  ),
  out: Optional[Path] = typer.Option(
    None,
    "--out",
    "-o",
    help="Optional path to write the review report",
  ),
  gui: bool = typer.Option(
    False,
    "--gui",
    help="Launch the local review GUI in a browser",
  ),
  host: str = typer.Option("127.0.0.1", "--host", help="GUI bind host"),
  port: int = typer.Option(8765, "--port", help="GUI bind port"),
  no_browser: bool = typer.Option(
    False,
    "--no-browser",
    help="With --gui, do not open a browser tab",
  ),
) -> None:
  """Review writing quality at sentence, paragraph, and full text levels."""
  if ctx.invoked_subcommand is not None:
    return

  if gui:
    from kindred.server import run_server

    typer.echo(f"Starting GUI at http://{host}:{port}/", err=True)
    run_server(host=host, port=port, open_browser=not no_browser)
    return

  if path is None:
    raise typer.BadParameter("PATH is required unless --gui is set")

  load_dotenv()
  configure_tracing()

  text = path.read_text(encoding="utf-8").strip()
  if not text:
    raise typer.BadParameter(f"Empty file: {path}")

  if is_human_model(model):
    typer.echo(
      "Human model: you will be prompted for each review unit. Finish with a line: END",
      err=True,
    )

  if is_tracing_enabled():
    typer.echo("OpenLLMetry tracing enabled", err=True)

  typer.echo(f"Reviewing {path} with {model} ...", err=True)
  try:
    result = review(text, model=model, max_workers=workers)
    report = _format_result(result)
    if out is not None:
      out.parent.mkdir(parents=True, exist_ok=True)
      out.write_text(report, encoding="utf-8")
      typer.echo(f"Wrote → {out}", err=True)
    else:
      typer.echo(report)
  finally:
    flush_tracing()


if __name__ == "__main__":
  app()

from __future__ import annotations

import typer

app = typer.Typer(
  name="kindred",
  help="Local writing GUI with draft-scoped AI chat.",
  add_completion=False,
  invoke_without_command=True,
)


@app.callback(invoke_without_command=True)
def main(
  ctx: typer.Context,
  gui: bool = typer.Option(
    True,
    "--gui/--no-gui",
    help="Launch the local GUI in a browser",
  ),
  host: str = typer.Option("127.0.0.1", "--host", help="GUI bind host"),
  port: int = typer.Option(8765, "--port", help="GUI bind port"),
  no_browser: bool = typer.Option(
    False,
    "--no-browser",
    help="Do not open a browser tab",
  ),
) -> None:
  """Launch the Kindred writing GUI."""
  if ctx.invoked_subcommand is not None:
    return

  if not gui:
    raise typer.BadParameter("Use --gui to launch the app")

  from kindred.server import run_server

  typer.echo(f"Starting GUI at http://{host}:{port}/", err=True)
  run_server(host=host, port=port, open_browser=not no_browser)


if __name__ == "__main__":
  app()

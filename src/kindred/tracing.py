"""OpenLLMetry (Traceloop) tracing helpers for kindred.

Uses ``traceloop-sdk`` for LiteLLM + OpenAI Responses auto-instrumentation and
``@workflow`` / ``@task`` spans. Tracing is enabled when ``TRACELOOP_API_KEY``
or ``TRACELOOP_BASE_URL`` is set, unless ``TRACELOOP_TRACING_ENABLED`` is false.
"""

from __future__ import annotations

import atexit
import json
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import wraps
from typing import Any, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

_CONFIGURED = False
_ATEXIT_REGISTERED = False


def is_tracing_enabled() -> bool:
  flag = os.getenv("TRACELOOP_TRACING_ENABLED", "true").strip().lower()
  if flag in {"0", "false", "no", "off"}:
    return False
  return bool(
    os.getenv("TRACELOOP_API_KEY", "").strip()
    or os.getenv("TRACELOOP_BASE_URL", "").strip()
  )


def configure_tracing() -> bool:
  """
  Initialize OpenLLMetry when credentials / export endpoint are present.

  Safe to call repeatedly. Returns whether tracing is active. An early call
  without credentials does not block a later successful configure.
  """
  global _CONFIGURED, _ATEXIT_REGISTERED
  if not is_tracing_enabled():
    return False
  if _CONFIGURED:
    return True

  from traceloop.sdk import Traceloop
  from traceloop.sdk.instruments import Instruments

  disable_batch = os.getenv("TRACELOOP_DISABLE_BATCH", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
  }

  Traceloop.init(
    app_name="kindred",
    instruments={Instruments.LITELLM, Instruments.OPENAI},
    disable_batch=disable_batch,
  )

  from traceloop.sdk.tracing.tracing import TracerWrapper

  if not hasattr(TracerWrapper, "instance"):
    return False

  if not _ATEXIT_REGISTERED:
    atexit.register(flush_tracing)
    _ATEXIT_REGISTERED = True

  _CONFIGURED = True
  return True


def flush_tracing() -> None:
  """Flush buffered OTEL spans (important for short-lived CLIs)."""
  if not is_tracing_enabled() or not _CONFIGURED:
    return
  try:
    from traceloop.sdk.tracing.tracing import TracerWrapper

    TracerWrapper().flush()
  except Exception:
    # Never let observability tear down the user command.
    pass


def observe(
  func: F | None = None,
  *,
  name: str | None = None,
  as_type: str | None = None,
  capture_input: bool = True,
  capture_output: bool = True,
  **kwargs: Any,
) -> F | Callable[[F], F]:
  """
  OpenLLMetry ``@workflow`` / ``@task`` when tracing is configured; otherwise a no-op.

  Decision is deferred to call time so ``load_dotenv()`` can run first.
  ``capture_input`` / ``capture_output`` are accepted for API compatibility;
  prompt content is controlled by ``TRACELOOP_TRACE_CONTENT``.
  """
  del capture_input, capture_output, kwargs  # content tracing is env-driven

  def decorator(fn: F) -> F:
    wrapped_fn: F | None = None

    @wraps(fn)
    def wrapper(*args: Any, **kw: Any) -> Any:
      nonlocal wrapped_fn
      configure_tracing()
      if not is_tracing_enabled():
        return fn(*args, **kw)
      if wrapped_fn is None:
        from traceloop.sdk.decorators import task, workflow

        entity_name = name or fn.__qualname__
        if as_type == "workflow":
          wrapped_fn = workflow(name=entity_name)(fn)  # type: ignore[assignment]
        else:
          wrapped_fn = task(name=entity_name)(fn)  # type: ignore[assignment]
      assert wrapped_fn is not None
      return wrapped_fn(*args, **kw)

    return wrapper  # type: ignore[return-value]

  if func is not None:
    return decorator(func)
  return decorator


@contextmanager
def trace_attributes(
  *,
  tags: list[str] | None = None,
  session_id: str | None = None,
  user_id: str | None = None,
  metadata: dict[str, Any] | None = None,
  trace_name: str | None = None,
) -> Iterator[None]:
  """Propagate association properties to the current observation subtree."""
  configure_tracing()
  if not is_tracing_enabled():
    yield
    return

  from traceloop.sdk import Traceloop
  from traceloop.sdk.tracing.tracing import set_workflow_name

  props: dict[str, Any] = {}
  if tags is not None:
    props["tags"] = ",".join(tags)
  if session_id is not None:
    props["session_id"] = session_id
  if user_id is not None:
    props["user_id"] = user_id
  if metadata is not None:
    props.update({str(k): str(v) for k, v in metadata.items()})
  if trace_name is not None:
    set_workflow_name(trace_name)
  if props:
    Traceloop.set_association_properties(props)
  yield


def update_current_trace(
  *,
  name: str | None = None,
  input: Any | None = None,
  output: Any | None = None,
  metadata: dict[str, Any] | None = None,
) -> None:
  """Update the active span with name, I/O, and metadata attributes."""
  configure_tracing()
  if not is_tracing_enabled():
    return
  try:
    from opentelemetry import trace

    span = trace.get_current_span()
    if not span.is_recording():
      return
    if name is not None:
      span.update_name(name)
    if metadata is not None:
      for key, value in metadata.items():
        span.set_attribute(f"kindred.{key}", str(value))
    if input is not None:
      span.set_attribute("kindred.input", json.dumps(input, default=str))
    if output is not None:
      span.set_attribute("kindred.output", json.dumps(output, default=str))
  except Exception:
    pass


def score_current(
  *,
  name: str,
  value: float,
  comment: str | None = None,
  data_type: str = "NUMERIC",
  on_trace: bool = False,
) -> None:
  """Attach a numeric score as attributes on the current span."""
  del data_type, on_trace  # OTEL spans carry attributes; no separate score API
  configure_tracing()
  if not is_tracing_enabled():
    return
  try:
    from opentelemetry import trace

    span = trace.get_current_span()
    if not span.is_recording():
      return
    span.set_attribute(f"kindred.score.{name}", float(value))
    if comment is not None:
      span.set_attribute(f"kindred.score.{name}.comment", comment)
  except Exception:
    pass


def extract_reasoning_summary(response: Any) -> str | None:
  """Pull reasoning summary text from a LiteLLM / OpenAI Responses payload."""
  for attr in ("reasoning_content", "reasoning_summary"):
    value = getattr(response, attr, None)
    if value is None and isinstance(response, dict):
      value = response.get(attr)
    if isinstance(value, dict):
      content = value.get("content")
      if content:
        return str(content).strip() or None
    if value and not isinstance(value, (dict, list)):
      text = str(value).strip()
      if text:
        return text

  try:
    message = response.choices[0].message
    reasoning_content = getattr(message, "reasoning_content", None)
    if reasoning_content:
      return str(reasoning_content).strip() or None
  except Exception:
    pass

  output = getattr(response, "output", None)
  if output is None and isinstance(response, dict):
    output = response.get("output")
  if not output:
    return None

  parts: list[str] = []
  for item in output:
    item_type = getattr(item, "type", None) or (
      item.get("type") if isinstance(item, dict) else None
    )
    if item_type != "reasoning":
      continue

    summary = getattr(item, "summary", None)
    if summary is None and isinstance(item, dict):
      summary = item.get("summary")
    if isinstance(summary, str) and summary.strip():
      parts.append(summary.strip())
    elif summary:
      for block in summary:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
          text = block.get("text")
        if text:
          parts.append(str(text).strip())

    content = getattr(item, "content", None)
    if content is None and isinstance(item, dict):
      content = item.get("content")
    if content:
      for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
          text = block.get("text")
        if text:
          parts.append(str(text).strip())

  joined = "\n".join(p for p in parts if p).strip()
  return joined or None


def record_reasoning_summary(
  response: Any,
  *,
  request_summary: str | None = None,
) -> None:
  """
  Attach reasoning summary text to the current span for Traceloop export.

  Belt-and-suspenders alongside OpenAI Responses auto-instrumentation, which
  LiteLLM's own instrumentor does not cover.
  """
  configure_tracing()
  if not is_tracing_enabled():
    return
  try:
    from opentelemetry import trace
    from opentelemetry.semconv_ai import SpanAttributes

    span = trace.get_current_span()
    if not span.is_recording():
      return
    if request_summary:
      span.set_attribute(
        SpanAttributes.GEN_AI_REQUEST_REASONING_SUMMARY,
        request_summary,
      )
    summary = extract_reasoning_summary(response)
    if summary:
      span.set_attribute("kindred.reasoning_summary", summary)
  except Exception:
    pass


def litellm_metadata(
  *,
  generation_name: str,
  tags: list[str] | None = None,
  extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
  """Metadata dict attached to LiteLLM calls (visible in instrumented spans)."""
  meta: dict[str, Any] = {"generation_name": generation_name}
  if tags:
    meta["tags"] = tags
  if extra:
    meta.update(extra)
  return meta

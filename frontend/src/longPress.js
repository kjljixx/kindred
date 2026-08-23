const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

export function bindLongPress(target, onLongPress, { ignore } = {}) {
  if (!target) return () => {};
  let timer = null;
  let startX = 0;
  let startY = 0;
  let handled = false;
  let suppressClickUntil = 0;

  const clear = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const onPointerDown = (event) => {
    if (!window.matchMedia("(hover: none), (pointer: coarse)").matches) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (event.button !== 0 || ignore?.(event)) return;
    startX = event.clientX;
    startY = event.clientY;
    handled = false;
    clear();
    timer = setTimeout(() => {
      handled = Boolean(onLongPress(event));
      if (handled) event.preventDefault();
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event) => {
    if (timer != null && Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE) clear();
  };
  const onPointerUp = (event) => {
    if (handled) {
      event.preventDefault();
      suppressClickUntil = Date.now() + 750;
    }
    clear();
  };
  const onContextMenu = (event) => {
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handled = false;
  };
  const onClick = (event) => {
    if (Date.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClickUntil = 0;
  };
  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerup", onPointerUp);
  target.addEventListener("pointercancel", clear);
    target.addEventListener("contextmenu", onContextMenu, true);
    target.addEventListener("click", onClick, true);
  return () => {
    clear();
    target.removeEventListener("pointerdown", onPointerDown);
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerup", onPointerUp);
    target.removeEventListener("pointercancel", clear);
      target.removeEventListener("contextmenu", onContextMenu, true);
      target.removeEventListener("click", onClick, true);
  };
}

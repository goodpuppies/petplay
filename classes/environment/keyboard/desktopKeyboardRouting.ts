import type { DisplayMouseSink } from "../displayInstance/mouse.ts";
import type { KeyboardSink } from "./types.ts";

/** Typing taps must not become desktop auto-repeat during a stalled scene frame.
 * Right-click navigation explicitly needs physical holds (for example Unity's fly camera).
 * Choose the mode once per press so releasing the mouse cannot strand a held key.
 */
export function createDesktopInputRouting(mouse: DisplayMouseSink, keyboard: KeyboardSink) {
  let rightDown = false;
  const modes = new Map<string, boolean>();
  const onMouse: DisplayMouseSink = (event) => {
    if (event.kind === "button" && event.button === "right") rightDown = event.pressed;
    mouse(event);
  };
  const onKey: KeyboardSink = (event) => {
    if (event.kind !== "key" || event.pressed == null) {
      keyboard(event);
      return;
    }
    const id = `${event.scanCodeHex}:${event.virtualKeyName ?? ""}`;
    if (event.pressed) {
      if (!modes.has(id)) modes.set(id, rightDown);
      if (modes.get(id)) keyboard(event);
      else {
        const { pressed: _, ...tap } = event;
        keyboard(tap);
      }
    } else {
      if (modes.get(id)) keyboard(event);
      modes.delete(id);
    }
  };
  return { onMouse, onKey };
}

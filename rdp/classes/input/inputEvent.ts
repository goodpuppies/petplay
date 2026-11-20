/**
 * What `desktopInput` injects: one event type for every sender (the VR scene's display and
 * keyboard, an rdp tab, a peer). Positions are 0..1 over the whole workspace.
 */
import type { KeyboardLogicEvent } from "../../../classes/environment/keyboard/types.ts";

export type MouseButton = "left" | "right" | "middle";
export type Modifier = Extract<KeyboardLogicEvent, { kind: "modifier" }>["modifier"];

export type InputEvent =
  | { t: "pointer"; x: number; y: number }
  /** With a position, the pointer moves there first. */
  | { t: "button"; button: MouseButton; down: boolean; x?: number; y?: number }
  /** `delta` in wheel notches, positive scrolls down (the DOM's `deltaY` sign). */
  | { t: "wheel"; delta: number; x?: number; y?: number }
  /**
   * A key by set-1 scan code (`1e`, `e01d`), or else by virtual key name (`F1`, `ESCAPE`) or
   * character. Without `down` it is a tap: press and release.
   */
  | { t: "key"; scan?: string; key?: string; char?: string; down?: boolean }
  /** A latched modifier from a virtual keyboard (caps toggles on `active`). */
  | { t: "modifier"; modifier: Modifier; active: boolean };

const BUTTONS = new Set<string>(["left", "right", "middle"]);
const MODIFIERS = new Set<string>([
  "shift",
  "caps",
  "leftCtrl",
  "rightCtrl",
  "leftAlt",
  "rightAlt",
  "leftMeta",
  "rightMeta",
]);
const SCAN = /^(?:e0)?[0-9a-f]{1,4}$/i;
const KEY_NAME = /^[A-Z0-9_]{1,24}$/i;

/** Positions outside 0..1 are clamped by the injector, not rejected. */
const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optionalAt = (e: { x?: unknown; y?: unknown }) =>
  (e.x === undefined && e.y === undefined) || (unit(e.x) && unit(e.y));

/** Whether `value` is a well-formed InputEvent (anything else is rejected, never injected). */
export function isInputEvent(value: unknown): value is InputEvent {
  const e = value as Record<string, unknown> | null;
  switch (e?.t) {
    case "pointer":
      return unit(e.x) && unit(e.y);
    case "button":
      return BUTTONS.has(e.button as string) && typeof e.down === "boolean" && optionalAt(e);
    case "wheel":
      return typeof e.delta === "number" && Number.isFinite(e.delta) && Math.abs(e.delta) <= 100 &&
        optionalAt(e);
    case "key":
      return (e.down === undefined || typeof e.down === "boolean") &&
        (e.scan === undefined || (typeof e.scan === "string" && SCAN.test(e.scan))) &&
        (e.key === undefined || (typeof e.key === "string" && KEY_NAME.test(e.key))) &&
        (e.char === undefined || (typeof e.char === "string" && e.char.length <= 2)) &&
        (e.scan !== undefined || e.key !== undefined || e.char !== undefined);
    case "modifier":
      return MODIFIERS.has(e.modifier as string) && typeof e.active === "boolean";
  }
  return false;
}

/** The scene keyboard's event for a key or modifier InputEvent (platform sinks take these). */
export function toKeyboardLogicEvent(
  event: Extract<InputEvent, { t: "key" | "modifier" }>,
): KeyboardLogicEvent {
  if (event.t === "modifier") {
    return { kind: "modifier", modifier: event.modifier, active: event.active };
  }
  const scanCodeHex = event.scan?.toUpperCase() ?? "00";
  return {
    kind: "key",
    ...(event.down === undefined ? {} : { pressed: event.down }),
    scanCode: Number.parseInt(scanCodeHex, 16) || 0,
    scanCodeHex,
    ...(event.char === undefined ? {} : { char: event.char }),
    ...(event.key === undefined ? {} : { virtualKeyName: event.key }),
  };
}

/** The other way: what the VR scene's keyboard sends, as an InputEvent. */
export function fromKeyboardLogicEvent(event: KeyboardLogicEvent): InputEvent | null {
  if (event.kind === "modifier") {
    return { t: "modifier", modifier: event.modifier, active: event.active };
  }
  const scan = event.scanCodeHex && event.scanCodeHex !== "00" ? event.scanCodeHex : undefined;
  const out: InputEvent = {
    t: "key",
    ...(scan ? { scan } : {}),
    ...(event.virtualKeyName ? { key: event.virtualKeyName } : {}),
    ...(event.char ? { char: event.char } : {}),
    ...(event.pressed == null ? {} : { down: event.pressed }),
  };
  return isInputEvent(out) ? out : null;
}

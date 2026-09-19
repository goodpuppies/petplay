import { COLOR } from "../ui/tokens.ts";
import type { NormalizedKeyFace } from "./types.ts";

export type KeyboardColorToken = NormalizedKeyFace["colorToken"];

/**
 * Keyboard colours, on the overlay design system.
 *
 * The keyboard reads as one more panel in that system: a black tray with grey
 * key tiles on it, the same ground/tile relationship the wrist overlay and the
 * contextual menu use. Keys sit directly on the black tray, so they are
 * top-level elements and take the tile shape rather than the circle one.
 *
 * **Every key is the same grey.** An earlier pass drew modifiers as outlines to
 * separate them from letter keys without spending a value step; on a surface
 * this dense that produced a field of competing rectangles rather than a
 * keyboard. A key's role is already legible from its size, position and legend,
 * so colour does not need to carry it — leaving colour free to mean one thing
 * only, which is the point below.
 *
 * **Pressed is the accent.** Accent means "this is on" everywhere else in the
 * UI, and a held key is exactly that, so a pressed cap is yellow with black
 * ink. Against a uniform grey field it is also the only thing that changes,
 * which is what makes key feedback readable at a glance.
 */
export const KEYBOARD_THEME = {
  default: {
    background: COLOR.tile,
    border: COLOR.tile,
  },
  /** Modifier and wide keys: identical to a letter key. See above. */
  dark: {
    background: COLOR.tile,
    border: COLOR.tile,
  },
  error: {
    background: COLOR.danger,
    border: COLOR.danger,
  },
  /** No accent: a key is not "on" merely because it confirms something. */
  confirm: {
    background: COLOR.tile,
    border: COLOR.tile,
  },
  /** Filled in `tokenBackground` / `tokenBorderColor` when `pressed` is true. */
  pressed: {
    default: { background: COLOR.accent, border: COLOR.accent },
    dark: { background: COLOR.accent, border: COLOR.accent },
    error: { background: COLOR.dangerBright, border: COLOR.dangerBright },
    confirm: { background: COLOR.accent, border: COLOR.accent },
  },
} as const;

const KEY_TEXT_COLORS: Record<KeyboardColorToken, string> = {
  default: COLOR.ink,
  dark: COLOR.ink,
  error: COLOR.onDanger,
  confirm: COLOR.ink,
};

const KEY_TEXT_COLORS_PRESSED: Record<KeyboardColorToken, string> = {
  default: COLOR.onAccent,
  dark: COLOR.onAccent,
  error: COLOR.onDanger,
  confirm: COLOR.onAccent,
};

/**
 * @param color — JSON `color` or undefined
 * @param highlight — JSON `highlightColor` (takes precedence)
 */
export function keyFaceToToken(
  color: string | undefined,
  highlight: string | undefined,
): KeyboardColorToken {
  if (highlight === "error") {
    return "error";
  }
  if (highlight === "confirm") {
    return "confirm";
  }
  if (color === "dark") {
    return "dark";
  }
  return "default";
}

export function tokenBackground(
  token: KeyboardColorToken,
  pressed: boolean = false,
): string {
  if (pressed) {
    return KEYBOARD_THEME.pressed[token].background;
  }
  return KEYBOARD_THEME[token].background;
}

export function tokenBorderColor(
  token: KeyboardColorToken,
  pressed: boolean = false,
): string {
  if (pressed) {
    return KEYBOARD_THEME.pressed[token].border;
  }
  return KEYBOARD_THEME[token].border;
}

export function keyTextColor(
  token: KeyboardColorToken,
  pressed: boolean = false,
): string {
  return pressed ? KEY_TEXT_COLORS_PRESSED[token] : KEY_TEXT_COLORS[token];
}

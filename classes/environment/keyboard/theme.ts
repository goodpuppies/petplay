import type { NormalizedKeyFace } from "./types.ts";

export type KeyboardColorToken = NormalizedKeyFace["colorToken"];

/**
 * petplay uikit: maps keyboard `color` / `highlightColor` JSON tokens to webgpu-uikit `Container` colors.
 *
 * Idle caps use **lighter mid-greys** (closer to how XS often reads in-headset) so key legends stay
 * legible on **AMOLED** (near-black UIs can crush; soft borders are used instead of ink-black edges).
 * Pressed caps jump to a **near-white** surface so feedback stays obvious.
 */
export const KEYBOARD_THEME = {
  default: {
    background: "#6b7380",
    border: "#3d444d",
  },
  dark: {
    /* Slightly dimmer than default — mod / wide keys, still a readable grey, not a “sink hole”. */
    background: "#525a66",
    border: "#2f353d",
  },
  error: {
    background: "#c64e46",
    border: "#7a2a24",
  },
  confirm: {
    background: "#35a65a",
    border: "#1d5a33",
  },
  /** Filled in `tokenBackground` / `tokenBorderColor` when `pressed` is true. */
  pressed: {
    default: { background: "#e4e6ea", border: "#6a737e" },
    dark: { background: "#d6dadf", border: "#5a626c" },
    error: { background: "#f0b4ae", border: "#8a3a32" },
    confirm: { background: "#8fe0a5", border: "#2e7a45" },
  },
} as const;

const KEY_TEXT_COLORS: Record<KeyboardColorToken, string> = {
  default: "#ffffff",
  dark: "#f7f8fa",
  error: "#ffffff",
  confirm: "#ffffff",
};

const KEY_TEXT_COLORS_PRESSED: Record<KeyboardColorToken, string> = {
  default: "#0f0f0f",
  dark: "#0a0b0c",
  error: "#1a0a0a",
  confirm: "#081208",
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

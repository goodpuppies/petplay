import type { NormalizedKeyFace } from "./types.ts";

export type KeyboardColorToken = NormalizedKeyFace["colorToken"];

/**
 * petplay uikit: maps keyboard `color` / `highlightColor` JSON tokens to webgpu-uikit `Container` colors.
 */
export const KEYBOARD_THEME = {
  default: {
    background: "#3d4f5f",
    border: "#1c2833",
  },
  dark: {
    background: "#2a3542",
    border: "#1a222c",
  },
  error: {
    background: "#8e2d1e",
    border: "#5c1a12",
  },
  confirm: {
    background: "#1e5c2e",
    border: "#12381c",
  },
} as const;

export const KEY_TEXT_COLORS: Record<KeyboardColorToken, string> = {
  default: "#e8f0f8",
  dark: "#dbe4ee",
  error: "#ffffff",
  confirm: "#ffffff",
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

export function tokenBackground(token: KeyboardColorToken): string {
  return KEYBOARD_THEME[token].background;
}

export function tokenBorderColor(token: KeyboardColorToken): string {
  return KEYBOARD_THEME[token].border;
}

export function keyTextColor(token: KeyboardColorToken): string {
  return KEY_TEXT_COLORS[token];
}

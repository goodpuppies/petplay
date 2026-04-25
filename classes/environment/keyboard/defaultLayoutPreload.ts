import type { KeyboardLayoutJson } from "./types.ts";
import { stripJsonComments } from "./parseJsonComments.ts";

/** Same file as [DEFAULT_KEYBOARD_JSON_URL](keyboardUi.tsx) (avoids loading uikit in this module). */
const DEFAULT_KEYBOARD_FILE = new URL("../../../resources/Keyboard.json", import.meta.url);

let cached: KeyboardLayoutJson | null = null;

export function isDefaultKeyboardLayoutUrl(url: URL): boolean {
  return url.href === DEFAULT_KEYBOARD_FILE.href;
}

/**
 * One sync `readTextFileSync` of the default layout (cached) so the first [KeyboardPanel](keyboard.tsx)
 * frame can render uikit + [GrabBox](../grabbox.tsx) together — no empty wireframe for ~half a
 * second while async `readTextFile` was resolving.
 */
export function getDefaultKeyboardLayoutSync(): KeyboardLayoutJson {
  if (cached) return cached;
  const text = Deno.readTextFileSync(DEFAULT_KEYBOARD_FILE);
  cached = JSON.parse(stripJsonComments(text)) as KeyboardLayoutJson;
  return cached;
}

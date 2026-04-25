/**
 * One-shot: release “stuck” keys after [SendInput] / VR keyboard tests (Windows).
 * Uses the same pass as app shutdown in [win32SystemKeyboard](classes/environment/keyboard/win32SystemKeyboard.ts).
 */
import { releaseWindowsSyntheticKeyboardState } from "../classes/environment/keyboard/win32SystemKeyboard.ts";

if (import.meta.main) {
  if (Deno.build.os !== "windows") {
    console.log("resetKeyboard: only needed on Windows (no-op on this OS).");
    Deno.exit(0);
  }
  await releaseWindowsSyntheticKeyboardState();
  console.log("resetKeyboard: sent key-up for any held keys (per GetAsyncKeyState).");
}

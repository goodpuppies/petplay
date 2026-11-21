import { assertEquals } from "jsr:@std/assert";
import { focusedKeyboard, focusKeyboard, releaseKeyboard } from "./keyboardFocus.ts";
import type { KeyboardSink } from "./types.ts";

Deno.test("the keyboard follows the display clicked last, and returns when it goes", () => {
  const typed: string[] = [];
  const sink = (name: string): KeyboardSink => () => void typed.push(name);
  const keyboard = focusedKeyboard(sink("local"));
  const key = { kind: "key", scanCodeHex: "1E" } as Parameters<KeyboardSink>[0];

  keyboard(key);
  focusKeyboard("display-remote", sink("cachyos"));
  keyboard(key);
  // Another display's release does not take the focus.
  releaseKeyboard("display-other");
  keyboard(key);
  // Clicking a local display gives it back.
  focusKeyboard("display-local", null);
  keyboard(key);
  focusKeyboard("display-remote", sink("cachyos"));
  releaseKeyboard("display-remote");
  keyboard(key);

  assertEquals(typed, ["local", "cachyos", "cachyos", "local", "local"]);
});

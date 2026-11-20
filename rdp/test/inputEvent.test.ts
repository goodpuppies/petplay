import { assertEquals } from "jsr:@std/assert";
import {
  fromKeyboardLogicEvent,
  isInputEvent,
  toKeyboardLogicEvent,
} from "../classes/input/inputEvent.ts";
import type { KeyboardLogicEvent } from "../../classes/environment/keyboard/types.ts";

Deno.test("the VR keyboard's events survive the trip through InputEvent", () => {
  const events: KeyboardLogicEvent[] = [
    { kind: "key", scanCode: 0x2d, scanCodeHex: "2D", char: "x" },
    { kind: "key", pressed: true, scanCode: 0xe01d, scanCodeHex: "E01D" },
    { kind: "key", pressed: false, scanCode: 0, scanCodeHex: "00", virtualKeyName: "F1" },
    { kind: "modifier", modifier: "leftAlt", active: true },
  ];
  for (const event of events) {
    const input = fromKeyboardLogicEvent(event);
    assertEquals(isInputEvent(input), true, JSON.stringify(event));
    assertEquals(toKeyboardLogicEvent(input as never), event);
  }
});

Deno.test("malformed input events are rejected", () => {
  for (
    const bad of [
      { t: "key", scan: "1e; rm" },
      { t: "key" },
      { t: "key", key: "F1 F2" },
      { t: "button", button: "back", down: true },
      { t: "button", button: "left", down: true, x: 0.5 },
      { t: "wheel", delta: 1e9 },
      { t: "pointer", x: Number.NaN, y: 0 },
      { t: "modifier", modifier: "hyper", active: true },
      null,
    ]
  ) assertEquals(isInputEvent(bad), false, JSON.stringify(bad));
});

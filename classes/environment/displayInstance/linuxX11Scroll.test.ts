import { assertEquals } from "@std/assert";
import { sendX11Wheel, type X11WheelConnection } from "./linuxX11Scroll.ts";

Deno.test("X11 wheel fallback sends complete discrete clicks with matching direction", () => {
  const events: unknown[] = [];
  const connection: X11WheelConnection = {
    pointerWindowAt: (x, y) => x === 0.25 && y === 0.5,
    button: (button, down) => events.push([button, down]),
    flush: () => events.push("flush"),
  };
  assertEquals(sendX11Wheel(connection, -2, 0.25, 0.5), true);
  assertEquals(events, [[4, true], [4, false], [4, true], [4, false], "flush"]);
  events.length = 0;
  assertEquals(sendX11Wheel(connection, 1, 0.25, 0.5), true);
  assertEquals(events, [[5, true], [5, false], "flush"]);
});

Deno.test("Wayland targets and stale cursor positions retain uinput scrolling", () => {
  let buttons = 0;
  const connection: X11WheelConnection = {
    pointerWindowAt: () => false,
    button: () => buttons++,
    flush: () => {},
  };
  assertEquals(sendX11Wheel(connection, 1, 0.5, 0.5), false);
  assertEquals(sendX11Wheel(null, 1, 0.5, 0.5), false);
  assertEquals(buttons, 0);
});

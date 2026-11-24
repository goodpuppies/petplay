import { assertEquals } from "@std/assert";
import { createDesktopInputRouting } from "./desktopKeyboardRouting.ts";
import { KeyRepeat } from "./keyRepeat.ts";
import { KeyHold } from "./keyHold.ts";
import { createLinuxKeyboardSink } from "./linuxSystemKeyboard.ts";
import type { KeyboardLogicEvent } from "./types.ts";

const w: KeyboardLogicEvent & { kind: "key" } = {
  kind: "key",
  scanCode: 0x11,
  scanCodeHex: "11",
  char: "w",
};
function fixture() {
  const commands: string[] = [];
  const routing = createDesktopInputRouting(
    () => {},
    createLinuxKeyboardSink((s) => commands.push(...s.split("\n"))),
  );
  const hold = new KeyHold((phase) => routing.onKey({ ...w, pressed: phase !== "up" }));
  const right = (pressed: boolean) =>
    routing.onMouse({ kind: "button", button: "right", pressed, x: 0.5, y: 0.5 });
  return { ...routing, commands, hold, right };
}

Deno.test("ordinary typing releases immediately even if its scene key-up is delayed", () => {
  const { commands, hold } = fixture();
  hold.down(1);
  assertEquals(commands, ["K,11,1", "K,11,0"]);
  hold.up(1);
  assertEquals(commands, ["K,11,1", "K,11,0"]);
});

Deno.test("right-click navigation preserves holds until key-up even after mouse-up", () => {
  const { commands, hold, right } = fixture();
  right(true);
  hold.down(1);
  assertEquals(commands, ["K,11,1"]);
  right(false);
  hold.up(1);
  assertEquals(commands, ["K,11,1", "K,11,0"]);
});

Deno.test("press mode is fixed until release, even if mouse navigation begins mid-key", () => {
  const { commands, hold, right } = fixture();
  hold.down(1);
  right(true);
  hold.repeat();
  hold.up(1);
  assertEquals(commands, ["K,11,1", "K,11,0", "K,11,1", "K,11,0"]);
});

Deno.test("a long stalled frame cannot fire stale text repeats or catch-up bursts", () => {
  let now = 0;
  const repeat = new KeyRepeat(() => now);
  const { commands, hold } = fixture();
  hold.down(1);
  repeat.tick();
  repeat.start(hold, () => hold.repeat());
  for (now = 16; now < 420; now += 16) repeat.tick();
  now = 2000; // delayed input release has not been processed yet
  repeat.tick();
  assertEquals(commands, ["K,11,1", "K,11,0"]);
  hold.up(1);
  repeat.stop(hold);
  now = 2200;
  repeat.tick();
  assertEquals(commands, ["K,11,1", "K,11,0"]);
});

Deno.test("an intentional hold repeats once per fresh interval and cancellation stops it", () => {
  let now = 0;
  let count = 0;
  const repeat = new KeyRepeat(() => now);
  const key = {};
  repeat.tick();
  repeat.start(key, () => count++);
  for (now = 20; now <= 420; now += 20) repeat.tick();
  assertEquals(count, 1);
  now = 460;
  repeat.tick();
  assertEquals(count, 1);
  now = 480;
  repeat.tick();
  assertEquals(count, 2);
  repeat.stop(key);
  now = 540;
  repeat.tick();
  assertEquals(count, 2);
});

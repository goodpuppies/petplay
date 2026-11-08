import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { KeyHold, type KeyPhase } from "./keyHold.ts";
import { createLinuxKeyboardSink } from "./linuxSystemKeyboard.ts";
import { dispatchWindowsKeyboardEvent } from "./win32SystemKeyboard.ts";
import type { KeyboardLogicEvent } from "./types.ts";

const w: KeyboardLogicEvent & { kind: "key" } = {
  kind: "key",
  scanCode: 0x11,
  scanCodeHex: "11",
  char: "w",
};

Deno.test("a held W stays down across repeats and releases exactly once", () => {
  const commands: string[] = [];
  const sink = createLinuxKeyboardSink((command) => commands.push(...command.split("\n")));
  const hold = new KeyHold((phase) => sink({ ...w, pressed: phase !== "up" }));
  hold.down(1);
  hold.repeat();
  hold.repeat();
  assertEquals(commands, ["K,11,1", "K,11,1", "K,11,1"]);
  hold.up(1);
  hold.repeat();
  hold.up(1);
  hold.releaseAll();
  assertEquals(commands, ["K,11,1", "K,11,1", "K,11,1", "K,11,0"]);
});

Deno.test("two pointers on one cap share a hold and cancellation releases it", () => {
  const phases: KeyPhase[] = [];
  const hold = new KeyHold((phase) => phases.push(phase));
  assertEquals(hold.down(1), true);
  assertEquals(hold.down(1), false);
  assertEquals(hold.down(2), false);
  assertEquals(hold.up(1), false);
  assertEquals(phases, ["down"]);
  hold.releaseAll();
  hold.up(2);
  assertEquals(phases, ["down", "up"]);
});

Deno.test("simultaneous movement keys release independently", () => {
  const commands: string[] = [];
  const sink = createLinuxKeyboardSink((command) => commands.push(...command.split("\n")));
  const wHold = new KeyHold((phase) => sink({ ...w, pressed: phase !== "up" }));
  const dHold = new KeyHold((phase) => sink({ ...w, scanCodeHex: "20", pressed: phase !== "up" }));
  wHold.down(1);
  dHold.down(2);
  wHold.up(1);
  dHold.up(2);
  assertEquals(commands, ["K,11,1", "K,20,1", "K,11,0", "K,20,0"]);
});

Deno.test("Linux keeps legacy taps, modifier holds and extended numpad keys", () => {
  const commands: string[] = [];
  const sink = createLinuxKeyboardSink((command) => commands.push(...command.split("\n")));
  sink(w);
  sink({ kind: "modifier", modifier: "rightAlt", active: true });
  sink({ ...w, scanCodeHex: "00", virtualKeyName: "RETURN", pressed: true });
  sink({ ...w, scanCodeHex: "00", virtualKeyName: "RETURN", pressed: false });
  sink({ kind: "modifier", modifier: "rightAlt", active: false });
  assertEquals(commands, ["K,11,1", "K,11,0", "K,E038,1", "K,E01C,1", "K,E01C,0", "K,E038,0"]);
});

Deno.test("Windows sends separate scan downs and ups and preserves legacy taps", () => {
  const events: { vk: number; scan: number; flags: number }[] = [];
  const km = {
    INPUT_KEYBOARD: 1,
    KEYEVENTF_EXTENDEDKEY: 1,
    KEYEVENTF_KEYUP: 2,
    KEYEVENTF_SCANCODE: 8,
    SendInput(count: number, buffer: Uint8Array, size: number) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      for (let i = 0; i < count; i++) {
        events.push({
          vk: view.getUint16(i * size + 8, true),
          scan: view.getUint16(i * size + 10, true),
          flags: view.getUint32(i * size + 12, true),
        });
      }
      return count;
    },
  } as unknown as Parameters<typeof dispatchWindowsKeyboardEvent>[0];
  dispatchWindowsKeyboardEvent(km, { ...w, pressed: true });
  assertEquals(events, [{ vk: 0, scan: 0x11, flags: 8 }]);
  dispatchWindowsKeyboardEvent(km, { ...w, pressed: false });
  dispatchWindowsKeyboardEvent(km, { ...w, scanCodeHex: "E01C", pressed: true });
  dispatchWindowsKeyboardEvent(km, { ...w, scanCodeHex: "E01C", pressed: false });
  dispatchWindowsKeyboardEvent(km, w);
  assertEquals(events.map((event) => [event.scan, event.flags]), [
    [0x11, 8],
    [0x11, 10],
    [0x1c, 9],
    [0x1c, 11],
    [0x11, 8],
    [0x11, 10],
  ]);
});

Deno.test("a Linux typing tap uses a single transport write with ordered down and up", () => {
  const writes: string[] = [];
  const sink = createLinuxKeyboardSink((command) => writes.push(command));
  sink(w);
  assertEquals(writes, ["K,11,1\nK,11,0"]);
});

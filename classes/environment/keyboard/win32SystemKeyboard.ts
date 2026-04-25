import type { KeyboardLogicEvent, KeyboardSink } from "./types.ts";

/**
 * `sizeof(INPUT)` for `SendInput` (must match the C layout).
 * x64: union is 32B (max of `MOUSEINPUT`) + 4B type + 4B pad = 40.
 * x86: 28. Wrong size returns 0 from `SendInput` (e.g. error 87).
 */
function sizeofInputForSendInput(): number {
  if (Deno.build.os !== "windows") {
    return 40;
  }
  const arch = Deno.build.arch as string;
  return arch === "x86" ? 28 : 40;
}

type Win32Km = typeof import("@win32/km");

const win32Km: Promise<Win32Km | null> = Deno.build.os === "windows"
  ? import("@win32/km")
  : Promise.resolve(null);

/**
 * Parse layout hex (`1D`, `E01D`, …) into low make-code + extended (E0/E1 prefix).
 */
export function parseLayoutScanHex(hex: string): { lowScan: number; extended: boolean } {
  const h = hex.toUpperCase().replace(/^0X/i, "");
  if (h.length <= 2) {
    return { lowScan: parseInt(h, 16) & 0xff, extended: false };
  }
  if ((h.startsWith("E0") || h.startsWith("E1")) && h.length >= 4) {
    return { lowScan: parseInt(h.slice(2), 16) & 0xff, extended: true };
  }
  const n = parseInt(h, 16);
  return { lowScan: n & 0xff, extended: false };
}

function packInputKeyboard(
  km: Win32Km,
  wVk: number,
  wScan: number,
  dwFlags: number,
): Uint8Array {
  const n = sizeofInputForSendInput();
  const buf = new Uint8Array(n);
  const v = new DataView(buf.buffer);
  v.setUint32(0, km.INPUT_KEYBOARD, true);
  // `KEYBDINPUT` begins at offset 8 inside `INPUT` (x64: union is 32B).
  v.setUint16(8, wVk, true);
  v.setUint16(10, wScan, true);
  v.setUint32(12, dwFlags, true);
  v.setUint32(16, 0, true);
  if (n === 40) {
    v.setBigUint64(24, 0n, true);
  } else {
    // x86: `ULONG_PTR` is 4 bytes; `KEYBDINPUT` ends with `dwExtraInfo` at offset 20 from `INPUT` base.
    v.setUint32(20, 0, true);
  }
  return buf;
}

function sendInputs(km: Win32Km, inputs: Uint8Array, nInputs: number): void {
  const sz = sizeofInputForSendInput();
  const sent = km.SendInput(nInputs, inputs, sz);
  if (sent !== nInputs) {
    console.warn(
      `[win32 keyboard] SendInput inserted ${sent}/${nInputs} (cbSize=${sz}; other causes: UIPI, focus, BlockInput)`,
    );
  }
}

function sendKeyTapVk(km: Win32Km, vk: number): void {
  const sz = sizeofInputForSendInput();
  const down = packInputKeyboard(km, vk, 0, 0);
  const up = packInputKeyboard(km, vk, 0, km.KEYEVENTF_KEYUP);
  const both = new Uint8Array(sz * 2);
  both.set(down, 0);
  both.set(up, sz);
  sendInputs(km, both, 2);
}

function sendKeyTapScan(km: Win32Km, lowScan: number, extended: boolean): void {
  const sz = sizeofInputForSendInput();
  const base = km.KEYEVENTF_SCANCODE | (extended ? km.KEYEVENTF_EXTENDEDKEY : 0);
  const down = packInputKeyboard(km, 0, lowScan, base);
  const up = packInputKeyboard(km, 0, lowScan, base | km.KEYEVENTF_KEYUP);
  const both = new Uint8Array(sz * 2);
  both.set(down, 0);
  both.set(up, sz);
  sendInputs(km, both, 2);
}

function modifierToVk(
  km: Win32Km,
  m: KeyboardLogicEvent & { kind: "modifier" },
): number | null {
  switch (m.modifier) {
    case "shift":
      return km.VK_LSHIFT;
    case "leftCtrl":
      return km.VK_LCONTROL;
    case "rightCtrl":
      return km.VK_RCONTROL;
    case "leftAlt":
      return km.VK_LMENU;
    case "rightAlt":
      return km.VK_RMENU;
    case "leftMeta":
      return km.VK_LWIN;
    case "rightMeta":
      return km.VK_RWIN;
    case "caps":
      return null;
  }
}

function sendModifierHold(km: Win32Km, vk: number, down: boolean): void {
  const flags = down ? 0 : km.KEYEVENTF_KEYUP;
  const one = packInputKeyboard(km, vk, 0, flags);
  sendInputs(km, one, 1);
}

function resolveVirtualVk(km: Win32Km, virtualKeyName?: string, char?: string): number | null {
  if (virtualKeyName) {
    const u = virtualKeyName.toUpperCase();
    const table: Record<string, number> = {
      BACK: km.VK_BACK,
      TAB: km.VK_TAB,
      RETURN: km.VK_RETURN,
      ENTER: km.VK_RETURN,
      ESCAPE: km.VK_ESCAPE,
      ESC: km.VK_ESCAPE,
      SPACE: km.VK_SPACE,
      PAGEUP: km.VK_PRIOR,
      PAGEDOWN: km.VK_NEXT,
      INSERT: km.VK_INSERT,
      DELETE: km.VK_DELETE,
      HOME: km.VK_HOME,
      END: km.VK_END,
      PAUSE: km.VK_PAUSE,
      CAPSLOCK: km.VK_CAPITAL,
      SCROLL: km.VK_SCROLL,
      NUMLOCK: km.VK_NUMLOCK,
      SNAPSHOT: km.VK_SNAPSHOT,
      "PRINT SCREEN": km.VK_SNAPSHOT,
      "PRT SC": km.VK_SNAPSHOT,
      "PRTSCN": km.VK_SNAPSHOT,
      "LEFT ARROW": km.VK_LEFT,
      "UP ARROW": km.VK_UP,
      "RIGHT ARROW": km.VK_RIGHT,
      "DOWN ARROW": km.VK_DOWN,
    };
    const t = table[u];
    if (t != null) return t;
    const f = u.match(/^F(1[0-2]|[1-9])$/);
    if (f) {
      const n = parseInt(f[1]!, 10);
      if (n >= 1 && n <= 12) return km.VK_F1 + (n - 1);
    }
  }
  if (char && char.length === 1) {
    const c = char.toUpperCase();
    const code = c.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) return code;
    if (code >= 0x41 && code <= 0x5a) return code;
  }
  return null;
}

function dispatch(km: Win32Km, ev: KeyboardLogicEvent): void {
  if (ev.kind === "modifier") {
    if (ev.modifier === "caps") return;
    const vk = modifierToVk(km, ev);
    if (vk == null) return;
    sendModifierHold(km, vk, ev.active);
    return;
  }

  if (ev.scanCodeHex && ev.scanCodeHex !== "00") {
    const { lowScan, extended } = parseLayoutScanHex(ev.scanCodeHex);
    sendKeyTapScan(km, lowScan, extended);
    return;
  }
  const vkDirect = resolveVirtualVk(km, ev.virtualKeyName, ev.char);
  if (vkDirect != null) {
    sendKeyTapVk(km, vkDirect);
  }
}

const ASYNC_KEY_DOWN = 0x8000;

function sendKeyUpIfDown(km: Win32Km, vk: number, sz: number): void {
  if ((km.GetAsyncKeyState(vk) & ASYNC_KEY_DOWN) === 0) return;
  const one = packInputKeyboard(km, vk, 0, km.KEYEVENTF_KEYUP);
  km.SendInput(1, one, sz);
}

/**
 * After closing a viewer that used [SendInput], release keys the OS still
 * considers held (latched shift, or half-finished tap). Safe to call multiple
 * times. No-op on non-Windows.
 */
export function releaseWindowsSyntheticKeyboardStateWithKm(km: Win32Km): void {
  const sz = sizeofInputForSendInput();
  // Skip mouse buttons (1–7), caps/num/scroll lock toggles (odd keyup behavior).
  for (let vk = 0x08; vk <= 0xfe; vk++) {
    if (vk === 0x14 || vk === 0x90 || vk === 0x91) continue;
    sendKeyUpIfDown(km, vk, sz);
  }
}

/**
 * Await the Win32 module and run [releaseWindowsSyntheticKeyboardStateWithKm].
 */
export async function releaseWindowsSyntheticKeyboardState(): Promise<void> {
  if (Deno.build.os !== "windows") {
    return;
  }
  const km = await win32Km;
  if (km) {
    releaseWindowsSyntheticKeyboardStateWithKm(km);
  }
}

/**
 * `SendInput` keyboard injection on Windows. No-op on other OS.
 * On Windows, `SendInput` may insert fewer than requested under UIPI (e.g. into elevated apps).
 */
export function createWindowsSystemKeyboardSink(): KeyboardSink {
  if (Deno.build.os !== "windows") {
    return () => {};
  }
  return (ev) => {
    void win32Km.then((km) => {
      if (km) dispatch(km, ev);
    });
  };
}

/**
 * One shared [KeyboardSink] for [KeyboardPanel] `onKey` — stable across re-renders;
 * on non-Windows it is a no-op.
 */
export const windowsSystemKeyboardSink: KeyboardSink = createWindowsSystemKeyboardSink();

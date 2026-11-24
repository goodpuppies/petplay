/**
 * The slice of Win32 keyboard/mouse input PetPlay uses (`SendInput`, `GetAsyncKeyState` and their
 * constants). Replaces the raw-GitHub import of deno_win32's `UI/Input/KeyboardAndMouse.ts`; values
 * and signatures are copied from it. user32.dll opens on first call, so importing this module is
 * safe on other platforms.
 */

let user32: Deno.DynamicLibrary<{
  SendInput: { parameters: ["u32", "pointer", "i32"]; result: "u32" };
  GetAsyncKeyState: { parameters: ["i32"]; result: "i16" };
}> | null = null;

function lib() {
  return user32 ??= Deno.dlopen("USER32.dll", {
    SendInput: { parameters: ["u32", "pointer", "i32"], result: "u32" },
    GetAsyncKeyState: { parameters: ["i32"], result: "i16" },
  });
}

/** Injects `cInputs` packed `INPUT` structures of `cbSize` bytes each; returns how many went in. */
export function SendInput(
  cInputs: number,
  pInputs: Deno.PointerValue | Uint8Array,
  cbSize: number,
): number {
  const pointer = pInputs instanceof Uint8Array ? Deno.UnsafePointer.of(pInputs as Uint8Array<ArrayBuffer>)
    : pInputs;
  return lib().symbols.SendInput(cInputs, pointer, cbSize);
}

/** High bit set: the key is down now. */
export function GetAsyncKeyState(vKey: number): number {
  return lib().symbols.GetAsyncKeyState(vKey);
}

export const INPUT_KEYBOARD = 1;
export const INPUT_MOUSE = 0;
export const KEYEVENTF_EXTENDEDKEY = 1;
export const KEYEVENTF_KEYUP = 2;
export const KEYEVENTF_SCANCODE = 8;
export const MOUSEEVENTF_ABSOLUTE = 32768;
export const MOUSEEVENTF_LEFTDOWN = 2;
export const MOUSEEVENTF_LEFTUP = 4;
export const MOUSEEVENTF_MIDDLEDOWN = 32;
export const MOUSEEVENTF_MIDDLEUP = 64;
export const MOUSEEVENTF_MOVE = 1;
export const MOUSEEVENTF_RIGHTDOWN = 8;
export const MOUSEEVENTF_RIGHTUP = 16;
export const MOUSEEVENTF_VIRTUALDESK = 16384;
export const MOUSEEVENTF_WHEEL = 2048;
export const VK_BACK = 8;
export const VK_CAPITAL = 20;
export const VK_DELETE = 46;
export const VK_DOWN = 40;
export const VK_END = 35;
export const VK_ESCAPE = 27;
export const VK_F1 = 112;
export const VK_HOME = 36;
export const VK_INSERT = 45;
export const VK_LBUTTON = 1;
export const VK_LCONTROL = 162;
export const VK_LEFT = 37;
export const VK_LMENU = 164;
export const VK_LSHIFT = 160;
export const VK_LWIN = 91;
export const VK_MBUTTON = 4;
export const VK_NEXT = 34;
export const VK_NUMLOCK = 144;
export const VK_PAUSE = 19;
export const VK_PRIOR = 33;
export const VK_RBUTTON = 2;
export const VK_RCONTROL = 163;
export const VK_RETURN = 13;
export const VK_RIGHT = 39;
export const VK_RMENU = 165;
export const VK_RWIN = 92;
export const VK_SCROLL = 145;
export const VK_SNAPSHOT = 44;
export const VK_SPACE = 32;
export const VK_TAB = 9;
export const VK_UP = 38;

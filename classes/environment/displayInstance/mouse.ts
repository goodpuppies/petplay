export type DisplayMouseButton = "left" | "middle" | "right";

export type DisplayMouseLogicEvent = {
  kind: "move";
  /** Horizontal position across the display, clamped to 0..1. */
  x: number;
  /** Vertical position down the display, clamped to 0..1. */
  y: number;
} | {
  kind: "button";
  button: DisplayMouseButton;
  pressed: boolean;
  /** Horizontal position across the display, clamped to 0..1. */
  x: number;
  /** Vertical position down the display, clamped to 0..1. */
  y: number;
};

export type DisplayMouseSink = (event: DisplayMouseLogicEvent) => void;

type Win32Km = typeof import("@win32/km");

const win32Km: Promise<Win32Km | null> = Deno.build.os === "windows"
  ? import("@win32/km")
  : Promise.resolve(null);

type User32 = Deno.DynamicLibrary<{
  GetSystemMetrics: {
    parameters: ["i32"];
    result: "i32";
  };
}>;

let user32: User32 | null | undefined;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

function sizeofInputForSendInput(): number {
  if (Deno.build.os !== "windows") {
    return 40;
  }
  const arch = Deno.build.arch as string;
  return arch === "x86" ? 28 : 40;
}

function getUser32(): User32 | null {
  if (user32 !== undefined) {
    return user32;
  }
  if (Deno.build.os !== "windows") {
    user32 = null;
    return user32;
  }
  user32 = Deno.dlopen("user32.dll", {
    GetSystemMetrics: { parameters: ["i32"], result: "i32" },
  });
  return user32;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function getVirtualScreenRect(): { x: number; y: number; width: number; height: number } {
  const u32 = getUser32();
  if (u32 == null) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const width = Math.max(1, u32.symbols.GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const height = Math.max(1, u32.symbols.GetSystemMetrics(SM_CYVIRTUALSCREEN));
  return {
    x: u32.symbols.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: u32.symbols.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width,
    height,
  };
}

function toAbsoluteMouseCoordinate(pixel: number, origin: number, size: number): number {
  if (size <= 1) return 0;
  return Math.round(((pixel - origin) * 65535) / (size - 1));
}

function packInputMouse(
  km: Win32Km,
  dx: number,
  dy: number,
  mouseData: number,
  dwFlags: number,
): Uint8Array {
  const n = sizeofInputForSendInput();
  const buf = new Uint8Array(n);
  const v = new DataView(buf.buffer);
  v.setUint32(0, km.INPUT_MOUSE, true);
  // `MOUSEINPUT` begins at offset 8 inside `INPUT` on both x86/x64.
  v.setInt32(8, dx, true);
  v.setInt32(12, dy, true);
  v.setUint32(16, mouseData, true);
  v.setUint32(20, dwFlags, true);
  v.setUint32(24, 0, true);
  if (n === 40) {
    v.setBigUint64(32, 0n, true);
  }
  return buf;
}

function sendInput(km: Win32Km, input: Uint8Array): void {
  const sent = km.SendInput(1, input, sizeofInputForSendInput());
  if (sent !== 1) {
    console.warn("[win32 display mouse] SendInput inserted 0/1");
  }
}

function sendButtonUp(km: Win32Km, button: DisplayMouseButton): void {
  sendInput(km, packInputMouse(km, 0, 0, 0, mouseButtonFlags(km, button, false)));
}

function mouseButtonFlags(km: Win32Km, button: DisplayMouseButton, pressed: boolean): number {
  switch (button) {
    case "left":
      return pressed ? km.MOUSEEVENTF_LEFTDOWN : km.MOUSEEVENTF_LEFTUP;
    case "middle":
      return pressed ? km.MOUSEEVENTF_MIDDLEDOWN : km.MOUSEEVENTF_MIDDLEUP;
    case "right":
      return pressed ? km.MOUSEEVENTF_RIGHTDOWN : km.MOUSEEVENTF_RIGHTUP;
  }
}

const ASYNC_KEY_DOWN = 0x8000;

function releaseMouseButtonIfDown(km: Win32Km, vk: number, button: DisplayMouseButton): void {
  if ((km.GetAsyncKeyState(vk) & ASYNC_KEY_DOWN) === 0) return;
  sendButtonUp(km, button);
}

export function releaseWindowsSyntheticDisplayMouseStateWithKm(km: Win32Km): void {
  releaseMouseButtonIfDown(km, km.VK_LBUTTON, "left");
  releaseMouseButtonIfDown(km, km.VK_MBUTTON, "middle");
  releaseMouseButtonIfDown(km, km.VK_RBUTTON, "right");
}

export async function releaseWindowsSyntheticDisplayMouseState(): Promise<void> {
  if (Deno.build.os !== "windows") {
    return;
  }
  const km = await win32Km;
  if (km) {
    releaseWindowsSyntheticDisplayMouseStateWithKm(km);
  }
}

function dispatch(km: Win32Km, ev: DisplayMouseLogicEvent): void {
  const rect = getVirtualScreenRect();
  const px = rect.x + clamp01(ev.x) * (rect.width - 1);
  const py = rect.y + clamp01(ev.y) * (rect.height - 1);
  const ax = toAbsoluteMouseCoordinate(px, rect.x, rect.width);
  const ay = toAbsoluteMouseCoordinate(py, rect.y, rect.height);
  let flags = km.MOUSEEVENTF_ABSOLUTE | km.MOUSEEVENTF_VIRTUALDESK | km.MOUSEEVENTF_MOVE;
  if (ev.kind === "button") {
    flags |= mouseButtonFlags(km, ev.button, ev.pressed);
  }
  sendInput(km, packInputMouse(km, ax, ay, 0, flags));
}

export function createWindowsSystemDisplayMouseSink(): DisplayMouseSink {
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
 * One shared [DisplayMouseSink] for [DisplayInstance] `onMouse` — stable across re-renders;
 * on non-Windows it is a no-op.
 */
export const windowsSystemDisplayMouseSink: DisplayMouseSink =
  createWindowsSystemDisplayMouseSink();

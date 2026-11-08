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
} | {
  kind: "wheel";
  deltaY: number;
  x: number;
  y: number;
};

export type DisplayMouseSink = (event: DisplayMouseLogicEvent) => void;

export type DisplayMouseSmoothingOptions = {
  /** Raw distance that is treated as controller/ray jitter. */
  deadZone?: number;
  /** EMA weight for ordinary motion. Lower values are smoother. */
  baseAlpha?: number;
  /** Motion distance at which filtering is bypassed. */
  snapDistance?: number;
  /** Avoid emitting sub-pixel-scale changes after filtering. */
  minimumOutputDistance?: number;
  /** Minimum time between synthetic move events. */
  minimumMoveIntervalMs?: number;
  /** Injectable monotonic clock for deterministic tests. */
  now?: () => number;
};

/**
 * Smooth normalized display motion without delaying button transitions. Button
 * events snap the pointer to their raw coordinates so click targets stay exact.
 */
export function createSmoothedDisplayMouseSink(
  sink: DisplayMouseSink,
  options: DisplayMouseSmoothingOptions = {},
): DisplayMouseSink {
  const deadZone = options.deadZone ?? 0.001;
  // Match WayVR's pointer smoothing and 100 Hz mouse-output cadence.
  const baseAlpha = options.baseAlpha ?? 0.3;
  const snapDistance = options.snapDistance ?? 0.08;
  const minimumOutputDistance = options.minimumOutputDistance ?? 0.00025;
  const minimumMoveIntervalMs = options.minimumMoveIntervalMs ?? 10;
  const now = options.now ?? performance.now.bind(performance);
  let filtered: { x: number; y: number } | null = null;
  let emitted: { x: number; y: number } | null = null;
  let lastMoveEmittedAt = Number.NEGATIVE_INFINITY;

  return (event) => {
    if (event.kind === "wheel") {
      sink(event);
      return;
    }
    if (event.kind === "button") {
      filtered = { x: event.x, y: event.y };
      emitted = { ...filtered };
      sink(event);
      return;
    }

    if (filtered == null) {
      filtered = { x: event.x, y: event.y };
      emitted = { ...filtered };
      lastMoveEmittedAt = now();
      sink(event);
      return;
    }

    const dx = event.x - filtered.x;
    const dy = event.y - filtered.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= deadZone) return;

    if (distance >= snapDistance) {
      filtered = { x: event.x, y: event.y };
    } else {
      filtered = {
        x: filtered.x + dx * baseAlpha,
        y: filtered.y + dy * baseAlpha,
      };
    }

    if (
      emitted != null &&
      Math.hypot(filtered.x - emitted.x, filtered.y - emitted.y) < minimumOutputDistance
    ) return;
    const moveAt = now();
    if (moveAt - lastMoveEmittedAt < minimumMoveIntervalMs) return;
    emitted = { ...filtered };
    lastMoveEmittedAt = moveAt;
    sink({ kind: "move", ...filtered });
  };
}

const diagnostics = {
  events: 0,
  moves: 0,
  buttonDowns: 0,
  buttonUps: 0,
  sendInputCalls: 0,
  sendInputFailures: 0,
  lastCursorPosition: null as { x: number; y: number } | null,
  lastEvent: null as DisplayMouseLogicEvent | null,
};

export function getDisplayMouseDiagnostics() {
  return { ...diagnostics };
}

type Win32Km = typeof import("@win32/km");

const win32Km: Promise<Win32Km | null> = Deno.build.os === "windows"
  ? import("@win32/km")
  : Promise.resolve(null);

type User32 = Deno.DynamicLibrary<{
  GetCursorPos: {
    parameters: ["pointer"];
    result: "bool";
  };
}>;

let user32: User32 | null | undefined;

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
    GetCursorPos: { parameters: ["pointer"], result: "bool" },
  });
  return user32;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
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
  diagnostics.sendInputCalls++;
  if (sent !== 1) {
    diagnostics.sendInputFailures++;
    console.warn("[win32 display mouse] SendInput inserted 0/1");
  }
  const u32 = getUser32();
  if (u32 != null) {
    const point = new Int32Array(2);
    const ptr = Deno.UnsafePointer.of(point);
    if (ptr && u32.symbols.GetCursorPos(ptr)) {
      diagnostics.lastCursorPosition = { x: point[0]!, y: point[1]! };
    }
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
  // The event's 0..1 coordinates span the stitched desktop, as this flag's 0..65535 range does.
  const ax = Math.round(clamp01(ev.x) * 65535);
  const ay = Math.round(clamp01(ev.y) * 65535);
  let flags = km.MOUSEEVENTF_ABSOLUTE | km.MOUSEEVENTF_MOVE | km.MOUSEEVENTF_VIRTUALDESK;
  let mouseData = 0;
  if (ev.kind === "button") {
    flags |= mouseButtonFlags(km, ev.button, ev.pressed);
  } else if (ev.kind === "wheel") {
    flags |= km.MOUSEEVENTF_WHEEL;
    mouseData = Math.round(-ev.deltaY * 120);
  }
  sendInput(km, packInputMouse(km, ax, ay, mouseData, flags));
}

export function createWindowsSystemDisplayMouseSink(): DisplayMouseSink {
  if (Deno.build.os !== "windows") {
    return () => {};
  }
  return (ev) => {
    diagnostics.events++;
    diagnostics.lastEvent = ev;
    if (ev.kind === "move") {
      diagnostics.moves++;
    } else if (ev.kind === "button" && ev.pressed) {
      diagnostics.buttonDowns++;
    } else if (ev.kind === "button") {
      diagnostics.buttonUps++;
    }
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

/** Optional discrete-wheel compatibility for X11/Xwayland applications. */
export type X11WheelConnection = {
  pointerWindowAt(x: number, y: number): boolean;
  button(button: number, down: boolean): void;
  flush(): void;
};

export function sendX11Wheel(
  connection: X11WheelConnection | null,
  deltaY: number,
  x: number,
  y: number,
): boolean {
  if (!connection || !Number.isSafeInteger(deltaY) || deltaY === 0) return false;
  if (!connection.pointerWindowAt(x, y)) return false;
  const button = deltaY < 0 ? 4 : 5;
  // Each notch is a complete button click, as on a traditional X11 wheel.
  for (let i = 0; i < Math.abs(deltaY); i++) {
    connection.button(button, true);
    connection.button(button, false);
  }
  connection.flush();
  return true;
}

function openX11Wheel(): X11WheelConnection | null {
  if (Deno.build.os !== "linux" || !Deno.env.get("DISPLAY")) return null;
  let close: (() => void) | undefined;
  try {
    const x11 = Deno.dlopen("libX11.so.6", {
      XOpenDisplay: { parameters: ["pointer"], result: "pointer" },
      XCloseDisplay: { parameters: ["pointer"], result: "i32" },
      XDefaultScreen: { parameters: ["pointer"], result: "i32" },
      XDefaultRootWindow: { parameters: ["pointer"], result: "usize" },
      XDisplayWidth: { parameters: ["pointer", "i32"], result: "i32" },
      XDisplayHeight: { parameters: ["pointer", "i32"], result: "i32" },
      XQueryPointer: {
        parameters: [
          "pointer",
          "usize",
          "buffer",
          "buffer",
          "buffer",
          "buffer",
          "buffer",
          "buffer",
          "buffer",
        ],
        result: "i32",
      },
      XFlush: { parameters: ["pointer"], result: "i32" },
    });
    close = () => x11.close();
    const display = x11.symbols.XOpenDisplay(null);
    if (!display) {
      close();
      return null;
    }
    close = () => {
      x11.symbols.XCloseDisplay(display);
      x11.close();
    };
    const xtest = Deno.dlopen("libXtst.so.6", {
      XTestFakeButtonEvent: { parameters: ["pointer", "u32", "i32", "usize"], result: "i32" },
    });
    const cleanup = close;
    globalThis.addEventListener("unload", () => {
      cleanup();
      xtest.close();
    }, { once: true });
    const screen = x11.symbols.XDefaultScreen(display);
    const root = x11.symbols.XDefaultRootWindow(display);
    const rootReturn = new BigUint64Array(1);
    const childReturn = new BigUint64Array(1);
    const coords = Array.from({ length: 5 }, () => new Int32Array(1));
    return {
      pointerWindowAt(x, y) {
        const result = x11.symbols.XQueryPointer(
          display,
          root,
          rootReturn,
          childReturn,
          coords[0],
          coords[1],
          coords[2],
          coords[3],
          coords[4],
        );
        if (!result || childReturn[0] === 0n) return false;
        // An actor message may still be moving the uinput cursor. Never scroll
        // the previous X11 window while the ray is aimed somewhere else.
        const width = x11.symbols.XDisplayWidth(display, screen);
        const height = x11.symbols.XDisplayHeight(display, screen);
        return Math.abs(coords[0][0] - x * width) <= 8 &&
          Math.abs(coords[1][0] - y * height) <= 8;
      },
      button(button, down) {
        xtest.symbols.XTestFakeButtonEvent(display, button, down ? 1 : 0, 0n);
      },
      flush() {
        x11.symbols.XFlush(display);
      },
    };
  } catch {
    close?.();
    return null;
  }
}

export const x11WheelDiagnostics = { available: false, attempts: 0, discrete: 0, uinput: 0 };
let connection: X11WheelConnection | null | undefined;
export function tryLinuxX11Scroll(deltaY: number, x: number, y: number): boolean {
  if (connection === undefined) {
    connection = openX11Wheel();
    x11WheelDiagnostics.available = connection != null;
  }
  const sent = sendX11Wheel(connection, deltaY, x, y);
  x11WheelDiagnostics.attempts++;
  if (sent) x11WheelDiagnostics.discrete++;
  else x11WheelDiagnostics.uinput++;
  return sent;
}

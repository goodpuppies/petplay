/**
 * Mapped X11 windows by name: VRChat (Proton/XWayland) for the depth block's window capture, and
 * the lab's OBS Xcomposite sources. Read-only: names, classes, depth and size.
 */
export type X11Window = {
  id: number;
  name: string;
  cls: string;
  depth: number;
  width: number;
  height: number;
  x: number;
  y: number;
};

const IS_VIEWABLE = 2;

export function listX11Windows(): X11Window[] {
  const x = Deno.dlopen("libX11.so.6", {
    XOpenDisplay: { parameters: ["pointer"], result: "pointer" },
    XCloseDisplay: { parameters: ["pointer"], result: "i32" },
    XDefaultRootWindow: { parameters: ["pointer"], result: "u64" },
    XQueryTree: {
      parameters: ["pointer", "u64", "buffer", "buffer", "buffer", "buffer"],
      result: "i32",
    },
    XFetchName: { parameters: ["pointer", "u64", "buffer"], result: "i32" },
    XGetClassHint: { parameters: ["pointer", "u64", "buffer"], result: "i32" },
    XGetWindowAttributes: { parameters: ["pointer", "u64", "buffer"], result: "i32" },
    XTranslateCoordinates: { parameters: ["pointer", "u64", "u64", "i32", "i32", "buffer", "buffer", "buffer"], result: "i32" },
    XFree: { parameters: ["pointer"], result: "i32" },
  });
  const display = x.symbols.XOpenDisplay(null);
  if (display == null) {
    x.close();
    throw new Error("cannot open the X display: set DISPLAY and XAUTHORITY to the desktop session");
  }
  const cString = (pointer: Deno.PointerValue) =>
    pointer == null ? "" : new Deno.UnsafePointerView(pointer).getCString();
  const readPointer = (buffer: BigUint64Array) => Deno.UnsafePointer.create(buffer[0]);
  const found: X11Window[] = [];
  // XWindowAttributes on x86-64: x, y, width, height, border_width, depth (ints), ..., map_state at byte 92.
  const attributes = new Uint8Array(136);
  const view = new DataView(attributes.buffer);
  const walk = (window: bigint) => {
    const root = new BigUint64Array(1);
    const parent = new BigUint64Array(1);
    const children = new BigUint64Array(1);
    const count = new Uint32Array(1);
    if (!x.symbols.XQueryTree(display, window, root, parent, children, count)) return;
    const list = readPointer(children);
    const ids = list == null
      ? []
      : [...new BigUint64Array(Deno.UnsafePointerView.getArrayBuffer(list, count[0] * 8))];
    if (list != null) x.symbols.XFree(list);
    for (const child of ids) {
      const name = new BigUint64Array(1);
      if (x.symbols.XFetchName(display, child, name) && name[0] !== 0n) {
        const namePointer = readPointer(name);
        const hint = new BigUint64Array(2);
        x.symbols.XGetClassHint(display, child, hint);
        x.symbols.XGetWindowAttributes(display, child, attributes);
        if (view.getInt32(92, true) === IS_VIEWABLE) {
          const px = new Int32Array(1), py = new Int32Array(1), underneath = new BigUint64Array(1);
          x.symbols.XTranslateCoordinates(display, child, x.symbols.XDefaultRootWindow(display), 0, 0, px, py, underneath);
          found.push({
            id: Number(child),
            name: cString(namePointer),
            cls: cString(Deno.UnsafePointer.create(hint[1])),
            depth: view.getInt32(20, true),
            width: view.getInt32(8, true),
            height: view.getInt32(12, true),
            x: px[0], y: py[0],
          });
        }
        x.symbols.XFree(namePointer);
        for (const part of hint) if (part !== 0n) x.symbols.XFree(Deno.UnsafePointer.create(part));
      }
      walk(child);
    }
  };
  try {
    walk(x.symbols.XDefaultRootWindow(display));
  } finally {
    x.symbols.XCloseDisplay(display);
    x.close();
  }
  return found;
}

export function findX11Window(name: string): X11Window | null {
  return listX11Windows().find((window) => window.name === name) ?? null;
}

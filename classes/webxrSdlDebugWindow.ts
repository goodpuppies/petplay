const SDL_INIT_VIDEO = 0x00000020;
const SDL_WINDOW_SHOWN = 0x00000004;
const SDL_WINDOW_RESIZABLE = 0x00000020;
const SDL_QUIT = 0x100;
const BUILD_OS = Deno.build.os;
const sizeOfEvent = 56;
const eventBuf = new Uint8Array(sizeOfEvent);
const sizeOfSDL_SysWMInfo = 3 + 4 + 8 * 64;
const wmInfoBuf = new Uint8Array(sizeOfSDL_SysWMInfo);
const encoder = new TextEncoder();

const sdl2 = Deno.dlopen("SDL2", {
  SDL_Init: { parameters: ["u32"], result: "i32" },
  SDL_Quit: { parameters: [], result: "void" },
  SDL_CreateWindow: {
    parameters: ["buffer", "i32", "i32", "i32", "i32", "u32"],
    result: "pointer",
  },
  SDL_DestroyWindow: { parameters: ["pointer"], result: "void" },
  SDL_GetWindowWMInfo: { parameters: ["pointer", "pointer"], result: "i32" },
  SDL_GetVersion: { parameters: ["pointer"], result: "void" },
  SDL_PollEvent: { parameters: ["pointer"], result: "i32" },
  SDL_Metal_CreateView: { parameters: ["pointer"], result: "pointer" },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asCString(text: string): Uint8Array {
  return encoder.encode(`${text}\0`);
}

export class WebXRSdlDebugWindow {
  private window: Deno.PointerValue | null = null;
  private surface: Deno.UnsafeWindowSurface | null = null;

  initialize(title: string, width: number, height: number) {
    if (this.window) {
      return;
    }

    assert(sdl2.symbols.SDL_Init(SDL_INIT_VIDEO) === 0, "SDL_Init failed");
    const window = sdl2.symbols.SDL_CreateWindow(
      asCString(title) as BufferSource,
      0x2fff0000,
      0x2fff0000,
      width,
      height,
      SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE,
    );
    assert(window !== null, "SDL_CreateWindow failed");
    const metalView = BUILD_OS === "darwin" ? sdl2.symbols.SDL_Metal_CreateView(window) : null;

    this.window = window;
    this.surface = this.createSurface(window, metalView, width, height);
  }

  private createSurface(
    window: Deno.PointerValue,
    metalView: Deno.PointerValue | null,
    width: number,
    height: number,
  ): Deno.UnsafeWindowSurface {
    const wmInfo = Deno.UnsafePointer.of(wmInfoBuf);
    assert(wmInfo, "Failed to obtain pointer for SDL_SysWMInfo");
    sdl2.symbols.SDL_GetVersion(wmInfo);
    const ok = sdl2.symbols.SDL_GetWindowWMInfo(window, wmInfo);
    assert(ok !== 0, "SDL_GetWindowWMInfo failed");

    const view = new Deno.UnsafePointerView(wmInfo);
    const subsystem = view.getUint32(4);

    if (BUILD_OS === "darwin") {
      const nsView = view.getPointer(8);
      assert(subsystem === 4, "Expected SDL_SYSWM_COCOA on macOS");
      assert(nsView, "Missing Cocoa NSView pointer");
      return new Deno.UnsafeWindowSurface({
        system: "cocoa",
        windowHandle: nsView,
        displayHandle: metalView,
        width,
        height,
      });
    }

    if (BUILD_OS === "windows") {
      const hwnd = view.getPointer(8);
      const hinstance = view.getPointer(28);
      assert(subsystem === 1, `Unexpected Windows SDL subsystem ${subsystem}`);
      assert(hwnd, "Missing Win32 HWND");
      assert(hinstance, "Missing Win32 HINSTANCE");
      return new Deno.UnsafeWindowSurface({
        system: "win32",
        windowHandle: hwnd,
        displayHandle: hinstance,
        width,
        height,
      });
    }

    if (BUILD_OS === "linux") {
      const display = view.getPointer(8);
      const surface = view.getPointer(16);
      assert(display, "Missing Linux display handle");
      assert(surface, "Missing Linux window handle");
      if (subsystem === 2) {
        return new Deno.UnsafeWindowSurface({
          system: "x11",
          windowHandle: surface,
          displayHandle: display,
          width,
          height,
        });
      }
      if (subsystem === 6) {
        return new Deno.UnsafeWindowSurface({
          system: "wayland",
          windowHandle: surface,
          displayHandle: display,
          width,
          height,
        });
      }
      throw new Error(`Unexpected Linux SDL subsystem ${subsystem}`);
    }

    throw new Error(`Unsupported platform ${BUILD_OS}`);
  }

  getSurface(): Deno.UnsafeWindowSurface {
    assert(this.surface, "SDL debug window not initialized");
    return this.surface;
  }

  pollQuit(): boolean {
    const event = Deno.UnsafePointer.of(eventBuf);
    assert(event, "Failed to obtain SDL event pointer");
    while (sdl2.symbols.SDL_PollEvent(event) === 1) {
      const view = new Deno.UnsafePointerView(event);
      if (view.getUint32() === SDL_QUIT) {
        return true;
      }
    }
    return false;
  }

  cleanup() {
    if (this.window) {
      sdl2.symbols.SDL_DestroyWindow(this.window);
      this.window = null;
    }
    this.surface = null;
    sdl2.symbols.SDL_Quit();
  }
}

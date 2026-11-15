/**
 * Framebuffer capture for the desktop window and for XR render targets, for
 * visual inspection of UI work.
 *
 * The GL read **must** happen inside the render loop. Calling
 * `LoadImageFromScreen` from an agent-REPL `/eval` races the loop writing the
 * same target and segfaults the process, and native crashes are not catchable
 * by JS error guards. So the REPL only ever sets a flag here (pure JS, safe),
 * and {@link runPendingScreenCapture} does the actual read from inside the
 * loop, after `EndDrawing`. The same applies to {@link writeTexturePng}, which
 * reads a render target the loop is drawing into.
 *
 * Encoding is pngjs rather than raylib's `ExportImage` so the pixel buffer is
 * already in JS — the same read can later feed diffing or thumbnails without a
 * second round-trip through the filesystem.
 */
import { PNG } from "pngjs";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";

type PendingCapture = {
  path: string;
  keepAlpha: boolean;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
};

let pending: PendingCapture | null = null;
let lastCapturePath: string | null = null;
let lastCaptureError: string | null = null;

/**
 * Queue a capture. Resolves once the render loop has written the file, so a
 * caller that awaits this is guaranteed a complete PNG rather than a partial
 * one. Only one capture may be queued at a time; a second call while one is
 * outstanding replaces it, since the newer frame is the one worth having.
 */
export function requestScreenCapture(
  path: string,
  options: { keepAlpha?: boolean } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    pending?.reject(new Error("superseded by a newer capture request"));
    pending = { path, keepAlpha: options.keepAlpha === true, resolve, reject };
  });
}

/** True while a capture is queued and the render loop still has to draw a frame for it. */
export function hasPendingScreenCapture(): boolean {
  return pending != null;
}

/** Diagnostics readable over the REPL without triggering another capture. */
export function getScreenCaptureStatus(): {
  pendingPath: string | null;
  lastCapturePath: string | null;
  lastCaptureError: string | null;
} {
  return {
    pendingPath: pending?.path ?? null,
    lastCapturePath,
    lastCaptureError,
  };
}

/**
 * Run a queued capture. Call from inside the render loop, after `EndDrawing`,
 * so the front buffer holds a complete frame and no draw is in flight.
 */
export function runPendingScreenCapture(): void {
  const request = pending;
  if (request == null) return;
  pending = null;

  try {
    const path = writeScreenPng(request.path, request.keepAlpha);
    lastCapturePath = path;
    lastCaptureError = null;
    request.resolve(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastCaptureError = message;
    request.reject(error instanceof Error ? error : new Error(message));
  }
}

function writeScreenPng(path: string, keepAlpha: boolean): string {
  // raylib's screen readback hard-codes alpha to 255, so a transparent window is read
  // through GL directly.
  const withAlpha = keepAlpha ? readScreenRgba() : null;
  if (withAlpha) {
    Deno.writeFileSync(path, PNG.sync.write(withAlpha));
    return path;
  }
  const image = raylib.H.LoadImageFromScreen();
  try {
    const { width, height, data, format } = image;
    if (width <= 0 || height <= 0) {
      throw new Error(`screen capture returned an empty image (${width}x${height})`);
    }
    // 7 == PIXELFORMAT_UNCOMPRESSED_R8G8B8A8, which is what raylib reads the
    // screen back as. Anything else would silently produce garbled channels.
    if (format !== 7) {
      throw new Error(`unexpected capture pixel format ${format}, expected 7 (R8G8B8A8)`);
    }

    // `Image.data` is declared u64 in the struct, so it comes back as a bigint
    // rather than an FFI pointer; it has to be turned back into one.
    const pointer = Deno.UnsafePointer.create(BigInt(data as unknown as bigint));
    if (pointer === null) {
      throw new Error("screen capture returned a null pixel pointer");
    }
    const view = new Deno.UnsafePointerView(pointer);

    const png = new PNG({ width, height });
    const bytes = view.getArrayBuffer(width * height * 4);
    const src = new Uint8Array(bytes);
    png.data.set(src);
    // The window carries no meaningful alpha; force it opaque so the capture
    // does not read as blank in viewers that honor it.
    for (let i = 3; i < png.data.length; i += 4) {
      png.data[i] = 255;
    }

    Deno.writeFileSync(path, PNG.sync.write(png));
    return path;
  } finally {
    raylib.H.UnloadImage(image);
  }
}

const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
let glReadPixels:
  | ((x: number, y: number, w: number, h: number, format: number, type: number, out: Uint8Array) => void)
  | null
  | undefined;

function loadGlReadPixels() {
  if (glReadPixels !== undefined) return glReadPixels;
  const candidates = Deno.build.os === "windows" ? ["opengl32.dll"] : ["libGL.so.1", "libGL.so"];
  for (const path of candidates) {
    try {
      const library = Deno.dlopen(path, {
        glReadPixels: { parameters: ["i32", "i32", "i32", "i32", "u32", "u32", "buffer"], result: "void" },
        glReadBuffer: { parameters: ["u32"], result: "void" },
        glGetIntegerv: { parameters: ["u32", "buffer"], result: "void" },
      });
      glReadPixels = (x, y, w, h, format, type, out) => {
        // Called after EndDrawing swaps buffers. GL_BACK can now be empty; read the presented
        // front buffer explicitly, preserving the caller's read-buffer state.
        const previous = new Int32Array(1);
        library.symbols.glGetIntegerv(0x0c02, previous); // GL_READ_BUFFER
        library.symbols.glReadBuffer(0x0404); // GL_FRONT
        try { library.symbols.glReadPixels(x, y, w, h, format, type, out); }
        finally { library.symbols.glReadBuffer(previous[0]); }
      };
      return glReadPixels;
    } catch {
      // Try the next candidate.
    }
  }
  glReadPixels = null;
  return glReadPixels;
}

/** The framebuffer with its alpha, top row first; null when GL cannot be reached. */
function readScreenRgba(): PNG | null {
  const read = loadGlReadPixels();
  if (read == null) return null;
  const width = raylib.GetRenderWidth();
  const height = raylib.GetRenderHeight();
  if (width <= 0 || height <= 0) return null;
  const pixels = new Uint8Array(width * height * 4);
  read(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  const png = new PNG({ width, height });
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    png.data.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return png;
}

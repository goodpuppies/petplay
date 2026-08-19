/**
 * Constant-time OpenGL health queries.
 *
 * raylib's `IsRenderTextureValid` only checks that ids are non-zero, so it
 * reports a framebuffer that has stopped accepting writes as perfectly healthy.
 * These ask the driver instead. All three are O(1) and force no GPU sync, so
 * they are cheap enough to run every frame — unlike a pixel readback, which
 * stalls the pipeline and only infers breakage from symptoms.
 */

const GL_FRAMEBUFFER = 0x8D40;
const GL_FRAMEBUFFER_COMPLETE = 0x8CD5;

const FRAMEBUFFER_STATUS_NAMES: Record<number, string> = {
  0x0000: "ZERO (no context or invalid name)",
  0x8CD5: "COMPLETE",
  0x8219: "UNDEFINED",
  0x8CD6: "INCOMPLETE_ATTACHMENT",
  0x8CD7: "INCOMPLETE_MISSING_ATTACHMENT",
  0x8CDB: "INCOMPLETE_DRAW_BUFFER",
  0x8CDC: "INCOMPLETE_READ_BUFFER",
  0x8CDD: "UNSUPPORTED",
  0x8D56: "INCOMPLETE_MULTISAMPLE",
  0x8DA8: "INCOMPLETE_LAYER_TARGETS",
};

const GL_ERROR_NAMES: Record<number, string> = {
  0x0000: "NO_ERROR",
  0x0500: "INVALID_ENUM",
  0x0501: "INVALID_VALUE",
  0x0502: "INVALID_OPERATION",
  0x0505: "OUT_OF_MEMORY",
  0x0506: "INVALID_FRAMEBUFFER_OPERATION",
  0x0507: "CONTEXT_LOST",
};

const RESET_STATUS_NAMES: Record<number, string> = {
  0x0000: "NO_ERROR",
  0x8253: "GUILTY_CONTEXT_RESET",
  0x8254: "INNOCENT_CONTEXT_RESET",
  0x8255: "UNKNOWN_CONTEXT_RESET",
};

type GlHealthSymbols = {
  glGetError: () => number;
  glCheckNamedFramebufferStatus: (framebuffer: number, target: number) => number;
  glGetGraphicsResetStatus: () => number;
  glIsTexture: (texture: number) => number;
  glXGetCurrentContext: () => Deno.PointerValue;
};

let symbols: GlHealthSymbols | null | undefined;

function libraryCandidates(): string[] {
  switch (Deno.build.os) {
    case "windows":
      return ["opengl32.dll"];
    case "darwin":
      return ["/System/Library/Frameworks/OpenGL.framework/OpenGL"];
    default:
      return ["libGL.so.1", "libGL.so"];
  }
}

/**
 * @returns the resolved symbols, or null when this platform/driver does not
 * export them, in which case every query below degrades to "unknown".
 */
function load(): GlHealthSymbols | null {
  if (symbols !== undefined) return symbols;
  for (const path of libraryCandidates()) {
    try {
      const library = Deno.dlopen(path, {
        glGetError: { parameters: [], result: "u32" },
        glCheckNamedFramebufferStatus: { parameters: ["u32", "u32"], result: "u32" },
        glGetGraphicsResetStatus: { parameters: [], result: "u32" },
        glIsTexture: { parameters: ["u32"], result: "u8" },
        glXGetCurrentContext: { parameters: [], result: "pointer" },
      });
      symbols = library.symbols as unknown as GlHealthSymbols;
      return symbols;
    } catch {
      // Try the next candidate; a missing entry point is not fatal.
    }
  }
  symbols = null;
  return symbols;
}

/**
 * Identity of the GL context current on *this* thread.
 *
 * Distinguishes the two ways a render target can go dead: the texture was
 * genuinely deleted from a shared namespace, or this thread's current context
 * was swapped, so the id now names nothing in the namespace being queried.
 * Same symptoms, different fixes.
 */
export function getCurrentContextId(): string | null {
  const s = load();
  if (s == null) return null;
  try {
    const ptr = s.glXGetCurrentContext();
    return ptr == null ? "0" : `0x${Deno.UnsafePointer.value(ptr).toString(16)}`;
  } catch {
    return null;
  }
}

export function isGlHealthAvailable(): boolean {
  return load() != null;
}

/** Sticky GL error code, or null when unavailable. */
export function getGlError(): { code: number; name: string } | null {
  const s = load();
  if (s == null) return null;
  const code = s.glGetError();
  return { code, name: GL_ERROR_NAMES[code] ?? `UNKNOWN(0x${code.toString(16)})` };
}

/**
 * Non-zero once the GL context has been reset (GPU hang, driver recovery).
 * After a reset every subsequent call silently does nothing, which looks exactly
 * like draws being issued normally and landing nowhere.
 */
export function getGraphicsResetStatus(): { code: number; name: string } | null {
  const s = load();
  if (s == null) return null;
  const code = s.glGetGraphicsResetStatus();
  return { code, name: RESET_STATUS_NAMES[code] ?? `UNKNOWN(0x${code.toString(16)})` };
}

/**
 * Does this texture object still exist?
 *
 * This is the check that actually catches a render target whose colour
 * attachment has been deleted underneath it. raylib keeps reporting the target
 * valid because the *id* is unchanged, and the framebuffer keeps reporting
 * COMPLETE because its attachment record still names that id — but every draw
 * into it is discarded and each frame raises one GL_INVALID_OPERATION.
 */
export function isTextureAlive(textureId: number): boolean | null {
  const s = load();
  if (s == null) return null;
  return s.glIsTexture(textureId) !== 0;
}

/**
 * Direct-state-access completeness check: does not bind the framebuffer, so it
 * cannot disturb whatever the renderer currently has bound.
 */
export function getFramebufferStatus(
  framebufferId: number,
): { code: number; name: string; complete: boolean } | null {
  const s = load();
  if (s == null) return null;
  const code = s.glCheckNamedFramebufferStatus(framebufferId, GL_FRAMEBUFFER);
  return {
    code,
    name: FRAMEBUFFER_STATUS_NAMES[code] ?? `UNKNOWN(0x${code.toString(16)})`,
    complete: code === GL_FRAMEBUFFER_COMPLETE,
  };
}

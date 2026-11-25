/**
 * Upgrades Raylib's headless Linux GL context to a surfaceless EGL OpenGL 3.3 Core context with
 * `EGL_CONTEXT_PRIORITY_HIGH_IMG` (`AMDGPU_CTX_PRIORITY_HIGH` on Mesa RadeonSI).
 *
 * Without high GPU priority, a 1.8 ms overlay render gets queued behind a heavy scene app (e.g.
 * VRChat at 15-20 ms/frame on the normal GPU ring), causing `glClientWaitSync` to stall 12-16 ms.
 */
import { LogChannel } from "@mommysgoodpuppy/logchannel";

const EGL_PLATFORM_SURFACELESS_MESA = 0x31DD;
const EGL_EXTENSIONS = 0x3055;
const EGL_OPENGL_API = 0x30A2;
const EGL_RENDERABLE_TYPE = 0x3040;
const EGL_OPENGL_BIT = 0x0008;
const EGL_SURFACE_TYPE = 0x3033;
const EGL_PBUFFER_BIT = 0x0001;
const EGL_WIDTH = 0x3057;
const EGL_HEIGHT = 0x3056;
const EGL_NONE = 0x3038;
const EGL_CONTEXT_MAJOR_VERSION = 0x3098;
const EGL_CONTEXT_MINOR_VERSION = 0x30FB;
const EGL_CONTEXT_OPENGL_PROFILE_MASK = 0x30FD;
const EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT = 0x0001;
const EGL_CONTEXT_PRIORITY_LEVEL_IMG = 0x3100;
const EGL_CONTEXT_PRIORITY_HIGH_IMG = 0x3101;
const EGL_CONTEXT_PRIORITY_MEDIUM_IMG = 0x3102;
const EGL_CONTEXT_PRIORITY_LOW_IMG = 0x3103;

export type HighPriorityEglContext = {
  priority: "high" | "medium" | "low" | "unknown";
  cleanup(): void;
};

function cstr(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${value}\0`);
}

function priorityName(code: number): HighPriorityEglContext["priority"] {
  if (code === EGL_CONTEXT_PRIORITY_HIGH_IMG) return "high";
  if (code === EGL_CONTEXT_PRIORITY_MEDIUM_IMG) return "medium";
  if (code === EGL_CONTEXT_PRIORITY_LOW_IMG) return "low";
  return "unknown";
}

/**
 * Replaces the active thread's GLX context (created by `InitWindow`) with a headless surfaceless
 * EGL OpenGL 3.3 Core context requesting `EGL_CONTEXT_PRIORITY_HIGH_IMG`, then re-initializes
 * Raylib's `rlgl` state inside the new context.
 *
 * Must be called immediately after `raylib.H.InitWindow(...)`, before loading any shaders,
 * textures, or render targets. Returns `null` (leaving the original context untouched) on
 * non-Linux platforms, when disabled via `PETPLAY_EGL_HIGH_PRIORITY=0`, or if EGL high-priority
 * context creation is unavailable.
 */
export function upgradeToHighPriorityEglContext(
  raylibPath: string,
  width = 1,
  height = 1,
): HighPriorityEglContext | null {
  if (Deno.build.os !== "linux") return null;
  if (Deno.env.get("PETPLAY_EGL_HIGH_PRIORITY") === "0") return null;

  let egl: ReturnType<typeof openEgl> | null = null;
  let rl: ReturnType<typeof openRlgl> | null = null;
  let dpy: Deno.PointerValue = null;
  let surf: Deno.PointerValue = null;
  let ctx: Deno.PointerValue = null;
  try {
    egl = openEgl();
    const getPlatformDisplayPtr = egl.symbols.eglGetProcAddress(cstr("eglGetPlatformDisplayEXT"));
    if (!getPlatformDisplayPtr) {
      egl.close();
      return null;
    }
    const getPlatformDisplay = new Deno.UnsafeFnPointer(
      getPlatformDisplayPtr as Deno.PointerObject<{
        parameters: ["u32", "pointer", "pointer"];
        result: "pointer";
      }>,
      {
        parameters: ["u32", "pointer", "pointer"],
        result: "pointer",
      },
    );
    dpy = getPlatformDisplay.call(EGL_PLATFORM_SURFACELESS_MESA, null, null);
    if (!dpy) {
      egl.close();
      return null;
    }
    const major = new Int32Array(1);
    const minor = new Int32Array(1);
    if (!egl.symbols.eglInitialize(dpy, major, minor)) {
      egl.close();
      return null;
    }
    const extPtr = egl.symbols.eglQueryString(dpy, EGL_EXTENSIONS);
    const exts = extPtr ? new Deno.UnsafePointerView(extPtr).getCString() : "";
    if (!exts.includes("EGL_IMG_context_priority")) {
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }
    if (!egl.symbols.eglBindAPI(EGL_OPENGL_API)) {
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }
    const cfgAttribs = new Int32Array([
      EGL_RENDERABLE_TYPE,
      EGL_OPENGL_BIT,
      EGL_SURFACE_TYPE,
      EGL_PBUFFER_BIT,
      EGL_NONE,
    ]);
    const cfgs = new BigUint64Array(1);
    const numCfg = new Int32Array(1);
    if (!egl.symbols.eglChooseConfig(dpy, cfgAttribs, cfgs, 1, numCfg) || numCfg[0] < 1) {
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }
    const cfg = Deno.UnsafePointer.create(cfgs[0]);
    const pbufAttribs = new Int32Array([
      EGL_WIDTH,
      Math.max(1, width),
      EGL_HEIGHT,
      Math.max(1, height),
      EGL_NONE,
    ]);
    surf = egl.symbols.eglCreatePbufferSurface(dpy, cfg, pbufAttribs);
    const ctxAttribs = new Int32Array([
      EGL_CONTEXT_MAJOR_VERSION,
      3,
      EGL_CONTEXT_MINOR_VERSION,
      3,
      EGL_CONTEXT_OPENGL_PROFILE_MASK,
      EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
      EGL_CONTEXT_PRIORITY_LEVEL_IMG,
      EGL_CONTEXT_PRIORITY_HIGH_IMG,
      EGL_NONE,
    ]);
    ctx = egl.symbols.eglCreateContext(dpy, cfg, null, ctxAttribs);
    if (!ctx) {
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }
    const actualPrioBuf = new Int32Array(1);
    egl.symbols.eglQueryContext(dpy, ctx, EGL_CONTEXT_PRIORITY_LEVEL_IMG, actualPrioBuf);
    const priority = priorityName(actualPrioBuf[0]!);
    if (priority !== "high") {
      LogChannel.log(
        "webxrv2",
        `[webxr] EGL context priority downgraded to ${priority} (0x${
          actualPrioBuf[0]!.toString(16)
        }); keeping default GLX context`,
      );
      egl.symbols.eglDestroyContext(dpy, ctx);
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }

    const eglGetProcAddressPtr = egl.symbols.eglGetProcAddress(cstr("eglGetProcAddress"));
    if (!eglGetProcAddressPtr) {
      egl.symbols.eglDestroyContext(dpy, ctx);
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }

    rl = openRlgl(raylibPath);
    // Tear down rlgl objects in the old GLX context, release the GLX context from this thread so
    // EGL can bind cleanly, then reload GL entry points and recreate rlgl inside the high-priority
    // EGL context.
    rl.symbols.rlglClose();
    releaseCurrentGlxContext();
    if (!egl.symbols.eglMakeCurrent(dpy, surf, surf, ctx)) {
      LogChannel.log(
        "webxrv2",
        `[webxr] eglMakeCurrent failed: 0x${egl.symbols.eglGetError().toString(16)}`,
      );
      rl.symbols.rlglInit(width, height);
      rl.close();
      if (surf) egl.symbols.eglDestroySurface(dpy, surf);
      egl.symbols.eglDestroyContext(dpy, ctx);
      egl.symbols.eglTerminate(dpy);
      egl.close();
      return null;
    }
    rl.symbols.rlLoadExtensions(eglGetProcAddressPtr);
    rl.symbols.rlglInit(width, height);

    LogChannel.log(
      "webxrv2",
      `[webxr] upgraded GL context to EGL 3.3 Core (priority=${priority})`,
    );

    let cleaned = false;
    const ownedEgl = egl;
    const ownedRl = rl;
    const ownedDpy = dpy;
    const ownedSurf = surf;
    const ownedCtx = ctx;
    return {
      priority,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          ownedEgl.symbols.eglMakeCurrent(ownedDpy, null, null, null);
          if (ownedSurf) ownedEgl.symbols.eglDestroySurface(ownedDpy, ownedSurf);
          ownedEgl.symbols.eglDestroyContext(ownedDpy, ownedCtx);
          ownedEgl.symbols.eglTerminate(ownedDpy);
        } catch {
          // Best-effort teardown during process exit.
        }
        try {
          ownedRl.close();
        } catch {
          // Ignore close errors on exit.
        }
        try {
          ownedEgl.close();
        } catch {
          // Ignore close errors on exit.
        }
      },
    };
  } catch (err) {
    LogChannel.log("webxrv2", `[webxr] high-priority EGL upgrade skipped: ${err}`);
    try {
      if (egl && dpy && ctx) egl.symbols.eglDestroyContext(dpy, ctx);
      if (egl && dpy) egl.symbols.eglTerminate(dpy);
      rl?.close();
      egl?.close();
    } catch {
      // Ignore cleanup errors on fallback.
    }
    return null;
  }
}

function releaseCurrentGlxContext(): void {
  try {
    const gl = Deno.dlopen("libGL.so.1", {
      glXGetCurrentDisplay: { parameters: [], result: "pointer" },
      glXMakeCurrent: { parameters: ["pointer", "u64", "pointer"], result: "i32" },
    });
    const glxDpy = gl.symbols.glXGetCurrentDisplay();
    if (glxDpy) {
      gl.symbols.glXMakeCurrent(glxDpy, 0n, null);
    }
    gl.close();
  } catch {
    // Best-effort: if GLX is not bound, EGL can still make current directly.
  }
}

function openEgl() {
  return Deno.dlopen("libEGL.so.1", {
    eglGetProcAddress: { parameters: ["buffer"], result: "pointer" },
    eglGetError: { parameters: [], result: "i32" },
    eglInitialize: { parameters: ["pointer", "buffer", "buffer"], result: "u32" },
    eglTerminate: { parameters: ["pointer"], result: "u32" },
    eglQueryString: { parameters: ["pointer", "i32"], result: "pointer" },
    eglBindAPI: { parameters: ["u32"], result: "u32" },
    eglChooseConfig: {
      parameters: ["pointer", "buffer", "buffer", "i32", "buffer"],
      result: "u32",
    },
    eglCreatePbufferSurface: {
      parameters: ["pointer", "pointer", "buffer"],
      result: "pointer",
    },
    eglDestroySurface: { parameters: ["pointer", "pointer"], result: "u32" },
    eglCreateContext: {
      parameters: ["pointer", "pointer", "pointer", "buffer"],
      result: "pointer",
    },
    eglDestroyContext: { parameters: ["pointer", "pointer"], result: "u32" },
    eglMakeCurrent: {
      parameters: ["pointer", "pointer", "pointer", "pointer"],
      result: "u32",
    },
    eglQueryContext: { parameters: ["pointer", "pointer", "i32", "buffer"], result: "u32" },
  });
}

function openRlgl(raylibPath: string) {
  return Deno.dlopen(raylibPath, {
    rlglClose: { parameters: [], result: "void" },
    rlLoadExtensions: { parameters: ["pointer"], result: "void" },
    rlglInit: { parameters: ["i32", "i32"], result: "void" },
  });
}

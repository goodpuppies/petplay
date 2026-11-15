/**
 * VRChat's window as a GL texture, with no CPU copy of the frame (`markdown/vrchat-depth/README.md`).
 *
 * VRChat (Proton) and PetPlay's raylib window both run under Xwayland, and raylib's GLFW makes a GLX
 * context. XComposite names the window's backing pixmap and `GLX_EXT_texture_from_pixmap` binds it
 * as a texture, so shaders sample VRChat's presented frame directly. Xwayland swaps that pixmap on
 * every present (measured 2026-11-07: rebinding only gave 10 of 42 fresh frames/s), so each damage
 * event names the current pixmap again; naming and binding copy nothing.
 *
 * Damage and configure events arrive on a connection of our own: GLFW's event loop drains the GL
 * connection and would swallow them. Pixmaps are server resources, so the GL connection binds what
 * the other one names.
 *
 * Must be created and used on the thread whose GL context is current (the raylib render loop).
 */

const enc = (s: string) => new TextEncoder().encode(s + "\0");

const GL_TEXTURE_2D = 0x0de1, GL_TEXTURE0 = 0x84c0, GL_NEAREST = 0x2600;
const GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803, GL_CLAMP_TO_EDGE = 0x812f;
const GL_FRAMEBUFFER = 0x8d40, GL_READ_FRAMEBUFFER = 0x8ca8, GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa, GL_DRAW_FRAMEBUFFER_BINDING = 0x8ca6;
const GL_TEXTURE_BINDING_2D = 0x8069, GL_ACTIVE_TEXTURE = 0x84e0;
const GL_COLOR_ATTACHMENT0 = 0x8ce0, GL_RENDERBUFFER = 0x8d41, GL_RGBA8 = 0x8058;
const GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401, GL_COLOR_BUFFER_BIT = 0x4000;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_PIXEL_PACK_BUFFER = 0x88eb, GL_STREAM_READ = 0x88e1;
const GL_SYNC_GPU_COMMANDS_COMPLETE = 0x9117, GL_TIMEOUT_EXPIRED = 0x911b, GL_WAIT_FAILED = 0x911d;

const GLX_DRAWABLE_TYPE = 0x8010, GLX_PIXMAP_BIT = 2, GLX_BIND_TO_TEXTURE_RGBA_EXT = 0x20d1,
  GLX_BIND_TO_TEXTURE_RGB_EXT = 0x20d0, GLX_BIND_TO_TEXTURE_TARGETS_EXT = 0x20d3,
  GLX_TEXTURE_2D_BIT_EXT = 2, GLX_DOUBLEBUFFER = 5, GLX_TEXTURE_TARGET_EXT = 0x20d6,
  GLX_TEXTURE_2D_EXT = 0x20dc, GLX_TEXTURE_FORMAT_EXT = 0x20d5,
  GLX_TEXTURE_FORMAT_RGB_EXT = 0x20d9, GLX_TEXTURE_FORMAT_RGBA_EXT = 0x20da,
  GLX_FRONT_LEFT_EXT = 0x20de;

const CONFIGURE_NOTIFY = 22, DESTROY_NOTIFY = 17, UNMAP_NOTIFY = 18;
const STRUCTURE_NOTIFY_MASK = 1 << 17;

let libs: ReturnType<typeof openLibs> | null = null;
/** The latest X error code (from any connection in the process), so a dead window can't exit us. */
let lastXError = 0;
const ERROR_HANDLER = { parameters: ["pointer", "pointer"], result: "i32" } as const;
let errorHandler: Deno.UnsafeCallback<typeof ERROR_HANDLER> | null = null;

function openLibs() {
  const gl = Deno.dlopen("libGL.so.1", {
    glXGetCurrentDisplay: { parameters: [], result: "pointer" },
    glXGetProcAddress: { parameters: ["buffer"], result: "pointer" },
    glXChooseFBConfig: { parameters: ["pointer", "i32", "buffer", "buffer"], result: "pointer" },
    glXGetVisualFromFBConfig: { parameters: ["pointer", "pointer"], result: "pointer" },
    glXCreatePixmap: { parameters: ["pointer", "pointer", "u64", "buffer"], result: "u64" },
    glXDestroyPixmap: { parameters: ["pointer", "u64"], result: "void" },
  });
  const x11 = Deno.dlopen("libX11.so.6", {
    XOpenDisplay: { parameters: ["pointer"], result: "pointer" },
    XCloseDisplay: { parameters: ["pointer"], result: "i32" },
    XGetWindowAttributes: { parameters: ["pointer", "u64", "buffer"], result: "i32" },
    XSelectInput: { parameters: ["pointer", "u64", "i64"], result: "i32" },
    XPending: { parameters: ["pointer"], result: "i32" },
    XNextEvent: { parameters: ["pointer", "buffer"], result: "i32" },
    XFree: { parameters: ["pointer"], result: "i32" },
    XSync: { parameters: ["pointer", "i32"], result: "i32" },
    XFlush: { parameters: ["pointer"], result: "i32" },
    XFreePixmap: { parameters: ["pointer", "u64"], result: "i32" },
    XSetErrorHandler: { parameters: ["pointer"], result: "pointer" },
  });
  const composite = Deno.dlopen("libXcomposite.so.1", {
    XCompositeRedirectWindow: { parameters: ["pointer", "u64", "i32"], result: "void" },
    XCompositeNameWindowPixmap: { parameters: ["pointer", "u64"], result: "u64" },
  });
  const damage = Deno.dlopen("libXdamage.so.1", {
    XDamageQueryExtension: { parameters: ["pointer", "buffer", "buffer"], result: "i32" },
    XDamageCreate: { parameters: ["pointer", "u64", "i32"], result: "u64" },
    XDamageDestroy: { parameters: ["pointer", "u64"], result: "void" },
    XDamageSubtract: { parameters: ["pointer", "u64", "u64", "u64"], result: "void" },
  });
  const proc = <T extends Deno.ForeignFunction>(name: string, def: T) => {
    const pointer = gl.symbols.glXGetProcAddress(enc(name));
    if (!pointer) throw new Error(`GL entry point ${name} missing`);
    return new Deno.UnsafeFnPointer(pointer as Deno.PointerObject<T>, def);
  };
  const g = {
    bindTexImage: proc("glXBindTexImageEXT", {
      parameters: ["pointer", "u64", "i32", "pointer"],
      result: "void",
    } as const),
    releaseTexImage: proc("glXReleaseTexImageEXT", {
      parameters: ["pointer", "u64", "i32"],
      result: "void",
    } as const),
    genTextures: proc("glGenTextures", { parameters: ["i32", "buffer"], result: "void" } as const),
    deleteTextures: proc("glDeleteTextures", {
      parameters: ["i32", "buffer"],
      result: "void",
    } as const),
    bindTexture: proc("glBindTexture", { parameters: ["u32", "u32"], result: "void" } as const),
    activeTexture: proc("glActiveTexture", { parameters: ["u32"], result: "void" } as const),
    texParameteri: proc("glTexParameteri", {
      parameters: ["u32", "u32", "i32"],
      result: "void",
    } as const),
    getIntegerv: proc("glGetIntegerv", { parameters: ["u32", "buffer"], result: "void" } as const),
    pixelStorei: proc("glPixelStorei", { parameters: ["u32", "i32"], result: "void" } as const),
    genFramebuffers: proc("glGenFramebuffers", {
      parameters: ["i32", "buffer"],
      result: "void",
    } as const),
    deleteFramebuffers: proc("glDeleteFramebuffers", {
      parameters: ["i32", "buffer"],
      result: "void",
    } as const),
    bindFramebuffer: proc("glBindFramebuffer", {
      parameters: ["u32", "u32"],
      result: "void",
    } as const),
    framebufferTexture2D: proc("glFramebufferTexture2D", {
      parameters: ["u32", "u32", "u32", "u32", "i32"],
      result: "void",
    } as const),
    genRenderbuffers: proc("glGenRenderbuffers", {
      parameters: ["i32", "buffer"],
      result: "void",
    } as const),
    deleteRenderbuffers: proc("glDeleteRenderbuffers", {
      parameters: ["i32", "buffer"],
      result: "void",
    } as const),
    bindRenderbuffer: proc("glBindRenderbuffer", {
      parameters: ["u32", "u32"],
      result: "void",
    } as const),
    renderbufferStorage: proc("glRenderbufferStorage", {
      parameters: ["u32", "u32", "i32", "i32"],
      result: "void",
    } as const),
    framebufferRenderbuffer: proc("glFramebufferRenderbuffer", {
      parameters: ["u32", "u32", "u32", "u32"],
      result: "void",
    } as const),
    blitFramebuffer: proc("glBlitFramebuffer", {
      parameters: ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "u32", "u32"],
      result: "void",
    } as const),
    readPixels: proc("glReadPixels", {
      parameters: ["i32", "i32", "i32", "i32", "u32", "u32", "buffer"],
      result: "void",
    } as const),
    /** `glReadPixels` into the bound pixel-pack buffer: the last argument is an offset. */
    readPixelsToBuffer: proc("glReadPixels", {
      parameters: ["i32", "i32", "i32", "i32", "u32", "u32", "pointer"],
      result: "void",
    } as const),
    genBuffers: proc("glGenBuffers", { parameters: ["i32", "buffer"], result: "void" } as const),
    deleteBuffers: proc("glDeleteBuffers", { parameters: ["i32", "buffer"], result: "void" } as const),
    bindBuffer: proc("glBindBuffer", { parameters: ["u32", "u32"], result: "void" } as const),
    bufferData: proc("glBufferData", {
      parameters: ["u32", "isize", "pointer", "u32"],
      result: "void",
    } as const),
    getBufferSubData: proc("glGetBufferSubData", {
      parameters: ["u32", "isize", "isize", "buffer"],
      result: "void",
    } as const),
    fenceSync: proc("glFenceSync", { parameters: ["u32", "u32"], result: "pointer" } as const),
    clientWaitSync: proc("glClientWaitSync", {
      parameters: ["pointer", "u32", "u64"],
      result: "u32",
    } as const),
    deleteSync: proc("glDeleteSync", { parameters: ["pointer"], result: "void" } as const),
    flush: proc("glFlush", { parameters: [], result: "void" } as const),
  };
  // Xlib's default handler exits the process on any error, e.g. naming the pixmap of a window
  // that just closed. Record instead; GLFW installs its own around its calls and restores ours.
  errorHandler = new Deno.UnsafeCallback(
    ERROR_HANDLER,
    (_display, event) => {
      lastXError = event ? new Deno.UnsafePointerView(event).getUint8(32) : -1;
      return 0;
    },
  );
  x11.symbols.XSetErrorHandler(errorHandler!.pointer);
  return { gl, x11, composite, damage, g };
}

export type GpuCaptureStatus = {
  window: { id: number; width: number; height: number } | null;
  damages: number;
  binds: number;
  lastBindAt: number;
  lost: string | null;
};

export class GpuWindowCapture {
  /**
   * One texture per slot. With more than one, a redraw binds into a slot the caller names
   * (`bindDamage`), so a slot that is being drawn from keeps its pixmap until the caller is done.
   */
  readonly textures: number[] = [];
  /** The slot the latest redraw was bound into. */
  slot = 0;
  /** GL texture name of the latest bound pixmap; row 0 is the window's top row. */
  get textureId(): number {
    return this.textures[this.slot];
  }
  width = 0;
  height = 0;
  damages = 0;
  binds = 0;
  /** `Date.now()` when the latest damage was bound: the frame's arrival time. */
  lastBindAt = 0;
  /** Set when the window went away or the binding failed; the capture is then dead. */
  lost: string | null = null;
  private readonly glDisplay: Deno.PointerValue;
  private readonly display: Deno.PointerValue;
  private readonly config: Deno.PointerValue;
  private readonly rgba: boolean;
  private readonly damageEventType: number;
  private readonly damage: bigint;
  private readonly pixmaps: bigint[] = [];
  private readonly glxPixmaps: bigint[] = [];
  /** Asynchronous readback (`startReadRect`): pixel-pack buffer, its size, and its fence. */
  private pbo = 0;
  private pboBytes = 0;
  private readBytes = 0;
  private fence: Deno.PointerValue = null;
  private readFbo = 0;
  private smallFbo = 0;
  private smallRbo = 0;
  private smallSize = [0, 0];
  private readonly event = new Uint8Array(192);
  private readonly scratch = new Int32Array(4);
  private pendingDamage = false;

  private constructor(readonly windowId: number, slots: number) {
    libs ??= openLibs();
    const { gl, x11, composite, damage, g } = libs;
    this.glDisplay = gl.symbols.glXGetCurrentDisplay();
    if (!this.glDisplay) throw new Error("no current GLX context (raylib not on GLX?)");
    this.display = x11.symbols.XOpenDisplay(null);
    if (!this.display) throw new Error("cannot open a second X connection");
    const id = BigInt(windowId);
    const attrs = new Uint8Array(256);
    if (!x11.symbols.XGetWindowAttributes(this.display, id, attrs)) {
      x11.symbols.XCloseDisplay(this.display);
      throw new Error(`window 0x${windowId.toString(16)} is gone`);
    }
    const view = new DataView(attrs.buffer);
    this.width = view.getInt32(8, true);
    this.height = view.getInt32(12, true);
    const depth = view.getInt32(20, true);
    this.rgba = depth === 32;
    this.config = chooseConfig(this.glDisplay, depth, this.rgba);

    composite.symbols.XCompositeRedirectWindow(this.display, id, 0); // automatic
    const eventBase = new Int32Array(1), errorBase = new Int32Array(1);
    if (!damage.symbols.XDamageQueryExtension(this.display, eventBase, errorBase)) {
      x11.symbols.XCloseDisplay(this.display);
      throw new Error("XDamage unavailable");
    }
    this.damageEventType = eventBase[0];
    this.damage = damage.symbols.XDamageCreate(this.display, id, 3) as bigint; // NonEmpty
    x11.symbols.XSelectInput(this.display, id, BigInt(STRUCTURE_NOTIFY_MASK));
    x11.symbols.XSync(this.display, 0);

    const names = new Uint32Array(Math.max(1, slots));
    g.genTextures.call(names.length, names);
    for (let slot = 0; slot < names.length; slot++) {
      this.textures.push(names[slot]);
      this.pixmaps.push(0n);
      this.glxPixmaps.push(0n);
      this.withTexture(slot, () => {
        g.texParameteri.call(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        g.texParameteri.call(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        g.texParameteri.call(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        g.texParameteri.call(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      });
    }
    this.bindCurrentPixmap(0);
  }

  /** Binds `windowId`, which must be a mapped top-level of this X server. */
  static open(windowId: number, slots = 1): GpuWindowCapture {
    return new GpuWindowCapture(windowId, slots);
  }

  /**
   * Drains window events; when the window was redrawn, binds its current pixmap and returns true.
   * Cheap when nothing happened: one `XPending`.
   */
  poll(): boolean {
    return this.damaged() && this.bindDamage(this.slot);
  }

  /** Drains window events: whether VRChat redrew since the last `bindDamage`. Binds nothing. */
  damaged(): boolean {
    if (this.lost) return false;
    const { x11 } = libs!;
    const view = new DataView(this.event.buffer);
    while (x11.symbols.XPending(this.display) > 0) {
      x11.symbols.XNextEvent(this.display, this.event);
      const type = view.getInt32(0, true);
      if (type === this.damageEventType) this.pendingDamage = true;
      else if (type === CONFIGURE_NOTIFY) {
        this.width = view.getInt32(56, true);
        this.height = view.getInt32(60, true);
        this.pendingDamage = true;
      } else if (type === DESTROY_NOTIFY || type === UNMAP_NOTIFY) {
        this.lost = type === DESTROY_NOTIFY ? "window destroyed" : "window unmapped";
        return false;
      }
    }
    return this.pendingDamage;
  }

  /** Binds the window's current pixmap into `slot` (releasing that slot's previous one). */
  bindDamage(slot: number): boolean {
    if (this.lost) return false;
    this.pendingDamage = false;
    this.damages++;
    libs!.damage.symbols.XDamageSubtract(this.display, this.damage, 0n, 0n);
    this.bindCurrentPixmap(slot);
    this.slot = slot;
    return !this.lost;
  }

  /**
   * Reads window pixels `[x, x+w) × [y, y+h)` (top-left origin) into `out` as RGBA. Synchronous:
   * keep it to small regions.
   */
  readRect(x: number, y: number, w: number, h: number, out: Uint8Array, slot = this.slot): void {
    if (out.length < w * h * 4) throw new Error("readRect buffer too small");
    const { g } = libs!;
    this.withReadFramebuffer(() => {
      this.ensureReadFbo(slot);
      g.bindFramebuffer.call(GL_READ_FRAMEBUFFER, this.readFbo);
      g.readPixels.call(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, out);
    });
  }

  /**
   * The whole window nearest-sampled to `w × h` (sample centres as `downsampleDepth`), RGBA, rows
   * top first.
   */
  readScaled(w: number, h: number, out: Uint8Array): void {
    const { g } = libs!;
    this.withReadFramebuffer(() => {
      this.ensureReadFbo(this.slot);
      if (!this.smallFbo || this.smallSize[0] !== w || this.smallSize[1] !== h) {
        const names = new Uint32Array(1);
        if (this.smallFbo) {
          g.deleteFramebuffers.call(1, Uint32Array.of(this.smallFbo));
          g.deleteRenderbuffers.call(1, Uint32Array.of(this.smallRbo));
        }
        g.genRenderbuffers.call(1, names);
        this.smallRbo = names[0];
        g.bindRenderbuffer.call(GL_RENDERBUFFER, this.smallRbo);
        g.renderbufferStorage.call(GL_RENDERBUFFER, GL_RGBA8, w, h);
        g.bindRenderbuffer.call(GL_RENDERBUFFER, 0);
        g.genFramebuffers.call(1, names);
        this.smallFbo = names[0];
        g.bindFramebuffer.call(GL_DRAW_FRAMEBUFFER, this.smallFbo);
        g.framebufferRenderbuffer.call(
          GL_DRAW_FRAMEBUFFER,
          GL_COLOR_ATTACHMENT0,
          GL_RENDERBUFFER,
          this.smallRbo,
        );
        this.smallSize = [w, h];
      }
      g.bindFramebuffer.call(GL_READ_FRAMEBUFFER, this.readFbo);
      g.bindFramebuffer.call(GL_DRAW_FRAMEBUFFER, this.smallFbo);
      g.blitFramebuffer.call(
        0,
        0,
        this.width,
        this.height,
        0,
        0,
        w,
        h,
        GL_COLOR_BUFFER_BIT,
        GL_NEAREST,
      );
      g.bindFramebuffer.call(GL_READ_FRAMEBUFFER, this.smallFbo);
      g.readPixels.call(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, out);
    });
  }

  /**
   * Starts reading `[x, x+w) × [y, y+h)` of `slot` into a pixel-pack buffer without waiting for
   * the GPU; `finishReadRect` collects it once its fence has passed. One read at a time; the slot
   * must not be rebound until it finishes.
   */
  startReadRect(slot: number, x: number, y: number, w: number, h: number): boolean {
    if (this.lost || this.fence) return false;
    const { g } = libs!;
    const bytes = w * h * 4;
    this.withReadFramebuffer(() => {
      this.ensureReadFbo(slot);
      g.bindFramebuffer.call(GL_READ_FRAMEBUFFER, this.readFbo);
      if (!this.pbo) {
        const names = new Uint32Array(1);
        g.genBuffers.call(1, names);
        this.pbo = names[0];
      }
      g.bindBuffer.call(GL_PIXEL_PACK_BUFFER, this.pbo);
      try {
        if (bytes > this.pboBytes) {
          g.bufferData.call(GL_PIXEL_PACK_BUFFER, BigInt(bytes), null, GL_STREAM_READ);
          this.pboBytes = bytes;
        }
        g.readPixelsToBuffer.call(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, null);
      } finally {
        g.bindBuffer.call(GL_PIXEL_PACK_BUFFER, 0);
      }
    });
    this.readBytes = bytes;
    this.fence = g.fenceSync.call(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    // Submit now, so the fence can pass while the caller does other work.
    g.flush.call();
    return true;
  }

  /** Whether a `startReadRect` is still outstanding. */
  get reading(): boolean {
    return this.fence != null;
  }

  /**
   * The bytes of the outstanding `startReadRect` into `out` once the GPU has written them (true);
   * false while it hasn't, never waiting.
   */
  finishReadRect(out: Uint8Array): boolean {
    if (!this.fence) return false;
    const { g } = libs!;
    const state = g.clientWaitSync.call(this.fence, 0, 0n);
    if (state === GL_TIMEOUT_EXPIRED) return false;
    g.deleteSync.call(this.fence);
    this.fence = null;
    if (state === GL_WAIT_FAILED) return false;
    if (out.length < this.readBytes) throw new Error("finishReadRect buffer too small");
    g.bindBuffer.call(GL_PIXEL_PACK_BUFFER, this.pbo);
    try {
      g.getBufferSubData.call(GL_PIXEL_PACK_BUFFER, 0n, BigInt(this.readBytes), out);
    } finally {
      g.bindBuffer.call(GL_PIXEL_PACK_BUFFER, 0);
    }
    return true;
  }

  status(): GpuCaptureStatus {
    return {
      window: { id: this.windowId, width: this.width, height: this.height },
      damages: this.damages,
      binds: this.binds,
      lastBindAt: this.lastBindAt,
      lost: this.lost,
    };
  }

  dispose(): void {
    if (!libs) return;
    const { gl, x11, damage, g } = libs;
    for (let slot = 0; slot < this.textures.length; slot++) this.releasePixmap(slot);
    g.deleteTextures.call(this.textures.length, Uint32Array.from(this.textures));
    if (this.fence) g.deleteSync.call(this.fence);
    this.fence = null;
    if (this.pbo) g.deleteBuffers.call(1, Uint32Array.of(this.pbo));
    this.pbo = this.pboBytes = 0;
    if (this.readFbo) g.deleteFramebuffers.call(1, Uint32Array.of(this.readFbo));
    if (this.smallFbo) g.deleteFramebuffers.call(1, Uint32Array.of(this.smallFbo));
    if (this.smallRbo) g.deleteRenderbuffers.call(1, Uint32Array.of(this.smallRbo));
    this.readFbo = this.smallFbo = this.smallRbo = 0;
    if (!this.lost) damage.symbols.XDamageDestroy(this.display, this.damage);
    x11.symbols.XSync(this.display, 0);
    x11.symbols.XCloseDisplay(this.display);
    void gl;
    this.lost ??= "disposed";
  }

  private releasePixmap(slot: number): void {
    const { gl, x11 } = libs!;
    const glxPixmap = this.glxPixmaps[slot];
    if (glxPixmap) {
      this.withTexture(slot, () =>
        libs!.g.releaseTexImage.call(this.glDisplay, glxPixmap, GLX_FRONT_LEFT_EXT)
      );
      gl.symbols.glXDestroyPixmap(this.glDisplay, glxPixmap);
      this.glxPixmaps[slot] = 0n;
    }
    if (this.pixmaps[slot]) {
      x11.symbols.XFreePixmap(this.display, this.pixmaps[slot]);
      this.pixmaps[slot] = 0n;
    }
  }

  private bindCurrentPixmap(slot: number): void {
    const { gl, x11, composite, g } = libs!;
    this.releasePixmap(slot);
    const pixmap = composite.symbols.XCompositeNameWindowPixmap(
      this.display,
      BigInt(this.windowId),
    ) as bigint;
    // The GL connection must see the pixmap before it wraps it.
    lastXError = 0;
    x11.symbols.XSync(this.display, 0);
    if (!pixmap || lastXError) {
      this.lost = `XCompositeNameWindowPixmap failed (X error ${lastXError})`;
      return;
    }
    this.pixmaps[slot] = pixmap;
    const attrs = new Int32Array([
      GLX_TEXTURE_TARGET_EXT,
      GLX_TEXTURE_2D_EXT,
      GLX_TEXTURE_FORMAT_EXT,
      this.rgba ? GLX_TEXTURE_FORMAT_RGBA_EXT : GLX_TEXTURE_FORMAT_RGB_EXT,
      0,
    ]);
    const glxPixmap = gl.symbols.glXCreatePixmap(this.glDisplay, this.config, pixmap, attrs) as bigint;
    this.glxPixmaps[slot] = glxPixmap;
    if (!glxPixmap) {
      this.lost = "glXCreatePixmap failed";
      return;
    }
    this.withTexture(slot, () =>
      g.bindTexImage.call(this.glDisplay, glxPixmap, GLX_FRONT_LEFT_EXT, null)
    );
    this.binds++;
    this.lastBindAt = Date.now();
  }

  private ensureReadFbo(slot: number): void {
    const { g } = libs!;
    if (!this.readFbo) {
      const names = new Uint32Array(1);
      g.genFramebuffers.call(1, names);
      this.readFbo = names[0];
    }
    // Re-attach every time: a new pixmap may have changed the texture's storage.
    g.bindFramebuffer.call(GL_FRAMEBUFFER, this.readFbo);
    g.framebufferTexture2D.call(
      GL_FRAMEBUFFER,
      GL_COLOR_ATTACHMENT0,
      GL_TEXTURE_2D,
      this.textures[slot],
      0,
    );
  }

  /** Runs `fn` with `slot`'s texture bound on unit 0, restoring raylib's binding. */
  private withTexture(slot: number, fn: () => void): void {
    const { g } = libs!;
    g.getIntegerv.call(GL_ACTIVE_TEXTURE, this.scratch);
    const active = this.scratch[0];
    g.activeTexture.call(GL_TEXTURE0);
    g.getIntegerv.call(GL_TEXTURE_BINDING_2D, this.scratch);
    const previous = this.scratch[0];
    g.bindTexture.call(GL_TEXTURE_2D, this.textures[slot]);
    try {
      fn();
    } finally {
      g.bindTexture.call(GL_TEXTURE_2D, previous);
      g.activeTexture.call(active);
    }
  }

  private withReadFramebuffer(fn: () => void): void {
    const { g } = libs!;
    g.getIntegerv.call(GL_READ_FRAMEBUFFER_BINDING, this.scratch);
    const read = this.scratch[0];
    g.getIntegerv.call(GL_DRAW_FRAMEBUFFER_BINDING, this.scratch);
    const draw = this.scratch[0];
    g.pixelStorei.call(GL_PACK_ALIGNMENT, 1);
    try {
      fn();
    } finally {
      g.pixelStorei.call(GL_PACK_ALIGNMENT, 4);
      g.bindFramebuffer.call(GL_READ_FRAMEBUFFER, read);
      g.bindFramebuffer.call(GL_DRAW_FRAMEBUFFER, draw);
    }
  }
}

function chooseConfig(display: Deno.PointerValue, depth: number, rgba: boolean): Deno.PointerValue {
  const { gl, x11 } = libs!;
  const want = new Int32Array([
    GLX_DRAWABLE_TYPE,
    GLX_PIXMAP_BIT,
    rgba ? GLX_BIND_TO_TEXTURE_RGBA_EXT : GLX_BIND_TO_TEXTURE_RGB_EXT,
    1,
    GLX_BIND_TO_TEXTURE_TARGETS_EXT,
    GLX_TEXTURE_2D_BIT_EXT,
    GLX_DOUBLEBUFFER,
    0,
    0,
  ]);
  const count = new Int32Array(1);
  const configs = gl.symbols.glXChooseFBConfig(display, 0, want, count);
  if (!configs || !count[0]) throw new Error("no texture-from-pixmap FB config");
  const list = new Deno.UnsafePointerView(configs);
  try {
    for (let i = 0; i < count[0]; i++) {
      const config = Deno.UnsafePointer.create(list.getBigUint64(i * 8));
      const visual = gl.symbols.glXGetVisualFromFBConfig(display, config);
      if (!visual) continue;
      const visualDepth = new Deno.UnsafePointerView(visual).getInt32(20);
      x11.symbols.XFree(visual);
      if (visualDepth === depth) return config;
    }
  } finally {
    // The configs stay valid after the list is freed.
    x11.symbols.XFree(configs);
  }
  throw new Error(`no texture-from-pixmap FB config with depth ${depth}`);
}

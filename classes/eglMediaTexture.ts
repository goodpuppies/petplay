import * as gl from "../submodules/gluten/api/gl4.6.ts";
import type { GpuMediaFrame } from "./gpuMediaSocket.ts";
/** Own an EGL GL context in the receiver's dedicated process.
 * Import RGB DMA-BUFs and copy on GPU into presentation-owned storage before ACKing reuse.
 * EGLImages must be used in an EGL context; the app's existing GLX context cannot import them.
 */
export class EglMediaTexture {
  private egl = Deno.dlopen(
    "libEGL.so.1",
    {
      eglBindAPI: { parameters: ["u32"], result: "u32" },
      eglChooseConfig: {
        parameters: ["pointer", "buffer", "buffer", "i32", "buffer"],
        result: "u32",
      },
      eglCreateContext: {
        parameters: ["pointer", "pointer", "pointer", "buffer"],
        result: "pointer",
      },
      eglCreatePbufferSurface: { parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
      eglMakeCurrent: { parameters: ["pointer", "pointer", "pointer", "pointer"], result: "u32" },
      eglDestroyContext: { parameters: ["pointer", "pointer"], result: "u32" },
      eglDestroySurface: { parameters: ["pointer", "pointer"], result: "u32" },
      eglTerminate: { parameters: ["pointer"], result: "u32" },
      eglGetDisplay: { parameters: ["pointer"], result: "pointer" },
      eglInitialize: { parameters: ["pointer", "buffer", "buffer"], result: "u32" },
      eglGetProcAddress: { parameters: ["buffer"], result: "pointer" },
      eglGetError: { parameters: [], result: "u32" },
    } as const,
  );
  private display: Deno.PointerValue = null;
  private createImage!: Deno.UnsafeFnPointer<
    { parameters: ["pointer", "pointer", "u32", "pointer", "buffer"]; result: "pointer" }
  >;
  private destroyImage!: Deno.UnsafeFnPointer<
    { parameters: ["pointer", "pointer"]; result: "u32" }
  >;
  private bindImage!: Deno.UnsafeFnPointer<{ parameters: ["u32", "pointer"]; result: "void" }>;
  private buffers = new Uint32Array(2);
  private width = 0;
  private height = 0;
  private context: Deno.PointerValue = null;
  private surface: Deno.PointerValue = null;
  readonly texture: number = 0;
  private glReady = false;
  private closed = false;
  constructor() {
    try {
      this.display = this.egl.symbols.eglGetDisplay(null);
      const major = new Int32Array(1), minor = new Int32Array(1);
      if (!this.display || !this.egl.symbols.eglInitialize(this.display, major, minor)) {
        throw Error(`EGL display init failed: ${this.egl.symbols.eglGetError().toString(16)}`);
      }
      const configs = new BigUint64Array(1), count = new Int32Array(1);
      const attributes = new Int32Array([
        0x3033,
        1,
        0x3040,
        8,
        0x3024,
        8,
        0x3023,
        8,
        0x3022,
        8,
        0x3021,
        8,
        0x3038,
      ]);
      if (
        !this.egl.symbols.eglBindAPI(0x30a2) ||
        !this.egl.symbols.eglChooseConfig(this.display, attributes, configs, 1, count) || !count[0]
      ) throw Error("No EGL OpenGL config");
      const config = Deno.UnsafePointer.create(configs[0]);
      this.context = this.egl.symbols.eglCreateContext(
        this.display,
        config,
        null,
        new Int32Array([0x3098, 3, 0x30fb, 2, 0x30fd, 1, 0x3038]),
      );
      this.surface = this.egl.symbols.eglCreatePbufferSurface(
        this.display,
        config,
        new Int32Array([0x3057, 1, 0x3056, 1, 0x3038]),
      );
      if (
        !this.context || !this.surface ||
        !this.egl.symbols.eglMakeCurrent(this.display, this.surface, this.surface, this.context)
      ) throw Error(`EGL GL context failed: ${this.egl.symbols.eglGetError().toString(16)}`);
      const getProcAddress = (name: string) =>
        this.egl.symbols.eglGetProcAddress(new TextEncoder().encode(name + "\0"));
      gl.load(getProcAddress);
      this.glReady = true;
      const output = new Uint32Array(1);
      gl.GenTextures(1, output);
      this.texture = output[0];
      gl.BindTexture(gl.TEXTURE_2D, this.texture);
      gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const proc = (name: string) => {
        const p = this.egl.symbols.eglGetProcAddress(new TextEncoder().encode(name + "\0"));
        if (!p) throw Error(`EGL function missing: ${name}`);
        return p;
      };
      this.createImage = new Deno.UnsafeFnPointer(proc("eglCreateImageKHR") as never, {
        parameters: ["pointer", "pointer", "u32", "pointer", "buffer"],
        result: "pointer",
      });
      this.destroyImage = new Deno.UnsafeFnPointer(proc("eglDestroyImageKHR") as never, {
        parameters: ["pointer", "pointer"],
        result: "u32",
      });
      const bind = getProcAddress("glEGLImageTargetTexture2DOES");
      if (!bind) throw Error("GL DMA-BUF image import unavailable");
      this.bindImage = new Deno.UnsafeFnPointer(bind as never, {
        parameters: ["u32", "pointer"],
        result: "void",
      });
      gl.GenFramebuffers(2, this.buffers);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  update(frame: GpuMediaFrame) {
    const attributes = new Int32Array([
      0x3057,
      frame.width,
      0x3056,
      frame.height,
      0x3271,
      0x34325241,
      0x3272,
      frame.fd,
      0x3273,
      frame.offset,
      0x3274,
      frame.pitch,
      0x3443,
      0,
      0x3444,
      0,
      0x3038,
    ]);
    const image = this.createImage.call(this.display, null, 0x3270, null, attributes);
    if (!image) {
      throw Error(`EGL DMA-BUF import failed: ${this.egl.symbols.eglGetError().toString(16)}`);
    }
    const imported = new Uint32Array(1);
    gl.GenTextures(1, imported);
    try {
      gl.BindTexture(gl.TEXTURE_2D, imported[0]);
      this.bindImage.call(gl.TEXTURE_2D, image);
      gl.BindFramebuffer(gl.READ_FRAMEBUFFER, this.buffers[0]);
      gl.FramebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        imported[0],
        0,
      );
      if (gl.CheckFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw Error("DMA-BUF read framebuffer incomplete");
      }
      gl.BindTexture(gl.TEXTURE_2D, this.texture);
      if (this.width !== frame.width || this.height !== frame.height) {
        gl.TexImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          frame.width,
          frame.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        this.width = frame.width;
        this.height = frame.height;
      }
      gl.BindFramebuffer(gl.DRAW_FRAMEBUFFER, this.buffers[1]);
      gl.FramebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.texture,
        0,
      );
      if (gl.CheckFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw Error("Overlay framebuffer incomplete");
      }
      // Match the existing desktop upload: the top-down source becomes bottom-up GL storage.
      gl.BlitFramebuffer(
        0,
        0,
        frame.width,
        frame.height,
        0,
        frame.height,
        frame.width,
        0,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.Finish();
      const error = gl.GetError();
      if (error !== gl.NO_ERROR) throw Error(`GPU media copy failed: GL ${error}`);
    } finally {
      gl.BindFramebuffer(gl.FRAMEBUFFER, 0);
      gl.DeleteTextures(1, imported);
      this.destroyImage.call(this.display, image);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.glReady) {
      gl.Finish();
      gl.DeleteFramebuffers(2, this.buffers);
      gl.DeleteTextures(1, new Uint32Array([this.texture]));
    }
    this.egl.symbols.eglMakeCurrent(this.display, null, null, null);
    if (this.context) this.egl.symbols.eglDestroyContext(this.display, this.context);
    if (this.surface) this.egl.symbols.eglDestroySurface(this.display, this.surface);
    this.egl.symbols.eglTerminate(this.display);
    this.egl.close();
  }
}

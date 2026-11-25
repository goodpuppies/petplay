/**
 * Uploads BGRA desktop frames from {@link DesktopFrameShmReader} into an OpenGL `GL_RGBA8`
 * texture using dual ping-pong Pixel Buffer Objects (PBOs) with `glMapBufferRange`
 * (`INVALIDATE_BUFFER | UNSYNCHRONIZED`), plus hardware mipmaps + 16x anisotropic filtering.
 */
import { type DesktopCursorState, DesktopFrameShmReader } from "./desktopFrameShm.ts";

const GL_TEXTURE_2D = 0x0DE1;
const GL_RGBA8 = 0x8058;
const GL_BGRA = 0x80E1;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_LINEAR = 0x2601;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_CLAMP_TO_EDGE = 0x812F;
const GL_TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE;
const GL_PIXEL_UNPACK_BUFFER = 0x88EC;
const GL_STREAM_DRAW = 0x88E0;
const GL_UNPACK_ALIGNMENT = 0x0CF5;
const GL_TEXTURE_BINDING_2D = 0x8069;
const GL_PIXEL_UNPACK_BUFFER_BINDING = 0x88EF;
const GL_MAP_WRITE_BIT = 0x0002;
const GL_MAP_INVALIDATE_BUFFER_BIT = 0x0008;
const GL_MAP_UNSYNCHRONIZED_BIT = 0x0020;

type GlSymbols = {
  glGenTextures: (n: number, ids: Uint32Array) => void;
  glDeleteTextures: (n: number, ids: Uint32Array) => void;
  glBindTexture: (target: number, id: number) => void;
  glTexParameteri: (target: number, pname: number, param: number) => void;
  glTexParameterf: (target: number, pname: number, param: number) => void;
  glGenerateMipmap: (target: number) => void;
  glTexImage2D: (
    target: number,
    level: number,
    internalFormat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: Deno.PointerValue,
  ) => void;
  glTexSubImage2D: (
    target: number,
    level: number,
    xoffset: number,
    yoffset: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: Deno.PointerValue,
  ) => void;
  glPixelStorei: (pname: number, param: number) => void;
  glGetIntegerv: (pname: number, data: Int32Array) => void;
  glGenBuffers: (n: number, ids: Uint32Array) => void;
  glDeleteBuffers: (n: number, ids: Uint32Array) => void;
  glBindBuffer: (target: number, id: number) => void;
  glBufferData: (
    target: number,
    size: bigint,
    data: Deno.PointerValue,
    usage: number,
  ) => void;
  glBufferSubData: (
    target: number,
    offset: bigint,
    size: bigint,
    data: BufferSource,
  ) => void;
  glMapBufferRange: (
    target: number,
    offset: bigint,
    length: bigint,
    access: number,
  ) => Deno.PointerValue;
  glUnmapBuffer: (target: number) => number;
};

let cachedGl: GlSymbols | null = null;
function loadGl(): GlSymbols {
  if (cachedGl) return cachedGl;
  const lib = Deno.dlopen("libGL.so.1", {
    glGenTextures: { parameters: ["i32", "buffer"], result: "void" },
    glDeleteTextures: { parameters: ["i32", "buffer"], result: "void" },
    glBindTexture: { parameters: ["u32", "u32"], result: "void" },
    glTexParameteri: { parameters: ["u32", "u32", "i32"], result: "void" },
    glTexParameterf: { parameters: ["u32", "u32", "f32"], result: "void" },
    glGenerateMipmap: { parameters: ["u32"], result: "void" },
    glTexImage2D: {
      parameters: ["u32", "i32", "i32", "i32", "i32", "i32", "u32", "u32", "pointer"],
      result: "void",
    },
    glTexSubImage2D: {
      parameters: ["u32", "i32", "i32", "i32", "i32", "i32", "u32", "u32", "pointer"],
      result: "void",
    },
    glPixelStorei: { parameters: ["u32", "i32"], result: "void" },
    glGetIntegerv: { parameters: ["u32", "buffer"], result: "void" },
    glGenBuffers: { parameters: ["i32", "buffer"], result: "void" },
    glDeleteBuffers: { parameters: ["i32", "buffer"], result: "void" },
    glBindBuffer: { parameters: ["u32", "u32"], result: "void" },
    glBufferData: { parameters: ["u32", "isize", "pointer", "u32"], result: "void" },
    glBufferSubData: { parameters: ["u32", "isize", "isize", "buffer"], result: "void" },
    glMapBufferRange: {
      parameters: ["u32", "isize", "isize", "u32"],
      result: "pointer",
    },
    glUnmapBuffer: { parameters: ["u32"], result: "u8" },
  });
  cachedGl = lib.symbols as unknown as GlSymbols;
  return cachedGl;
}

export class DesktopTextureUploader {
  private readonly reader: DesktopFrameShmReader;
  private textureId = 0;
  private width = 0;
  private height = 0;
  private pbos = new Uint32Array(2);
  private pboBytes = 0;
  private pboIndex = 0;
  private readonly scratchInt = new Int32Array(1);
  lastUploadMs = 0;
  uploadCount = 0;

  constructor(shmPath?: string) {
    this.reader = new DesktopFrameShmReader(shmPath);
  }

  getTextureId(): number {
    return this.textureId;
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  readCursor(): DesktopCursorState {
    return this.reader.readCursor();
  }

  /**
   * Checks `/dev/shm` for a newer BGRA frame; if present, uploads it via a ping-pong mapped PBO
   * into `textureId` and regenerates mipmaps on the GPU.
   */
  update(): boolean {
    const frame = this.reader.pollFrame();
    if (!frame) return false;

    const t0 = performance.now();
    const gl = loadGl();
    gl.glGetIntegerv(GL_TEXTURE_BINDING_2D, this.scratchInt);
    const prevTex = this.scratchInt[0]!;
    gl.glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, this.scratchInt);
    const prevPbo = this.scratchInt[0]!;

    const byteSize = frame.width * frame.height * 4;
    if (this.textureId === 0) {
      const ids = new Uint32Array(1);
      gl.glGenTextures(1, ids);
      this.textureId = ids[0]!;
      gl.glGenBuffers(2, this.pbos);
    }

    const resized = this.width !== frame.width || this.height !== frame.height;
    gl.glBindTexture(GL_TEXTURE_2D, this.textureId);
    if (resized) {
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      gl.glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, 16.0);
      gl.glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
      gl.glTexImage2D(
        GL_TEXTURE_2D,
        0,
        GL_RGBA8,
        frame.width,
        frame.height,
        0,
        GL_BGRA,
        GL_UNSIGNED_BYTE,
        null,
      );
      this.width = frame.width;
      this.height = frame.height;
      this.pboBytes = byteSize;
      for (let i = 0; i < 2; i++) {
        gl.glBindBuffer(GL_PIXEL_UNPACK_BUFFER, this.pbos[i]!);
        gl.glBufferData(GL_PIXEL_UNPACK_BUFFER, BigInt(byteSize), null, GL_STREAM_DRAW);
      }
    }

    const pbo = this.pbos[this.pboIndex]!;
    this.pboIndex ^= 1;
    gl.glBindBuffer(GL_PIXEL_UNPACK_BUFFER, pbo);
    const mapped = gl.glMapBufferRange(
      GL_PIXEL_UNPACK_BUFFER,
      0n,
      BigInt(byteSize),
      GL_MAP_WRITE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT | GL_MAP_UNSYNCHRONIZED_BIT,
    );
    if (mapped) {
      const dst = new Uint8Array(new Deno.UnsafePointerView(mapped).getArrayBuffer(byteSize));
      dst.set(frame.pixels);
      gl.glUnmapBuffer(GL_PIXEL_UNPACK_BUFFER);
    } else {
      gl.glBufferData(GL_PIXEL_UNPACK_BUFFER, BigInt(this.pboBytes), null, GL_STREAM_DRAW);
      gl.glBufferSubData(
        GL_PIXEL_UNPACK_BUFFER,
        0n,
        BigInt(byteSize),
        frame.pixels as unknown as BufferSource,
      );
    }
    gl.glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    gl.glTexSubImage2D(
      GL_TEXTURE_2D,
      0,
      0,
      0,
      frame.width,
      frame.height,
      GL_BGRA,
      GL_UNSIGNED_BYTE,
      null,
    );
    gl.glGenerateMipmap(GL_TEXTURE_2D);

    gl.glBindBuffer(GL_PIXEL_UNPACK_BUFFER, prevPbo);
    gl.glBindTexture(GL_TEXTURE_2D, prevTex);

    this.lastUploadMs = performance.now() - t0;
    this.uploadCount++;
    return true;
  }

  dispose(): void {
    this.reader.close();
    if (this.textureId !== 0) {
      try {
        const gl = loadGl();
        gl.glDeleteTextures(1, new Uint32Array([this.textureId]));
        gl.glDeleteBuffers(2, this.pbos);
      } catch {
        // Ignore teardown errors when GL context is already gone.
      }
      this.textureId = 0;
      this.width = 0;
      this.height = 0;
      this.pboBytes = 0;
    }
  }
}

import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import {
  createWindow,
  DwmWindow,
  getProcAddress,
} from "@gfx/dwm";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type { MappedTextureReadback } from "./webgpu.ts";

function assertPointer<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function getGlErrorLabel(error: number): string {
  switch (error) {
    case gl.NO_ERROR:
      return "GL_NO_ERROR";
    case gl.INVALID_ENUM:
      return "GL_INVALID_ENUM";
    case gl.INVALID_VALUE:
      return "GL_INVALID_VALUE";
    case gl.INVALID_OPERATION:
      return "GL_INVALID_OPERATION";
    case gl.INVALID_FRAMEBUFFER_OPERATION:
      return "GL_INVALID_FRAMEBUFFER_OPERATION";
    case gl.OUT_OF_MEMORY:
      return "GL_OUT_OF_MEMORY";
    default:
      return `GL_ERROR_${error}`;
  }
}

function normalizeU32(value: number): number {
  return (Math.trunc(value) >>> 0);
}

function readGlString(pointer: Deno.PointerValue | null, maxBytes = 128): string {
  if (!pointer) {
    return "null";
  }

  try {
    const bytes = new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(pointer, maxBytes));
    let length = bytes.indexOf(0);
    if (length < 0) {
      length = bytes.length;
    }
    return new TextDecoder().decode(bytes.slice(0, length));
  } catch {
    return "unreadable";
  }
}

export class WebXROverlayGl {
  private window: DwmWindow | null = null;
  private textureHandle: number | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  private readonly uniqueId = crypto.randomUUID().slice(0, 8);

  initialize(name = "WebXR Overlay") {
    if (this.window) {
      return;
    }

    this.window = createWindow({
      title: `${name}_${this.uniqueId}`,
      width: 1,
      height: 1,
      resizable: false,
      visible: false,
      glVersion: [4, 6],
      gles: false,
    });

    gl.load(getProcAddress);
    this.makeCurrent();
    const versionPtr = gl.GetString(gl.VERSION) as Deno.PointerValue | null;
    const vendorPtr = gl.GetString(gl.VENDOR) as Deno.PointerValue | null;
    LogChannel.log(
      "webxrv2",
      `[webxr] gl init version=${readGlString(versionPtr)} vendor=${readGlString(vendorPtr)}`,
    );
  }

  getTextureHandle(): number {
    return assertPointer(this.textureHandle, "OpenGL texture not initialized");
  }

  private makeCurrent() {
    assertPointer(this.window, "OpenGL window not initialized").makeContextCurrent();
  }

  hasTexture(): boolean {
    return this.textureHandle != null;
  }

  ensureTexture(width: number, height: number) {
    this.makeCurrent();
    if (this.textureHandle != null) {
      return;
    }

    const texture = new Uint32Array(1);
    gl.GenTextures(1, texture);
    this.textureHandle = normalizeU32(texture[0]);
    gl.BindTexture(gl.TEXTURE_2D, this.textureHandle);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.PixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.TexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.BindTexture(gl.TEXTURE_2D, 0);
    gl.Finish();
    this.textureWidth = width;
    this.textureHeight = height;
  }

  uploadMappedFrame(frame: MappedTextureReadback) {
    this.makeCurrent();
    this.ensureTexture(frame.width, frame.height);
    if (this.textureWidth !== frame.width || this.textureHeight !== frame.height) {
      throw new Error(
        `Live overlay texture size changed from ${this.textureWidth}x${this.textureHeight} to ${frame.width}x${frame.height}`,
      );
    }

    const sourceFormat = frame.format === "bgra" ? gl.BGRA : gl.RGBA;
    const unpackRowLength = Math.floor(frame.bytesPerRow / 4);
    const texture = assertPointer(this.textureHandle, "OpenGL texture not initialized");
    gl.BindTexture(gl.TEXTURE_2D, texture);
    gl.PixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.PixelStorei(gl.UNPACK_ROW_LENGTH, unpackRowLength);
    gl.TexSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      frame.width,
      frame.height,
      sourceFormat,
      gl.UNSIGNED_BYTE,
      frame.rawPointer,
    );
    gl.PixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.BindTexture(gl.TEXTURE_2D, 0);
    gl.Finish();
  }

  getTextureSize() {
    return {
      width: this.textureWidth,
      height: this.textureHeight,
    };
  }

  describeTexture() {
    this.makeCurrent();
    const texture = assertPointer(this.textureHandle, "OpenGL texture not initialized");
    const isTexture = gl.IsTexture(texture);
    gl.BindTexture(gl.TEXTURE_2D, texture);
    const width = new Int32Array(1);
    const height = new Int32Array(1);
    const internalFormat = new Int32Array(1);
    gl.GetTexLevelParameteriv(gl.TEXTURE_2D, 0, gl.TEXTURE_WIDTH, width);
    gl.GetTexLevelParameteriv(gl.TEXTURE_2D, 0, gl.TEXTURE_HEIGHT, height);
    gl.GetTexLevelParameteriv(gl.TEXTURE_2D, 0, gl.TEXTURE_INTERNAL_FORMAT, internalFormat);
    gl.BindTexture(gl.TEXTURE_2D, 0);
    const error = gl.GetError();
    return {
      handle: texture,
      isTexture,
      width: width[0],
      height: height[0],
      internalFormat: internalFormat[0],
      glError: error,
      glErrorLabel: getGlErrorLabel(error),
    };
  }

  cleanup() {
    if (this.window) {
      this.makeCurrent();
    }
    if (this.textureHandle != null) {
      gl.DeleteTextures(1, new Uint32Array([this.textureHandle]));
      this.textureHandle = null;
    }
    if (this.window) {
      this.window.close();
      this.window = null;
    }
    this.textureWidth = 0;
    this.textureHeight = 0;
  }
}

import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress } from "@gfx/dwm";
import { cstr } from "https://deno.land/x/dwm@0.3.4/src/platform/glfw/ffi.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type { MappedTextureReadback, StereoMappedTextureReadback } from "./webgpu.ts";

const VARGGLES_VERTEX_SHADER = `#version 450
layout (location = 0) out vec2 uv;

const vec2 positions[4] = vec2[](
    vec2(-1.0, -1.0), vec2( 1.0, -1.0),
    vec2(-1.0,  1.0), vec2( 1.0,  1.0)
);
const vec2 uvs_in[4] = vec2[](
    vec2(0.0, 0.0), vec2(1.0, 0.0),
    vec2(0.0, 1.0), vec2(1.0, 1.0)
);

out gl_PerVertex { vec4 gl_Position; };

void main() {
    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    uv = uvs_in[gl_VertexID];
}
`;

const VARGGLES_FRAGMENT_SHADER = `#version 450
layout (location = 0) in vec2 uv;
layout (binding = 0) uniform sampler2D eyeLeft;
layout (binding = 1) uniform sampler2D eyeRight;
uniform mat4 lookRotation;
uniform float halfFOVInRadians;
layout (location = 0) out vec4 outColor;

const float PI = 3.141592653589793;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

void main() {
    vec2 xy = vec2(uv.x, 1.0 - uv.y);
    vec2 angles = (2.0 * xy - vec2(1.0, 1.0)) * vec2(PI, HALF_PI);
    angles.y *= 2.0;

    bool renderTopHalf = angles.y >= 0.0;
    if (renderTopHalf) {
        angles.y -= HALF_PI;
    } else {
        angles.y += HALF_PI;
    }

    float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI);
    vec3 lookupDirection = vec3(sin(angles.x), 1.0, cos(angles.x)) *
        vec3(cos(angles.y), sin(angles.y), cos(angles.y));
    lookupDirection = (lookRotation * vec4(lookupDirection, 0.0)).xyz;

    float u = (((lookupDirection.x / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5;
    float v = 1.0 - ((((lookupDirection.y / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5);
    vec2 eyeUv = clamp(vec2(u, v), 0.0, 1.0);

    if (renderTopHalf) {
        outColor = texture(eyeLeft, eyeUv);
    } else {
        outColor = texture(eyeRight, eyeUv);
    }
}
`;

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
  return Math.trunc(value) >>> 0;
}

type OverlayGlSyncMode = "finish" | "flush" | "none";

function getOverlayGlSyncMode(): OverlayGlSyncMode {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-gl-sync="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "flush":
      return "flush";
    case "none":
      return "none";
    case "finish":
    case undefined:
    case "":
      return "flush";
    default:
      LogChannel.log(
        "webxrv2",
        `[webxr] unknown --webxr-gl-sync=${configured}, defaulting to flush`,
      );
      return "flush";
  }
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

function compileShader(source: string, type: gl.GLenum): number {
  const shader = gl.CreateShader(type);
  if (!shader || shader === 0) {
    throw new Error(`CreateShader failed for type=${type}`);
  }

  const encodedSource = new TextEncoder().encode(source);
  const sourcePtr = Deno.UnsafePointer.of(encodedSource);
  if (!sourcePtr) {
    gl.DeleteShader(shader);
    throw new Error("Failed to create shader source pointer");
  }
  const sourcePointerArray = new BigUint64Array([BigInt(Deno.UnsafePointer.value(sourcePtr))]);
  gl.ShaderSource(
    shader,
    1,
    new Uint8Array(sourcePointerArray.buffer),
    new Int32Array([source.length]),
  );
  gl.CompileShader(shader);

  const compileStatus = new Int32Array(1);
  gl.GetShaderiv(shader, gl.COMPILE_STATUS, compileStatus);
  if (compileStatus[0] === gl.FALSE) {
    const infoLogLength = new Int32Array(1);
    gl.GetShaderiv(shader, gl.INFO_LOG_LENGTH, infoLogLength);
    const infoLog = new Uint8Array(Math.max(1, infoLogLength[0]));
    const writtenLength = new Int32Array(1);
    gl.GetShaderInfoLog(shader, infoLog.length, writtenLength, infoLog);
    gl.DeleteShader(shader);
    throw new Error(
      `Shader compile failed: ${new TextDecoder().decode(infoLog.slice(0, writtenLength[0]))}`,
    );
  }

  return normalizeU32(shader);
}

function linkProgram(vertexShader: number, fragmentShader: number): number {
  const program = gl.CreateProgram();
  if (!program || program === 0) {
    throw new Error("CreateProgram failed");
  }

  gl.AttachShader(program, vertexShader);
  gl.AttachShader(program, fragmentShader);
  gl.LinkProgram(program);

  const linkStatus = new Int32Array(1);
  gl.GetProgramiv(program, gl.LINK_STATUS, linkStatus);
  if (linkStatus[0] === gl.FALSE) {
    const infoLogLength = new Int32Array(1);
    gl.GetProgramiv(program, gl.INFO_LOG_LENGTH, infoLogLength);
    const infoLog = new Uint8Array(Math.max(1, infoLogLength[0]));
    const writtenLength = new Int32Array(1);
    gl.GetProgramInfoLog(program, infoLog.length, writtenLength, infoLog);
    gl.DeleteProgram(program);
    throw new Error(
      `Program link failed: ${new TextDecoder().decode(infoLog.slice(0, writtenLength[0]))}`,
    );
  }

  gl.DetachShader(program, vertexShader);
  gl.DetachShader(program, fragmentShader);
  return normalizeU32(program);
}

function allocateTexture(width: number, height: number, filter: number): number {
  const texture = new Uint32Array(1);
  gl.GenTextures(1, texture);
  const textureHandle = normalizeU32(texture[0]);
  gl.BindTexture(gl.TEXTURE_2D, textureHandle);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.TexImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  gl.BindTexture(gl.TEXTURE_2D, 0);
  return textureHandle;
}

export class WebXROverlayGl {
  private window: DwmWindow | null = null;
  private outputTextureHandle: number | null = null;
  private leftTextureHandle: number | null = null;
  private rightTextureHandle: number | null = null;
  private framebufferHandle: number | null = null;
  private vaoHandle: number | null = null;
  private shaderProgram: number | null = null;
  private lookRotationUniform: number | null = null;
  private halfFovUniform: number | null = null;
  private outputWidth = 0;
  private outputHeight = 0;
  private eyeWidth = 0;
  private eyeHeight = 0;
  private readonly uniqueId = crypto.randomUUID().slice(0, 8);
  private readonly syncMode = getOverlayGlSyncMode();
  private uploadStateInitialized = false;
  private lastUnpackRowLength = -1;
  private currentFramebuffer: number | null = null;
  private currentProgram: number | null = null;
  private currentVertexArray: number | null = null;
  private currentActiveTextureUnit = gl.TEXTURE0;
  private readonly currentTexturesByUnit = new Map<number, number | null>();
  private viewportWidth = -1;
  private viewportHeight = -1;

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
    this.initializeProgram();
    const versionPtr = gl.GetString(gl.VERSION) as Deno.PointerValue | null;
    const vendorPtr = gl.GetString(gl.VENDOR) as Deno.PointerValue | null;
    LogChannel.log(
      "webxrv2",
      `[webxr] gl init version=${readGlString(versionPtr)} vendor=${
        readGlString(vendorPtr)
      } sync=${this.syncMode}`,
    );
  }

  getTextureHandle(): number {
    return assertPointer(this.outputTextureHandle, "OpenGL output texture not initialized");
  }

  private makeCurrent() {
    assertPointer(this.window, "OpenGL window not initialized").makeContextCurrent();
  }

  private initializeProgram() {
    if (this.shaderProgram != null) {
      return;
    }

    const vertexShader = compileShader(VARGGLES_VERTEX_SHADER, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(VARGGLES_FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
    try {
      this.shaderProgram = linkProgram(vertexShader, fragmentShader);
    } finally {
      gl.DeleteShader(vertexShader);
      gl.DeleteShader(fragmentShader);
    }

    const vao = new Uint32Array(1);
    gl.GenVertexArrays(1, vao);
    this.vaoHandle = normalizeU32(vao[0]);
    this.lookRotationUniform = gl.GetUniformLocation(this.shaderProgram, cstr("lookRotation"));
    this.halfFovUniform = gl.GetUniformLocation(this.shaderProgram, cstr("halfFOVInRadians"));

    gl.UseProgram(this.shaderProgram);
    gl.Uniform1i(gl.GetUniformLocation(this.shaderProgram, cstr("eyeLeft")), 0);
    gl.Uniform1i(gl.GetUniformLocation(this.shaderProgram, cstr("eyeRight")), 1);
    gl.UseProgram(0);
  }

  hasTexture(): boolean {
    return this.outputTextureHandle != null;
  }

  ensureTexture(eyeWidth: number, eyeHeight: number) {
    this.makeCurrent();
    if (this.outputTextureHandle != null) {
      if (this.eyeWidth !== eyeWidth || this.eyeHeight !== eyeHeight) {
        throw new Error(
          `Live overlay eye size changed from ${this.eyeWidth}x${this.eyeHeight} to ${eyeWidth}x${eyeHeight}`,
        );
      }
      return;
    }

    if (eyeWidth !== eyeHeight) {
      throw new Error(`Varggles path expects square eye textures, got ${eyeWidth}x${eyeHeight}`);
    }

    this.eyeWidth = eyeWidth;
    this.eyeHeight = eyeHeight;
    this.outputWidth = eyeWidth * 2;
    this.outputHeight = eyeWidth * 2;
    this.leftTextureHandle = allocateTexture(eyeWidth, eyeHeight, gl.LINEAR);
    this.rightTextureHandle = allocateTexture(eyeWidth, eyeHeight, gl.LINEAR);
    this.outputTextureHandle = allocateTexture(this.outputWidth, this.outputHeight, gl.LINEAR);

    const framebuffer = new Uint32Array(1);
    gl.GenFramebuffers(1, framebuffer);
    this.framebufferHandle = normalizeU32(framebuffer[0]);
    gl.BindFramebuffer(gl.FRAMEBUFFER, this.framebufferHandle);
    gl.FramebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.outputTextureHandle,
      0,
    );
    const status = gl.CheckFramebufferStatus(gl.FRAMEBUFFER);
    gl.BindFramebuffer(gl.FRAMEBUFFER, 0);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`OpenGL framebuffer incomplete: ${status}`);
    }

    gl.PixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.uploadStateInitialized = true;
    this.lastUnpackRowLength = -1;
    gl.Finish();
  }

  private uploadEyeTexture(texture: number, frame: MappedTextureReadback) {
    const sourceFormat = frame.format === "bgra" ? gl.BGRA : gl.RGBA;
    const unpackRowLength = Math.floor(frame.bytesPerRow / 4);
    this.bindTexture(this.currentActiveTextureUnit, texture);
    if (!this.uploadStateInitialized) {
      gl.PixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.uploadStateInitialized = true;
    }
    if (this.lastUnpackRowLength !== unpackRowLength) {
      gl.PixelStorei(gl.UNPACK_ROW_LENGTH, unpackRowLength);
      this.lastUnpackRowLength = unpackRowLength;
    }
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
  }

  private applyFrameSync() {
    switch (this.syncMode) {
      case "finish":
        gl.Finish();
        break;
      case "flush":
        gl.Flush();
        break;
      case "none":
        break;
    }
  }

  private bindFramebuffer(framebuffer: number | null) {
    if (this.currentFramebuffer === framebuffer) {
      return;
    }
    gl.BindFramebuffer(gl.FRAMEBUFFER, framebuffer ?? 0);
    this.currentFramebuffer = framebuffer;
  }

  private useProgram(program: number | null) {
    if (this.currentProgram === program) {
      return;
    }
    gl.UseProgram(program ?? 0);
    this.currentProgram = program;
  }

  private bindVertexArray(vertexArray: number | null) {
    if (this.currentVertexArray === vertexArray) {
      return;
    }
    gl.BindVertexArray(vertexArray ?? 0);
    this.currentVertexArray = vertexArray;
  }

  private activeTexture(textureUnit: number) {
    if (this.currentActiveTextureUnit === textureUnit) {
      return;
    }
    gl.ActiveTexture(textureUnit);
    this.currentActiveTextureUnit = textureUnit;
  }

  private bindTexture(textureUnit: number, texture: number | null) {
    this.activeTexture(textureUnit);
    if (this.currentTexturesByUnit.get(textureUnit) === texture) {
      return;
    }
    gl.BindTexture(gl.TEXTURE_2D, texture ?? 0);
    this.currentTexturesByUnit.set(textureUnit, texture);
  }

  private setViewport(width: number, height: number) {
    if (this.viewportWidth === width && this.viewportHeight === height) {
      return;
    }
    gl.Viewport(0, 0, width, height);
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  uploadStereoFrame(frame: StereoMappedTextureReadback) {
    this.makeCurrent();
    this.ensureTexture(frame.left.width, frame.left.height);

    if (
      frame.left.width !== frame.right.width ||
      frame.left.height !== frame.right.height
    ) {
      throw new Error("Stereo eye sizes do not match");
    }

    this.uploadEyeTexture(
      assertPointer(this.leftTextureHandle, "Left texture not initialized"),
      frame.left,
    );
    this.uploadEyeTexture(
      assertPointer(this.rightTextureHandle, "Right texture not initialized"),
      frame.right,
    );

    this.bindFramebuffer(
      assertPointer(this.framebufferHandle, "OpenGL framebuffer not initialized"),
    );
    this.setViewport(this.outputWidth, this.outputHeight);
    this.useProgram(assertPointer(this.shaderProgram, "OpenGL shader program not initialized"));
    this.bindVertexArray(assertPointer(this.vaoHandle, "OpenGL VAO not initialized"));

    if (this.lookRotationUniform !== null && this.lookRotationUniform !== -1) {
      gl.UniformMatrix4fv(this.lookRotationUniform, 1, 0, frame.lookRotation);
    }
    if (this.halfFovUniform !== null && this.halfFovUniform !== -1) {
      gl.Uniform1f(this.halfFovUniform, frame.halfFovInRadians);
    }

    this.bindTexture(gl.TEXTURE0, assertPointer(this.leftTextureHandle, "Left texture missing"));
    this.bindTexture(gl.TEXTURE1, assertPointer(this.rightTextureHandle, "Right texture missing"));
    gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.applyFrameSync();
  }

  getTextureSize() {
    return {
      width: this.outputWidth,
      height: this.outputHeight,
    };
  }

  describeTexture() {
    this.makeCurrent();
    const texture = assertPointer(this.outputTextureHandle, "OpenGL texture not initialized");
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
    if (this.framebufferHandle != null) {
      gl.DeleteFramebuffers(1, new Uint32Array([this.framebufferHandle]));
      this.framebufferHandle = null;
    }
    if (this.outputTextureHandle != null) {
      gl.DeleteTextures(1, new Uint32Array([this.outputTextureHandle]));
      this.outputTextureHandle = null;
    }
    if (this.leftTextureHandle != null) {
      gl.DeleteTextures(1, new Uint32Array([this.leftTextureHandle]));
      this.leftTextureHandle = null;
    }
    if (this.rightTextureHandle != null) {
      gl.DeleteTextures(1, new Uint32Array([this.rightTextureHandle]));
      this.rightTextureHandle = null;
    }
    if (this.vaoHandle != null) {
      gl.DeleteVertexArrays(1, new Uint32Array([this.vaoHandle]));
      this.vaoHandle = null;
    }
    if (this.shaderProgram != null) {
      gl.DeleteProgram(this.shaderProgram);
      this.shaderProgram = null;
    }
    if (this.window) {
      this.window.close();
      this.window = null;
    }
    this.lookRotationUniform = null;
    this.halfFovUniform = null;
    this.outputWidth = 0;
    this.outputHeight = 0;
    this.eyeWidth = 0;
    this.eyeHeight = 0;
    this.uploadStateInitialized = false;
    this.lastUnpackRowLength = -1;
    this.currentFramebuffer = null;
    this.currentProgram = null;
    this.currentVertexArray = null;
    this.currentActiveTextureUnit = gl.TEXTURE0;
    this.currentTexturesByUnit.clear();
    this.viewportWidth = -1;
    this.viewportHeight = -1;
  }
}

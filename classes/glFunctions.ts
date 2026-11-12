/**
 * OpenGL functions for code that draws inside raylib's frame, beyond what rlgl wraps (integer
 * textures, integer vertex attributes, instancing at an offset).
 *
 * The pointers come from raylib itself: its glad loader fills `glad_gl*` variables, which every
 * raylib build we ship exports (Linux x86-64 and ARM64, Windows). They point into the context raylib
 * created, so this needs no GL library or platform loader of its own (`wglGetProcAddress` on
 * Windows, where `opengl32.dll` only exports GL 1.1). Read them once raylib's window exists.
 */
import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";

const SIGNATURES = {
  glActiveTexture: { parameters: ["u32"], result: "void" },
  glAttachShader: { parameters: ["u32", "u32"], result: "void" },
  glBindBuffer: { parameters: ["u32", "u32"], result: "void" },
  glBindTexture: { parameters: ["u32", "u32"], result: "void" },
  glBindVertexArray: { parameters: ["u32"], result: "void" },
  glBlendEquationSeparate: { parameters: ["u32", "u32"], result: "void" },
  glBlendFuncSeparate: { parameters: ["u32", "u32", "u32", "u32"], result: "void" },
  glBufferData: { parameters: ["u32", "isize", "pointer", "u32"], result: "void" },
  glCompileShader: { parameters: ["u32"], result: "void" },
  glCreateProgram: { parameters: [], result: "u32" },
  glCreateShader: { parameters: ["u32"], result: "u32" },
  glDeleteBuffers: { parameters: ["i32", "buffer"], result: "void" },
  glDeleteProgram: { parameters: ["u32"], result: "void" },
  glDeleteShader: { parameters: ["u32"], result: "void" },
  glDeleteTextures: { parameters: ["i32", "buffer"], result: "void" },
  glDeleteVertexArrays: { parameters: ["i32", "buffer"], result: "void" },
  glDepthMask: { parameters: ["u8"], result: "void" },
  glDisable: { parameters: ["u32"], result: "void" },
  glDrawArraysInstanced: { parameters: ["u32", "i32", "i32", "i32"], result: "void" },
  glEnable: { parameters: ["u32"], result: "void" },
  glEnableVertexAttribArray: { parameters: ["u32"], result: "void" },
  glGenBuffers: { parameters: ["i32", "buffer"], result: "void" },
  glGenTextures: { parameters: ["i32", "buffer"], result: "void" },
  glGenVertexArrays: { parameters: ["i32", "buffer"], result: "void" },
  glGetBooleanv: { parameters: ["u32", "buffer"], result: "void" },
  glGetIntegerv: { parameters: ["u32", "buffer"], result: "void" },
  glGetProgramInfoLog: { parameters: ["u32", "i32", "buffer", "buffer"], result: "void" },
  glGetProgramiv: { parameters: ["u32", "u32", "buffer"], result: "void" },
  glGetShaderInfoLog: { parameters: ["u32", "i32", "buffer", "buffer"], result: "void" },
  glGetShaderiv: { parameters: ["u32", "u32", "buffer"], result: "void" },
  glGetUniformLocation: { parameters: ["u32", "buffer"], result: "i32" },
  glIsEnabled: { parameters: ["u32"], result: "u8" },
  glLinkProgram: { parameters: ["u32"], result: "void" },
  glPixelStorei: { parameters: ["u32", "i32"], result: "void" },
  glShaderSource: { parameters: ["u32", "i32", "buffer", "buffer"], result: "void" },
  glTexImage2D: {
    parameters: ["u32", "i32", "i32", "i32", "i32", "i32", "u32", "u32", "buffer"],
    result: "void",
  },
  glTexParameteri: { parameters: ["u32", "u32", "i32"], result: "void" },
  glUniform1f: { parameters: ["i32", "f32"], result: "void" },
  glUniform1i: { parameters: ["i32", "i32"], result: "void" },
  glUniform2f: { parameters: ["i32", "f32", "f32"], result: "void" },
  glUseProgram: { parameters: ["u32"], result: "void" },
  glVertexAttribDivisor: { parameters: ["u32", "u32"], result: "void" },
  glVertexAttribIPointer: {
    parameters: ["u32", "i32", "u32", "i32", "pointer"],
    result: "void",
  },
  glVertexAttribPointer: {
    parameters: ["u32", "i32", "u32", "u8", "i32", "pointer"],
    result: "void",
  },
} as const satisfies Record<string, Deno.UnsafeCallbackDefinition>;

type Signatures = typeof SIGNATURES;
export type GlFunctions = {
  [K in keyof Signatures]: (
    ...args: Deno.ToNativeParameterTypes<Signatures[K]["parameters"]>
  ) => Deno.FromNativeResultType<Signatures[K]["result"]>;
};

let cached: GlFunctions | null = null;

/** The GL functions of raylib's context. Throws when raylib has not loaded GL yet. */
export function loadGlFunctions(): GlFunctions {
  if (cached != null) return cached;
  const statics = Object.fromEntries(
    Object.keys(SIGNATURES).map((name) => [`glad_${name}`, { type: "pointer" as const }]),
  );
  // The same path raylib was loaded from, so this is the same loaded library and its variables.
  const library = Deno.dlopen(getRaylibLibraryPath(), statics);
  const functions: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(SIGNATURES)) {
    // A `pointer` static is the variable's address; the function pointer is the value stored in it.
    const variable = (library.symbols as Record<string, Deno.PointerValue>)[`glad_${name}`];
    if (variable == null) throw new Error(`raylib does not export glad_${name}`);
    const pointer = Deno.UnsafePointer.create(new Deno.UnsafePointerView(variable).getBigUint64());
    if (pointer == null) {
      throw new Error(`OpenGL function ${name} is not loaded; create raylib's window first`);
    }
    const fn = new Deno.UnsafeFnPointer(
      pointer as Deno.PointerObject<Deno.UnsafeCallbackDefinition>,
      definition as Deno.UnsafeCallbackDefinition,
    );
    functions[name] = fn.call.bind(fn);
  }
  // The library stays open: closing it would let the loader drop raylib while these are in use.
  cached = functions as GlFunctions;
  return cached;
}

/** A null-terminated C string for FFI `buffer` parameters. */
export function cString(text: string): Uint8Array {
  return new TextEncoder().encode(`${text}\0`);
}

/** An offset into the bound buffer, for the `pointer` parameters of the attribute calls. */
export function bufferOffset(bytes: number): Deno.PointerValue {
  return bytes === 0 ? null : Deno.UnsafePointer.create(BigInt(bytes));
}

/** Compiles and links a program; throws with the driver's log on failure. */
export function linkProgram(gl: GlFunctions, vertex: string, fragment: string): number {
  const compile = (type: number, source: string) => {
    const shader = gl.glCreateShader(type);
    const text = cString(source);
    const sources = new BigUint64Array([
      BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(text))),
    ]);
    gl.glShaderSource(shader, 1, sources, new Int32Array([text.length - 1]));
    gl.glCompileShader(shader);
    const status = new Int32Array(1);
    gl.glGetShaderiv(shader, GL.COMPILE_STATUS, status);
    if (status[0] === 0) {
      const log = infoLog((size, length, out) => gl.glGetShaderInfoLog(shader, size, length, out));
      gl.glDeleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
  };
  const vs = compile(GL.VERTEX_SHADER, vertex);
  let fs: number;
  try {
    fs = compile(GL.FRAGMENT_SHADER, fragment);
  } catch (error) {
    gl.glDeleteShader(vs);
    throw error;
  }
  const program = gl.glCreateProgram();
  gl.glAttachShader(program, vs);
  gl.glAttachShader(program, fs);
  gl.glLinkProgram(program);
  gl.glDeleteShader(vs);
  gl.glDeleteShader(fs);
  const status = new Int32Array(1);
  gl.glGetProgramiv(program, GL.LINK_STATUS, status);
  if (status[0] === 0) {
    const log = infoLog((size, length, out) => gl.glGetProgramInfoLog(program, size, length, out));
    gl.glDeleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

function infoLog(read: (size: number, length: Int32Array, out: Uint8Array) => void): string {
  const out = new Uint8Array(4096);
  const length = new Int32Array(1);
  read(out.length, length, out);
  return new TextDecoder().decode(out.subarray(0, length[0]));
}

/** The GL enums used here. */
export const GL = {
  ACTIVE_TEXTURE: 0x84E0,
  ARRAY_BUFFER: 0x8892,
  ARRAY_BUFFER_BINDING: 0x8894,
  BLEND: 0x0BE2,
  BLEND_DST_ALPHA: 0x80CA,
  BLEND_DST_RGB: 0x80C8,
  BLEND_EQUATION_ALPHA: 0x883D,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_SRC_ALPHA: 0x80CB,
  BLEND_SRC_RGB: 0x80C9,
  CLAMP_TO_EDGE: 0x812F,
  COMPILE_STATUS: 0x8B81,
  CULL_FACE: 0x0B44,
  CURRENT_PROGRAM: 0x8B8D,
  DEPTH_TEST: 0x0B71,
  DEPTH_WRITEMASK: 0x0B72,
  FLOAT: 0x1406,
  FRAGMENT_SHADER: 0x8B30,
  FRAMEBUFFER_SRGB: 0x8DB9,
  FUNC_ADD: 0x8006,
  HALF_FLOAT: 0x140B,
  LINK_STATUS: 0x8B82,
  NEAREST: 0x2600,
  ONE: 1,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  PIXEL_UNPACK_BUFFER: 0x88EC,
  PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
  R16UI: 0x8234,
  R32UI: 0x8236,
  RED_INTEGER: 0x8D94,
  RGBA: 0x1908,
  RGBA16F: 0x881A,
  SCISSOR_TEST: 0x0C11,
  SRC_ALPHA: 0x0302,
  STATIC_DRAW: 0x88E4,
  STENCIL_TEST: 0x0B90,
  STREAM_DRAW: 0x88E0,
  TEXTURE0: 0x84C0,
  TEXTURE_2D: 0x0DE1,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TRIANGLES: 0x0004,
  UNPACK_ALIGNMENT: 0x0CF5,
  UNSIGNED_INT: 0x1405,
  UNSIGNED_SHORT: 0x1403,
  VERTEX_ARRAY_BINDING: 0x85B5,
  VERTEX_SHADER: 0x8B31,
  VIEWPORT: 0x0BA2,
} as const;

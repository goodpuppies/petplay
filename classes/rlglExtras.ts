import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";

const RLGL_EXTRA_SYMBOLS = {
  rlSetBlendFactorsSeparate: {
    parameters: ["i32", "i32", "i32", "i32", "i32", "i32"],
    result: "void",
  },
  rlDrawRenderBatchActive: {
    parameters: [],
    result: "void",
  },
  rlViewport: {
    parameters: ["i32", "i32", "i32", "i32"],
    result: "void",
  },
} as const;

let rlglExtras: Deno.DynamicLibrary<typeof RLGL_EXTRA_SYMBOLS> | null = null;

function getRlglExtras(): Deno.DynamicLibrary<typeof RLGL_EXTRA_SYMBOLS> {
  return (rlglExtras ??= Deno.dlopen(getRaylibLibraryPath(), RLGL_EXTRA_SYMBOLS));
}

/** Configure separate RGB/alpha blend factors and equations for `BLEND_CUSTOM_SEPARATE`. */
export function rlSetBlendFactorsSeparate(
  glSrcRGB: number,
  glDstRGB: number,
  glSrcAlpha: number,
  glDstAlpha: number,
  glEqRGB: number,
  glEqAlpha: number,
): void {
  getRlglExtras().symbols.rlSetBlendFactorsSeparate(
    glSrcRGB,
    glDstRGB,
    glSrcAlpha,
    glDstAlpha,
    glEqRGB,
    glEqAlpha,
  );
}

/** Flush raylib's active rlgl render batch before issuing direct GL calls. */
export function rlDrawRenderBatchActive(): void {
  getRlglExtras().symbols.rlDrawRenderBatchActive();
}

/**
 * Restrict drawing to part of the bound render target (`glViewport`), e.g. two eye images side by
 * side in one texture. `BeginTextureMode` sets the full target again; `BeginMode3D` leaves it.
 */
export function rlViewport(x: number, y: number, width: number, height: number): void {
  getRlglExtras().symbols.rlViewport(x, y, width, height);
}

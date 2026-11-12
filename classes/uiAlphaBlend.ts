import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";

let rlgl:
  | Deno.DynamicLibrary<{
    rlSetBlendFactorsSeparate: {
      parameters: ["i32", "i32", "i32", "i32", "i32", "i32"];
      result: "void";
    };
  }>
  | null = null;

/** Straight-alpha UI colors over a render target whose alpha must retain coverage.
 * Raylib's BLEND_ALPHA also multiplies source alpha by itself: a half-covered
 * edge over an opaque panel would lower destination alpha from 1 to 0.75.
 * RGB still uses ordinary source-over; alpha uses As + Ad * (1 - As).
 * Pair with EndBlendMode() after the UI pass to restore Raylib's default.
 */
export function beginUiAlphaBlend(): void {
  rlgl ??= Deno.dlopen(getRaylibLibraryPath(), {
    rlSetBlendFactorsSeparate: {
      parameters: ["i32", "i32", "i32", "i32", "i32", "i32"],
      result: "void",
    },
  });
  const SRC_ALPHA = 0x0302, ONE_MINUS_SRC_ALPHA = 0x0303, ONE = 1, FUNC_ADD = 0x8006;
  rlgl.symbols.rlSetBlendFactorsSeparate(
    SRC_ALPHA,
    ONE_MINUS_SRC_ALPHA,
    ONE,
    ONE_MINUS_SRC_ALPHA,
    FUNC_ADD,
    FUNC_ADD,
  );
  raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_CUSTOM_SEPARATE);
}

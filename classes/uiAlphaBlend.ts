import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { rlSetBlendFactorsSeparate } from "./rlglExtras.ts";

const GL_ZERO = 0;
const GL_ONE = 1;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_FUNC_ADD = 0x8006;

/**
 * Straight-alpha source over premultiplied destination (`RGB = As*Cs + (1-As)*Cd`,
 * `A = As + (1-As)*Ad`). Produces premultiplied RGBA on a transparent render target.
 *
 * Raylib's `BLEND_ALPHA` multiplies source alpha by itself (`As*As + (1-As)*Ad`), which
 * lowers destination alpha on translucent pixels and anti-aliased edges.
 * Pair with `EndBlendMode()` to restore Raylib's default.
 */
export function beginUiAlphaBlend(): void {
  rlSetBlendFactorsSeparate(
    GL_SRC_ALPHA,
    GL_ONE_MINUS_SRC_ALPHA,
    GL_ONE,
    GL_ONE_MINUS_SRC_ALPHA,
    GL_FUNC_ADD,
    GL_FUNC_ADD,
  );
  raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_CUSTOM_SEPARATE);
}

/**
 * Direct premultiplied copy (`ONE, ZERO` on both RGB and alpha) into a cleared render target.
 * Preserves premultiplied eye-buffer pixels through resample passes (such as the panorama
 * combine shader) without multiplying RGB by alpha a second time or squaring alpha.
 */
export function beginPremultipliedCopyBlend(): void {
  rlSetBlendFactorsSeparate(
    GL_ONE,
    GL_ZERO,
    GL_ONE,
    GL_ZERO,
    GL_FUNC_ADD,
    GL_FUNC_ADD,
  );
  raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_CUSTOM_SEPARATE);
}

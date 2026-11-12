/**
 * Glyph (Slug) text in TypeScript: vector glyph coverage drawn inside the raythree UI pass, from
 * fonts baked by pmndrs/glyph (resources/fonts/glyph/*.font.glb, see glyphFont.ts) with our GLSL
 * port of Glyph's shader (glyphShaders.ts). It needs no native library, so it runs wherever raylib
 * does.
 *
 * It replaces the native library's `pp_glyph_*` path and draws the same thing: the same records,
 * the same instance data and the same shader. tests/pathfinder_text/render.ts compares the two.
 */
import * as THREE from "three";
import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";
import {
  bufferOffset,
  cString,
  GL,
  type GlFunctions,
  linkProgram,
  loadGlFunctions,
} from "./glFunctions.ts";
import { type GlyphFont, type GlyphFontGlyph, parseGlyphFont } from "./glyphFont.ts";
import { GLYPH_FRAGMENT_SHADER, GLYPH_VERTEX_SHADER } from "./glyphShaders.ts";
import type { WebXRRaythreeUiSnapshot } from "./webxrRaythreeUi.ts";
import type { TextRenderingSettings } from "./textRenderingSettings.ts";

/** Font slots in the UI's glyph placements: 0 Roboto, 1 Material Icons. */
const FONT_FILES = ["roboto.font.glb", "icons.font.glb"] as const;

export function glyphFontUrl(file: string): URL {
  return new URL(`../resources/fonts/glyph/${file}`, import.meta.url);
}

/** Whether the baked fonts are present (they ship in resources/, so: in every build). */
export function bakedGlyphFontsAvailable(): boolean {
  try {
    return FONT_FILES.every((file) => Deno.statSync(glyphFontUrl(file)).isFile);
  } catch {
    return false;
  }
}

/** Per instance: mat4, bounds, 4 offsets, 2 band counts, band transform, tint. */
const INSTANCE_WORDS = 34;
/** Per glyph placement from the UI: code point, pen x, pen y, size, font slot. */
const PLACEMENT_WORDS = 5;

type Page = { textures: [number, number, number] };

export class GlyphTextRenderer {
  private readonly gl: GlFunctions;
  private readonly raylib: Deno.DynamicLibrary<
    { rlDrawRenderBatchActive: { parameters: []; result: "void" } }
  >;
  private readonly program: number;
  private readonly vao: number;
  private readonly corners: number;
  private readonly instanceBuffer: number;
  private readonly pages: Page[] = [];
  /** By font slot, the global page index of each font page. */
  private readonly fonts: { font: GlyphFont; pageBase: number }[] = [];
  private readonly uniforms: Record<
    "viewport" | "exponent" | "weight" | "aaWidth" | "curves" | "headers" | "references",
    number
  >;
  private instances = new ArrayBuffer(0);
  private floats = new Float32Array(0);
  private words = new Uint32Array(0);
  private readonly mvp = new THREE.Matrix4();
  private readonly world = new THREE.Matrix4();
  private readonly scratch = new Int32Array(4);
  private readonly flag = new Uint8Array(1);
  private warnedMissing = false;
  private disposed = false;

  constructor() {
    this.gl = loadGlFunctions();
    this.raylib = Deno.dlopen(getRaylibLibraryPath(), {
      rlDrawRenderBatchActive: { parameters: [], result: "void" },
    });
    const gl = this.gl;
    this.raylib.symbols.rlDrawRenderBatchActive();
    const saved = this.saveState();
    try {
      this.program = linkProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);
      const location = (name: string) => gl.glGetUniformLocation(this.program, cString(name));
      this.uniforms = {
        viewport: location("uViewport"),
        exponent: location("uCoverageExponent"),
        weight: location("uWeightPixels"),
        aaWidth: location("uAaWidth"),
        curves: location("uCurves"),
        headers: location("uHeaders"),
        references: location("uReferences"),
      };
      const ids = new Uint32Array(1);
      gl.glGenVertexArrays(1, ids);
      this.vao = ids[0]!;
      gl.glBindVertexArray(this.vao);
      gl.glGenBuffers(1, ids);
      this.corners = ids[0]!;
      gl.glBindBuffer(GL.ARRAY_BUFFER, this.corners);
      const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
      gl.glBufferData(
        GL.ARRAY_BUFFER,
        BigInt(corners.byteLength),
        Deno.UnsafePointer.of(corners),
        GL.STATIC_DRAW,
      );
      gl.glEnableVertexAttribArray(0);
      gl.glVertexAttribPointer(0, 2, GL.FLOAT, 0, 8, null);
      gl.glGenBuffers(1, ids);
      this.instanceBuffer = ids[0]!;

      gl.glBindBuffer(GL.PIXEL_UNPACK_BUFFER, 0);
      gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
      for (const file of FONT_FILES) {
        const font = parseGlyphFont(Deno.readFileSync(glyphFontUrl(file)));
        this.fonts.push({ font, pageBase: this.pages.length });
        for (const page of font.pages) {
          this.pages.push({
            textures: [
              this.texture(GL.RGBA16F, GL.RGBA, GL.HALF_FLOAT, page.curves),
              this.texture(GL.R32UI, GL.RED_INTEGER, GL.UNSIGNED_INT, page.headers),
              this.texture(GL.R16UI, GL.RED_INTEGER, GL.UNSIGNED_SHORT, page.references),
            ],
          });
        }
      }
    } finally {
      this.restoreState(saved);
    }
    console.log("[raythree] text renderer=glyph (TypeScript, baked fonts)");
  }

  /**
   * Draws one UI root's texts. Returns the labels drawn, or `null` to have that group drawn with
   * MSDF instead (it lacks glyph placements).
   */
  draw(
    texts: WebXRRaythreeUiSnapshot["texts"],
    projectionView: THREE.Matrix4,
    tuning?: TextRenderingSettings,
  ): number | null {
    if (this.disposed) return null;
    let count = 0;
    let visible = 0;
    for (const text of texts) {
      if (text.text.length === 0 || text.color[3] <= 0 || text.geometry == null) continue;
      const glyphs = text.geometry.vectorGlyphs;
      if (glyphs == null) return null;
      count += glyphs.length / PLACEMENT_WORDS;
      visible++;
    }
    if (count === 0) return visible === 0 ? 0 : visible;
    this.reserve(count);

    // Instances in the producer's order; consecutive glyphs on the same page draw together.
    const runs: { page: number; first: number; count: number }[] = [];
    let index = 0;
    for (const text of texts) {
      if (text.text.length === 0 || text.color[3] <= 0 || text.geometry == null) continue;
      this.mvp.multiplyMatrices(projectionView, this.world.fromArray(text.worldMatrix));
      const m = this.mvp.elements;
      const placements = text.geometry.vectorGlyphs!;
      const tint = [
        toSrgb(text.color[0]),
        toSrgb(text.color[1]),
        toSrgb(text.color[2]),
        text.color[3],
      ];
      for (let p = 0; p < placements.length; p += PLACEMENT_WORDS) {
        const code = placements[p]!;
        const penX = placements[p + 1]!;
        const penY = placements[p + 2]!;
        const size = placements[p + 3]!;
        const slot = placements[p + 4]!;
        const found = this.lookup(slot, code);
        if (found == null) continue;
        const { glyph, page } = found;
        const run = runs.at(-1);
        if (run != null && run.page === page) run.count++;
        else runs.push({ page, first: index, count: 1 });
        this.writeInstance(index, m, penX, penY, size, glyph, tint);
        index++;
      }
    }
    if (index === 0) return visible;

    const gl = this.gl;
    this.raylib.symbols.rlDrawRenderBatchActive();
    const saved = this.saveState();
    try {
      gl.glGetIntegerv(GL.VIEWPORT, this.scratch);
      if (this.scratch[2]! <= 0 || this.scratch[3]! <= 0) throw new Error("Invalid Glyph viewport");
      gl.glUseProgram(this.program);
      gl.glUniform1f(this.uniforms.exponent, tuning?.glyphCoverageExponent ?? 1);
      gl.glUniform1f(this.uniforms.weight, tuning?.glyphWeightPixels ?? 0);
      gl.glUniform1f(this.uniforms.aaWidth, tuning?.glyphAaWidth ?? 1);
      gl.glUniform1i(this.uniforms.curves, 0);
      gl.glUniform1i(this.uniforms.headers, 1);
      gl.glUniform1i(this.uniforms.references, 2);
      gl.glUniform2f(this.uniforms.viewport, this.scratch[2]!, this.scratch[3]!);
      gl.glBindVertexArray(this.vao);
      gl.glDisable(GL.DEPTH_TEST);
      gl.glDepthMask(0);
      gl.glDisable(GL.CULL_FACE);
      gl.glDisable(GL.STENCIL_TEST);
      gl.glDisable(GL.SCISSOR_TEST);
      gl.glDisable(GL.FRAMEBUFFER_SRGB);
      gl.glEnable(GL.BLEND);
      gl.glBlendEquationSeparate(GL.FUNC_ADD, GL.FUNC_ADD);
      gl.glBlendFuncSeparate(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
      gl.glBindBuffer(GL.ARRAY_BUFFER, this.instanceBuffer);
      gl.glBufferData(
        GL.ARRAY_BUFFER,
        BigInt(index * INSTANCE_WORDS * 4),
        Deno.UnsafePointer.of(this.floats),
        GL.STREAM_DRAW,
      );
      for (const run of runs) {
        const textures = this.pages[run.page]!.textures;
        for (let unit = 0; unit < 3; unit++) {
          gl.glActiveTexture(GL.TEXTURE0 + unit);
          gl.glBindTexture(GL.TEXTURE_2D, textures[unit]!);
        }
        // GL 3.3 has no base-instance draw: point the attributes at this run's first instance.
        for (const [location, size, offset, integer] of ATTRIBUTES) {
          const at = bufferOffset((run.first * INSTANCE_WORDS + offset) * 4);
          gl.glEnableVertexAttribArray(location);
          gl.glVertexAttribDivisor(location, 1);
          if (integer) {
            gl.glVertexAttribIPointer(location, size, GL.UNSIGNED_INT, INSTANCE_WORDS * 4, at);
          } else {
            gl.glVertexAttribPointer(location, size, GL.FLOAT, 0, INSTANCE_WORDS * 4, at);
          }
        }
        gl.glDrawArraysInstanced(GL.TRIANGLES, 0, 6, run.count);
      }
    } finally {
      this.restoreState(saved);
    }
    return visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.raylib.symbols.rlDrawRenderBatchActive();
    gl.glDeleteProgram(this.program);
    gl.glDeleteVertexArrays(1, new Uint32Array([this.vao]));
    gl.glDeleteBuffers(1, new Uint32Array([this.corners]));
    gl.glDeleteBuffers(1, new Uint32Array([this.instanceBuffer]));
    const textures = new Uint32Array(this.pages.flatMap((page) => page.textures));
    if (textures.length > 0) gl.glDeleteTextures(textures.length, textures);
    this.raylib.close();
  }

  private lookup(slot: number, code: number): { glyph: GlyphFontGlyph; page: number } | null {
    const font = this.fonts[slot];
    const glyph = font?.font.glyphs.get(code);
    if (font == null || glyph == null) {
      // Characters without an outline (a space) are never placed; anything else is missing from
      // the bake (utils/glyph-bake/*.set).
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        console.warn(
          `[raythree] Glyph text: no baked outline for U+${
            code.toString(16).toUpperCase().padStart(4, "0")
          } (font ${slot}); skipped`,
        );
      }
      return null;
    }
    return { glyph, page: font.pageBase + glyph.page };
  }

  /** Same as the native loader: the placement is Y-down BMFont units, Glyph curves are Y-up em. */
  private writeInstance(
    index: number,
    m: ArrayLike<number>,
    penX: number,
    penY: number,
    size: number,
    glyph: GlyphFontGlyph,
    tint: number[],
  ): void {
    const f = this.floats;
    const u = this.words;
    const at = index * INSTANCE_WORDS;
    for (let row = 0; row < 4; row++) {
      f[at + row] = m[row]! * size;
      f[at + 4 + row] = -m[4 + row]! * size;
      f[at + 8 + row] = m[8 + row]!;
      f[at + 12 + row] = m[row]! * penX + m[4 + row]! * penY + m[12 + row]!;
    }
    const [minX, minY, maxX, maxY] = glyph.bounds;
    f[at + 16] = minX;
    f[at + 17] = minY;
    f[at + 18] = maxX;
    f[at + 19] = maxY;
    u[at + 20] = glyph.curveBase;
    u[at + 21] = glyph.horizontalHeaderBase;
    u[at + 22] = glyph.verticalHeaderBase;
    u[at + 23] = glyph.referenceBase;
    u[at + 24] = glyph.horizontalBands;
    u[at + 25] = glyph.verticalBands;
    const sx = glyph.verticalBands / (maxX - minX);
    const sy = glyph.horizontalBands / (maxY - minY);
    f[at + 26] = sx;
    f[at + 27] = sy;
    f[at + 28] = -minX * sx;
    f[at + 29] = -minY * sy;
    f[at + 30] = tint[0]!;
    f[at + 31] = tint[1]!;
    f[at + 32] = tint[2]!;
    f[at + 33] = tint[3]!;
  }

  private reserve(count: number): void {
    const bytes = count * INSTANCE_WORDS * 4;
    if (this.instances.byteLength >= bytes) return;
    this.instances = new ArrayBuffer(Math.max(bytes, this.instances.byteLength * 2));
    this.floats = new Float32Array(this.instances);
    this.words = new Uint32Array(this.instances);
  }

  private texture(
    internal: number,
    format: number,
    type: number,
    data: { bytes: Uint8Array; width: number; height: number },
  ): number {
    const gl = this.gl;
    const id = new Uint32Array(1);
    gl.glGenTextures(1, id);
    gl.glBindTexture(GL.TEXTURE_2D, id[0]!);
    gl.glTexImage2D(
      GL.TEXTURE_2D,
      0,
      internal,
      data.width,
      data.height,
      0,
      format,
      type,
      data.bytes,
    );
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
    return id[0]!;
  }

  /** What this renderer changes, so raylib's cached state stays true afterwards. */
  private saveState(): SavedState {
    const gl = this.gl;
    const integer = (name: number) => {
      gl.glGetIntegerv(name, this.scratch);
      return this.scratch[0]!;
    };
    const enabled = (cap: number) => gl.glIsEnabled(cap) !== 0;
    const active = integer(GL.ACTIVE_TEXTURE);
    const textures: number[] = [];
    for (let unit = 0; unit < 3; unit++) {
      gl.glActiveTexture(GL.TEXTURE0 + unit);
      textures.push(integer(GL.TEXTURE_BINDING_2D));
    }
    gl.glActiveTexture(active);
    gl.glGetBooleanv(GL.DEPTH_WRITEMASK, this.flag);
    return {
      program: integer(GL.CURRENT_PROGRAM),
      vao: integer(GL.VERTEX_ARRAY_BINDING),
      array: integer(GL.ARRAY_BUFFER_BINDING),
      unpackBuffer: integer(GL.PIXEL_UNPACK_BUFFER_BINDING),
      unpackAlignment: integer(GL.UNPACK_ALIGNMENT),
      active,
      textures,
      depthMask: this.flag[0]!,
      caps: CAPS.map((cap) => [cap, enabled(cap)] as const),
      blend: [
        integer(GL.BLEND_SRC_RGB),
        integer(GL.BLEND_DST_RGB),
        integer(GL.BLEND_SRC_ALPHA),
        integer(GL.BLEND_DST_ALPHA),
        integer(GL.BLEND_EQUATION_RGB),
        integer(GL.BLEND_EQUATION_ALPHA),
      ],
    };
  }

  private restoreState(state: SavedState): void {
    const gl = this.gl;
    for (let unit = 0; unit < 3; unit++) {
      gl.glActiveTexture(GL.TEXTURE0 + unit);
      gl.glBindTexture(GL.TEXTURE_2D, state.textures[unit]!);
    }
    gl.glActiveTexture(state.active);
    gl.glUseProgram(state.program);
    gl.glBindVertexArray(state.vao);
    gl.glBindBuffer(GL.ARRAY_BUFFER, state.array);
    gl.glBindBuffer(GL.PIXEL_UNPACK_BUFFER, state.unpackBuffer);
    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, state.unpackAlignment);
    gl.glDepthMask(state.depthMask);
    for (const [cap, on] of state.caps) on ? gl.glEnable(cap) : gl.glDisable(cap);
    const [srcRgb, dstRgb, srcAlpha, dstAlpha, equationRgb, equationAlpha] = state.blend;
    gl.glBlendFuncSeparate(srcRgb!, dstRgb!, srcAlpha!, dstAlpha!);
    gl.glBlendEquationSeparate(equationRgb!, equationAlpha!);
  }
}

type SavedState = {
  program: number;
  vao: number;
  array: number;
  unpackBuffer: number;
  unpackAlignment: number;
  active: number;
  textures: number[];
  depthMask: number;
  caps: (readonly [number, boolean])[];
  blend: number[];
};

const CAPS = [
  GL.BLEND,
  GL.DEPTH_TEST,
  GL.CULL_FACE,
  GL.STENCIL_TEST,
  GL.SCISSOR_TEST,
  GL.FRAMEBUFFER_SRGB,
];

/** Attribute location, components, word offset in the instance, integer. As in glyph.vert. */
const ATTRIBUTES: readonly (readonly [number, number, number, boolean])[] = [
  [1, 4, 0, false],
  [2, 4, 4, false],
  [3, 4, 8, false],
  [4, 4, 12, false],
  [5, 4, 16, false],
  [6, 4, 20, true],
  [7, 2, 24, true],
  [8, 4, 26, false],
  [9, 4, 30, false],
];

function toSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

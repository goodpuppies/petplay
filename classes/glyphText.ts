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
import { fromFileUrl } from "@std/path";
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

type NativeGlyphDrawFn = (
  header: Uint32Array,
  uniforms: Float32Array,
  runs: Uint32Array,
  instanceData: Float32Array,
  instanceBytes: number,
) => number;

let nativeGlyphDrawTried = false;
let nativeGlyphDrawCached: NativeGlyphDrawFn | null = null;

function loadNativeGlyphDraw(): NativeGlyphDrawFn | null {
  if (nativeGlyphDrawTried) return nativeGlyphDrawCached;
  nativeGlyphDrawTried = true;
  if (Deno.build.os !== "linux") return null;
  try {
    const path = fromFileUrl(new URL("../resources/libpetplay_overlay_presenter.so", import.meta.url));
    const lib = Deno.dlopen(path, {
      pp_glyph_draw_fast: {
        parameters: ["buffer", "buffer", "buffer", "buffer", "usize"],
        result: "i32",
        optional: true,
      },
    });
    nativeGlyphDrawCached = (lib.symbols.pp_glyph_draw_fast as NativeGlyphDrawFn | null) ?? null;
  } catch {
    nativeGlyphDrawCached = null;
  }
  return nativeGlyphDrawCached;
}

export class GlyphTextRenderer {
  private readonly gl: GlFunctions;
  private readonly nativeDraw: NativeGlyphDrawFn | null;
  private readonly nativeHeader = new Uint32Array(10);
  private readonly nativeUniforms = new Float32Array(5);
  private nativeRuns = new Uint32Array(64 * 5);
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
  private gpuBufferBytes = 0;
  private lastBoundFirst = -1;
  private readonly mvp = new THREE.Matrix4();
  private readonly world = new THREE.Matrix4();
  private readonly scratch = new Int32Array(4);
  private readonly flag = new Uint8Array(1);
  private readonly runPages: number[] = [];
  private readonly runFirsts: number[] = [];
  private readonly runCounts: number[] = [];
  private pageCounts = new Int32Array(0);
  private pageCursors = new Int32Array(0);
  private readonly resolvedScratch: (ResolvedPlacements | null)[] = [];
  private readonly placementCache = new WeakMap<Float32Array, ResolvedPlacements>();
  /**
   * Content-addressed L2 cache so unchanged labels arriving in fresh wire packets reuse their
   * resolved typed arrays instead of reallocating ~250 KB/frame when any unrelated scene item
   * (such as a controller ray) triggers a packet delivery.
   */
  private readonly placementContentCache = new Map<
    number,
    { raw: Float32Array; resolved: ResolvedPlacements }
  >();
  private lastExponent = Number.NaN;
  private lastWeight = Number.NaN;
  private lastAaWidth = Number.NaN;
  private lastVpW = -1;
  private lastVpH = -1;
  private warnedMissing = false;
  private disposed = false;

  constructor() {
    this.gl = loadGlFunctions();
    this.nativeDraw = loadNativeGlyphDraw();
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
      // Sampler units never change; set them once on the program.
      gl.glUseProgram(this.program);
      gl.glUniform1i(this.uniforms.curves, 0);
      gl.glUniform1i(this.uniforms.headers, 1);
      gl.glUniform1i(this.uniforms.references, 2);
      // Pre-enable all instance attributes and divisors once on this VAO.
      gl.glBindBuffer(GL.ARRAY_BUFFER, this.instanceBuffer);
      for (const [location, size, offset, integer] of ATTRIBUTES) {
        const at = bufferOffset(offset * 4);
        gl.glEnableVertexAttribArray(location);
        gl.glVertexAttribDivisor(location, 1);
        if (integer) {
          gl.glVertexAttribIPointer(location, size, GL.UNSIGNED_INT, INSTANCE_WORDS * 4, at);
        } else {
          gl.glVertexAttribPointer(location, size, GL.FLOAT, 0, INSTANCE_WORDS * 4, at);
        }
      }
      this.lastBoundFirst = 0;

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

  /** Reads the current GL viewport once per eye so multiple UI roots can reuse it. */
  readViewport(): { width: number; height: number } {
    this.gl.glGetIntegerv(GL.VIEWPORT, this.scratch);
    return { width: this.scratch[2]!, height: this.scratch[3]! };
  }

  private resolvePlacements(placements: Float32Array): ResolvedPlacements {
    const cached = this.placementCache.get(placements);
    if (cached != null) return cached;
    const hash = hashFloat32Array(placements);
    const contentHit = this.placementContentCache.get(hash);
    if (contentHit != null && sameFloat32Array(contentHit.raw, placements)) {
      this.placementCache.set(placements, contentHit.resolved);
      return contentHit.resolved;
    }
    const maxGlyphs = placements.length / PLACEMENT_WORDS;
    const penX = new Float32Array(maxGlyphs);
    const penY = new Float32Array(maxGlyphs);
    const size = new Float32Array(maxGlyphs);
    // 14 pre-baked words per glyph: bounds[4] (f32), curve/header/ref/bands[6] (u32), bandScale/Offset[4] (f32).
    const staticFloats = new Float32Array(maxGlyphs * 14);
    const staticWords = new Uint32Array(staticFloats.buffer);
    const pages = new Int32Array(maxGlyphs);
    let count = 0;
    let singlePage = -2;
    for (let p = 0; p < placements.length; p += PLACEMENT_WORDS) {
      const code = placements[p]!;
      const slot = placements[p + 4]!;
      const fontEntry = this.fonts[slot];
      const glyph = fontEntry?.font.glyphs.get(code);
      if (fontEntry == null || glyph == null) {
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          console.warn(
            `[raythree] Glyph text: no baked outline for U+${
              code.toString(16).toUpperCase().padStart(4, "0")
            } (font ${slot}); skipped`,
          );
        }
        continue;
      }
      penX[count] = placements[p + 1]!;
      penY[count] = placements[p + 2]!;
      size[count] = placements[p + 3]!;
      const page = fontEntry.pageBase + glyph.page;
      pages[count] = page;
      if (singlePage === -2) singlePage = page;
      else if (singlePage !== page) singlePage = -1;
      const off = count * 14;
      const [minX, minY, maxX, maxY] = glyph.bounds;
      staticFloats[off] = minX;
      staticFloats[off + 1] = minY;
      staticFloats[off + 2] = maxX;
      staticFloats[off + 3] = maxY;
      staticWords[off + 4] = glyph.curveBase;
      staticWords[off + 5] = glyph.horizontalHeaderBase;
      staticWords[off + 6] = glyph.verticalHeaderBase;
      staticWords[off + 7] = glyph.referenceBase;
      staticWords[off + 8] = glyph.horizontalBands;
      staticWords[off + 9] = glyph.verticalBands;
      const sx = glyph.verticalBands / (maxX - minX);
      const sy = glyph.horizontalBands / (maxY - minY);
      staticFloats[off + 10] = sx;
      staticFloats[off + 11] = sy;
      staticFloats[off + 12] = -minX * sx;
      staticFloats[off + 13] = -minY * sy;
      count++;
    }
    const resolved: ResolvedPlacements = {
      count,
      singlePage: singlePage >= 0 ? singlePage : -1,
      penX,
      penY,
      size,
      staticFloats,
      staticWords,
      pages,
    };
    this.placementCache.set(placements, resolved);
    if (this.placementContentCache.size >= 1024) {
      this.placementContentCache.clear();
    }
    this.placementContentCache.set(hash, { raw: placements.slice(), resolved });
    return resolved;
  }

  /**
   * Draws one UI root's texts. Returns the labels drawn, or `null` to have that group drawn with
   * MSDF instead (it lacks glyph placements).
   */
  draw(
    texts: WebXRRaythreeUiSnapshot["texts"],
    projectionView: THREE.Matrix4,
    tuning?: TextRenderingSettings,
    fastUiPass?: { width?: number; height?: number; restoreDepthTest: boolean },
  ): number | null {
    if (this.disposed) return null;
    const numPages = this.pages.length;
    if (this.pageCounts.length < numPages) {
      this.pageCounts = new Int32Array(numPages);
      this.pageCursors = new Int32Array(numPages);
    }
    const pageCounts = this.pageCounts;
    const pageCursors = this.pageCursors;
    pageCounts.fill(0, 0, numPages);

    const resolvedScratch = this.resolvedScratch;
    resolvedScratch.length = texts.length;
    let count = 0;
    let visible = 0;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (text.text.length === 0 || text.color[3] <= 0 || text.geometry == null) {
        resolvedScratch[i] = null;
        continue;
      }
      const glyphs = text.geometry.vectorGlyphs;
      if (glyphs == null) return null;
      const resolved = this.resolvePlacements(glyphs);
      resolvedScratch[i] = resolved;
      const n = resolved.count;
      if (n > 0) {
        if (resolved.singlePage >= 0) {
          pageCounts[resolved.singlePage] = pageCounts[resolved.singlePage]! + n;
        } else {
          const pageArr = resolved.pages;
          for (let g = 0; g < n; g++) {
            const p = pageArr[g]!;
            pageCounts[p] = pageCounts[p]! + 1;
          }
        }
        count += n;
      }
      visible++;
    }
    if (count === 0) return visible === 0 ? 0 : visible;
    this.reserve(count);

    // Group glyphs by font page into contiguous slices so each active page draws in one instanced call.
    let runCount = 0;
    let cursor = 0;
    for (let p = 0; p < numPages; p++) {
      const c = pageCounts[p]!;
      if (c === 0) continue;
      this.runPages[runCount] = p;
      this.runFirsts[runCount] = cursor;
      this.runCounts[runCount] = c;
      pageCursors[p] = cursor;
      cursor += c;
      runCount++;
    }

    const f = this.floats;
    const u = this.words;
    for (let ti = 0; ti < texts.length; ti++) {
      const resolved = resolvedScratch[ti];
      if (resolved == null || resolved.count === 0) continue;
      const text = texts[ti]!;
      this.mvp.multiplyMatrices(projectionView, this.world.fromArray(text.worldMatrix));
      const m = this.mvp.elements;
      const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!;
      const m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!;
      const m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m11 = m[11]!;
      const m12 = m[12]!, m13 = m[13]!, m14 = m[14]!, m15 = m[15]!;
      const tr = toSrgb(text.color[0]);
      const tg = toSrgb(text.color[1]);
      const tb = toSrgb(text.color[2]);
      const ta = text.color[3];
      const n = resolved.count;
      const penXArr = resolved.penX;
      const penYArr = resolved.penY;
      const sizeArr = resolved.size;
      const sf = resolved.staticFloats;
      const su = resolved.staticWords;
      const pageArr = resolved.pages;
      for (let g = 0; g < n; g++) {
        const page = pageArr[g]!;
        const idx = pageCursors[page]!;
        pageCursors[page] = idx + 1;
        const px = penXArr[g]!;
        const py = penYArr[g]!;
        const sz = sizeArr[g]!;
        const at = idx * INSTANCE_WORDS;
        const off = g * 14;
        f[at] = m0 * sz;
        f[at + 1] = m1 * sz;
        f[at + 2] = m2 * sz;
        f[at + 3] = m3 * sz;
        f[at + 4] = -m4 * sz;
        f[at + 5] = -m5 * sz;
        f[at + 6] = -m6 * sz;
        f[at + 7] = -m7 * sz;
        f[at + 8] = m8;
        f[at + 9] = m9;
        f[at + 10] = m10;
        f[at + 11] = m11;
        f[at + 12] = m0 * px + m4 * py + m12;
        f[at + 13] = m1 * px + m5 * py + m13;
        f[at + 14] = m2 * px + m6 * py + m14;
        f[at + 15] = m3 * px + m7 * py + m15;
        f[at + 16] = sf[off]!;
        f[at + 17] = sf[off + 1]!;
        f[at + 18] = sf[off + 2]!;
        f[at + 19] = sf[off + 3]!;
        u[at + 20] = su[off + 4]!;
        u[at + 21] = su[off + 5]!;
        u[at + 22] = su[off + 6]!;
        u[at + 23] = su[off + 7]!;
        u[at + 24] = su[off + 8]!;
        u[at + 25] = su[off + 9]!;
        f[at + 26] = sf[off + 10]!;
        f[at + 27] = sf[off + 11]!;
        f[at + 28] = sf[off + 12]!;
        f[at + 29] = sf[off + 13]!;
        f[at + 30] = tr;
        f[at + 31] = tg;
        f[at + 32] = tb;
        f[at + 33] = ta;
      }
    }
    const index = cursor;
    if (index === 0) return visible;

    const gl = this.gl;
    this.raylib.symbols.rlDrawRenderBatchActive();
    const saved = fastUiPass ? null : this.saveDrawState();
    let vpW: number;
    let vpH: number;
    if (fastUiPass?.width && fastUiPass?.height) {
      vpW = fastUiPass.width;
      vpH = fastUiPass.height;
    } else {
      gl.glGetIntegerv(GL.VIEWPORT, this.scratch);
      vpW = this.scratch[2]!;
      vpH = this.scratch[3]!;
    }
    if (vpW <= 0 || vpH <= 0) throw new Error("Invalid Glyph viewport");
    const exp = tuning?.glyphCoverageExponent ?? 1;
    const wgt = tuning?.glyphWeightPixels ?? 0;
    const aaw = tuning?.glyphAaWidth ?? 1;

    // Fast path: submit the entire root in one native Zig FFI call (zero UnsafeFnPointer crossings).
    if (fastUiPass && this.nativeDraw != null) {
      let flags = 0;
      if (exp !== this.lastExponent) {
        flags |= 1;
        this.lastExponent = exp;
      }
      if (wgt !== this.lastWeight) {
        flags |= 2;
        this.lastWeight = wgt;
      }
      if (aaw !== this.lastAaWidth) {
        flags |= 4;
        this.lastAaWidth = aaw;
      }
      if (vpW !== this.lastVpW || vpH !== this.lastVpH) {
        flags |= 8;
        this.lastVpW = vpW;
        this.lastVpH = vpH;
      }
      if (this.nativeRuns.length < runCount * 5) {
        this.nativeRuns = new Uint32Array(runCount * 5 * 2);
      }
      const runs = this.nativeRuns;
      for (let r = 0; r < runCount; r++) {
        const textures = this.pages[this.runPages[r]!]!.textures;
        const base = r * 5;
        runs[base] = textures[0];
        runs[base + 1] = textures[1];
        runs[base + 2] = textures[2];
        runs[base + 3] = this.runFirsts[r]!;
        runs[base + 4] = this.runCounts[r]!;
      }
      const h = this.nativeHeader;
      h[0] = this.program;
      h[1] = this.vao;
      h[2] = this.instanceBuffer;
      h[3] = runCount;
      h[4] = fastUiPass.restoreDepthTest ? 1 : 0;
      h[5] = flags;
      h[6] = this.uniforms.exponent >>> 0;
      h[7] = this.uniforms.weight >>> 0;
      h[8] = this.uniforms.aaWidth >>> 0;
      h[9] = this.uniforms.viewport >>> 0;
      const uArr = this.nativeUniforms;
      uArr[0] = exp;
      uArr[1] = wgt;
      uArr[2] = aaw;
      uArr[3] = vpW;
      uArr[4] = vpH;
      if (this.nativeDraw(h, uArr, runs, this.floats, index * INSTANCE_WORDS * 4) === 0) {
        return visible;
      }
      // If native GL proc lookup failed, reset cached uniform state and fall through to JS GL.
      this.lastExponent = Number.NaN;
      this.lastWeight = Number.NaN;
      this.lastAaWidth = Number.NaN;
      this.lastVpW = -1;
      this.lastVpH = -1;
    }

    try {
      gl.glUseProgram(this.program);
      if (exp !== this.lastExponent) {
        gl.glUniform1f(this.uniforms.exponent, exp);
        this.lastExponent = exp;
      }
      if (wgt !== this.lastWeight) {
        gl.glUniform1f(this.uniforms.weight, wgt);
        this.lastWeight = wgt;
      }
      if (aaw !== this.lastAaWidth) {
        gl.glUniform1f(this.uniforms.aaWidth, aaw);
        this.lastAaWidth = aaw;
      }
      if (vpW !== this.lastVpW || vpH !== this.lastVpH) {
        gl.glUniform2f(this.uniforms.viewport, vpW, vpH);
        this.lastVpW = vpW;
        this.lastVpH = vpH;
      }
      gl.glBindVertexArray(this.vao);
      gl.glDisable(GL.DEPTH_TEST);
      gl.glDepthMask(0);
      if (!fastUiPass) {
        gl.glDisable(GL.CULL_FACE);
        gl.glDisable(GL.STENCIL_TEST);
        gl.glDisable(GL.SCISSOR_TEST);
        gl.glDisable(GL.FRAMEBUFFER_SRGB);
        gl.glEnable(GL.BLEND);
        gl.glBlendEquationSeparate(GL.FUNC_ADD, GL.FUNC_ADD);
        gl.glBlendFuncSeparate(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
      }
      gl.glBindBuffer(GL.ARRAY_BUFFER, this.instanceBuffer);
      // Buffer-orphan with glBufferData(STREAM_DRAW) so the driver never stalls on an in-flight eye.
      gl.glBufferData(
        GL.ARRAY_BUFFER,
        BigInt(index * INSTANCE_WORDS * 4),
        Deno.UnsafePointer.of(this.floats),
        GL.STREAM_DRAW,
      );
      const drawBaseInstance = gl.glDrawArraysInstancedBaseInstance;
      for (let r = 0; r < runCount; r++) {
        const page = this.runPages[r]!;
        const first = this.runFirsts[r]!;
        const countInRun = this.runCounts[r]!;
        const textures = this.pages[page]!.textures;
        for (let unit = 0; unit < 3; unit++) {
          gl.glActiveTexture(GL.TEXTURE0 + unit);
          gl.glBindTexture(GL.TEXTURE_2D, textures[unit]!);
        }
        if (drawBaseInstance != null) {
          drawBaseInstance(GL.TRIANGLES, 0, 6, countInRun, first);
        } else {
          // Only re-point vertex attributes when `first` changes (99% of roots have a single run at 0).
          if (first !== this.lastBoundFirst) {
            for (const [location, size, offset, integer] of ATTRIBUTES) {
              const at = bufferOffset((first * INSTANCE_WORDS + offset) * 4);
              if (integer) {
                gl.glVertexAttribIPointer(location, size, GL.UNSIGNED_INT, INSTANCE_WORDS * 4, at);
              } else {
                gl.glVertexAttribPointer(location, size, GL.FLOAT, 0, INSTANCE_WORDS * 4, at);
              }
            }
            this.lastBoundFirst = first;
          }
          gl.glDrawArraysInstanced(GL.TRIANGLES, 0, 6, countInRun);
        }
      }
    } finally {
      if (saved) {
        this.restoreDrawState(saved);
      } else {
        gl.glActiveTexture(GL.TEXTURE0);
        gl.glBindTexture(GL.TEXTURE_2D, 0);
        gl.glUseProgram(0);
        gl.glBindVertexArray(0);
        gl.glBindBuffer(GL.ARRAY_BUFFER, 0);
        if (fastUiPass?.restoreDepthTest) gl.glEnable(GL.DEPTH_TEST);
      }
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
    tr: number,
    tg: number,
    tb: number,
    ta: number,
  ): void {
    const f = this.floats;
    const u = this.words;
    const at = index * INSTANCE_WORDS;
    const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!;
    const m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!;
    f[at] = m0 * size;
    f[at + 1] = m1 * size;
    f[at + 2] = m2 * size;
    f[at + 3] = m3 * size;
    f[at + 4] = -m4 * size;
    f[at + 5] = -m5 * size;
    f[at + 6] = -m6 * size;
    f[at + 7] = -m7 * size;
    f[at + 8] = m[8]!;
    f[at + 9] = m[9]!;
    f[at + 10] = m[10]!;
    f[at + 11] = m[11]!;
    f[at + 12] = m0 * penX + m4 * penY + m[12]!;
    f[at + 13] = m1 * penX + m5 * penY + m[13]!;
    f[at + 14] = m2 * penX + m6 * penY + m[14]!;
    f[at + 15] = m3 * penX + m7 * penY + m[15]!;
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
    f[at + 30] = tr;
    f[at + 31] = tg;
    f[at + 32] = tb;
    f[at + 33] = ta;
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

  /** Minimal state save for `draw()` (skips pixel-unpack state that only `constructor` touches). */
  private saveDrawState(): SavedDrawState {
    const gl = this.gl;
    const integer = (name: number) => {
      gl.glGetIntegerv(name, this.scratch);
      return this.scratch[0]!;
    };
    const enabled = (cap: number) => gl.glIsEnabled(cap) !== 0;
    const active = integer(GL.ACTIVE_TEXTURE);
    gl.glActiveTexture(GL.TEXTURE0);
    const t0 = integer(GL.TEXTURE_BINDING_2D);
    gl.glActiveTexture(GL.TEXTURE0 + 1);
    const t1 = integer(GL.TEXTURE_BINDING_2D);
    gl.glActiveTexture(GL.TEXTURE0 + 2);
    const t2 = integer(GL.TEXTURE_BINDING_2D);
    gl.glActiveTexture(active);
    gl.glGetBooleanv(GL.DEPTH_WRITEMASK, this.flag);
    return {
      program: integer(GL.CURRENT_PROGRAM),
      vao: integer(GL.VERTEX_ARRAY_BINDING),
      array: integer(GL.ARRAY_BUFFER_BINDING),
      active,
      t0,
      t1,
      t2,
      depthMask: this.flag[0]!,
      blendOn: enabled(GL.BLEND),
      depthOn: enabled(GL.DEPTH_TEST),
      cullOn: enabled(GL.CULL_FACE),
      stencilOn: enabled(GL.STENCIL_TEST),
      scissorOn: enabled(GL.SCISSOR_TEST),
      srgbOn: enabled(GL.FRAMEBUFFER_SRGB),
      srcRgb: integer(GL.BLEND_SRC_RGB),
      dstRgb: integer(GL.BLEND_DST_RGB),
      srcAlpha: integer(GL.BLEND_SRC_ALPHA),
      dstAlpha: integer(GL.BLEND_DST_ALPHA),
      eqRgb: integer(GL.BLEND_EQUATION_RGB),
      eqAlpha: integer(GL.BLEND_EQUATION_ALPHA),
    };
  }

  private restoreDrawState(s: SavedDrawState): void {
    const gl = this.gl;
    gl.glActiveTexture(GL.TEXTURE0);
    gl.glBindTexture(GL.TEXTURE_2D, s.t0);
    gl.glActiveTexture(GL.TEXTURE0 + 1);
    gl.glBindTexture(GL.TEXTURE_2D, s.t1);
    gl.glActiveTexture(GL.TEXTURE0 + 2);
    gl.glBindTexture(GL.TEXTURE_2D, s.t2);
    gl.glActiveTexture(s.active);
    gl.glUseProgram(s.program);
    gl.glBindVertexArray(s.vao);
    gl.glBindBuffer(GL.ARRAY_BUFFER, s.array);
    gl.glDepthMask(s.depthMask);
    s.blendOn ? gl.glEnable(GL.BLEND) : gl.glDisable(GL.BLEND);
    s.depthOn ? gl.glEnable(GL.DEPTH_TEST) : gl.glDisable(GL.DEPTH_TEST);
    s.cullOn ? gl.glEnable(GL.CULL_FACE) : gl.glDisable(GL.CULL_FACE);
    s.stencilOn ? gl.glEnable(GL.STENCIL_TEST) : gl.glDisable(GL.STENCIL_TEST);
    s.scissorOn ? gl.glEnable(GL.SCISSOR_TEST) : gl.glDisable(GL.SCISSOR_TEST);
    s.srgbOn ? gl.glEnable(GL.FRAMEBUFFER_SRGB) : gl.glDisable(GL.FRAMEBUFFER_SRGB);
    gl.glBlendFuncSeparate(s.srcRgb, s.dstRgb, s.srcAlpha, s.dstAlpha);
    gl.glBlendEquationSeparate(s.eqRgb, s.eqAlpha);
  }

  /** What this renderer changes in constructor, so raylib's cached state stays true afterwards. */
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

type ResolvedPlacements = {
  count: number;
  singlePage: number;
  penX: Float32Array;
  penY: Float32Array;
  size: Float32Array;
  staticFloats: Float32Array;
  staticWords: Uint32Array;
  pages: Int32Array;
};

type SavedDrawState = {
  program: number;
  vao: number;
  array: number;
  active: number;
  t0: number;
  t1: number;
  t2: number;
  depthMask: number;
  blendOn: boolean;
  depthOn: boolean;
  cullOn: boolean;
  stencilOn: boolean;
  scissorOn: boolean;
  srgbOn: boolean;
  srcRgb: number;
  dstRgb: number;
  srcAlpha: number;
  dstAlpha: number;
  eqRgb: number;
  eqAlpha: number;
};

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

function hashFloat32Array(arr: Float32Array): number {
  let h = (0x811c9dc5 ^ arr.length) | 0;
  // Reinterpret directly when 4-byte aligned (always true for Float32Array).
  const u32 = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  for (let i = 0; i < u32.length; i++) {
    h = Math.imul(h ^ u32[i]!, 0x01000193);
  }
  return h >>> 0;
}

function sameFloat32Array(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const SRGB_CACHE = new Map<number, number>();

function toSrgb(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  if (value <= 0.0031308) return value * 12.92;
  const cached = SRGB_CACHE.get(value);
  if (cached !== undefined) return cached;
  const result = 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  if (SRGB_CACHE.size < 256) SRGB_CACHE.set(value, result);
  return result;
}

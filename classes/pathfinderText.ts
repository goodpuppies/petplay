import * as THREE from "three";
import { fromFileUrl } from "@std/path";
import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";
import type { WebXRRaythreeUiSnapshot } from "./webxrRaythreeUi.ts";
import type { TextRenderingSettings } from "./textRenderingSettings.ts";

const symbols = {
  pp_pf_abi: { parameters: [], result: "u32" },
  pp_pf_create: { parameters: [], result: "pointer" },
  pp_pf_draw: { parameters: ["pointer", "buffer", "u32"], result: "i32" },
  pp_pf_error: { parameters: [], result: "pointer" },
  pp_pf_destroy: { parameters: ["pointer"], result: "void" },
  pp_glyph_draw_tuned: {
    parameters: ["pointer", "buffer", "u32", "f32", "f32"], result: "i32", optional: true,
  },
  pp_glyph_draw_filtered: {
    parameters: ["pointer", "buffer", "u32", "f32", "f32", "f32"], result: "i32", optional: true,
  },
} as const;

/** Native vector coverage renderer, used inside the existing raythree UI pass. */
export class PathfinderTextRenderer {
  private library: Deno.DynamicLibrary<typeof symbols>;
  private raylib: Deno.DynamicLibrary<
    { rlDrawRenderBatchActive: { parameters: []; result: "void" } }
  >;
  private handle: Deno.PointerValue;
  private records = new Float32Array(0);
  private readonly matrix = new THREE.Matrix4();
  private readonly world = new THREE.Matrix4();
  private warnedMissingLayout = false;

  static createIfEnabled(): PathfinderTextRenderer | null {
    const backend = Deno.args.find((arg) => arg.startsWith("--text-renderer="))?.split("=")[1] ??
      Deno.env.get("PETPLAY_TEXT_RENDERER") ?? "msdf";
    if (backend === "msdf" || backend === "glyph" || backend === "windfoil") return null;
    if (backend !== "pathfinder") throw new Error(`Unknown text renderer: ${backend}`);
    return new PathfinderTextRenderer();
  }

  constructor(private readonly backend: "pathfinder" | "glyph" | "windfoil" = "pathfinder") {
    if (Deno.build.os !== "linux") {
      throw new Error("The experimental Pathfinder text backend currently builds on Linux only");
    }
    const path = fromFileUrl(
      new URL("../resources/libpetplay_pathfinder_text.so", import.meta.url),
    );
    try {
      const prefix = backend === "pathfinder" ? "pp_pf" : "pp_glyph";
      this.library = Deno.dlopen(path, {
        ...symbols,
        pp_pf_create: { ...symbols.pp_pf_create, name: backend === "windfoil" ? "pp_windfoil_create" : `${prefix}_create` },
        pp_pf_draw: { ...symbols.pp_pf_draw, name: `${prefix}_draw` },
        pp_pf_destroy: { ...symbols.pp_pf_destroy, name: `${prefix}_destroy` },
      });
    } catch (cause) {
      throw new Error("Pathfinder text library unavailable; run deno task text:pathfinder:build", {
        cause,
      });
    }
    if (this.library.symbols.pp_pf_abi() !== 1) {
      this.library.close();
      throw new Error("Unsupported Pathfinder text ABI; rebuild the library");
    }
    this.raylib = Deno.dlopen(getRaylibLibraryPath(), {
      rlDrawRenderBatchActive: { parameters: [], result: "void" },
    });
    this.raylib.symbols.rlDrawRenderBatchActive();
    this.handle = this.library.symbols.pp_pf_create();
    if (this.handle === null) {
      const message = this.error();
      this.raylib.close();
      this.library.close();
      throw new Error(message);
    }
    console.log(`[raythree] text renderer=${backend} (experimental vector coverage)`);
  }

  draw(texts: WebXRRaythreeUiSnapshot["texts"], projectionView: THREE.Matrix4, tuning?: TextRenderingSettings): number | null {
    const visible = texts.filter((text) =>
      text.text.length > 0 && text.color[3] > 0 && text.geometry != null
    );
    if (visible.some((text) => text.geometry!.vectorGlyphs == null)) {
      if (!this.warnedMissingLayout) {
        console.warn(
          "[raythree] Vector text: UI group lacks glyph placements; using MSDF for that group",
        );
        this.warnedMissingLayout = true;
      }
      return null;
    }
    const count = visible.reduce((n, text) => n + text.geometry!.vectorGlyphs!.length / 5, 0);
    if (count === 0) return 0;
    if (this.records.length < count * 25) this.records = new Float32Array(count * 25);
    let offset = 0;
    for (const text of visible) {
      this.matrix.multiplyMatrices(projectionView, this.world.fromArray(text.worldMatrix));
      const glyphs = text.geometry!.vectorGlyphs!;
      const color = [
        toSrgb(text.color[0]),
        toSrgb(text.color[1]),
        toSrgb(text.color[2]),
        text.color[3],
      ];
      for (let i = 0; i < glyphs.length; i += 5) {
        this.records.set(glyphs.subarray(i, i + 5), offset);
        this.records.set(this.matrix.elements, offset + 5);
        this.records.set(color, offset + 21);
        offset += 25;
      }
    }
    this.raylib.symbols.rlDrawRenderBatchActive();
    const exponent = tuning?.glyphCoverageExponent ?? 1;
    const weight = tuning?.glyphWeightPixels ?? 0;
    const aaWidth = tuning?.glyphAaWidth ?? 1;
    const filtered = this.library.symbols.pp_glyph_draw_filtered;
    const tuned = this.library.symbols.pp_glyph_draw_tuned;
    if (this.backend !== "pathfinder" && ((!filtered && aaWidth !== 1) || (!filtered && !tuned && (exponent !== 1 || weight !== 0)))) {
      throw new Error("Glyph tuning requires rebuilding the native text library and reloading the renderer");
    }
    const result = this.backend !== "pathfinder" && filtered
      ? filtered(this.handle, this.records, count, exponent, weight, aaWidth)
      : this.backend !== "pathfinder" && tuned ? tuned(this.handle, this.records, count, exponent, weight)
      : this.library.symbols.pp_pf_draw(this.handle, this.records, count);
    if (result !== 0) {
      throw new Error(this.error());
    }
    return visible.length;
  }

  dispose(): void {
    if (this.handle === null) return;
    this.raylib.symbols.rlDrawRenderBatchActive();
    this.library.symbols.pp_pf_destroy(this.handle);
    this.handle = null;
    this.library.close();
    this.raylib.close();
  }

  private error(): string {
    const pointer = this.library.symbols.pp_pf_error();
    return pointer
      ? new Deno.UnsafePointerView(pointer).getCString()
      : "Unknown Pathfinder text error";
  }
}

function toSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

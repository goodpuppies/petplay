import { getSetting } from "./settings.ts";

export type TextRenderingSettings = {
  renderer: "msdf" | "pathfinder" | "glyph" | "windfoil";
  panoramaFilter: "linear" | "catmull-rom";
  /** Optional for older scene producers; defaults preserve original glyph coverage. */
  glyphCoverageExponent?: number;
  glyphWeightPixels?: number;
  glyphAaWidth?: number;
};

/** Resolve in the scene producer; send the result to all render consumers. */
export function getTextRenderingSettings(): TextRenderingSettings {
  const sessionRenderer =
    Deno.args.find((arg) => arg.startsWith("--text-renderer="))?.split("=")[1] ??
      Deno.env.get("PETPLAY_TEXT_RENDERER");
  return {
    glyphAaWidth: getSetting("glyphAaWidth"),
    glyphCoverageExponent: getSetting("glyphCoverageExponent"),
    glyphWeightPixels: getSetting("glyphWeightPixels"),
    renderer: getSetting("textRenderer") ??
      (sessionRenderer === "pathfinder" || sessionRenderer === "glyph" || sessionRenderer === "windfoil" ? sessionRenderer : "msdf"),
    panoramaFilter: getSetting("panoramaFilter") ??
      (Deno.env.get("PETPLAY_PANORAMA_FILTER") === "catmull-rom" ? "catmull-rom" : "linear"),
  };
}

export function pathfinderTextAvailable(): boolean {
  if (Deno.build.os !== "linux") return false;
  try {
    return Deno.statSync(new URL("../resources/libpetplay_pathfinder_text.so", import.meta.url))
      .isFile;
  } catch {
    return false;
  }
}

export function glyphTextAvailable(): boolean {
  if (!pathfinderTextAvailable()) return false;
  // Feature detection keeps a new UI from enabling Glyph against an older native build.
  try {
    const lib = Deno.dlopen(
      new URL("../resources/libpetplay_pathfinder_text.so", import.meta.url),
      {
        pp_glyph_draw: { parameters: ["pointer", "buffer", "u32"], result: "i32" },
      },
    );
    lib.close();
    return true;
  } catch {
    return false;
  }
}

export function windfoilTextAvailable(): boolean {
  if (!pathfinderTextAvailable()) return false;
  try {
    const lib = Deno.dlopen(new URL("../resources/libpetplay_pathfinder_text.so", import.meta.url), {
      pp_windfoil_create: {parameters:[],result:"pointer"},
    });
    lib.close();
    return true;
  } catch { return false; }
}

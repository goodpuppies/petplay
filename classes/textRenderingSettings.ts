import { getSetting } from "./settings.ts";

export type TextRenderingSettings = {
  renderer: "msdf" | "pathfinder" | "glyph" | "windfoil";
  panoramaFilter: "linear" | "catmull-rom";
  /** Optional for older scene producers; defaults preserve original glyph coverage. */
  glyphCoverageExponent?: number;
  glyphWeightPixels?: number;
  glyphAaWidth?: number;
};

/**
 * Vector (Pathfinder) and Windfoil are comparison renderers: shown in development, hidden in
 * release builds (`release.env` sets `NODE_ENV=production`) unless `PETPLAY_EXPERIMENTAL_TEXT=1`.
 * Glyph is the vector renderer releases keep.
 */
export function experimentalTextRenderersShown(): boolean {
  return EXPERIMENTAL_SHOWN;
}

// The environment is fixed for the process, and the renderer is resolved every frame.
const EXPERIMENTAL_SHOWN = Deno.env.get("PETPLAY_EXPERIMENTAL_TEXT") === "1" ||
  Deno.env.get("NODE_ENV") !== "production";

const EXPERIMENTAL_RENDERERS = new Set(["pathfinder", "windfoil"]);

/** Resolve in the scene producer; send the result to all render consumers. */
export function getTextRenderingSettings(): TextRenderingSettings {
  const sessionRenderer =
    Deno.args.find((arg) => arg.startsWith("--text-renderer="))?.split("=")[1] ??
      Deno.env.get("PETPLAY_TEXT_RENDERER");
  const chosen = getSetting("textRenderer") ??
    (sessionRenderer === "pathfinder" || sessionRenderer === "glyph" ||
        sessionRenderer === "windfoil"
      ? sessionRenderer
      : "msdf");
  return {
    glyphAaWidth: getSetting("glyphAaWidth"),
    glyphCoverageExponent: getSetting("glyphCoverageExponent"),
    glyphWeightPixels: getSetting("glyphWeightPixels"),
    // A choice saved in a development run falls back where its renderer is hidden.
    renderer: EXPERIMENTAL_RENDERERS.has(chosen) && !experimentalTextRenderersShown()
      ? "msdf"
      : chosen,
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

/**
 * Glyph draws in TypeScript from the baked fonts in resources/fonts/glyph (see
 * classes/glyphText.ts), so it needs no native library and works on every platform.
 */
export function glyphTextAvailable(): boolean {
  try {
    return ["roboto.font.glb", "icons.font.glb"].every((file) =>
      Deno.statSync(new URL(`../resources/fonts/glyph/${file}`, import.meta.url)).isFile
    );
  } catch {
    return false;
  }
}

export function windfoilTextAvailable(): boolean {
  if (!pathfinderTextAvailable()) return false;
  try {
    const lib = Deno.dlopen(
      new URL("../resources/libpetplay_pathfinder_text.so", import.meta.url),
      {
        pp_windfoil_create: { parameters: [], result: "pointer" },
      },
    );
    lib.close();
    return true;
  } catch {
    return false;
  }
}

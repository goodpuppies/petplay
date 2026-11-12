/** Exact offscreen A/B through the production UI extractor and Raylib renderer; no SteamVR. */
import * as THREE from "three";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import raylib, * as bindings from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../../classes/webxrRaythreeRaylibRenderer.ts";
import { extractWebXRRaythreeUi } from "../../classes/webxrRaythreeUi.ts";
import { RaythreeExtractor } from "../../submodules/raythree/src/lib.ts";
import { MSDFTextGeometry } from "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/index.ts";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 2, 0.05, 10);
camera.position.z = 1;
camera.updateMatrixWorld(true);
const paths = {
  roboto:
    "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.fnt",
  "material-icons": "../../resources/fonts/material-icons/material-icons.fnt",
};
for (
  const [index, [text, font]] of [
    ["PetPlay Settings Monitors Il1 O0", "roboto"],
    ["@@@ AV ffi curves agpq", "roboto"],
    ["ö ä å § € ½", "material-icons"],
    ["\ue31b \ue338 \ue8b8", "material-icons"],
  ].entries()
) {
  const data = JSON.parse(
    Deno.readTextFileSync(new URL(paths[font as keyof typeof paths], import.meta.url)),
  );
  const geometry = new MSDFTextGeometry({ text, font: data });
  geometry.computeBoundingBox();
  if (!geometry.boundingBox) throw new Error("Missing glyph bounds");
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(-0.48, 0.23 - index * 0.12, 0);
  mesh.rotation.set(Math.PI, index === 1 ? 0.5 : 0, 0);
  mesh.scale.setScalar(0.00045);
  mesh.userData = {
    bridge: { kind: "skip" },
    raythreeUiText: {
      text,
      font,
      color: [1, 1, 1, 1],
      fontSize: 0.00045,
      align: "left",
      anchorX: "left",
      bounds: {
        minX: geometry.boundingBox.min.x,
        maxX: geometry.boundingBox.max.x,
        minY: geometry.boundingBox.min.y,
        maxY: geometry.boundingBox.max.y,
      },
    },
  };
  scene.add(mesh);
}
scene.updateMatrixWorld(true);
const extraction = new RaythreeExtractor().extract(scene, camera);
const ui = extractWebXRRaythreeUi(scene);
// Separate roots exercise repeated native/host transitions within one eye pass.
ui.texts.forEach((text, index) => text.rootIndex = index);
if (ui.texts.length !== 4 || ui.texts.some((t) => !t.geometry?.vectorGlyphs?.length)) {
  throw new Error("Real MSDF geometry did not export vector placements");
}
const original = Deno.env.get("PETPLAY_TEXT_RENDERER");
raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
raylib.H.InitWindow(64, 64, "PetPlay vector text offscreen test");
let target: bindings.RenderTexture2D | null = null;
let renderer: WebXRRaythreeRaylibRenderer | null = null;
let baselineGlyph: Uint8Array | undefined;
let baselineWindfoil: Uint8Array | undefined;
try {
  target = raylib.H.LoadRenderTexture(1024, 512);
  renderer = new WebXRRaythreeRaylibRenderer();
  const variants = ["msdf", "pathfinder", "glyph", "msdf", "glyph", "pathfinder"].map(
    (backend) => ({backend, exponent:1, weight:0, aaWidth:1, label:backend}),
  );
  variants.push(
    {backend:"glyph", exponent:0.85, weight:0, aaWidth:1, label:"glyph-coverage"},
    {backend:"glyph", exponent:1, weight:0.125, aaWidth:1, label:"glyph-weight"},
    {backend:"glyph", exponent:0.85, weight:0.125, aaWidth:1, label:"glyph-combined"},
    {backend:"glyph", exponent:0.7, weight:0.125, aaWidth:0.85, label:"glyph-aa-85"},
    {backend:"glyph", exponent:0.7, weight:0.125, aaWidth:0.7, label:"glyph-aa-70"},
    {backend:"glyph", exponent:1, weight:0, aaWidth:1, label:"glyph-reset"},
    {backend:"windfoil", exponent:1, weight:0, aaWidth:1, label:"windfoil"},
    {backend:"windfoil", exponent:0.7, weight:0.125, aaWidth:0.7, label:"windfoil-tuned"},
    {backend:"glyph", exponent:1, weight:0, aaWidth:1, label:"glyph-after-windfoil"},
    {backend:"windfoil", exponent:1, weight:0, aaWidth:1, label:"windfoil-reset"},
  );
  for (const {backend, exponent, weight, aaWidth, label} of variants) {
    Deno.env.set("PETPLAY_TEXT_RENDERER", backend);
    ui.textRendering = {
      renderer: backend as "msdf" | "pathfinder" | "glyph" | "windfoil",
      panoramaFilter: "linear",
      glyphCoverageExponent: exponent,
      glyphWeightPixels: weight,
      glyphAaWidth: aaWidth,
    };
    for (let frame = 0; frame < 3; frame++) {
      raylib.BeginDrawing();
      raylib.H.BeginTextureMode(target);
      const stats = renderer.renderExtraction(
        extraction,
        [0.05, 0.1, 0.16, 1],
        undefined,
        undefined,
        ui,
      );
      // A host draw after Pathfinder exercises restored shader/VAO/texture/blend state.
      raylib.H.DrawRectangle(980, 470, 24, 24, raylib.RED);
      raylib.EndTextureMode();
      raylib.EndDrawing();
      if (stats.uiTextDrawn !== 4) {
        throw new Error(`${backend}: lost text labels (${stats.uiTextDrawn})`);
      }
    }
    const image = raylib.H.LoadImageFromTexture(target.texture);
    const handle = bindings.Image.createPointer(image);
    raylib.H.ImageFlipVertical(handle.pointer);
    const flipped = handle.read();
    const output = `${Deno.cwd()}/_scratch/pathfinder-raythree-${label}.png`;
    if (!raylib.H.ExportImage(flipped, output)) throw new Error("Image export failed");
    raylib.H.UnloadImage(flipped);
    const pixels = PNG.sync.read(Buffer.from(Deno.readFileSync(output)));
    if (backend === "glyph" || backend === "windfoil") {
      const reference: Uint8Array = (backend === "glyph" ? baselineGlyph : baselineWindfoil) ?? new Uint8Array(pixels.data);
      if (backend === "glyph") baselineGlyph = reference;
      else baselineWindfoil = reference;
      let difference = 0;
      for (let i = 0; i < pixels.data.length; i++) difference += Math.abs(pixels.data[i]! - reference[i]!);
      if (exponent === 1 && weight === 0 && aaWidth === 1) {
        if (difference !== 0) throw new Error(`${label}: resetting controls did not restore exact baseline`);
      } else if (difference === 0) throw new Error(`${label}: tuning did not reach production rendering`);
    }
    for (const [top, bottom] of [[125, 155], [175, 215], [240, 270], [300, 325]]) {
      let lit = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = 270; x < 650; x++) {
          if (pixels.data[(y * 1024 + x) * 4] > 64) lit++;
        }
      }
      if (lit < 25) throw new Error(`${backend}: missing glyph pixels in row ${top}`);
    }
    if (pixels.data[(480 * 1024 + 990) * 4] < 200) {
      throw new Error(`${backend}: host overdraw missing`);
    }
    console.log(`PASS: ${backend}: 4 UI labels, 3 frames, host overdraw; ${output}`);
  }
} finally {
  renderer?.dispose();
  if (target) raylib.H.UnloadRenderTexture(target);
  raylib.CloseWindow();
  if (original == null) Deno.env.delete("PETPLAY_TEXT_RENDERER");
  else Deno.env.set("PETPLAY_TEXT_RENDERER", original);
}

/** GPU check: production shader compilation and cubic reconstruction against a CPU reference. */
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../../classes/nativeLibraryPaths.ts";
import { WEBXR_VARGGLES_GLSL330_FRAGMENT } from "../../classes/webxrVargglesShader.ts";

raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
raylib.H.InitWindow(64, 64, "PetPlay panorama filter offscreen test");
const source = raylib.H.LoadRenderTexture(32, 32);
const target = raylib.H.LoadRenderTexture(256, 32);
const production = raylib.H.LoadShaderFromMemory(null, WEBXR_VARGGLES_GLSL330_FRAGMENT);
if (!raylib.H.IsShaderValid(production)) {
  throw new Error("Production panorama shader failed to compile");
}
// Isolate the reconstruction function at known pixel phases; keep the production sampleEye code.
const testSource = WEBXR_VARGGLES_GLSL330_FRAGMENT.replace(
  "finalColor = sampleEye(eyeUv)",
  "finalColor = sampleEye(fragTexCoord)",
);
const shader = raylib.H.LoadShaderFromMemory(null, testSource);
if (!raylib.H.IsShaderValid(shader)) {
  throw new Error("Reconstruction test shader failed to compile");
}
const location = raylib.H.GetShaderLocation(shader, "panoramaFilter");
raylib.H.SetTextureFilter(source.texture, raylib.TextureFilter.TEXTURE_FILTER_BILINEAR);
try {
  raylib.BeginDrawing();
  raylib.H.BeginTextureMode(source);
  raylib.H.ClearBackground(raylib.BLACK);
  raylib.H.DrawRectangle(16, 0, 16, 32, raylib.WHITE);
  raylib.EndTextureMode();
  raylib.EndDrawing();
  for (const [filter, name] of ["linear", "catmull-rom"].entries()) {
    const value = new Int32Array([filter]);
    raylib.H.SetShaderValue(
      shader,
      location,
      Deno.UnsafePointer.of(value),
      raylib.ShaderUniformDataType.SHADER_UNIFORM_INT,
    );
    raylib.BeginDrawing();
    raylib.H.BeginTextureMode(target);
    raylib.H.ClearBackground(raylib.BLACK);
    raylib.H.BeginShaderMode(shader);
    raylib.H.DrawTexturePro(
      source.texture,
      { x: 0, y: 0, width: 32, height: -32 },
      { x: 0, y: 0, width: 256, height: 32 },
      { x: 0, y: 0 },
      0,
      raylib.WHITE,
    );
    raylib.H.EndShaderMode();
    raylib.EndTextureMode();
    raylib.EndDrawing();
    const image = raylib.H.LoadImageFromTexture(target.texture);
    const output = `${Deno.cwd()}/_scratch/panorama-filter-${name}.png`;
    try {
      if (!raylib.H.ExportImage(image, output)) throw new Error("Export failed");
    } finally {
      raylib.H.UnloadImage(image);
    }
    const png = PNG.sync.read(Buffer.from(Deno.readFileSync(output)));
    let maxError = 0;
    for (let x = 0; x < 256; x++) {
      const pixel = (x + 0.5) / 8 - 0.5;
      const base = Math.floor(pixel), f = pixel - base;
      const weights = filter === 0 ? [0, 1 - f, f, 0] : [
        -0.5 * f + f * f - 0.5 * f * f * f,
        1 - 2.5 * f * f + 1.5 * f * f * f,
        0.5 * f + 2 * f * f - 1.5 * f * f * f,
        -0.5 * f * f + 0.5 * f * f * f,
      ];
      let expected = 0;
      weights.forEach((weight, i) => {
        const tap = base + i - 1;
        // Existing bilinear render textures repeat at their boundary. The cubic
        // reconstruction explicitly clamps taps so opposite eye edges cannot bleed.
        const index = filter === 0 ? (tap + 32) % 32 : Math.max(0, Math.min(31, tap));
        if (index >= 16) expected += weight;
      });
      expected = Math.max(0, Math.min(1, expected)) * 255;
      maxError = Math.max(maxError, Math.abs(png.data[(16 * 256 + x) * 4] - expected));
    }
    if (maxError > 2) throw new Error(`${name}: reconstruction error ${maxError}/255`);
    console.log(`PASS: ${name}, reference max error=${maxError.toFixed(3)}/255`);
  }
} finally {
  raylib.H.UnloadShader(shader);
  raylib.H.UnloadShader(production);
  raylib.H.UnloadRenderTexture(source);
  raylib.H.UnloadRenderTexture(target);
  raylib.CloseWindow();
}

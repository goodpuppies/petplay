/** Hidden GL window, exact back-buffer comparison: lit object casts onto a supplied depth plane. */
import * as THREE from "three";
import { PNG } from "pngjs";
import { assert } from "@std/assert";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";
import {
  environmentFromRecord,
  setEnvironmentLighting,
} from "../classes/vrchatDepth/environmentLighting.ts";
import { LIGHTING } from "../classes/vrchatDepth/format.ts";

const size = 256, out = "_scratch/vrchat-depth/shadows";
await Deno.mkdir(out, { recursive: true });
raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
raylib.H.InitWindow(size, size, "Shadow GPU regression probe");
const gl = Deno.dlopen("libGL.so.1", {
  glReadPixels: {
    parameters: ["i32", "i32", "i32", "i32", "u32", "u32", "buffer"],
    result: "void",
  },
});
const renderer = new WebXRRaythreeRaylibRenderer();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, 0.03, 500);
const geometry = new THREE.SphereGeometry(0.3, 24, 16);
const material = new THREE.MeshStandardMaterial({ color: 0xdc143c });
const ball = new THREE.Mesh(geometry, material);
ball.position.set(0, 0, -2);
scene.add(ball);
const extractor = new RaythreeExtractor();
const record = new Array(LIGHTING.length).fill(0);
for (let c = 0; c < 3; c++) record[LIGHTING.sh + c * 4 + 3] = 0.3;
record.splice(LIGHTING.mainLightPosition, 4, 0, 1, -1, 0);
record.splice(LIGHTING.mainLightColor, 4, 1, 1, 1, 1);
setEnvironmentLighting(
  environmentFromRecord(record, { yawRad: 0, scale: 1, translation: [0, 0, 0] }),
);
function render(shadows: boolean) {
  renderer.setShadows(shadows);
  renderer.setDepthForeground({
    depth: new Float32Array(4).fill(3),
    width: 2,
    height: 2,
    scale: 1,
    revision: 1,
  });
  raylib.BeginDrawing();
  renderer.renderExtraction(extractor.extract(scene, camera), [204, 204, 204, 255]);
  const bytes = new Uint8Array(size * size * 4);
  gl.symbols.glReadPixels(0, 0, size, size, 0x1908, 0x1401, bytes);
  raylib.EndDrawing();
  return bytes;
}
try {
  const off = render(false), on = render(true), offAgain = render(false);
  let shadowPixels = 0, changedAfterDisable = 0;
  for (let i = 0; i < off.length; i += 4) {
    if (off[i] === 204 && off[i + 1] === 204 && on[i] < 180 && on[i + 1] < 180) shadowPixels++;
    if (off[i] !== offAgain[i] || off[i + 1] !== offAgain[i + 1]) changedAfterDisable++;
  }
  for (const [name, bytes] of [["off", off], ["on", on]] as const) {
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
      png.data.set(bytes.subarray((size - y - 1) * size * 4, (size - y) * size * 4), y * size * 4);
    }
    await Deno.writeFile(`${out}/${name}.png`, PNG.sync.write(png));
  }
  assert(shadowPixels > 1500, `Expected a solid shadow on receiver pixels, found ${shadowPixels}`);
  assert(changedAfterDisable === 0, `Shadow toggle left ${changedAfterDisable} changed pixels`);
  console.log(JSON.stringify({ shadowPixels, changedAfterDisable, out }));
} finally {
  renderer.dispose();
  geometry.dispose();
  material.dispose();
  setEnvironmentLighting(null);
  gl.close();
  raylib.H.CloseWindow();
  raylib.unloadRaylib();
}

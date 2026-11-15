/** Exact offscreen renderer check: spatial lighting changes across one PetPlay mesh. */
import * as THREE from "three";
import { assert } from "jsr:@std/assert@^1.0.0";
import { PNG } from "pngjs";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";
import {
  environmentFromRecord,
  setEnvironmentLighting,
} from "../classes/vrchatDepth/environmentLighting.ts";
import { lightVolumeCache, LV, volumeChecksum } from "../classes/vrchatDepth/lightVolumes.ts";
import { LIGHTING } from "../classes/vrchatDepth/format.ts";
import {
  nativeVolumePage,
  volumePage,
} from "../classes/vrchatDepth/testdata/lightVolumeFixture.ts";

const size = 256, out = "_scratch/vrchat-depth/light-volumes";
let lastImage: PNG;
await Deno.mkdir(out, { recursive: true });
raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
raylib.H.InitWindow(size, size, "Light Volumes GPU probe");
const renderer = new WebXRRaythreeRaylibRenderer();
const target = raylib.H.LoadRenderTexture(size, size);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, 0.03, 500);
const geometry = new THREE.PlaneGeometry(1.6, 1.6),
  material = new THREE.MeshStandardMaterial({ color: 0x808080 });
const plane = new THREE.Mesh(geometry, material);
plane.position.z = -2;
scene.add(plane);
const extractor = new RaythreeExtractor();
const base = new Array(LIGHTING.length).fill(0);
for (let c = 0; c < 3; c++) base[c * 4 + 3] = 0.1;
setEnvironmentLighting(
  environmentFromRecord(base, { yawRad: 0, scale: 1, translation: [0, 0, 0] }),
);
function render(name: string) {
  raylib.BeginDrawing();
  raylib.H.BeginTextureMode(target);
  renderer.renderExtraction(extractor.extract(scene, camera), [0, 0, 0, 255]);
  raylib.H.EndTextureMode();
  raylib.EndDrawing();
  const image = raylib.H.LoadImageFromTexture(target.texture);
  const pixels = new Uint8Array(
    new Deno.UnsafePointerView(Deno.UnsafePointer.create(image.data as unknown as bigint)!)
      .getArrayBuffer(size * size * 4),
  );
  const png = lastImage = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    png.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
  }
  raylib.H.UnloadImage(image);
  Deno.writeFileSync(`${out}/${name}.png`, PNG.sync.write(png));
  return [60, 105, 150, 195].map((x) => png.data[(128 * size + x) * 4]);
}
try {
  lightVolumeCache.reset();
  const fallback = render("fallback");
  for (let page = 0; page < 32; page++) {
    const r = volumePage(page);
    const o = LIGHTING.length;
    r[o + 12 + 11] = -2; // Unity z=+2 -> volume local z=0
    r[o + 28] = r[o + 29] = r[o + 30] = 100;
    const h = volumeChecksum(r.slice(o, -2));
    r[r.length - 2] = h & 65535;
    r[r.length - 1] = h >>> 16;
    assert(lightVolumeCache.ingest(r));
  }
  assert(lightVolumeCache.snapshot());
  const spatial = render("spatial");
  renderer.setSpatialLightingStrength(3);
  const boosted = render("spatial-3x");
  assert(
    boosted[1] > spatial[1] && boosted[2] > spatial[2],
    `Boost must amplify the spatial change: ${boosted} / ${spatial}`,
  );
  assert(
    boosted[0] === fallback[0] && boosted[3] === fallback[3],
    "Boost must preserve outside-volume fallback",
  );
  renderer.setSpatialLightingStrength(0);
  const zero = render("spatial-0x");
  assert(zero.every((v, i) => v === fallback[i]), "Zero strength must reproduce probe lighting");
  renderer.setSpatialLightingStrength(1);
  // Samples outside the volume retain the probe, while two fragments of one plane differ.
  assert(spatial[2] > spatial[1] + 25, `Expected spatial gradient: ${spatial}`);
  assert(
    Math.abs(spatial[0] - fallback[0]) <= 1 && Math.abs(spatial[3] - fallback[3]) <= 1,
    `Outside fallback ${spatial} / ${fallback}`,
  );
  lightVolumeCache.reset();
  const reset = render("reset");
  assert(
    reset.every((v, i) => v === fallback[i]),
    "Reset must restore fallback without stale texture use",
  );
  function constantVolumes(additive: number, maxAdditive: number) {
    lightVolumeCache.reset();
    for (let id = 0; id < 2; id++) {
      for (let page = 0; page < 32; page++) {
        const r = volumePage(page, id, 2), o = LIGHTING.length;
        r[o + 3] = additive;
        r[o + 10] = maxAdditive;
        r[o + 8] = 1;
        r[o + 12 + 11] = -2;
        r[o + 28] = r[o + 29] = r[o + 30] = 100;
        for (let s = 0; s < 128; s++) {
          const at = o + 60 + s * 12;
          for (let c = 0; c < 12; c++) r[at + c] = c < 3 ? (id === 0 ? 0.2 : 0.5) : 0;
        }
        const hash = volumeChecksum(r.slice(o, -2));
        r[r.length - 2] = hash & 65535;
        r[r.length - 1] = hash >>> 16;
        assert(lightVolumeCache.ingest(r));
      }
    }
  }
  constantVolumes(0, 0);
  const priority = render("priority");
  constantVolumes(1, 0);
  const capped = render("additive-disabled");
  constantVolumes(1, 1);
  const additive = render("additive");
  assert(
    priority[1] < capped[1] && capped[1] < additive[1],
    `Volume priority and additive cap: ${priority} / ${capped} / ${additive}`,
  );
  lightVolumeCache.reset();
  function detailPages(grid: number) {
    for (let page = 0; page < grid ** 3 / 128; page++) {
      const r = volumePage(page, 0, 1, grid), o = LIGHTING.length;
      r[o + 12 + 11] = -2;
      r[o + 28] = r[o + 29] = r[o + 30] = 100;
      for (let s = 0; s < 128; s++) {
        const x = ((page * 128 + s) % grid) / (grid - 1);
        const value = .2 + .8 * Math.max(0, 1 - Math.abs(x * 31 - 17));
        const at = o + 60 + s * 12;
        for (let c = 0; c < 12; c++) r[at + c] = c < 3 ? value : 0;
      }
      const h = volumeChecksum(r.slice(o, -2));
      r[r.length - 2] = h & 65535;
      r[r.length - 1] = h >>> 16;
      assert(lightVolumeCache.ingest(r));
    }
  }
  detailPages(16);
  render("detail-16");
  const coarseDetail = lastImage!.data[(128 * size + 133) * 4];
  detailPages(32);
  render("detail-32");
  const fineDetail = lastImage!.data[(128 * size + 133) * 4];
  assert(
    fineDetail > coarseDetail + 15,
    `Fine grid must recover narrow lighting detail: ${coarseDetail} -> ${fineDetail}`,
  );
  // Native 34x14x22 boundary-padded data must match its analytic linear field per fragment.
  function nativeReference(native: boolean) {
    lightVolumeCache.reset();
    const dims: [number, number, number] = native ? [34, 14, 22] : [16, 16, 16];
    const total = dims[0] * dims[1] * dims[2];
    for (let page = 0; page < Math.ceil(total / 128); page++) {
      const r = native ? nativeVolumePage(page, dims) : volumePage(page), o = LIGHTING.length;
      r[o + 23] = -2;
      r[o + 28] = r[o + 29] = r[o + 30] = 100;
      for (let j = 0; j < 128; j++) {
        const k = page * 128 + j,
          xyz = [
            k % dims[0],
            Math.floor(k / dims[0]) % dims[1],
            Math.floor(k / (dims[0] * dims[1])),
          ];
        const coordinates = xyz.map((v, i) => native ? v : v / 15 * [32, 12, 20][i] + .5);
        const value = coordinates.reduce((a, v, i) => a + v / [33, 13, 21][i] * [.6, .2, .2][i], 0);
        for (let c = 0; c < 12; c++) r[o + 60 + j * 12 + c] = c < 3 ? value : 0;
      }
      const h = volumeChecksum(r.slice(o, -2));
      r[r.length - 2] = h & 65535;
      r[r.length - 1] = h >>> 16;
      assert(lightVolumeCache.ingest(r));
    }
    render(native ? "native-anisotropic" : "native-analytic-reference");
    return new Uint8Array(lastImage!.data);
  }
  const reference = nativeReference(false), nativeImage = nativeReference(true);
  let nativeMaxError = 0;
  for (let i = 0; i < reference.length; i++) {
    nativeMaxError = Math.max(nativeMaxError, Math.abs(reference[i] - nativeImage[i]));
  }
  assert(
    nativeMaxError <= 1,
    `Native boundary sampling differs from analytic field: ${nativeMaxError}`,
  );
  function rawParity(raw: boolean) {
    lightVolumeCache.reset();
    for (let page = 0; page < 32; page++) {
      const r = volumePage(page), o = LIGHTING.length;
      r[o + 1] = raw ? 4 : 1;
      r[o + 23] = -2;
      r[o + 28] = r[o + 29] = r[o + 30] = 100;
      r[o + 32] = .5;
      r[o + 33] = .8;
      r[o + 34] = 1;
      r[o + 35] = 1;
      r[o + 36] = 1;
      r[o + 37] = 0;
      r[o + 38] = 0;
      r[o + 40] = 0;
      r[o + 41] = 0;
      r[o + 42] = 1;
      for (let j = 0; j < 128; j++) {
        const at = o + 60 + j * 12, tint = [.5, .8, 1];
        for (let c = 0; c < 3; c++) {
          r[at + c] = [.2, .3, .4][c] * (raw ? 1 : tint[c]);
          const v = [.1, .02, .03].map((x) => x * (c + 1));
          const coefficients = raw ? v : [v[0] * tint[c], v[2] * tint[c], -v[1] * tint[c]];
          coefficients.forEach((v, k) => r[at + 3 + c * 3 + k] = v);
        }
      }
      const h = volumeChecksum(r.slice(o, -2));
      r[r.length - 2] = h & 65535;
      r[r.length - 1] = h >>> 16;
      assert(lightVolumeCache.ingest(r));
    }
    render(raw ? "raw-volume" : "baked-reference");
    return new Uint8Array(lastImage!.data);
  }
  const baked = rawParity(false), rawPixels = rawParity(true);
  let rawMaxError = 0;
  for (let i = 0; i < baked.length; i++) {
    rawMaxError = Math.max(rawMaxError, Math.abs(baked[i] - rawPixels[i]));
  }
  assert(rawMaxError <= 1, `Raw tint/rotation differs from baked reference: ${rawMaxError}`);
  const snapshot = lightVolumeCache.snapshot()!, dataRevision = snapshot.dataRevision;
  // Animate red tint on one subsequent page: no coefficient/whole-atlas update should occur.
  const r = volumePage(0), o = LIGHTING.length;
  r[o + 1] = 4;
  r[o + 23] = -2;
  r[o + 28] = r[o + 29] = r[o + 30] = 100;
  r[o + 32] = 1;
  r[o + 33] = .8;
  r[o + 34] = 1;
  r[o + 35] = 1;
  r[o + 36] = 1;
  r[o + 37] = 0;
  r[o + 38] = 0;
  r[o + 40] = 0;
  r[o + 41] = 0;
  r[o + 42] = 1;
  const hash = volumeChecksum(r.slice(o, -2));
  r[r.length - 2] = hash & 65535;
  r[r.length - 1] = hash >>> 16;
  assert(lightVolumeCache.ingest(r));
  assert(
    lightVolumeCache.snapshot()!.dataRevision === dataRevision,
    "Tint animation must retain atlas",
  );
  render("raw-animated-tint");
  assert(
    lastImage!.data[(128 * size + 128) * 4] > rawPixels[(128 * size + 128) * 4],
    "Metadata-only GPU update must change tint",
  );
  console.log(
    JSON.stringify({
      passed: true,
      nativeMaxError,
      rawMaxError,
      coarseDetail,
      fineDetail,
      fallback,
      spatial,
      reset,
      priority,
      capped,
      additive,
      out,
      words: LV.words,
    }),
  );
} finally {
  lightVolumeCache.reset();
  setEnvironmentLighting(null);
  renderer.dispose();
  geometry.dispose();
  material.dispose();
  raylib.H.UnloadRenderTexture(target);
  raylib.H.CloseWindow();
  raylib.unloadRaylib();
}

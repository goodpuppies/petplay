/** Exact hidden-window GPU check: foreground quadrants must punch transparent holes. */
import * as THREE from "three";
import { PNG } from "pngjs";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";
import { assert, assertEquals } from "@std/assert";
import {
  decodeImage,
  DEFAULT_DEPTH_FAR,
  dequantizeDepth,
  deriveLayout,
  drawCells,
  encodeCells,
  floatBits,
  quantizeDepth,
} from "../classes/vrchatDepth/format.ts";
import type { DepthForegroundBlock } from "../classes/vrchatDepth/foreground.ts";

const out = "_scratch/vrchat-depth/foreground";
const size = 512;
let latestImage: PNG;
await Deno.mkdir(out, { recursive: true });
raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(
  raylib.ConfigFlags.FLAG_WINDOW_HIDDEN | raylib.ConfigFlags.FLAG_WINDOW_TRANSPARENT,
);
raylib.H.InitWindow(size, size, "Depth foreground GPU probe");
const renderer = new WebXRRaythreeRaylibRenderer();
const target = raylib.H.LoadRenderTexture(size, size);
const scene = new THREE.Scene();
const geometry = new THREE.PlaneGeometry(2, 2);
const material = new THREE.MeshBasicMaterial({ color: 0xff8800 });
const plane = new THREE.Mesh(geometry, material);
plane.position.z = -2;
scene.add(plane);
const camera = new THREE.PerspectiveCamera(60, 1, 0.03, 500);
camera.updateMatrixWorld(true);
const extractor = new RaythreeExtractor();
let revision = 0;
async function render(
  name: string,
  depth: Float32Array | null,
  bypassDepth = false,
  grid = 2,
  block?: DepthForegroundBlock,
) {
  material.depthTest = !bypassDepth;
  material.needsUpdate = true;
  const extraction = extractor.extract(scene, camera);
  renderer.setDepthForeground(
    depth ? { depth, width: grid, height: grid, revision: ++revision, scale: 1, block } : null,
  );
  const path = `${out}/${name}.png`;
  raylib.BeginDrawing();
  raylib.H.BeginTextureMode(target);
  renderer.renderExtraction(extraction, [0, 0, 0, 0]);
  raylib.H.EndTextureMode();
  raylib.EndDrawing();
  const image = raylib.H.LoadImageFromTexture(target.texture);
  const pointer = Deno.UnsafePointer.create(image.data as unknown as bigint)!;
  const pixels = new Uint8Array(
    new Deno.UnsafePointerView(pointer).getArrayBuffer(size * size * 4),
  );
  const png = latestImage = new PNG({ width: size, height: size });
  const stride = size * 4;
  for (let y = 0; y < size; y++) {
    png.data.set(pixels.subarray((size - 1 - y) * stride, (size - y) * stride), y * stride);
  }
  raylib.H.UnloadImage(image);
  await Deno.writeFile(path, PNG.sync.write(png));
  return [[48, 48], [80, 48], [48, 80], [80, 80]].map(([x, y]) =>
    Array.from(
      png.data.slice(
        ((y * size / 128) * size + x * size / 128) * 4,
        ((y * size / 128) * size + x * size / 128) * 4 + 4,
      ),
    )
  );
}
try {
  const off = await render("off", null);
  const on = await render("on", new Float32Array([1, 3, 3, 1]));
  const missing = await render("missing", new Float32Array(4));
  const bypass = await render("depth-test-disabled-material", new Float32Array([1, 3, 3, 1]), true);
  assertEquals(off.map((p) => p[3]), [255, 255, 255, 255]);
  assertEquals(on.map((p) => p[3]), [0, 255, 255, 0]);
  assertEquals(missing.map((p) => p[3]), [255, 255, 255, 255]);
  assertEquals(bypass.map((p) => p[3]), [0, 255, 255, 0]);
  await render("continuous-plane", new Float32Array([1.96, 1.99, 1.96, 1.99]));
  const alpha = (x: number, y: number) => latestImage.data[(y * size + x) * 4 + 3];
  // Sub-texel plane intersection must remain smooth instead of snapping to the centre column.
  assertEquals(alpha(280, 256), 0);
  assertEquals(alpha(320, 256), 255);
  const thin = new Float32Array(size * size).fill(3);
  for (let y = 0; y < size; y++) thin[y * size + 255] = 1;
  await render("512-thin-feature", thin, false, size);
  assertEquals([alpha(254, 256), alpha(255, 256), alpha(256, 256)], [255, 0, 255]);
  // The same planes as a depth block inside a "window" texture, decoded per fragment.
  const DEPTH_REF = 0.05;
  const blockCase = async (
    name: string,
    plane: Float32Array,
    grid: number,
    bits: [number, number, number],
    calibration3D = false,
  ) => {
    const near = Math.fround(DEPTH_REF), far = Math.fround(DEFAULT_DEPTH_FAR), cellBits = bits[0] + bits[1] + bits[2];
    const quantized = plane.map((d) => Math.fround(dequantizeDepth(quantizeDepth(d, near, far, cellBits), near, far, cellBits)));
    const layout = deriveLayout({ bits, gridWidth: Math.max(64, Math.min(1024, grid * 2)), depthWidth: grid, depthHeight: grid, calibration3D,
      levelInset: calibration3D ? 16 : 0 });
    const cells = encodeCells(layout, {
      timeTag: floatBits(1.5), eye: 0, flags: 0,
      viewToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      projection: { m00: 1, m11: 1, m02: 0, m12: 0 }, near: 0.03, far: 500,
      screenWidth: size, screenHeight: size, depthRef: DEPTH_REF,
      anchorToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    }, plane);
    const width = layout.gridWidth + 23, height = layout.gridHeight + 17;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    drawCells({ width, height, data: pixels, channels: 4 }, layout, cells, 9, 6, 1);
    if (calibration3D) {
      // The chamber's channel-mixing grade (format.test.ts): 1D calibration can't decode this.
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        pixels[i] = Math.round((0.85 * r + 0.15 * g) * 241 / 255);
        pixels[i + 1] = Math.round(g * 241 / 255);
        pixels[i + 2] = Math.round((0.88 * b + 0.12 * r) * 241 / 255);
      }
    }
    const decoded = decodeImage({ width, height, data: pixels, channels: 4 }, undefined, { depthGrid: 4 });
    assert(decoded.ok, "block image decodes on the CPU");
    const texture = raylib.H.LoadTextureFromImage({ data: Deno.UnsafePointer.value(Deno.UnsafePointer.of(pixels)),
      width, height, mipmaps: 1, format: raylib.PixelFormat.PIXELFORMAT_UNCOMPRESSED_R8G8B8A8 } as never);
    try {
      await render(`${name}-texture`, quantized, false, grid);
      const expected = latestImage.data.filter((_: number, i: number) => i % 4 === 3);
      await render(`${name}-block`, quantized, false, grid, {
        textureId: texture.id, textureWidth: width, textureHeight: height,
        x0: decoded.location.x0, y0: decoded.location.y0, pitch: decoded.location.pitch,
        gridWidth: layout.gridWidth, dataStartRow: layout.dataStartRow,
        depthStartCell: layout.depthStartCell, bits,
        depthWidth: grid, depthHeight: grid, depthRef: near, depthFar: far, luts: decoded.luts,
        table3d: decoded.classifier
          ? { ...decoded.classifier.shaderTable(64, 8), size: 64, tiles: 8, revision: 1 }
          : undefined,
      });
      const got = latestImage.data.filter((_: number, i: number) => i % 4 === 3);
      let mismatched = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) mismatched++;
      // float32 reciprocal rounding may move a pixel on an exactly grazing intersection.
      assert(mismatched <= got.length * 1e-3, `${name}: ${mismatched} pixels differ`);
      return mismatched;
    } finally {
      raylib.H.UnloadTexture(texture);
    }
  };
  const blockMismatches = {
    quadrants: await blockCase("block-quadrants", new Float32Array([1, 3, 3, 1]), 2, [8, 8, 8]),
    plane: await blockCase("block-plane", new Float32Array([1.96, 1.99, 1.96, 1.99]), 2, [8, 8, 8]),
    thin: await blockCase("block-512-thin", thin, size, [8, 8, 8]),
    thin6: await blockCase("block-512-thin-6bit", thin, size, [6, 6, 6]),
    thin3d: await blockCase("block-512-thin-3d-graded", thin, size, [4, 4, 4], true),
    plane3d: await blockCase("block-plane-3d-graded", new Float32Array([1.96, 1.99, 1.96, 1.99]), 2, [4, 4, 4], true),
  };
  console.log(JSON.stringify({ passed: true, off, on, missing, bypass, blockMismatches, out }));
} finally {
  renderer.dispose();
  geometry.dispose();
  material.dispose();
  raylib.H.UnloadRenderTexture(target);
  raylib.H.CloseWindow();
  raylib.unloadRaylib();
}

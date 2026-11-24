import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { unprojectDepth } from "./sync.ts";
import { type VoxelFrame, VoxelMap } from "./voxelMap.ts";

const PROJECTION = { m00: 1, m11: 1, m02: 0, m12: 0 };
const W = 32, H = 32;

/** A camera at the origin looking down −z at a flat wall `distance` away (0 = nothing). */
function frame(
  distance: number,
  now = 0,
  color: [number, number, number] | null = null,
): VoxelFrame {
  const depth = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Planar depth for a wall facing the camera is the same for every sample.
      depth[j * W + i] = distance;
    }
  }
  const colors = color ? new Float32Array(W * H * 3).map((_, k) => color[k % 3]) : null;
  return {
    cameraPosition: [0, 0, 0],
    cameraQuaternion: [0, 0, 0, 1],
    points: unprojectDepth(depth, W, H, PROJECTION),
    depth,
    width: W,
    height: H,
    projection: PROJECTION,
    colors,
    now,
  };
}

Deno.test("integrating a wall fills cells on the wall, coloured", () => {
  const map = new VoxelMap(0.1, 100000, 1);
  map.integrate(frame(3, 0, [0.2, 0.4, 0.6]));
  assert(map.cells.size > 0);
  for (const cell of map.cells.values()) {
    assertAlmostEquals(cell.z, -3, 1e-6);
    assertAlmostEquals(cell.g, 0.4, 1e-6);
    assert(cell.nz > 0.5); // facing back towards the camera (+z)
  }
});

Deno.test("seeing through a cell carves it away", () => {
  const map = new VoxelMap(0.1, 100000, 1);
  map.integrate(frame(3));
  map.integrate(frame(3));
  const before = map.cells.size;
  for (let n = 0; n < 4; n++) map.integrate(frame(6, n + 1));
  for (const cell of map.cells.values()) assertAlmostEquals(cell.z, -6, 1e-6);
  assert(map.cells.size > 0 && map.cells.size <= before * 4 + 1);
  // Nothing in view (sky) carves too.
  for (let n = 0; n < 12; n++) map.integrate(frame(0, 10 + n));
  assertEquals(map.cells.size, 0);
});

Deno.test("the map keeps at most maxCells, dropping the oldest", () => {
  const map = new VoxelMap(0.05, 50, 1);
  map.integrate(frame(3));
  assertEquals(map.cells.size, 50);
});

Deno.test("moving and turning the camera adds a second surface without moving the first", () => {
  const map = new VoxelMap(0.1, 100000, 4);
  map.integrate(frame(3));
  const first = [...map.cells.keys()];
  const turned = frame(3, 1);
  turned.cameraPosition = [0, 0, 1];
  turned.cameraQuaternion = [0, 1, 0, 0];
  map.integrate(turned);
  for (const key of first) assertAlmostEquals(map.cells.get(key)!.z, -3, 1e-6);
  assert([...map.cells.values()].some((cell) => Math.abs(cell.z - 4) < 1e-6));
});

Deno.test("a long-observed surface can still be carved away promptly", () => {
  const map = new VoxelMap(0.1, 100000, 4);
  for (let n = 0; n < 100; n++) map.integrate(frame(3, n));
  for (let n = 0; n < 31; n++) map.integrate(frame(0, 100 + n));
  assertEquals(map.cells.size, 0);
});

Deno.test("surfels sit on the wall in tracking space under the alignment", () => {
  const map = new VoxelMap(0.1, 100000, 4);
  map.integrate(frame(3));
  map.integrate(frame(3));
  const { positions, count } = map.buildSurfels(
    { yawRad: Math.PI / 2, scale: 2, translation: [1, 0, 0] },
  );
  assert(count > 0);
  // World z = −3 turned 90° about +y lands on x = −3, scaled by 2, then shifted by 1.
  // Corners can lean off the plane by both tangents: at most √2 · half a cell, scaled.
  for (let v = 0; v < count * 6; v++) {
    assertAlmostEquals(positions[v * 3], -5, Math.SQRT2 * 0.1 + 1e-4);
  }
});

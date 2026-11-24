import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import * as THREE from "three";
import { updateDepthSurface, updateOccluderSurface } from "./surface.ts";
import { unprojectDepth } from "./sync.ts";

Deno.test("depth surface cuts missing depth and discontinuities, and survives grid resizing", () => {
  const geometry = new THREE.BufferGeometry();
  const update = (depth: Float32Array, width: number) =>
    updateDepthSurface(geometry, {
      width,
      height: 2,
      depth,
      positions: unprojectDepth(depth, width, 2, { m00: 1, m11: 1, m02: 0, m12: 0 }),
      colors: null,
      revision: 1,
    });
  const version = () =>
    Object.values(geometry.attributes).reduce(
      (sum, a) => sum + (a as THREE.BufferAttribute).version,
      0,
    ) + geometry.index!.version;
  update(new Float32Array([1, 1, 1, 1]), 2);
  assertEquals(Array.from(geometry.index!.array), [0, 2, 1, 1, 2, 3]);
  update(new Float32Array([1, 10, 1, 10]), 2);
  assertEquals(Array.from(geometry.index!.array), [0, 0, 0, 0, 0, 0]);
  update(new Float32Array([0, 0, 0, 0]), 2);
  assert(Array.from(geometry.attributes.position.array).every(Number.isFinite));
  const before = version();
  update(new Float32Array(6).fill(1), 3);
  assert(version() > before);
  assertEquals(geometry.attributes.position.count, 6);
  geometry.dispose();
});

/** A 3x2 grid looking down −z from the origin: a wall at 2 m, the right column at 4 m. */
function grid() {
  const depth = new Float32Array([2, 2, 4, 2, 2, 4]);
  const positions = new Float32Array(18);
  for (let k = 0; k < 6; k++) {
    const i = k % 3, j = Math.floor(k / 3);
    positions.set([(i - 1) * 0.1 * depth[k], (j - 0.5) * 0.1 * depth[k], -depth[k]], k * 3);
  }
  return {
    revision: 1,
    width: 3,
    height: 2,
    positions,
    depth,
    colors: null,
    origin: [0, 0, 0] as const,
  };
}

Deno.test("occluder vertices move biasMeters further along their ray", () => {
  const geometry = new THREE.BufferGeometry();
  const data = grid();
  updateOccluderSurface(geometry, data, 0.02);
  const p = geometry.getAttribute("position").array as Float32Array;
  for (let k = 0; k < 6; k++) {
    const before = Math.hypot(
      data.positions[k * 3],
      data.positions[k * 3 + 1],
      data.positions[k * 3 + 2],
    );
    const after = Math.hypot(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
    assertAlmostEquals(after - before, 0.02, 1e-5);
  }
});

Deno.test("occluder keeps the wall's triangles and cuts across the depth step", () => {
  const geometry = new THREE.BufferGeometry();
  updateOccluderSurface(geometry, grid(), 0);
  const index = geometry.getIndex()!.array;
  assertEquals(index instanceof Uint16Array, true);
  assertEquals(Array.from(index.slice(0, 6)), [0, 3, 1, 1, 3, 4]);
  assertEquals(Array.from(index.slice(6)), [0, 0, 0, 0, 0, 0]);
});

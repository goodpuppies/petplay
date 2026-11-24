import { assert, assertAlmostEquals } from "@std/assert";
import * as THREE from "three";
import { shadowFrustum } from "./shadowFrustum.ts";
import { LIGHTING } from "./format.ts";
import { environmentFromRecord, shadowLight } from "./environmentLighting.ts";

const ndc = (m: THREE.Matrix4, p: number[]) => new THREE.Vector3(...p).applyMatrix4(m);

Deno.test("a light from above maps the casters into the frustum and the floor behind them", () => {
  const f = shadowFrustum([0, 1, 0], [{ center: [1, 1, -2], radius: 0.3 }])!;
  const ball = ndc(f.matrix, [1, 1, -2]);
  const floor = ndc(f.matrix, [1, 0, -2]);
  const top = ndc(f.matrix, [1, 1.3, -2]);
  assertAlmostEquals(ball.x, 0, 1e-6);
  assertAlmostEquals(ball.y, 0, 1e-6);
  // Farther from the light reads deeper.
  assert(top.z < ball.z && ball.z < floor.z && floor.z < 1, `${top.z} ${ball.z} ${floor.z}`);
  // A point beside the ball, outside the margin, falls outside the map.
  assert(Math.abs(ndc(f.matrix, [3, 0, -2]).x) > 1);
});

Deno.test("shadow light: SH-only lighting shadows from the dominant L1 direction", () => {
  const r = new Array(LIGHTING.length).fill(0);
  for (let c = 0; c < 3; c++) {
    r[LIGHTING.sh + c * 4 + 1] = 0.2; // L1 up
    r[LIGHTING.sh + c * 4 + 3] = 0.36; // L0
  }
  const env = environmentFromRecord(r, { yawRad: 0.8, scale: 1, translation: [0, 0, 0] })!;
  const light = shadowLight(env)!;
  for (const [i, want] of [0, 1, 0].entries()) assertAlmostEquals(light.direction[i], want, 1e-9);
  assertAlmostEquals(light.strength, 0.2 / 0.56, 1e-9);
});

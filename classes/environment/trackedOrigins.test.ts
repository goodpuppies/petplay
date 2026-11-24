import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import {
  getTrackedOriginWorldMatrix,
  isTrackedOriginId,
  SPATIAL_ORIGIN_IDS,
  SPATIAL_ORIGIN_LABEL,
  VRC_WORLD_ORIGIN_ID,
} from "./trackedOrigins.ts";
import { setVRCOriginFromHmdMatrix34 } from "../webxrShadowScene.ts";

Deno.test("vrc-world is registered as a tracked spatial origin", () => {
  assert(isTrackedOriginId(VRC_WORLD_ORIGIN_ID));
  assert(SPATIAL_ORIGIN_IDS.includes(VRC_WORLD_ORIGIN_ID));
  assertEquals(SPATIAL_ORIGIN_LABEL[VRC_WORLD_ORIGIN_ID], "VRC World");
});

Deno.test("getTrackedOriginWorldMatrix returns false until VRC origin is known, then copies it", () => {
  const dummyHead = new THREE.Object3D();
  const out = new THREE.Matrix4();

  assertEquals(getTrackedOriginWorldMatrix(VRC_WORLD_ORIGIN_ID, dummyHead, out), false);

  const yaw = Math.PI / 4;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  setVRCOriginFromHmdMatrix34([
    [c, 0, s, -3.5],
    [0, 1, 0, -1.2],
    [-s, 0, c, 7.8],
  ]);

  assertEquals(getTrackedOriginWorldMatrix(VRC_WORLD_ORIGIN_ID, dummyHead, out), true);
  const pos = new THREE.Vector3();
  out.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  assertAlmostEquals(pos.x, -3.5, 1e-5);
  assertAlmostEquals(pos.y, -1.2, 1e-5);
  assertAlmostEquals(pos.z, 7.8, 1e-5);
});

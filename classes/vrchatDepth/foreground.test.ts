import { assertAlmostEquals } from "jsr:@std/assert@^1.0.0";
import * as THREE from "three";
import { foregroundCamera } from "./foreground.ts";
import { debugFrameFromRaw } from "./debugView.ts";
import type { DepthFrameHeader } from "./format.ts";

Deno.test("foreground uses the captured projection, image orientation and tracking scale", () => {
  const header: DepthFrameHeader = {
    timeTag: 1,
    eye: 0,
    flags: 16,
    near: 0.01,
    far: 1000,
    screenWidth: 1920,
    screenHeight: 1000,
    depthRef: 0.05,
    viewToWorld: [1, 0, 0, 4, 0, 1, 0, 1, 0, 0, -1, 3],
    anchorToWorld: [1, 0, 0, 5, 0, 1, 0, 1.6, 0, 0, 1, 4],
    projection: { m00: 1.4, m11: -2, m02: 0.2, m12: -0.1 },
  };
  const frame = debugFrameFromRaw({
    receivedAt: 100,
    decodeMs: 0,
    header,
    width: 2,
    height: 2,
    depth: new Float32Array([2, 4, 6, 8]),
    colors: null,
  }, 1);
  const alignment = { yawRad: 0.4, scale: 0.7, translation: [3, 4, 5] as [number, number, number] };
  const matrices = foregroundCamera(frame, alignment);
  const transform = new THREE.Matrix4().makeRotationY(alignment.yawRad)
    .scale(new THREE.Vector3().setScalar(alignment.scale)).setPosition(...alignment.translation);
  const view = new THREE.Matrix4().fromArray(matrices.viewMatrix);
  const projection = new THREE.Matrix4().fromArray(matrices.projectionMatrix);
  for (let i = 0; i < 4; i++) {
    const point = new THREE.Vector3().fromArray(frame.mesh.positions, i * 3).applyMatrix4(transform)
      .applyMatrix4(view);
    assertAlmostEquals(-point.z, frame.mesh.depth[i] * alignment.scale, 1e-5);
    point.applyMatrix4(projection);
    assertAlmostEquals(point.x, i % 2 ? 0.5 : -0.5, 1e-5);
    assertAlmostEquals(point.y, i < 2 ? 0.5 : -0.5, 1e-5);
  }
});

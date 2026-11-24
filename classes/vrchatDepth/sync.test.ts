import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { DepthFrameHeader } from "./format.ts";
import {
  alignHead,
  AlignmentFilter,
  applyWorldToTracking,
  cameraWorldPose,
  downsampleDepth,
  fovYDeg,
  headWorldPose,
  matrixToQuat,
  rotateVec,
  unprojectDepth,
} from "./sync.ts";
import type { TrackedPose, Vec3 } from "../vrcCameraCalibration.ts";

const EPS = 1e-6;

function header(partial: Partial<DepthFrameHeader>): DepthFrameHeader {
  return {
    timeTag: 0,
    eye: 0,
    flags: 0,
    viewToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0],
    projection: { m00: 1, m11: 1, m02: 0, m12: 0 },
    near: 0.01,
    far: 1000,
    screenWidth: 1920,
    screenHeight: 1000,
    depthRef: 0.05,
    anchorToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    ...partial,
  };
}

/** Unity rotation about +y by `deg` (maps +z towards +x), as a row-major 3x4 at `p`. */
function unityYaw(deg: number, p: Vec3, scale = 1): number[] {
  const a = deg * Math.PI / 180, c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  return [c, 0, s, p[0], 0, scale, 0, p[1], -s, 0, c, p[2]];
}

function forward(pose: TrackedPose): Vec3 {
  return rotateVec(pose.quaternion, [0, 0, -1]);
}

function assertVec(actual: ArrayLike<number>, expected: readonly number[], eps = EPS) {
  for (let i = 0; i < expected.length; i++) assertAlmostEquals(actual[i], expected[i], eps);
}

Deno.test("an unrotated Unity head looks down -z with z mirrored", () => {
  const pose = headWorldPose(header({ anchorToWorld: unityYaw(0, [1, 2, 3]) }));
  assertVec(pose.position, [1, 2, -3]);
  assertVec(forward(pose), [0, 0, -1]);
});

Deno.test("a Unity head turned to +x looks down +x in right-handed space, scale dropped", () => {
  const pose = headWorldPose(header({ anchorToWorld: unityYaw(90, [0, 1.5, 0], 0.3) }));
  assertVec(forward(pose), [1, 0, 0]);
  assertVec(rotateVec(pose.quaternion, [0, 1, 0]), [0, 1, 0]);
});

Deno.test("the camera pose comes from UNITY_MATRIX_I_V", () => {
  // A Unity camera turned to +x: view −z maps to world +x, so I_V = R_y(90) · diag(1, 1, −1).
  const r = unityYaw(90, [4, 1, -2]);
  const iv = [r[0], r[1], -r[2], r[3], r[4], r[5], -r[6], r[7], r[8], r[9], -r[10], r[11]];
  const pose = cameraWorldPose(header({ viewToWorld: iv }));
  assertVec(pose.position, [4, 1, 2]);
  assertVec(forward(pose), [1, 0, 0]);
  assertVec(rotateVec(pose.quaternion, [0, 1, 0]), [0, 1, 0]);
});

Deno.test("the camera and head conventions agree for one Unity rotation", () => {
  const r = unityYaw(-37, [0, 0, 0]);
  const iv = [r[0], r[1], -r[2], 0, r[4], r[5], -r[6], 0, r[8], r[9], -r[10], 0];
  const camera = cameraWorldPose(header({ viewToWorld: iv }));
  const head = headWorldPose(header({ anchorToWorld: r }));
  assertVec(camera.quaternion.map(Math.abs), head.quaternion.map(Math.abs));
});

Deno.test("alignHead recovers a known world to tracking transform", () => {
  const truth = { yawRad: 0.7, scale: 1.273, translation: [0.4, -1.2, 2.5] as Vec3 };
  const head = headWorldPose(header({ anchorToWorld: unityYaw(123, [-4.3, 1.38, -10.9]) }));
  const hmd = applyWorldToTracking(truth, head);
  const fit = alignHead(head, hmd, truth.scale);
  assertAlmostEquals(fit.yawRad, 0.7, EPS);
  // Another world point maps like the truth does: scale included.
  const far = { position: [3, 0.5, -7] as Vec3, quaternion: head.quaternion };
  assertVec(applyWorldToTracking(fit, far).position, applyWorldToTracking(truth, far).position);
  assertVec(fit.translation, truth.translation);
  assertAlmostEquals(fit.tiltDeg, 0, 1e-4);
  // A pitched headset still aligns by yaw, and the residual shows as tilt.
  const pitched = {
    ...hmd,
    quaternion: matrixToQuat([
      1,
      0,
      0,
      0,
      Math.cos(0.1),
      -Math.sin(0.1),
      0,
      Math.sin(0.1),
      Math.cos(0.1),
    ]),
  };
  const tilted = alignHead(head, { ...pitched, quaternion: pitched.quaternion }, truth.scale);
  assertEquals(tilted.tiltDeg > 1, true);
});

Deno.test("the filter averages jitter and snaps on locomotion", () => {
  const filter = new AlignmentFilter(0.5, 0.05);
  filter.push({ yawRad: 0, scale: 1, translation: [0, 0, 0] });
  const averaged = filter.push({ yawRad: 0.01, scale: 1, translation: [0.02, 0, 0] });
  assertAlmostEquals(averaged.translation[0], 0.01, EPS);
  const snapped = filter.push({ yawRad: 0, scale: 1, translation: [1, 0, 0] });
  assertAlmostEquals(snapped.translation[0], 1, EPS);
});

Deno.test("unprojectDepth puts the centre on the axis and the top row up", () => {
  const depth = new Float32Array([2, 2, 2, 0, 2, 2, 2, 2, 2]);
  const points = unprojectDepth(depth, 3, 3, { m00: 1, m11: -1, m02: 0, m12: 0 });
  assertVec(points.subarray(12, 15), [0, 0, -2]); // centre
  assertEquals(points[1] > 0, true); // row 0 is the top of the image
  assertEquals(Number.isNaN(points[9]), true); // no depth
  assertAlmostEquals(fovYDeg(header({ projection: { m00: 1, m11: -1, m02: 0, m12: 0 } })), 90, EPS);
});

Deno.test("downsampleDepth keeps real samples", () => {
  const depth = new Float32Array(16).map((_, i) => i + 1);
  assertEquals(Array.from(downsampleDepth(depth, 4, 4, 2, 2)), [6, 8, 14, 16]);
});

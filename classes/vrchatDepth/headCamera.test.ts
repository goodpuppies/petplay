import { assertAlmostEquals } from "jsr:@std/assert@^1.0.0";
import { applyWorldToTracking, rotateVec } from "./sync.ts";
import { headCameraPose, trackingToWorld } from "./headCamera.ts";
import type { Quat } from "../vrcCameraCalibration.ts";

const alignment = {
  yawRad: 1.2,
  scale: 0.8,
  translation: [1.5, -0.2, 3] as [number, number, number],
};
const q = (axis: [number, number, number], angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

Deno.test("trackingToWorld inverts applyWorldToTracking", () => {
  const world = {
    position: [4, 1.7, -2] as [number, number, number],
    quaternion: q([0.6, 0.8, 0], 0.9),
  };
  const back = trackingToWorld(alignment, applyWorldToTracking(alignment, world));
  for (let i = 0; i < 3; i++) assertAlmostEquals(back.position[i], world.position[i], 1e-9);
  // Same rotation (up to sign).
  const dot = back.quaternion.reduce((s, v, i) => s + v * world.quaternion[i], 0);
  assertAlmostEquals(Math.abs(dot), 1, 1e-9);
});

Deno.test("the head camera sits ahead of the eyes, in Unity's coordinates", () => {
  // Headset at the tracking origin's alignment target, looking along tracking −z, no tilt.
  const hmd = {
    position: [1.5, 1.4, 3] as [number, number, number],
    quaternion: [0, 0, 0, 1] as Quat,
  };
  const pose = headCameraPose(hmd, alignment, 0.2);
  // Expected: the point 0.2 m ahead in tracking, back into the right-handed world, z negated.
  const ahead = trackingToWorld(alignment, { position: [1.5, 1.4, 2.8], quaternion: [0, 0, 0, 1] });
  assertAlmostEquals(pose.position[0], ahead.position[0], 1e-9);
  assertAlmostEquals(pose.position[1], ahead.position[1], 1e-9);
  assertAlmostEquals(pose.position[2], -ahead.position[2], 1e-9);
  // 0.2 tracking metres are 0.25 world metres at scale 0.8.
  const eyes = trackingToWorld(alignment, hmd);
  const d = Math.hypot(...[0, 1, 2].map((i) => ahead.position[i] - eyes.position[i]));
  assertAlmostEquals(d, 0.25, 1e-9);
  // Level view: no pitch or roll.
  assertAlmostEquals(pose.rotationDeg[0], 0, 1e-9);
  assertAlmostEquals(pose.rotationDeg[2], 0, 1e-9);
  void rotateVec;
});

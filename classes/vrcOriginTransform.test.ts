import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Vec3, VrcOriginWorldPose } from "./vrcOriginCodec.ts";
import {
  angleDiffRad,
  computeWorldOriginTranslation,
  hmdYawRightHandedRad,
  type Matrix34Tuple,
  standingPointToUnityWorld,
  transformToHmdMatrix34,
  unityWorldPointToStanding,
  VrcOriginSolver,
  type VrcWorldToStandingTransform,
} from "./vrcOriginTransform.ts";

/** Builds an OpenVR Standing HMD matrix at `pos` with right-handed yaw `yawRH` (CCW from -Z). */
function makeHmdMatrix(pos: Vec3, yawRH: number): Matrix34Tuple {
  const c = Math.cos(yawRH);
  const s = Math.sin(yawRH);
  return [
    [c, 0, s, pos[0]],
    [0, 1, 0, pos[1]],
    [-s, 0, c, pos[2]],
  ];
}

function makeWorldPose(position: Vec3, yawRad: number): VrcOriginWorldPose {
  return { source: "petplay-origin", position, yawRad };
}

function assertVec3AlmostEquals(actual: Vec3, expected: Vec3, eps = 1e-5, msg = ""): void {
  assertAlmostEquals(actual[0], expected[0], eps, `${msg} [x]`);
  assertAlmostEquals(actual[1], expected[1], eps, `${msg} [y]`);
  assertAlmostEquals(actual[2], expected[2], eps, `${msg} [z]`);
}

Deno.test("hmdYawRightHandedRad extracts exact CCW yaw from OpenVR HMD matrices", () => {
  for (const deg of [-170, -90, -45, 0, 30, 90, 135, 179]) {
    const rad = (deg * Math.PI) / 180;
    assertAlmostEquals(hmdYawRightHandedRad(makeHmdMatrix([1, 1.6, -2], rad)), rad, 1e-6);
  }
});

Deno.test("unityWorldPointToStanding and standingPointToUnityWorld round-trip exactly", () => {
  const transform: VrcWorldToStandingTransform = {
    yawRad: 0.73,
    scale: 1.25,
    translation: [-4.2, -1.8, 9.5],
  };
  const points: Vec3[] = [
    [0, 0, 0],
    [12.3, 4.5, -6.7],
    [-100, 2.1, 42.8],
  ];
  for (const pt of points) {
    const standing = unityWorldPointToStanding(transform, pt);
    const back = standingPointToUnityWorld(transform, standing);
    assertVec3AlmostEquals(back, pt, 1e-5);
  }
});

Deno.test("world origin signs: avatar at Unity (+5, +2, +10) facing +Z puts world origin at Standing (-5, -2, +10)", () => {
  const solver = new VrcOriginSolver();
  const res = solver.update(
    makeWorldPose([5, 2, 10], 0),
    makeHmdMatrix([0, 1.6, 0], 0),
  );
  assertAlmostEquals(res.transform.yawRad, 0, 1e-6);
  assertVec3AlmostEquals(res.transform.translation, [-5, -2, 10], 1e-6);
  // Avatar's own world position maps to Standing (0, 0, 0) (feet under HMD).
  assertVec3AlmostEquals(unityWorldPointToStanding(res.transform, [5, 2, 10]), [0, 0, 0], 1e-6);
  // World origin (0, 0, 0) maps to Standing (-5, -2, +10).
  assertVec3AlmostEquals(unityWorldPointToStanding(res.transform, [0, 0, 0]), [-5, -2, 10], 1e-6);
});

Deno.test("room-scale walking keeps VRChat world origin invariant at arbitrary playspace yaw", () => {
  // Playspace rotated +56.8 deg (like our live VRChat capture).
  const trueYaw = (56.8 * Math.PI) / 180;
  const trueOriginInStanding: Vec3 = [-3.4, -1.2, 8.7];
  const trueTransform: VrcWorldToStandingTransform = {
    yawRad: trueYaw,
    scale: 1,
    translation: trueOriginInStanding,
  };

  const solver = new VrcOriginSolver();
  const hmdSteps: Array<{ pos: Vec3; hmdYaw: number }> = [
    { pos: [0, 1.6, 0], hmdYaw: 0 },
    { pos: [0.6, 1.6, -0.4], hmdYaw: 0 },
    { pos: [-0.8, 1.55, 0.9], hmdYaw: 0.3 },
    { pos: [1.1, 1.62, 0.2], hmdYaw: -0.4 },
  ];

  for (const step of hmdSteps) {
    // Ground-truth avatar root in Unity world space is Standing (hmdX, 0, hmdZ) mapped to Unity world.
    const avatarWorldPos = standingPointToUnityWorld(trueTransform, [step.pos[0], 0, step.pos[2]]);
    const avatarWorldYaw = trueYaw - step.hmdYaw;
    const res = solver.update(
      makeWorldPose(avatarWorldPos, avatarWorldYaw),
      makeHmdMatrix(step.pos, step.hmdYaw),
    );
    assertAlmostEquals(angleDiffRad(res.transform.yawRad, trueYaw), 0, 1e-5);
    assertVec3AlmostEquals(res.transform.translation, trueOriginInStanding, 1e-5);
  }
});

Deno.test("head-only look-around does not drift playspace yaw, and body catch-up keeps it locked", () => {
  const trueYaw = 0.5;
  const solver = new VrcOriginSolver();

  // Initial aligned state.
  let res = solver.update(makeWorldPose([1, 0, 2], trueYaw), makeHmdMatrix([0, 1.6, 0], 0));
  assertAlmostEquals(res.transform.yawRad, trueYaw, 1e-6);

  // Case 1: Turn head 30 deg left without body rotating (avatar root yaw unchanged).
  const head30 = (30 * Math.PI) / 180;
  res = solver.update(makeWorldPose([1, 0, 2], trueYaw), makeHmdMatrix([0, 1.6, 0], head30));
  assertAlmostEquals(res.transform.yawRad, trueYaw, 1e-6);

  // Case 4: Body catches up 30 deg left (Unity yaw decreases by 30 deg -> rawYaw returns to trueYaw).
  res = solver.update(makeWorldPose([1, 0, 2], trueYaw - head30), makeHmdMatrix([0, 1.6, 0], head30));
  assertAlmostEquals(res.transform.yawRad, trueYaw, 1e-6);
});

Deno.test("joystick snap-turn and smooth-turn update playspace yaw accurately even with head offset", () => {
  const trueYaw = 0.2;
  const solver = new VrcOriginSolver();

  // Start aligned.
  solver.update(makeWorldPose([0, 0, 0], trueYaw), makeHmdMatrix([0, 1.6, 0], 0));

  // Look 20 deg left with head only (avatar yaw stays at trueYaw).
  const head20 = (20 * Math.PI) / 180;
  let res = solver.update(makeWorldPose([0, 0, 0], trueYaw), makeHmdMatrix([0, 1.6, 0], head20));
  assertAlmostEquals(res.transform.yawRad, trueYaw, 1e-6);

  // Now snap-turn 45 deg right with joystick (Unity yaw increases by +45 deg, HMD yaw unchanged).
  const snap45 = (45 * Math.PI) / 180;
  res = solver.update(
    makeWorldPose([0, 0, 0], trueYaw + snap45),
    makeHmdMatrix([0, 1.6, 0], head20),
  );
  assertAlmostEquals(angleDiffRad(res.transform.yawRad, trueYaw + snap45), 0, 1e-6);

  // Smooth-turn another 10 deg right in 5 steps of 2 deg.
  const step2 = (2 * Math.PI) / 180;
  for (let i = 1; i <= 5; i++) {
    res = solver.update(
      makeWorldPose([0, 0, 0], trueYaw + snap45 + i * step2),
      makeHmdMatrix([0, 1.6, 0], head20),
    );
  }
  assertAlmostEquals(angleDiffRad(res.transform.yawRad, trueYaw + snap45 + 5 * step2), 0, 1e-6);
});

Deno.test("transformToHmdMatrix34 matches unityWorldPointToStanding", () => {
  const transform: VrcWorldToStandingTransform = {
    yawRad: -1.1,
    scale: 1,
    translation: computeWorldOriginTranslation([3, 1, -4], [0.5, 1.6, -0.2], -1.1, 1),
  };
  const m = transformToHmdMatrix34(transform);
  const pUnity: Vec3 = [7, 2.5, 11];
  const pRH: Vec3 = [pUnity[0], pUnity[1], -pUnity[2]];
  const viaMatrix: Vec3 = [
    m[0][0] * pRH[0] + m[0][1] * pRH[1] + m[0][2] * pRH[2] + m[0][3],
    m[1][0] * pRH[0] + m[1][1] * pRH[1] + m[1][2] * pRH[2] + m[1][3],
    m[2][0] * pRH[0] + m[2][1] * pRH[1] + m[2][2] * pRH[2] + m[2][3],
  ];
  assertVec3AlmostEquals(viaMatrix, unityWorldPointToStanding(transform, pUnity), 1e-6);
});

Deno.test("publish threshold suppresses sub-millimeter no-op updates", () => {
  const solver = new VrcOriginSolver();
  const r1 = solver.update(makeWorldPose([1, 2, 3], 0.5), makeHmdMatrix([0, 1.6, 0], 0));
  assertEquals(r1.changed, true);
  const r2 = solver.update(makeWorldPose([1.0001, 2, 3], 0.5), makeHmdMatrix([0, 1.6, 0], 0));
  assertEquals(r2.changed, false);
  const r3 = solver.update(makeWorldPose([1.01, 2, 3], 0.5), makeHmdMatrix([0, 1.6, 0], 0));
  assertEquals(r3.changed, true);
  assert(r3.matrix[0][3] !== r1.matrix[0][3]);
});

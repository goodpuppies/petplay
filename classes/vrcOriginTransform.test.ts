import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Vec3, VrcOriginWorldPose } from "./vrcOriginCodec.ts";
import {
  angleDiffRad,
  computeWorldOriginTranslation,
  evaluateVrcOriginMotion,
  hmdYawRightHandedRad,
  type Matrix34Tuple,
  standingPointToUnityWorld,
  transformToHmdMatrix34,
  unityWorldPointToStanding,
  VrcOriginRoomLock,
  VrcOriginSolver,
  VrcRootPredictor,
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
  res = solver.update(
    makeWorldPose([1, 0, 2], trueYaw - head30),
    makeHmdMatrix([0, 1.6, 0], head30),
  );
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

/** Feeds solver + lock one sample, like `petplay/VRCOrigin.ts` does. */
function lockStep(
  solver: VrcOriginSolver,
  lock: VrcOriginRoomLock,
  world: VrcOriginWorldPose,
  hmdPos: Vec3,
  hmdYaw: number,
  hmdSpeed: number,
  now: number,
) {
  const raw = solver.update(world, makeHmdMatrix(hmdPos, hmdYaw));
  return lock.update(raw.transform, world, hmdPos, hmdSpeed, now);
}

Deno.test("room lock: head motion against a stale avatar root leaves the output frozen", () => {
  const solver = new VrcOriginSolver();
  const lock = new VrcOriginRoomLock();
  const world = makeWorldPose([12, 0.6, -22], 0.1);
  let t = 0;
  let res = lockStep(solver, lock, world, [0, 1.6, 0], 0, 0, t);
  for (; t <= 400; t += 16) res = lockStep(solver, lock, world, [0, 1.6, 0], 0, 0, t);
  assertEquals(res.mode, "locked");
  const lockedTranslation = [...res.transform.translation] as Vec3;

  // Lean and turn the head; the avatar root (OSC, ~8 Hz) lags and sits under the neck.
  for (let i = 0; i < 60; i++, t += 16) {
    const sway = 0.08 * Math.sin(i / 6);
    res = lockStep(solver, lock, world, [sway, 1.6, sway / 2], 0.3 * Math.sin(i / 9), 0.4, t);
    assertEquals(res.mode, "locked");
    assertEquals(res.changed, false);
  }
  assertVec3AlmostEquals(res.transform.translation, lockedTranslation, 0);
});

Deno.test("room lock: joystick walking breaks the lock, follows, then re-locks where it stopped", () => {
  const solver = new VrcOriginSolver();
  const lock = new VrcOriginRoomLock();
  const hmd: Vec3 = [0.3, 1.6, -0.2];
  let t = 0;
  let res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), hmd, 0, 0, t);
  for (; t <= 400; t += 16) res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), hmd, 0, 0, t);
  assertEquals(res.mode, "locked");

  // Walk 2 m along Unity +Z at 3 m/s with the stick; the head stays put in the room.
  let z = 0;
  let sawMoving = false;
  for (; z < 2; t += 16) {
    z = Math.min(2, z + 0.048);
    res = lockStep(solver, lock, makeWorldPose([0, 0, z], 0), hmd, 0, 0, t);
    sawMoving ||= res.mode === "moving";
  }
  assert(sawMoving, "walking with the stick unlocks");
  for (const end = t + 400; t <= end; t += 16) {
    res = lockStep(solver, lock, makeWorldPose([0, 0, 2], 0), hmd, 0, 0, t);
  }
  assertEquals(res.mode, "locked");
  // The avatar root maps to the floor under the HMD again.
  assertVec3AlmostEquals(
    unityWorldPointToStanding(res.transform, [0, 0, 2]),
    [hmd[0], 0, hmd[2]],
    1e-6,
  );
});

Deno.test("room lock: a snap turn breaks the lock", () => {
  const solver = new VrcOriginSolver();
  const lock = new VrcOriginRoomLock();
  let t = 0;
  let res = lockStep(solver, lock, makeWorldPose([1, 0, 1], 0.2), [0, 1.6, 0], 0, 0, t);
  for (; t <= 400; t += 16) {
    res = lockStep(solver, lock, makeWorldPose([1, 0, 1], 0.2), [0, 1.6, 0], 0, 0, t);
  }
  assertEquals(res.mode, "locked");
  res = lockStep(solver, lock, makeWorldPose([1, 0, 1], 0.2 + Math.PI / 4), [0, 1.6, 0], 0, 0, t);
  assertEquals(res.mode, "moving");
  assertAlmostEquals(angleDiffRad(res.transform.yawRad, 0.2 + Math.PI / 4), 0, 1e-6);
});

Deno.test("room lock: a small lasting offset with a still head breaks the lock, a moving head does not", () => {
  const make = () => {
    const solver = new VrcOriginSolver();
    const lock = new VrcOriginRoomLock();
    let t = 0;
    for (; t <= 400; t += 16) {
      lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), [0, 1.6, 0], 0, 0, t);
    }
    return { solver, lock, t };
  };
  // A 0.2 m joystick nudge, then still.
  const still = make();
  let res = lockStep(
    still.solver,
    still.lock,
    makeWorldPose([0, 0, 0.2], 0),
    [0, 1.6, 0],
    0,
    0,
    still.t,
  );
  assertEquals(res.mode, "locked");
  for (let t = still.t; t <= still.t + 500; t += 16) {
    res = lockStep(
      still.solver,
      still.lock,
      makeWorldPose([0, 0, 0.2], 0),
      [0, 1.6, 0],
      0,
      0.05,
      t,
    );
  }
  assertEquals(res.mode, "moving");

  // The same offset while the head moves fast (latency, not locomotion) keeps the lock.
  const moving = make();
  for (let t = moving.t; t <= moving.t + 500; t += 16) {
    res = lockStep(
      moving.solver,
      moving.lock,
      makeWorldPose([0, 0, 0.2], 0),
      [0, 1.6, 0],
      0,
      0.8,
      t,
    );
  }
  assertEquals(res.mode, "locked");
});

Deno.test("root predictor: jittery arrivals of a steady run predict the true path, yaw-only bursts do not stall it", () => {
  const predictor = new VrcRootPredictor();
  // 4 m/s along -X in 0.16 m ticks every 40 ms; arrivals jittered ±18 ms; every third burst
  // only changes yaw (the position repeats).
  const jitter = [0, 14, -11, 18, -6, 9, -17, 3, 12, -9, 6, -14, 16, -3, 8];
  let yaw = 0.1;
  for (let i = 0; i < jitter.length; i++) {
    const tTrue = 1000 + i * 40;
    if (i % 3 === 2) {
      yaw += 0.001;
      const prev = 10 - 0.16 * (i - 1);
      predictor.add({ t: tTrue + jitter[i], pose: makeWorldPose([prev, 0, 0], yaw) });
    } else {
      predictor.add({ t: tTrue + jitter[i], pose: makeWorldPose([10 - 0.16 * i, 0, 0], yaw) });
    }
  }
  const now = 1000 + 14 * 40 + 20;
  const p = predictor.predict(now);
  assertAlmostEquals(p.pose.position[0], 10 - 4 * (now - 1000) / 1000, 0.06);
  assertAlmostEquals(p.velocity[0], -4, 0.6);
});

Deno.test("root predictor: after a stop (silence) it settles on the last sample", () => {
  const predictor = new VrcRootPredictor();
  for (let i = 0; i <= 6; i++) {
    predictor.add({ t: i * 40, pose: makeWorldPose([0.16 * i, 0, 0], 0) });
  }
  const settled = predictor.predict(6 * 40 + 1000);
  assertAlmostEquals(settled.pose.position[0], 0.96, 1e-9);
  assertEquals(settled.velocity, [0, 0, 0]);
});

Deno.test("root predictor: a snap turn is taken at once, not smeared", () => {
  const predictor = new VrcRootPredictor();
  for (let i = 0; i <= 4; i++) predictor.add({ t: i * 40, pose: makeWorldPose([0, 0, 0], 0.2) });
  predictor.add({ t: 200, pose: makeWorldPose([0, 0, 0], 0.2 + Math.PI / 4) });
  assertAlmostEquals(predictor.predict(205).pose.yawRad, 0.2 + Math.PI / 4, 1e-9);
});

Deno.test("motion model at its own time equals the solver's transform, and follows the root", () => {
  const yawRad = 0.7;
  const unityRoot: Vec3 = [3, 1, -4];
  const hmd: Vec3 = [0.4, 1.6, -0.3];
  const translation = computeWorldOriginTranslation(unityRoot, hmd, yawRad, 1);
  const motion = {
    t: 5000,
    yawRad,
    yawRate: 0,
    scale: 1,
    pivot: [hmd[0], 0, hmd[2]] as Vec3,
    rootRH: [unityRoot[0], unityRoot[1], -unityRoot[2]] as Vec3,
    rootVelocityRH: [2, 0, 0] as Vec3,
  };
  assertVec3AlmostEquals(evaluateVrcOriginMotion(motion, 5000).translation, translation, 1e-9);
  // 30 ms later the root has moved 6 cm along world +X, and still maps to the pivot.
  const later = evaluateVrcOriginMotion(motion, 5030);
  assertVec3AlmostEquals(
    unityWorldPointToStanding(later, [unityRoot[0] + 0.06, unityRoot[1], unityRoot[2]]),
    [hmd[0], 0, hmd[2]],
    1e-9,
  );
});

Deno.test("root predictor display: jittery arrivals of a constant walk show as a smooth path", () => {
  const predictor = new VrcRootPredictor();
  const jitter = [0, 14, -11, 18, -6, 9, -17, 3, 12, -9, 6, -14, 16, -3, 8, -12, 10, -5, 15, -8];
  const samples = jitter.map((j, i) => ({ t: 1000 + i * 40 + j, x: 0.04 * i })); // 1 m/s
  let k = 0;
  const shown: number[] = [];
  for (let t = 1000; t < 1000 + 19 * 40; t += 11) {
    while (k < samples.length && samples[k].t <= t) {
      predictor.add({ t: samples[k].t, pose: makeWorldPose([samples[k].x, 0, 0], 0) });
      k++;
    }
    if (k) shown.push(predictor.display(t).pose.position[0]);
  }
  // After settling in, the shown speed stays near 1 m/s (11 mm a frame): ±18 ms arrival jitter on
  // 40 ms spacing still leaves some, but no frame stands still or doubles up.
  for (let i = 30; i < shown.length; i++) {
    assertAlmostEquals(shown[i] - shown[i - 1], 0.011, 0.0045, `frame ${i}`);
  }
});

Deno.test("room lock: breaking the lock blends from the held transform instead of snapping", () => {
  const solver = new VrcOriginSolver();
  const lock = new VrcOriginRoomLock();
  const hmd: Vec3 = [0, 1.6, 0];
  let t = 0;
  let res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), hmd, 0, 0, t);
  for (; t <= 400; t += 16) res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), hmd, 0, 0, t);
  const held = [...res.transform.translation];
  // Locomotion starts: the root is 0.5 m off at once (as if VRChat jumped ahead).
  const raw = solver.update(makeWorldPose([0, 0, 0.5], 0), makeHmdMatrix(hmd, 0));
  res = lock.update(raw.transform, makeWorldPose([0, 0, 0.5], 0), hmd, 0, t, 1.0);
  assertEquals(res.mode, "moving");
  assert(
    Math.hypot(...res.transform.translation.map((v, k) => v - held[k])) < 0.01,
    "the first moving output is still at the held transform",
  );
  for (const end = t + 500; t <= end; t += 16) {
    res = lock.update(raw.transform, makeWorldPose([0, 0, 0.5], 0), hmd, 0, t, 1.0);
  }
  assertVec3AlmostEquals(res.transform.translation, raw.transform.translation, 1e-9);
});

Deno.test("root predictor: a skipped update slows the prediction instead of stopping it dead", () => {
  const predictor = new VrcRootPredictor();
  for (let i = 0; i <= 10; i++) {
    predictor.add({ t: i * 40, pose: makeWorldPose([0.04 * i, 0, 0], 0) });
  }
  // 150 ms of silence mid-walk: still moving, slower, and never backwards.
  let prev = predictor.predict(400).pose.position[0];
  for (let t = 411; t <= 550; t += 11) {
    const x = predictor.predict(t).pose.position[0];
    assert(x > prev, `still advancing at ${t}`);
    prev = x;
  }
  assert(predictor.predict(550).velocity[0] > 0.1);
});

/** A constant 1 m/s walk along +X with the given arrival jitter, the stick held throughout. */
function stickWalk(predictor: VrcRootPredictor, jitter: number[], stick: boolean) {
  const samples = jitter.map((j, i) => ({ t: 1000 + i * 40 + j, x: 0.04 * i }));
  let k = 0;
  const shown: number[] = [];
  for (let t = 1000; t < 1000 + (jitter.length - 1) * 40; t += 11) {
    if (stick) predictor.setInput({ t, move: [0, 1], turn: 0, headYawRate: 0 });
    while (k < samples.length && samples[k].t <= t) {
      predictor.add({ t: samples[k].t, pose: makeWorldPose([samples[k].x, 0, 0], 0) });
      k++;
    }
    if (k) shown.push(predictor.display(t).pose.position[0]);
  }
  return shown;
}

Deno.test("sticks: a steady held stick shows a steady speed despite arrival jitter", () => {
  const jitter = [0, 14, -11, 18, -6, 9, -17, 3, 12, -9, 6, -14, 16, -3, 8, -12, 10, -5, 15, -8];
  const spread = (shown: number[]) => {
    const steps = shown.slice(40).map((x, i) => x - shown[39 + i]);
    return Math.max(...steps) - Math.min(...steps);
  };
  const without = spread(stickWalk(new VrcRootPredictor(), jitter, false));
  const withStick = spread(stickWalk(new VrcRootPredictor(), jitter, true));
  assert(withStick < without / 2, `stick ${withStick} vs no stick ${without}`);
});

Deno.test("sticks: releasing the stick stops the estimate there, without overshoot", () => {
  const predictor = new VrcRootPredictor();
  for (let i = 0; i <= 10; i++) {
    predictor.setInput({ t: i * 40, move: [0, 1], turn: 0, headYawRate: 0 });
    predictor.add({ t: i * 40, pose: makeWorldPose([0.04 * i, 0, 0], 0) });
  }
  predictor.setInput({ t: 405, move: [0, 0], turn: 0, headYawRate: 0 });
  // VRChat stopped at ~0.40 m; a late sample confirms it.
  predictor.add({ t: 440, pose: makeWorldPose([0.402, 0, 0], 0) });
  for (let t = 410; t <= 700; t += 10) {
    predictor.setInput({ t, move: [0, 0], turn: 0, headYawRate: 0 });
    assert(predictor.predict(t).pose.position[0] < 0.42, `no overshoot at ${t}`);
  }
});

Deno.test("room lock: a held stick breaks the lock at once and keeps it open", () => {
  const solver = new VrcOriginSolver();
  const lock = new VrcOriginRoomLock();
  let t = 0;
  let res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), [0, 1.6, 0], 0, 0, t);
  for (; t <= 400; t += 16) {
    res = lockStep(solver, lock, makeWorldPose([0, 0, 0], 0), [0, 1.6, 0], 0, 0, t);
  }
  assertEquals(res.mode, "locked");
  const raw = solver.update(makeWorldPose([0, 0, 0], 0), makeHmdMatrix([0, 1.6, 0], 0));
  for (const end = t + 600; t <= end; t += 16) {
    res = lock.update(raw.transform, makeWorldPose([0, 0, 0], 0), [0, 1.6, 0], 0, t, 0, true);
    assertEquals(res.mode, "moving");
  }
});

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  CUSTOM_OBJECT_SYNC_PARAMS,
  decodeLegacyCustomObjectSyncPose,
  decodeOverlappingProximityAxis,
  decodePetPlayOriginPose,
  decodePetPlayOriginV2Pose,
  decodePhysBoneYawRad,
  decodeVrcOriginPose,
  encodeOverlappingProximityAxis,
  encodePetPlayOriginV2Pose,
  encodePetPlayOriginV2RigPose,
  encodePhysBoneYawRad,
  isOverlappingProximityConsistent,
  isVrcOriginOscAddress,
  PETPLAY_ORIGIN_PARAMS,
  PETPLAY_ORIGIN_V2_COARSE_PARAMS,
  PETPLAY_ORIGIN_V2_PARAMS,
} from "./vrcOriginCodec.ts";

Deno.test("overlapping proximity axis round-trips across full ±512 m range including origin and overlap transitions", () => {
  const samples = [
    -511.5,
    -256,
    -102.5,
    -102.4,
    -102.3,
    -50,
    -1,
    -0.001,
    0,
    0.001,
    1,
    50,
    102.3,
    102.4,
    102.5,
    256,
    511.5,
  ];

  for (const expected of samples) {
    const [pos, neg] = encodeOverlappingProximityAxis(expected);
    assert(
      isOverlappingProximityConsistent(pos, neg),
      `inconsistent overlap at ${expected}: pos=${pos}, neg=${neg}`,
    );
    const decoded = decodeOverlappingProximityAxis(pos, neg);
    assert(decoded !== null, `expected valid decode at ${expected}`);
    assertAlmostEquals(decoded, expected, 1e-4, `mismatch at ${expected}`);
  }
});

Deno.test("overlapping proximity at world origin (0 m) keeps both receivers strictly active (~1/6)", () => {
  const [pos, neg] = encodeOverlappingProximityAxis(0);
  assertAlmostEquals(pos, 1 / 6, 1e-6);
  assertAlmostEquals(neg, 1 / 6, 1e-6);
  assertAlmostEquals(pos + neg, 1 / 3, 1e-6);
  assertAlmostEquals(decodeOverlappingProximityAxis(pos, neg)!, 0, 1e-6);
});

Deno.test("overlapping proximity returns null when both contacts are 0 (inactive / out of range)", () => {
  assertEquals(decodeOverlappingProximityAxis(0, 0), null);
  assertEquals(decodeOverlappingProximityAxis(NaN, 0.2), null);
});

Deno.test("PhysBone yaw round-trips continuously around full 360 degrees", () => {
  for (let deg = -179; deg <= 180; deg += 7) {
    const rad = (deg * Math.PI) / 180;
    const [mag, sign] = encodePhysBoneYawRad(rad);
    const decoded = decodePhysBoneYawRad(mag, sign);
    assertAlmostEquals(decoded, rad, 1e-6, `mismatch at ${deg} deg`);
  }

  // Jitter near 0 degrees should not flip by 180 degrees.
  const [mag0, sign0] = encodePhysBoneYawRad(0.0005);
  assertAlmostEquals(decodePhysBoneYawRad(mag0, sign0 + 0.0002), 0, 0.01);

  // Jitter near 180 degrees stays near ±pi.
  const [magPi, signPi] = encodePhysBoneYawRad(Math.PI - 0.001);
  assertAlmostEquals(Math.abs(decodePhysBoneYawRad(magPi, signPi)), Math.PI, 0.01);
});

Deno.test("decodePetPlayOriginPose decodes full 3D position + yaw and handles omitted zero-valued channels", () => {
  const [xPos, xNeg] = encodeOverlappingProximityAxis(12.345);
  const [yPos, yNeg] = encodeOverlappingProximityAxis(-200.5);
  const [zPos, zNeg] = encodeOverlappingProximityAxis(0);
  const [yawMag, yawSign] = encodePhysBoneYawRad(-1.23);

  // Simulate VRChat omitting yPos (since y = -200.5 is outside positive receiver -> stays default 0).
  const coords: Record<string, number> = {
    [PETPLAY_ORIGIN_PARAMS.posXPos]: xPos,
    [PETPLAY_ORIGIN_PARAMS.posXNeg]: xNeg,
    [PETPLAY_ORIGIN_PARAMS.posYNeg]: yNeg,
    [PETPLAY_ORIGIN_PARAMS.posZPos]: zPos,
    [PETPLAY_ORIGIN_PARAMS.posZNeg]: zNeg,
    [PETPLAY_ORIGIN_PARAMS.yawMag]: yawMag,
    [PETPLAY_ORIGIN_PARAMS.yawSign]: yawSign,
  };
  assertEquals(yPos, 0);

  const pose = decodePetPlayOriginPose(coords);
  assert(pose !== null);
  assertEquals(pose.source, "petplay-origin");
  assertAlmostEquals(pose.position[0], 12.345, 1e-4);
  assertAlmostEquals(pose.position[1], -200.5, 1e-4);
  assertAlmostEquals(pose.position[2], 0, 1e-4);
  assertAlmostEquals(pose.yawRad, -1.23, 1e-5);
});

Deno.test("decodeVrcOriginPose prefers PetPlay/Origin over legacy CustomObjectSync and falls back cleanly", () => {
  const [xPos, xNeg] = encodeOverlappingProximityAxis(5);
  const [yPos, yNeg] = encodeOverlappingProximityAxis(2);
  const [zPos, zNeg] = encodeOverlappingProximityAxis(-7);
  const [yawMag, yawSign] = encodePhysBoneYawRad(0.5);

  const legacyOnly: Record<string, number> = {
    [CUSTOM_OBJECT_SYNC_PARAMS.posX]: 0.5 + 10 / 512,
    [CUSTOM_OBJECT_SYNC_PARAMS.posY]: 0.5 + 3 / 512,
    [CUSTOM_OBJECT_SYNC_PARAMS.posZ]: 0.5 - 4 / 512,
    [CUSTOM_OBJECT_SYNC_PARAMS.rotY]: 0.25,
  };
  const legacyPose = decodeVrcOriginPose(legacyOnly);
  assert(legacyPose !== null);
  assertEquals(legacyPose.source, "custom-object-sync");
  assertAlmostEquals(legacyPose.position[0], 10, 1e-4);
  assertAlmostEquals(legacyPose.position[1], 3, 1e-4);
  assertAlmostEquals(legacyPose.position[2], -4, 1e-4);
  assertAlmostEquals(legacyPose.yawRad, Math.PI / 2, 1e-5);

  const both: Record<string, number> = {
    ...legacyOnly,
    [PETPLAY_ORIGIN_PARAMS.posXPos]: xPos,
    [PETPLAY_ORIGIN_PARAMS.posXNeg]: xNeg,
    [PETPLAY_ORIGIN_PARAMS.posYPos]: yPos,
    [PETPLAY_ORIGIN_PARAMS.posYNeg]: yNeg,
    [PETPLAY_ORIGIN_PARAMS.posZPos]: zPos,
    [PETPLAY_ORIGIN_PARAMS.posZNeg]: zNeg,
    [PETPLAY_ORIGIN_PARAMS.yawMag]: yawMag,
    [PETPLAY_ORIGIN_PARAMS.yawSign]: yawSign,
  };
  const preferred = decodeVrcOriginPose(both);
  assert(preferred !== null);
  assertEquals(preferred.source, "petplay-origin");
  assertAlmostEquals(preferred.position[0], 5, 1e-4);
  assertAlmostEquals(preferred.position[1], 2, 1e-4);
  assertAlmostEquals(preferred.position[2], -7, 1e-4);
  assertAlmostEquals(preferred.yawRad, 0.5, 1e-5);
});

Deno.test("decodeLegacyCustomObjectSyncPose returns null when incomplete", () => {
  assertEquals(decodeLegacyCustomObjectSyncPose({}), null);
  assertEquals(decodeLegacyCustomObjectSyncPose({ [CUSTOM_OBJECT_SYNC_PARAMS.posX]: 0.5 }), null);
});

Deno.test("isVrcOriginOscAddress matches both new and legacy prefixes", () => {
  assert(isVrcOriginOscAddress(PETPLAY_ORIGIN_PARAMS.posXPos));
  assert(isVrcOriginOscAddress(PETPLAY_ORIGIN_PARAMS.yawMag));
  assert(isVrcOriginOscAddress(CUSTOM_OBJECT_SYNC_PARAMS.posX));
  assert(!isVrcOriginOscAddress("/avatar/parameters/VelocityX"));
});

Deno.test("v2 decode keeps float32 world precision across the range, for any scale exponent", () => {
  const positions: [number, number, number][] = [
    [0, 0, 0],
    [0.001, -0.002, 0.003],
    [12.345, 1.5, -67.89],
    [-1000.125, 250.5, 4000.75],
    [8000, -3000, 6000.3],
  ];
  for (const n of [6, 10, 13, 16]) {
    for (const position of positions) {
      if (Math.hypot(...position) >= 2 ** n) continue;
      for (const yawDeg of [-179, -90, -1, 0, 37, 90, 180]) {
        const yawRad = (yawDeg * Math.PI) / 180;
        const pose = decodePetPlayOriginV2Pose(encodePetPlayOriginV2Pose(position, yawRad, n));
        assert(pose, `no decode at ${position} N=${n}`);
        assertEquals(pose.source, "petplay-origin-v2");
        for (let i = 0; i < 3; i++) {
          // A power-of-two scale is exact: the only error is float32 rounding of the coordinate.
          assertEquals(
            pose.position[i],
            Math.fround(position[i]),
            `axis ${i} at ${position} N=${n}`,
          );
        }
        const yawError = Math.atan2(Math.sin(pose.yawRad - yawRad), Math.cos(pose.yawRad - yawRad));
        const bound = 1e-6 + Math.hypot(...position) * 2 ** -25;
        assert(Math.abs(yawError) < bound, `yaw ${yawDeg} at ${position} N=${n}: ${yawError}`);
      }
    }
  }
});

Deno.test("v2 decode needs both receivers present and a power-of-two forward offset", () => {
  const good = encodePetPlayOriginV2Pose([10, 2, -30], 0.5);
  assert(decodePetPlayOriginV2Pose(good));
  assertEquals(decodePetPlayOriginV2Pose({ ...good, [PETPLAY_ORIGIN_V2_PARAMS.pos]: 0 }), null);
  const noFwd = { ...good };
  delete noFwd[PETPLAY_ORIGIN_V2_PARAMS.fwd];
  assertEquals(decodePetPlayOriginV2Pose(noFwd), null);
  // Forward offset 1.5 * 2^-5: not a power of two.
  const torn = {
    ...good,
    [PETPLAY_ORIGIN_V2_PARAMS.fwdX]: good[PETPLAY_ORIGIN_V2_PARAMS.posX],
    [PETPLAY_ORIGIN_V2_PARAMS.fwdZ]: good[PETPLAY_ORIGIN_V2_PARAMS.posZ] + 1.5 * 2 ** -5,
  };
  assertEquals(decodePetPlayOriginV2Pose(torn), null);
  // Coincident senders.
  const zero = {
    ...good,
    [PETPLAY_ORIGIN_V2_PARAMS.fwdX]: good[PETPLAY_ORIGIN_V2_PARAMS.posX],
    [PETPLAY_ORIGIN_V2_PARAMS.fwdZ]: good[PETPLAY_ORIGIN_V2_PARAMS.posZ],
  };
  assertEquals(decodePetPlayOriginV2Pose(zero), null);
});

Deno.test("v2 decode tolerates a frame-old Fwd while walking", () => {
  // Pos from this frame, Fwd from one 90 Hz frame earlier at 5 m/s (~5.6 cm behind).
  const now = encodePetPlayOriginV2Pose([100, 0, 50], 0);
  const before = encodePetPlayOriginV2Pose([100, 0, 50 - 5 / 90], 0);
  const mixed = { ...now };
  for (const k of ["fwd", "fwdX", "fwdY", "fwdZ"] as const) {
    mixed[PETPLAY_ORIGIN_V2_PARAMS[k]] = before[PETPLAY_ORIGIN_V2_PARAMS[k]];
  }
  const pose = decodePetPlayOriginV2Pose(mixed);
  assert(pose);
  assertAlmostEquals(pose.position[2], 50, 1e-3);
  // Sideways at 15 m/s (flying): the 8 m forward offset keeps the heading within ~1.2 degrees.
  const side = encodePetPlayOriginV2Pose([100 - 15 / 90, 0, 50], 0);
  const skewed = { ...now };
  for (const k of ["fwd", "fwdX", "fwdY", "fwdZ"] as const) {
    skewed[PETPLAY_ORIGIN_V2_PARAMS[k]] = side[PETPLAY_ORIGIN_V2_PARAMS[k]];
  }
  const sidePose = decodePetPlayOriginV2Pose(skewed);
  assert(sidePose);
  assert(Math.abs(sidePose.yawRad) < 1.2 * Math.PI / 180, `yaw ${sidePose.yawRad}`);
});

Deno.test("decodeVrcOriginPose prefers v2 over v1 and accepts the v2 OSC prefix", () => {
  const [xPos, xNeg] = encodeOverlappingProximityAxis(1);
  const coords = {
    ...encodePetPlayOriginV2Pose([5, 6, 7], 0),
    [PETPLAY_ORIGIN_PARAMS.posXPos]: xPos,
    [PETPLAY_ORIGIN_PARAMS.posXNeg]: xNeg,
  };
  assertEquals(decodeVrcOriginPose(coords)?.source, "petplay-origin-v2");
  assert(isVrcOriginOscAddress(PETPLAY_ORIGIN_V2_PARAMS.posX));
});

Deno.test("two-scale v2 rig: fine inside 768 m, coarse beyond, nothing past 8192 m", () => {
  const near = decodePetPlayOriginV2Pose(encodePetPlayOriginV2RigPose([300.25, 2, -500.5], 1));
  assert(near);
  assertEquals(near.position, [300.25, 2, -500.5]);
  const far = encodePetPlayOriginV2RigPose([3000, 10, -2000], -2);
  assertEquals(far[PETPLAY_ORIGIN_V2_PARAMS.pos], 0);
  assertEquals(far[PETPLAY_ORIGIN_V2_COARSE_PARAMS.pos], 1);
  const farPose = decodePetPlayOriginV2Pose(far);
  assert(farPose);
  assertEquals(farPose.position, [3000, 10, -2000]);
  assertAlmostEquals(farPose.yawRad, -2, 1e-4);
  assertEquals(decodePetPlayOriginV2Pose(encodePetPlayOriginV2RigPose([9000, 0, 0], 0)), null);
});

Deno.test("decodePetPlayOriginV2Pose prefers local 1 m HeadFwd compass yaw when present", () => {
  const yaw = -1.234;
  const coords = {
    ...encodePetPlayOriginV2Pose([10, 0.5, -20], 0.5),
    "/avatar/parameters/PetPlay/OriginV2/HeadFwd": 1,
    "/avatar/parameters/PetPlay/OriginV2/HeadFwd_SenderLocalPositionX": Math.sin(yaw),
    "/avatar/parameters/PetPlay/OriginV2/HeadFwd_SenderLocalPositionY": 0,
    "/avatar/parameters/PetPlay/OriginV2/HeadFwd_SenderLocalPositionZ": Math.cos(yaw),
  };
  const pose = decodePetPlayOriginV2Pose(coords);
  assert(pose);
  assertAlmostEquals(pose.yawRad, yaw, 1e-5);
});

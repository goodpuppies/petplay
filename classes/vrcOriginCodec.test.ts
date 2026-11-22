import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  CUSTOM_OBJECT_SYNC_PARAMS,
  decodeLegacyCustomObjectSyncPose,
  decodeOverlappingProximityAxis,
  decodePetPlayOriginPose,
  decodePhysBoneYawRad,
  decodeVrcOriginPose,
  encodeOverlappingProximityAxis,
  encodePhysBoneYawRad,
  isOverlappingProximityConsistent,
  isVrcOriginOscAddress,
  PETPLAY_ORIGIN_PARAMS,
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

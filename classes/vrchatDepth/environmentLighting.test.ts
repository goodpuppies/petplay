import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1.0.0";
import { LIGHTING } from "./format.ts";
import { applyWorldToTracking } from "./sync.ts";
import {
  applyMat3,
  environmentFromRecord,
  environmentLighting,
  setEnvironmentLighting,
  shade4PointLights,
  shadeSH9,
  STALE_MS,
  trackingToUnityPoint,
} from "./environmentLighting.ts";

function record(): number[] {
  const r = new Array(LIGHTING.length).fill(0);
  // L0 0.3/0.2/0.1, red L1 along Unity +x, green along +z; a sun from above and -z.
  r[LIGHTING.sh + 3] = 0.3;
  r[LIGHTING.sh + 7] = 0.2;
  r[LIGHTING.sh + 11] = 0.1;
  r[LIGHTING.sh + 0] = 0.25;
  r[LIGHTING.sh + 4 + 2] = 0.15;
  r.splice(LIGHTING.mainLightPosition, 4, 0, 0.8, -0.6, 0);
  r.splice(LIGHTING.mainLightColor, 4, 1.2, 1.1, 1, 1);
  return r;
}

Deno.test("tracking normals map back to the Unity world direction under any yaw", () => {
  for (const yawRad of [0, 0.7, -2.4, Math.PI]) {
    const env = environmentFromRecord(record(), { yawRad, scale: 1, translation: [0, 0, 0] })!;
    for (const unity of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.48, -0.6, 0.64]]) {
      // Unity → right-handed world (z negated) → tracking, as `sync.ts` maps poses.
      const tracking = applyWorldToTracking(
        { yawRad, scale: 1.7, translation: [0, 0, 0] },
        { position: [unity[0], unity[1], -unity[2]], quaternion: [0, 0, 0, 1] },
      ).position.map((v) => v / 1.7);
      const back = applyMat3(env.trackingToUnity, tracking);
      for (let i = 0; i < 3; i++) assertAlmostEquals(back[i], unity[i], 1e-9);
    }
  }
});

Deno.test("ShadeSH9 adds L1 along the Unity axis it was given", () => {
  const env = environmentFromRecord(record(), { yawRad: 0, scale: 1, translation: [0, 0, 0] })!;
  const [r, g, b] = shadeSH9(env, [1, 0, 0]);
  assertAlmostEquals(r, 0.55, 1e-9);
  assertAlmostEquals(g, 0.2, 1e-9);
  assertAlmostEquals(b, 0.1, 1e-9);
  assertAlmostEquals(shadeSH9(env, [0, 0, 1])[1], 0.35, 1e-9);
  assertAlmostEquals(shadeSH9(env, [-1, 0, 0])[0], 0.05, 1e-9);
});

Deno.test("main light: normalized direction, none when black or positional", () => {
  const env = environmentFromRecord(record(), { yawRad: 0, scale: 1, translation: [0, 0, 0] })!;
  assertEquals(env.mainDirection, [0, 0.8, -0.6]);
  assertEquals(env.mainColor, [1.2, 1.1, 1]);
  const dark = record();
  dark.splice(LIGHTING.mainLightColor, 3, 0, 0, 0);
  assertEquals(environmentFromRecord(dark, { yawRad: 0, scale: 1, translation: [0, 0, 0] })!.mainDirection, null);
  const point = record();
  point[LIGHTING.mainLightPosition + 3] = 1;
  assertEquals(environmentFromRecord(point, { yawRad: 0, scale: 1, translation: [0, 0, 0] })!.mainColor, [0, 0, 0]);
});

Deno.test("stale lighting is dropped", () => {
  setEnvironmentLighting(environmentFromRecord(record(), { yawRad: 0, scale: 1, translation: [0, 0, 0] }, 1000));
  assertEquals(environmentLighting(1000 + STALE_MS) != null, true);
  assertEquals(environmentLighting(1001 + STALE_MS), null);
  setEnvironmentLighting(null);
});

Deno.test("tracking positions map back to Unity world through scale, yaw and translation", () => {
  const alignment = { yawRad: 1.1, scale: 0.8, translation: [2, -0.5, 3] as [number, number, number] };
  const env = environmentFromRecord(record(), alignment)!;
  for (const unity of [[0, 0, 0], [1.5, 2, -4]]) {
    const tracking = applyWorldToTracking(alignment, {
      position: [unity[0], unity[1], -unity[2]],
      quaternion: [0, 0, 0, 1],
    }).position;
    const back = trackingToUnityPoint(env, tracking);
    for (let i = 0; i < 3; i++) assertAlmostEquals(back[i], unity[i], 1e-9);
  }
});

Deno.test("Shade4PointLights: a light 2 m above a floor facing up", () => {
  const r = record();
  r[LIGHTING.vertexLightPositionY] = 2; // light 0 at (0, 2, 0)
  r[LIGHTING.vertexLightAttenuation] = 0.25;
  r.splice(LIGHTING.vertexLightColor, 3, 1, 0.5, 0.25);
  const env = environmentFromRecord(r, { yawRad: 0, scale: 1, translation: [0, 0, 0] })!;
  // 1 / (1 + 4 · 0.25) = 0.5; lights 1..3 are black.
  const lit = shade4PointLights(env, [0, 0, 0], [0, 1, 0]);
  for (const [i, want] of [0.5, 0.25, 0.125].entries()) assertAlmostEquals(lit[i], want, 1e-9);
  assertEquals(shade4PointLights(env, [0, 0, 0], [0, -1, 0]), [0, 0, 0]);
});

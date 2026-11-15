import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1.0.0";
import { LIGHTING } from "./format.ts";
import { evaluateShL1, lightingDebugLine, parseLighting } from "./lighting.ts";

function record(): number[] {
  const r = new Array(LIGHTING.length).fill(0);
  // Red: L1 pointing +z in Unity (towards the viewer's forward), L0 0.5.
  r.splice(LIGHTING.sh, 4, 0, 0, 0.25, 0.5);
  r.splice(LIGHTING.sh + 4, 4, 0, 0.1, 0, 0.4);
  r.splice(LIGHTING.sh + 8, 4, 0, 0, 0, 0.3);
  r.splice(LIGHTING.mainLightPosition, 4, 0, 1, 1, 0);
  r.splice(LIGHTING.mainLightColor, 4, 1, 0.9, 0.8, 0);
  r.splice(LIGHTING.vertexLightColor + 8, 4, 0.2, 0.2, 0.2, 0); // slot 2 only
  r[LIGHTING.vertexLightPositionX + 2] = 3;
  r[LIGHTING.vertexLightPositionZ + 2] = 4;
  r.splice(LIGHTING.lightVolumes, 8, 1, 3, 5, 1, 1, 0, 12, 0.01);
  r.splice(LIGHTING.samplePosition, 3, 1, 2, 3);
  return r;
}

Deno.test("lighting record parses into the right-handed world", () => {
  const l = parseLighting(record())!;
  assertEquals(l.sh.l0, [0.5, 0.4, 0.3]);
  assertEquals(l.sh.l1[0], [0, 0, -0.25]); // Unity +z is right-handed -z
  assertEquals(l.mainLight.direction, [0, 1, -1]);
  assertEquals(l.mainLight.position, null);
  assertEquals(l.vertexLights.length, 1);
  assertEquals(l.vertexLights[0].position, [3, 0, -4]);
  assertEquals(l.lightVolumes.enabled, true);
  assertEquals(l.lightVolumes.count, 5);
  assertEquals(l.lightVolumes.pointLightCount, 12);
  assertEquals(l.samplePosition, [1, 2, -3]);
  // Facing right-handed -z (Unity +z) picks up the red L1 term.
  assertAlmostEquals(evaluateShL1(l, [0, 0, -1])[0], 0.75, 1e-9);
  assertAlmostEquals(evaluateShL1(l, [0, 1, 0])[1], 0.5, 1e-9);
  assertEquals(lightingDebugLine(l).includes("LV v3 5 vol 12 lights"), true);
});

Deno.test("a short or missing record gives no lighting", () => {
  assertEquals(parseLighting(undefined), null);
  assertEquals(parseLighting([1, 2, 3]), null);
  assertEquals(lightingDebugLine(null).startsWith("lighting: none"), true);
});

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { angleBetweenDeg, AUTO_HIDE_FADE_S, nextAutoHidden, stepAutoHideFade } from "./autoHide.ts";

Deno.test("angle between directions ignores their length", () => {
  assertAlmostEquals(angleBetweenDeg({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -3 }), 0, 1e-9);
  assertAlmostEquals(angleBetweenDeg({ x: 0, y: 0, z: -1 }, { x: 2, y: 0, z: 0 }), 90, 1e-9);
  assertAlmostEquals(angleBetweenDeg({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }), 180, 1e-9);
  assertEquals(angleBetweenDeg({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 0);
});

Deno.test("hides past 60 degrees and only comes back under 55", () => {
  assert(!nextAutoHidden(false, 59), "still facing it");
  assert(nextAutoHidden(false, 60), "turned away");
  assert(nextAutoHidden(true, 57), "held near the edge stays hidden");
  assert(!nextAutoHidden(true, 54), "facing it again");
});

Deno.test("fades over the fade time and stays in range", () => {
  const half = AUTO_HIDE_FADE_S / 2;
  assertAlmostEquals(stepAutoHideFade(1, true, half), 0.5, 1e-9);
  assertEquals(stepAutoHideFade(0.5, true, AUTO_HIDE_FADE_S), 0);
  assertAlmostEquals(stepAutoHideFade(0, false, half), 0.5, 1e-9);
  assertEquals(stepAutoHideFade(0.9, false, 1), 1);
});

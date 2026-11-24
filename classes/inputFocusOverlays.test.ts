import { assertAlmostEquals, assertEquals } from "@std/assert";
import { focusOverlayRows } from "./inputFocusOverlays.ts";

Deno.test("focus overlay faces the controller and sits at the hit", () => {
  const out = new Float32Array(12);
  assertEquals(focusOverlayRows({ point: [0, 1, -2], origin: [0, 1, 0] }, out), true);
  // Columns: x, y, z axes, then translation (row-major 3×4).
  const expected = [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, -2];
  expected.forEach((v, i) => assertAlmostEquals(out[i], v, 1e-6));
  // Straight down still gives an orthonormal frame.
  assertEquals(focusOverlayRows({ point: [0, 0, 0], origin: [0, 2, 0] }, out), true);
  assertAlmostEquals(out[6], 1, 1e-6); // z axis points up at the controller
  assertEquals(focusOverlayRows({ point: [1, 1, 1], origin: [1, 1, 1] }, out), false);
});

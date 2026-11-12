import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  columnMajorFromRows,
  invertRigid,
  multiply,
  playspaceFrame,
  rowsFromColumnMajor,
} from "./playspaceFrame.ts";
import { transformCornersXz, writeRows } from "./playspaceMover.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

/** A yaw of `yaw` radians plus a translation, column-major. */
function pose(yaw: number, x: number, y: number, z: number): Float32Array {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}

function assertMatrixClose(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  assertEquals(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assertAlmostEquals(actual[i], expected[i], 1e-5);
}

function point(m: ArrayLike<number>, p: [number, number, number]): number[] {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

const z0 = pose(0.7, 1.5, 0.2, -2);

Deno.test("an inactive frame reads and writes Standing untouched", () => {
  playspaceFrame.setAnchor(null);
  assertEquals(playspaceFrame.universe, OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding);
  const rows = rowsFromColumnMajor(pose(0.3, 1, 2, 3));
  const before = rows.map((r) => [...r]);
  playspaceFrame.poseRowsFromRaw(rows);
  playspaceFrame.poseRowsToUniverse(rows);
  assertEquals(rows, before);
});

Deno.test("raw poses round-trip through the anchored frame", () => {
  playspaceFrame.setAnchor(z0);
  assertEquals(
    playspaceFrame.universe,
    OpenVR.TrackingUniverseOrigin.TrackingUniverseRawAndUncalibrated,
  );
  const raw = pose(-1.1, 0.4, 1.6, 0.9);
  const rows = rowsFromColumnMajor(raw);
  playspaceFrame.poseRowsFromRaw(rows);
  // Before any drag the PetPlay frame is Standing: Z0⁻¹ · raw.
  assertMatrixClose(columnMajorFromRows(rows), multiply(invertRigid(z0), raw));
  playspaceFrame.poseRowsToUniverse(rows);
  assertMatrixClose(columnMajorFromRows(rows), raw);
  playspaceFrame.setAnchor(null);
});

Deno.test("a projection view in the PetPlay frame becomes a raw-universe view", () => {
  playspaceFrame.setAnchor(z0);
  const eyeInPetplay = pose(0.4, 0.1, 1.7, 0.3);
  const view = invertRigid(eyeInPetplay);
  const rows = writeRows(view, new Float32Array(12));
  playspaceFrame.viewRows34ToUniverse(rows);
  const rawPoint: [number, number, number] = [0.3, 1.2, -0.8];
  const petplayPoint = point(playspaceFrame.rawToPetplay, rawPoint) as [number, number, number];
  const expected = point(view, petplayPoint);
  const actual = [0, 1, 2].map((r) =>
    rows[r * 4] * rawPoint[0] + rows[r * 4 + 1] * rawPoint[1] + rows[r * 4 + 2] * rawPoint[2] +
    rows[r * 4 + 3]
  );
  assertMatrixClose(actual, expected);
  playspaceFrame.setAnchor(null);
});

Deno.test("a Standing pose follows the playspace into the PetPlay frame", () => {
  playspaceFrame.setAnchor(z0);
  let notified = 0;
  const off = playspaceFrame.onStandingChange(() => notified++);
  const dragged = new Float32Array(z0);
  dragged[12] += 0.5;
  dragged[14] -= 0.25;
  playspaceFrame.setStandingZeroPose(dragged);
  assertEquals(notified, 1);
  const origin = rowsFromColumnMajor(pose(0, 2, 0, 1));
  playspaceFrame.poseRowsFromStanding(origin);
  // The world moved with the playspace: its raw place is now Z · P, seen from PetPlay as Z0⁻¹ · Z · P.
  assertMatrixClose(
    columnMajorFromRows(origin),
    multiply(invertRigid(z0), multiply(dragged, pose(0, 2, 0, 1))),
  );
  off();
  playspaceFrame.setAnchor(null);
});

Deno.test("counter-moved bounds keep each guardian corner where it physically was", () => {
  const start = z0;
  const moved = new Float32Array(start);
  moved[12] += 1.25;
  moved[13] -= 0.4;
  moved[14] += 0.5;
  const corners = new Float32Array([1, 0, 1, 1, 2.4, 1, -1, 0, 2, -1, 2.4, 2]);
  const out = transformCornersXz(
    multiply(invertRigid(moved), start),
    corners,
    new Float32Array(corners.length),
  );
  for (let i = 0; i < corners.length; i += 3) {
    const before = point(start, [corners[i], corners[i + 1], corners[i + 2]]);
    const after = point(moved, [out[i], out[i + 1], out[i + 2]]);
    assertAlmostEquals(after[0], before[0], 1e-5);
    assertAlmostEquals(after[2], before[2], 1e-5);
    // Heights stay floor/ceiling relative, as WayVR keeps them.
    assertEquals(out[i + 1], corners[i + 1]);
  }
});

import { assertEquals } from "@std/assert";
import { BlockCalibration } from "./blockCalibration.ts";

/** Feeds one tick a second with per-second increments. */
function run(c: BlockCalibration, from: number, seconds: number, good: number, bad: number, totals: { d: number; f: number }) {
  const changes: [number, string][] = [];
  for (let s = 0; s < seconds; s++) {
    totals.d += good;
    totals.f += bad;
    const at = from + s * 1000;
    const mode = c.observe(at, totals.d, { "bad-checksum": totals.f, "not-found": 1e6 });
    if (mode) changes.push([at, mode]);
  }
  return changes;
}

Deno.test("a clean world stays in 1D", () => {
  const c = new BlockCalibration();
  const totals = { d: 0, f: 0 };
  assertEquals(run(c, 0, 60, 40, 0, totals), []);
  assertEquals(c.mode, "1d");
});

Deno.test("a world that corrupts the block switches to 3D, then waits for the avatar", () => {
  const c = new BlockCalibration();
  const totals = { d: 0, f: 0 };
  const changes = run(c, 0, 30, 0, 3, totals);
  assertEquals(changes.length, 1);
  assertEquals(changes[0][1], "3d");
  // Still corrupt while the avatar applies it: no flapping back.
  assertEquals(run(c, 30_000, 30, 0, 3, totals), []);
  assertEquals(c.mode, "3d");
});

Deno.test("a mostly clean 1D stream with occasional errors does not switch", () => {
  const c = new BlockCalibration();
  const totals = { d: 0, f: 0 };
  assertEquals(run(c, 0, 60, 30, 2, totals), []);
});

Deno.test("a new world goes back to 1D; a fixed policy holds", () => {
  const c = new BlockCalibration();
  const totals = { d: 0, f: 0 };
  run(c, 0, 30, 0, 3, totals);
  assertEquals(c.worldChanged(40_000), "1d");
  assertEquals(c.setPolicy("3d", 41_000), "3d");
  assertEquals(c.worldChanged(50_000), null);
  assertEquals(run(c, 60_000, 30, 40, 0, totals), []);
  assertEquals(c.mode, "3d");
});

Deno.test("a decoder handover that resets the failure counters is not read as a change", () => {
  const c = new BlockCalibration();
  for (let s = 0; s < 30; s++) c.observe(s * 1000, s * 40, { "bad-checksum": 100 + s });
  // The debug view takes over: `decoded` keeps counting, failures restart from zero.
  for (let s = 0; s < 10; s++) {
    assertEquals(c.observe(30_000 + s * 1000, 1200 + s * 40, { "bad-checksum": s % 2 }), null);
    const recent = c.status(30_000 + s * 1000).recent;
    assertEquals(recent.corrupt >= 0 && recent.decoded >= 0, true);
  }
  assertEquals(c.mode, "1d");
});

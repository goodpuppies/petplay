import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { vsyncLockedScheduler } from "./webxrPolyfills.ts";

const PERIOD = 10;

function fakeVsync(time: FakeTime, jitterMs = () => 0) {
  return {
    sample: () => {
      const t = time.now + jitterMs();
      return {
        msSinceVsync: ((t % PERIOD) + PERIOD) % PERIOD,
        frameIndex: BigInt(Math.floor(t / PERIOD)),
      };
    },
    periodMs: PERIOD,
    phaseMs: 4,
  };
}

Deno.test("frames start at the vsync phase, one per vsync, without drift", () => {
  using time = new FakeTime(1000);
  const schedule = vsyncLockedScheduler(fakeVsync(time), 16);
  const starts: number[] = [];
  const frame = () => {
    starts.push(time.now);
    time.tick(3); // frame work before it requests the next one
    schedule(frame);
  };
  schedule(frame);
  time.tick(100);
  assertEquals(starts.slice(0, 4), [1004, 1014, 1024, 1034]);
});

Deno.test("a late frame skips to the next free vsync instead of running twice", () => {
  using time = new FakeTime(1000);
  const schedule = vsyncLockedScheduler(fakeVsync(time), 16);
  const starts: number[] = [];
  let n = 0;
  const frame = () => {
    starts.push(time.now);
    time.tick(n++ === 1 ? 12 : 1);
    schedule(frame);
  };
  schedule(frame);
  time.tick(60);
  assertEquals(starts.slice(0, 4), [1004, 1014, 1034, 1044]);
});

Deno.test("vsync estimate jitter cannot give one vsync two frames", () => {
  using time = new FakeTime(1000);
  // The estimate runs 0.5 ms behind when sampled right after a frame starts.
  let behind = false;
  const schedule = vsyncLockedScheduler(fakeVsync(time, () => (behind ? -0.5 : 0)), 16);
  const starts: number[] = [];
  const frame = () => {
    starts.push(time.now);
    behind = true;
    schedule(frame);
    behind = false;
  };
  schedule(frame);
  time.tick(40);
  assertEquals(starts.slice(0, 3), [1004, 1014, 1024]);
});

Deno.test("callbacks requested before a frame share it", () => {
  using time = new FakeTime(1000);
  const schedule = vsyncLockedScheduler(fakeVsync(time), 16);
  const ran: [string, number][] = [];
  schedule(() => ran.push(["a", time.now]));
  time.tick(1);
  schedule(() => ran.push(["b", time.now]));
  time.tick(10);
  assertEquals(ran, [["a", 1004], ["b", 1004]]);
});

Deno.test("vsync frameIndex reset after standby does not freeze rAF", () => {
  using time = new FakeTime(1000);
  let frameIndex = 50_000n;
  let msSinceVsync = 2;
  const schedule = vsyncLockedScheduler(
    {
      periodMs: 10,
      phaseMs: 4,
      sample: () => ({ frameIndex, msSinceVsync }),
    },
    16,
  );
  const starts: number[] = [];
  schedule(() => {
    starts.push(time.now);
    // Simulate Steam Link standby reset: frameIndex drops back to 1n and msSinceVsync goes negative.
    frameIndex = 1n;
    msSinceVsync = -500;
    schedule(() => {
      starts.push(time.now);
    });
  });
  time.tick(30);
  assertEquals(starts.length, 2);
});

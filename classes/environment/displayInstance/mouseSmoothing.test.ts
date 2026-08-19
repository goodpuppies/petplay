import { createSmoothedDisplayMouseSink, type DisplayMouseLogicEvent } from "./mouse.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, received ${a}`);
}

function assertLess(actual: number, expected: number): void {
  if (!(actual < expected)) throw new Error(`Expected ${actual} < ${expected}`);
}

Deno.test("display mouse smoothing suppresses small alternating jitter", () => {
  const events: DisplayMouseLogicEvent[] = [];
  const sink = createSmoothedDisplayMouseSink((event) => events.push(event));
  sink({ kind: "move", x: 0.5, y: 0.5 });
  sink({ kind: "move", x: 0.5005, y: 0.5 });
  sink({ kind: "move", x: 0.4995, y: 0.5 });
  assertEquals(events, [{ kind: "move", x: 0.5, y: 0.5 }]);
});

Deno.test("display mouse smoothing damps motion and snaps large jumps", () => {
  const events: DisplayMouseLogicEvent[] = [];
  let now = 0;
  const sink = createSmoothedDisplayMouseSink((event) => events.push(event), {
    now: () => now,
  });
  sink({ kind: "move", x: 0.1, y: 0.1 });
  now = 10;
  sink({ kind: "move", x: 0.12, y: 0.1 });
  assertLess((events.at(-1) as { x: number }).x, 0.12);
  now = 20;
  sink({ kind: "move", x: 0.8, y: 0.7 });
  assertEquals(events.at(-1), { kind: "move", x: 0.8, y: 0.7 });
});

Deno.test("display mouse smoothing limits move output to WayVR's 100 Hz cadence", () => {
  const events: DisplayMouseLogicEvent[] = [];
  let now = 0;
  const sink = createSmoothedDisplayMouseSink((event) => events.push(event), {
    deadZone: 0,
    minimumOutputDistance: 0,
    now: () => now,
  });
  sink({ kind: "move", x: 0.1, y: 0.1 });
  now = 5;
  sink({ kind: "move", x: 0.2, y: 0.1 });
  assertEquals(events.length, 1);
  now = 10;
  sink({ kind: "move", x: 0.3, y: 0.1 });
  assertEquals(events.length, 2);
});

Deno.test("display mouse buttons retain exact raw coordinates", () => {
  const events: DisplayMouseLogicEvent[] = [];
  const sink = createSmoothedDisplayMouseSink((event) => events.push(event));
  sink({ kind: "move", x: 0.2, y: 0.2 });
  sink({ kind: "move", x: 0.22, y: 0.2 });
  sink({ kind: "button", button: "left", pressed: true, x: 0.22, y: 0.2 });
  assertEquals(events.at(-1), {
    kind: "button",
    button: "left",
    pressed: true,
    x: 0.22,
    y: 0.2,
  });
});

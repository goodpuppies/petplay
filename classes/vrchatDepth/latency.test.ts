import { assertEquals } from "@std/assert";
import { type DepthFrameTiming, DepthLatencyTracker } from "./latency.ts";

const pose = {
  position: [1, 2, 3] as [number, number, number],
  rotationDeg: [0, 179.99, 0] as [number, number, number],
};
function frame(partial: Partial<DepthFrameTiming> = {}): DepthFrameTiming {
  return {
    revision: 1,
    pose,
    capturedAt: 110,
    decodedAt: 115,
    deliveredAt: 117,
    preparedAt: 120,
    ...partial,
  };
}

Deno.test("latency tracks command, decode, delivery, preparation and swap separately", () => {
  const tracker = new DepthLatencyTracker();
  const sequence = tracker.command(pose, 100);
  tracker.acknowledge(sequence, 102);
  tracker.observe(frame());
  assertEquals(tracker.report().samples.length, 0);
  tracker.swapped(1, 128);
  assertEquals(tracker.report().samples[0], {
    sequence,
    commandToCaptureMs: 10,
    commandToSourceMs: null,
    sourceToArrivalMs: null,
    captureToDecodeMs: 5,
    decodeToDeliveryMs: 2,
    prepareMs: 3,
    prepareToSwapMs: 8,
    commandAckMs: 2,
    totalMs: 28,
  });
  tracker.swapped(1, 140);
  assertEquals(tracker.report().samples.length, 1);
});

Deno.test("pose matching handles wrapped Euler angles and rejects pre-command captures", () => {
  const tracker = new DepthLatencyTracker();
  tracker.command(pose, 100);
  tracker.observe(frame({ capturedAt: 99 }));
  tracker.swapped(1, 120);
  assertEquals(tracker.report().samples.length, 0);
  tracker.observe(frame({ revision: 2, pose: { ...pose, rotationDeg: [0, -180.01, 0] } }));
  tracker.swapped(2, 130);
  assertEquals(tracker.report().samples.length, 1);
});

Deno.test("unmatched and skipped frames do not become fabricated latency samples", () => {
  const tracker = new DepthLatencyTracker();
  tracker.command(pose, 100);
  tracker.observe(frame({ pose: { ...pose, position: [10, 2, 3] } }));
  tracker.swapped(1, 130);
  tracker.observe(frame({ revision: 2 }));
  tracker.swapped(3, 140); // the matched frame was superseded before being drawn
  assertEquals(tracker.report().samples.length, 0);
  tracker.command(pose, 2201);
  assertEquals(tracker.report().expired, 1);
  assertEquals(tracker.report().pending, 1);
});

Deno.test("legacy frames report missing decode stamps as unknown, not zero", () => {
  const tracker = new DepthLatencyTracker();
  tracker.command(pose, 100);
  tracker.observe(frame({ decodedAt: undefined }));
  tracker.swapped(1, 130);
  assertEquals(tracker.report().samples[0].captureToDecodeMs, null);
  assertEquals(tracker.report().summary.captureToDecodeMs.count, 0);
});

Deno.test("source PTS separates command-to-source from capture and pipe delay", () => {
  const tracker = new DepthLatencyTracker();
  tracker.command(pose, 100);
  tracker.observe(frame({ sourceCapturedAt: 105 }));
  tracker.swapped(1, 130);
  assertEquals(tracker.report().samples[0].commandToSourceMs, 5);
  assertEquals(tracker.report().samples[0].sourceToArrivalMs, 5);
});

Deno.test("a matching replacement can be measured after an earlier match was never drawn", () => {
  const tracker = new DepthLatencyTracker();
  tracker.command(pose, 100);
  tracker.observe(frame());
  tracker.observe(
    frame({ revision: 2, capturedAt: 120, decodedAt: 125, deliveredAt: 126, preparedAt: 127 }),
  );
  tracker.swapped(2, 130);
  assertEquals(tracker.report().samples.length, 1);
  assertEquals(tracker.report().samples[0].totalMs, 30);
  assertEquals(tracker.report().samples[0].commandToCaptureMs, 20);
});

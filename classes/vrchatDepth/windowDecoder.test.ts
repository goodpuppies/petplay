import { assert, assertEquals } from "@std/assert";
import { type DepthFrameHeader, deriveLayout, drawCells, encodeCells } from "./format.ts";
import { depthFrameToWire, WindowDepthDecoder } from "./windowDecoder.ts";
import { debugFrameFromRaw } from "./debugView.ts";

Deno.test("full foreground preserves thin geometry without expanding the mesh or VR wire frame", () => {
  const layout = deriveLayout({ bits: [8, 8, 8], gridWidth: 96, depthWidth: 32, depthHeight: 32 });
  const header: DepthFrameHeader = {
    timeTag: 1,
    eye: 0,
    flags: 0,
    near: 0.01,
    far: 1000,
    screenWidth: 256,
    screenHeight: 160,
    depthRef: 0.05,
    viewToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    anchorToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    projection: { m00: 1, m11: 1, m02: 0, m12: 0 },
  };
  const depth = new Float32Array(32 * 32).fill(5);
  for (let y = 0; y < 32; y++) depth[y * 32 + 15] = 1;
  const data = new Uint8Array(256 * 160 * 4);
  drawCells(
    { width: 256, height: 160, data, channels: 4 },
    layout,
    encodeCells(layout, header, depth),
    8,
    8,
    1,
  );
  const window = { width: 256, height: 160, data, receivedAt: 100 };
  const frame = new WindowDepthDecoder(8, 512).decode(window)!;
  assert(frame);
  assertEquals([frame.width, frame.height, frame.depth.length], [8, 8, 64]);
  assert(frame.depth.every((d) => d > 4.9));
  assertEquals([frame.foreground!.width, frame.foreground!.height], [32, 32]);
  assert(frame.foreground!.depth[15] < 1.01);
  assertEquals(debugFrameFromRaw(frame, 1).mesh.positions.length, 64 * 3);
  const wire = depthFrameToWire(frame, 1);
  assertEquals([wire.width, wire.height], [8, 8]);
  assertEquals("foreground" in wire, false);
  assertEquals(new WindowDepthDecoder(8).decode(window)!.foreground, undefined);
});

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { debugFrameFromRaw, debugFrameFromSource, VrcDepthDebugView } from "./debugView.ts";
import { encodeBytesBase64, encodeFloat32Base64, type VrcDepthFramePayload } from "./wire.ts";

function source(): VrcDepthFramePayload {
  return {
    receivedAt: 100,
    decodeMs: 2,
    width: 2,
    height: 2,
    worldScale: 0.8,
    depthBase64: encodeFloat32Base64(new Float32Array([2, 2, 2, 2])),
    colorBase64: encodeBytesBase64(
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]),
    ),
    header: {
      timeTag: 1,
      eye: 0,
      flags: 16,
      near: 0.01,
      far: 1000,
      screenWidth: 1920,
      screenHeight: 1000,
      depthRef: 0.05,
      viewToWorld: [1, 0, 0, 4, 0, 1, 0, 1, 0, 0, -1, 3],
      anchorToWorld: [1, 0, 0, 5, 0, 1, 0, 1.6, 0, 0, 1, 4],
      projection: { m00: 1, m11: 1, m02: 0, m12: 0 },
    },
  };
}

Deno.test("direct debug frame places points and player in VRChat world without HMD alignment", () => {
  const frame = debugFrameFromSource(source(), 7);
  assertEquals(frame.mesh.revision, 7);
  assertEquals(Array.from(frame.mesh.positions.slice(0, 3)), [3, 2, -5]);
  assertEquals(Array.from(frame.mesh.colors!.slice(0, 3)), [1, 0, 0]);
  assertEquals(Number.isNaN(frame.mesh.colors![3]), true);
  const view = new VrcDepthDebugView();
  view.update(frame, 1.92);
  assertEquals(view.camera.position.toArray(), [4, 1, -3]);
  assertEquals(view.head.position.toArray(), [5, 1.6, -4]);
  // Repeated stationary draws use exactly the same camera, with no commanded/captured handoff.
  const before = view.camera.matrixWorld.elements.slice();
  view.update(frame, 1.92);
  assertEquals(view.camera.matrixWorld.elements, before);
  const next = source();
  next.header.viewToWorld = [1, 0, 0, 4.2, 0, 1, 0, 1, 0, 0, -1, 3];
  view.update(debugFrameFromSource(next, 8), 1.92);
  assertAlmostEquals(view.camera.position.x, 4.2);
  view.dispose();
});

Deno.test("foreground-only frames keep full depth while omitting hidden world geometry", () => {
  const s = source();
  const raw = {
    receivedAt: s.receivedAt,
    decodeMs: 1,
    header: s.header,
    width: 2,
    height: 2,
    depth: new Float32Array([2, 2, 2, 2]),
    colors: new Uint8Array(16).fill(255),
    foreground: { width: 8, height: 8, depth: new Float32Array(64).fill(2) },
  };
  const hidden = debugFrameFromRaw(raw, 1, false);
  assertEquals(hidden.mesh.positions.length, 0);
  assertEquals(hidden.mesh.colors, null);
  assertEquals(hidden.mesh.depth, raw.depth);
  assertEquals(hidden.foreground, raw.foreground);
  const visible = debugFrameFromRaw(raw, 2, true);
  assertEquals(visible.mesh.positions.length, 12);
  assertEquals(visible.mesh.colors!.length, 12);
});

import { assertEquals } from "@std/assert";
import { DEPTH_LOG16, encodeBytesBase64, encodeDepthLog16, payloadDepth } from "./wire.ts";

Deno.test("log16 depth survives the wire within 0.011 % and keeps 'none' as 0", () => {
  const depth = new Float32Array([0, -1, NaN, DEPTH_LOG16.near, 0.05, 0.731, 2, 13.37, 999, 1e6]);
  const codes = encodeDepthLog16(depth);
  const back = payloadDepth({ depthLog16Base64: encodeBytesBase64(new Uint8Array(codes.buffer)) });
  assertEquals([back[0], back[1], back[2]], [0, 0, 0]);
  for (let i = 3; i < 9; i++) {
    const error = Math.abs(back[i] - depth[i]) / depth[i];
    if (!(error < 1.1e-4)) throw new Error(`${depth[i]} → ${back[i]} (${error})`);
  }
  // Beyond `far` it clamps rather than wrapping.
  assertEquals(Math.round(back[9]), DEPTH_LOG16.far);
});

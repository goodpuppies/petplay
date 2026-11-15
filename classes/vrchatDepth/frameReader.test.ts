import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { readFrameBytes } from "./frameReader.ts";

function bytes(chunks: number[][]) {
  const source: UnderlyingByteSource = {
    type: "bytes",
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(new Uint8Array(chunk));
      else {
        controller.close();
        controller.byobRequest?.respond(0);
      }
    },
  };
  return new ReadableStream(source);
}

Deno.test("BYOB frame reader preserves partial prefixes and separates coalesced frames", async () => {
  const frames: number[][] = [];
  await readFrameBytes(
    bytes([[1], [2, 3, 4, 5, 6], [7, 8]]),
    4,
    (frame) => frames.push([...frame]),
  );
  assertEquals(frames, [[1, 2, 3, 4], [5, 6, 7, 8]]);
});

Deno.test("BYOB frame reader never emits an incomplete trailing frame", async () => {
  const frames: number[][] = [];
  await readFrameBytes(bytes([[1, 2], [3, 4, 5]]), 4, (frame) => frames.push([...frame]));
  assertEquals(frames, [[1, 2, 3, 4]]);
});

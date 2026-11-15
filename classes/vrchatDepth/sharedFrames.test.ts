import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { SharedDepthFrames } from "./sharedFrames.ts";
import type { RawDepthFrame } from "./windowDecoder.ts";
import type { DepthFrameHeader } from "./format.ts";

function frame(value: number): RawDepthFrame {
  return {
    receivedAt: value,
    decodeMs: 1,
    header: {} as DepthFrameHeader,
    width: 2,
    height: 1,
    depth: new Float32Array([value, value]),
    colors: new Uint8Array(8).fill(value),
  };
}

Deno.test("shared slots drop overwritten notices without destroying the newer frame", () => {
  const producer = new SharedDepthFrames(2);
  const consumer = new SharedDepthFrames(2, producer.buffer);
  const old = producer.write(frame(1), 1)!;
  producer.write(frame(2), 2);
  producer.write(frame(3), 3);
  const newest = producer.write(frame(4), 4)!;
  assertEquals(consumer.read(old), null);
  const snapshot = consumer.read(newest)!;
  assertEquals(Array.from(snapshot.depth), [4, 4]);
  assertEquals(Array.from(snapshot.colors!), new Array(8).fill(4));
  producer.write(frame(5), 5);
  producer.write(frame(6), 6);
  producer.write(frame(7), 7);
  assertEquals(Array.from(snapshot.depth), [4, 4]);
});

Deno.test("producer never overwrites slots held by a reader and storage stays bounded", () => {
  const shared = new SharedDepthFrames(2);
  // Hold every slot as an in-progress read.
  for (let i = 0; i < 3; i++) Atomics.store(shared.control, i * 2, 3);
  assertEquals(shared.write(frame(1), 1), null);
  Atomics.store(shared.control, 2, 0);
  const notice = shared.write(frame(2), 2);
  assert(notice);
  assertEquals(notice.slot, 1);
  const bytes = shared.buffer.byteLength;
  for (let i = 3; i < 1000; i++) shared.write(frame(i % 255), i);
  assertEquals(shared.buffer.byteLength, bytes);
});

Deno.test("shared frame without colour does not expose an old colour buffer", () => {
  const shared = new SharedDepthFrames(2);
  shared.write(frame(1), 1);
  const next = frame(2);
  next.colors = null;
  const notice = shared.write(next, 4)!;
  assertEquals(shared.read(notice)!.colors, null);
});

Deno.test("worker and renderer share complete meshes and larger foreground planes while frames are replaced", async () => {
  const shared = new SharedDepthFrames(1024, undefined, 4096);
  const code = `import { SharedDepthFrames } from ${
    JSON.stringify(new URL("./sharedFrames.ts", import.meta.url).href)
  };
    onmessage = event => {
      const shared = new SharedDepthFrames(1024, event.data, 4096);
      for (let sequence = 1; sequence <= 500; sequence++) {
        const notice = shared.write({ receivedAt: sequence, decodeMs: 0, header: {}, width: 32,
          height: 32, depth: new Float32Array(1024).fill(sequence),
          colors: new Uint8Array(4096).fill(sequence % 256),
          foreground: {width:64,height:64,depth:new Float32Array(4096).fill(sequence + 0.5)} }, sequence);
        if (notice) postMessage(notice);
      }
      postMessage({ done: true });
    };`;
  const worker = new Worker(`data:application/javascript,${encodeURIComponent(code)}`, {
    type: "module",
  });
  let received = 0, last = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = (event) => {
        if (event.data.done) {
          resolve();
          return;
        }
        try {
          const snapshot = shared.read(event.data);
          if (!snapshot) return;
          assert(snapshot.depth.every((value) => value === snapshot.receivedAt));
          assert(snapshot.colors!.every((value) => value === snapshot.receivedAt % 256));
          assertEquals(snapshot.foreground!.depth.length, 4096);
          assert(snapshot.foreground!.depth.every((value) => value === snapshot.receivedAt + 0.5));
          assertEquals(event.data.foreground, { width: 64, height: 64 });
          assert(snapshot.receivedAt > last);
          received++;
          last = snapshot.receivedAt;
        } catch (error) {
          reject(error);
        }
      };
      worker.postMessage(shared.buffer);
    });
    assert(received > 0);
    assertEquals(last, 500);
  } finally {
    worker.terminate();
  }
});

Deno.test("foreground snapshots are owned, optional and never leak into notices as arrays", () => {
  const shared = new SharedDepthFrames(2, undefined, 16);
  const source = {
    ...frame(1),
    foreground: { width: 4, height: 4, depth: new Float32Array(16).fill(1) },
  };
  const notice = shared.write(source, 1)!;
  assertEquals(notice.foreground, { width: 4, height: 4 });
  const snapshot = shared.read(notice)!;
  source.foreground.depth.fill(99);
  shared.write(source, 4);
  assertEquals(Array.from(snapshot.foreground!.depth), new Array(16).fill(1));
  const noForeground = shared.write(frame(2), 7)!;
  assertEquals(shared.read(noForeground)!.foreground, undefined);
});

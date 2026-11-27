import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { chunkStream, indexFile, parseChunkIndex, planDelta } from "./updateChunks.ts";

function bytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function* blocks(data: Uint8Array, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.slice(i, i + size);
}

async function chunks(data: Uint8Array, blockSize = 1 << 20) {
  const out = [];
  for await (const chunk of chunkStream(blocks(data, blockSize))) out.push(chunk);
  return out;
}

Deno.test("chunking does not depend on how the stream is split into reads", async () => {
  const data = bytes(3_000_000, 1);
  const a = await chunks(data, 1 << 20);
  const b = await chunks(data, 77_777);
  assertEquals(a, b);
  assertEquals(a.reduce((n, c) => n + c.length, 0), data.length);
  assert(a.every((c) => c.length <= 256 * 1024));
});

Deno.test("an insertion only changes the chunks around it", async () => {
  const data = bytes(4_000_000, 2);
  const edited = new Uint8Array(data.length + 10);
  edited.set(data.subarray(0, 1_500_000));
  edited.set(bytes(10, 3), 1_500_000);
  edited.set(data.subarray(1_500_000), 1_500_010);
  const before = new Set((await chunks(data)).map((c) => c.hash));
  const after = await chunks(edited);
  const changed = after.filter((c) => !before.has(c.hash));
  assert(changed.length <= 3, `${changed.length} chunks changed`);
});

Deno.test("an index round-trips and plans reuse of a local file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "bin");
    await Deno.writeFile(path, bytes(1_000_000, 4));
    const index = parseChunkIndex(JSON.parse(JSON.stringify(await indexFile(path))));
    const local = new Map(
      (await chunks(await Deno.readFile(path))).map((
        c,
      ) => [c.hash, { path, offset: c.offset, length: c.length }]),
    );
    const plan = planDelta(index, local);
    assertEquals(plan.fetchBytes, 0);
    assertEquals(plan.reusedBytes, 1_000_000);
    const none = planDelta(index, new Map());
    assertEquals(none.ranges, [{ start: 0, end: 1_000_000 }]);
    assertThrows(() => parseChunkIndex({ ...index, size: 5 }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

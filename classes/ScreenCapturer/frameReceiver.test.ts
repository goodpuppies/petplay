import { assertEquals } from "@std/assert";
import { FrameReceiver } from "./frameReceiver.ts";

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));
    if (written <= 0) throw new Error("short write");
    offset += written;
  }
}

async function sendFrame(
  conn: Deno.Conn,
  width: number,
  height: number,
  fillByte: number,
): Promise<void> {
  const totalSize = width * height * 4;
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, totalSize, true);
  view.setUint32(12, 1, true);
  await writeAll(conn, header);

  const chunkHeader = new Uint8Array(4);
  new DataView(chunkHeader.buffer).setUint32(0, totalSize, true);
  await writeAll(conn, chunkHeader);

  const payload = new Uint8Array(totalSize).fill(fillByte);
  await writeAll(conn, payload);
}

Deno.test("FrameReceiver rejects invalid/oversized headers without killing the listener", async () => {
  const receiver = await FrameReceiver.start({ reaccept: true });
  try {
    // 1. Send a corrupt/huge header that previously caused RangeError and killed the worker.
    const badConn = await Deno.connect({ hostname: "127.0.0.1", port: receiver.port });
    const badHeader = new Uint8Array(16);
    const view = new DataView(badHeader.buffer);
    view.setUint32(0, 65535, true);
    view.setUint32(4, 65535, true);
    view.setUint32(8, 0xffffffff, true);
    view.setUint32(12, 1, true);
    await writeAll(badConn, badHeader);
    badConn.close();

    // 2. A fresh helper connecting to the exact same port must still succeed and deliver frames.
    const goodConn = await Deno.connect({ hostname: "127.0.0.1", port: receiver.port });
    try {
      await sendFrame(goodConn, 4, 2, 0xab);
      const first = await receiver.nextFrame(null, 2_000);
      assertEquals(first?.width, 4);
      assertEquals(first?.height, 2);
      assertEquals(first?.data.byteLength, 32);
      assertEquals(first?.data[0], 0xab);

      // 3. Delivering additional frames recycles buffers and keeps working cleanly.
      await sendFrame(goodConn, 4, 2, 0xcd);
      const second = await receiver.nextFrame(first, 2_000);
      assertEquals(second?.width, 4);
      assertEquals(second?.height, 2);
      assertEquals(second?.data[0], 0xcd);
    } finally {
      goodConn.close();
    }
  } finally {
    receiver.dispose();
  }
});

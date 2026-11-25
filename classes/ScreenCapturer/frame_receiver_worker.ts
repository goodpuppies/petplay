// Frame receiver worker
let conn: Deno.Conn | null = null;
let listener: Deno.Listener | null = null;
let isConnected = false;

const MAX_FRAME_DIMENSION = 16_384;
const MAX_FRAME_BYTES = 128 * 1024 * 1024; // 128 MiB (e.g. 8192x4096x4)
const MAX_FRAME_CHUNKS = 65_536;
const MAX_POOL_BUFFERS = 3;

const bufferPool: ArrayBuffer[] = [];

function acquireFrameBuffer(size: number): Uint8Array<ArrayBuffer> | null {
  while (bufferPool.length > 0) {
    const recycled = bufferPool.pop()!;
    if (recycled.byteLength === size) {
      return new Uint8Array(recycled);
    }
  }
  try {
    return new Uint8Array(size);
  } catch (err) {
    console.error(`[frame_receiver_worker] Failed to allocate ${size} byte frame buffer:`, err);
    return null;
  }
}

function returnToPool(buffer: ArrayBuffer): void {
  if (buffer.byteLength <= 0 || buffer.byteLength > MAX_FRAME_BYTES) return;
  if (bufferPool.length >= MAX_POOL_BUFFERS) return;
  bufferPool.push(buffer);
}

const worker = self as unknown as Worker;

async function readExactly(size: number): Promise<Uint8Array | null> {
  if (!conn) return null;
  const buffer = new Uint8Array(size);
  let totalRead = 0;
  try {
    while (totalRead < size) {
      const bytesRead = await conn.read(buffer.subarray(totalRead));
      if (!bytesRead) {
        console.log("Connection closed while reading");
        return null;
      }
      totalRead += bytesRead;
    }
    return buffer;
  } catch (err) {
    // Check for connection reset errors and mark as disconnected
    if (
      err instanceof Error && (err.name === "ConnectionReset" || err.message.includes("ECONNRESET"))
    ) {
      isConnected = false;
      return null;
    }
    console.error("Error reading from connection:", err);
    return null;
  }
}

async function readExactlyInto(
  buffer: Uint8Array,
  offset: number,
  size: number,
): Promise<boolean> {
  if (!conn) return false;
  let totalRead = 0;
  try {
    while (totalRead < size) {
      const bytesRead = await conn.read(
        buffer.subarray(offset + totalRead, offset + size),
      );
      if (!bytesRead) return false;
      totalRead += bytesRead;
    }
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "ConnectionReset" || err.message.includes("ECONNRESET"))
    ) {
      isConnected = false;
      return false;
    }
    console.error("Error reading from connection:", err);
    return false;
  }
}

async function receiveFrame(): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  // Read metadata (width, height, size, chunks)
  const metadata = await readExactly(16); // 4 x 32-bit values
  if (!metadata) return null;

  const width = new DataView(metadata.buffer).getUint32(0, true);
  const height = new DataView(metadata.buffer).getUint32(4, true);
  const totalSize = new DataView(metadata.buffer).getUint32(8, true);
  const numChunks = new DataView(metadata.buffer).getUint32(12, true);

  const expectedSize = width * height * 4;
  if (
    width === 0 || height === 0 ||
    width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION ||
    totalSize === 0 || totalSize > MAX_FRAME_BYTES || totalSize !== expectedSize ||
    numChunks === 0 || numChunks > MAX_FRAME_CHUNKS
  ) {
    console.error(
      `[frame_receiver_worker] Rejecting invalid frame header: ${width}x${height}, totalSize=${totalSize}, numChunks=${numChunks}`,
    );
    return null;
  }

  // Acquire (recycled or newly allocated) frame buffer without letting OOM kill the listener.
  const frameData = acquireFrameBuffer(totalSize);
  if (!frameData) return null;
  let offset = 0;

  // Read all chunks
  for (let i = 0; i < numChunks; i++) {
    // Read chunk size
    const chunkSizeData = await readExactly(4);
    if (!chunkSizeData) {
      returnToPool(frameData.buffer);
      return null;
    }
    const chunkSize = new DataView(chunkSizeData.buffer).getUint32(0, true);

    // Read straight into the final frame. The old path allocated a chunk and
    // copied it into this buffer for every protocol chunk.
    if (offset + chunkSize > frameData.length) {
      returnToPool(frameData.buffer);
      return null;
    }
    if (!await readExactlyInto(frameData, offset, chunkSize)) {
      returnToPool(frameData.buffer);
      return null;
    }
    offset += chunkSize;
  }

  return { data: frameData, width, height };
}

async function startReceiving() {
  while (isConnected) {
    const frameStart = performance.now();
    const frame = await receiveFrame();
    if (frame) {
      const receiveTime = performance.now() - frameStart;
      worker.postMessage({
        type: "frame",
        data: frame.data,
        width: frame.width,
        height: frame.height,
        receiveTime,
      }, [frame.data.buffer]);
    } else {
      // If receiveFrame returns null, connection is likely closed
      if (isConnected) {
        isConnected = false;
        worker.postMessage({ type: "disconnected" });
      }
      break;
    }
    // The next TCP read is already an asynchronous yield. Avoid creating a
    // timer and promise for every captured frame.
  }
}

async function acceptConnections(reaccept: boolean): Promise<void> {
  do {
    const current = listener;
    if (!current) return;
    try {
      conn = await current.accept();
    } catch {
      return; // stopped
    }
    isConnected = true;
    worker.postMessage({ type: "connected" });
    try {
      await startReceiving();
    } catch (err) {
      console.error("[frame_receiver_worker] Unexpected receive loop error:", err);
      if (isConnected) {
        isConnected = false;
        worker.postMessage({ type: "disconnected" });
      }
    }
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
    conn = null;
  } while (reaccept && listener);
}

worker.onmessage = async (e: MessageEvent) => {
  const { type, port } = e.data;

  if (type === "recycle") {
    const buf = e.data.buffer;
    if (buf instanceof ArrayBuffer) {
      returnToPool(buf);
    }
    return;
  }

  if (type === "connect") {
    try {
      // Port 0: any free port, reported back. With `reaccept`, a helper that goes away can be
      // replaced by another connecting to the same port; otherwise one connection only.
      listener = Deno.listen({ hostname: "127.0.0.1", port });
      worker.postMessage({ type: "listening", port: (listener.addr as Deno.NetAddr).port });
      void acceptConnections(e.data.reaccept === true);
    } catch (err) {
      worker.postMessage({ type: "error", error: (err as Error).message });
    }
  } else if (type === "stop") {
    isConnected = false;
    if (conn) {
      conn.close();
      conn = null;
    }
    if (listener) {
      listener.close();
      listener = null;
    }
    worker.postMessage({ type: "stopped" });
  }
};

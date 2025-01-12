// Frame receiver worker
let conn: Deno.Conn | null = null;
let listener: Deno.Listener | null = null;
let isConnected = false;

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
    console.error("Error reading from connection:", err);
    return null;
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

  // Allocate frame buffer
  const frameData = new Uint8Array(totalSize);
  let offset = 0;

  // Read all chunks
  for (let i = 0; i < numChunks; i++) {
    // Read chunk size
    const chunkSizeData = await readExactly(4);
    if (!chunkSizeData) return null;
    const chunkSize = new DataView(chunkSizeData.buffer).getUint32(0, true);

    // Read chunk data
    const chunk = await readExactly(chunkSize);
    if (!chunk) return null;

    frameData.set(chunk, offset);
    offset += chunk.length;
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
        type: 'frame', 
        data: frame.data,
        width: frame.width,
        height: frame.height,
        receiveTime 
      });
    }
    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

worker.onmessage = async (e: MessageEvent) => {
  const { type, port } = e.data;
  
  if (type === 'connect') {
    try {
      // Create TCP server
      listener = Deno.listen({
        hostname: "127.0.0.1",
        port,
      });
      worker.postMessage({ type: 'listening', port });

      // Wait for client connection
      console.log("Waiting for client connection...");
      conn = await listener.accept();
      isConnected = true;
      worker.postMessage({ type: 'connected' });
      startReceiving();
    } catch (err) {
      worker.postMessage({ type: 'error', error: (err as Error).message });
    }
  } else if (type === 'stop') {
    isConnected = false;
    if (conn) {
      conn.close();
      conn = null;
    }
    if (listener) {
      listener.close();
      listener = null;
    }
    worker.postMessage({ type: 'stopped' });
  }
};

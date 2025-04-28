// Frame receiver worker (named pipe version)
import { listen, type NamedPipeConn, type NamedPipeListener } from "jsr:@milly/namedpipe";

let conn: NamedPipeConn | null = null;
let listener: NamedPipeListener | null = null;
let isConnected = false;

const PIPE_PATH = "\\\\.\\pipe\\your-own-name";
const worker = self as unknown as Worker;

// Ping-pong buffers
let sabs: SharedArrayBuffer[] = [];
let sabViews: Uint8Array[] = [];
let currentIndex = 0;

// --- Static metadata storage ---
let frameWidth: number | null = null;
let frameHeight: number | null = null;
let frameTotalSize: number | null = null;
let initialMetadataRead = false;

// Read exactly into provided buffer
async function readExactlyTo(buf: Uint8Array): Promise<boolean> {
  let offset = 0;
  while (offset < buf.length) {
    if (!conn) return false;
    const n = await conn.read(buf.subarray(offset));
    if (n === null) return false;
    if (n > 0) {
      offset += n;
    }
  }
  return true;
}

const SKIP_BYTES_BUFFER = new Uint8Array(4096);
async function skipBytes(size: number): Promise<boolean> {
  let remaining = size;
  while (remaining > 0) {
    const readSize = Math.min(remaining, SKIP_BYTES_BUFFER.length);
    const chunkView = SKIP_BYTES_BUFFER.subarray(0, readSize);
    if (!conn) return false;
    const n = await conn.read(chunkView);
    if (n === null) return false;
    if (n > 0) {remaining -= n;}
  }
  return true;
}

async function startReceiving() {
  // Read initial metadata ONCE if not already done for this connection
  if (!initialMetadataRead) {
    const metaBuf = new Uint8Array(16);
    const okMeta = await readExactlyTo(metaBuf);
    if (!okMeta) {
      worker.postMessage({ type: 'error', error: 'Failed to read initial metadata' });
      isConnected = false; // Stop receiving
      return;
    }
    const metaInts = new Uint32Array(metaBuf.buffer, metaBuf.byteOffset, 4);
    const [width, height, totalSize, numChunks] = metaInts;

    if (numChunks !== 1) {
      worker.postMessage({ type: 'error', error: `Initial metadata: Expected 1 chunk, got ${numChunks}`});
      isConnected = false; // Stop receiving
      return;
    }

    // Read and check initial chunk size (4 bytes)
    const sizeBuf = new Uint8Array(4);
    const okSize = await readExactlyTo(sizeBuf);
    if (!okSize) {
      worker.postMessage({ type: 'error', error: 'Failed to read initial chunk size' });
      isConnected = false; // Stop receiving
      return;
    }
    const chunkSize = new DataView(sizeBuf.buffer).getUint32(0, true);
    if (chunkSize !== totalSize) {
      worker.postMessage({ type: 'error', error: `Initial metadata: Chunk size (${chunkSize}) != total size (${totalSize})` });
      isConnected = false; // Stop receiving
      return;
    }

    // Store static values for this connection
    frameWidth = width;
    frameHeight = height;
    frameTotalSize = totalSize;
    initialMetadataRead = true;
    console.log(`[Worker] Initial metadata OK: ${frameWidth}x${frameHeight}, Size: ${frameTotalSize}`);

    // Ensure SAB capacity based on initial read
    if (sabs.length < 2 || sabs[0].byteLength < frameTotalSize) {
      //console.log(`[Worker] Resizing SABs to ${frameTotalSize} bytes.`);
      sabs = [new SharedArrayBuffer(frameTotalSize!), new SharedArrayBuffer(frameTotalSize!)]; // Ensure 2 SABs exist
      sabViews = sabs.map(sab => new Uint8Array(sab));
      worker.postMessage({ type: 'resize', buffers: sabs });
    } else {
      console.log(`[Worker] Existing SABs sufficient (${sabs[0].byteLength} bytes).`);
    }
  }

  // --- Main loop starts here --- 
  if (frameWidth === null || frameHeight === null || frameTotalSize === null) {
    worker.postMessage({ type: 'error', error: 'Static metadata not initialized before receive loop.' });
    isConnected = false; // Stop receiving
    return;
  }

  while (isConnected) {
    const frameStart = performance.now();

    // Skip the 16 bytes of metadata + 4 bytes of chunk size = 20 bytes
    const skipStart = performance.now();
    const skippedOk = await skipBytes(20);
    if (!skippedOk) {
      console.warn("[Worker] Failed to skip header bytes, connection likely closed.");
      isConnected = false; // Stop receiving
      break;
    }
    const skipTime = performance.now() - skipStart;

    // Read pixel data directly into current ping-pong SAB
    const sabView = sabViews[currentIndex];
    const recvStart = performance.now();
    // Read chunk directly into sabView (size is known from initial metadata)
    const chunkView = sabView.subarray(0, frameTotalSize);
    const readOk = await readExactlyTo(chunkView);
    if (!readOk) {
      console.warn("[Worker] Failed to read frame data, connection likely closed.");
      isConnected = false; // Stop receiving
      break;
    }
    const receiveTime = performance.now() - recvStart;
    const totalTime = performance.now() - frameStart;

    //console.debug(`[WorkerTiming] skip: ${skipTime.toFixed(2)}ms, chunk: ${receiveTime.toFixed(2)}ms, total: ${totalTime.toFixed(2)}ms`);
    // notify main thread new frame is ready using stored dimensions
    worker.postMessage({ type: 'frame-ready', width: frameWidth, height: frameHeight, receiveTime, index: currentIndex });
    // Swap buffer
    currentIndex = 1 - currentIndex;
  }
  console.log("[Worker] Receive loop finished.");
}

worker.onmessage = async (e: MessageEvent) => {
  const { type, buffers } = e.data;
  if (type === 'connect') {
    // Reset state for new connection
    initialMetadataRead = false;
    frameWidth = null;
    frameHeight = null;
    frameTotalSize = null;
    conn = null;
    isConnected = false;
    currentIndex = 0; // Reset buffer index

    if (Array.isArray(buffers)) {
      sabs = buffers;
      sabViews = sabs.map(b => new Uint8Array(b));
      //console.log(`[Worker] Initialized with provided SABs of size ${sabs.length > 0 ? sabs[0].byteLength : 0}`);
    } else {
        // If no buffers provided, create some defaults (will be resized if needed)
        sabs = [new SharedArrayBuffer(1024*1024), new SharedArrayBuffer(1024*1024)];
        sabViews = sabs.map(b => new Uint8Array(b));
        console.log(`[Worker] Initialized with default SABs of size ${sabs[0].byteLength}`);
    }

    try {
      // Create named pipe server
      if (listener) {
        try { listener.close(); } catch(e) { console.warn("Error closing previous listener:", e); }
      }
      listener = listen({ path: PIPE_PATH });
      worker.postMessage({ type: 'listening', path: PIPE_PATH });

      // Wait for client connection
      console.log("Waiting for named pipe client connection...");
      conn = await listener.accept();
      isConnected = true;
      worker.postMessage({ type: 'connected' });
      startReceiving(); // Start receiving, will read initial metadata
    } catch (err) {
      worker.postMessage({ type: 'error', error: (err as Error).message });
      isConnected = false;
    }
  } else if (type === 'stop') {
    console.log("[Worker] Received stop message.");
    isConnected = false;
    if (conn) {
      try { conn.close(); } catch(e) { console.warn("Error closing connection:", e); }
      conn = null;
    }
    if (listener) {
      try { listener.close(); } catch(e) { console.warn("Error closing listener:", e); }
      listener = null;
    }
    worker.postMessage({ type: 'stopped' });
  }
};

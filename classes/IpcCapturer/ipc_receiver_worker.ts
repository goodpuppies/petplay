// classes/IpcCapturer/ipc_receiver_worker.ts
import { listen, type NamedPipeListener, type NamedPipeConn } from "jsr:@milly/namedpipe@^1.1"; // Use listen

let pipeListener: NamedPipeListener | null = null;
let isListening = false;
let stopListening = false;
let currentConnection: NamedPipeConn | null = null; // Keep track of the current connection
// Removed currentReader

let sharedBuffer: SharedArrayBuffer | null = null;
let sharedView: DataView | null = null;
let frameReadyFlag: Int32Array | null = null;
let sharedPixelData: Uint8Array | null = null;
const WIDTH_BYTES = 4;
const HEIGHT_BYTES = 4;
const METADATA_SIZE = WIDTH_BYTES + HEIGHT_BYTES; // width + height
const SYNC_FLAG_SIZE = 4; // Size of the Int32Array flag
const HEADER_SIZE = METADATA_SIZE + SYNC_FLAG_SIZE; // Total size before pixel data in SharedArrayBuffer
let expectedFrameSize = 0; // Total bytes expected per frame message
let internalBufferSize = 0; // Size of the worker's internal read buffer
// -------------------------------

const worker = self as unknown as Worker;

// Adapted from pipeserver.ts, integrated with SAB and worker communication
async function handlePersistentConnection(conn: NamedPipeConn): Promise<void> {
  console.log('[IPC Worker] Client connected to pipe.');
  currentConnection = conn;
  worker.postMessage({ type: 'connected' });
  
  // Use direct reads into SharedArrayBuffer for optimal performance
  if (!sharedBuffer || !frameReadyFlag) {
    console.error("[IPC Worker] SharedArrayBuffer not initialized. Aborting.");
    return;
  }
  // Helper to read exactly `target.length` bytes
  async function readExactly(conn: NamedPipeConn, target: Uint8Array): Promise<boolean> {
    let offset = 0;
    while (offset < target.length && !stopListening) {
      const n = await conn.read(target.subarray(offset));
      if (n === null) return false;
      if (n > 0) offset += n;
    }
    return offset === target.length;
  }
  // Pre-allocate header buffer and typed-array views
  const headerBuf = new Uint8Array(METADATA_SIZE);
  const headerView = new DataView(headerBuf.buffer);
  const metaArray = new Uint32Array(sharedBuffer, 0, METADATA_SIZE / 4);
  let totalFramesReceived = 0;

  try {
    while (!stopListening) {
      // Start per-frame performance timing
      const frameStart = performance.now();
      // Read header
      const ok = await readExactly(conn, headerBuf);
      const tHeader = performance.now();
      if (!ok || stopListening) break;
      const w = headerView.getUint32(0, true);
      const h = headerView.getUint32(WIDTH_BYTES, true);
      const pixelSize = w * h * 4;

      // Write metadata to SAB
      const tMetaStart = performance.now();
      Atomics.store(frameReadyFlag, 0, 0);
      metaArray[0] = w;
      metaArray[1] = h;
      const tMeta = performance.now();

      // Read pixels directly into SAB
      const tPixStart = performance.now();
      const pixelView = new Uint8Array(sharedBuffer, HEADER_SIZE, pixelSize);
      const ok2 = await readExactly(conn, pixelView);
      if (!ok2 || stopListening) break;

      const tNotifyStart = performance.now();
      Atomics.store(frameReadyFlag, 0, 1);
      worker.postMessage({ type: 'frameReady', width: w, height: h });
      const tNotify = performance.now();
      totalFramesReceived++;
      console.log(
        `[IPC Worker] Frame ${totalFramesReceived}: total ${(tNotify - frameStart).toFixed(2)}ms` +
        ` (hdr ${(tHeader - frameStart).toFixed(2)}ms, meta ${(tMeta - tMetaStart).toFixed(2)}ms, ` +
        `pix ${(tNotifyStart - tPixStart).toFixed(2)}ms, notify ${(tNotify - tNotifyStart).toFixed(2)}ms)`
      );
    }
  } catch (error) {
    if (!stopListening) { // Don't log error if we stopped intentionally
        console.error('[IPC Worker] Error during pipe read/process loop:', error);
        worker.postMessage({ type: 'error', error: `Pipe read error: ${error}` });
    }
  } finally {
    console.log('[IPC Worker] Closing pipe connection read loop.');
    isListening = false; // Mark as not actively listening on this connection
    // Removed reader; no cancellation required
    currentConnection = null;
    // Note: we skip cancelling any stream reader
    try { await conn.close(); } catch (e) { console.warn("[IPC Worker] Error closing connection:", e); }
    // Only post disconnected if we weren't explicitly stopped
    if (!stopListening) {
        worker.postMessage({ type: 'disconnected' });
    }
    console.log(`[IPC Worker] Connection finished. Received ${totalFramesReceived} frames.`);
  }
}

// Main listener loop for the worker
async function startPipeListener(pipeName: string) {
  if (pipeListener) {
    console.warn('[IPC Worker] Pipe listener already exists.');
    return;
  }
  stopListening = false;
  console.log(`[IPC Worker] Starting named pipe listener on: ${pipeName}`);
  try {
    pipeListener = listen({ path: pipeName });
    worker.postMessage({ type: 'listening', pipeName });
    console.log(`[IPC Worker] Listener created, waiting for connections...`);

    for await (const conn of pipeListener) {
      if (stopListening) break; // Exit loop if stop was requested
      // Handle the new connection (don't await, allow multiple connections potentially, though unlikely for this use case)
      // If we only want one connection at a time, we could await here.
      handlePersistentConnection(conn).catch(err => {
          console.error("[IPC Worker] Unhandled error in handlePersistentConnection:", err);
      });
    }

  } catch (err) {
    console.error(`[IPC Worker] Failed to start or run pipe listener on ${pipeName}:`, err);
    worker.postMessage({ type: 'error', error: `Pipe listener error: ${err}` });
  } finally {
    console.log('[IPC Worker] Pipe listener loop finished.');
    isListening = false;
    pipeListener = null; // Clear listener reference
    // If stopListening was true, post 'stopped', otherwise it might be an error state
    if (stopListening) {
        worker.postMessage({ type: 'stopped' });
    }
  }
}

worker.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      sharedBuffer = e.data.buffer as SharedArrayBuffer;
      expectedFrameSize = 0;
      internalBufferSize = (WIDTH_BYTES + HEIGHT_BYTES + (1920 * 1080 * 4)) * 2; // Recalculate internal buffer size

      sharedView = new DataView(sharedBuffer);
      frameReadyFlag = new Int32Array(sharedBuffer, METADATA_SIZE, 1); // Flag is after metadata
      sharedPixelData = new Uint8Array(sharedBuffer, HEADER_SIZE); // Pixels are after metadata + flag

      console.log(`[IPC Worker] Initialized with SharedArrayBuffer. Meta: ${METADATA_SIZE}, Header: ${HEADER_SIZE}`);
      worker.postMessage({ type: 'workerReady' });
    } catch (error) {
      console.error('[IPC Worker] Error initializing SharedArrayBuffer:', error);
      worker.postMessage({ type: 'error', error: `Failed to initialize SharedArrayBuffer: ${error}` });
    } 
  } else if (type === 'connect') {
    const { pipeName } = e.data;
    if (!pipeName) {
      worker.postMessage({ type: 'error', error: 'Pipe name not provided for connect command.' });
      return;
    }
    // Don't await here, let the listener run in the background
    startPipeListener(pipeName).catch(err => {
        console.error("[IPC Worker] Error starting listener process:", err);
    }); 
  } else if (type === 'stop') {
    console.log('[IPC Worker] Received stop command.');
    stopListening = true;
    isListening = false;

    // Removed reader cancellation logic
    // Close the current connection if it exists
    if (currentConnection) {
        console.log('[IPC Worker] Closing current connection...');
        try { await currentConnection.close(); } catch(e) { console.warn("[IPC Worker] Error closing connection during stop:", e); }
        currentConnection = null;
    }
    // Close the main listener
    if (pipeListener) {
      console.log('[IPC Worker] Closing pipe listener...');
      try {
         pipeListener.close(); // Close the server listener
      } catch (err) {
        console.error('[IPC Worker] Error closing pipe listener:', err);
      }
      pipeListener = null;
    }
    // Note: 'stopped' message is posted in the finally block of startPipeListener
  }
};

console.log('[IPC Worker] Worker script loaded.');

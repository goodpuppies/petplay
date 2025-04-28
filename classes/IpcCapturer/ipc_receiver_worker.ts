// classes/IpcCapturer/ipc_receiver_worker.ts
import { listen, type NamedPipeListener, type NamedPipeConn } from "jsr:@milly/namedpipe@^1.1"; // Only listen needed now

// --- Frame Pipe variables (Server role) ---
let framePipeListener: NamedPipeListener | null = null; // Will be renamed later
let frameIsListening = false; // Will be renamed later
let frameStopListening = false; // Will be renamed later
let frameCurrentConnection: NamedPipeConn | null = null; // Will be renamed later

// --- Transform Pipe variables (Server role) ---
let transformPipeListener: NamedPipeListener | null = null;
let transformPipeConn: NamedPipeConn | null = null; // The connection from Rust client
let transformPipeWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let transformIsListening = false;
let transformStopListening = false;
const TRANSFORM_PIPE_NAME = '\\\\.\\pipe\\petplay-ipc-transform';
const TRANSFORM_DATA_SIZE = 16 * 4; // 16 x float32

// --- Shared Buffer Variables --- 
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

const worker = self as unknown as Worker;

// --- Transform Pipe Listener Logic ---
async function handleTransformConnection(conn: NamedPipeConn): Promise<void> {
    console.log('[IPC Worker TX] Rust client connected to transform pipe.');

    // Only allow one transform connection at a time for simplicity
    if (transformPipeConn) {
        console.warn("[IPC Worker TX] Another client tried to connect to transform pipe. Closing new connection.");
        try { await conn.close(); } catch(e) { /* Ignore */ }
        return;
    }

    transformPipeConn = conn;
    transformPipeWriter = conn.writable.getWriter();
    worker.postMessage({ type: 'transformPipeConnected' }); // Notify main thread

    // Monitor the connection for closure/errors from the Rust side
    // We don't read from this pipe, but need to know if it closes
    conn.readable.pipeTo(new WritableStream({
        write() { /* Ignore incoming data */ },
        close() {
            console.log('[IPC Worker TX] Transform pipe connection closed by Rust client.');
            transformPipeWriter = null;
            transformPipeConn = null;
            worker.postMessage({ type: 'transformPipeDisconnected' });
        },
        abort(reason) {
             console.error('[IPC Worker TX] Transform pipe connection aborted:', reason);
             transformPipeWriter = null;
             transformPipeConn = null;
             worker.postMessage({ type: 'transformPipeDisconnected', error: reason });
        }
    })).catch(err => {
        console.error('[IPC Worker TX] Error piping transform readable stream:', err);
        transformPipeWriter = null;
        transformPipeConn = null;
        worker.postMessage({ type: 'transformPipeDisconnected', error: err });
    });

    // Handle potential closure/errors originating from our writer side
    transformPipeWriter.closed.catch(err => {
        console.error('[IPC Worker TX] Transform pipe writer closed with error:', err);
        if (transformPipeConn === conn) { // Only clear if it's still the same connection
            transformPipeWriter = null;
            transformPipeConn = null;
            worker.postMessage({ type: 'transformPipeDisconnected', error: `Writer error: ${err}` });
        }
    });

     console.log("[IPC Worker TX] Ready to send transform data.");
}

async function startTransformPipeListener() {
  if (transformPipeListener || transformIsListening) {
    console.warn('[IPC Worker TX] Transform pipe listener already starting/running.');
    return;
  }
  transformStopListening = false;
  transformIsListening = true; // Set flag early
  console.log(`[IPC Worker TX] Starting transform pipe listener (server) on: ${TRANSFORM_PIPE_NAME}`);
  try {
    transformPipeListener = listen({ path: TRANSFORM_PIPE_NAME }); // Use listen
    worker.postMessage({ type: 'transformPipeListening' });
    console.log(`[IPC Worker TX] Transform Listener created, waiting for Rust client connection...`);

    for await (const conn of transformPipeListener) {
      if (transformStopListening) break;
      handleTransformConnection(conn).catch(err => {
          console.error("[IPC Worker TX] Unhandled error in handleTransformConnection:", err);
          try { conn.close(); } catch(e) {}
      });
    }

  } catch (err) {
    console.error(`[IPC Worker TX] Failed to start or run transform pipe listener on ${TRANSFORM_PIPE_NAME}:`, err);
    worker.postMessage({ type: 'error', error: `Transform Pipe listener error: ${err}` });
  } finally {
    console.log('[IPC Worker TX] Transform pipe listener loop finished.');
    transformIsListening = false;
    transformPipeListener = null; // Clear listener reference
    if (transformPipeConn && !transformStopListening) {
        console.warn("[IPC Worker TX] Transform listener stopped unexpectedly, cleaning up connection.");
        try { await transformPipeConn.close(); } catch(e) {}
        transformPipeConn = null;
        transformPipeWriter = null;
        worker.postMessage({ type: 'transformPipeDisconnected', error: 'Listener stopped unexpectedly' });
    }
    if (transformStopListening) {
        worker.postMessage({ type: 'transformPipeStopped' });
    }
  }
}

async function sendTransformData(matrixData: Float32Array): Promise<void> {
    if (!transformPipeWriter) {
        console.warn("[IPC Worker TX] Transform pipe writer not available (no client connected?), cannot send data.");
        return;
    }
    if (matrixData.byteLength !== TRANSFORM_DATA_SIZE) {
         console.error(`[IPC Worker TX] Invalid matrix data size: expected ${TRANSFORM_DATA_SIZE}, got ${matrixData.byteLength}`);
         return;
    }

    try {
        await transformPipeWriter.write(new Uint8Array(matrixData.buffer));
        // console.log("[IPC Worker TX] Sent transform data."); // Log only if debugging
    } catch (error) {
        console.error('[IPC Worker TX] Error writing transform data:', error);
        // Writer might be closed, connection state handled by .closed/.readable handlers
    }
}

// --- Frame Pipe Connection/Handling Logic (Renamed and updated) ---

async function handleFrameConnection(conn: NamedPipeConn): Promise<void> {
  console.log('[IPC Worker FR] Client connected to frame pipe.');
  frameCurrentConnection = conn;
  worker.postMessage({ type: 'framePipeConnected' });
  
  // Use direct reads into SharedArrayBuffer for optimal performance
  if (!sharedBuffer || !frameReadyFlag) {
    console.error("[IPC Worker FR] SharedArrayBuffer not initialized. Aborting.");
    return;
  }
  // Helper to read exactly `target.length` bytes
  async function readExactly(conn: NamedPipeConn, target: Uint8Array): Promise<boolean> {
    let offset = 0;
    while (offset < target.length && !frameStopListening) {
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
    while (!frameStopListening) {
      // Start per-frame performance timing
      const frameStart = performance.now();
      // Read header
      const ok = await readExactly(conn, headerBuf);
      const tHeader = performance.now();
      if (!ok || frameStopListening) break;
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
      // Ensure pixelView size doesn't exceed buffer bounds (important!)
      if (HEADER_SIZE + pixelSize > sharedBuffer.byteLength) {
          console.error(`[IPC Worker FR] Frame size ${pixelSize} exceeds SharedArrayBuffer pixel space (${sharedBuffer.byteLength - HEADER_SIZE}). Aborting read.`);
          break; // Prevent buffer overflow
      }
      const pixelView = new Uint8Array(sharedBuffer, HEADER_SIZE, pixelSize);
      const ok2 = await readExactly(conn, pixelView);
      if (!ok2 || frameStopListening) break;

      const tNotifyStart = performance.now();
      Atomics.store(frameReadyFlag, 0, 1);
      
      worker.postMessage({ type: 'frameReady', width: w, height: h });
      const tNotify = performance.now();
      totalFramesReceived++;
      // console.log(`[IPC Worker FR] Frame ${totalFramesReceived}: ${w}x${h}`); // Optional logging
    }
  } catch (error) {
    if (!frameStopListening) {
        console.error('[IPC Worker FR] Error during frame pipe read/process loop:', error);
        worker.postMessage({ type: 'error', error: `Frame Pipe read error: ${error}` });
    }
  } finally {
    console.log('[IPC Worker FR] Closing frame pipe connection read loop.');
    frameCurrentConnection = null;
    try { await conn.close(); } catch (e) { console.warn("[IPC Worker FR] Error closing frame connection:", e); }
    if (!frameStopListening) {
        worker.postMessage({ type: 'framePipeDisconnected' });
    }
    console.log(`[IPC Worker FR] Frame connection finished. Received ${totalFramesReceived} frames.`);
  }
}

async function startFramePipeListener(pipeName: string) {
  if (framePipeListener || frameIsListening) {
    console.warn('[IPC Worker FR] Frame pipe listener already exists or is starting.');
    return;
  }
  frameStopListening = false;
  frameIsListening = true;
  console.log(`[IPC Worker FR] Starting frame pipe listener on: ${pipeName}`);
  try {
    framePipeListener = listen({ path: pipeName });
    worker.postMessage({ type: 'framePipeListening', pipeName });
    console.log(`[IPC Worker FR] Frame Listener created, waiting for connections...`);

    for await (const conn of framePipeListener) {
      if (frameStopListening) break;
      // Only handle one frame connection at a time for now
      if (frameCurrentConnection) {
          console.warn("[IPC Worker FR] Another client tried to connect to frame pipe. Closing new connection.");
          try { await conn.close(); } catch(e) {} // Ignore error
          continue; // Wait for next connection attempt
      }
      handleFrameConnection(conn).catch(err => {
          console.error("[IPC Worker FR] Unhandled error in handleFrameConnection:", err);
          try { conn.close(); } catch(e) {} // Attempt cleanup
      });
    }
  } catch (err) {
    console.error(`[IPC Worker FR] Failed to start or run frame pipe listener on ${pipeName}:`, err);
    worker.postMessage({ type: 'error', error: `Frame Pipe listener error: ${err}` });
  } finally {
    console.log('[IPC Worker FR] Frame pipe listener loop finished.');
    frameIsListening = false;
    framePipeListener = null;
    // Clean up connection if loop exits unexpectedly
    if (frameCurrentConnection && !frameStopListening) {
        console.warn("[IPC Worker FR] Frame listener stopped unexpectedly, cleaning up connection.");
        try { await frameCurrentConnection.close(); } catch(e) {}
        frameCurrentConnection = null;
        worker.postMessage({ type: 'framePipeDisconnected', error: 'Listener stopped unexpectedly' });
    }
    if (frameStopListening) {
        worker.postMessage({ type: 'framePipeStopped' });
    }
  }
}

// --- Worker Message Handling ---

worker.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
        sharedBuffer = e.data.buffer as SharedArrayBuffer;
        frameReadyFlag = new Int32Array(sharedBuffer, METADATA_SIZE, 1);
        console.log(`[IPC Worker] Initialized with SharedArrayBuffer.`);
        worker.postMessage({ type: 'workerReady' });

        // --- Start Transform Pipe Listener --- 
        transformStopListening = false; // Allow starting
        startTransformPipeListener(); // Start listening for the Rust client

    } catch (error) {
        console.error('[IPC Worker] Error initializing SharedArrayBuffer:', error);
        worker.postMessage({ type: 'error', error: `Failed to initialize SharedArrayBuffer: ${error}` });
    } 
  } else if (type === 'connectFramePipe') {
    const { pipeName } = e.data;
    if (!pipeName) {
      worker.postMessage({ type: 'error', error: 'Frame Pipe name not provided for connect command.' });
      return;
    }
    // Prevent starting multiple listeners
    if (!frameIsListening && !framePipeListener) {
        startFramePipeListener(pipeName).catch(err => {
            console.error("[IPC Worker FR] Error starting frame listener process:", err);
        }); 
    } else {
        console.warn("[IPC Worker FR] Frame pipe listener already active or starting.");
    }
  } else if (type === 'sendTransform') {
      const { matrix } = e.data;
      if (matrix instanceof Float32Array) {
          await sendTransformData(matrix);
      } else {
          console.error("[IPC Worker TX] Received invalid data type for 'sendTransform'. Expected Float32Array.", matrix);
      }

  } else if (type === 'stop') {
    console.log('[IPC Worker] Received stop command.');
    // Stop both listeners and close connections
    frameStopListening = true;
    transformStopListening = true;

    // Close frame connection/listener
    if (frameCurrentConnection) {
        console.log('[IPC Worker FR] Closing frame connection...');
        try { await frameCurrentConnection.close(); } catch(e) { console.warn("[IPC Worker FR] Error closing frame connection:", e); }
        frameCurrentConnection = null;
    }
    if (framePipeListener) {
      console.log('[IPC Worker FR] Closing frame pipe listener...');
      try { framePipeListener.close(); } catch (err) { console.error('[IPC Worker FR] Error closing frame pipe listener:', err); }
      framePipeListener = null;
    }

    // Close transform connection/listener
    if (transformPipeConn) {
        console.log('[IPC Worker TX] Closing transform connection...');
        try { await transformPipeConn.close(); } catch(e) { console.warn("[IPC Worker TX] Error closing transform connection:", e); }
        transformPipeConn = null;
        transformPipeWriter = null; // Make sure writer is cleared
    }
     if (transformPipeListener) {
      console.log('[IPC Worker TX] Closing transform pipe listener...');
      try { transformPipeListener.close(); } catch (err) { console.error('[IPC Worker TX] Error closing transform pipe listener:', err); }
      transformPipeListener = null;
    }

    // Note: 'stopped' messages are posted in the finally blocks of the listeners
  }
};

console.log('[IPC Worker] Worker script loaded.');

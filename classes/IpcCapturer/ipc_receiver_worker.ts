// classes/IpcCapturer/ipc_receiver_worker.ts
import { listen, type NamedPipeListener } from "jsr:@milly/namedpipe@^1.1"; // Use listen

let pipeListener: NamedPipeListener | null = null;
let isListening = false;
let stopListening = false;
let currentConnection: Deno.Conn | null = null; // Keep track of the current connection
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

// --- SharedArrayBuffer State ---
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
async function handlePersistentConnection(conn: Deno.Conn): Promise<void> {
  console.log('[IPC Worker] Client connected to pipe.');
  currentConnection = conn;
  worker.postMessage({ type: 'connected' });
  
  currentReader = conn.readable.getReader();
  const reader = currentReader; // Local ref for safety within loop

  // Pre-allocated buffer and pointers for reading from the pipe
  let buffer = new Uint8Array(internalBufferSize);
  let readPos = 0;  // Start position of unread data in 'buffer'
  let writePos = 0; // End position of unread data in 'buffer'
  let totalFramesReceived = 0;

  try {
    while (!stopListening) {
      // --- Compact buffer if necessary --- 
      if (readPos > 0 && writePos > readPos) {
         buffer.set(buffer.subarray(readPos, writePos), 0);
         writePos -= readPos;
         readPos = 0;
      }
      // Check if buffer is full after compaction
      if (writePos === buffer.byteLength) {
          console.error("[IPC Worker] Internal read buffer full, cannot read more data. Potential logic error or frame size mismatch.");
          // Consider how to recover - maybe discard buffer and wait for next frame?
          // For now, break the read loop for this connection.
          break; 
      }

      // --- Read more data into the buffer --- 
      const { value, done } = await reader.read();

      if (done || stopListening) {
        console.log(`[IPC Worker] Pipe read stream closed (Done: ${done}, Stop: ${stopListening}).`);
        break;
      }
      if (!value || value.byteLength === 0) {
        console.log('[IPC Worker] Read 0 bytes, continuing.');
        continue; // Should not happen often with named pipes but handle defensively
      }

      // Append new data
      const spaceAvailable = buffer.byteLength - writePos;
      const bytesToCopy = Math.min(value.byteLength, spaceAvailable);
      if (bytesToCopy < value.byteLength) {
          console.warn(`[IPC Worker] Read buffer overflow imminent. Received ${value.byteLength}, space ${spaceAvailable}. Truncating read.`);
      }
      buffer.set(value.subarray(0, bytesToCopy), writePos);
      writePos += bytesToCopy;

      // --- Process complete frames from the buffer ---
      while (writePos - readPos >= METADATA_SIZE) {
        const metadataView = new DataView(buffer.buffer, buffer.byteOffset + readPos, METADATA_SIZE);
        const width = metadataView.getUint32(0, true);
        const height = metadataView.getUint32(WIDTH_BYTES, true);
        const requiredPixelSize = width * height * 4;
        expectedFrameSize = METADATA_SIZE + requiredPixelSize;

        if (writePos - readPos >= expectedFrameSize) {
          const frameData = buffer.subarray(readPos, readPos + expectedFrameSize);
          readPos += expectedFrameSize; // Consume frame from buffer

          // --- Process Frame into SharedArrayBuffer ---
          try {
            if (!sharedBuffer || !sharedView || !frameReadyFlag || !sharedPixelData) {
              console.error("[IPC Worker] SharedArrayBuffer not initialized. Skipping frame.");
              continue;
            }

            // Lock not strictly needed with single worker write, but good practice
            Atomics.store(frameReadyFlag, 0, 0); // 0 = writing/not ready

            // 1. Parse Metadata (from pipe data)
            const receivedMetadataView = new DataView(frameData.buffer, frameData.byteOffset, METADATA_SIZE);
            const receivedWidth = receivedMetadataView.getUint32(0, true);
            const receivedHeight = receivedMetadataView.getUint32(WIDTH_BYTES, true);

            // 2. Write Metadata to Shared Buffer
            sharedView.setUint32(0, receivedWidth, true);
            sharedView.setUint32(WIDTH_BYTES, receivedHeight, true);
            
            // 3. Write Pixel Data to Shared Buffer
            const pixelDataOffset = METADATA_SIZE;
            const pixelData = frameData.subarray(pixelDataOffset);
            sharedPixelData.set(pixelData); // Direct copy

            // 4. Mark Frame Ready
            Atomics.store(frameReadyFlag, 0, 1); // 1 = ready

            // 5. Notify Main Thread (Push Model)
            worker.postMessage({ 
              type: 'frameReady',
              width: receivedWidth,
              height: receivedHeight
            });
            totalFramesReceived++;
            // Log periodically
            if (totalFramesReceived % 30 === 0) {
              // console.log(`[IPC Worker] Processed ${totalFramesReceived} frames.`);
            }

          } catch (err) {
            console.error("[IPC Worker] Error processing frame into SharedArrayBuffer:", err);
            Atomics.store(frameReadyFlag!, 0, 0); // Ensure flag is reset on error
            // Use throw error for any undefined behaviour as per user rules
            throw new Error(`Error processing frame: ${err}`);
          }
          // ----------------------------------------
        } else {
          break;
        }
      }
    }
  } catch (error) {
    if (!stopListening) { // Don't log error if we stopped intentionally
        console.error('[IPC Worker] Error during pipe read/process loop:', error);
        worker.postMessage({ type: 'error', error: `Pipe read error: ${error}` });
    }
  } finally {
    console.log('[IPC Worker] Closing pipe connection read loop.');
    isListening = false; // Mark as not actively listening on this connection
    currentReader = null;
    currentConnection = null;
    // Don't close the reader here if it was cancelled by stopListening
    if (!stopListening && reader) {
       try { await reader.cancel(); } catch(e) { console.warn("[IPC Worker] Error cancelling reader:", e); }
    }
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

    // Cancel any ongoing read operation
    if (currentReader) {
        console.log('[IPC Worker] Cancelling current reader...');
        try { await currentReader.cancel(); } catch(e) { console.warn("[IPC Worker] Error cancelling reader during stop:", e); }
        currentReader = null;
    }
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

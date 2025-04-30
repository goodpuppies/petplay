// Frame receiver worker (named pipe version)

import { connect, NamedPipeConn } from "jsr:@milly/namedpipe";
(async () => {
  try {

    let conn: NamedPipeConn | null = null;
    let isConnected = false;
    let stopRequested = false; // Flag to signal stop during connection attempts

    const PIPE_PATH = "\\\\.\\pipe\\petplay-webxr";
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
      try {
        while (offset < buf.length) {
          if (!conn || stopRequested) return false;
          const n = await conn.read(buf.subarray(offset));
          if (n === null) return false;
          if (n > 0) {
            offset += n;
          }
        }
        return true;
      } catch (err) {
        const error = err as Error;
        // Gracefully handle pipe closure errors
        if (error.message.includes("forcibly closed") || 
            error.message.includes("os error 997") || 
            error.message.includes("os error 232")) {
          console.log("[Worker] Pipe connection closed during read");
          isConnected = false;
          return false;
        }
        // Rethrow unexpected errors
        throw err;
      }
    }

    const SKIP_BYTES_BUFFER = new Uint8Array(4096);
    async function skipBytes(size: number): Promise<boolean> {
      let remaining = size;
      try {
        while (remaining > 0) {
          if (!conn || stopRequested) return false;
          const readSize = Math.min(remaining, SKIP_BYTES_BUFFER.length);
          const chunkView = SKIP_BYTES_BUFFER.subarray(0, readSize);
          const n = await conn.read(chunkView);
          if (n === null) return false;
          if (n > 0) {remaining -= n;}
        }
        return true;
      } catch (err) {
        const error = err as Error;
        // Gracefully handle pipe closure errors
        if (error.message.includes("forcibly closed") || 
            error.message.includes("os error 997") || 
            error.message.includes("os error 232")) {
          console.log("[Worker] Pipe connection closed during skip");
          isConnected = false;
          return false;
        }
        // Rethrow unexpected errors
        throw err;
      }
    }

    // Helper function for delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


    async function startReceiving() {
      try {
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
      } catch (err) {
        const error = err as Error;
        // Handle any pipe errors during receiving
        if (error.message.includes("forcibly closed") || 
            error.message.includes("os error 997") || 
            error.message.includes("os error 232")) {
          console.log("[Worker] Pipe connection closed during frame receive");
          isConnected = false;
          return;
        }
        console.error("[Worker] Error in startReceiving:", error);
        worker.postMessage({ type: 'error', error: `Frame receive error: ${error.message}` });
        isConnected = false;
      }
    }

    worker.onmessage = async (e: MessageEvent) => {
      const { type, buffers } = e.data;
      if (type === 'connect') {
        // Reset state for new connection
        stopRequested = false; // Reset stop flag
        initialMetadataRead = false;
        frameWidth = null;
        frameHeight = null;
        frameTotalSize = null;
        if (conn) { // Close previous connection if exists
            try { conn.close(); } catch(e) { console.warn("Error closing previous connection:", e); }
        }
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

        // --- Connection Retry Loop ---
        while (!isConnected && !stopRequested) {
            try {
              // Connect as a client
              console.log(`[Worker] Attempting to connect to named pipe: ${PIPE_PATH}...`);
              conn = await connect({ path: PIPE_PATH });
              isConnected = true; // Connection successful
              console.log("[Worker] Connected successfully.");
              worker.postMessage({ type: 'connected' });
              startReceiving(); // Start receiving frames
            } catch (err) {
              const error = err as Error;
              // Check if it's the specific "file not found" error
              if (error.message.includes("(os error 2)")) {
                console.log("[Worker] Pipe not found (os error 2), retrying in 1 second...");
                await delay(1000); // Wait 1 second before retrying
              } else {
                // For other errors, report and stop trying
                console.error("[Worker] Connection failed:", error.message);
                worker.postMessage({ type: 'error', error: `Connection failed: ${error.message}` });
                isConnected = false;
                stopRequested = true; // Stop retrying on other errors
              }
            }
        }
        if (stopRequested) {
            console.log("[Worker] Connection attempt cancelled by stop request.");
        }
        // --- End Connection Retry Loop ---

      } else if (type === 'stop') {
        console.log("[Worker] Received stop message.");
        stopRequested = true; // Signal to stop connection attempts or receiving loop
        isConnected = false;
        
        if (conn) {
          try { 
            console.log("[Worker] Closing pipe connection...");
            conn.close();
          } catch(e) { 
            const error = e as Error;
            console.warn("[Worker] Error closing connection:", error.message);
            
            // Don't treat pipe closure errors as fatal during shutdown
            if (!error.message.includes("forcibly closed") && 
                !error.message.includes("os error 997") && 
                !error.message.includes("os error 232")) {
              worker.postMessage({ type: 'error', error: `Connection close error: ${error.message}` });
            }
          }
          conn = null;
        }
        
        worker.postMessage({ type: 'stopped' });
      }
    };

    // Global error handlers to catch and properly categorize errors
    self.addEventListener('unhandledrejection', (event) => {
      const error = event.reason;
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Don't report pipe closure errors during shutdown as fatal errors
      if (stopRequested && (
          errorMsg.includes("forcibly closed") || 
          errorMsg.includes("os error 997") || 
          errorMsg.includes("os error 232"))) {
        console.log("[Worker] Ignoring pipe closure error during shutdown:", errorMsg);
        event.preventDefault();
        return;
      }
      
      worker.postMessage({ type: 'error', error: `Unhandled rejection: ${errorMsg}` });
      event.preventDefault();
    });

    self.addEventListener('error', (event) => {
      // Similar filtering for expected errors during shutdown
      if (stopRequested && (
          event.message.includes("forcibly closed") || 
          event.message.includes("os error 997") || 
          event.message.includes("os error 232"))) {
        console.log("[Worker] Ignoring pipe error during shutdown:", event.message);
        event.preventDefault();
        return;
      }
      
      worker.postMessage({ type: 'error', error: `Unhandled error: ${event.message}` });
      event.preventDefault();
    });

  } catch (err) {
    // Top-level catch for any unexpected errors
    const error = err as Error;
    // Don't report connection closure errors during shutdown as fatal
    if (error.message.includes("forcibly closed") || 
        error.message.includes("os error 997") || 
        error.message.includes("os error 232")) {
      console.log("[Worker] Named pipe connection closed");
    } else {
      (self as any).postMessage?.({ type: 'error', error: `Fatal worker error: ${error.message}` });
    }
  }
})();

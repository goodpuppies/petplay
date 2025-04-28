// Frame receiver worker
let isConnected = false;
let wsServer: Deno.HttpServer | null = null;
let wsConnection: WebSocket | null = null;

// SharedArrayBuffer state
let sharedBuffer: SharedArrayBuffer | null = null;
let sharedView: DataView | null = null;
let frameReadyFlag: Int32Array | null = null;
let sharedPixelData: Uint8Array | null = null;
let metadataSize = 24; // Default values, will be updated in 'init' message
let headerSize = 28;

const worker = self as unknown as Worker;

function startWebSocketServer(port: number) {
  try {
    wsServer = Deno.serve({ port }, (req) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response(null, { status: 501 });
      }
      
      const { socket, response } = Deno.upgradeWebSocket(req);
      
      socket.addEventListener("open", () => {
        console.log("WebSocket client connected!");
        wsConnection = socket;
        isConnected = true;
        worker.postMessage({ type: 'connected' });
      });
      
      socket.addEventListener("message", (event) => {
        // Get timestamp as early as possible
        const messageArrivalTime = Date.now();
        
        try {
          // Handle binary data
          if (event.data instanceof ArrayBuffer) {
            // Check if SharedArrayBuffer is initialized
            if (!sharedBuffer || !sharedView || !frameReadyFlag || !sharedPixelData) {
              console.error("SharedArrayBuffer not initialized");
              return;
            }

            const buffer = new Uint8Array(event.data);
            
            // Parse metadata from incoming buffer
            // First section (16 bytes): width(4), height(4), timestamp(8)
            // Extended metadata may include poseTimestamp(8) and poseId(8)
            const metadataSize = buffer.byteLength >= 32 ? 32 : (buffer.byteLength >= 24 ? 24 : 16);
            const metadataView = new DataView(buffer.buffer, buffer.byteOffset, metadataSize);
            
            const width = metadataView.getUint32(0, true);
            const height = metadataView.getUint32(4, true);
            const frameTimestamp = metadataView.getFloat64(8, true); // Read timestamp
            
            // Safely read pose timestamp if available
            let poseTimestamp = frameTimestamp; // Default to frame timestamp if no pose timestamp
            if (metadataSize >= 24) {
              try {
                poseTimestamp = metadataView.getFloat64(16, true); // Read pose timestamp
              } catch (e) {
                console.warn("Failed to read pose timestamp, using frame timestamp instead");
              }
            }
            
            // Safely read pose ID if available
            let poseId = undefined;
            if (metadataSize >= 32) {
              try {
                poseId = metadataView.getFloat64(24, true); // Read pose ID
              } catch (e) {
                console.warn("Failed to read pose ID");
              }
            }
            
            // Calculate and log network latency
            const networkSendLatency = messageArrivalTime - frameTimestamp;
            //console.log(`Net+Send Latency: ${networkSendLatency.toFixed(2)} ms`);

            // Start timing direct memory access
            const processStartTime = Date.now();
            
            // Set frame ready flag to 0 during update (locked state)
            Atomics.store(frameReadyFlag, 0, 0);
            
            // Update the shared metadata
            sharedView.setUint32(0, width, true);
            sharedView.setUint32(4, height, true);
            sharedView.setFloat64(8, frameTimestamp, true);
            sharedView.setFloat64(16, poseTimestamp, true);
            
            if (poseId !== undefined) {
              sharedView.setFloat64(24, poseId, true);
            }
            
            // Extract and copy the pixel data directly to shared buffer
            const pixelDataOffset = metadataSize;
            const pixelData = new Uint8Array(buffer.buffer, buffer.byteOffset + pixelDataOffset);
            sharedPixelData.set(pixelData); // Direct copy to shared memory
            
            // Store the time when the frame becomes available in shared memory
            const frameAvailableTime = Date.now();
            sharedView.setFloat64(32, frameAvailableTime, true);
            
            // Mark frame as ready in the shared buffer
            Atomics.store(frameReadyFlag, 0, 1);
            
            // PUSH MODEL: Directly notify main thread about the new frame
            // This is much more immediate than polling or waiting
            worker.postMessage({ 
              type: 'frameReady',
              width,
              height,
              timestamp: frameTimestamp,
              poseTimestamp,
              poseId,
              frameAvailableTime
            });
            
            // Log direct memory access time
            const processEndTime = Date.now();
            //console.log(`Direct memory write time: ${processEndTime - processStartTime} ms`);
          } else {
            console.error("Expected binary data but received text");
          }
        } catch (err) {
          console.error("Error processing WebSocket message:", err);
        }
      });
      
      socket.addEventListener("close", () => {
        console.log("WebSocket client disconnected");
        wsConnection = null;
        isConnected = false;
      });
      
      socket.addEventListener("error", (event) => {
        console.error("WebSocket error:", event);
      });
      
      return response;
    });
    
    worker.postMessage({ type: 'listening', port });
    console.log(`WebSocket server started on port ${port}`);
    
  } catch (err) {
    worker.postMessage({ type: 'error', error: (err as Error).message });
  }
}

worker.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;
  
  if (type === 'init') {
    // Initialize SharedArrayBuffer from main thread
    try {
      sharedBuffer = e.data.buffer as SharedArrayBuffer;
      metadataSize = e.data.metadataSize || 24;
      headerSize = e.data.headerSize || 28;
      
      // Create views into the shared buffer
      sharedView = new DataView(sharedBuffer);
      frameReadyFlag = new Int32Array(sharedBuffer, metadataSize, 1);
      sharedPixelData = new Uint8Array(sharedBuffer, headerSize);
      
      console.log("Worker initialized with SharedArrayBuffer");
    } catch (error) {
      console.error("Error initializing SharedArrayBuffer in worker:", error);
      worker.postMessage({ type: 'error', error: `Failed to initialize SharedArrayBuffer: ${error}` });
    }
  } else if (type === 'connect') {
    const { port } = e.data;
    await startWebSocketServer(port);
  } else if (type === 'stop') {
    isConnected = false;
    
    if (wsConnection) {
      wsConnection.close();
      wsConnection = null;
    }
    
    if (wsServer) {
      wsServer.shutdown();
      wsServer = null;
    }
    
    worker.postMessage({ type: 'stopped' });
  } else if (type === "WSMSG") {
    const { payload } = e.data;
    wsConnection?.send(payload);
  }
};

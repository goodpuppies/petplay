// Frame receiver worker
let isConnected = false;
let wsServer: Deno.HttpServer | null = null;
let wsConnection: WebSocket | null = null;

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
        // Process incoming frame data from WebSocket
        try {
          // Handle binary data
          if (event.data instanceof ArrayBuffer) {
            const frameStart = performance.now();
            const buffer = new Uint8Array(event.data);
            
            // Parse metadata (first 8 bytes: width, height)
            const metadataView = new DataView(buffer.buffer, buffer.byteOffset, 8);
            const width = metadataView.getUint32(0, true);
            const height = metadataView.getUint32(4, true);
            
            // Extract the pixel data (remaining bytes after metadata)
            const pixelData = new Uint8Array(buffer.buffer, buffer.byteOffset + 8);
            
            const receiveTime = performance.now() - frameStart;
            
            worker.postMessage({ 
              type: 'frame', 
              data: pixelData,
              width: width,
              height: height,
              receiveTime 
            });
          } else {
            throw new Error("Expected binary data but received text");
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
  const { type, port } = e.data;
  
  if (type === 'connect') {
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
    const { type, payload } = e.data;
    wsConnection?.send(payload);
  }
};

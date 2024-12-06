// Deno WebSocket server for screen capture
const activeConnections = new Set<WebSocket>();

// Stats tracking
let bytesReceived = 0;
let lastStatsTime = performance.now();
let frameCount = 0;

// Start the WebSocket server
const server = Deno.serve({
  port: 8080,
  handler: (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    
    socket.addEventListener("open", () => {
      console.log("Client connected!");
      activeConnections.add(socket);
    });

    socket.addEventListener("message", async (event) => {
      // If it's an image frame from Python
      if (event.data.startsWith("frame:")) {
        const frameSize = event.data.length;
        bytesReceived += frameSize;
        frameCount++;

        const now = performance.now();
        if (now - lastStatsTime >= 1000) {
          const mbps = (bytesReceived * 8) / (1024 * 1024); // Convert to Mbps
          console.log(`Server Stats - FPS: ${frameCount}, Bandwidth: ${mbps.toFixed(2)} Mbps, Frame size: ${(frameSize/1024).toFixed(1)}KB`);
          bytesReceived = 0;
          frameCount = 0;
          lastStatsTime = now;
        }

        // Broadcast to all other clients
        for (const client of activeConnections) {
          if (client !== socket && client.readyState === WebSocket.OPEN) {
            try {
              client.send(event.data);
            } catch (err) {
              console.error("Error sending to client:", err);
              activeConnections.delete(client);
            }
          }
        }
      }
    });

    socket.addEventListener("close", () => {
      console.log("Client disconnected!");
      activeConnections.delete(socket);
    });

    return response;
  }
});

console.log("Screen capture WebSocket server running on ws://localhost:8080");

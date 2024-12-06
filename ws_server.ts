// Simple Deno WebSocket server
const server = Deno.serve({
  port: 8080,
  handler: (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    
    socket.addEventListener("open", () => {
      console.log("Client connected!");
    });

    socket.addEventListener("message", (event) => {
      console.log("Received:", event.data);
      // Echo back
      socket.send(`Server received: ${event.data}`);
    });

    socket.addEventListener("close", () => {
      console.log("Client disconnected!");
    });

    return response;
  }
});

console.log("WebSocket server running on ws://localhost:8080");

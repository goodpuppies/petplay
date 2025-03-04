// deno_server.ts


export class SignalingServer {
  private clients = new Map();

  constructor(private port: number) { }

  start() {
    this.startSignalingServer();
  }
  // SERVER
  private startSignalingServer() {
    Deno.serve({ hostname: "0.0.0.0", port: this.port }, (req) => {
      if (req.headers.get("upgrade") != "websocket") {
        return new Response(null, { status: 501 });
      }

      console.log("Upgrading connection to WebSocket...");
      const { socket, response } = Deno.upgradeWebSocket(req);
      
      // Add a unique ID to each client for better logging
      const clientId = crypto.randomUUID().substring(0, 8);
      console.log(`New WebSocket connection (${clientId}) - waiting for open event`);

      socket.addEventListener("open", () => {
        console.log(`WebSocket (${clientId}) opened`);
        this.clients.set(socket, { id: clientId });
        console.log(`Total connected clients: ${this.clients.size}`);
      });

      socket.addEventListener("close", (event) => {
        console.log(`WebSocket (${clientId}) closed with code ${event.code}, reason: ${event.reason}`);
        this.clients.delete(socket);
        console.log(`Total connected clients: ${this.clients.size}`);
      });

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`WebSocket (${clientId}) received message:`, data);
          
          this.handleWebSocketMessage(socket, data);
        } catch (error) {
          console.error(`WebSocket (${clientId}) error parsing message:`, error);
        }
      });

      socket.addEventListener("error", (event) => {
        console.error(`WebSocket (${clientId}) error:`, event);
      });

      return response;
    });
    console.log(`Signaling server is running on ws://localhost:${this.port}`);
  }

  private handleWebSocketMessage = (socket: WebSocket, message: unknown) => {
    console.log(`Broadcasting message to all clients (${this.clients.size} total)`);
    this.broadcastMessage(socket, message);
  };

  private broadcastMessage = (senderSocket: WebSocket, message: unknown) => {
    let sentCount = 0;
    
    this.clients.forEach((client, socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(message));
          sentCount++;
          console.log(`Message sent to client ${client.id}`);
        } catch (error) {
          console.error(`Error sending message to client ${client.id}:`, error);
        }
      } else {
        console.log(`Client ${client.id} not ready (state: ${socket.readyState})`);
      }
    });
    
    console.log(`Message broadcast complete. Sent to ${sentCount}/${this.clients.size} clients`);
  };
}

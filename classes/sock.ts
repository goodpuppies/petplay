

// Interface for the object controlling a specific WebSocket server instance
interface WebSocketServerController {
  /** Sends data to all connected clients on this server. */ // <-- Renamed from broadcast
  send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void;
  /** Closes all client connections and shuts down the server. */
  shutdown: () => Promise<void>;
  /** Returns a Set of currently connected client WebSockets (cleaned). */
  getClients: () => Set<WebSocket>;
  /** Checks if there are any clients currently connected and ready. */
  hasClients: () => boolean;
  /** Handler called when a new client connects. */
  onconnect: ((socket: WebSocket) => void) | null;
  /** Handler called when a client disconnects. */
  ondisconnect: ((socket: WebSocket, event: CloseEvent) => void) | null;
  /** Handler called when a message is received from any client. */
  onmessage: ((socket: WebSocket, event: MessageEvent) => void) | null;
  /** Handler called when an error occurs with a client connection. */
  onerror: ((socket: WebSocket | null, event: Event | ErrorEvent) => void) | null; // socket might be null for server errors
}

/**
 * Creates and starts a WebSocket server on the specified port.
 * Manages multiple client connections independently for this server instance.
 * @param port The port number to listen on.
 * @param options Optional Deno.ServeInit options (excluding port).
 * @returns A WebSocketServerController to manage the server and its clients.
 */
function createWebSocketServer(port: number, options?: Omit<Deno.ServeInit, "port">): WebSocketServerController {
  const clients = new Set<WebSocket>(); // Manages all clients for this server instance
  let server: Deno.HttpServer<Deno.NetAddr> | null = null;

  const controller: WebSocketServerController = {
    // Method renamed from 'broadcast' to 'send'
    send: (data) => {
      let count = 0;
      // Get the cleaned set of clients before iterating
      const currentClients = controller.getClients();
      currentClients.forEach((socket) => {
        // Double-check readyState although getClients should filter somewhat
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(data);
            count++;
          } catch (e) {
            console.error(`Error sending to client: ${e}. Removing client.`);
            try { socket.close(1011, "Send error"); } catch (_) { /* Ignore close errors */ }
            // Ensure removal from the main set as well
            clients.delete(socket);
          }
        }
      });
      // console.log(`Sent message to ${count} clients on port ${port}.`);
    },
    shutdown: async () => {
      console.log(`Shutting down WebSocket server on port ${port}...`);
      // Use getClients() internally to ensure we close cleaned list
      const currentClients = controller.getClients();
      currentClients.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1001, "Server shutting down");
        }
      });
      clients.clear(); // Clear the main set
      if (server) {
        await server.shutdown();
        server = null;
        console.log(`WebSocket server on port ${port} shut down.`);
      }
    },
    getClients: () => {
      // Clean up closed/closing sockets before returning the set
      clients.forEach(socket => {
        if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
          clients.delete(socket);
        }
      });
      return new Set(clients); // Return a copy of the cleaned set
    },
    hasClients: () => {
      // Use getClients to ensure the check is against the cleaned set
      return controller.getClients().size > 0;
    },
    onconnect: null,
    ondisconnect: null,
    onmessage: null,
    onerror: null,
  };

  console.log(`Starting WebSocket server on port ${port}...`);
  try {
    server = Deno.serve({ ...options, port,
      onError: (error) => {
        console.error(`Server error on port ${port}:`, error);
        if(controller.onerror) {
          try { controller.onerror(null, new ErrorEvent("error", { error })); } catch(e) { console.error("Error in server onerror handler:", e); }
        }
        return new Response("Internal Server Error", { status: 500 });
      }
    }, (req) => {
      if (req.headers.get("upgrade") != "websocket") {
        return new Response(null, { status: 501 });
      }

      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.addEventListener("open", (_event) => {
        clients.add(socket);
        if (controller.onconnect) {
          try { controller.onconnect(socket); } catch (e) { console.error("Error in onconnect handler:", e); }
        }
      });

      socket.addEventListener("message", (event) => {
        if (controller.onmessage) {
          try { controller.onmessage(socket, event); } catch (e) { console.error("Error in onmessage handler:", e); }
        } else {
          if (event.data === "ping") {
            socket.send("pong");
          }
        }
      });

      socket.addEventListener("close", (event) => {
        const deleted = clients.delete(socket);
        if (deleted && controller.ondisconnect) {
          try { controller.ondisconnect(socket, event); } catch (e) { console.error("Error in ondisconnect handler:", e); }
        }
      });

      socket.addEventListener("error", (event) => {
        console.error(`WebSocket error on port ${port} for a client:`, event instanceof ErrorEvent ? event.error : event);
        if (controller.onerror) {
          try { controller.onerror(socket, event); } catch (e) { console.error("Error in onerror handler:", e); }
        }
        // Ensure cleanup even if close event doesn't fire
        const deleted = clients.delete(socket);
        if (deleted && controller.ondisconnect && event instanceof ErrorEvent) {
          const closeEvent = new CloseEvent("close", { code: 1011, reason: `WebSocket error: ${event.message}`, wasClean: false });
          try { controller.ondisconnect(socket, closeEvent); } catch (e) { console.error("Error in ondisconnect handler after error:", e); }
        }
        if (socket.readyState !== WebSocket.CLOSED) {
          try { socket.close(1011, "WebSocket error"); } catch (_) { /* Ignore */ }
        }
      });

      return response;
    });
  } catch (e) {
    console.error(`Failed to start server on port ${port}:`, e);
    throw e;
  }

  return controller;
}

// Example of how to use the function:
/*
const state: {
  socket1?: WebSocketServerController;
  socket2?: WebSocketServerController;
} = {};

try {
  state.socket1 = createWebSocketServer(8080);
  state.socket2 = createWebSocketServer(8081);

  console.log("Servers created.");

  // Example: Imperative style - check and send periodically
  setInterval(() => {
    // Use hasClients() as the check and send() to send to all
    if (state.socket1?.hasClients()) {
      console.log(`[Server 8080] Sending time to ${state.socket1.getClients().size} clients...`);
      state.socket1.send(`Server 8080 time: ${new Date().toLocaleTimeString()}`); // <-- Use send()
    } else {
      // console.log("[Server 8080] No clients connected, skipping send.");
    }

    // Example: Send to individual clients on server 2 (still requires getClients)
    if (state.socket2?.hasClients()) {
      const clients2 = state.socket2.getClients();
      console.log(`[Server 8081] Sending individual pings to ${clients2.size} clients...`);
      clients2.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send("ping_from_server_8081");
          } catch (e) {
            console.error("[Server 8081] Failed to send ping to a client:", e);
          }
        }
      });
    }

  }, 5000);

  // --- Event handlers remain useful for reacting to specific events ---
  state.socket1.onconnect = (socket) => {
    console.log(`[Server 8080] Event: Client connected! Total clients: ${state.socket1?.getClients().size}`);
    socket.send("Welcome to server 8080!");
    // You can still use send() here to notify others
    state.socket1?.send("A new client joined server 8080.");
  };

  state.socket1.onmessage = (socket, event) => {
    console.log(`[Server 8080] Event: Message from client: ${event.data}`);
    // Echo back to all clients on this server
    state.socket1?.send(`[Server 8080] Client says: ${event.data}`);
  };

  state.socket1.ondisconnect = (socket, event) => {
    console.log(`[Server 8080] Event: Client disconnected. Code: ${event.code}. Total clients: ${state.socket1?.getClients().size}`);
    // Notify remaining clients
    state.socket1?.send("A client left server 8080.");
  };

} catch (error) {
  console.error("Failed to initialize servers:", error);
}
*/

// Remember to export the function if it's in a module:
export { createWebSocketServer };
export type { WebSocketServerController }; // Export the type too
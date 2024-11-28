import { Iroh } from "@number0/iroh";
import { Buffer } from "node:buffer";

const clients = new Set<WebSocket>();

await Deno.serve({
    port: 8000,
    handler: (req) => {
        if (req.headers.get("upgrade") !== "websocket") {
            return new Response("WebSocket Required", { status: 426 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        const broadcast = (message: string, exclude: WebSocket) => {
            for (const client of clients) {
                if (client !== exclude && client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            }
        };

        socket.addEventListener("open", () => {
            clients.add(socket);
            console.log(`Client connected. Total clients: ${clients.size}`);
        });

        socket.addEventListener("message", (event) => {
            try {
                const announcement = JSON.parse(event.data);
                if (!announcement.irohId || !announcement.topics) {
                    socket.send(JSON.stringify({
                        error: "Invalid message format. Requires irohId and topics."
                    }));
                    return;
                }
                broadcast(event.data, socket);
            } catch (e) {
                console.error("Invalid message:", e);
            }
        });

        socket.addEventListener("close", () => {
            clients.delete(socket);
        });

        return response;
    }
}).finished;
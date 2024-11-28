import { Iroh } from "@number0/iroh";
import { Buffer } from "node:buffer";

//#region server
const clients = new Set<WebSocket>();

const server = Deno.serve({
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
});
//#endregion

//#region test_clients
async function runTest() {
    const TOPIC_PROTOCOL_STR = "test-topic/0";
    const JSON_PROTOCOL_STR = "json-test/0";
    const TOPIC_PROTOCOL = Buffer.from(TOPIC_PROTOCOL_STR);
    const JSON_PROTOCOL = Buffer.from(JSON_PROTOCOL_STR);

    const protocols = {
        [TOPIC_PROTOCOL_STR]: (_err: unknown, _ep: unknown, client: any) => ({
            accept: async (err: unknown, connecting: any) => {
                if (err) return;
                const conn = await connecting.connect();
                const remote = await conn.getRemoteNodeId();
                console.log(`Direct connection established with ${remote}`);

                const bi = await conn.acceptBi();
                const bytes = await bi.recv.readToEnd(64);
                console.log(`Node received: ${bytes.toString()} from ${remote}`);

                await bi.send.writeAll(Buffer.from("connected"));
                await bi.send.finish();
                await bi.send.stopped();
            }
        }),
        [JSON_PROTOCOL_STR]: (_err: unknown, _ep: unknown, client: any) => ({
            accept: async (err: unknown, connecting: any) => {
                if (err) return;
                const conn = await connecting.connect();
                const remote = await conn.getRemoteNodeId();
                console.log(`JSON connection established with ${remote}`);

                const bi = await conn.acceptBi();
                const bytes = await bi.recv.readToEnd(1024);
                const jsonData = JSON.parse(bytes.toString());
                console.log(`Node received JSON:`, jsonData, `from ${remote}`);

                const response = {
                    status: "success",
                    receivedAt: new Date().toISOString(),
                    echo: jsonData
                };

                await bi.send.writeAll(Buffer.from(JSON.stringify(response)));
                await bi.send.finish();
                await bi.send.stopped();
            }
        })
    };

    // Create 5 nodes - first 3 in topic1, last 2 in topic2
    const nodes = await Promise.all([
        Iroh.memory({ protocols }), // topic1
        Iroh.memory({ protocols }), // topic1
        Iroh.memory({ protocols }), // topic1
        Iroh.memory({ protocols }), // topic2
        Iroh.memory({ protocols }), // topic2
    ]);

    const nodeAddrs = await Promise.all(nodes.map(n => n.net.nodeAddr()));
    console.log("Created nodes:", nodeAddrs.map(a => a.nodeId));

    // Track connections to verify network topology
    const connections = new Map<string, Set<string>>();
    let connectionCount = 0;
    let jsonTestsCompleted = 0;

    const createClient = (index: number, topic: string) => {
        const client = new WebSocket("ws://localhost:8000");
        const nodeId = nodeAddrs[index].nodeId;

        connections.set(nodeId, new Set());

        client.onopen = () => {
            console.log(`Node ${index} connected to WS server with topic: ${topic}`);
            client.send(JSON.stringify({
                irohId: nodeId,
                topics: [topic],
                addr: nodeAddrs[index]
            }));
        };

        client.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            if (msg.irohId === nodeId) return;

            // Only connect if same topic
            if (!msg.topics.includes(topic)) return;

            console.log(`Node ${index} discovered peer ${msg.irohId} in topic: ${topic}`);

            const endpoint = nodes[index].node.endpoint();
            if (!endpoint) throw new Error("No endpoint");

            try {
                if (!connections.get(nodeId)!.has(msg.irohId)) {
                    // First establish the basic connection
                    const conn = await endpoint.connect(msg.addr, TOPIC_PROTOCOL);

                    const bi = await conn.openBi();
                    await bi.send.writeAll(Buffer.from(`hello from ${nodeId}`));
                    await bi.send.finish();
                    await bi.send.stopped();

                    const response = await bi.recv.readToEnd(64);
                    if (response.toString() === "connected") {
                        connections.get(nodeId)!.add(msg.irohId);
                        connectionCount++;
                        console.log(`Connection established ${nodeId} -> ${msg.irohId}`);

                        // Now test JSON protocol
                        const jsonConn = await endpoint.connect(msg.addr, JSON_PROTOCOL);
                        const jsonBi = await jsonConn.openBi();

                        const testData = {
                            sender: nodeId,
                            timestamp: new Date().toISOString(),
                            testMessage: "Hello JSON world!",
                            numericalData: 42
                        };

                        await jsonBi.send.writeAll(Buffer.from(JSON.stringify(testData)));
                        await jsonBi.send.finish();

                        const jsonResponse = await jsonBi.recv.readToEnd(1024);
                        const parsedResponse = JSON.parse(jsonResponse.toString());
                        console.log(`JSON test completed ${nodeId} -> ${msg.irohId}:`, parsedResponse);

                        await jsonBi.send.stopped();
                        jsonTestsCompleted++;

                        checkNetworkComplete();
                    }
                }
            } catch (e) {
                console.error(`Connection failed from ${nodeId} to ${msg.irohId}:`, e);
            }
        };

        return client;
    };

    function checkNetworkComplete() {
        // Expected: 
        // topic1: 3 nodes = 6 connections (each node connects to 2 others)
        // topic2: 2 nodes = 2 connections (nodes connect to each other)
        // Total: 8 connections and 8 JSON tests
        if (connectionCount >= 8 && jsonTestsCompleted >= 8) {
            console.log("\n✅ Network topology verification:");
            for (const [nodeId, peers] of connections) {
                console.log(`Node ${nodeId} connected to:`, Array.from(peers));
            }

            // Clean shutdown
            Promise.all(nodes.map(n => n.node.shutdown(false)))
                .then(() => Deno.exit(0));
        }
    }

    // Create clients - 3 in topic1, 2 in topic2
    const clients = [
        createClient(0, "topic1"),
        createClient(1, "topic1"),
        createClient(2, "topic1"),
        createClient(3, "topic2"),
        createClient(4, "topic2")
    ];
}
//#endregion

console.log("Starting test...");
runTest().catch(console.error);
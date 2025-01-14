import { stat } from "node:fs";
import { TypedActorFunctions, GenericMessage, BaseState, Message, ToAddress, worker, type GenericActorFunctions, type Topic, PairAddress } from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { Iroh, Doc } from "@number0/iroh";
import { Buffer } from "node:buffer";

// For testing, we'll create a shared map of iroh nodes
const TEST_MODE = true;
//#region state
type State = {
    irohNodes: Map<string, any>; // actorId -> irohNode
    topic?: string;
    connections: Map<string, any>; // actorId -> connection
    topicPeers: Map<string, Set<string>>; // topic -> Set<actorId>
    IDTopics: Map<string, string>; // actorId -> topic
    IDNoderaddrs: Map<string, string>; // actorId -> nodeAddr
    addressBook: Set<string>; // actorId
    pendingTopicSets: Map<string, Topic>; // actorId -> topic
    idtodoc: Map<string, Doc>; // actorId -> doc
    petplayServer: null | WebSocket;
    actordocs: Map<string, string>; // actorId -> doc
    [key: string]: unknown;
};

const state: State & BaseState = {
    name: "Iroh",
    id: "",
    addressBook: new Set(),
    irohNodes: new Map(),
    IDNoderaddrs: new Map(),
    connections: new Map(), // Base connections
    topicPeers: new Map(),
    IDTopics: new Map(),
    actordocs: new Map(),
    idtodoc: new Map(),
    pendingTopicSets: new Map<string, Topic>(),
    petplayServer: null
};
//#endregion

const PROTOCOL_STR = "actor-mesh/0";
const PROTOCOL = Buffer.from(PROTOCOL_STR);

export const functions = {
    ADDCONTACT: async (payload: ToAddress) => {
        CustomLogger.log("iroh", "ADDCONTACT start for", payload);
        state.addressBook.add(payload);
        CustomLogger.log("iroh", "Added contact", payload);
        CustomLogger.log("iroh", "Current addressbook:", Array.from(state.addressBook));

        if (TEST_MODE) {

            CustomLogger.log("iroh", "Creating Iroh node for", payload);
            const node = await initIroh();
            state.irohNodes.set(payload, node);

            CustomLogger.log("iroh", `Created Iroh node for ${payload}`);
            CustomLogger.log("iroh", "Current irohNodes:", Array.from(state.irohNodes.keys()));

            // Explicitly check and handle pending topic
            const pendingTopic = state.pendingTopicSets.get(payload);
            if (pendingTopic) {

                CustomLogger.log("iroh", "Found pending topic", pendingTopic, "for", payload);
                state.pendingTopicSets.delete(payload);
                // Create a fake message address for setTopic
                const fakeAddress = {
                    fm: payload,
                    to: state.id
                };
                // Call SET_TOPIC again now that we have the node
                await functions.SET_TOPIC(pendingTopic, fakeAddress);
            } else {

                CustomLogger.log("iroh", "No pending topic for", payload);
            }
        }
    },
    SET_TOPIC: (payload: Topic, address: PairAddress) => {
        CustomLogger.log("iroh", "SET_TOPIC called for", address.fm, "with topic", payload);

        const irohNode = state.irohNodes.get(address.fm);
        if (!irohNode) {

            CustomLogger.log("iroh", "No Iroh node yet, storing pending SET_TOPIC for", address.fm);
            state.pendingTopicSets.set(address.fm, payload);
            return;
        }


        CustomLogger.log("iroh", "Found irohNode for", address.fm, "proceeding with topic setup");
        const ws = new WebSocket("ws://localhost:8000");

        CustomLogger.log("iroh", "WebSocket created for", address.fm);

        ws.onopen = async () => {
            try {

                CustomLogger.log("iroh", "WebSocket opened for", address.fm);
                const nodeAddr = await irohNode.net.nodeAddr();

                //CustomLogger.log("iroh", "Got node address:", nodeAddr.nodeId);

                const announcement = {
                    irohId: nodeAddr.nodeId,
                    topics: [payload],
                    addr: nodeAddr,
                    actorId: address.fm
                };
                state.IDTopics.set(address.fm, payload)
                state.IDNoderaddrs.set(address.fm, nodeAddr)

                //console.log("Sending announcement:", announcement);
                ws.send(JSON.stringify(announcement));
                state.petplayServer = ws
            } catch (err) {

                CustomLogger.log("iroh", "Failed to announce:", err);
            }
        };

        ws.onmessage = async (event) => {
            //console.log("WA");
            try {
                //console.log("Parsing message:", event.data);
                const msg = JSON.parse(event.data);
                //console.log("Parsed message:", msg);

                /* CustomLogger.log("iroh", "Comparing:", {
                    msgTopics: msg.topics,
                    payload,
                    msgActorId: msg.actorId,
                    ourActorId: address.fm
                }); */

                if (msg.topics.includes(payload) && msg.actorId !== address.fm) {
                    //console.log("Attempting to connect to peer:", msg.addr);
                    const result = await connectToPeer(msg.addr, irohNode, address.fm, msg.actorId);

                    CustomLogger.log("iroh", "Connection result:", result);
                    CustomLogger.log("iroh", "connection is between:", address.fm, " and ", msg.actorId);
                } else {

                    CustomLogger.log("iroh", "Skipping connection due to topic/id mismatch");
                }
            } catch (err) {

                CustomLogger.log("iroh", "Error in onmessage:", err);
            }
        };


    },
    SEND: async (payload: GenericMessage | boolean, address: PairAddress) => {
        //if (typeof payload === 'boolean') return false;

        const message = payload as GenericMessage;
        const sourceActor = address.fm;
        const targetId = message.address.to;
        const connectionKey = `${sourceActor}-${targetId}`;

        // Get the Iroh node for the sending actor
        const irohNode = state.irohNodes.get(sourceActor);
        if (!irohNode) {
            CustomLogger.log("iroh", "current actor has no iroh node", sourceActor);
            Postman.PostMessage({
                address: { fm: state.id, to: address.fm },
                type: "CB:SEND",
                payload: false
            })
            return
        }

        let conn = state.connections.get(connectionKey);
        if (!conn) {
            CustomLogger.log("iroh", `No connection found for ${sourceActor} to ${targetId}, attempting to establish...`);
            const targetAddr = state.IDNoderaddrs.get(targetId);
            if (!targetAddr) {
                CustomLogger.log("iroh", `No node address found for target ${targetId}`);
                Postman.PostMessage({
                    address: { fm: state.id, to: address.fm },
                    type: "CB:SEND",
                    payload: false
                })
                return
            }

            try {
                conn = await connectToPeer(targetAddr, irohNode, sourceActor, targetId as ToAddress);
                if (!conn) {
                    CustomLogger.log("iroh", `Failed to establish connection to ${targetId}`);
                    Postman.PostMessage({
                        address: { fm: state.id, to: address.fm },
                        type: "CB:SEND",
                        payload: false
                    })
                    return
                }
            } catch (err) {
                CustomLogger.log("iroh", "Failed to establish connection:", err);
                Postman.PostMessage({
                    address: { fm: state.id, to: address.fm },
                    type: "CB:SEND",
                    payload: false
                })
                return
            }
        }

        try {
            // Create a new bi-directional stream for each message
            CustomLogger.log("iroh", "Opening new bi-directional stream");
            const bi = await conn.openBi();

            CustomLogger.log("iroh", "Sending message from", sourceActor, "to", targetId);

            // Send the message
            await bi.send.writeAll(Buffer.from(JSON.stringify(message)));
            await bi.send.finish();

            // Wait for acknowledgment
            const response = await bi.recv.readToEnd(64);
            if (response.toString() === "received") {
                CustomLogger.log("iroh", "Message successfully delivered and acknowledged");
            }

            // Close only the bi-directional stream, keep the base connection
            await bi.send.stopped();

            Postman.PostMessage({
                address: { fm: state.id, to: address.fm },
                type: "CB:SEND",
                payload: true
            })
        } catch (e) {
            CustomLogger.log("iroh", "Failed to send:", e);
            // If the base connection is dead, remove it and try to reconnect next time
            if ((e as Error).message?.includes("connection lost")) {
                CustomLogger.log("iroh", "Connection lost, removing from state");
                state.connections.delete(connectionKey);
            }
            Postman.PostMessage({
                address: { fm: state.id, to: address.fm },
                type: "CB:SEND",
                payload: false
            })
        }
    },
    CREATEDOC: async (payload: null, address: PairAddress) => {
        if (!state.petplayServer) throw new Error("Petplay server not initialized yet!");

        const topic = state.IDTopics.get(address.fm)
        const nodeAddr = state.IDNoderaddrs.get(address.fm)
        const node = state.irohNodes.get(address.fm)
        const doc = await node.docs.create()
        console.log(`created doc: ${doc.id()}`)
        const announcement = {
            irohId: doc.id(),
            topics: [topic],
            addr: nodeAddr,
            actorId: address.fm
        };

        state.petplayServer.send(JSON.stringify(announcement));
        console.log("doc announced!", announcement)
        state.actordocs.set(address.fm, doc.id())
        state.idtodoc.set(doc.id(), doc)

        Postman.PostMessage({
            address: { fm: state.id, to: address.fm },
            type: "CB:CREATEDOC",
            payload: doc.id(),
        })
    }
} as const;

async function initIroh() {
    const protocols = {
        [PROTOCOL_STR]: (_err: unknown, _ep: unknown, client: any) => ({
            accept: async (err: unknown, connecting: any) => {
                if (err) return;
                const conn = await connecting.connect();
                const remote = await conn.getRemoteNodeId();

                // Find which actor owns this node
                const nodeId = await client.net.nodeId();
                let ownerActorId = "unknown";
                for (const [actorId, node] of state.irohNodes.entries()) {
                    const currentNodeId = await node.net.nodeId();
                    if (currentNodeId === nodeId) {
                        ownerActorId = actorId;
                        break;
                    }
                }

                CustomLogger.log("iroh", `Node ${nodeId} (owned by actor ${ownerActorId}) receiving messages from ${remote}`);

                // Continuously accept messages on this connection
                while (true) {
                    try {
                        const bi = await conn.acceptBi();
                        const bytes = await bi.recv.readToEnd(1024 * 1024);
                        const message = JSON.parse(bytes.toString());

                        CustomLogger.log("iroh", `Node ${nodeId} (owned by actor ${ownerActorId}) sending message to actorsystem ${message}`);

                        // Enhanced logging with node identity
                        CustomLogger.log("iroh", "Message received:", {
                            receivingNode: nodeId,
                            receivingActor: ownerActorId,
                            message: {
                                from: message.address.fm,
                                to: message.address.to,
                                type: message.type,
                                payload: message.payload
                            }
                        });

                        // Send acknowledgment
                        await bi.send.writeAll(Buffer.from("received"));
                        await bi.send.finish();
                        await bi.send.stopped();

                        // Run the message through Postman
                        Postman.PostMessage(message);
                        Postman.runFunctions(message);
                    } catch (e) {
                        if ((e as Error).message?.includes('connection lost')) {
                            CustomLogger.log("iroh", `Connection lost with ${remote} for node ${nodeId} (actor ${ownerActorId})`);
                            break;
                        }
                        CustomLogger.log("iroh", `Error in message handler for node ${nodeId} (actor ${ownerActorId}):`, e);
                    }
                }
            }
        })
    };

    const node = await Iroh.memory({ protocols, enableDocs: true });
    const nodeId = await node.net.nodeId();
    //CustomLogger.log("iroh", `New Iroh node started with ID ${nodeId}`);
    return node;
}


async function connectToPeer(peerAddr: any, irohNode: any, actorId: string, remote: ToAddress) {
    try {

        console.log("Connecting to peer:", peerAddr,"Iroh node:", irohNode, "Actor ID:", actorId, "Remote:", remote);
        const endpoint = irohNode.node.endpoint();
        const conn = await endpoint.connect(peerAddr, PROTOCOL);
        const _remote = await conn.getRemoteNodeId();

        // Store only the base connection
        const connectionKey = `${actorId}-${remote}`;
        state.connections.set(connectionKey, conn);

        CustomLogger.log("iroh", "Connected to peer:", remote, "for actor:", actorId);
        CustomLogger.log("iroh", "Base connection established");

        return conn;
    } catch (err) {
        CustomLogger.log("iroh", "Failed to connect:", err);
    }
}


new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
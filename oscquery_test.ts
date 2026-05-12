#!/usr/bin/env -S deno run --allow-net --allow-read --allow-sys

/**
 * OSCQuery Test Script
 *
 * This script implements an OSCQuery server that advertises itself to VRChat
 * and receives OSC data for /tracking/vrsystem/{head,leftwrist,rightwrist}/pose.
 *
 * Based on VRChat's OSCQuery implementation, the application needs to:
 * 1. Advertise its OSC and OSCQuery services via mDNS/Zeroconf
 * 2. Serve an address tree that includes /tracking/vrsystem
 * 3. Listen for OSC messages from VRChat
 */

interface OSCQueryNode {
  FULL_PATH: string;
  ACCESS?: number;
  TYPE?: string;
  VALUE?: any[];
  RANGE?: any[];
  DESCRIPTION?: string;
  CONTENTS?: { [key: string]: OSCQueryNode };
  TAGS?: string[];
  EXTENDED_TYPE?: string[];
  UNIT?: string[];
  CRITICAL?: boolean;
  CLIPMODE?: string[];
}

interface OSCQueryHostInfo {
  NAME?: string;
  EXTENSIONS?: { [key: string]: boolean };
  OSC_IP?: string;
  OSC_PORT?: number;
  OSC_TRANSPORT?: string;
  WS_IP?: string;
  WS_PORT?: number;
}

interface OSCMessage {
  address: string;
  args: any[];
}

class MDNSAdvertiser {
  private static readonly MDNS_ADDRESS = "224.0.0.251";
  private static readonly MDNS_PORT = 5353;
  private static readonly TTL_SECONDS = 120;
  private static readonly REBROADCAST_MS = 5_000;

  private socket: ReturnType<typeof Deno.listenDatagram> | null = null;
  private stopped = false;
  private readonly lastQueryLogByRemote = new Map<string, number>();
  private readonly instanceName: string;
  private readonly hostName: string;

  constructor(
    serviceName: string,
    private readonly ip: string,
    private readonly oscQueryPort: number,
    _oscPort: number,
  ) {
    this.instanceName = this.sanitizeLabel(serviceName);
    this.hostName = `${this.instanceName}.oscjson.tcp`;
  }

  async start(): Promise<void> {
    this.socket = Deno.listenDatagram({
      hostname: "0.0.0.0",
      port: MDNSAdvertiser.MDNS_PORT,
      transport: "udp",
      reuseAddress: true,
    });

    this.socket.joinMulticastV4(MDNSAdvertiser.MDNS_ADDRESS, "0.0.0.0");
    console.log(
      `mDNS advertising ${this.instanceName} as _oscjson._tcp:${this.oscQueryPort}`,
    );

    await this.announce();
    this.receiveLoop();
    this.announcementLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.socket) {
      return;
    }

    await this.sendResponse(0);
    this.socket.close();
    this.socket = null;
  }

  private receiveLoop(): void {
    const run = async () => {
      while (!this.stopped && this.socket) {
        try {
          const [data, remote] = await this.socket.receive();
          const question = this.matchingQuestion(data);
          if (question && remote.transport === "udp") {
            this.logDiscoveryQuery(remote, question);
            await this.sendResponse(MDNSAdvertiser.TTL_SECONDS, remote);
          }
        } catch (error) {
          if (!this.stopped) {
            console.error("mDNS receive error:", error);
          }
        }
      }
    };

    run();
  }

  private announcementLoop(): void {
    const run = async () => {
      while (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, MDNSAdvertiser.REBROADCAST_MS));
        if (!this.stopped) {
          await this.announce();
        }
      }
    };

    run();
  }

  private async announce(): Promise<void> {
    await this.sendResponse(MDNSAdvertiser.TTL_SECONDS);
    await this.broadcastOnExternalInterfaces();
  }

  private async sendResponse(ttl: number, remote?: Deno.NetAddr): Promise<void> {
    if (!this.socket) {
      return;
    }

    const packet = this.buildResponsePacket(ttl);
    const target = remote ?? {
      hostname: MDNSAdvertiser.MDNS_ADDRESS,
      port: MDNSAdvertiser.MDNS_PORT,
      transport: "udp" as const,
    };
    await this.socket.send(packet, target);
  }

  private async broadcastOnExternalInterfaces(): Promise<void> {
    const addresses = Deno.networkInterfaces()
      .filter((networkInterface) => networkInterface.family === "IPv4")
      .map((networkInterface) => networkInterface.address)
      .filter((address) => address !== "127.0.0.1" && !address.startsWith("169.254."));

    if (addresses.length === 0) {
      console.log("[DISCOVERY] mDNS broadcast skipped: no external IPv4 interfaces");
      return;
    }

    await Promise.all(addresses.map((address) => this.broadcastOnInterface(address)));
  }

  private async broadcastOnInterface(address: string): Promise<void> {
    let socket: ReturnType<typeof Deno.listenDatagram> | null = null;
    try {
      try {
        socket = Deno.listenDatagram({
          hostname: address,
          port: MDNSAdvertiser.MDNS_PORT,
          transport: "udp",
          reuseAddress: true,
        });
      } catch {
        socket = Deno.listenDatagram({
          hostname: address,
          port: 0,
          transport: "udp",
        });
      }

      await socket.send(this.buildResponsePacket(MDNSAdvertiser.TTL_SECONDS), {
        hostname: MDNSAdvertiser.MDNS_ADDRESS,
        port: MDNSAdvertiser.MDNS_PORT,
        transport: "udp",
      });
      console.log(
        `[DISCOVERY] mDNS broadcast from ${address}: ${this.instanceName}._oscjson._tcp.local -> 127.0.0.1:${this.oscQueryPort}`,
      );
    } catch (error) {
      console.error(
        `[DISCOVERY] mDNS broadcast failed on ${address}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      socket?.close();
    }
  }

  private matchingQuestion(data: Uint8Array): string | null {
    if (data.length < 12) {
      return null;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const questionCount = view.getUint16(4, false);
    let offset = 12;

    for (let i = 0; i < questionCount; i++) {
      const parsed = this.readName(data, offset);
      if (!parsed) {
        return null;
      }
      offset = parsed.offset + 4; // qtype + qclass

      if (
        parsed.name === "_oscjson._tcp.local" ||
        parsed.name === `${this.instanceName}._oscjson._tcp.local` ||
        parsed.name === this.hostName
      ) {
        return parsed.name;
      }
    }

    return null;
  }

  private logDiscoveryQuery(remote: Deno.NetAddr, question: string): void {
    const now = Date.now();
    const remoteKey = `${remote.hostname}:${remote.port}:${question}`;
    const lastLog = this.lastQueryLogByRemote.get(remoteKey) ?? 0;

    if (now - lastLog < 5_000) {
      return;
    }

    this.lastQueryLogByRemote.set(remoteKey, now);
    console.log(
      `[DISCOVERY] mDNS query from ${remote.hostname}:${remote.port} for ${question}; advertising ${this.instanceName}`,
    );
  }

  private buildResponsePacket(ttl: number): Uint8Array {
    const answers = [
      this.ptrRecord("_oscjson._tcp.local", `${this.instanceName}._oscjson._tcp.local`, ttl),
    ];
    const additionals = [
      this.srvRecord(`${this.instanceName}._oscjson._tcp.local`, this.oscQueryPort, ttl),
      this.txtRecord(`${this.instanceName}._oscjson._tcp.local`, ttl),
      this.aRecord(this.hostName, this.ip, ttl),
    ];
    const records = [...answers, ...additionals];

    const packet = new Uint8Array(12 + records.reduce((sum, record) => sum + record.length, 0));
    const view = new DataView(packet.buffer);
    view.setUint16(2, 0x8400, false); // response + authoritative answer
    view.setUint16(6, answers.length, false);
    view.setUint16(10, additionals.length, false);

    let offset = 12;
    for (const record of records) {
      packet.set(record, offset);
      offset += record.length;
    }

    return packet;
  }

  private ptrRecord(name: string, value: string, ttl: number): Uint8Array {
    return this.record(name, 12, ttl, this.encodeName(value), false);
  }

  private srvRecord(name: string, port: number, ttl: number): Uint8Array {
    const target = this.encodeName(this.hostName);
    const rdata = new Uint8Array(6 + target.length);
    const view = new DataView(rdata.buffer);
    view.setUint16(4, port, false);
    rdata.set(target, 6);
    return this.record(name, 33, ttl, rdata);
  }

  private txtRecord(name: string, ttl: number): Uint8Array {
    const txtVersion = new TextEncoder().encode("txtvers=1");
    return this.record(name, 16, ttl, new Uint8Array([txtVersion.length, ...txtVersion]));
  }

  private aRecord(name: string, ip: string, ttl: number): Uint8Array {
    return this.record(name, 1, ttl, new Uint8Array(ip.split(".").map((part) => Number(part))));
  }

  private record(
    name: string,
    type: number,
    ttl: number,
    rdata: Uint8Array,
    flush = true,
  ): Uint8Array {
    const encodedName = this.encodeName(name);
    const record = new Uint8Array(encodedName.length + 10 + rdata.length);
    record.set(encodedName, 0);

    const view = new DataView(record.buffer);
    const headerOffset = encodedName.length;
    view.setUint16(headerOffset, type, false);
    view.setUint16(headerOffset + 2, flush ? 0x8001 : 0x0001, false); // cache-flush + IN
    view.setUint32(headerOffset + 4, ttl, false);
    view.setUint16(headerOffset + 8, rdata.length, false);
    record.set(rdata, headerOffset + 10);

    return record;
  }

  private encodeName(name: string): Uint8Array {
    const encoder = new TextEncoder();
    const parts: number[] = [];
    for (const label of name.split(".")) {
      const encoded = encoder.encode(label);
      parts.push(encoded.length, ...encoded);
    }
    parts.push(0);
    return new Uint8Array(parts);
  }

  private readName(data: Uint8Array, startOffset: number): { name: string; offset: number } | null {
    const labels: string[] = [];
    let offset = startOffset;
    let jumped = false;
    let nextOffset = startOffset;
    const decoder = new TextDecoder();

    for (let i = 0; i < 32; i++) {
      if (offset >= data.length) {
        return null;
      }

      const length = data[offset];
      if (length === 0) {
        if (!jumped) {
          nextOffset = offset + 1;
        }
        return { name: labels.join("."), offset: nextOffset };
      }

      if ((length & 0xc0) === 0xc0) {
        if (offset + 1 >= data.length) {
          return null;
        }
        const pointer = ((length & 0x3f) << 8) | data[offset + 1];
        if (!jumped) {
          nextOffset = offset + 2;
        }
        offset = pointer;
        jumped = true;
        continue;
      }

      const labelStart = offset + 1;
      const labelEnd = labelStart + length;
      if (labelEnd > data.length) {
        return null;
      }
      labels.push(decoder.decode(data.slice(labelStart, labelEnd)));
      offset = labelEnd;
    }

    return null;
  }

  private sanitizeLabel(label: string): string {
    return label.replaceAll(".", "-").replaceAll(" ", "-").slice(0, 63);
  }
}

class OSCQueryServer {
  private httpPort: number;
  private oscPort: number;
  private name: string;
  private server: Deno.HttpServer | null = null;
  private oscSocket: ReturnType<typeof Deno.listenDatagram> | null = null;
  private mdnsAdvertiser: MDNSAdvertiser | null = null;
  private addressTree: OSCQueryNode;
  private readonly lastHttpLogByRemote = new Map<string, number>();

  constructor(name: string, httpPort: number, oscPort: number) {
    this.name = name;
    this.httpPort = httpPort;
    this.oscPort = oscPort;
    this.addressTree = this.buildAddressTree();
  }

  private buildAddressTree(): OSCQueryNode {
    return {
      FULL_PATH: "/",
      DESCRIPTION: "OSCQuery Test Server for VRChat Tracking Data",
      ACCESS: 0,
      CONTENTS: {
        "tracking": {
          FULL_PATH: "/tracking",
          DESCRIPTION: "VRChat tracking system data",
          ACCESS: 0,
          CONTENTS: {
            "vrsystem": {
              FULL_PATH: "/tracking/vrsystem",
              DESCRIPTION: "VRChat VR system tracking data",
              ACCESS: 0,
              CONTENTS: {
                "head": {
                  FULL_PATH: "/tracking/vrsystem/head",
                  DESCRIPTION: "Head tracking data",
                  ACCESS: 0,
                  CONTENTS: {
                    "pose": {
                      FULL_PATH: "/tracking/vrsystem/head/pose",
                      DESCRIPTION: "Head pose as position xyz and euler rotation xyz",
                      ACCESS: 2,
                      TYPE: "ffffff",
                    },
                  },
                },
                "leftwrist": {
                  FULL_PATH: "/tracking/vrsystem/leftwrist",
                  DESCRIPTION: "Left wrist tracking data",
                  ACCESS: 0,
                  CONTENTS: {
                    "pose": {
                      FULL_PATH: "/tracking/vrsystem/leftwrist/pose",
                      DESCRIPTION: "Left wrist pose as position xyz and euler rotation xyz",
                      ACCESS: 2,
                      TYPE: "ffffff",
                    },
                  },
                },
                "rightwrist": {
                  FULL_PATH: "/tracking/vrsystem/rightwrist",
                  DESCRIPTION: "Right wrist tracking data",
                  ACCESS: 0,
                  CONTENTS: {
                    "pose": {
                      FULL_PATH: "/tracking/vrsystem/rightwrist/pose",
                      DESCRIPTION: "Right wrist pose as position xyz and euler rotation xyz",
                      ACCESS: 2,
                      TYPE: "ffffff",
                    },
                  },
                },
              },
            },
          },
        },
        "usercamera": {
          FULL_PATH: "/usercamera",
          DESCRIPTION: "VRChat user camera endpoints",
          ACCESS: 0,
          CONTENTS: {
            "Mode": {
              FULL_PATH: "/usercamera/Mode",
              DESCRIPTION: "Camera mode",
              ACCESS: 3,
              TYPE: "i",
            },
            "Pose": {
              FULL_PATH: "/usercamera/Pose",
              DESCRIPTION: "Camera pose as position xyz and euler rotation xyz",
              ACCESS: 3,
              TYPE: "ffffff",
            },
          },
        },
      },
    };
  }

  private getNode(path: string): OSCQueryNode | null {
    const parts = path.split("/").filter((p) => p.length > 0);
    let current: any = this.addressTree;

    for (const part of parts) {
      if (current.CONTENTS && current.CONTENTS[part]) {
        current = current.CONTENTS[part];
      } else {
        return null;
      }
    }

    return current;
  }

  private handleHttpRequest(req: Request, info?: Deno.ServeHandlerInfo): Response {
    const url = new URL(req.url);
    const path = url.pathname;
    const searchParams = url.searchParams;
    const remoteAddr = info?.remoteAddr.transport === "tcp"
      ? `${info.remoteAddr.hostname}:${info.remoteAddr.port}`
      : "unknown";

    this.logHttpDiscovery(remoteAddr, req.method, path, url.search);

    // Handle HOST_INFO query
    if (searchParams.has("HOST_INFO")) {
      const hostInfo: OSCQueryHostInfo = {
        NAME: this.name,
        EXTENSIONS: {
          "ACCESS": true,
          "VALUE": true,
          "RANGE": true,
          "DESCRIPTION": true,
          "TAGS": true,
        },
        OSC_IP: "127.0.0.1",
        OSC_PORT: this.oscPort,
        OSC_TRANSPORT: "UDP",
      };
      return new Response(JSON.stringify(hostInfo), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle VALUE query
    if (searchParams.has("VALUE")) {
      const node = this.getNode(path);
      if (!node) {
        return new Response(null, { status: 404 });
      }
      if (!node.VALUE) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ VALUE: node.VALUE }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle regular path query
    const node = this.getNode(path);
    if (!node) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(node), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async startHttpServer(): Promise<void> {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: this.httpPort },
      this.handleHttpRequest.bind(this),
    );
    console.log(`OSCQuery HTTP server listening on http://127.0.0.1:${this.httpPort}`);
  }

  private logHttpDiscovery(
    remoteAddr: string,
    method: string,
    path: string,
    search: string,
  ): void {
    const now = Date.now();
    const key = `${remoteAddr}:${method}:${path}${search}`;
    const lastLog = this.lastHttpLogByRemote.get(key) ?? 0;

    if (now - lastLog < 2_000) {
      return;
    }

    this.lastHttpLogByRemote.set(key, now);
    console.log(`[DISCOVERY] OSCQuery HTTP ${method} ${path}${search} from ${remoteAddr}`);
  }

  async startOSCReceiver(): Promise<void> {
    this.oscSocket = Deno.listenDatagram({
      port: this.oscPort,
      transport: "udp",
    });

    console.log(`OSC UDP receiver listening on port ${this.oscPort}`);
    console.log(`Waiting for VRChat to send tracking data...`);
    console.log(`Make sure VRChat has accepted the tracking legal notice!`);
  }

  async startAdvertising(): Promise<void> {
    this.mdnsAdvertiser = new MDNSAdvertiser(this.name, "127.0.0.1", this.httpPort, this.oscPort);
    await this.mdnsAdvertiser.start();
  }

  async receiveOSCMessages(
    callback: (message: OSCMessage, rawLength: number) => void,
  ): Promise<void> {
    if (!this.oscSocket) {
      throw new Error("OSC receiver not started");
    }

    while (true) {
      try {
        const [data, _remote] = await this.oscSocket.receive();

        // Parse OSC packet (basic parsing)
        const messages = this.parseOSCPacket(data);
        for (const message of messages) {
          callback(message, data.length);
        }
      } catch (error) {
        console.error("Error receiving OSC message:", error);
      }
    }
  }

  private parseOSCPacket(data: Uint8Array): OSCMessage[] {
    const bundleMessages = this.parseOSCBundle(data);
    if (bundleMessages) {
      return bundleMessages;
    }

    const message = this.parseOSCMessage(data);
    return message ? [message] : [];
  }

  private parseOSCBundle(data: Uint8Array): OSCMessage[] | null {
    const decoder = new TextDecoder();
    const bundleTag = decoder.decode(data.slice(0, 7));
    if (bundleTag !== "#bundle") {
      return null;
    }

    const messages: OSCMessage[] = [];
    let dataPos = 16; // "#bundle\0" + 8-byte NTP timetag

    while (dataPos + 4 <= data.length) {
      const sizeView = new DataView(data.buffer, data.byteOffset + dataPos, 4);
      const elementSize = sizeView.getInt32(0, false);
      dataPos += 4;

      if (elementSize <= 0 || dataPos + elementSize > data.length) {
        break;
      }

      messages.push(...this.parseOSCPacket(data.slice(dataPos, dataPos + elementSize)));
      dataPos += elementSize;
    }

    return messages;
  }

  private parseOSCMessage(data: Uint8Array): { address: string; args: any[] } | null {
    try {
      const decoder = new TextDecoder();

      // Find the null terminator for the address
      let addressEnd = 0;
      while (addressEnd < data.length && data[addressEnd] !== 0) {
        addressEnd++;
      }

      if (addressEnd === 0 || addressEnd >= data.length) {
        return null;
      }

      const address = decoder.decode(data.slice(0, addressEnd));

      // Skip to the type tag (after address, padded to 4 bytes)
      const typeTagStart = ((addressEnd + 1) + 3) & ~3;

      if (typeTagStart >= data.length) {
        return { address, args: [] };
      }

      // Find the null terminator for the type tag
      let typeTagEnd = typeTagStart;
      while (typeTagEnd < data.length && data[typeTagEnd] !== 0) {
        typeTagEnd++;
      }

      const typeTag = decoder.decode(data.slice(typeTagStart, typeTagEnd));

      // Parse arguments based on type tag
      const args: any[] = [];
      let dataPos = ((typeTagEnd + 1) + 3) & ~3;

      for (let i = 1; i < typeTag.length; i++) {
        const type = typeTag[i];

        if (type === "f" || type === "i") {
          if (dataPos + 4 > data.length) break;
          const view = new DataView(data.buffer, data.byteOffset + dataPos, 4);
          const value = type === "f" ? view.getFloat32(0, false) : view.getInt32(0, false);
          args.push(value);
          dataPos += 4;
        } else if (type === "s") {
          let strEnd = dataPos;
          while (strEnd < data.length && data[strEnd] !== 0) {
            strEnd++;
          }
          if (strEnd > dataPos) {
            args.push(decoder.decode(data.slice(dataPos, strEnd)));
          }
          dataPos = ((strEnd + 1) + 3) & ~3;
        }
      }

      return { address, args };
    } catch (error) {
      console.error("Error parsing OSC message:", error);
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
    }
    if (this.oscSocket) {
      this.oscSocket.close();
      this.oscSocket = null;
    }
    if (this.mdnsAdvertiser) {
      await this.mdnsAdvertiser.stop();
      this.mdnsAdvertiser = null;
    }
  }
}

function getAvailableTcpPort(startPort: number): number {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port });
      listener.close();
      return port;
    } catch {
      // Try the next port.
    }
  }

  throw new Error(`No available TCP port found from ${startPort} to ${startPort + 99}`);
}

async function pollVrchatUserCamera(selfHttpPort: number): Promise<void> {
  let lastPose = "";
  let lastMode = "";
  let lastError = "";
  let vrchatOscQueryBaseUrl: string | null = null;

  while (true) {
    try {
      if (!vrchatOscQueryBaseUrl) {
        vrchatOscQueryBaseUrl = await findVrchatOscQueryBaseUrl(selfHttpPort);
        console.log(`[VRC CAMERA] Using VRChat OSCQuery at ${vrchatOscQueryBaseUrl}`);
      }

      const [mode, pose] = await Promise.all([
        queryOscQueryValue(`${vrchatOscQueryBaseUrl}/usercamera/Mode?VALUE`),
        queryOscQueryValue(`${vrchatOscQueryBaseUrl}/usercamera/Pose?VALUE`),
      ]);

      const modeText = JSON.stringify(mode);
      if (modeText !== lastMode) {
        lastMode = modeText;
        console.log(`[VRC CAMERA] Mode VALUE ${modeText}`);
      }

      const poseText = JSON.stringify(pose);
      if (poseText !== lastPose) {
        lastPose = poseText;
        console.log(`[VRC CAMERA] Pose VALUE ${poseText}`);
      }

      lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        lastError = message;
        console.log(`[VRC CAMERA] Poll failed: ${message}`);
      }
      vrchatOscQueryBaseUrl = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function findVrchatOscQueryBaseUrl(selfHttpPort: number): Promise<string> {
  const candidatePorts = uniqueNumbers([
    ...range(9000, 9020),
    ...range(33776, 33810),
  ]).filter((port) => port !== selfHttpPort);

  for (const port of candidatePorts) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const hostInfo = await queryJson(`${baseUrl}/?HOST_INFO`, 300);
      const name = String((hostInfo as { NAME?: unknown }).NAME ?? "");
      const looksLikeVrchat = name.toLowerCase().includes("vrchat") ||
        await hasOscQueryPath(`${baseUrl}/usercamera/Pose`, 300);

      if (looksLikeVrchat) {
        return baseUrl;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not find VRChat OSCQuery HTTP service on localhost");
}

async function queryOscQueryValue(url: string): Promise<unknown> {
  const body = await queryJson(url, 1_000);
  if (body && typeof body === "object" && "VALUE" in body) {
    return (body as { VALUE: unknown }).VALUE;
  }

  return body;
}

async function hasOscQueryPath(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function queryJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return await response.json();
}

function range(start: number, endInclusive: number): number[] {
  const numbers: number[] = [];
  for (let value = start; value <= endInclusive; value++) {
    numbers.push(value);
  }
  return numbers;
}

function uniqueNumbers(numbers: number[]): number[] {
  return [...new Set(numbers)];
}

async function main() {
  const SERVER_NAME = "PetPlay";
  const HTTP_PORT = getAvailableTcpPort(33776); // OSCQuery HTTP port
  const OSC_PORT = 9001; // OSC UDP port for receiving data

  console.log("OSCQuery Test Script");
  console.log("====================");
  console.log(`Server name: ${SERVER_NAME}`);
  console.log(`HTTP port: ${HTTP_PORT}`);
  console.log(`OSC port: ${OSC_PORT}`);
  console.log();

  const server = new OSCQueryServer(SERVER_NAME, HTTP_PORT, OSC_PORT);

  try {
    // Start the HTTP server for OSCQuery
    await server.startHttpServer();

    // Start the OSC receiver
    await server.startOSCReceiver();

    // Advertise OSCQuery and OSC services with mDNS/Zeroconf.
    await server.startAdvertising();

    console.log();
    console.log("Advertised service type: _oscjson._tcp");
    console.log();

    pollVrchatUserCamera(HTTP_PORT);

    // Handle graceful shutdown
    const shutdown = () => {
      console.log("\nShutting down...");
      server.stop();
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    let lastHeadPoseLog = 0;

    // Start receiving OSC messages
    await server.receiveOSCMessages(({ address, args }, rawLength) => {
      //console.log(`[OSC] ${rawLength} bytes ${address || "<unparsed>"} (${args.length} args)`);

      // Filter to only tracking and usercamera paths.
      if (
        !address.startsWith("/tracking/vrsystem/head/pose") &&
        !address.startsWith("/usercamera")
      ) {
        return;
      }

      const now = Date.now();
      if (address.startsWith("/tracking/vrsystem/head/pose") && now - lastHeadPoseLog < 1_000) {
        return;
      }
      if (address.startsWith("/tracking/vrsystem/head/pose")) {
        lastHeadPoseLog = now;
      }

      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] ${address} ${
          args.map((arg) => typeof arg === "number" ? arg.toFixed(4) : arg).join(" ")
        }`,
      );
    });
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    server.stop();
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}

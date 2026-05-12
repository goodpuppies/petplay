#!/usr/bin/env -S deno run -A
import { ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type { Vec3Tuple, VrcCameraDebugPose } from "../classes/vrcCameraDebugState.ts";

type OscMessage = {
  address: string;
  args: unknown[];
};

type OSCQueryNode = {
  FULL_PATH: string;
  ACCESS?: number;
  TYPE?: string;
  DESCRIPTION?: string;
  CONTENTS?: Record<string, OSCQueryNode>;
};

type OSCQueryHostInfo = {
  NAME: string;
  EXTENSIONS: Record<string, boolean>;
  OSC_IP: string;
  OSC_PORT: number;
  OSC_TRANSPORT: "UDP";
};

type CoordinateMap = Record<string, number>;
type CameraRaySample = {
  position: Vec3Tuple;
  direction: Vec3Tuple;
  rotationDeg: Vec3Tuple;
  receivedAt: number;
};
type CameraPositionEstimate = {
  targetWorld: Vec3Tuple;
  originRelativeToTarget: Vec3Tuple;
  targetRelativeToFirstCamera: Vec3Tuple;
  rmsError: number;
  maxError: number;
  sampleCount: number;
  baselineMeters: number;
  updatedAt: number;
};

const USER_CAMERA_POSE = "/usercamera/Pose";
const USER_CAMERA_MODE = "/usercamera/Mode";
const CUSTOM_OBJECT_SYNC_PREFIX = "/avatar/parameters/CustomObjectSync/";
const DEFAULT_OSC_PORT = 9001;
const DEFAULT_HTTP_PORT = 33776;
const MAX_POSITION_SAMPLES = 96;
const MIN_POSITION_SAMPLES = 4;
const MIN_SAMPLE_DISTANCE_METERS = 0.03;
const MIN_SAMPLE_ANGLE_DEG = 0.35;

const state = actorState({
  name: "vrc-origin-camera",
  webxr: null as ActorId | null,
  driver: null as CameraOscQueryDriver | null,
  latestCameraPose: null as VrcCameraDebugPose | null,
  positionSamples: [] as CameraRaySample[],
  positionEstimate: null as CameraPositionEstimate | null,
  visualBaselinePosition: null as Vec3Tuple | null,
  customObjectSyncCoordinates: {} as CoordinateMap,
  lastDebugPostAt: 0,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    ASSIGNWEBXR: (payload: ActorId) => {
      state.webxr = payload;
    },
    STARTCAMERAORIGIN: (_payload: void) => {
      if (state.driver) return;
      state.driver = new CameraOscQueryDriver({
        name: "PetPlayCameraOrigin",
        httpPort: getAvailableTcpPort(DEFAULT_HTTP_PORT),
        oscPort: DEFAULT_OSC_PORT,
        onMessage: handleOscMessage,
      });
      state.driver.start().catch((error) => {
        LogChannel.error(
          "vrc-camera-origin",
          `camera origin driver failed: ${error instanceof Error ? error.message : error}`,
        );
      });
    },
    STOPCAMERAORIGIN: async (_payload: void) => {
      await state.driver?.stop();
      state.driver = null;
      return true;
    },
    GETCAMERAPOSE: (_payload: void) => state.latestCameraPose,
    GETCAMERAPOSITIONESTIMATE: (_payload: void) => state.positionEstimate,
    GETCAMERAPOSITIONSAMPLES: (_payload: void) => state.positionSamples,
    RESETCAMERAPOSITIONESTIMATE: (_payload: void) => {
      state.positionSamples = [];
      state.positionEstimate = null;
      postCameraDebugUpdate(null, state.latestCameraPose);
      return true;
    },
    GETCUSTOMOBJECTSYNCCOORDINATE: (_payload: void) => state.customObjectSyncCoordinates,
    GETCOORDINATE: (_payload: void) => state.customObjectSyncCoordinates,
  } as const,
);

function handleOscMessage(message: OscMessage): void {
  if (message.address.startsWith(CUSTOM_OBJECT_SYNC_PREFIX)) {
    const value = message.args[0];
    if (typeof value === "number") {
      state.customObjectSyncCoordinates[message.address] = value;
    }
  }

  if (message.address !== USER_CAMERA_POSE) return;
  if (message.args.length < 6 || !message.args.every((value) => typeof value === "number")) {
    return;
  }

  const pose: VrcCameraDebugPose = {
    position: [message.args[0], message.args[1], message.args[2]] as Vec3Tuple,
    rotationDeg: [message.args[3], message.args[4], message.args[5]] as Vec3Tuple,
    receivedAt: Date.now(),
  };
  state.latestCameraPose = pose;
  state.visualBaselinePosition ??= [...pose.position];
  updatePositionEstimate(pose);

  const now = Date.now();
  if (now - state.lastDebugPostAt < 33) {
    return;
  }
  state.lastDebugPostAt = now;

  postCameraDebugUpdate(state.positionEstimate, pose);
}

function postCameraDebugUpdate(
  estimate: CameraPositionEstimate | null,
  pose: VrcCameraDebugPose | null = null,
): void {
  if (!state.webxr) return;
  PostMan.PostMessage({
    target: state.webxr,
    type: "VRCCAMERADEBUGUPDATE",
    payload: {
      cameraPose: pose,
      originEstimate: estimate?.originRelativeToTarget ?? null,
      lookAtTargetEstimate: estimate?.targetRelativeToFirstCamera ?? null,
    },
  });
}

function updatePositionEstimate(pose: VrcCameraDebugPose): void {
  const sample: CameraRaySample = {
    position: [...pose.position],
    direction: normalize(unityForwardFromEulerDeg(pose.rotationDeg)),
    rotationDeg: [...pose.rotationDeg],
    receivedAt: pose.receivedAt,
  };

  const last = state.positionSamples.at(-1);
  if (last) {
    const moved = distance(last.position, sample.position);
    const turnedDeg = angleBetweenDeg(last.direction, sample.direction);
    if (moved < MIN_SAMPLE_DISTANCE_METERS && turnedDeg < MIN_SAMPLE_ANGLE_DEG) {
      return;
    }
  }

  state.positionSamples.push(sample);
  if (state.positionSamples.length > MAX_POSITION_SAMPLES) {
    state.positionSamples.splice(0, state.positionSamples.length - MAX_POSITION_SAMPLES);
  }

  const estimate = fitCameraLookAtTarget(state.positionSamples);
  if (estimate) {
    state.positionEstimate = estimate;
  }
}

function fitCameraLookAtTarget(samples: CameraRaySample[]): CameraPositionEstimate | null {
  if (samples.length < MIN_POSITION_SAMPLES) return null;

  const firstPosition = samples[0].position;
  const visualBaselinePosition = state.visualBaselinePosition ?? firstPosition;
  let baselineMeters = 0;
  for (const sample of samples) {
    baselineMeters = Math.max(baselineMeters, distance(firstPosition, sample.position));
  }
  if (baselineMeters < MIN_SAMPLE_DISTANCE_METERS * 2) return null;

  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];

  for (const sample of samples) {
    const d = sample.direction;
    const projector = [
      [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2]],
      [-d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2]],
      [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]],
    ];

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        a[row][col] += projector[row][col];
      }
      b[row] += dot(projector[row] as Vec3Tuple, sample.position);
    }
  }

  const targetWorld = solve3x3(a, b);
  if (!targetWorld) return null;

  let errorSquared = 0;
  let maxError = 0;
  for (const sample of samples) {
    const error = pointLineDistance(targetWorld, sample.position, sample.direction);
    errorSquared += error * error;
    maxError = Math.max(maxError, error);
  }

  return {
    targetWorld,
    originRelativeToTarget: [-targetWorld[0], -targetWorld[1], -targetWorld[2]],
    targetRelativeToFirstCamera: [
      targetWorld[0] - visualBaselinePosition[0],
      targetWorld[1] - visualBaselinePosition[1],
      targetWorld[2] - visualBaselinePosition[2],
    ],
    rmsError: Math.sqrt(errorSquared / samples.length),
    maxError,
    sampleCount: samples.length,
    baselineMeters,
    updatedAt: Date.now(),
  };
}

function unityForwardFromEulerDeg(rotationDeg: Vec3Tuple): Vec3Tuple {
  const pitch = degreesToRadians(rotationDeg[0]);
  const yaw = degreesToRadians(rotationDeg[1]);
  return [
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
}

function solve3x3(matrix: number[][], vector: number[]): Vec3Tuple | null {
  const m = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < 3; pivot++) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row++) {
      if (Math.abs(m[row][pivot]) > Math.abs(m[bestRow][pivot])) {
        bestRow = row;
      }
    }
    if (Math.abs(m[bestRow][pivot]) < 1e-6) return null;
    [m[pivot], m[bestRow]] = [m[bestRow], m[pivot]];

    const pivotValue = m[pivot][pivot];
    for (let col = pivot; col < 4; col++) {
      m[pivot][col] /= pivotValue;
    }
    for (let row = 0; row < 3; row++) {
      if (row === pivot) continue;
      const scale = m[row][pivot];
      for (let col = pivot; col < 4; col++) {
        m[row][col] -= scale * m[pivot][col];
      }
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

function pointLineDistance(
  point: Vec3Tuple,
  linePoint: Vec3Tuple,
  lineDirection: Vec3Tuple,
): number {
  const delta = subtract(point, linePoint);
  const projectionLength = dot(delta, lineDirection);
  const closest = add(linePoint, scale(lineDirection, projectionLength));
  return distance(point, closest);
}

function normalize(vector: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function angleBetweenDeg(a: Vec3Tuple, b: Vec3Tuple): number {
  const value = Math.max(-1, Math.min(1, Math.abs(dot(a, b))));
  return degreesFromRadians(Math.acos(value));
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3Tuple, value: number): Vec3Tuple {
  return [a[0] * value, a[1] * value, a[2] * value];
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function degreesFromRadians(value: number): number {
  return value * 180 / Math.PI;
}

class CameraOscQueryDriver {
  private httpServer: Deno.HttpServer | null = null;
  private oscSocket: ReturnType<typeof Deno.listenDatagram> | null = null;
  private mdns: OscQueryMdnsAdvertiser | null = null;
  private readonly addressTree = buildAddressTree();

  constructor(
    private readonly options: {
      name: string;
      httpPort: number;
      oscPort: number;
      onMessage: (message: OscMessage) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.httpServer = Deno.serve(
      { hostname: "127.0.0.1", port: this.options.httpPort },
      this.handleHttpRequest.bind(this),
    );

    this.oscSocket = Deno.listenDatagram({
      port: this.options.oscPort,
      transport: "udp",
    });

    this.mdns = new OscQueryMdnsAdvertiser(this.options.name, this.options.httpPort);
    await this.mdns.start();

    LogChannel.log(
      "vrc-camera-origin",
      `OSCQuery camera origin listening http=127.0.0.1:${this.options.httpPort} osc=127.0.0.1:${this.options.oscPort}`,
    );

    await this.receiveLoop();
  }

  async stop(): Promise<void> {
    this.mdns?.stop();
    this.mdns = null;
    try {
      this.oscSocket?.close();
    } catch {
      // Ignore shutdown races.
    }
    this.oscSocket = null;
    try {
      await this.httpServer?.shutdown();
    } catch {
      // Ignore shutdown races.
    }
    this.httpServer = null;
  }

  private handleHttpRequest(req: Request): Response {
    const url = new URL(req.url);
    if (url.searchParams.has("HOST_INFO")) {
      const hostInfo: OSCQueryHostInfo = {
        NAME: this.options.name,
        EXTENSIONS: {
          ACCESS: true,
          VALUE: true,
          RANGE: true,
          TYPE: true,
        },
        OSC_IP: "127.0.0.1",
        OSC_PORT: this.options.oscPort,
        OSC_TRANSPORT: "UDP",
      };
      return jsonResponse(hostInfo);
    }

    const node = getNode(this.addressTree, url.pathname);
    if (!node) {
      return new Response("OSC Path not found", { status: 404 });
    }

    return jsonResponse(node);
  }

  private async receiveLoop(): Promise<void> {
    if (!this.oscSocket) return;
    try {
      for await (const [data] of this.oscSocket) {
        for (const message of parseOscPacket(data)) {
          this.options.onMessage(message);
        }
      }
    } catch {
      // Expected when the socket is closed for reboot/shutdown.
    }
  }
}

class OscQueryMdnsAdvertiser {
  private static readonly ADDRESS = "224.0.0.251";
  private static readonly PORT = 5353;
  private static readonly TTL_SECONDS = 120;
  private static readonly REBROADCAST_MS = 5_000;

  private stopped = false;
  private readonly instanceName: string;
  private readonly targetName: string;

  constructor(serviceName: string, private readonly httpPort: number) {
    this.instanceName = sanitizeDnsLabel(serviceName);
    this.targetName = `${this.instanceName}.oscjson.tcp`;
  }

  async start(): Promise<void> {
    await this.broadcast();
    this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private loop(): void {
    const run = async () => {
      while (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, OscQueryMdnsAdvertiser.REBROADCAST_MS));
        if (!this.stopped) await this.broadcast();
      }
    };
    run();
  }

  private async broadcast(): Promise<void> {
    const addresses = Deno.networkInterfaces()
      .filter((networkInterface) => networkInterface.family === "IPv4")
      .map((networkInterface) => networkInterface.address)
      .filter((address) => address !== "127.0.0.1" && !address.startsWith("169.254."));

    await Promise.all(addresses.map((address) => this.broadcastOnInterface(address)));
  }

  private async broadcastOnInterface(address: string): Promise<void> {
    let socket: ReturnType<typeof Deno.listenDatagram> | null = null;
    try {
      socket = Deno.listenDatagram({
        hostname: address,
        port: OscQueryMdnsAdvertiser.PORT,
        transport: "udp",
        reuseAddress: true,
      });
    } catch {
      socket = Deno.listenDatagram({ hostname: address, port: 0, transport: "udp" });
    }

    try {
      await socket.send(this.buildPacket(), {
        hostname: OscQueryMdnsAdvertiser.ADDRESS,
        port: OscQueryMdnsAdvertiser.PORT,
        transport: "udp",
      });
    } finally {
      socket.close();
    }
  }

  private buildPacket(): Uint8Array {
    const serviceType = "_oscjson._tcp.local";
    const instanceName = `${this.instanceName}.${serviceType}`;
    const answers = [ptrRecord(serviceType, instanceName, OscQueryMdnsAdvertiser.TTL_SECONDS)];
    const additionals = [
      srvRecord(instanceName, this.targetName, this.httpPort, OscQueryMdnsAdvertiser.TTL_SECONDS),
      txtRecord(instanceName, OscQueryMdnsAdvertiser.TTL_SECONDS),
      aRecord(this.targetName, "127.0.0.1", OscQueryMdnsAdvertiser.TTL_SECONDS),
    ];
    const records = [...answers, ...additionals];
    const packet = new Uint8Array(12 + records.reduce((sum, record) => sum + record.length, 0));
    const view = new DataView(packet.buffer);
    view.setUint16(2, 0x8400, false);
    view.setUint16(6, answers.length, false);
    view.setUint16(10, additionals.length, false);
    let offset = 12;
    for (const record of records) {
      packet.set(record, offset);
      offset += record.length;
    }
    return packet;
  }
}

function buildAddressTree(): OSCQueryNode {
  return {
    FULL_PATH: "/",
    DESCRIPTION: "PetPlay camera origin OSCQuery receiver",
    ACCESS: 0,
    CONTENTS: {
      "usercamera": {
        FULL_PATH: "/usercamera",
        ACCESS: 0,
        CONTENTS: {
          "Mode": {
            FULL_PATH: USER_CAMERA_MODE,
            ACCESS: 3,
            TYPE: "i",
          },
          "Pose": {
            FULL_PATH: USER_CAMERA_POSE,
            ACCESS: 3,
            TYPE: "ffffff",
          },
        },
      },
    },
  };
}

function getNode(root: OSCQueryNode, path: string): OSCQueryNode | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  let current: OSCQueryNode = root;
  for (const part of parts) {
    const next = current.CONTENTS?.[part];
    if (!next) return null;
    current = next;
  }
  return current;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function parseOscPacket(data: Uint8Array): OscMessage[] {
  const bundle = parseOscBundle(data);
  if (bundle) return bundle;
  const message = parseOscMessage(data);
  return message ? [message] : [];
}

function parseOscBundle(data: Uint8Array): OscMessage[] | null {
  const tag = new TextDecoder().decode(data.slice(0, 7));
  if (tag !== "#bundle") return null;
  const messages: OscMessage[] = [];
  let offset = 16;
  while (offset + 4 <= data.length) {
    const size = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
    offset += 4;
    if (size <= 0 || offset + size > data.length) break;
    messages.push(...parseOscPacket(data.slice(offset, offset + size)));
    offset += size;
  }
  return messages;
}

function parseOscMessage(data: Uint8Array): OscMessage | null {
  const decoder = new TextDecoder();
  let addressEnd = 0;
  while (addressEnd < data.length && data[addressEnd] !== 0) addressEnd++;
  if (addressEnd === 0 || addressEnd >= data.length) return null;
  const address = decoder.decode(data.slice(0, addressEnd));
  const typeTagStart = ((addressEnd + 1) + 3) & ~3;
  let typeTagEnd = typeTagStart;
  while (typeTagEnd < data.length && data[typeTagEnd] !== 0) typeTagEnd++;
  const typeTag = decoder.decode(data.slice(typeTagStart, typeTagEnd));
  const args: unknown[] = [];
  let offset = ((typeTagEnd + 1) + 3) & ~3;
  for (let i = 1; i < typeTag.length; i++) {
    const type = typeTag[i];
    if (type === "f" || type === "i") {
      if (offset + 4 > data.length) break;
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      args.push(type === "f" ? view.getFloat32(0, false) : view.getInt32(0, false));
      offset += 4;
    }
  }
  return { address, args };
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

function ptrRecord(name: string, value: string, ttl: number): Uint8Array {
  return record(name, 12, ttl, encodeDnsName(value), false);
}

function srvRecord(name: string, target: string, port: number, ttl: number): Uint8Array {
  const encodedTarget = encodeDnsName(target);
  const rdata = new Uint8Array(6 + encodedTarget.length);
  const view = new DataView(rdata.buffer);
  view.setUint16(4, port, false);
  rdata.set(encodedTarget, 6);
  return record(name, 33, ttl, rdata);
}

function txtRecord(name: string, ttl: number): Uint8Array {
  const text = new TextEncoder().encode("txtvers=1");
  return record(name, 16, ttl, new Uint8Array([text.length, ...text]));
}

function aRecord(name: string, ip: string, ttl: number): Uint8Array {
  return record(name, 1, ttl, new Uint8Array(ip.split(".").map((part) => Number(part))));
}

function record(name: string, type: number, ttl: number, rdata: Uint8Array, flush = true) {
  const encodedName = encodeDnsName(name);
  const out = new Uint8Array(encodedName.length + 10 + rdata.length);
  out.set(encodedName);
  const view = new DataView(out.buffer);
  const headerOffset = encodedName.length;
  view.setUint16(headerOffset, type, false);
  view.setUint16(headerOffset + 2, flush ? 0x8001 : 0x0001, false);
  view.setUint32(headerOffset + 4, ttl, false);
  view.setUint16(headerOffset + 8, rdata.length, false);
  out.set(rdata, headerOffset + 10);
  return out;
}

function encodeDnsName(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  for (const label of name.split(".")) {
    const encoded = encoder.encode(label);
    parts.push(encoded.length, ...encoded);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

function sanitizeDnsLabel(label: string): string {
  return label.replaceAll(".", "-").replaceAll(" ", "-").slice(0, 63);
}

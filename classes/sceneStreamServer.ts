/**
 * Scene stream server (markdown/scene-stream, P4): serves the scene store to browser renderers.
 *
 * Runs inside the webxr worker. Each published frame is written into a `SceneStore`; each
 * connected client receives "latest since its ack" (or a snapshot) as one binary delta, with at
 * most one delta in flight per client. Tracked poses travel separately as small JSON messages, so
 * they never dirty the store.
 *
 * HTTP on the same port: `/` the viewer page, `/viewer.js` its bundle
 * (`deno task scene-stream:build`), `/scene` the WebSocket. Loopback only unless a hostname is
 * given; expose remote access deliberately (for example through `tailscale serve`).
 *
 * Start with `PETPLAY_SCENE_STREAM_PORT=<port>` in the environment of the PetPlay server, or from
 * the agent REPL inside the webxr worker:
 * `import(new URL("../classes/sceneStreamServer.ts", moduleUrl).href).then((m) => m.startSceneStream({ port: 3993 }))`.
 */
import * as THREE from "three";
import type { ExtractionResult } from "../submodules/raythree/src/lib.ts";
import { encodeDelta, type TrackedSpace } from "../submodules/raythree/src/store/mod.ts";
import type { OverlayAssetCache } from "./overlaySceneDelivery.ts";
import type { RenderAnchorSpace } from "./overlayRenderTracking.ts";
import { PetplaySceneStoreWriter } from "./sceneStoreWriter.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

export interface SceneStreamOptions {
  port: number;
  hostname?: string;
}

export interface SceneStreamStatus {
  url: string;
  tick: number;
  clients: number;
  items: number;
  framesPublished: number;
  deltasSent: number;
  bytesSent: number;
  lastError: string | null;
}

const VIEWER_DIR = new URL("../web/scene-stream/", import.meta.url);
const BUNDLE = new URL("../dist/scene-stream/viewer.js", import.meta.url);
/** A client that has not acked for this long gets a snapshot next. */
const ACK_TIMEOUT_MS = 5000;

const ANCHOR_SPACE: Readonly<Record<RenderAnchorSpace, TrackedSpace>> = {
  head: "viewer",
  "left-hand": "left-grip",
  "right-hand": "right-grip",
  "left-ray": "left-ray",
  "right-ray": "right-ray",
};

type Client = {
  socket: WebSocket;
  /** Producer tick the client's replica equals; null until it has a snapshot. */
  ack: number | null;
  inFlightSince: number | null;
  lastPoses: string;
};

class SceneStream {
  readonly writer = new PetplaySceneStoreWriter();
  readonly store = this.writer.store;
  private readonly clients = new Set<Client>();
  private readonly server: Deno.HttpServer;
  private assetVersion = 0;
  private anchors = new Map<RenderAnchorSpace, THREE.Object3D>();
  private anchorsFoundAt = -Infinity;
  private poses = "{}";
  framesPublished = 0;
  deltasSent = 0;
  bytesSent = 0;
  lastError: string | null = null;

  constructor(readonly options: SceneStreamOptions) {
    this.server = Deno.serve({
      port: options.port,
      hostname: options.hostname ?? "127.0.0.1",
      onListen: () => {},
    }, (request) => this.handle(request));
  }

  get url(): string {
    return `http://${this.options.hostname ?? "127.0.0.1"}:${this.options.port}/`;
  }

  /** One frame from the webxr worker. Never throws into the frame loop. */
  publish(payload: WebXRRaythreeRenderPayload, assets: OverlayAssetCache, scene: THREE.Object3D | null) {
    try {
      // The extractor's asset batches are deltas; the cache holds their union, so a stream started
      // late still gets every asset the scene uses.
      const extraction: ExtractionResult = {
        ...payload.leftEye,
        assets: assets.since(this.assetVersion),
      };
      this.assetVersion = assets.version;
      this.writer.write(extraction, payload.ui);
      this.framesPublished++;
      this.poses = JSON.stringify({ poses: this.collectPoses(payload, scene) });
      for (const client of this.clients) this.pump(client);
      this.truncateJournal();
    } catch (error) {
      this.lastError = String(error instanceof Error ? error.stack ?? error : error);
    }
  }

  status(): SceneStreamStatus {
    return {
      url: this.url,
      tick: this.store.tick,
      clients: this.clients.size,
      items: this.store.size("items"),
      framesPublished: this.framesPublished,
      deltasSent: this.deltasSent,
      bytesSent: this.bytesSent,
      lastError: this.lastError,
    };
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.socket.close();
    this.clients.clear();
    await this.server.shutdown();
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/scene") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("WebSocket only", { status: 426 });
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      this.attach(socket);
      return response;
    }
    try {
      if (path === "/" || path === "/index.html") {
        return new Response(await Deno.readFile(new URL("index.html", VIEWER_DIR)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (path === "/viewer.js") {
        return new Response(await Deno.readFile(BUNDLE), {
          headers: { "content-type": "text/javascript", "cache-control": "no-store" },
        });
      }
    } catch (error) {
      return new Response(`Not built: ${error}`, { status: 500 });
    }
    return new Response("Not found", { status: 404 });
  }

  private attach(socket: WebSocket): void {
    socket.binaryType = "arraybuffer";
    const client: Client = { socket, ack: null, inFlightSince: null, lastPoses: "" };
    socket.onopen = () => {
      this.clients.add(client);
      this.pump(client);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: { ack?: unknown; resync?: unknown };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.ack === "number" && Number.isFinite(message.ack)) {
        client.ack = message.ack;
        client.inFlightSince = null;
      } else if (message.resync === true) {
        client.ack = null;
        client.inFlightSince = null;
      }
      this.pump(client);
    };
    const drop = () => {
      this.clients.delete(client);
      this.truncateJournal();
    };
    socket.onclose = drop;
    socket.onerror = drop;
  }

  /** Sends the client what it lacks, if nothing is in flight to it. */
  private pump(client: Client): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.lastPoses !== this.poses) {
      client.socket.send(this.poses);
      client.lastPoses = this.poses;
    }
    if (client.inFlightSince != null) {
      if (performance.now() - client.inFlightSince < ACK_TIMEOUT_MS) return;
      client.ack = null; // lost or stuck: start over from a snapshot
    }
    if (client.ack === this.store.tick) return;
    const delta = (client.ack == null ? null : this.store.changesSince(client.ack)) ??
      this.store.snapshot();
    const bytes = encodeDelta(delta);
    client.socket.send(bytes);
    client.inFlightSince = performance.now();
    this.deltasSent++;
    this.bytesSent += bytes.byteLength;
  }

  /** The journal only has to reach back to the oldest ack; new clients start from a snapshot. */
  private truncateJournal(): void {
    let oldest = this.store.tick;
    for (const client of this.clients) {
      if (client.ack != null) oldest = Math.min(oldest, client.ack);
    }
    this.store.truncateJournal(oldest);
  }

  /**
   * The exact poses the producer placed anchored items from: the head from the frame, the hands
   * from the scene objects tagged `renderTrackingAnchor` (found again once a second).
   */
  private collectPoses(
    payload: WebXRRaythreeRenderPayload,
    scene: THREE.Object3D | null,
  ): Partial<Record<TrackedSpace, number[]>> {
    const out: Partial<Record<TrackedSpace, number[]>> = {};
    const f = payload.frame;
    if (f.viewerPosition && f.viewerQuaternion) {
      out.viewer = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(f.viewerPosition),
        new THREE.Quaternion().fromArray(f.viewerQuaternion),
        new THREE.Vector3(1, 1, 1),
      ).toArray();
    }
    if (scene) {
      const now = performance.now();
      if (now - this.anchorsFoundAt > 1000) {
        this.anchorsFoundAt = now;
        this.anchors = new Map();
        scene.traverse((object) => {
          const space = object.userData?.renderTrackingAnchor as RenderAnchorSpace | undefined;
          if (space && space in ANCHOR_SPACE && !this.anchors.has(space)) this.anchors.set(space, object);
        });
      }
      for (const [space, object] of this.anchors) {
        if (space === "head" && out.viewer) continue;
        out[ANCHOR_SPACE[space]] = object.matrixWorld.toArray();
      }
    }
    return out;
  }
}

let active: SceneStream | null = null;

export function startSceneStream(options: SceneStreamOptions): SceneStreamStatus {
  if (active) {
    if (active.options.port === options.port) return active.status();
    throw new Error(`Scene stream already running on ${active.url}`);
  }
  active = new SceneStream(options);
  return active.status();
}

export async function stopSceneStream(): Promise<void> {
  const stream = active;
  active = null;
  await stream?.stop();
}

export function activeSceneStream(): SceneStream | null {
  return active;
}

/** Started by the environment, once per worker: `PETPLAY_SCENE_STREAM_PORT`. */
export function startSceneStreamFromEnv(): void {
  const port = Number(Deno.env.get("PETPLAY_SCENE_STREAM_PORT"));
  if (!Number.isInteger(port) || port <= 0 || active) return;
  try {
    startSceneStream({ port, hostname: Deno.env.get("PETPLAY_SCENE_STREAM_HOST") || undefined });
  } catch (error) {
    console.error(`[scene-stream] could not start on ${port}: ${error}`);
  }
}

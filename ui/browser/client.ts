/// <reference lib="dom" />
/**
 * Browser worker for the PetPlay UI preview: connects to the studio actor's `/tab` WebSocket,
 * applies raythree `SceneStore` deltas to a local replica, acks each tick, and renders via
 * `SceneView` onto the transferred `OffscreenCanvas` (same rendering pipeline as `rdp/browser/client.ts`).
 */
import * as THREE from "npm:three@0.186.1";
import {
  decodeDelta,
  SceneStore,
  StoreDivergence,
} from "../../submodules/raythree/src/store/mod.ts";
import { SceneView, viewState } from "../../web/scene-stream/sceneView.ts";
import type { TabDomEvent, TabViewport, ToUi } from "../../rdp/classes/tabProtocol.ts";

export type ToPage = { status: string };

type AttachMessage = {
  type: "ATTACH";
  canvas: OffscreenCanvas;
  port: MessagePort;
  viewport: TabViewport;
  wsUrl: string;
};

type ServerJson = {
  camera?: { projection: number[]; world: number[] };
  background?: string;
};

const RECONNECT_MIN_MS = 150;
const RECONNECT_MAX_MS = 1000;

const replica = new SceneStore();
const view = new SceneView(replica);
const camera = new THREE.Camera();
camera.matrixAutoUpdate = false;

let renderer: THREE.WebGLRenderer | null = null;
let page: MessagePort | null = null;
let socket: WebSocket | null = null;
let viewport: TabViewport | null = null;
let wsUrl = "";
let reconnectDelay = RECONNECT_MIN_MS;

function status(text: string): void {
  page?.postMessage({ status: text } satisfies ToPage);
}

function toUi(message: ToUi): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function resize(next: TabViewport): void {
  viewport = next;
  renderer?.setPixelRatio(next.dpr);
  renderer?.setSize(next.width, next.height, false);
  viewState.dirty = true;
  toUi({ viewport: next });
}

function connect(): void {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    status("connected");
    if (viewport) toUi({ viewport });
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      try {
        const delta = decodeDelta(bytes);
        replica.apply(delta);
        toUi({ ack: delta.toTick });
      } catch (error) {
        if (!(error instanceof StoreDivergence)) console.error("ui preview:", error);
        toUi({ resync: true });
      }
      return;
    }
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data) as ServerJson;
      if (message.camera) {
        camera.projectionMatrix.fromArray(message.camera.projection);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        camera.matrixWorld.fromArray(message.camera.world);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        viewState.dirty = true;
      }
      if (message.background) {
        view.scene.background = new THREE.Color(message.background);
        viewState.dirty = true;
      }
    } catch { /* ignore malformed frame */ }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    status("reloading…");
    const delay = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(reconnectDelay * 1.6));
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };
}

function frame(): void {
  if (renderer) {
    view.update(camera);
    if (viewState.dirty) {
      viewState.dirty = false;
      renderer.render(view.scene, camera);
    }
  }
  schedule();
}

function schedule(): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (raf) raf(frame);
  else setTimeout(frame, 16);
}

self.onmessage = (event: MessageEvent<AttachMessage>) => {
  const msg = event.data;
  if (msg?.type !== "ATTACH") return;
  wsUrl = msg.wsUrl;
  renderer = new THREE.WebGLRenderer({ canvas: msg.canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  page = msg.port;
  page.onmessage = (ev) => {
    const data = ev.data as { viewport?: TabViewport; dom?: TabDomEvent };
    if (data.viewport) resize(data.viewport);
    else if (data.dom) toUi({ dom: data.dom });
  };
  resize(msg.viewport);
  connect();
  schedule();
};

/// <reference lib="dom" />
/**
 * The RDP tab's client actor, a stageforge worker in the browser.
 *
 * The page (`page.ts`) hands it an OffscreenCanvas and a MessagePort for DOM events (`ATTACH`).
 * It joins the session topic; when the UI actor appears among its contacts (the topic's
 * connection is iroh, through a relay in a browser) it negotiates the `rdp.ui` transport, a
 * direct WebSocket, and from then on:
 *
 * - applies scene store deltas to a replica and acks each one, and draws the replica
 *   (`web/scene-stream/sceneView.ts`) with the camera the UI actor sends;
 * - receives the media feeds the scene's video surfaces show (`mediaFeeds.ts`) and reports each
 *   feed's picture size back, like a video element's `loadedmetadata`;
 * - forwards the page's viewport and DOM events.
 */
import * as THREE from "npm:three@0.186.1";
import {
  actorState,
  messages,
  PostMan,
  registerTransportKind,
  Transport,
  type TransportMessages,
  webSocketTransport,
} from "../../submodules/stageforge/mod.ts";
import {
  decodeDelta,
  SceneStore,
  StoreDivergence,
} from "../../submodules/raythree/src/store/mod.ts";
import { SceneView, viewState } from "../scene-stream/sceneView.ts";
import { MediaFeeds } from "../scene-stream/mediaFeeds.ts";
import {
  type TabDomEvent,
  type TabViewport,
  type ToTab,
  type ToUi,
  UI_ACTOR_NAME,
  UI_PURPOSE,
} from "../../rdp/classes/tabProtocol.ts";
import { sessionTopic } from "../../rdp/classes/session.ts";

type Attach = {
  canvas: OffscreenCanvas;
  port: MessagePort;
  viewport: TabViewport;
  /** The session secret from the link (see rdp/classes/session.ts). */
  secret: string;
  /** The page's query string: media receiver options (`buffer`, `software`). */
  search: string;
};

/** Page ← client: what the page shows over the canvas. */
export type ToPage = { status: string };

const CONTACT_POLL_MS = 200;

const state = actorState({
  name: "rdp-tab",
  ui: null as string | null,
  connected: false,
  deltas: 0,
  bytes: 0,
  resyncs: 0,
  status: "starting",
});

const replica = new SceneStore();
const view = new SceneView(replica);
const camera = new THREE.Camera();
camera.matrixAutoUpdate = false;
let renderer: THREE.WebGLRenderer | null = null;
let page: MessagePort | null = null;
let tab: TransportMessages | null = null;
let viewport: TabViewport | null = null;
let media: MediaFeeds | null = null;
let secret = "";

function status(text: string): void {
  state.status = text;
  page?.postMessage({ status: text } satisfies ToPage);
}

function toUi(message: ToUi): void {
  if (tab && !tab.isClosed) tab.send(message);
}

function resize(next: TabViewport): void {
  viewport = next;
  renderer?.setPixelRatio(next.dpr);
  renderer?.setSize(next.width, next.height, false);
  viewState.dirty = true;
  toUi({ viewport: next });
}

function onTabMessage(raw: unknown): void {
  const message = raw as ToTab;
  if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    state.deltas++;
    state.bytes += bytes.byteLength;
    try {
      const delta = decodeDelta(bytes);
      replica.apply(delta);
      toUi({ ack: delta.toTick });
    } catch (error) {
      if (!(error instanceof StoreDivergence)) console.error("rdp tab:", error);
      state.resyncs++;
      toUi({ resync: true });
    }
    return;
  }
  if ("camera" in message) {
    camera.projectionMatrix.fromArray(message.camera.projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.matrixWorld.fromArray(message.camera.world);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    viewState.dirty = true;
  } else if ("media" in message) {
    media?.update(message.media.feeds);
  }
}

/** Find the UI actor among the topic's contacts and open the transport to it. */
async function connect(): Promise<void> {
  for (;;) {
    const ui = [...state.addressBook].find((id) => String(id).startsWith(`${UI_ACTOR_NAME}@`));
    if (ui && !tab) {
      state.ui = ui;
      status("connecting to the desktop…");
      try {
        const transport = await Transport.open(ui, {
          purpose: UI_PURPOSE,
          kinds: ["websocket"],
          params: { secret },
        });
        tab = messages(transport);
        state.connected = true;
        status("connected");
        tab.onmessage = onTabMessage;
        tab.onclose = (reason) => {
          tab = null;
          state.connected = false;
          status(`disconnected: ${reason ?? "closed"}; reconnecting…`);
        };
        // A new connection starts from a snapshot.
        if (viewport) toUi({ viewport });
      } catch (error) {
        status(`could not connect: ${error}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CONTACT_POLL_MS));
  }
}

function frame(now: number): void {
  if (renderer) {
    view.update(camera);
    const replaced: VideoFrame[] = [];
    const video = media?.present(now, replaced) ?? false;
    if (viewState.dirty || video) {
      viewState.dirty = false;
      renderer.render(view.scene, camera);
      for (const picture of replaced) picture.close();
    }
  }
  schedule();
}

function schedule(): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
    .requestAnimationFrame;
  if (raf) raf(frame);
  else setTimeout(() => frame(performance.now()), 16);
}

new PostMan(state, {
  ATTACH: async ({ canvas, port, viewport: initial, secret: session, search }: Attach) => {
    secret = session;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    media = new MediaFeeds(view, new URLSearchParams(search), (feed, width, height) => {
      toUi({ feedSize: { feed, width, height } });
    });
    page = port;
    port.onmessage = (event) => {
      const message = event.data as { viewport?: TabViewport; dom?: TabDomEvent };
      if (message.viewport) resize(message.viewport);
      else if (message.dom) toUi({ dom: message.dom });
    };
    resize(initial);
    registerTransportKind(webSocketTransport());
    PostMan.setTopic(await sessionTopic(secret));
    status("looking for the desktop…");
    void connect();
    schedule();
    return true;
  },
  __HEALTH__: () => ({ ...state, addressBook: [...state.addressBook] }),
} as const);

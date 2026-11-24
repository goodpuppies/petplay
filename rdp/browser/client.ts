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
  System,
  Transport,
  type TransportMessages,
  webSocketTransport,
  webTransportTransport,
} from "../../submodules/stageforge/mod.ts";
import {
  decodeDelta,
  SceneStore,
  StoreDivergence,
} from "../../submodules/raythree/src/store/mod.ts";
import { type FeedFrame, SceneView, viewState } from "../../web/scene-stream/sceneView.ts";
import { MediaFeeds } from "../../web/scene-stream/mediaFeeds.ts";
import {
  type FeedInfo,
  MEDIA_MUX_ACTOR_NAME,
  type SessionDirectory,
  type TabDomEvent,
  type TabViewport,
  type ToTab,
  type ToUi,
  UI_ACTOR_NAME,
  UI_PURPOSE,
} from "../classes/tabProtocol.ts";
import {
  MEDIA_PURPOSE,
  type PageWebRtcEvent,
  WEBRTC_VIDEO_KIND,
  webRtcVideoBrowserTransport,
  type WebRtcVideoClientHandle,
} from "../classes/webRtcVideoTransport.ts";

type Attach = {
  canvas: OffscreenCanvas;
  viewport: TabViewport;
  /** Public rendezvous topic for this session (see rdp/classes/session.ts). */
  topic: string;
  /** The session secret from the link (see rdp/classes/session.ts). */
  secret: string;
  /** The page's query string: media receiver options (`buffer`, `software`). */
  search: string;
  /** Optional local `rdp-liaison` actor; when present, `rdp-tab` stays off the topic server. */
  liaison?: string;
};

/** Page ← client: what the page shows over the canvas. */
export type ToPage = { status: string };

const CONTACT_POLL_MS = 200;

const state = actorState({
  name: "rdp-tab",
  ui: null as string | null,
  mux: null as string | null,
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
let forceWebRtc = false;
let secret = "";
type WebRtcFeed = { key: string; transport: Transport | null; handle: WebRtcVideoClientHandle | null };
const webrtcFeeds = new Map<string, WebRtcFeed>();
let latestFeeds: Record<string, FeedInfo> = {};
(globalThis as Record<string, unknown>).__rdpTabDebug = {
  replica,
  view,
  webrtcFeeds,
  getMedia: () => media,
  getFeeds: () => latestFeeds,
  getViewport: () => viewport,
  getRenderer: () => renderer,
};

const hasWebTransportVideo = () =>
  typeof WebTransport !== "undefined" && typeof VideoDecoder !== "undefined";

function useWebRtcMedia(info: FeedInfo): boolean {
  if (!info.webrtc) return false;
  return forceWebRtc || !hasWebTransportVideo();
}

function dropWebRtcFeed(name: string): void {
  const existing = webrtcFeeds.get(name);
  if (!existing) return;
  webrtcFeeds.delete(name);
  existing.transport?.close("feed changed");
  view.clearFeed(name)?.close();
}

function updateFeeds(feeds: Record<string, FeedInfo>): void {
  latestFeeds = feeds;
  const webtransportFeeds: Record<string, FeedInfo> = {};
  const wantedWebRtc = new Set<string>();
  for (const [name, info] of Object.entries(feeds)) {
    if (useWebRtcMedia(info)) {
      wantedWebRtc.add(name);
      const key = `${info.host}:${info.port}:${info.fingerprint}`;
      if (webrtcFeeds.get(name)?.key === key) continue;
      dropWebRtcFeed(name);
      const entry: WebRtcFeed = { key, transport: null, handle: null };
      webrtcFeeds.set(name, entry);
      const mediaActor = state.mux ?? state.ui;
      if (!mediaActor) continue;
      void Transport.open(mediaActor, {
        purpose: MEDIA_PURPOSE,
        kinds: [WEBRTC_VIDEO_KIND],
        params: { secret, feed: name },
      }).then((transport) => {
        if (webrtcFeeds.get(name) !== entry) {
          transport.close("superseded");
          return;
        }
        entry.transport = transport;
        const handle = transport.connection as WebRtcVideoClientHandle;
        entry.handle = handle;
        handle.onSize = (width, height) => {
          status("connected");
          toUi({ feedSize: { feed: name, width, height } });
        };
        void transport.closed.then(() => {
          if (webrtcFeeds.get(name) !== entry) return;
          entry.transport = null;
          entry.handle = null;
          entry.key = "";
          setTimeout(() => {
            if (webrtcFeeds.get(name) === entry) updateFeeds(latestFeeds);
          }, 2000);
        });
      }).catch((error) => {
        console.warn(`webrtc media feed ${name}:`, error);
        if (webrtcFeeds.get(name) !== entry) return;
        entry.key = "";
        setTimeout(() => {
          if (webrtcFeeds.get(name) === entry) updateFeeds(latestFeeds);
        }, 2000);
      });
    } else {
      dropWebRtcFeed(name);
      if (!hasWebTransportVideo()) {
        status("video needs WebRTC (update this machine's agent) or HTTPS");
        continue;
      }
      webtransportFeeds[name] = info;
    }
  }
  for (const name of [...webrtcFeeds.keys()]) {
    if (!wantedWebRtc.has(name)) dropWebRtcFeed(name);
  }
  media?.update(webtransportFeeds);
}

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
    updateFeeds(message.media.feeds);
  }
}

let directoryUi: string | null = null;
let directoryMux: string | null = null;

/** Find the UI actor (from `rdp-liaison` directory or topic contacts) and open the transport to it. */
async function connect(): Promise<void> {
  for (;;) {
    const mux = directoryMux ??
      [...state.addressBook].find((id) => String(id).startsWith(`${MEDIA_MUX_ACTOR_NAME}@`));
    if (mux && state.mux !== mux) {
      state.mux = mux;
      if (Object.keys(latestFeeds).length > 0) updateFeeds(latestFeeds);
    }
    const ui = directoryUi ??
      [...state.addressBook].find((id) => String(id).startsWith(`${UI_ACTOR_NAME}@`));
    if (ui && (!tab || state.ui !== ui)) {
      if (tab && state.ui !== ui) tab.close("ui actor updated");
      state.ui = ui;
      status("connecting to the desktop…");
      try {
        const transport = await Promise.race([
          Transport.open(ui, {
            purpose: UI_PURPOSE,
            // WebTransport works from an https page anywhere; a WebSocket only from http or a
            // page on the same host.
            kinds: ["webtransport", "websocket"],
            params: { secret },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("connect timed out")), 5_000)
          ),
        ]);
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
    const replaced: FeedFrame[] = [];
    let video = media?.present(now, replaced) ?? false;
    for (const [name, entry] of webrtcFeeds) {
      const bitmap = entry.handle?.takeFrame();
      if (!bitmap) continue;
      video = true;
      const previous = view.setFeedFrame(name, bitmap);
      if (previous) replaced.push(previous);
    }
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
  ATTACH: async ({ canvas, viewport: initial, topic, secret: session, search, liaison }: Attach) => {
    secret = session;
    const searchParams = new URLSearchParams(search);
    forceWebRtc = searchParams.has("webrtc");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    media = new MediaFeeds(view, searchParams, (feed, width, height) => {
      toUi({ feedSize: { feed, width, height } });
    });
    const bridge = await Transport.open(System, {
      purpose: "page.bridge",
      kinds: ["messageport"],
    });
    const port = bridge.connection as MessagePort;
    page = port;
    const webrtcVideo = webRtcVideoBrowserTransport((cmd) => page?.postMessage(cmd));
    port.onmessage = (event) => {
      const message = event.data as { viewport?: TabViewport; dom?: TabDomEvent } | PageWebRtcEvent;
      if ("webrtc" in message) {
        webrtcVideo.handlePageEvent(message);
        return;
      }
      if (message.viewport) resize(message.viewport);
      else if (message.dom) toUi({ dom: message.dom });
    };
    resize(initial);
    registerTransportKind(webSocketTransport());
    registerTransportKind(webTransportTransport());
    registerTransportKind(webrtcVideo);
    if (!liaison) PostMan.setTopic(topic);
    status("looking for the desktop…");
    void connect();
    schedule();
    return true;
  },
  DIRECTORY: (payload: { services: SessionDirectory }) => {
    const services = payload?.services ?? {};
    if (services.ui) directoryUi = services.ui;
    if (services.mediaMux) {
      directoryMux = services.mediaMux;
      if (state.mux !== services.mediaMux) {
        state.mux = services.mediaMux;
        if (Object.keys(latestFeeds).length > 0) updateFeeds(latestFeeds);
      }
    }
    return true;
  },
  __HEALTH__: () => ({ ...state, addressBook: [...state.addressBook] }),
} as const);

/**
 * rdp UI actor: renders the remote desktop app for a browser tab.
 *
 * It joins the session's topic, so the tab's client actor finds it, and accepts one `rdp.ui`
 * transport at a time: WebTransport with a pinned self-signed certificate
 * (`classes/selfSignedCert.ts`), so a page served over https anywhere can reach it, or a WebSocket.
 * The descriptor travels over the actor route, never the topic. A tab must present the session secret in its offer
 * (`classes/session.ts`); any other transport is closed before anything is sent. The app runs in a headless browser tab sized to the real one
 * (`classes/browserTab.ts`); the tab's DOM events are dispatched into it, and its scene is sent
 * back as raythree store deltas, "latest since ack" (`classes/sceneFeed.ts`).
 *
 * With `source` (desktopSource) the tab is told where to receive the desktop's video; with
 * `input` (desktopInput) pointer and keys on the video drive the desktop, over a negotiated
 * `rdp.input` transport.
 */
import React from "react";
import {
  type ActorId,
  actorState,
  messages,
  PostMan,
  registerTransportKind,
  Transport,
  type TransportMessages,
  webSocketTransport,
  webTransportTransport,
} from "../submodules/stageforge/mod.ts";
import { CERT_RENEW_MS, selfSignedCertificate } from "./classes/selfSignedCert.ts";
import { type BrowserTab, createBrowserTab } from "./classes/browserTab.ts";
import { SceneFeed } from "./classes/sceneFeed.ts";
import {
  type FeedInfo,
  isTabDomEvent,
  isViewport,
  type ToTab,
  type ToUi,
  UI_ACTOR_NAME,
  UI_PURPOSE,
} from "./classes/tabProtocol.ts";
import { DESKTOP_FEED, type DesktopInputSink, RdpApp } from "./app.tsx";
import { sameSecret, sessionTopic } from "./classes/session.ts";
import type { InputEvent } from "./desktopInput.ts";

export type UiStart = {
  /** The session secret; the topic is derived from it, and tabs must present it. */
  secret: string;
  /** Where the tab's WebSocket reaches this actor (a tailnet address); default loopback. */
  websocket?: { hostname?: string; port?: number; publicUrl?: string };
  /**
   * Where the tab's WebTransport reaches this actor; default the websocket hostname. False: no
   * WebTransport (it needs --unstable-net and openssl).
   */
  webtransport?: { hostname?: string; port?: number; publicHost?: string } | false;
  source?: ActorId;
  input?: ActorId;
};

const FRAME_MS = 16;
const FEED_POLL_MS = 2000;

const state = actorState({
  name: UI_ACTOR_NAME,
  topic: null as string | null,
  tabConnected: false,
  viewport: null as { width: number; height: number; dpr: number } | null,
  frames: 0,
  deltasSent: 0,
  bytesSent: 0,
  domEvents: 0,
  rejected: 0,
  /** The transport kind of the connected tab. */
  tabKind: null as string | null,
  webtransport: false,
  feed: null as FeedInfo | null,
  inputConnected: false,
  lastError: null as string | null,
});

let config: UiStart | null = null;
let secret = "";
let browserTab: BrowserTab | null = null;
let session: { tab: TransportMessages; feed: SceneFeed } | null = null;
let feedSize: { width: number; height: number } | null = null;
let input: TransportMessages | null = null;
let lastCamera = "";
let frameTimer: ReturnType<typeof setInterval> | null = null;
let certTimer: ReturnType<typeof setTimeout> | null = null;
let feedTimer: ReturnType<typeof setInterval> | null = null;

const inputSink: DesktopInputSink = {
  send(event: InputEvent) {
    if (input && !input.isClosed) input.send(event);
  },
};

function send(message: ToTab): void {
  if (session && !session.tab.isClosed) session.tab.send(message);
}

function render(): void {
  if (!browserTab) return;
  const status = !config?.source
    ? "no desktop source"
    : state.feed
    ? feedSize ? `${feedSize.width}x${feedSize.height}` : "connecting video..."
    : "desktop feed not running";
  browserTab.render(
    <RdpApp
      input={input ? inputSink : null}
      feed={state.feed ? feedSize ?? { width: 16, height: 9 } : null}
      status={status}
    />,
  );
}

function frame(): void {
  if (!browserTab || !session) return;
  try {
    browserTab.frame();
    session.feed.write(browserTab.scene, browserTab.camera);
    state.frames++;
    const camera = browserTab.camera;
    camera.updateMatrixWorld();
    const view = JSON.stringify([camera.projectionMatrix.elements, camera.matrixWorld.elements]);
    if (view !== lastCamera) {
      lastCamera = view;
      send({
        camera: {
          projection: [...camera.projectionMatrix.elements],
          world: [...camera.matrixWorld.elements],
        },
      });
    }
    const bytes = session.feed.next();
    if (bytes) send(bytes);
    state.deltasSent = session.feed.deltasSent;
    state.bytesSent = session.feed.bytesSent;
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.stack ?? error : error);
  }
}

async function pollFeed(): Promise<void> {
  if (!config?.source) return;
  let feed: FeedInfo | null = null;
  try {
    feed = await PostMan.PostMessage(
      { target: config.source, type: "FEED", payload: null },
      true,
    ) as FeedInfo | null;
  } catch (error) {
    state.lastError = `FEED: ${error}`;
  }
  if (JSON.stringify(feed) === JSON.stringify(state.feed)) return;
  state.feed = feed;
  send({ media: { feeds: feed ? { [DESKTOP_FEED]: feed } : {} } });
  render();
}

async function connectInput(): Promise<void> {
  if (!config?.input || (input && !input.isClosed)) return;
  try {
    input = messages(await Transport.open(config.input, { purpose: "rdp.input" }));
    state.inputConnected = true;
    input.onclose = () => {
      state.inputConnected = false;
      input = null;
      render();
    };
  } catch (error) {
    state.lastError = `input: ${error}`;
  }
  render();
}

async function onTab(transport: Transport): Promise<void> {
  if (!sameSecret(transport.info.params.secret, secret)) {
    state.rejected++;
    transport.close("not part of this session");
    return;
  }
  // One tab: a new one replaces the old.
  session?.tab.close("replaced by a newer tab");
  const tab = messages(transport);
  const current = { tab, feed: new SceneFeed() };
  session = current;
  lastCamera = "";
  state.tabConnected = true;
  state.tabKind = transport.kind;
  tab.onclose = () => {
    if (session !== current) return;
    session = null;
    state.tabConnected = false;
  };
  tab.onmessage = async (raw) => {
    const message = raw as ToUi;
    if ("ack" in message) {
      current.feed.acked(message.ack);
    } else if ("resync" in message) {
      current.feed.resync();
    } else if ("viewport" in message && isViewport(message.viewport)) {
      state.viewport = message.viewport;
      if (!browserTab) {
        browserTab = await createBrowserTab(message.viewport);
        render();
      } else browserTab.resize(message.viewport);
    } else if ("dom" in message && isTabDomEvent(message.dom)) {
      state.domEvents++;
      browserTab?.dispatch(message.dom);
    } else if ("feedSize" in message && message.feedSize?.feed === DESKTOP_FEED) {
      const { width, height } = message.feedSize;
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        feedSize = { width, height };
        render();
      }
    } else {
      state.rejected++;
    }
  };
  // What the tab needs before its first frame.
  send({ media: { feeds: state.feed ? { [DESKTOP_FEED]: state.feed } : {} } });
}

/**
 * Listen on WebTransport with a fresh certificate, and again with a new one before it expires.
 * A renewal replaces the kind for new tabs; the old listener stays up for the tab it carries.
 */
async function listenWebTransport(options: Exclude<UiStart["webtransport"], false>): Promise<void> {
  if (typeof (Deno as { QuicEndpoint?: unknown }).QuicEndpoint !== "function") {
    state.lastError = "webtransport: needs --unstable-net; tabs use websocket";
    return;
  }
  try {
    registerTransportKind(webTransportTransport({
      certificate: await selfSignedCertificate(),
      hostname: options?.hostname ?? config?.websocket?.hostname ?? "127.0.0.1",
      port: options?.port,
      publicHost: options?.publicHost,
      reach: "network",
    }));
    state.webtransport = true;
  } catch (error) {
    state.lastError = `webtransport: ${error}`;
  }
  certTimer = setTimeout(() => void listenWebTransport({ ...options, port: undefined }), CERT_RENEW_MS);
}

function stop(): void {
  if (certTimer) clearTimeout(certTimer);
  certTimer = null;
  if (frameTimer) clearInterval(frameTimer);
  if (feedTimer) clearInterval(feedTimer);
  frameTimer = feedTimer = null;
  session?.tab.close("ui stopped");
  session = null;
  input?.close("ui stopped");
  input = null;
  browserTab?.dispose();
  browserTab = null;
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    START: async (payload: UiStart) => {
      if (config) return { topic: state.topic };
      if (typeof payload?.secret !== "string" || payload.secret.length < 16) {
        throw new Error("START needs the session secret (16+ characters)");
      }
      config = payload;
      secret = payload.secret;
      const topic = await sessionTopic(secret);
      registerTransportKind(webSocketTransport({
        hostname: payload.websocket?.hostname ?? "127.0.0.1",
        port: payload.websocket?.port,
        publicUrl: payload.websocket?.publicUrl,
        // The address is where browsers reach this machine (loopback for one on it), and a
        // browser is always "network" away.
        reach: "network",
      }));
      if (payload.webtransport !== false) await listenWebTransport(payload.webtransport);
      Transport.accept(UI_PURPOSE, (transport) => onTab(transport));
      frameTimer = setInterval(frame, FRAME_MS);
      if (payload.source) {
        void pollFeed();
        feedTimer = setInterval(() => void pollFeed(), FEED_POLL_MS);
      }
      await connectInput();
      PostMan.setTopic(topic);
      state.topic = topic;
      return { topic };
    },
    __SHUTDOWN__: () => stop(),
  } as const,
);

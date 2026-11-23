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
 * Desktops: this machine's (`source`, `input`), and with a household (`classes/household.ts`)
 * every desktopSource on its topic, other machines' included. The tab shows one, picked in the
 * toolbar: it receives that desktop's video straight from its encoder, and pointer and keys on
 * the video drive its desktopInput (over `rdp.input` in this process, as messages over iroh to
 * another machine). Household desktops are asked through `GUARDED` with a proof.
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
import { newSessionId, sameSecret, sessionTopic } from "./classes/session.ts";
import { householdProof } from "./classes/household.ts";
import { MEDIA_PURPOSE, webRtcVideoServerTransport } from "./classes/webRtcVideoTransport.ts";
import type { WindowInfo } from "./classes/windowCapture.ts";
import type { InputEvent } from "./desktopInput.ts";

export type UiStart = {
  /** Public rendezvous topic for this session; omit or pass `false` when `rdp-liaison` handles discovery. */
  topic?: string | false;
  /** The session secret; tabs must present it when opening `rdp.ui`. */
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
  /** Find other machines' desktops on the household topic, and ask them with proofs. */
  household?: { secret: string; topic: string };
};

type Desktop = {
  source: ActorId;
  input: ActorId | null;
  machine: string;
  /** This process's own; the rest are reached over iroh. */
  local: boolean;
  feed: FeedInfo | null;
  startRequested: boolean;
};

const FRAME_MS = 16;
const FEED_POLL_MS = 2000;
const START_RETRY_MS = 10_000;

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
  desktops: [] as Array<{ source: string; machine: string; local: boolean; feed: boolean }>,
  selected: null as string | null,
  inputConnected: false,
  lastError: null as string | null,
});

let config: UiStart | null = null;
let secret = "";
let browserTab: BrowserTab | null = null;
let session: { tab: TransportMessages; feed: SceneFeed } | null = null;
let feedSize: { width: number; height: number } | null = null;
let input: TransportMessages | null = null;
/** Input for a desktop on another machine: messages to its desktopInput. */
let remoteInput: ActorId | null = null;
const desktops = new Map<ActorId, Desktop>();
let selected: ActorId | null = null;
let windows: WindowInfo[] = [];
let selectedWindow: WindowInfo | null = null;
let windowFeed: FeedInfo | null = null;
const proofs = new Map<string, Promise<string>>();
let lastCamera = "";
let frameTimer: ReturnType<typeof setInterval> | null = null;
let certTimer: ReturnType<typeof setTimeout> | null = null;
let feedTimer: ReturnType<typeof setInterval> | null = null;

function mapInputEvent(event: InputEvent): InputEvent {
  const region = selectedWindow?.region;
  if (!region || event.t !== "pointer") return event;
  let ry = region.y;
  let rh = region.height;
  // When KWin/WGC streams only the client area while window geometry includes the top titlebar,
  // trim the top of `region` by the logical height difference (anchored at the bottom edge).
  if (
    feedSize && selectedWindow && selectedWindow.width > 0 && selectedWindow.height > 0 &&
    feedSize.width > 0 && feedSize.height > 0
  ) {
    const scaleX = feedSize.width / selectedWindow.width;
    const logicalFeedH = feedSize.height / scaleX;
    const titlebarLogical = selectedWindow.height - logicalFeedH;
    if (titlebarLogical > 2 && titlebarLogical < 120) {
      const trimFrac = titlebarLogical / selectedWindow.height;
      ry += trimFrac * rh;
      rh *= 1 - trimFrac;
    }
  }
  return {
    t: "pointer",
    x: Math.min(1, Math.max(0, region.x + event.x * region.width)),
    y: Math.min(1, Math.max(0, ry + event.y * rh)),
  };
}

const inputSink: DesktopInputSink = {
  send(event: InputEvent) {
    if (event.t === "button" && event.down && selectedWindow && selected) {
      const desktop = desktops.get(selected);
      if (desktop) {
        void request(desktop.source, "FOCUSWINDOW", { window: selectedWindow.id }).catch(() => {});
      }
    }
    const mapped = mapInputEvent(event);
    if (input && !input.isClosed) input.send(mapped);
    else if (remoteInput) void request(remoteInput, "INPUT", mapped).catch(() => {});
  },
};

function proof(actor: string): Promise<string> {
  let made = proofs.get(actor);
  if (!made) proofs.set(actor, made = householdProof(config!.household!.secret, actor));
  return made;
}

/** Ask a desktop's actor: `GUARDED` with a proof in a household (this machine's too), else directly. */
async function request<T>(target: ActorId, type: string, payload: unknown = null): Promise<T> {
  if (config?.household) {
    return await PostMan.PostMessage({
      target,
      type: "GUARDED",
      payload: { proof: await proof(target), type, payload },
    }, true) as T;
  }
  return await PostMan.PostMessage({ target, type, payload }, true) as T;
}

function summarize(): void {
  state.desktops = [...desktops.values()].map((d) => ({
    source: d.source,
    machine: d.machine,
    local: d.local,
    feed: d.feed != null,
  }));
  state.selected = selected;
  state.feed = selectedWindow ? windowFeed : (selected ? desktops.get(selected)?.feed ?? null : null);
}

function send(message: ToTab): void {
  if (session && !session.tab.isClosed) session.tab.send(message);
}

function render(): void {
  if (!browserTab) return;
  const desktop = selected ? desktops.get(selected) : undefined;
  const activeFeed = selectedWindow ? windowFeed : desktop?.feed ?? null;
  const status = !desktop
    ? "no desktop found yet"
    : activeFeed
    ? feedSize ? `${feedSize.width}x${feedSize.height}` : "connecting video..."
    : selectedWindow
    ? "starting window capture..."
    : "starting the desktop's video...";
  browserTab.render(
    <RdpApp
      input={input || remoteInput ? inputSink : null}
      feed={activeFeed ? feedSize ?? { width: 16, height: 9 } : null}
      status={status}
      desktops={[...desktops.values()].map((d) => ({
        id: d.source,
        label: d.local ? `${d.machine} (here)` : d.machine,
      }))}
      selected={selected}
      onSelect={(id) => void select(id as ActorId)}
      windows={windows.map((w) => ({ id: w.id, title: w.title, app: w.app }))}
      selectedWindow={selectedWindow?.id ?? null}
      onSelectWindow={(id) => void selectWindow(id)}
      onRefreshWindows={() => void refreshWindows()}
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

/** Find desktops: this process's, and the household topic's desktopSources. */
async function discover(): Promise<void> {
  if (config?.source && !desktops.has(config.source)) {
    desktops.set(config.source, {
      source: config.source,
      input: config.input ?? null,
      machine: Deno.hostname(),
      local: true,
      feed: null,
      startRequested: true, // this process started it
    });
  }
  if (config?.household) {
    const known = new Set([...state.addressBook].map(String));
    // A machine whose agent left (or restarted, under a new actor id) drops off the list.
    for (const [id, desktop] of desktops) if (!desktop.local && !known.has(id)) forget(id);
    for (const id of known) {
      if (!id.startsWith("desktopSource@") || desktops.has(id as ActorId)) continue;
      try {
        const described = await request<{ machine: string; input: ActorId | null }>(id as ActorId, "DESCRIBE");
        // The same machine under a new id is its agent restarted; its old entry is gone.
        for (const [old, desktop] of desktops) {
          if (!desktop.local && desktop.machine === described.machine) forget(old);
        }
        desktops.set(id as ActorId, {
          source: id as ActorId,
          input: described.input,
          machine: described.machine,
          local: false,
          feed: null,
          startRequested: false,
        });
      } catch (error) {
        report(`DESCRIBE ${id}: ${error}`);
      }
    }
  }
  if (!selected && desktops.size) await select([...desktops.keys()][0]);
  summarize();
}

function forget(id: ActorId): void {
  desktops.delete(id);
  if (selected !== id) return;
  releaseInput("desktop left");
  selected = null;
  sendMedia();
}

/** Errors go to the health report and this process's log; the page shows no errors yet. */
function report(error: string): void {
  if (state.lastError === error) return;
  state.lastError = error;
  console.error(`[rdp] ${error}`);
}

/** Keep the selected desktop's feed current, starting its encoder when it is not running. */
async function pollFeed(): Promise<void> {
  await discover();
  const desktop = selected ? desktops.get(selected) : undefined;
  if (!desktop) return render();
  let feed: FeedInfo | null = null;
  try {
    feed = await request<FeedInfo | null>(desktop.source, "FEED");
    if (!feed && !desktop.startRequested) {
      desktop.startRequested = true;
      try {
        feed = await request<FeedInfo>(desktop.source, "START");
      } catch (error) {
        // Ask again later; a capture the user refused is not retried by the source anyway.
        setTimeout(() => desktop.startRequested = false, START_RETRY_MS);
        throw error;
      }
    }
  } catch (error) {
    report(`FEED ${desktop.machine}: ${error}`);
  }
  if (JSON.stringify(feed) === JSON.stringify(desktop.feed)) return;
  desktop.feed = feed;
  summarize();
  sendMedia();
  render();
}

function sendMedia(): void {
  const feed = selectedWindow ? windowFeed : (selected ? desktops.get(selected)?.feed : null);
  send({ media: { feeds: feed ? { [DESKTOP_FEED]: feed } : {} } });
}

async function refreshWindows(): Promise<void> {
  const desktop = selected ? desktops.get(selected) : undefined;
  if (!desktop) {
    windows = [];
    render();
    return;
  }
  try {
    const listed = await request<WindowInfo[]>(desktop.source, "LISTWINDOWS");
    if (selected !== desktop.source) return;
    windows = Array.isArray(listed) ? listed : [];
    if (selectedWindow) {
      const updated = windows.find((w) => w.id === selectedWindow!.id);
      if (updated) selectedWindow = updated;
    }
  } catch {
    windows = [];
  }
  render();
}

async function stopActiveWindow(): Promise<void> {
  const prev = selectedWindow;
  const desktop = selected ? desktops.get(selected) : undefined;
  selectedWindow = null;
  windowFeed = null;
  if (prev && desktop) {
    await request(desktop.source, "STOP", { window: prev.id }).catch(() => {});
  }
}

async function selectWindow(windowId: string | null): Promise<void> {
  const desktop = selected ? desktops.get(selected) : undefined;
  if (!desktop) return;
  if (selectedWindow?.id === windowId) return;
  await stopActiveWindow();
  feedSize = null;
  if (!windowId) {
    summarize();
    sendMedia();
    render();
    return;
  }
  const win = windows.find((w) => w.id === windowId);
  if (!win) return;
  selectedWindow = win;
  summarize();
  sendMedia();
  render();
  try {
    const feed = await request<FeedInfo>(desktop.source, "START", { window: win.id });
    if (selectedWindow?.id !== win.id) {
      await request(desktop.source, "STOP", { window: win.id }).catch(() => {});
      return;
    }
    windowFeed = feed;
    summarize();
    sendMedia();
    render();
  } catch (error) {
    report(`START window ${win.title}: ${error}`);
    selectedWindow = null;
    windowFeed = null;
    summarize();
    sendMedia();
    render();
  }
}

/** Show another desktop: its video, and input to its desktopInput. */
async function select(id: ActorId): Promise<void> {
  if (selected === id || !desktops.has(id)) return;
  await stopActiveWindow();
  windows = [];
  releaseInput("switched desktops");
  selected = id;
  feedSize = null;
  summarize();
  sendMedia();
  render();
  await connectInput();
  void pollFeed();
}

function releaseInput(reason: string): void {
  input?.close(reason);
  input = null;
  if (remoteInput) void request(remoteInput, "RELEASEALL").catch(() => {});
  remoteInput = null;
  state.inputConnected = false;
}

async function connectInput(): Promise<void> {
  const desktop = selected ? desktops.get(selected) : undefined;
  if (!desktop?.input || input || remoteInput) return;
  if (!desktop.local) {
    remoteInput = desktop.input;
    state.inputConnected = true;
    return render();
  }
  try {
    const opened = messages(
      await Transport.open(desktop.input, {
        purpose: "rdp.input",
        params: config?.household ? { proof: await proof(desktop.input) } : {},
      }),
    );
    if (selected !== desktop.source) return opened.close("switched desktops");
    input = opened;
    state.inputConnected = true;
    opened.onclose = () => {
      if (input !== opened) return;
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
    // Nothing may stay held on a desktop nobody is looking at.
    if (remoteInput) void request(remoteInput, "RELEASEALL").catch(() => {});
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
  sendMedia();
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
  releaseInput("ui stopped");
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
      const topic = payload.topic === false
        ? null
        : payload.topic ?? sessionTopic(newSessionId());
      registerTransportKind(webSocketTransport({
        hostname: payload.websocket?.hostname ?? "127.0.0.1",
        port: payload.websocket?.port,
        publicUrl: payload.websocket?.publicUrl,
        // The address is where browsers reach this machine (loopback for one on it), and a
        // browser is always "network" away.
        reach: "network",
      }));
      if (payload.webtransport !== false) await listenWebTransport(payload.webtransport);
      registerTransportKind(webRtcVideoServerTransport(async (params, offerSdp) => {
        if (!sameSecret(params.secret, secret)) {
          state.rejected++;
          throw new Error("not part of this session");
        }
        const desktop = selected ? desktops.get(selected) : undefined;
        if (!desktop) throw new Error("no desktop selected");
        const { sdp } = await request<{ sdp: string }>(desktop.source, "WEBRTC_OFFER", {
          sdp: offerSdp,
          ...(selectedWindow ? { window: selectedWindow.id } : {}),
        });
        return sdp;
      }));
      Transport.accept(UI_PURPOSE, (transport) => onTab(transport));
      Transport.accept(MEDIA_PURPOSE, () => {});
      frameTimer = setInterval(frame, FRAME_MS);
      if (payload.household) PostMan.setTopic(payload.household.topic);
      await discover();
      void pollFeed();
      feedTimer = setInterval(() => void pollFeed(), FEED_POLL_MS);
      if (topic) PostMan.setTopic(topic);
      state.topic = topic;
      return { topic };
    },
    __SHUTDOWN__: () => stop(),
  } as const,
);

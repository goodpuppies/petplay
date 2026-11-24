/**
 * compositor: hot-reloadable multi-machine desktop compositor actor.
 *
 * Composes `WallpaperFeed`, `FloatingWindow`, and `Taskbar` over headless R3F + uikit
 * (`BrowserTab`), streaming scene deltas to 1..N connected `rdp-tab` viewers while delegating:
 * - all stream discovery, refcounted capture, and WebRTC signaling to `mediaMux`, and
 * - all coordinate mapping and local/remote input injection to `inputRouter`.
 *
 * Because `mediaMux` and `inputRouter` live in their own long-lived actors, reloading
 * `compositor` (`__SNAPSHOT__` / `__RESTORE__`) preserves open windows and active streams
 * without restarting any encoder or capture session.
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
import { newSessionId, sameSecret, sessionTopic } from "./classes/session.ts";
import {
  type FeedInfo,
  isTabDomEvent,
  isViewport,
  type ToTab,
  type ToUi,
  UI_ACTOR_NAME,
  UI_PURPOSE,
} from "./classes/tabProtocol.ts";
import type { WindowInfo } from "./classes/windowCapture.ts";
import type { InputEvent, InputRegion } from "./desktopInput.ts";
import type { RoutedInput } from "./inputRouter.ts";
import type { FeedTarget, SourceSummary } from "./mediaMux.ts";
import {
  FloatingWindow,
  type FloatingWindowData,
  WINDOW_TITLEBAR_HEIGHT,
} from "./components/FloatingWindow.tsx";
import { Taskbar } from "./components/Taskbar.tsx";
import { WallpaperFeed } from "./components/WallpaperFeed.tsx";

export type CompositorStart = {
  /** Session topic; omit or pass `false` when `rdp-liaison` handles discovery. */
  topic?: string | false;
  secret: string;
  mediaMux: ActorId;
  inputRouter: ActorId;
  websocket?: { hostname?: string; port?: number; publicUrl?: string };
  webtransport?: { hostname?: string; port?: number; publicHost?: string } | false;
};

type WindowEntry = FloatingWindowData & {
  source: ActorId;
  target: FeedTarget;
  /** Shared stream key in `ToTab.media.feeds` (equals `feedId` unless backed by an atlas). */
  streamId?: string;
  windowId?: string;
  region?: InputRegion;
  windowSize?: { width: number; height: number };
};

type WallpaperEntry = {
  source: ActorId;
  target: FeedTarget;
  feedId: string;
  label: string;
};

type TabSession = {
  id: string;
  peer: string;
  tab: TransportMessages;
  feed: SceneFeed;
  lastCamera: string;
};

export type CompositorSnapshot = {
  config: CompositorStart | null;
  windows: WindowEntry[];
  wallpaper: WallpaperEntry | null;
  focusedId: string | null;
  nextWindowSeq: number;
};

const FRAME_MS = 16;
/**
 * Host window pixels per compositor CSS pixel. At `2`, apps inside windows run at 2× the
 * compositor's CSS dimensions (behaving like 50% browser zoom) while compositor chrome
 * (titlebars, taskbar, menus) stays at 100% scale.
 */
const WINDOW_CONTENT_SCALE = 2;

const state = actorState({
  name: UI_ACTOR_NAME,
  topic: null as string | null,
  viewers: 0,
  tabPeers: [] as string[],
  viewport: null as { width: number; height: number; dpr: number } | null,
  frames: 0,
  domEvents: 0,
  rejected: 0,
  webtransport: false,
  windowCount: 0,
  wallpaper: null as string | null,
  lastError: null as string | null,
});

let config: CompositorStart | null = null;
let secret = "";
let browserTab: BrowserTab | null = null;
const tabs = new Map<string, TabSession>();
let nextTabSeq = 1;
let inputChannel: TransportMessages | null = null;
let sources: SourceSummary[] = [];
let feeds: Record<string, FeedInfo> = {};
const feedSizes = new Map<string, { width: number; height: number }>();
let windowsBySource: Record<string, WindowInfo[]> = {};

let windows: WindowEntry[] = [];
let wallpaper: WallpaperEntry | null = null;
let focusedId: string | null = null;
let nextWindowSeq = 1;
let autoWallpaperTried = false;

let frameTimer: ReturnType<typeof setInterval> | null = null;
let certTimer: ReturnType<typeof setTimeout> | null = null;

function call<T>(target: ActorId, type: string, payload: unknown = null): Promise<T> {
  return PostMan.PostMessage({ target, type, payload }, true) as Promise<T>;
}

function broadcast(message: ToTab): void {
  for (const session of tabs.values()) {
    if (!session.tab.isClosed) session.tab.send(message);
  }
}

function broadcastMedia(): void {
  broadcast({ media: { feeds } });
}

function syncState(): void {
  state.viewers = tabs.size;
  state.tabPeers = [...tabs.values()].map((t) => t.peer);
  state.windowCount = windows.length;
  state.wallpaper = wallpaper?.label ?? null;
}

function sendWindowInput(win: WindowEntry, event: InputEvent): void {
  const src = sources.find((s) => s.actor === win.source);
  if (!src?.input) return;
  const frame: RoutedInput = {
    inputActor: src.input,
    local: src.local,
    guarded: src.guarded,
    region: win.region,
    windowSize: win.windowSize,
    feedSize: win.srcSize ?? feedSizes.get(win.streamId ?? win.feedId),
    focus: win.windowId
      ? { source: win.source, window: win.windowId, guarded: src.guarded }
      : undefined,
    event,
  };
  if (inputChannel && !inputChannel.isClosed) {
    inputChannel.send(frame);
  } else if (config?.inputRouter) {
    void call(config.inputRouter, "ROUTE", frame).catch(() => {});
  }
}

function focusWindow(id: string | null): void {
  if (id === null) {
    focusedId = null;
    if (config?.inputRouter) void call(config.inputRouter, "RELEASEALL").catch(() => {});
    render();
    return;
  }
  const idx = windows.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const [win] = windows.splice(idx, 1);
  win!.minimized = false;
  windows.push(win!);
  focusedId = id;
  if (win!.windowId && config?.mediaMux) {
    void call(config.mediaMux, "FOCUS", { source: win!.source, window: win!.windowId }).catch(
      () => {},
    );
  }
  render();
}

function moveWindow(id: string, x: number, y: number, width: number, height: number): void {
  const win = windows.find((w) => w.id === id);
  if (!win) return;
  win.x = x;
  win.y = y;
  win.width = width;
  win.height = height;
  render();
}

async function resizeHostWindow(id: string, width: number, height: number): Promise<void> {
  const win = windows.find((w) => w.id === id);
  if (!win?.windowId || !config?.mediaMux) return;
  const contentH = Math.max(120, height - WINDOW_TITLEBAR_HEIGHT);
  const updated = await call<WindowInfo | null>(config.mediaMux, "RESIZE", {
    source: win.source,
    window: win.windowId,
    width: Math.round(width * WINDOW_CONTENT_SCALE),
    height: Math.round(contentH * WINDOW_CONTENT_SCALE),
  }).catch(() => null);
  if (updated) {
    win.region = updated.region;
    win.windowSize = { width: updated.width, height: updated.height };
  }
}

function setMinimized(id: string, minimized?: boolean): void {
  const win = windows.find((w) => w.id === id);
  if (!win) return;
  win.minimized = minimized ?? !win.minimized;
  if (win.minimized && focusedId === id) {
    focusedId = [...windows].reverse().find((w) => !w.minimized)?.id ?? null;
  } else if (!win.minimized) {
    focusWindow(id);
    return;
  }
  render();
}

function toggleMute(id: string, muted?: boolean): void {
  const win = windows.find((w) => w.id === id);
  if (!win) return;
  win.muted = muted ?? !win.muted;
  render();
}

async function closeWindow(id: string): Promise<void> {
  const idx = windows.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const [removed] = windows.splice(idx, 1);
  if (focusedId === id) {
    focusedId = [...windows].reverse().find((w) => !w.minimized)?.id ?? null;
  }
  syncState();
  render();
  if (removed && config?.mediaMux) {
    await call(config.mediaMux, "RELEASE", { feedId: removed.feedId }).catch(() => {});
  }
}

async function openWindow(req: {
  source: ActorId;
  window?: WindowInfo;
  target?: FeedTarget;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Promise<{ id: string; feedId: string }> {
  if (!config?.mediaMux) throw new Error("compositor not started");
  const src = sources.find((s) => s.actor === req.source);
  const target: FeedTarget = req.target ??
    (req.window ? { kind: "window", window: req.window.id } : { kind: "desktop" });

  // If this exact (source, window) is already open, just focus it.
  if (target.kind === "window") {
    const existing = windows.find((w) => w.source === req.source && w.windowId === target.window);
    if (existing) {
      focusWindow(existing.id);
      return { id: existing.id, feedId: existing.feedId };
    }
  }

  const { feedId, info } = await call<{ feedId: string; info: FeedInfo }>(
    config.mediaMux,
    "ACQUIRE",
    { source: req.source, target },
  );
  const streamKey = info.streamId ?? feedId;
  feeds = { ...feeds, [streamKey]: info };
  broadcastMedia();

  const vp = state.viewport ?? { width: 1280, height: 720 };
  const cascade = (windows.length % 8) * 32;
  const hostW = req.window?.width != null
    ? Math.round(req.window.width / WINDOW_CONTENT_SCALE)
    : 760;
  const hostH = req.window?.height != null
    ? Math.round(req.window.height / WINDOW_CONTENT_SCALE)
    : 480;
  const defaultW = Math.min(Math.round(vp.width * 0.72), Math.max(400, hostW));
  const defaultH = Math.min(
    Math.round((vp.height - 60) * 0.8),
    Math.max(280, hostH + WINDOW_TITLEBAR_HEIGHT),
  );
  const id = `w${nextWindowSeq++}`;
  const entry: WindowEntry = {
    id,
    feedId,
    streamId: info.streamId,
    source: req.source,
    target,
    windowId: req.window?.id,
    region: req.window?.region,
    windowSize: req.window ? { width: req.window.width, height: req.window.height } : undefined,
    title: req.title ?? req.window?.title ?? (src ? `${src.machine} Desktop` : "Desktop"),
    machine: src?.machine ?? "remote",
    app: req.window?.app,
    x: req.x ?? Math.min(vp.width - defaultW - 20, 60 + cascade),
    y: req.y ?? Math.min(vp.height - defaultH - 60, 40 + cascade),
    width: req.width ?? defaultW,
    height: req.height ?? defaultH,
    minimized: false,
    muted: false,
    crop: info.crop,
    srcSize: info.srcSize,
  };
  windows.push(entry);
  focusedId = id;
  syncState();
  render();
  return { id, feedId };
}

async function setWallpaper(
  req: { source: ActorId; target?: FeedTarget } | null,
): Promise<true> {
  if (!config?.mediaMux) return true;
  const prev = wallpaper;
  wallpaper = null;
  if (prev) {
    await call(config.mediaMux, "RELEASE", { feedId: prev.feedId }).catch(() => {});
  }
  if (!req) {
    syncState();
    render();
    return true;
  }
  const src = sources.find((s) => s.actor === req.source);
  const target: FeedTarget = req.target ??
    (src?.kind === "vrchat" ? { kind: "vrchat" } : { kind: "desktop" });
  const { feedId, info } = await call<{ feedId: string; info: FeedInfo }>(
    config.mediaMux,
    "ACQUIRE",
    { source: req.source, target, feedId: "wallpaper" },
  );
  feeds = { ...feeds, [feedId]: info };
  wallpaper = {
    source: req.source,
    target,
    feedId,
    label: src?.machine ?? "Wallpaper",
  };
  broadcastMedia();
  syncState();
  render();
  return true;
}

async function refreshLauncher(): Promise<void> {
  if (!config?.mediaMux) return;
  try {
    sources = await call<SourceSummary[]>(config.mediaMux, "LISTSOURCES");
  } catch (error) {
    state.lastError = `LISTSOURCES: ${error}`;
  }
  const desktopSources = sources.filter((s) => s.kind === "desktop");
  const next: Record<string, WindowInfo[]> = {};
  await Promise.all(
    desktopSources.map(async (src) => {
      try {
        next[src.actor] = await call<WindowInfo[]>(config!.mediaMux, "LISTWINDOWS", {
          source: src.actor,
        });
      } catch {
        next[src.actor] = [];
      }
    }),
  );
  windowsBySource = next;
  // Refresh region/size for any already-open windows.
  for (const win of windows) {
    if (!win.windowId) continue;
    const updated = windowsBySource[win.source]?.find((w) => w.id === win.windowId);
    if (updated) {
      win.region = updated.region;
      win.windowSize = { width: updated.width, height: updated.height };
      win.title = updated.title;
    }
  }
  render();
}

function maybeAutoWallpaper(): void {
  if (autoWallpaperTried || wallpaper) return;
  const vrc = sources.find((s) => s.kind === "vrchat");
  if (!vrc) return;
  autoWallpaperTried = true;
  void setWallpaper({ source: vrc.actor, target: { kind: "vrchat" } }).catch((err) => {
    state.lastError = `vrchat wallpaper: ${err}`;
  });
}

function render(): void {
  if (!browserTab) return;
  const wpFeed = wallpaper ? feeds[wallpaper.feedId] : undefined;
  browserTab.render(
    <>
      <WallpaperFeed
        feedId={wallpaper && wpFeed ? wallpaper.feedId : null}
        feedSize={wallpaper ? feedSizes.get(wallpaper.feedId) ?? null : null}
        crop={wpFeed?.crop}
        onBackgroundClick={() => focusWindow(null)}
      />
      {windows.map((win, index) => {
        const streamKey = win.streamId ?? win.feedId;
        const src = sources.find((s) => s.actor === win.source);
        return (
          <FloatingWindow
            key={win.id}
            window={{ ...win, feedId: streamKey }}
            zBase={10 + index * 10}
            focused={win.id === focusedId}
            hasFeed={Boolean(feeds[streamKey])}
            hasAudio={Boolean(src?.audio)}
            onFocus={() => focusWindow(win.id)}
            onMove={(x, y, w, h) => moveWindow(win.id, x, y, w, h)}
            onResizeEnd={(w, h) => void resizeHostWindow(win.id, w, h)}
            onMinimize={() => setMinimized(win.id, true)}
            onMuteToggle={() => toggleMute(win.id)}
            onClose={() => void closeWindow(win.id)}
            onInput={(event) => sendWindowInput(win, event)}
          />
        );
      })}
      <Taskbar
        sources={sources}
        windowsBySource={windowsBySource}
        openWindows={windows}
        focusedWindowId={focusedId}
        wallpaperLabel={wallpaper?.label ?? null}
        viewerCount={tabs.size}
        onRefreshLauncher={() => void refreshLauncher()}
        onOpenWindow={(src, w) =>
          void openWindow({ source: src.actor, window: w }).catch((err) => {
            state.lastError = `openWindow: ${err}`;
            console.error("[compositor] openWindow:", err);
          })}
        onOpenDesktop={(src) =>
          void openWindow({
            source: src.actor,
            target: { kind: "desktop" },
            title: `${src.machine} Desktop`,
          }).catch((err) => {
            state.lastError = `openDesktop: ${err}`;
            console.error("[compositor] openDesktop:", err);
          })}
        onSelectWallpaper={(src) =>
          void setWallpaper(src ? { source: src.actor } : null).catch((err) => {
            state.lastError = `wallpaper: ${err}`;
          })}
        onWindowPillClick={(id) => {
          const win = windows.find((w) => w.id === id);
          if (!win) return;
          if (win.minimized || focusedId !== id) focusWindow(id);
          else setMinimized(id, true);
        }}
      />
    </>,
  );
}

function frame(): void {
  if (!browserTab || tabs.size === 0) return;
  try {
    browserTab.frame();
    const camera = browserTab.camera;
    camera.updateMatrixWorld();
    const viewJson = JSON.stringify([camera.projectionMatrix.elements, camera.matrixWorld.elements]);
    const camMsg: ToTab = {
      camera: {
        projection: [...camera.projectionMatrix.elements],
        world: [...camera.matrixWorld.elements],
      },
    };
    state.frames++;
    for (const session of tabs.values()) {
      if (session.tab.isClosed) continue;
      session.feed.write(browserTab.scene, camera);
      if (session.lastCamera !== viewJson) {
        session.lastCamera = viewJson;
        session.tab.send(camMsg);
      }
      const bytes = session.feed.next();
      if (bytes) session.tab.send(bytes);
    }
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.stack ?? error : error);
  }
}

async function onTab(transport: Transport): Promise<void> {
  if (!sameSecret(transport.info.params.secret, secret)) {
    state.rejected++;
    transport.close("not part of this session");
    return;
  }
  const id = `tab-${nextTabSeq++}`;
  const tab = messages(transport);
  const session: TabSession = {
    id,
    peer: String(transport.info.peer),
    tab,
    feed: new SceneFeed(),
    lastCamera: "",
  };
  tabs.set(id, session);
  syncState();

  tab.onclose = () => {
    tabs.delete(id);
    syncState();
    if (tabs.size === 0 && config?.inputRouter) {
      void call(config.inputRouter, "RELEASEALL").catch(() => {});
    }
    render();
  };

  tab.onmessage = async (raw) => {
    const message = raw as ToUi;
    if ("ack" in message) {
      session.feed.acked(message.ack);
    } else if ("resync" in message) {
      session.feed.resync();
    } else if ("viewport" in message && isViewport(message.viewport)) {
      state.viewport = message.viewport;
      if (!browserTab) {
        browserTab = await createBrowserTab(message.viewport);
        render();
      } else {
        browserTab.resize(message.viewport);
      }
    } else if ("dom" in message && isTabDomEvent(message.dom)) {
      state.domEvents++;
      browserTab?.dispatch(message.dom);
    } else if ("feedSize" in message && message.feedSize) {
      const { feed, width, height } = message.feedSize;
      if (
        typeof feed === "string" && Number.isFinite(width) && Number.isFinite(height) &&
        width > 0 && height > 0
      ) {
        feedSizes.set(feed, { width, height });
        render();
      }
    } else {
      state.rejected++;
    }
  };

  tab.send({ media: { feeds } } satisfies ToTab);
  render();
}

async function listenWebTransport(
  options: Exclude<CompositorStart["webtransport"], false>,
): Promise<void> {
  if (typeof (Deno as { QuicEndpoint?: unknown }).QuicEndpoint !== "function") {
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
  certTimer = setTimeout(
    () => void listenWebTransport({ ...options, port: undefined }),
    CERT_RENEW_MS,
  );
}

function stop(): void {
  if (certTimer) clearTimeout(certTimer);
  if (frameTimer) clearInterval(frameTimer);
  certTimer = frameTimer = null;
  for (const session of tabs.values()) session.tab.close("compositor stopped");
  tabs.clear();
  inputChannel?.close("compositor stopped");
  inputChannel = null;
  browserTab?.dispose();
  browserTab = null;
}

async function startCompositor(payload: CompositorStart): Promise<{ topic: string | null }> {
  if (config) return { topic: state.topic };
  if (typeof payload?.secret !== "string" || payload.secret.length < 16) {
    throw new Error("compositor START needs secret (16+ characters)");
  }
  config = payload;
  secret = payload.secret;
  const topic = payload.topic === false ? null : payload.topic ?? null;

  registerTransportKind(webSocketTransport({
    hostname: payload.websocket?.hostname ?? "127.0.0.1",
    port: payload.websocket?.port,
    publicUrl: payload.websocket?.publicUrl,
    reach: "network",
  }));
  if (payload.webtransport !== false) await listenWebTransport(payload.webtransport);

  Transport.accept(UI_PURPOSE, (transport) => onTab(transport));

  // Open direct messageport transport to inputRouter.
  try {
    inputChannel = messages(
      await Transport.open(payload.inputRouter, { purpose: "rdp.input" }),
    );
  } catch (error) {
    state.lastError = `inputRouter transport: ${error}`;
  }

  // Subscribe to mediaMux for source/feed updates and FEED_ENDED.
  const sub = await call<{ sources: SourceSummary[]; feeds: Record<string, FeedInfo> }>(
    payload.mediaMux,
    "SUBSCRIBE",
    { actor: state.id },
  );
  sources = sub.sources ?? [];
  feeds = sub.feeds ?? {};
  maybeAutoWallpaper();

  frameTimer = setInterval(frame, FRAME_MS);
  if (topic) PostMan.setTopic(topic);
  state.topic = topic;
  syncState();
  return { topic };
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    __SNAPSHOT__: (): CompositorSnapshot => ({
      config,
      windows: windows.map((w) => ({ ...w })),
      wallpaper: wallpaper ? { ...wallpaper } : null,
      focusedId,
      nextWindowSeq,
    }),
    __RESTORE__: async (snap: CompositorSnapshot) => {
      if (!snap) return true;
      windows = Array.isArray(snap.windows) ? snap.windows.map((w) => ({ ...w })) : [];
      wallpaper = snap.wallpaper ? { ...snap.wallpaper } : null;
      focusedId = snap.focusedId ?? null;
      nextWindowSeq = Math.max(nextWindowSeq, snap.nextWindowSeq ?? 1);
      if (snap.config && !config) await startCompositor(snap.config);
      syncState();
      render();
      return true;
    },
    START: (payload: CompositorStart) => startCompositor(payload),
    SOURCES_UPDATED: (payload: { sources: SourceSummary[] }) => {
      sources = payload?.sources ?? [];
      maybeAutoWallpaper();
      render();
      return true;
    },
    FEEDS_UPDATED: (payload: { feeds: Record<string, FeedInfo> }) => {
      feeds = payload?.feeds ?? {};
      broadcastMedia();
      render();
      return true;
    },
    WINDOW_LAYOUTS_UPDATED: (
      payload: {
        layouts?: Record<string, { crop?: FeedInfo["crop"]; srcSize?: { width: number; height: number } }>;
      },
    ) => {
      const layouts = payload?.layouts;
      if (!layouts) return true;
      let changed = false;
      for (const win of windows) {
        const slot = layouts[win.feedId];
        if (!slot) continue;
        if (slot.crop) win.crop = slot.crop;
        if (slot.srcSize) win.srcSize = slot.srcSize;
        changed = true;
      }
      if (changed) render();
      return true;
    },
    FEED_ENDED: (payload: { feedId: string }) => {
      const feedId = payload?.feedId;
      if (!feedId) return true;
      const before = windows.length;
      windows = windows.filter((w) => w.feedId !== feedId);
      if (wallpaper?.feedId === feedId) wallpaper = null;
      if (focusedId && !windows.some((w) => w.id === focusedId)) {
        focusedId = [...windows].reverse().find((w) => !w.minimized)?.id ?? null;
      }
      if (windows.length !== before || !wallpaper) {
        syncState();
        render();
      }
      return true;
    },
    SET_WALLPAPER: (payload: { source: ActorId; target?: FeedTarget } | null) =>
      setWallpaper(payload),
    OPEN_WINDOW: (
      payload: {
        source: ActorId;
        window?: WindowInfo;
        target?: FeedTarget;
        title?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      },
    ) => openWindow(payload),
    CLOSE_WINDOW: async (payload: { id: string }) => {
      await closeWindow(payload.id);
      return true;
    },
    FOCUS_WINDOW: (payload: { id: string | null }) => {
      focusWindow(payload?.id ?? null);
      return true;
    },
    MINIMIZE_WINDOW: (payload: { id: string; minimized?: boolean }) => {
      setMinimized(payload.id, payload.minimized);
      return true;
    },
    MUTE_WINDOW: (payload: { id: string; muted?: boolean }) => {
      toggleMute(payload.id, payload.muted);
      return true;
    },
    MOVE_WINDOW: (payload: { id: string; x: number; y: number; width: number; height: number }) => {
      moveWindow(payload.id, payload.x, payload.y, payload.width, payload.height);
      return true;
    },
    GET_STATE: () => ({
      sources,
      feeds,
      windows,
      wallpaper,
      focusedId,
      viewers: tabs.size,
    }),
    __SHUTDOWN__: () => stop(),
  } as const,
);

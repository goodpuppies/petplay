/**
 * studio: stageforge UI actor for the PetPlay UI web previewer, mirroring `rdp/ui.tsx`.
 *
 * Runs the React/r3f/uikit preview studio in a headless `BrowserTab` (`rdp/classes/browserTab.ts`),
 * extracts raythree IR into a `SceneFeed` (`rdp/classes/sceneFeed.ts`), and serves both the built
 * static page (`dist/ui/`) and the `/tab` WebSocket on one port so the browser renders the live
 * scene store onto an `OffscreenCanvas` and forwards DOM events back.
 */
import React from "react";
import { fromFileUrl } from "@std/path";
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { type BrowserTab, createBrowserTab } from "../rdp/classes/browserTab.ts";
import { SceneFeed } from "../rdp/classes/sceneFeed.ts";
import { isTabDomEvent, isViewport, type ToUi } from "../rdp/classes/tabProtocol.ts";
import { BACKGROUNDS, UiStudioApp } from "./app.tsx";
import { DEFAULT_SCENE_ID } from "./scenes/index.ts";

// Keep settings writes inside the preview worker away from the developer's live PetPlay config.
if (!Deno.env.get("PETPLAY_SETTINGS_PATH")) {
  const scratchSettings = fromFileUrl(
    new URL("../_scratch/ui-preview-settings.json", import.meta.url),
  );
  Deno.env.set("PETPLAY_SETTINGS_PATH", scratchSettings);
}

export type StudioStart = {
  hostname?: string;
  port?: number;
  scene?: string;
  dir?: string;
};

const FRAME_MS = 16;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
};

const state = actorState({
  name: "ui-studio",
  url: null as string | null,
  scene: DEFAULT_SCENE_ID,
  tabConnected: false,
  viewport: null as { width: number; height: number; dpr: number } | null,
  frames: 0,
  deltasSent: 0,
  bytesSent: 0,
  domEvents: 0,
  lastError: null as string | null,
});

let server: Deno.HttpServer | null = null;
let browserTab: BrowserTab | null = null;
let session: { socket: WebSocket; feed: SceneFeed } | null = null;
let frameTimer: ReturnType<typeof setInterval> | null = null;
let lastCamera = "";
let background: string = BACKGROUNDS[0].color;
let staticDir = fromFileUrl(new URL("../dist/ui", import.meta.url));
let listenConfig: { hostname: string; port: number } | null = null;

type StudioSnapshot = {
  hostname: string;
  port: number;
  scene: string;
  background: string;
  dir: string;
};

function sendJson(message: Record<string, unknown>): void {
  if (session && session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify(message));
  }
}

function render(): void {
  if (!browserTab) return;
  browserTab.render(
    <UiStudioApp
      sceneId={state.scene}
      onSceneChange={(id) => {
        state.scene = id;
        render();
      }}
      onBackgroundChange={(hex) => {
        background = hex;
        sendJson({ background: hex });
      }}
    />,
  );
}

function frame(): void {
  if (!browserTab || !session || session.socket.readyState !== WebSocket.OPEN) return;
  try {
    browserTab.frame();
    session.feed.write(browserTab.scene, browserTab.camera);
    state.frames++;
    const camera = browserTab.camera;
    camera.updateMatrixWorld();
    const view = JSON.stringify([camera.projectionMatrix.elements, camera.matrixWorld.elements]);
    if (view !== lastCamera) {
      lastCamera = view;
      sendJson({
        camera: {
          projection: [...camera.projectionMatrix.elements],
          world: [...camera.matrixWorld.elements],
        },
      });
    }
    const bytes = session.feed.next();
    if (bytes) session.socket.send(bytes);
    state.deltasSent = session.feed.deltasSent;
    state.bytesSent = session.feed.bytesSent;
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.stack ?? error : error);
  }
}

function attachSocket(socket: WebSocket, initialScene?: string): void {
  if (initialScene) state.scene = initialScene;
  if (session) {
    try {
      session.socket.close(1000, "replaced by a newer tab");
    } catch { /* ignore */ }
  }
  const current = { socket, feed: new SceneFeed() };
  session = current;
  lastCamera = "";
  state.tabConnected = true;

  socket.onopen = () => {
    sendJson({ background });
  };

  socket.onclose = () => {
    if (session !== current) return;
    session = null;
    state.tabConnected = false;
  };

  socket.onmessage = async (event) => {
    if (typeof event.data !== "string") return;
    let message: ToUi;
    try {
      message = JSON.parse(event.data) as ToUi;
    } catch {
      return;
    }
    if ("ack" in message) {
      current.feed.acked(message.ack);
    } else if ("resync" in message) {
      current.feed.resync();
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
    }
  };
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/tab") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket only", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    attachSocket(socket, url.searchParams.get("scene") ?? undefined);
    return response;
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (name.split("/").some((part) => part === ".." || part.startsWith("."))) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const body = await Deno.readFile(`${staticDir}/${name}`);
    const type = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
    return new Response(body, {
      headers: { "content-type": type, "cache-control": "no-store" },
    });
  } catch {
    return new Response("Not found (run `deno task ui:build`)", { status: 404 });
  }
}

async function stop(): Promise<void> {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
  if (session) {
    try {
      session.socket.close(1000, "studio stopped");
    } catch { /* ignore */ }
    session = null;
  }
  browserTab?.dispose();
  browserTab = null;
  await server?.shutdown();
  server = null;
}

function startServer(hostname: string, port: number): Promise<{ url: string }> {
  frameTimer = setInterval(frame, FRAME_MS);
  return new Promise<{ url: string }>((resolve) => {
    server = Deno.serve({
      hostname,
      port,
      onListen: ({ port: boundPort }) => {
        listenConfig = { hostname, port: boundPort };
        state.url = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${boundPort}/`;
        resolve({ url: state.url });
      },
    }, handleRequest);
  });
}

new PostMan(state, {
  __INIT__: () => {},
  __HEALTH__: () => ({ ...state }),
  START: (payload: StudioStart = {}) => {
    if (state.url) return { url: state.url };
    if (payload.scene) state.scene = payload.scene;
    if (payload.dir) staticDir = payload.dir;
    const hostname = payload.hostname ?? "127.0.0.1";
    const port = payload.port ?? 3995;
    return startServer(hostname, port);
  },
  SETSCENE: (scene: string) => {
    state.scene = scene;
    render();
    return { scene: state.scene };
  },
  __SNAPSHOT__: (): StudioSnapshot | null => {
    if (!listenConfig) return null;
    return {
      hostname: listenConfig.hostname,
      port: listenConfig.port,
      scene: state.scene,
      background,
      dir: staticDir,
    };
  },
  __RESTORE__: async (snapshot: StudioSnapshot | null) => {
    if (!snapshot) return;
    state.scene = snapshot.scene;
    background = snapshot.background;
    staticDir = snapshot.dir;
    await startServer(snapshot.hostname, snapshot.port);
  },
  __SHUTDOWN__: () => stop(),
} as const);

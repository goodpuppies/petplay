/**
 * Local capturable windows exposed as on-demand VR `WorkspaceOutput`s.
 *
 * Queries this machine's `desktopSource` (`LISTWINDOWS`) and lazily spawns ONE
 * `petplay/localWindowOverlay.ts` process when a `DisplayInstance` selects a local window
 * (`SHOW` / `RELEASE` / `INPUTTARGET` — the same lifecycle contract as `householdDesktops.ts`).
 */
import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import type { WindowInfo } from "../rdp/desktopSource.ts";
import type { WorkspaceOutput } from "../classes/environment/workspaceDisplays.ts";

const REFRESH_MS = 3_000;
const RELEASE_GRACE_MS = 15_000;
const FIRST_FRAME_POLL_MS = 200;
const FIRST_FRAME_WAIT_MS = 15_000;
const REQUEST_MS = 10_000;

type TrackedWindow = {
  info: WindowInfo;
  holders: Set<string>;
  running: boolean;
  frames: number;
  width: number;
  height: number;
  starting: boolean;
  releaseAt: number | null;
  error: string | null;
};

const state = actorState({
  name: "localWindows",
  source: null as string | null,
  input: null as string | null,
  overlay: null as string | null,
  windowCount: 0,
  shownCount: 0,
  lastError: null as string | null,
});

const tracked = new Map<string, TrackedWindow>();
let lastListAt = 0;
let listing = false;
let overlaySpawnPromise: Promise<ActorId> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(Error(`${what}: no reply in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(handle));
}

function shortAppName(app: string): string {
  const trimmed = app.trim();
  if (!trimmed) return "";
  // Reverse-DNS ids like "com.t3tools.T3Code" or "org.kde.dolphin" -> last segment.
  const seg = trimmed.includes(".") ? trimmed.split(".").at(-1) ?? trimmed : trimmed;
  return seg.replace(/^steam_app_\d+$/i, "").trim();
}

function shortWindowLabel(w: WindowInfo): string {
  const title = (w.title || "").trim();
  const app = shortAppName(w.app || "");
  let raw = title || app || w.id;
  if (app && title && !title.toLowerCase().includes(app.toLowerCase())) {
    raw = `${app}: ${title}`;
  }
  return raw.length > 26 ? `${raw.slice(0, 25)}…` : raw;
}

async function refreshWindows(): Promise<void> {
  if (!state.source || listing) return;
  if (Date.now() - lastListAt < REFRESH_MS) return;
  listing = true;
  try {
    const list = await withTimeout(
      PostMan.PostMessage({ target: state.source as ActorId, type: "LISTWINDOWS", payload: null }, true) as Promise<
        WindowInfo[]
      >,
      REQUEST_MS,
      "LISTWINDOWS",
    );
    lastListAt = Date.now();
    const visible = (Array.isArray(list) ? list : []).filter((w) =>
      w && typeof w.id === "string" && w.id && w.width > 1 && w.height > 1 &&
      !w.title?.startsWith("PetPlayWindowOverlay_")
    );
    const seen = new Set<string>();
    for (const info of visible) {
      seen.add(info.id);
      const existing = tracked.get(info.id);
      if (existing) {
        existing.info = info;
      } else {
        tracked.set(info.id, {
          info,
          holders: new Set(),
          running: false,
          frames: 0,
          width: info.width,
          height: info.height,
          starting: false,
          releaseAt: null,
          error: null,
        });
      }
    }
    for (const [id, entry] of tracked) {
      if (!seen.has(id) && entry.holders.size === 0) {
        tracked.delete(id);
      }
    }
    state.windowCount = tracked.size;
    state.lastError = null;
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.message : error);
  } finally {
    listing = false;
  }
}

async function ensureOverlayHost(): Promise<ActorId> {
  if (state.overlay) return state.overlay as ActorId;
  overlaySpawnPromise ??= (async () => {
    const actor = (await PostMan.create("./localWindowOverlay.ts", import.meta.url, {
      worker: "process",
    })) as unknown as ActorId;
    const id = String(actor) as ActorId;
    state.overlay = id;
    return id;
  })().finally(() => {
    overlaySpawnPromise = null;
  });
  return await overlaySpawnPromise;
}

async function syncOverlayState(): Promise<void> {
  if (!state.overlay) return;
  try {
    const snapshot = await withTimeout(
      PostMan.PostMessage({ target: state.overlay as ActorId, type: "WINDOWSTATE", payload: null }, true) as Promise<
        Record<string, { running: boolean; frames: number; width: number; height: number }>
      >,
      3_000,
      "WINDOWSTATE",
    );
    for (const [id, entry] of tracked) {
      const s = snapshot?.[id];
      if (s) {
        entry.running = s.running;
        entry.frames = s.frames;
        if (s.width > 0) entry.width = s.width;
        if (s.height > 0) entry.height = s.height;
      } else if (!entry.starting) {
        entry.running = false;
        entry.frames = 0;
      }
    }
  } catch {
    // Overlay host may be shutting down.
  }
}

async function watchFirstFrame(windowId: string): Promise<void> {
  const deadline = Date.now() + FIRST_FRAME_WAIT_MS;
  while (Date.now() < deadline) {
    const entry = tracked.get(windowId);
    if (!entry || entry.holders.size === 0) return;
    await syncOverlayState();
    if (entry.frames > 0) return;
    await new Promise((r) => setTimeout(r, FIRST_FRAME_POLL_MS));
  }
}

async function startTrackedWindow(entry: TrackedWindow, displayId: string): Promise<void> {
  if (!state.source) return;
  const overlay = await ensureOverlayHost();
  await withTimeout(
    PostMan.PostMessage({
      target: overlay,
      type: "ASSIGNDISPLAY",
      payload: { displayId, windowId: entry.info.id },
    }, true),
    REQUEST_MS,
    "ASSIGNDISPLAY",
  );
  if (entry.running || entry.starting) return;
  entry.starting = true;
  try {
    await withTimeout(
      PostMan.PostMessage({
        target: overlay,
        type: "STARTWINDOW",
        payload: { windowId: entry.info.id, desktopSource: state.source },
      }, true),
      REQUEST_MS,
      "STARTWINDOW",
    );
    entry.error = null;
    void watchFirstFrame(entry.info.id);
  } catch (error) {
    entry.error = String(error instanceof Error ? error.message : error);
    state.lastError = entry.error;
  } finally {
    entry.starting = false;
  }
}

async function stopUnusedWindows(): Promise<void> {
  const now = Date.now();
  let activeShown = 0;
  for (const entry of tracked.values()) {
    if (entry.holders.size > 0) {
      activeShown++;
      continue;
    }
    if (entry.releaseAt !== null && now >= entry.releaseAt && state.overlay) {
      entry.releaseAt = null;
      entry.running = false;
      entry.frames = 0;
      await withTimeout(
        PostMan.PostMessage({
          target: state.overlay as ActorId,
          type: "STOPWINDOW",
          payload: { windowId: entry.info.id },
        }, true),
        REQUEST_MS,
        "STOPWINDOW",
      ).catch(() => {});
    }
  }
  state.shownCount = activeShown;
}

function outputs(): WorkspaceOutput[] {
  return [...tracked.values()].map((entry) => {
    const ready = state.overlay !== null && entry.frames > 0;
    const width = entry.width > 0 ? entry.width : (entry.info.width || 1280);
    const height = entry.height > 0 ? entry.height : (entry.info.height || 720);
    return {
      id: `window:${entry.info.id}`,
      name: shortWindowLabel(entry.info),
      kind: "window",
      windowId: entry.info.id,
      ...(entry.info.minimized ? { minimized: true } : {}),
      local: true,
      priority: -2,
      logicalX: entry.info.x,
      logicalY: entry.info.y,
      logicalWidth: width,
      logicalHeight: height,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      household: { desktop: entry.info.id, provider: state.id },
      ...(ready ? { overlayHostActor: state.overlay! } : {}),
      ...(ready && state.input ? { inputActor: state.input } : { input: "none" as const }),
      ...(entry.error ? { error: entry.error } : {}),
    };
  });
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    SETUP: (payload: { source: string; input: string }) => {
      state.source = payload?.source ?? null;
      state.input = payload?.input ?? null;
      if (!pollTimer && state.source) {
        pollTimer = setInterval(() => {
          void stopUnusedWindows();
          if (state.shownCount > 0) {
            void refreshWindows();
            void syncOverlayState();
          }
        }, 2_000);
      }
      void refreshWindows();
      return true;
    },
    LIST: async () => {
      await refreshWindows();
      if (state.shownCount > 0) await syncOverlayState();
      return outputs();
    },
    SHOW: (payload: { desktop: string; display: string }) => {
      const entry = tracked.get(payload?.desktop);
      if (!entry) return false;
      entry.holders.add(String(payload.display));
      entry.releaseAt = null;
      state.shownCount = [...tracked.values()].filter((e) => e.holders.size > 0).length;
      void startTrackedWindow(entry, String(payload.display));
      return true;
    },
    RELEASE: (payload: { desktop: string; display: string }) => {
      const entry = tracked.get(payload?.desktop);
      if (!entry) return false;
      entry.holders.delete(String(payload.display));
      if (state.overlay) {
        PostMan.PostMessage({
          target: state.overlay as ActorId,
          type: "UNASSIGNDISPLAY",
          payload: { displayId: String(payload.display) },
        });
      }
      if (entry.holders.size === 0) entry.releaseAt = Date.now() + RELEASE_GRACE_MS;
      state.shownCount = [...tracked.values()].filter((e) => e.holders.size > 0).length;
      return true;
    },
    INPUTTARGET: (payload: { desktop: string }) => {
      const entry = tracked.get(payload?.desktop);
      if (!entry || !state.input) return null;
      return {
        actor: state.input,
        ...(entry.info.region ? { region: entry.info.region } : {}),
        ...(state.source ? { focusSource: state.source, focusWindow: entry.info.id } : {}),
      };
    },
    __SHUTDOWN__: async () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      const overlay = state.overlay;
      state.overlay = null;
      if (overlay) {
        await PostMan.shutdown(overlay as ActorId, { timeoutMs: 5_000, bestEffort: true })
          .catch(() => {});
      }
      tracked.clear();
    },
  } as const,
);

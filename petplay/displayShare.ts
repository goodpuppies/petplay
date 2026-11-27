/**
 * displayShare: this PetPlay's displays, offered to others on a share topic.
 *
 * `SETUP {source, input}` (main, at launch) joins the topic derived from the share key and answers
 * there, sharing nothing until told what: `SETSHARED {screens: [{name, input}]}` from the scene
 * (a display's Share action; Windows monitors by name, `DISPLAY2`; on Linux any shared display
 * shares the whole workspace), or `SHAREALL` for `--share-all-displays`. For now the key is the household secret (`.secret`,
 * `rdp/classes/household.ts`), a debug key; later it comes from VRChat identity. Requests come
 * only as `GUARDED` with the key's proof for this actor, and go on to this machine's own
 * desktopSource and desktopInput, which stay off the topic: their local messages (the overlay
 * host's frame sink and the rest) keep working unguarded.
 *
 * It answers what a desktopSource answers on the topic, so a viewer's householdDesktops treats
 * it as one: `DESCRIBE` (with itself as the input target), `START`/`FEED`/`STOP` `{monitor}`,
 * `AUDIO`/`STOPAUDIO`, and `INPUT` for the desktop. Feeds always carry an iroh share code, the
 * only way a viewer reaches them: no LAN or tailnet address is involved.
 *
 * Only shared screens are listed (`screens`, each with `input`: whether they may be driven) or
 * started; input lands only on a screen that allows it. When nothing is shared any more, its
 * feeds and sound stop.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import {
  guardedDispatch,
  HouseholdGuard,
  householdSecret,
  householdTopic,
} from "../rdp/classes/household.ts";
import type {
  DesktopDescription,
  ScreenInfo,
  SharedWindowInfo,
  SourceRequest,
  WindowInfo,
} from "../rdp/desktopSource.ts";
import type { InputEvent } from "../rdp/classes/input/inputEvent.ts";
import type { SharedDisplayWorldPose } from "../classes/vrcOriginTransform.ts";

/** A shared screen or window (monitor by name, or window by `kind: "window"` + `windowId`). */
export type SharedScreen = {
  kind?: "monitor" | "window";
  windowId?: string;
  name: string;
  input: boolean;
  worldPose?: SharedDisplayWorldPose;
};

/** The encoders' local listeners (loopback only); viewers use the share codes. */
const MEDIA_PORT = 4460;
const REQUEST_MS = 60_000;

const state = actorState({
  name: "displayShare",
  sharing: false,
  topic: null as string | null,
  instanceTopic: null as string | null,
  source: null as string | null,
  input: null as string | null,
  /** Everything, with input (`--share-all-displays`); otherwise `shared`. */
  all: false,
  shared: [] as SharedScreen[],
  requests: 0,
  inputs: 0,
  refusedInputs: 0,
  lastError: null as string | null,
});

const guard = new HouseholdGuard();
/** Per-peer capability tokens granted to trusted VRChat peers (`vrcUserId -> token`). */
const peerTokens = new Map<string, string>();
let peerRejected = 0;

/** Latest pose pushed by a remote viewer (`window:<id>` or `monitor:<name>`). */
const remotePoses = new Map<
  string,
  { kind: "monitor" | "window"; windowId?: string; name: string; worldPose: SharedDisplayWorldPose }
>();

function sharedKey(s: Pick<SharedScreen, "kind" | "windowId" | "name">): string {
  return s.kind === "window" && s.windowId ? `window:${s.windowId}` : `monitor:${s.name}`;
}

function validTuple3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n));
}

function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasValidPeerToken(proof: unknown): boolean {
  if (typeof proof !== "string" || proof.length === 0) return false;
  for (const token of peerTokens.values()) {
    if (sameToken(proof, token)) return true;
  }
  return false;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function call<T>(target: string, type: string, payload: unknown = null): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    PostMan.PostMessage({ target: target as ActorId, type, payload }, true) as Promise<T>,
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(Error(`${type}: no reply in ${REQUEST_MS} ms`)), REQUEST_MS);
    }),
  ]).finally(() => clearTimeout(handle));
}

/** The local source's screens and windows, cached for input checks. */
let screens: ScreenInfo[] | null = null;
let cachedWindows: WindowInfo[] = [];

function sharedMonitors(): SharedScreen[] {
  return state.shared.filter((s) => s.kind !== "window");
}

function sharedWindows(): SharedScreen[] {
  return state.shared.filter((s) =>
    s.kind === "window" && typeof s.windowId === "string" && s.windowId.length > 0
  );
}

function sharedAs(name: string): SharedScreen | null {
  if (state.all) return { name, input: true };
  return sharedMonitors().find((s) => s.name === name) ?? null;
}

function sharedAsWindow(windowId: string): SharedScreen | null {
  if (state.all) return { kind: "window", windowId, name: windowId, input: true };
  return sharedWindows().find((s) => s.windowId === windowId) ?? null;
}

/** What is shared, as the viewer sees it. */
async function describe(): Promise<DesktopDescription> {
  const described = await call<DesktopDescription>(source(), "DESCRIBE");
  screens = described.screens ?? null;
  const monitors = sharedMonitors();
  const offered = described.screens
    ? described.screens.flatMap((screen) => {
      const shared = sharedAs(screen.name);
      return shared
        ? [{
          ...screen,
          input: shared.input,
          ...(shared.worldPose ? { worldPose: shared.worldPose } : {}),
        }]
        : [];
    })
    // Whole-workspace fallback when desktopSource doesn't expose per-monitor screens.
    : state.all || monitors.length > 0
    ? undefined
    : [];

  const winShares = sharedWindows();
  let offeredWindows: SharedWindowInfo[] = [];
  if (winShares.length > 0) {
    try {
      const listed = await call<WindowInfo[]>(source(), "LISTWINDOWS");
      cachedWindows = Array.isArray(listed) ? listed : [];
    } catch {
      // Keep last known window geometry if LISTWINDOWS transiently fails.
    }
    offeredWindows = winShares.flatMap((shared) => {
      const win = cachedWindows.find((w) => w.id === shared.windowId);
      if (!win) return [];
      return [{
        id: win.id,
        title: win.title,
        app: win.app,
        width: win.width,
        height: win.height,
        ...(win.region ? { region: win.region } : {}),
        input: shared.input,
        ...(shared.worldPose ? { worldPose: shared.worldPose } : {}),
      }];
    });
  } else {
    cachedWindows = [];
  }

  const wholeWorldPose = offered === undefined
    ? monitors.find((s) => s.worldPose != null)?.worldPose
    : undefined;
  return {
    ...described,
    // Input comes here, with the proof, and goes on to the local desktopInput.
    input: state.id,
    ...(offered ? { screens: offered } : {}),
    ...(offeredWindows.length > 0 ? { windows: offeredWindows } : {}),
    ...(offered === undefined
      ? {
        wholeInput: state.all || monitors.some((s) => s.input),
        ...(wholeWorldPose ? { wholeWorldPose } : {}),
      }
      : {}),
  };
}

function allowedMonitor(monitor: unknown): boolean {
  if (!screens) return state.all || sharedMonitors().length > 0;
  const screen = screens.find((s) => s.index === monitor);
  return screen ? sharedAs(screen.name) !== null : false;
}

function allowedWindow(windowId: unknown): boolean {
  if (typeof windowId !== "string" || !windowId) return false;
  return sharedAsWindow(windowId) !== null;
}

/** Whether an input event lands on a screen or window that may be driven. */
function inputAllowed(event: InputEvent): boolean {
  const anyInput = state.all || state.shared.some((s) => s.input);
  if (!anyInput) return false;
  if (!("x" in event) || event.x === undefined || event.y === undefined) return true;
  const { x, y } = event as { x: number; y: number };
  const inMonitor = screens
    ? screens.some((s) =>
      sharedAs(s.name)?.input === true &&
      x >= s.region.x && x <= s.region.x + s.region.width &&
      y >= s.region.y && y <= s.region.y + s.region.height
    )
    : (state.all || sharedMonitors().some((s) => s.input));
  if (inMonitor) return true;
  return cachedWindows.some((w) =>
    w.region != null &&
    sharedAsWindow(w.id)?.input === true &&
    x >= w.region.x && x <= w.region.x + w.region.width &&
    y >= w.region.y && y <= w.region.y + w.region.height
  );
}

/** Stop what is no longer shared. */
async function settle(removedWindowIds: string[] = []): Promise<void> {
  if (!state.source) return;
  if (!state.all && state.shared.length === 0) {
    await call(state.source, "STOP").catch(() => {});
    await call(state.source, "STOPAUDIO").catch(() => {});
    return;
  }
  for (const screen of screens ?? []) {
    if (!sharedAs(screen.name)) {
      await call(state.source, "STOP", { monitor: screen.index }).catch(() => {});
    }
  }
  for (const windowId of removedWindowIds) {
    if (!sharedAsWindow(windowId)) {
      await call(state.source, "STOP", { window: windowId }).catch(() => {});
    }
  }
}

function source(): string {
  if (!state.source) throw new Error("not sharing");
  state.requests++;
  return state.source;
}

const guardedHandlers: Record<string, (payload: unknown) => unknown> = {
  DESCRIBE: () => describe(),
  START: (payload) => {
    const req = payload as Partial<SourceRequest> | null;
    if (typeof req?.window === "string" && req.window) {
      if (!allowedWindow(req.window)) throw new Error("that window is not shared");
      return call(source(), "START", {
        ...req,
        host: "127.0.0.1",
        port: MEDIA_PORT,
        share: true,
      });
    }
    const monitor = req?.monitor;
    if (!allowedMonitor(monitor ?? screens?.find((s) => s.primary)?.index ?? 0)) {
      throw new Error("that display is not shared");
    }
    return call(source(), "START", {
      ...req,
      host: "127.0.0.1",
      port: MEDIA_PORT,
      share: true,
    });
  },
  FEED: (payload) => {
    const req = payload as { monitor?: number; window?: string } | null;
    if (typeof req?.window === "string" && req.window) {
      return allowedWindow(req.window) ? call(source(), "FEED", payload) : null;
    }
    return allowedMonitor(req?.monitor ?? 0) ? call(source(), "FEED", payload) : null;
  },
  FOCUSWINDOW: (payload) => {
    const windowId = (payload as { window?: unknown } | null)?.window;
    if (typeof windowId !== "string" || !windowId) return false;
    if (sharedAsWindow(windowId)?.input !== true) return false;
    return call(source(), "FOCUSWINDOW", { window: windowId });
  },
  STOP: (payload) => call(source(), "STOP", payload),
  AUDIO: () =>
    state.all || state.shared.length > 0
      ? call(source(), "AUDIO", { host: "127.0.0.1", port: MEDIA_PORT })
      : null,
  STOPAUDIO: () => call(source(), "STOPAUDIO"),
  INPUT: (event) => {
    if (!state.input) return false;
    if (!inputAllowed(event as InputEvent)) {
      state.refusedInputs++;
      return false;
    }
    state.inputs++;
    PostMan.PostMessage({ target: state.input as ActorId, type: "INPUT", payload: event });
    return true;
  },
  SETPOSE: (payload) => {
    const req = payload as {
      kind?: "monitor" | "window";
      windowId?: string;
      name?: string;
      monitor?: number;
      worldPose?: SharedDisplayWorldPose;
    } | null;
    const pose = req?.worldPose;
    if (
      !pose || !validTuple3(pose.position) || !validTuple3(pose.rotation) ||
      !validTuple3(pose.scale)
    ) {
      return false;
    }
    const target = req?.kind === "window" && typeof req.windowId === "string"
      ? sharedAsWindow(req.windowId)
      : typeof req?.name === "string"
      ? sharedAs(req.name)
      : typeof req?.monitor === "number" && screens
      ? (() => {
        const sc = screens.find((s) => s.index === req.monitor);
        return sc ? sharedAs(sc.name) : null;
      })()
      : sharedMonitors()[0] ?? null;
    if (!target) return false;
    const nextPose: SharedDisplayWorldPose = {
      position: [...pose.position],
      rotation: [...pose.rotation],
      scale: [...pose.scale],
      updatedAt: Date.now(),
    };
    target.worldPose = nextPose;
    remotePoses.set(sharedKey(target), {
      kind: target.kind === "window" ? "window" : "monitor",
      ...(target.windowId ? { windowId: target.windowId } : {}),
      name: target.name,
      worldPose: nextPose,
    });
    return true;
  },
};

const householdGuarded = guardedDispatch(guard, guardedHandlers);

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({
      ...state,
      rejected: guard.rejected + peerRejected,
      peerGrants: peerTokens.size,
    }),
    /**
     * Configure this machine's desktopSource and desktopInput. If a household `.secret` exists,
     * also joins the household topic; otherwise serves only per-peer grants from `vrcPeers`.
     */
    SETUP: async (payload: { source: string; input: string }) => {
      if (state.sharing) return true;
      state.source = payload.source;
      state.input = payload.input;
      const secret = householdSecret();
      if (secret) {
        await guard.enable(secret, state.id);
        state.topic = await householdTopic(secret);
        PostMan.setTopic(state.topic);
        console.log(`[displayShare] on the household share topic`);
      } else {
        console.log(`[displayShare] ready for peer grants (no household .secret)`);
      }
      state.sharing = true;
      return true;
    },
    /** Grant a trusted peer (e.g. VRChat `usr_...`) a revocable capability token. */
    GRANTPEER: (payload: { peerKey: string }) => {
      const peerKey = payload?.peerKey;
      if (typeof peerKey !== "string" || !peerKey) {
        throw new Error("GRANTPEER requires peerKey");
      }
      let token = peerTokens.get(peerKey);
      if (!token) {
        token = randomToken();
        peerTokens.set(peerKey, token);
      }
      return { shareActor: state.id, token };
    },
    /** Revoke a previously granted peer capability token. */
    REVOKEPEER: (payload: { peerKey: string }) => {
      const removed = typeof payload?.peerKey === "string" && peerTokens.delete(payload.peerKey);
      return { removed };
    },
    /**
     * Join/leave the current VRChat instance topic so trusted peers' hubs have an iroh route to
     * this actor. Requests still require a valid per-peer token (or household proof).
     */
    SETINSTANCETOPIC: (payload: { topic: string | null; key?: string | null }) => {
      const next = typeof payload?.topic === "string" && payload.topic ? payload.topic : null;
      const key = typeof payload?.key === "string" && payload.key ? payload.key : null;
      if (next === state.instanceTopic) return true;
      if (state.instanceTopic) PostMan.delTopic(state.instanceTopic);
      state.instanceTopic = next;
      if (next) PostMan.setTopic(next, key ? { key } : undefined);
      return true;
    },
    /** Share these screens and/or windows (the scene's shared displays). */
    SETSHARED: async (payload: { screens: SharedScreen[] }) => {
      const next = (payload?.screens ?? []).filter((s) => typeof s?.name === "string")
        .map((s) => ({
          ...(s.kind ? { kind: s.kind } : {}),
          ...(s.windowId ? { windowId: s.windowId } : {}),
          name: s.name,
          input: s.input === true,
          ...(s.worldPose ? { worldPose: s.worldPose } : {}),
        }));
      const prevWindowIds = sharedWindows().map((w) => w.windowId!);
      const keyOf = (s: SharedScreen) => ({
        kind: s.kind ?? "monitor",
        windowId: s.windowId ?? null,
        name: s.name,
        input: s.input,
      });
      const prevSet = JSON.stringify(state.shared.map(keyOf));
      const nextSet = JSON.stringify(next.map(keyOf));
      if (JSON.stringify(next) === JSON.stringify(state.shared)) return true;
      state.shared = next;
      if (prevSet !== nextSet) {
        console.log(`[displayShare] sharing ${next.map((s) => s.name).join(", ") || "nothing"}`);
        await settle(prevWindowIds);
      }
      return true;
    },
    /** Latest viewer-pushed world poses, for two-way shared display sync. */
    GETREMOTEPOSES: () => [...remotePoses.values()],
    /** Share every screen, with input (`--share-all-displays`). */
    SHAREALL: () => {
      state.all = true;
      console.log(`[displayShare] sharing every display`);
      return true;
    },
    GUARDED: (request: { proof: string; type: string; payload?: unknown }) => {
      if (hasValidPeerToken(request?.proof)) {
        const handler = guardedHandlers[request.type];
        if (!handler) throw new Error(`no share request ${request.type}`);
        return handler(request.payload);
      }
      if (guard.active) {
        return householdGuarded(request);
      }
      peerRejected++;
      throw new Error("not authorized for this displayShare");
    },
  } as const,
);

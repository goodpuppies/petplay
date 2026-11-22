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
import type { DesktopDescription, ScreenInfo, SourceRequest } from "../rdp/desktopSource.ts";
import type { InputEvent } from "../rdp/classes/input/inputEvent.ts";
import type { SharedDisplayWorldPose } from "../classes/vrcOriginTransform.ts";

/** A shared screen, by name (Windows: `DISPLAY2`; Linux: ignored, the workspace). */
export type SharedScreen = { name: string; input: boolean; worldPose?: SharedDisplayWorldPose };

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

/** The local source's screens (Windows), cached for input checks. */
let screens: ScreenInfo[] | null = null;

function sharedAs(name: string): SharedScreen | null {
  if (state.all) return { name, input: true };
  return state.shared.find((s) => s.name === name) ?? null;
}

/** What is shared, as the viewer sees it. */
async function describe(): Promise<DesktopDescription> {
  const described = await call<DesktopDescription>(source(), "DESCRIBE");
  screens = described.screens ?? null;
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
    // Linux: one workspace, shared when any display is; no screens means nothing shared.
    : state.all || state.shared.length > 0
    ? undefined
    : [];
  const wholeWorldPose = offered === undefined
    ? state.shared.find((s) => s.worldPose != null)?.worldPose
    : undefined;
  return {
    ...described,
    // Input comes here, with the proof, and goes on to the local desktopInput.
    input: state.id,
    ...(offered ? { screens: offered } : {}),
    ...(offered === undefined
      ? {
        wholeInput: state.all || state.shared.some((s) => s.input),
        ...(wholeWorldPose ? { wholeWorldPose } : {}),
      }
      : {}),
  };
}

function allowedMonitor(monitor: unknown): boolean {
  if (!screens) return state.all || state.shared.length > 0;
  const screen = screens.find((s) => s.index === monitor);
  return screen ? sharedAs(screen.name) !== null : false;
}

/** Whether an input event lands on a screen that may be driven. */
function inputAllowed(event: InputEvent): boolean {
  const anyInput = state.all || state.shared.some((s) => s.input);
  if (!anyInput) return false;
  if (!screens) return true;
  if (!("x" in event) || event.x === undefined || event.y === undefined) return true;
  const { x, y } = event as { x: number; y: number };
  return screens.some((s) =>
    sharedAs(s.name)?.input === true &&
    x >= s.region.x && x <= s.region.x + s.region.width &&
    y >= s.region.y && y <= s.region.y + s.region.height
  );
}

/** Stop what is no longer shared. */
async function settle(): Promise<void> {
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
}

function source(): string {
  if (!state.source) throw new Error("not sharing");
  state.requests++;
  return state.source;
}

const guardedHandlers: Record<string, (payload: unknown) => unknown> = {
  DESCRIBE: () => describe(),
  START: (payload) => {
    const monitor = (payload as { monitor?: number } | null)?.monitor;
    if (!allowedMonitor(monitor ?? screens?.find((s) => s.primary)?.index ?? 0)) {
      throw new Error("that display is not shared");
    }
    return call(source(), "START", {
      ...(payload as Partial<SourceRequest> | null),
      host: "127.0.0.1",
      port: MEDIA_PORT,
      share: true,
    });
  },
  FEED: (payload) =>
    allowedMonitor((payload as { monitor?: number } | null)?.monitor ?? 0)
      ? call(source(), "FEED", payload)
      : null,
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
    SETINSTANCETOPIC: (payload: { topic: string | null }) => {
      const next = typeof payload?.topic === "string" && payload.topic ? payload.topic : null;
      if (next === state.instanceTopic) return true;
      if (state.instanceTopic) PostMan.delTopic(state.instanceTopic);
      state.instanceTopic = next;
      if (next) PostMan.setTopic(next);
      return true;
    },
    /** Share these screens (the scene's shared displays). */
    SETSHARED: async (payload: { screens: SharedScreen[] }) => {
      const next = (payload?.screens ?? []).filter((s) => typeof s?.name === "string")
        .map((s) => ({
          name: s.name,
          input: s.input === true,
          ...(s.worldPose ? { worldPose: s.worldPose } : {}),
        }));
      const prevSet = JSON.stringify(state.shared.map((s) => ({ name: s.name, input: s.input })));
      const nextSet = JSON.stringify(next.map((s) => ({ name: s.name, input: s.input })));
      if (JSON.stringify(next) === JSON.stringify(state.shared)) return true;
      state.shared = next;
      if (prevSet !== nextSet) {
        console.log(`[displayShare] sharing ${next.map((s) => s.name).join(", ") || "nothing"}`);
        await settle();
      }
      return true;
    },
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

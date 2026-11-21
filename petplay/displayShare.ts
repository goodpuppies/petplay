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

/** A shared screen, by name (Windows: `DISPLAY2`; Linux: ignored, the workspace). */
export type SharedScreen = { name: string; input: boolean };

/** The encoders' local listeners (loopback only); viewers use the share codes. */
const MEDIA_PORT = 4460;
const REQUEST_MS = 60_000;

const state = actorState({
  name: "displayShare",
  sharing: false,
  topic: null as string | null,
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
      return shared ? [{ ...screen, input: shared.input }] : [];
    })
    // Linux: one workspace, shared when any display is; no screens means nothing shared.
    : state.all || state.shared.length > 0
    ? undefined
    : [];
  return {
    ...described,
    // Input comes here, with the proof, and goes on to the local desktopInput.
    input: state.id,
    ...(offered ? { screens: offered } : {}),
    ...(offered === undefined
      ? { wholeInput: state.all || state.shared.some((s) => s.input) }
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

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state, rejected: guard.rejected }),
    /** Join the share topic, offering this machine's desktopSource and desktopInput. */
    SETUP: async (payload: { source: string; input: string }) => {
      if (state.sharing) return true;
      const secret = householdSecret();
      if (!secret) throw new Error("no share key: put one (16+ characters) in .secret");
      state.source = payload.source;
      state.input = payload.input;
      await guard.enable(secret, state.id);
      state.topic = await householdTopic(secret);
      PostMan.setTopic(state.topic);
      state.sharing = true;
      console.log(`[displayShare] on the share topic`);
      return true;
    },
    /** Share these screens (the scene's shared displays). */
    SETSHARED: async (payload: { screens: SharedScreen[] }) => {
      const next = (payload?.screens ?? []).filter((s) => typeof s?.name === "string")
        .map((s) => ({ name: s.name, input: s.input === true }));
      if (JSON.stringify(next) === JSON.stringify(state.shared)) return true;
      state.shared = next;
      console.log(`[displayShare] sharing ${next.map((s) => s.name).join(", ") || "nothing"}`);
      await settle();
      return true;
    },
    /** Share every screen, with input (`--share-all-displays`). */
    SHAREALL: () => {
      state.all = true;
      console.log(`[displayShare] sharing every display`);
      return true;
    },
    GUARDED: guardedDispatch(guard, {
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
    }),
  } as const,
);

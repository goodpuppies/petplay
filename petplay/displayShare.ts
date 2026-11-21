/**
 * displayShare: this PetPlay's displays, offered to others on a share topic.
 *
 * `SHARE {source, input}` (main does it for `--share-all-displays`) joins the topic derived from
 * the share key and answers there. For now the key is the household secret (`.secret`,
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
 * Which displays: all of them for now (`--share-all-displays`); a per-display toggle is next.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import {
  guardedDispatch,
  HouseholdGuard,
  householdSecret,
  householdTopic,
} from "../rdp/classes/household.ts";
import type { DesktopDescription, SourceRequest } from "../rdp/desktopSource.ts";

/** The encoders' local listeners (loopback only); viewers use the share codes. */
const MEDIA_PORT = 4460;
const REQUEST_MS = 60_000;

const state = actorState({
  name: "displayShare",
  sharing: false,
  topic: null as string | null,
  source: null as string | null,
  input: null as string | null,
  requests: 0,
  inputs: 0,
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
    /** Start sharing: this machine's desktopSource and desktopInput. */
    SHARE: async (payload: { source: string; input: string }) => {
      if (state.sharing) return true;
      const secret = householdSecret();
      if (!secret) throw new Error("no share key: put one (16+ characters) in .secret");
      state.source = payload.source;
      state.input = payload.input;
      await guard.enable(secret, state.id);
      state.topic = await householdTopic(secret);
      PostMan.setTopic(state.topic);
      state.sharing = true;
      console.log(`[displayShare] sharing this machine's displays`);
      return true;
    },
    GUARDED: guardedDispatch(guard, {
      DESCRIBE: async () => {
        const described = await call<DesktopDescription>(source(), "DESCRIBE");
        // Input comes here, with the proof, and goes on to the local desktopInput.
        return { ...described, input: state.id };
      },
      START: (payload) =>
        call(source(), "START", {
          ...(payload as Partial<SourceRequest> | null),
          host: "127.0.0.1",
          port: MEDIA_PORT,
          share: true,
        }),
      FEED: (payload) => call(source(), "FEED", payload),
      STOP: (payload) => call(source(), "STOP", payload),
      AUDIO: () => call(source(), "AUDIO", { host: "127.0.0.1", port: MEDIA_PORT }),
      STOPAUDIO: () => call(source(), "STOPAUDIO"),
      INPUT: (event) => {
        if (!state.input) return false;
        state.inputs++;
        PostMan.PostMessage({ target: state.input as ActorId, type: "INPUT", payload: event });
        return true;
      },
    }),
  } as const,
);

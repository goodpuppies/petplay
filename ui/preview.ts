/**
 * preview: root composer actor for the PetPlay UI web previewer, mirroring `rdp/rdp.ts`.
 * Spawns `studio.tsx` (the headless BrowserTab + SceneFeed + HTTP/WS server) and optionally
 * watches its module graph for hot reload via stageforge `RELOAD`.
 */
import { fromFileUrl } from "@std/path";
import {
  type ActorId,
  actorState,
  PostMan,
  resolveActorId,
  System,
} from "../submodules/stageforge/mod.ts";
import { startWebXrAutoReload } from "../classes/webxrAutoReload.ts";

export type PreviewStart = {
  hostname?: string;
  port?: number;
  scene?: string;
  dir?: string;
  watch?: boolean;
};

const state = actorState({
  name: "ui-preview",
  url: null as string | null,
  watching: false,
  actors: {} as Record<string, ActorId>,
});

let stopWatch: (() => void) | null = null;

const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
  PostMan.PostMessage({ target, type, payload }, true) as Promise<T>;

new PostMan(state, {
  START: async (payload: PreviewStart = {}) => {
    if (state.url) return { url: state.url, actors: state.actors };
    const studio = resolveActorId(await PostMan.create("./studio.tsx", import.meta.url));
    const { url } = await call<{ url: string }>(studio, "START", payload);
    state.url = url;
    state.actors = { studio };

    if (payload.watch !== false) {
      const watcher = await startWebXrAutoReload({
        entry: fromFileUrl(new URL("./studio.tsx", import.meta.url)),
        getTarget: () => state.actors.studio ?? null,
        reload: async (actorId) => {
          await PostMan.PostMessage({ target: System, type: "RELOAD", payload: { actorId } }, true);
        },
        toast: () => {},
        log: (message) => console.log(message.replaceAll("webxr-autoreload", "ui-reload")),
        debounceMs: 150,
      });
      stopWatch = watcher.stop;
      state.watching = true;
    }

    return { url, actors: state.actors };
  },
  RELOAD: async () => {
    const actorId = state.actors.studio;
    if (!actorId) throw new Error("studio actor not started");
    await PostMan.PostMessage({ target: System, type: "RELOAD", payload: { actorId } }, true);
    return { reloaded: actorId };
  },
  __SHUTDOWN__: () => {
    stopWatch?.();
    stopWatch = null;
    state.watching = false;
  },
  __HEALTH__: () => ({ ...state }),
} as const);

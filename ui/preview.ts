/**
 * preview: root composer actor for the PetPlay UI web previewer, mirroring `rdp/rdp.ts`.
 * Spawns `studio.tsx` (the headless BrowserTab + SceneFeed + HTTP/WS server). Hot reload is the
 * process's (`ui/main.ts` enables stageforge `HotReload`).
 */
import {
  type ActorId,
  actorState,
  PostMan,
  resolveActorId,
  System,
} from "../submodules/stageforge/mod.ts";

export type PreviewStart = {
  hostname?: string;
  port?: number;
  scene?: string;
  dir?: string;
};

const state = actorState({
  name: "ui-preview",
  url: null as string | null,
  actors: {} as Record<string, ActorId>,
});

const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
  PostMan.PostMessage({ target, type, payload }, true) as Promise<T>;

new PostMan(
  state,
  {
    START: async (payload: PreviewStart = {}) => {
      if (state.url) return { url: state.url, actors: state.actors };
      const studio = resolveActorId(await PostMan.create("./studio.tsx", import.meta.url));
      const { url } = await call<{ url: string }>(studio, "START", payload);
      state.url = url;
      state.actors = { studio };
      return { url, actors: state.actors };
    },
    RELOAD: async () => {
      const actorId = state.actors.studio;
      if (!actorId) throw new Error("studio actor not started");
      await PostMan.PostMessage({ target: System, type: "RELOAD", payload: { actorId } }, true);
      return { reloaded: actorId };
    },
    __HEALTH__: () => ({ ...state }),
  } as const,
);

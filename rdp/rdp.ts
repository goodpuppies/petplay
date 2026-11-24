/**
 * rdp: composes a remote desktop for one browser tab from independent actors.
 *
 *   desktopSource  capture + encoder; the tab receives its video over WebTransport
 *   desktopInput   pointer and keys into the desktop
 *   ui             the app, rendered for the tab (headless uikit "browser tab")
 *   site           the static page (optional: the page can be hosted anywhere)
 *
 * START makes a session secret and returns the link to open, the secret in its URL fragment
 * (never sent to the page's host). The actors meet on a topic derived from it; see
 * `classes/session.ts` for why the topic alone is not the secret.
 */
import {
  type ActorId,
  actorState,
  PostMan,
  resolveActorId,
} from "../submodules/stageforge/mod.ts";
import {
  formatSessionFragment,
  newSessionId,
  newSessionSecret,
  sessionTopic,
} from "./classes/session.ts";
import { householdSecret, householdTopic } from "./classes/household.ts";

export type RdpStart = {
  /** Where browsers reach this machine (its tailnet address); default 127.0.0.1. */
  host?: string;
  /** Encoder (WebTransport) port; default 4460. */
  mediaPort?: number;
  /** Serve the page here; default an ephemeral port on `host`. False: host it elsewhere. */
  site?: { port?: number; password?: string } | false;
  /** Without capture or input (testing, or a view-only session). */
  capture?: boolean;
  input?: boolean;
  /** Use these instead of creating them (tests). */
  actors?: { source?: ActorId; input?: ActorId };
  /** A fixed session id instead of a random one (tests). */
  id?: string;
  /** A fixed session secret instead of a random one (tests). */
  secret?: string;
  /** False: no household even if this machine has `.secret`. Also off when `actors` is given. */
  household?: false;
  /** "classic" (default single-desktop UI) or "compositor" (multi-machine WM + wallpaper). */
  mode?: "classic" | "compositor";
  /** Optional VRChat `petplay_ovrdriver` media socket path for `vrchatSource` in compositor mode. */
  vrchat?: {
    socketPath?: string;
    port?: number;
    layout?: "mono" | "side-by-side";
    autoWallpaper?: boolean;
  } | boolean;
};

const state = actorState({
  name: "rdp",
  topic: null as string | null,
  link: null as string | null,
  actors: {} as Record<string, ActorId>,
});

const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
  PostMan.PostMessage({ target, type, payload }, true) as Promise<T>;

new PostMan(state, {
  START: async (payload: RdpStart = {}) => {
    if (state.link) return { topic: state.topic, link: state.link };
    const host = payload.host ?? "127.0.0.1";
    const id = payload.id ?? newSessionId();
    const secret = payload.secret ?? newSessionSecret();
    const topic = sessionTopic(id);
    const actors: Record<string, ActorId> = {};

    let source = payload.actors?.source;
    if (!source && payload.capture !== false) {
      source = actors.source = resolveActorId(await PostMan.create("./desktopSource.ts", import.meta.url));
      await call(source, "START", { host, port: payload.mediaPort ?? 4460 });
    }
    let input = payload.actors?.input;
    if (!input && payload.input !== false) {
      input = actors.input = resolveActorId(await PostMan.create("./desktopInput.ts", import.meta.url));
    }
    // With a household, this desktop is offered to its other machines, and theirs show here.
    // Actors the caller brought are its own to configure; they cannot take guarded requests.
    const ownActors = !payload.actors?.source && !payload.actors?.input;
    const homeSecret = payload.household === false || !ownActors ? null : householdSecret();
    const household = homeSecret
      ? { secret: homeSecret, topic: await householdTopic(homeSecret) }
      : undefined;
    if (household) {
      if (source && actors.source) await call(source, "SETINPUT", input ?? null);
      for (const actor of [actors.source, actors.input]) {
        if (actor) await call(actor, "SETHOUSEHOLD", household);
      }
    }
    if (payload.mode === "compositor") {
      const localSources: Array<{
        actor: ActorId;
        kind: "desktop" | "vrchat";
        input?: ActorId | null;
        guarded?: boolean;
      }> = [];
      if (source) {
        localSources.push({
          actor: source,
          kind: "desktop",
          input: input ?? null,
          guarded: Boolean(household && actors.source),
        });
      }
      let autoVrchatWallpaper = true;
      if (payload.vrchat) {
        const vrcCfg = typeof payload.vrchat === "object" ? payload.vrchat : {};
        autoVrchatWallpaper = vrcCfg.autoWallpaper ?? true;
        const vrchat = actors.vrchat = resolveActorId(
          await PostMan.create("./vrchatSource.ts", import.meta.url),
        );
        await call(vrchat, "CONFIGURE", {
          host,
          port: vrcCfg.port ?? ((payload.mediaPort ?? 4460) + 50),
          socketPath: vrcCfg.socketPath,
          layout: vrcCfg.layout,
        });
        if (household) await call(vrchat, "SETHOUSEHOLD", household);
        localSources.push({
          actor: vrchat,
          kind: "vrchat",
          input: null,
          guarded: Boolean(household),
        });
      }
      const mediaMux = actors.mediaMux = resolveActorId(
        await PostMan.create("./mediaMux.ts", import.meta.url),
      );
      await call(mediaMux, "START", {
        secret,
        localSources,
        household,
      });
      const inputRouter = actors.inputRouter = resolveActorId(
        await PostMan.create("./inputRouter.ts", import.meta.url),
      );
      await call(inputRouter, "START", { household });
      const compositor = actors.ui = resolveActorId(
        await PostMan.create("./compositor.tsx", import.meta.url),
      );
      await call(compositor, "START", {
        topic: false,
        secret,
        mediaMux,
        inputRouter,
        autoVrchatWallpaper,
        websocket: { hostname: host },
        webtransport: { hostname: host },
      });
      const liaison = actors.liaison = resolveActorId(
        await PostMan.create("./liaison.ts", import.meta.url),
      );
      await call(liaison, "START", {
        role: "host",
        topic,
        secret,
        services: { ui: compositor, mediaMux },
      });
    } else {
      const ui = actors.ui = resolveActorId(await PostMan.create("./ui.tsx", import.meta.url));
      await call(ui, "START", {
        topic: false,
        secret,
        websocket: { hostname: host },
        webtransport: { hostname: host },
        source,
        input,
        household,
      });
      const liaison = actors.liaison = resolveActorId(
        await PostMan.create("./liaison.ts", import.meta.url),
      );
      await call(liaison, "START", {
        role: "host",
        topic,
        secret,
        services: { ui },
      });
    }

    let base = "";
    if (payload.site !== false) {
      const site = actors.site = resolveActorId(await PostMan.create("./site.ts", import.meta.url));
      base = await call<string>(site, "SERVE", {
        hostname: host,
        port: payload.site?.port,
        session: { id, secret },
        password: payload.site?.password,
      });
    }
    state.topic = topic;
    state.actors = actors;
    state.link = `${base}#${formatSessionFragment(id, secret)}`;
    return { topic, link: state.link, url: base || null, actors };
  },
  __HEALTH__: () => ({ ...state }),
} as const);

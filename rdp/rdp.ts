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
import { newSessionSecret, sessionTopic } from "./classes/session.ts";

export type RdpStart = {
  /** Where browsers reach this machine (its tailnet address); default 127.0.0.1. */
  host?: string;
  /** Encoder (WebTransport) port; default 4460. */
  mediaPort?: number;
  /** Serve the page here; default an ephemeral port on `host`. False: host it elsewhere. */
  site?: { port?: number } | false;
  /** Without capture or input (testing, or a view-only session). */
  capture?: boolean;
  input?: boolean;
  /** Use these instead of creating them (tests). */
  actors?: { source?: ActorId; input?: ActorId };
  /** A fixed session secret instead of a random one (tests). */
  secret?: string;
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
    const secret = payload.secret ?? newSessionSecret();
    const topic = await sessionTopic(secret);
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
    const ui = actors.ui = resolveActorId(await PostMan.create("./ui.tsx", import.meta.url));
    await call(ui, "START", {
      secret,
      websocket: { hostname: host },
      webtransport: { hostname: host },
      source,
      input,
    });

    let base = "";
    if (payload.site !== false) {
      const site = actors.site = resolveActorId(await PostMan.create("./site.ts", import.meta.url));
      base = await call<string>(site, "SERVE", { hostname: host, port: payload.site?.port });
    }
    state.topic = topic;
    state.actors = actors;
    state.link = `${base}#${secret}`;
    return { topic, link: state.link, actors };
  },
  __HEALTH__: () => ({ ...state }),
} as const);

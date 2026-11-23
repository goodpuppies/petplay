/**
 * rdpLiaison: single shared actor (runs identically on the host in Deno and in the browser as a
 * Web Worker) whose only job is topic rendezvous and sharing direct actor addresses.
 *
 * - Only `rdp-liaison` joins the session topic (`rdp-<id>`). Every other session actor (`ui`,
 *   `compositor`, `mediaMux`, `rdp-tab`, future audio/clipboard actors) stays off the topic server.
 * - Host mode: verifies `HELLO { secret, peer }`, shares the session's service `ActorId`s via
 *   StageForge `ADDCONTACT` (which attaches their routes on the peer's `PostalService`), and
 *   pushes `DIRECTORY` updates if a service hot-reloads.
 * - Client mode: finds the host `rdp-liaison` on the topic, sends `HELLO`, and forwards the
 *   verified `services` directory to local consumer actors (`rdp-tab`, etc.).
 */
import { type ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { sameSecret } from "./classes/session.ts";
import { LIAISON_ACTOR_NAME, type SessionDirectory } from "./classes/tabProtocol.ts";

export type LiaisonStart =
  | {
    role: "host";
    topic: string;
    secret: string;
    services: SessionDirectory;
  }
  | {
    role: "client";
    topic: string;
    secret: string;
    consumers?: ActorId[];
  };

const POLL_MS = 200;

const state = actorState({
  name: LIAISON_ACTOR_NAME,
  role: null as "host" | "client" | null,
  topic: null as string | null,
  host: null as ActorId | null,
  services: null as SessionDirectory | null,
  peers: 0,
  rejected: 0,
  lastError: null as string | null,
});

let secret = "";
let services: SessionDirectory = {};
const peers = new Set<ActorId>();
const consumers = new Set<ActorId>();
let clientTimer: ReturnType<typeof setInterval> | null = null;
let handshaking = false;

function serviceIds(dir: SessionDirectory): ActorId[] {
  return Object.values(dir).filter((id): id is ActorId => typeof id === "string" && id.length > 0);
}

async function pushToPeer(peer: ActorId, dir: SessionDirectory): Promise<void> {
  const ids = serviceIds(dir);
  if (ids.length > 0) {
    await PostMan.PostMessage({ target: peer, type: "ADDCONTACT", payload: ids }, true);
  }
  await PostMan.PostMessage({ target: peer, type: "DIRECTORY", payload: { services: dir } }, true);
}

function forwardToConsumers(dir: SessionDirectory): void {
  const targets = [...consumers];
  if (targets.length === 0) return;
  const ids = serviceIds(dir);
  if (ids.length > 0) {
    PostMan.PostMessage({ target: targets, type: "ADDCONTACT", payload: ids });
  }
  PostMan.PostMessage({ target: targets, type: "DIRECTORY", payload: { services: dir } });
}

async function pollHost(): Promise<void> {
  if (handshaking || state.role !== "client") return;
  const host = [...state.addressBook].find((id) =>
    String(id).startsWith(`${LIAISON_ACTOR_NAME}@`) && id !== state.id
  );
  if (!host || host === state.host) return;
  handshaking = true;
  try {
    const reply = await PostMan.PostMessage({
      target: host,
      type: "HELLO",
      payload: { secret, peer: state.id },
    }, true) as { services: SessionDirectory };
    state.host = host;
    services = reply.services ?? {};
    state.services = services;
    state.lastError = null;
    forwardToConsumers(services);
  } catch (error) {
    state.lastError = String(error);
  } finally {
    handshaking = false;
  }
}

function stop(): void {
  if (clientTimer) {
    clearInterval(clientTimer);
    clientTimer = null;
  }
  peers.clear();
  consumers.clear();
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    START: (payload: LiaisonStart) => {
      if (state.role) return { topic: state.topic };
      if (typeof payload?.secret !== "string" || payload.secret.length < 16) {
        throw new Error("liaison START needs secret (16+ characters)");
      }
      secret = payload.secret;
      state.role = payload.role;
      state.topic = payload.topic;
      if (payload.role === "host") {
        services = { ...payload.services };
        state.services = services;
      } else {
        for (const c of payload.consumers ?? []) consumers.add(c);
        clientTimer = setInterval(() => void pollHost(), POLL_MS);
      }
      PostMan.setTopic(payload.topic);
      if (payload.role === "client") void pollHost();
      return { topic: payload.topic };
    },
    /** Host: authenticate a peer liaison, share service contacts, and return the directory. */
    HELLO: async (payload: { secret: string; peer?: ActorId }) => {
      if (state.role !== "host") throw new Error("liaison is not in host role");
      if (!sameSecret(payload?.secret, secret)) {
        state.rejected++;
        throw new Error("not part of this session");
      }
      const peer = payload.peer ?? PostMan.sender;
      if (typeof peer !== "string" || !peer) {
        throw new Error("HELLO needs sender or {peer}");
      }
      peers.add(peer);
      state.peers = peers.size;
      const ids = serviceIds(services);
      if (ids.length > 0) {
        await PostMan.PostMessage({ target: peer, type: "ADDCONTACT", payload: ids }, true);
      }
      return { services };
    },
    /** Host: update services (e.g. after hot-reloading compositor) and push to all peers. */
    SET_SERVICES: async (payload: SessionDirectory) => {
      if (state.role !== "host") throw new Error("liaison is not in host role");
      services = { ...payload };
      state.services = services;
      await Promise.all(
        [...peers].map((peer) => pushToPeer(peer, services).catch(() => peers.delete(peer))),
      );
      state.peers = peers.size;
      return true;
    },
    /** Client: receive updated directory from host and forward to local consumers. */
    DIRECTORY: (payload: { services: SessionDirectory }) => {
      services = { ...(payload?.services ?? {}) };
      state.services = services;
      forwardToConsumers(services);
      return true;
    },
    /** Client: subscribe a local actor to receive the current and future service directory. */
    SUBSCRIBE: (payload: { actor: ActorId }) => {
      if (typeof payload?.actor === "string" && payload.actor) {
        consumers.add(payload.actor);
        if (serviceIds(services).length > 0) {
          const ids = serviceIds(services);
          PostMan.PostMessage({ target: payload.actor, type: "ADDCONTACT", payload: ids });
          PostMan.PostMessage({
            target: payload.actor,
            type: "DIRECTORY",
            payload: { services },
          });
        }
      }
      return { services };
    },
    __SHUTDOWN__: () => stop(),
  } as const,
);

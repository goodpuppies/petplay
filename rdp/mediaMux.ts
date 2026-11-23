/**
 * mediaMux: long-lived stream & household multiplexer actor.
 *
 * Owns:
 * - Source discovery: local sources (`desktopSource`, `vrchatSource`, ...) plus remote
 *   household sources on the household topic (`GUARDED` via `HouseholdClient`).
 * - Refcounted active feeds (`ACQUIRE` / `RELEASE`) keyed by `feedId`, mapping each to its
 *   owning `{ source, target, info }`.
 * - Browser WebRTC video brokering: accepts `rdp.media` (`webrtc-video`) transports on the
 *   session topic, validates the session secret, and forwards `WEBRTC_OFFER` by `feedId` to
 *   the owning source actor.
 * - Automatic `FEED_ENDED` propagation when a captured window closes on its host machine.
 *
 * Because `mediaMux` is independent of `compositor`, hot-reloading `compositor` never drops
 * encoders, capture sessions, or active WebRTC feeds.
 */
import {
  type ActorId,
  actorState,
  PostMan,
  registerTransportKind,
  Transport,
} from "../submodules/stageforge/mod.ts";
import { HouseholdClient } from "./classes/household.ts";
import { sameSecret } from "./classes/session.ts";
import {
  type FeedInfo,
  MEDIA_MUX_ACTOR_NAME,
} from "./classes/tabProtocol.ts";
import { MEDIA_PURPOSE, webRtcVideoServerTransport } from "./classes/webRtcVideoTransport.ts";
import type { DesktopDescription, ScreenInfo, WindowInfo } from "./desktopSource.ts";

export type LocalSourceConfig = {
  actor: ActorId;
  kind?: "desktop" | "vrchat";
  machine?: string;
  input?: ActorId | null;
  /** True when this local actor has `SETHOUSEHOLD` enabled and requires `GUARDED` calls. */
  guarded?: boolean;
};

export type MediaMuxStart = {
  /** Session rendezvous topic; `rdp-tab` discovers `rdp-mux@` here to open `rdp.media`. */
  topic?: string;
  /** Session secret validated on incoming `rdp.media` offers. */
  secret: string;
  /** Local source actors owned by this host process. */
  localSources?: LocalSourceConfig[];
  /** Optional household config for discovering and authenticating remote sources. */
  household?: { secret: string; topic: string };
};

export type FeedTarget =
  | { kind: "desktop"; monitor?: number }
  | { kind: "window"; window: string }
  | { kind: "vrchat" };

export type SourceSummary = {
  actor: ActorId;
  machine: string;
  kind: "desktop" | "vrchat";
  local: boolean;
  input: ActorId | null;
  guarded: boolean;
  screens?: ScreenInfo[];
  audio?: boolean;
};

type SourceEntry = SourceSummary & {
  subscribedEnd: boolean;
};

type AcquiredFeed = {
  feedId: string;
  key: string;
  source: ActorId;
  target: FeedTarget;
  info: FeedInfo;
  refs: number;
  /** True if mediaMux started this feed itself (so RELEASE at 0 should STOP it). */
  startedByMux: boolean;
};

const DISCOVER_POLL_MS = 2000;

const state = actorState({
  name: MEDIA_MUX_ACTOR_NAME,
  topic: null as string | null,
  sources: [] as SourceSummary[],
  feeds: {} as Record<string, FeedInfo>,
  rejected: 0,
  lastError: null as string | null,
});

let config: MediaMuxStart | null = null;
let secret = "";
let household = new HouseholdClient(null);
const sources = new Map<ActorId, SourceEntry>();
const feeds = new Map<string, AcquiredFeed>();
const feedsByKey = new Map<string, string>();
const subscribers = new Set<ActorId>();
let nextFeedSeq = 1;
let discoverTimer: ReturnType<typeof setInterval> | null = null;

const post = (msg: { target: string; type: string; payload: unknown }, wait: true) =>
  PostMan.PostMessage(msg, wait);

function targetKey(source: ActorId, target: FeedTarget): string {
  if (target.kind === "window") return `${source}|window|${target.window}`;
  if (target.kind === "vrchat") return `${source}|vrchat`;
  return `${source}|desktop|${target.monitor ?? 0}`;
}

function requestSource<T>(source: ActorId, type: string, payload: unknown = null): Promise<T> {
  const entry = sources.get(source);
  const guarded = entry ? entry.guarded : household.active;
  return household.request<T>(post, source, type, payload, guarded);
}

function feedMap(): Record<string, FeedInfo> {
  const out: Record<string, FeedInfo> = {};
  for (const [id, entry] of feeds) out[id] = entry.info;
  return out;
}

function publishState(): void {
  state.sources = [...sources.values()].map(({ subscribedEnd: _, ...summary }) => summary);
  state.feeds = feedMap();
}

function notifySubscribers(type: string, payload: unknown): void {
  for (const actor of subscribers) {
    try {
      PostMan.PostMessage({ target: actor, type, payload });
    } catch {
      subscribers.delete(actor);
    }
  }
}

function report(error: string): void {
  if (state.lastError === error) return;
  state.lastError = error;
  console.error(`[mediaMux] ${error}`);
}

async function subscribeEnd(entry: SourceEntry): Promise<void> {
  if (entry.subscribedEnd) return;
  entry.subscribedEnd = true;
  await requestSource(entry.actor, "SUBSCRIBE_END", { actor: state.id }).catch(() => {
    // Older agents may not implement SUBSCRIBE_END yet; safe to ignore.
  });
}

function dropFeedsForSource(source: ActorId): void {
  let changed = false;
  for (const [feedId, entry] of [...feeds.entries()]) {
    if (entry.source !== source) continue;
    feeds.delete(feedId);
    feedsByKey.delete(entry.key);
    changed = true;
    notifySubscribers("FEED_ENDED", { feedId });
  }
  if (changed) {
    publishState();
    notifySubscribers("FEEDS_UPDATED", { feeds: feedMap() });
  }
}

async function discover(): Promise<void> {
  let sourcesChanged = false;
  if (config?.localSources) {
    for (const local of config.localSources) {
      if (sources.has(local.actor)) continue;
      let described: DesktopDescription | null = null;
      const guarded = local.guarded ?? false;
      try {
        described = await household.request<DesktopDescription>(
          post,
          local.actor,
          "DESCRIBE",
          null,
          guarded,
        );
      } catch {
        // Local source may not be fully ready yet; use provided metadata.
      }
      const entry: SourceEntry = {
        actor: local.actor,
        machine: described?.machine ?? local.machine ?? Deno.hostname(),
        kind: described?.kind ?? local.kind ?? "desktop",
        local: true,
        input: (described?.input as ActorId | null) ?? local.input ?? null,
        guarded,
        screens: described?.screens,
        audio: described?.audio,
        subscribedEnd: false,
      };
      sources.set(local.actor, entry);
      sourcesChanged = true;
      void subscribeEnd(entry);
    }
  }

  if (config?.household) {
    const known = new Set([...state.addressBook].map(String));
    for (const [id, entry] of [...sources.entries()]) {
      if (!entry.local && !known.has(id)) {
        sources.delete(id);
        dropFeedsForSource(id);
        sourcesChanged = true;
      }
    }
    for (const id of known) {
      const isSource = id.startsWith("desktopSource@") || id.startsWith("vrchatSource@");
      if (!isSource || sources.has(id as ActorId)) continue;
      try {
        const described = await household.request<DesktopDescription>(
          post,
          id as ActorId,
          "DESCRIBE",
          null,
          true,
        );
        const kind = described.kind ?? (id.startsWith("vrchatSource@") ? "vrchat" : "desktop");
        // If a remote agent restarted under a new actor id, forget its previous entry.
        for (const [oldId, old] of [...sources.entries()]) {
          if (!old.local && old.machine === described.machine && old.kind === kind) {
            sources.delete(oldId);
            dropFeedsForSource(oldId);
          }
        }
        const entry: SourceEntry = {
          actor: id as ActorId,
          machine: described.machine,
          kind,
          local: false,
          input: (described.input as ActorId | null) ?? null,
          guarded: true,
          screens: described.screens,
          audio: described.audio,
          subscribedEnd: false,
        };
        sources.set(id as ActorId, entry);
        sourcesChanged = true;
        void subscribeEnd(entry);
      } catch (error) {
        report(`DESCRIBE ${id}: ${error}`);
      }
    }
  }

  if (sourcesChanged) {
    publishState();
    notifySubscribers("SOURCES_UPDATED", { sources: state.sources });
  }
}

async function acquire(
  source: ActorId,
  target: FeedTarget,
  requestedFeedId?: string,
): Promise<{ feedId: string; info: FeedInfo }> {
  const key = targetKey(source, target);
  const existingId = feedsByKey.get(key);
  if (existingId) {
    const existing = feeds.get(existingId);
    if (existing) {
      existing.refs++;
      return { feedId: existing.feedId, info: existing.info };
    }
  }

  const reqPayload = target.kind === "window"
    ? { window: target.window }
    : target.kind === "desktop" && target.monitor !== undefined
    ? { monitor: target.monitor }
    : null;

  let info = await requestSource<FeedInfo | null>(source, "FEED", reqPayload);
  let startedByMux = false;
  if (!info) {
    info = await requestSource<FeedInfo>(source, "START", reqPayload);
    startedByMux = true;
  }

  const feedId = requestedFeedId && !feeds.has(requestedFeedId)
    ? requestedFeedId
    : `f${nextFeedSeq++}`;

  const acquired: AcquiredFeed = {
    feedId,
    key,
    source,
    target,
    info,
    refs: 1,
    startedByMux,
  };
  feeds.set(feedId, acquired);
  feedsByKey.set(key, feedId);
  publishState();
  notifySubscribers("FEEDS_UPDATED", { feeds: feedMap() });
  return { feedId, info };
}

async function release(feedId: string): Promise<true> {
  const entry = feeds.get(feedId);
  if (!entry) return true;
  entry.refs--;
  if (entry.refs > 0) return true;
  feeds.delete(feedId);
  feedsByKey.delete(entry.key);
  publishState();
  notifySubscribers("FEEDS_UPDATED", { feeds: feedMap() });

  if (entry.target.kind === "window") {
    await requestSource(entry.source, "STOP", { window: entry.target.window }).catch(() => {});
  } else if (entry.startedByMux && entry.target.kind === "desktop") {
    await requestSource(
      entry.source,
      "STOP",
      entry.target.monitor !== undefined ? { monitor: entry.target.monitor } : null,
    ).catch(() => {});
  }
  return true;
}

function handleFeedEnded(payload: { source?: string; window?: string } | null): void {
  const source = payload?.source;
  const windowId = payload?.window;
  let changed = false;
  for (const [feedId, entry] of [...feeds.entries()]) {
    if (source && entry.source !== source) continue;
    if (windowId) {
      if (entry.target.kind !== "window" || entry.target.window !== windowId) continue;
    } else if (!source) {
      continue;
    }
    feeds.delete(feedId);
    feedsByKey.delete(entry.key);
    changed = true;
    notifySubscribers("FEED_ENDED", { feedId });
  }
  if (changed) {
    publishState();
    notifySubscribers("FEEDS_UPDATED", { feeds: feedMap() });
  }
}

async function stop(): Promise<void> {
  if (discoverTimer) {
    clearInterval(discoverTimer);
    discoverTimer = null;
  }
  for (const entry of [...feeds.values()]) {
    if (entry.target.kind === "window") {
      await requestSource(entry.source, "STOP", { window: entry.target.window }).catch(() => {});
    }
  }
  feeds.clear();
  feedsByKey.clear();
  subscribers.clear();
  publishState();
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state, activeFeedCount: feeds.size }),
    START: async (payload: MediaMuxStart) => {
      if (config) return true;
      if (typeof payload?.secret !== "string" || payload.secret.length < 16) {
        throw new Error("mediaMux START needs secret (16+ characters)");
      }
      config = payload;
      secret = payload.secret;
      household = new HouseholdClient(payload.household?.secret ?? null);

      registerTransportKind(webRtcVideoServerTransport(async (params, offerSdp) => {
        if (!sameSecret(params.secret, secret)) {
          state.rejected++;
          throw new Error("not part of this session");
        }
        const feedId = typeof params.feed === "string" ? params.feed : "";
        const entry = feeds.get(feedId);
        if (!entry) throw new Error(`unknown media feed: ${feedId}`);
        const offerPayload: { sdp: string; window?: string; monitor?: number } = { sdp: offerSdp };
        if (entry.target.kind === "window") offerPayload.window = entry.target.window;
        else if (entry.target.kind === "desktop" && entry.target.monitor !== undefined) {
          offerPayload.monitor = entry.target.monitor;
        }
        const { sdp } = await requestSource<{ sdp: string }>(
          entry.source,
          "WEBRTC_OFFER",
          offerPayload,
        );
        return sdp;
      }));
      Transport.accept(MEDIA_PURPOSE, () => {});

      if (payload.household) PostMan.setTopic(payload.household.topic);
      if (payload.topic) {
        PostMan.setTopic(payload.topic);
        state.topic = payload.topic;
      }
      await discover();
      discoverTimer = setInterval(() => void discover(), DISCOVER_POLL_MS);
      return true;
    },
    LISTSOURCES: async () => {
      await discover();
      return state.sources;
    },
    LISTWINDOWS: async (payload: { source: ActorId }): Promise<WindowInfo[]> => {
      const listed = await requestSource<WindowInfo[]>(payload.source, "LISTWINDOWS");
      return Array.isArray(listed) ? listed : [];
    },
    ACQUIRE: (
      payload: { source: ActorId; target: FeedTarget; feedId?: string },
    ): Promise<{ feedId: string; info: FeedInfo }> =>
      acquire(payload.source, payload.target, payload.feedId),
    RELEASE: (payload: { feedId: string }): Promise<true> => release(payload.feedId),
    FOCUS: async (payload: { source: ActorId; window: string }): Promise<true> => {
      await requestSource(payload.source, "FOCUSWINDOW", { window: payload.window });
      return true;
    },
    SUBSCRIBE: (payload: { actor: ActorId }) => {
      if (typeof payload?.actor === "string" && payload.actor) subscribers.add(payload.actor);
      return { sources: state.sources, feeds: feedMap() };
    },
    FEED_ENDED: (payload: { source?: string; window?: string } | null) => {
      handleFeedEnded(payload);
      return true;
    },
    __SHUTDOWN__: () => stop(),
  } as const,
);

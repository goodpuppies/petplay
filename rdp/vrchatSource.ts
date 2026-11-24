/**
 * vrchatSource: exposes `petplay_ovrdriver` -> `petplayMedia@*` as a standard `MediaSource` actor.
 *
 * Delegates all `dmabuf-seqpacket` transport & encoder lifecycle to `DesktopMediaFeed`, while
 * exposing the `MediaSource` contract (`DESCRIBE`, `START`, `STOP`, `FEED`, `WEBRTC_OFFER`,
 * `SUBSCRIBE_END`, `SETHOUSEHOLD`, `GUARDED`) for `mediaMux` and `compositor`.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { DesktopMediaFeed } from "../classes/sceneStreamMedia.ts";
import { guardedDispatch, HouseholdGuard, refuseWhenGuarded } from "./classes/household.ts";
import type { DesktopDescription, FeedInfo } from "./desktopSource.ts";

export type VrchatSourceConfig = {
  /** Where browsers reach the encoder: 127.0.0.1, or this machine's tailnet address. */
  host: string;
  port: number;
  /** Unix seqpacket socket path (`PP_MEDIA_SOCKET`). */
  socketPath?: string;
  /** Frame layout produced by the driver ("mono" or "side-by-side"). */
  layout?: "mono" | "side-by-side";
  fps?: number;
  bitrate?: number;
  share?: boolean;
};

const state = actorState({
  name: "vrchatSource",
  running: false,
  socketPath: null as string | null,
  feed: null as FeedInfo | null,
  lastError: null as string | null,
});

const guard = new HouseholdGuard();
const endSubscribers = new Set<string>();
let defaults: VrchatSourceConfig | null = null;
let active: { media: DesktopMediaFeed; info: FeedInfo } | null = null;
let starting: Promise<FeedInfo> | null = null;

function defaultSocketPath(): string {
  const fromEnv = Deno.env.get("PP_MEDIA_SOCKET");
  if (fromEnv) return fromEnv;
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") ?? `/run/user/${Deno.uid()}`;
  return `${runtime}/petplay_ovrdriver/media.sock`;
}

function notifyEnded(): void {
  for (const target of endSubscribers) {
    try {
      PostMan.PostMessage({ target, type: "FEED_ENDED", payload: { source: state.id } });
    } catch {
      endSubscribers.delete(target);
    }
  }
}

function startFeed(payload?: Partial<VrchatSourceConfig> | null): Promise<FeedInfo> {
  if (Deno.build.os !== "linux") {
    return Promise.reject(new Error(`vrchatSource requires Linux VA-API (got ${Deno.build.os})`));
  }
  if (active) return Promise.resolve(active.info);
  if (starting) return starting;

  const cfg: VrchatSourceConfig = {
    host: payload?.host ?? defaults?.host ?? "",
    port: payload?.port ?? defaults?.port ?? NaN,
    socketPath: payload?.socketPath ?? defaults?.socketPath ?? defaultSocketPath(),
    layout: payload?.layout ?? defaults?.layout ?? "mono",
    fps: payload?.fps ?? defaults?.fps ?? 60,
    bitrate: payload?.bitrate ?? defaults?.bitrate ?? 12_000_000,
    share: payload?.share ?? defaults?.share ?? guard.active,
  };
  if (!cfg.host || !Number.isInteger(cfg.port)) {
    return Promise.reject(new Error("vrchatSource START needs {host, port} or CONFIGURE first"));
  }
  defaults ??= cfg;

  starting = (async () => {
    try {
      const media = await DesktopMediaFeed.start({
        host: cfg.host,
        port: cfg.port,
        socketPath: cfg.socketPath,
        layout: cfg.layout ?? "mono",
        fps: cfg.fps ?? 60,
        bitrate: cfg.bitrate ?? 12_000_000,
        share: Boolean(cfg.share),
        actorFeedId: "vrchat",
      });
      const info: FeedInfo = {
        host: cfg.host,
        port: media.info.port,
        fingerprint: media.info.fingerprint,
        ...(media.info.code ? { code: media.info.code } : {}),
        ...(media.info.webrtc ? { webrtc: true } : {}),
        ...(cfg.layout === "side-by-side" ? { crop: { x: 0, y: 0, width: 0.5, height: 1 } } : {}),
      };
      const entry = { media, info };
      active = entry;
      state.running = true;
      state.socketPath = media.socketPath;
      state.feed = info;
      state.lastError = null;

      void media.exited.then(() => {
        if (active !== entry) return;
        active = null;
        state.running = false;
        state.feed = null;
        notifyEnded();
      });
      return info;
    } catch (error) {
      state.lastError = String(error);
      throw error;
    }
  })().finally(() => {
    starting = null;
  });

  return starting;
}

async function stopFeed(): Promise<void> {
  const current = active;
  active = null;
  state.running = false;
  state.feed = null;
  await current?.media.stop();
}

async function acceptWebRtcOffer(offerSdp: string): Promise<{ sdp: string }> {
  if (!active) throw new Error("vrchatSource has no running WebRTC encoder");
  return { sdp: await active.media.acceptWebRtcOffer(offerSdp) };
}

function describe(): DesktopDescription {
  return {
    machine: `${Deno.hostname()} · VRChat`,
    kind: "vrchat",
    input: null,
    feed: state.feed,
    audio: false,
  };
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    CONFIGURE: refuseWhenGuarded(guard, (payload: VrchatSourceConfig) => {
      defaults = { ...payload };
      return true;
    }),
    SETHOUSEHOLD: refuseWhenGuarded(guard, async (payload: { secret: string; topic: string }) => {
      await guard.enable(payload.secret, state.id);
      PostMan.setTopic(payload.topic);
      return true;
    }),
    DESCRIBE: refuseWhenGuarded(guard, describe),
    START: refuseWhenGuarded(guard, (payload?: Partial<VrchatSourceConfig>) => startFeed(payload)),
    FEED: refuseWhenGuarded(guard, () => state.feed),
    STOP: refuseWhenGuarded(guard, async () => {
      await stopFeed();
      return true;
    }),
    LISTWINDOWS: refuseWhenGuarded(guard, () => []),
    WEBRTC_OFFER: refuseWhenGuarded(guard, (payload: { sdp: string }) => {
      if (typeof payload?.sdp !== "string" || !payload.sdp) {
        throw new Error("WEBRTC_OFFER needs {sdp}");
      }
      return acceptWebRtcOffer(payload.sdp);
    }),
    SUBSCRIBE_END: refuseWhenGuarded(guard, (payload: { actor?: string } | string) => {
      const actor = typeof payload === "string" ? payload : payload?.actor;
      if (typeof actor === "string" && actor) endSubscribers.add(actor);
      return true;
    }),
    GUARDED: guardedDispatch(guard, {
      DESCRIBE: describe,
      START: (p) => startFeed(p as Partial<VrchatSourceConfig> | undefined),
      FEED: () => state.feed,
      STOP: async () => {
        await stopFeed();
        return true;
      },
      LISTWINDOWS: () => [],
      WEBRTC_OFFER: (p) => {
        const sdp = (p as { sdp?: unknown } | null)?.sdp;
        if (typeof sdp !== "string" || !sdp) throw new Error("WEBRTC_OFFER needs {sdp}");
        return acceptWebRtcOffer(sdp);
      },
      SUBSCRIBE_END: (p) => {
        const actor = typeof p === "string" ? p : (p as { actor?: unknown } | null)?.actor;
        if (typeof actor === "string" && actor) endSubscribers.add(actor);
        return true;
      },
    }),
    __SHUTDOWN__: () => stopFeed(),
  } as const,
);

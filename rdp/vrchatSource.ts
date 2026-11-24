/**
 * vrchatSource: exposes `petplay_ovrdriver` -> `petplayMedia@*` as a standard `MediaSource` actor.
 *
 * Implements the same actor contract as `desktopSource` (`DESCRIBE`, `START`, `STOP`, `FEED`,
 * `WEBRTC_OFFER`, `SUBSCRIBE_END`, `SETHOUSEHOLD`, `GUARDED`), so `mediaMux` and `compositor`
 * can treat VRChat (or any SteamVR app running through `petplay_ovrdriver`) identically to a
 * desktop or window feed — for example, as a live wallpaper behind floating windows.
 *
 * Control RPCs (`START_SOCKET_FEED`, `WEBRTC_OFFER`, `STOP_FEED`) go to the shared
 * `petplayMedia@*` StageForge native actor (`NativeStdioProxy`), while GPU frames travel
 * directly from `petplay_ovrdriver` (`media_export.zig`) to `petplay-media` over the Linux
 * `SOCK_SEQPACKET` DMA-BUF socket at `PP_MEDIA_SOCKET`.
 */
import { type ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { guardedDispatch, HouseholdGuard, refuseWhenGuarded } from "./classes/household.ts";
import { ensurePetplayMedia } from "./classes/petplayMediaActor.ts";
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

type SocketFeedResponse = {
  id: string;
  socketPath: string;
  host: string;
  port: number;
  fingerprint: string;
  code?: string;
  webrtc?: boolean;
};

const FEED_ID = "vrchat";

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
let active: {
  mediaActor: ActorId;
  feedId: string;
  info: FeedInfo;
  socketPath: string;
} | null = null;
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
      const mediaActor = await ensurePetplayMedia();
      const socketPath = cfg.socketPath!;
      const res = await PostMan.PostMessage({
        target: mediaActor,
        type: "START_SOCKET_FEED",
        payload: {
          id: FEED_ID,
          socketPath,
          host: cfg.host,
          port: cfg.port,
          layout: cfg.layout ?? "mono",
          fps: cfg.fps ?? 60,
          maxFps: cfg.fps ?? 60,
          bitrate: cfg.bitrate ?? 12_000_000,
          persist: true,
          share: Boolean(cfg.share),
          subscriber: state.id,
        },
      }, true) as SocketFeedResponse;

      const info: FeedInfo = {
        host: res.host,
        port: res.port,
        fingerprint: res.fingerprint,
        ...(res.code ? { code: res.code } : {}),
        ...(res.webrtc ? { webrtc: true } : {}),
        ...(cfg.layout === "side-by-side" ? { crop: { x: 0, y: 0, width: 0.5, height: 1 } } : {}),
      };
      active = { mediaActor, feedId: res.id, info, socketPath: res.socketPath };
      state.running = true;
      state.socketPath = res.socketPath;
      state.feed = info;
      state.lastError = null;
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
  if (!current) return;
  await PostMan.PostMessage({
    target: current.mediaActor,
    type: "STOP_FEED",
    payload: { id: current.feedId },
  }, true).catch(() => {});
}

async function acceptWebRtcOffer(offerSdp: string): Promise<{ sdp: string }> {
  const current = active;
  if (!current) throw new Error("vrchatSource has no running WebRTC encoder");
  return await PostMan.PostMessage({
    target: current.mediaActor,
    type: "WEBRTC_OFFER",
    payload: { id: current.feedId, sdp: offerSdp },
  }, true) as { sdp: string };
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
    FEED_ENDED: (payload: { id?: string }) => {
      if (active && (!payload?.id || payload.id === active.feedId)) {
        active = null;
        state.running = false;
        state.feed = null;
        notifyEnded();
      }
      return true;
    },
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

/**
 * vrchatSource: exposes `petplay_ovrdriver` -> `petplay-media` as a standard `MediaSource` actor.
 *
 * Implements the same actor contract as `desktopSource` (`DESCRIBE`, `START`, `STOP`, `FEED`,
 * `WEBRTC_OFFER`, `SUBSCRIBE_END`, `SETHOUSEHOLD`, `GUARDED`), so `mediaMux` and `compositor`
 * can treat VRChat (or any SteamVR app running through `petplay_ovrdriver`) identically to a
 * desktop or window feed — for example, as a live wallpaper behind floating windows.
 *
 * `petplay_ovrdriver`'s Vulkan capture layer (`media_export.zig`) connects to the Unix seqpacket
 * socket at `PP_MEDIA_SOCKET` (default `/run/user/<uid>/petplay_ovrdriver/media.sock`). This actor
 * runs `petplay-media --persist` on that socket so SteamVR/VRChat can attach or restart anytime.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { dirname } from "@std/path";
import { petplayMediaCommand, petplayMediaPath } from "../classes/petplayMediaPath.ts";
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

const READY_TIMEOUT_MS = 10_000;
const SHARE_READY_TIMEOUT_MS = 25_000;

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
  child: Deno.ChildProcess;
  info: FeedInfo;
  webrtcOfferUrl: string | null;
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

async function drainLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let buffered = "";
  try {
    for await (
      const chunk of stream.pipeThrough(
        new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
      )
    ) {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
      }
    }
  } catch { /* closed */ }
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
    const socketPath = cfg.socketPath!;
    await Deno.mkdir(dirname(socketPath), { recursive: true }).catch(() => {});
    await Deno.remove(socketPath).catch(() => {});

    const child = petplayMediaCommand([
      socketPath,
      "-",
      `${cfg.host}:${cfg.port}`,
      "--layout",
      cfg.layout ?? "mono",
      "--fps",
      String(cfg.fps ?? 60),
      "--bitrate",
      String(cfg.bitrate ?? 12_000_000),
      "--persist",
      "--max-fps",
      String(cfg.fps ?? 60),
      ...(cfg.share ? ["--iroh-share"] : []),
    ], {
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const log: string[] = [];
    const keep = (line: string) => {
      log.push(line);
      if (log.length > 100) log.shift();
    };
    const drained = [drainLines(child.stderr, keep)];

    try {
      let code: string | null = null;
      let webrtcOfferUrl: string | null = null;
      const fingerprint = await new Promise<string>((resolve, reject) => {
        let fp: string | null = null;
        const timer = setTimeout(
          () =>
            reject(new Error(`vrchatSource petplay-media not ready: ${log.at(-1) ?? "no output"}`)),
          cfg.share ? SHARE_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
        );
        drained.push(drainLines(child.stdout, (line) => {
          keep(line);
          code ??= line.match(/^IROH_SHARE code=(\S+)/)?.[1] ?? null;
          webrtcOfferUrl ??= line.match(/^WEBRTC_READY (\S+)/)?.[1] ?? null;
          fp ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
          if (line.startsWith("MEDIA_READY") && fp && (code || !cfg.share)) {
            clearTimeout(timer);
            resolve(fp);
          }
        }));
        child.status.then(async (status) => {
          clearTimeout(timer);
          await Promise.race([Promise.allSettled(drained), new Promise((r) => setTimeout(r, 500))]);
          reject(
            new Error(`vrchatSource petplay-media exited (${status.code}): ${log.at(-1) ?? ""}`),
          );
        });
      });

      const info: FeedInfo = {
        host: cfg.host,
        port: cfg.port,
        fingerprint,
        ...(code ? { code } : {}),
        ...(webrtcOfferUrl ? { webrtc: true } : {}),
        ...(cfg.layout === "side-by-side" ? { crop: { x: 0, y: 0, width: 0.5, height: 1 } } : {}),
      };
      const entry = { child, info, webrtcOfferUrl, socketPath };
      active = entry;
      state.running = true;
      state.socketPath = socketPath;
      state.feed = info;
      state.lastError = null;

      void child.status.then(() => {
        if (active !== entry) return;
        active = null;
        state.running = false;
        state.feed = null;
        notifyEnded();
      });
      return info;
    } catch (error) {
      state.lastError = String(error);
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
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
  try {
    current.child.kill("SIGTERM");
  } catch { /* gone */ }
  await Promise.race([current.child.status, new Promise((r) => setTimeout(r, 2000))]);
  try {
    current.child.kill("SIGKILL");
  } catch { /* gone */ }
}

async function acceptWebRtcOffer(offerSdp: string): Promise<{ sdp: string }> {
  const url = active?.webrtcOfferUrl;
  if (!url) throw new Error("vrchatSource has no running WebRTC encoder");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/sdp" },
    body: offerSdp,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WebRTC offer rejected (${response.status}): ${text}`);
  return { sdp: text };
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

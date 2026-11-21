/**
 * desktopSource: this machine's desktop capture, as an actor. The one capture on a machine:
 * every consumer of the desktop's pixels gets them from here, so there is one portal session and
 * one restore token.
 *
 * It runs the capture helper (`CaptureHelper`: `screen-streamer`) with the outputs its consumers
 * ask for, restarting it when they change:
 * - a frame sink (`ADDFRAMESINK {port, fps}`): a `FrameReceiver` port, RGBA frames for whoever
 *   shows them (the VR overlay host);
 * - the encoder (`START {host, port}`): `petplay-media --persist` (`classes/sceneStreamMedia.ts`),
 *   VA-API H.264 served over WebTransport; `FEED` tells receivers `{host, port, fingerprint}`.
 *   Or an encoder someone else runs (`SETMEDIASOCKET {path}`, the scene stream's).
 *
 * Policy, as the overlay host had it: a helper that loses a working capture is restarted with
 * backoff (1 s doubling to 30 s, reset after a minute of running); one that never started (the
 * portal refused or was cancelled) is not, since each start would open a new picker. The next
 * consumer change (opening the desktop again) retries. Subscribers (`SUBSCRIBESTATUS`) get
 * `CAPTURESTATUS {event: "lost" | "recovered" | "unavailable", message?}`.
 *
 * For other machines: `CONFIGURE {host, port}` sets where the encoder serves, so `START` needs no
 * payload; `SETINPUT` pairs the desktopInput that drives this desktop; `DESCRIBE` returns
 * `{machine, input, feed, screens}`. In a household (`SETHOUSEHOLD`, `classes/household.ts`) requests
 * come only as `GUARDED` with a proof, and the local-only messages are refused.
 *
 * `LAYOUT` returns the monitors as crops of the capture (`workspaceDisplays.ts`).
 *
 * The encoder: on Linux the helper publishes into `petplay-media`'s media socket, one feed of the
 * whole workspace. On Windows each monitor is its own feed: `petplay-media capture-wgc` captures
 * one monitor itself (`classes/wgcMediaFeed.ts`), all on the GPU, on `port + index`, and its feed
 * also carries an iroh share `code`. `DESCRIBE` lists them as `screens`, with the rectangle each
 * covers on the virtual desktop (input `region`s); `START`, `FEED` and `STOP` take `{monitor}`,
 * without it the configured one. Frame sinks work wherever the helper does.
 *
 * Audio, Windows for now: `AUDIO` starts the machine's sound (every app but VRChat and PetPlay,
 * `WgcMediaFeed.audio`) on `port + 100` if it is not running and returns its feed; `STOPAUDIO`
 * ends it. `DESCRIBE` says `audio: true` where it can.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { join } from "@std/path";
import { DesktopMediaFeed } from "../classes/sceneStreamMedia.ts";
import { regionOf, WgcMediaFeed, wgcMonitors } from "./classes/wgcMediaFeed.ts";
import { CaptureHelper } from "../classes/ScreenCapturer/captureHelper.ts";
import { clampCaptureFps, DEFAULT_CAPTURE_FPS } from "../classes/ScreenCapturer/scclass.ts";
import {
  screenStreamerPath,
  stopStaleScreenStreamer,
} from "../classes/ScreenCapturer/screenStreamerPath.ts";
import { configDir } from "../classes/appPaths.ts";
import { guardedDispatch, HouseholdGuard, refuseWhenGuarded } from "./classes/household.ts";
import {
  loadWorkspaceOutputs,
  type WorkspaceOutput,
} from "../classes/environment/workspaceDisplays.ts";

export type SourceRequest = {
  /** Where receivers reach the encoder: 127.0.0.1, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
  /** Windows: the monitor to capture (`capture-wgc --list` index). */
  monitor?: number;
};

/**
 * Where receivers reach the encoder: its pinned WebTransport listener, and on Windows also an
 * iroh share `code`, which native receivers prefer (it passes firewalls).
 */
export type FeedInfo = { host: string; port: number; fingerprint: string; code?: string };
/** One monitor a Windows machine offers as its own feed. */
export type ScreenInfo = {
  index: number;
  name: string;
  width: number;
  height: number;
  primary: boolean;
  /** Its rectangle on the virtual desktop, as fractions: where its input positions go. */
  region: { x: number; y: number; width: number; height: number };
};
export type DesktopDescription = {
  machine: string;
  input: string | null;
  feed: FeedInfo | null;
  /** Windows: every monitor, each its own feed. Absent: one feed of the whole workspace. */
  screens?: ScreenInfo[];
  /** The machine's sound can be had (`AUDIO`). */
  audio?: boolean;
};
export type CaptureStatus = { event: "lost" | "recovered" | "unavailable"; message?: string };

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const STABLE_MS = 60_000;

const state = actorState({
  name: "desktopSource",
  capturing: false,
  captureStarted: false,
  capturePid: null as number | null,
  captureArgs: null as { framePort: number | null; mediaSocket: string | null; fps: number } | null,
  /** The last helper never started; waiting for a consumer change to try again. */
  refused: false,
  captureRestarts: 0,
  encoderRestarts: 0,
  lastError: null as string | null,
  /** The configured monitor's feed (the only one on Linux). */
  feed: null as FeedInfo | null,
  /** Every running feed, by monitor. */
  feeds: {} as Record<string, FeedInfo>,
});

/** Consumers. */
let frameSink: { port: number; fps: number } | null = null;
let externalMediaSocket: string | null = Deno.env.get("PETPLAY_DESKTOP_MEDIA_SOCKET") || null;
let feedDefaults: SourceRequest | null = null;
let pairedInput: string | null = null;
const guard = new HouseholdGuard();
/** Running feeds by monitor; Linux has one, monitor 0, the whole workspace. */
type Running = { encoder: DesktopMediaFeed | WgcMediaFeed; request: SourceRequest; info: FeedInfo };
const running = new Map<number, Running>();
let screens: ScreenInfo[] | null = null;
/** The machine's sound: its feed, or the start in progress. */
let audio: { encoder: WgcMediaFeed; info: FeedInfo } | null = null;
let audioStarting: Promise<FeedInfo> | null = null;
/** Ports above the monitors' feeds. */
const AUDIO_PORT_OFFSET = 100;

function startAudio(): Promise<FeedInfo | null> {
  if (Deno.build.os !== "windows") return Promise.resolve(null);
  if (audio) return Promise.resolve(audio.info);
  if (audioStarting) return audioStarting;
  const defaults = feedDefaults;
  if (!defaults || typeof defaults.host !== "string" || !Number.isInteger(defaults.port)) {
    return Promise.reject(new Error("AUDIO needs CONFIGURE first"));
  }
  const port = defaults.port + AUDIO_PORT_OFFSET;
  audioStarting = (async () => {
    const encoder = await WgcMediaFeed.audio({ host: defaults.host, port });
    const started = {
      encoder,
      info: { host: defaults.host, port, fingerprint: encoder.info.fingerprint, code: encoder.info.code },
    };
    audio = started;
    // An exit leaves no feed; the next AUDIO starts another.
    void encoder.exited.then(() => {
      if (audio === started) audio = null;
    });
    return started.info;
  })().finally(() => audioStarting = null);
  return audioStarting;
}

async function stopAudio(): Promise<void> {
  const running = audio;
  audio = null;
  await running?.encoder.stop();
}
const subscribers = new Set<string>();

let helper: CaptureHelper | null = null;
let applying: Promise<void> = Promise.resolve();
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartDelay = RESTART_MIN_MS;
let startedAt = 0;
let recovering = false;
let shuttingDown = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(status: CaptureStatus): void {
  for (const target of subscribers) {
    try {
      PostMan.PostMessage({ target, type: "CAPTURESTATUS", payload: status });
    } catch {
      subscribers.delete(target);
    }
  }
}

function wanted(): { framePort: number | null; mediaSocket: string | null; fps: number } | null {
  const linux = running.get(0);
  const mediaSocket = linux?.encoder.socketPath ?? externalMediaSocket;
  if (!frameSink && !mediaSocket) return null;
  const fps = Math.max(frameSink?.fps ?? 0, linux?.request.fps ?? 0) || DEFAULT_CAPTURE_FPS;
  return { framePort: frameSink?.port ?? null, mediaSocket, fps: clampCaptureFps(fps) };
}

/** A consumer changed: retry even after a refusal, and bring the helper in line. */
function consumersChanged(): Promise<void> {
  state.refused = false;
  return reconcile();
}

function reconcile(): Promise<void> {
  applying = applying.then(apply).catch((error) => {
    state.lastError = String(error);
  });
  return applying;
}

async function apply(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const want = shuttingDown ? null : wanted();
  const current = helper;
  if (
    current && want && current.framePort === want.framePort &&
    current.mediaSocket === want.mediaSocket && current.fps === want.fps
  ) return;
  if (current) {
    helper = null;
    await current.stop();
  }
  state.capturing = false;
  state.captureStarted = false;
  state.capturePid = null;
  state.captureArgs = want;
  if (!want || state.refused) return;
  await stopStaleScreenStreamer();
  const started = new CaptureHelper({
    executablePath: screenStreamerPath(),
    fps: want.fps,
    tokenPath: join(configDir(), "screencast-restore-token"),
    framePort: want.framePort,
    mediaSocket: want.mediaSocket,
    // As the overlay host logged it: progress, portal messages, the reason for an exit.
    log: (line) => console.log(`[desktopSource] ${line}`),
    onStarted: () => {
      if (helper !== started) return;
      state.captureStarted = true;
      startedAt = performance.now();
      if (recovering) {
        recovering = false;
        notify({ event: "recovered" });
      }
    },
  });
  helper = started;
  state.capturing = true;
  state.capturePid = started.pid;
  void started.exited.then((status) => onExit(started, status));
}

function onExit(exited: CaptureHelper, status: Deno.CommandStatus): void {
  if (helper !== exited || shuttingDown) return; // stopped on purpose
  helper = null;
  state.capturing = false;
  state.capturePid = null;
  const message = `screen-streamer exited (code=${status.code})` +
    (exited.lastError ? `: ${exited.lastError}` : "");
  state.lastError = message;
  if (!exited.started) {
    // Refused, cancelled or no source: a restart would open a new picker every few seconds.
    state.refused = true;
    recovering = false;
    notify({ event: "unavailable", message: exited.lastError ?? undefined });
    return;
  }
  if (!recovering) notify({ event: "lost", message });
  recovering = true;
  if (performance.now() - startedAt > STABLE_MS) restartDelay = RESTART_MIN_MS;
  const delay = restartDelay;
  restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    state.captureRestarts++;
    void reconcile();
  }, delay);
}

function monitorOf(payload?: { monitor?: unknown } | null): number {
  if (Deno.build.os !== "windows") return 0;
  const monitor = payload?.monitor ?? feedDefaults?.monitor ?? 0;
  if (!Number.isInteger(monitor) || (monitor as number) < 0) throw new Error("monitor is an index");
  return monitor as number;
}

function publishFeeds(): void {
  state.feeds = Object.fromEntries([...running].map(([monitor, r]) => [monitor, r.info]));
  state.feed = running.get(monitorOf(null))?.info ?? null;
}

async function startEncoder(
  monitor: number,
  request: SourceRequest,
  directory?: string,
): Promise<Running> {
  const encoder = Deno.build.os === "windows"
    ? await WgcMediaFeed.start({
      host: request.host,
      // One listener per monitor.
      port: request.port + monitor,
      monitor,
      fps: request.fps,
      bitrate: request.bitrate,
    })
    : await DesktopMediaFeed.start({
      host: request.host,
      port: request.port,
      fps: request.fps,
      bitrate: request.bitrate,
      directory,
      // A household feed also gets a share code: the Windows receiver takes nothing else, and
      // it reaches past NATs and firewalls.
      share: guard.active,
    });
  const started: Running = {
    encoder,
    request,
    info: {
      host: request.host,
      port: encoder.info.port,
      fingerprint: encoder.info.fingerprint,
      ...(encoder.info.code ? { code: encoder.info.code } : {}),
    },
  };
  running.set(monitor, started);
  publishFeeds();
  void superviseEncoder(monitor, started);
  return started;
}

async function superviseEncoder(monitor: number, feed: Running): Promise<void> {
  await feed.encoder.exited;
  let delay = 1000;
  while (!shuttingDown && running.get(monitor) === feed) {
    state.lastError = `encoder ${monitor} exited: ${feed.encoder.log.at(-1) ?? ""}`;
    await sleep(delay);
    if (shuttingDown || running.get(monitor) !== feed) return;
    try {
      // Same directory, so the capture helper finds the replacement on the same socket.
      await startEncoder(monitor, feed.request, feed.encoder.directoryPath);
      state.encoderRestarts++;
      return;
    } catch (error) {
      state.lastError = String(error);
      delay = Math.min(30_000, delay * 2);
    }
  }
}

/** Stop one monitor's feed, or every feed. */
async function stopFeed(monitor?: number): Promise<void> {
  const stopping = [...running].filter(([m]) => monitor === undefined || m === monitor);
  for (const [m] of stopping) running.delete(m);
  publishFeeds();
  await consumersChanged();
  await Promise.all(stopping.map(([, r]) => r.encoder.stop()));
}

const startingFeeds = new Map<number, Promise<FeedInfo>>();

function startFeed(payload?: Partial<SourceRequest>): Promise<FeedInfo> {
  if (Deno.build.os !== "linux" && Deno.build.os !== "windows") {
    return Promise.reject(new Error(`desktopSource has no encoder on ${Deno.build.os}`));
  }
  const monitor = monitorOf(payload);
  const current = running.get(monitor);
  if (current) return Promise.resolve(current.info);
  const pending = startingFeeds.get(monitor);
  if (pending) return pending;
  const request = { ...feedDefaults, ...payload, monitor } as SourceRequest;
  if (typeof request.host !== "string" || !Number.isInteger(request.port)) {
    return Promise.reject(new Error("START needs {host, port}, or CONFIGURE first"));
  }
  shuttingDown = false;
  const starting = (async () => {
    const started = await startEncoder(monitor, request);
    await consumersChanged();
    return started.info;
  })().finally(() => startingFeeds.delete(monitor));
  startingFeeds.set(monitor, starting);
  return starting;
}

async function describe(): Promise<DesktopDescription> {
  if (Deno.build.os === "windows" && !screens) {
    try {
      const monitors = await wgcMonitors();
      screens = monitors.map((m) => ({
        index: m.index,
        name: m.name.replace(/^\\\\\.\\/, ""),
        width: m.width,
        height: m.height,
        primary: m.primary,
        region: regionOf(m, monitors),
      }));
    } catch (error) {
      state.lastError = String(error);
    }
  }
  return {
    machine: Deno.hostname(),
    input: pairedInput,
    feed: state.feed,
    ...(screens ? { screens } : {}),
    ...(Deno.build.os === "windows" ? { audio: true } : {}),
  };
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({
      ...state,
      frameSink,
      externalMediaSocket,
      subscribers: [...subscribers],
      lastHelperError: helper?.lastError ?? null,
    }),
    /** Stream RGBA frames to this `FrameReceiver` port (one sink; a new one replaces it). */
    ADDFRAMESINK: refuseWhenGuarded(guard, async (payload: { port: number; fps?: number }) => {
      if (!Number.isInteger(payload?.port) || payload.port <= 0) {
        throw new Error("ADDFRAMESINK needs {port}");
      }
      frameSink = { port: payload.port, fps: clampCaptureFps(payload.fps ?? DEFAULT_CAPTURE_FPS) };
      await consumersChanged();
      return { ...state };
    }),
    REMOVEFRAMESINK: refuseWhenGuarded(guard, async (payload: { port: number }) => {
      if (frameSink && frameSink.port === payload?.port) {
        frameSink = null;
        await reconcile();
      }
      return true;
    }),
    /** Publish to an encoder someone else runs (null stops). The own feed (`START`) wins. */
    SETMEDIASOCKET: refuseWhenGuarded(guard, async (payload: { path: string | null }) => {
      externalMediaSocket = typeof payload?.path === "string" && payload.path ? payload.path : null;
      await consumersChanged();
      return { ...state };
    }),
    SUBSCRIBESTATUS: refuseWhenGuarded(guard, (actor: string) => {
      if (typeof actor === "string") subscribers.add(actor);
      return true;
    }),
    /** Where the encoder serves when `START` comes without a payload. */
    CONFIGURE: refuseWhenGuarded(guard, (payload: SourceRequest) => {
      feedDefaults = { ...payload };
      return true;
    }),
    /** The desktopInput that drives this desktop, for `DESCRIBE`. */
    SETINPUT: refuseWhenGuarded(guard, (actor: string | null) => {
      pairedInput = typeof actor === "string" ? actor : null;
      return true;
    }),
    /** Join the household: its topic, and proofs from here on. Once, after the above. */
    SETHOUSEHOLD: refuseWhenGuarded(guard, async (payload: { secret: string; topic: string }) => {
      await guard.enable(payload.secret, state.id);
      PostMan.setTopic(payload.topic);
      return true;
    }),
    DESCRIBE: refuseWhenGuarded(guard, describe),
    GUARDED: guardedDispatch(guard, {
      DESCRIBE: describe,
      START: (payload) => startFeed(payload as Partial<SourceRequest> | undefined),
      FEED: (payload) => running.get(monitorOf(payload as { monitor?: number }))?.info ?? null,
      STOP: async (payload) => {
        const monitor = (payload as { monitor?: number } | null)?.monitor;
        await stopFeed(Number.isInteger(monitor) ? monitor : undefined);
        return true;
      },
      LAYOUT: () => loadWorkspaceOutputs(),
      AUDIO: () => startAudio(),
      STOPAUDIO: async () => {
        await stopAudio();
        return true;
      },
    }),
    /** Start the encoder feed; returns where receivers reach it. */
    START: refuseWhenGuarded(guard, (payload?: Partial<SourceRequest>) => startFeed(payload)),
    FEED: refuseWhenGuarded(guard, (): FeedInfo | null => state.feed),
    /** The monitors, as crops of the capture: KDE, Windows, or GNOME (hardcoded for now). */
    LAYOUT: refuseWhenGuarded(guard, (): Promise<WorkspaceOutput[]> => loadWorkspaceOutputs()),
    /** Stop the encoder feed; frame sinks keep capturing. */
    STOP: refuseWhenGuarded(guard, async () => {
      await stopFeed();
      return true;
    }),
    __SHUTDOWN__: async () => {
      shuttingDown = true;
      frameSink = null;
      await stopAudio();
      await stopFeed();
      await applying;
    },
  } as const,
);

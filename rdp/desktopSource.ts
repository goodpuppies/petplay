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
 * The encoder is Linux only (the media socket); frame sinks work wherever the helper does.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { join } from "@std/path";
import { DesktopMediaFeed } from "../classes/sceneStreamMedia.ts";
import { CaptureHelper } from "../classes/ScreenCapturer/captureHelper.ts";
import { clampCaptureFps, DEFAULT_CAPTURE_FPS } from "../classes/ScreenCapturer/scclass.ts";
import {
  screenStreamerPath,
  stopStaleScreenStreamer,
} from "../classes/ScreenCapturer/screenStreamerPath.ts";
import { configDir } from "../classes/appPaths.ts";

export type SourceRequest = {
  /** Where receivers reach the encoder: 127.0.0.1, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
};

export type FeedInfo = { host: string; port: number; fingerprint: string };
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
  feed: null as FeedInfo | null,
});

/** Consumers. */
let frameSink: { port: number; fps: number } | null = null;
let externalMediaSocket: string | null = Deno.env.get("PETPLAY_DESKTOP_MEDIA_SOCKET") || null;
let feedRequest: SourceRequest | null = null;
let encoder: DesktopMediaFeed | null = null;
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
  const mediaSocket = encoder?.socketPath ?? externalMediaSocket;
  if (!frameSink && !mediaSocket) return null;
  const fps = Math.max(frameSink?.fps ?? 0, feedRequest?.fps ?? 0) || DEFAULT_CAPTURE_FPS;
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

async function startEncoder(directory?: string): Promise<DesktopMediaFeed> {
  const request = feedRequest!;
  const feed = await DesktopMediaFeed.start({
    host: request.host,
    port: request.port,
    fps: request.fps,
    bitrate: request.bitrate,
    directory,
  });
  encoder = feed;
  state.feed = { host: request.host, port: feed.info.port, fingerprint: feed.info.fingerprint };
  void superviseEncoder(feed);
  return feed;
}

async function superviseEncoder(feed: DesktopMediaFeed): Promise<void> {
  await feed.exited;
  let delay = 1000;
  while (!shuttingDown && encoder === feed) {
    state.lastError = `encoder exited: ${feed.log.at(-1) ?? ""}`;
    await sleep(delay);
    if (shuttingDown || encoder !== feed) return;
    try {
      // Same directory, so the capture helper finds the replacement on the same socket.
      await startEncoder(feed.directoryPath);
      state.encoderRestarts++;
      return;
    } catch (error) {
      state.lastError = String(error);
      delay = Math.min(30_000, delay * 2);
    }
  }
}

async function stopFeed(): Promise<void> {
  const feed = encoder;
  encoder = null;
  feedRequest = null;
  state.feed = null;
  await consumersChanged();
  await feed?.stop();
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
    ADDFRAMESINK: async (payload: { port: number; fps?: number }) => {
      if (!Number.isInteger(payload?.port) || payload.port <= 0) {
        throw new Error("ADDFRAMESINK needs {port}");
      }
      frameSink = { port: payload.port, fps: clampCaptureFps(payload.fps ?? DEFAULT_CAPTURE_FPS) };
      await consumersChanged();
      return { ...state };
    },
    REMOVEFRAMESINK: async (payload: { port: number }) => {
      if (frameSink && frameSink.port === payload?.port) {
        frameSink = null;
        await reconcile();
      }
      return true;
    },
    /** Publish to an encoder someone else runs (null stops). The own feed (`START`) wins. */
    SETMEDIASOCKET: async (payload: { path: string | null }) => {
      externalMediaSocket = typeof payload?.path === "string" && payload.path ? payload.path : null;
      await consumersChanged();
      return { ...state };
    },
    SUBSCRIBESTATUS: (actor: string) => {
      if (typeof actor === "string") subscribers.add(actor);
      return true;
    },
    /** Start the encoder feed; returns where receivers reach it. */
    START: async (payload: SourceRequest): Promise<FeedInfo> => {
      if (Deno.build.os !== "linux") {
        throw new Error("desktopSource encodes through the Linux media socket only");
      }
      if (encoder && state.feed) return state.feed;
      if (typeof payload?.host !== "string" || !Number.isInteger(payload.port)) {
        throw new Error("START needs {host, port}");
      }
      shuttingDown = false;
      feedRequest = { ...payload };
      await startEncoder();
      await consumersChanged();
      return state.feed!;
    },
    FEED: (): FeedInfo | null => state.feed,
    /** Stop the encoder feed; frame sinks keep capturing. */
    STOP: async () => {
      await stopFeed();
      return true;
    },
    __SHUTDOWN__: async () => {
      shuttingDown = true;
      frameSink = null;
      await stopFeed();
      await applying;
    },
  } as const,
);

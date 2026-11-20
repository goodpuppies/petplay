/**
 * desktopSource: this machine's desktop as an encoded video feed, as an actor.
 *
 * Owns two processes and needs no OpenVR:
 * - the encoder, `petplay-media --persist` (`classes/sceneStreamMedia.ts`): VA-API H.264 served
 *   to browsers over WebTransport on `host:port`;
 * - the capture helper, `screen-streamer --no-frame-socket --no-input --media-socket=…`, which
 *   publishes captured frames straight to the encoder (no CPU frames reach Deno).
 *
 * Consumers ask for `FEED`: `{host, port, fingerprint}`, everything a WebTransport receiver
 * needs. That is the media transport, negotiated with ordinary messages; the pixels never cross
 * the actor graph.
 *
 * Either process exiting is restarted with backoff (1 s doubling to 30 s) until `STOP`. The
 * helper reconnects to a replaced encoder by itself, because the encoder keeps its socket path.
 * The capture has its own portal restore token (`rdp-screencast-restore-token`), apart from the
 * VR overlay's, so the two never fight over one session.
 *
 * Linux only for now (the media socket is Linux; Windows publishes through
 * `petplay-media capture-tcp`, which can sit behind the same API).
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { DesktopMediaFeed } from "../classes/sceneStreamMedia.ts";
import { screenStreamerPath } from "./helperPaths.ts";

export type SourceRequest = {
  /** Where receivers reach the encoder: 127.0.0.1, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
};

export type FeedInfo = { host: string; port: number; fingerprint: string };

const state = actorState({
  name: "desktopSource",
  running: false,
  encoderRestarts: 0,
  captureRestarts: 0,
  capturePid: null as number | null,
  lastError: null as string | null,
  feed: null as FeedInfo | null,
});

let request: SourceRequest | null = null;
let encoder: DesktopMediaFeed | null = null;
let capture: Deno.ChildProcess | null = null;
let stopping = false;

function tokenPath(): string {
  const home = Deno.env.get("HOME") ?? ".";
  const config = Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
  return `${config}/petplay/rdp-screencast-restore-token`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startEncoder(directory?: string): Promise<DesktopMediaFeed> {
  const feed = await DesktopMediaFeed.start({
    host: request!.host,
    port: request!.port,
    fps: request!.fps,
    bitrate: request!.bitrate,
    directory,
  });
  encoder = feed;
  state.feed = { host: request!.host, port: feed.info.port, fingerprint: feed.info.fingerprint };
  void superviseEncoder(feed);
  return feed;
}

async function superviseEncoder(feed: DesktopMediaFeed): Promise<void> {
  await feed.exited;
  let delay = 1000;
  while (!stopping && encoder === feed) {
    state.lastError = `encoder exited: ${feed.log.at(-1) ?? ""}`;
    await sleep(delay);
    if (stopping || encoder !== feed) return;
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

function startCapture(socketPath: string): void {
  const child = new Deno.Command(screenStreamerPath(), {
    args: [
      `--fps=${request!.fps ?? 30}`,
      "--no-frame-socket",
      "--no-input",
      `--media-socket=${socketPath}`,
      `--capture-token-path=${tokenPath()}`,
    ],
    // The helper stops on Enter; an open stdin keeps it running.
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  capture = child;
  state.capturePid = child.pid;
  void (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
      const line = chunk.trim().split("\n").at(-1);
      if (line) state.lastError = `capture: ${line}`;
    }
  })().catch(() => {});
  void superviseCapture(child, socketPath);
}

async function superviseCapture(child: Deno.ChildProcess, socketPath: string): Promise<void> {
  await child.status;
  let delay = 1000;
  while (!stopping && capture === child) {
    await sleep(delay);
    if (stopping || capture !== child) return;
    try {
      startCapture(socketPath);
      state.captureRestarts++;
      return;
    } catch (error) {
      state.lastError = String(error);
      delay = Math.min(30_000, delay * 2);
    }
  }
}

async function stop(): Promise<void> {
  stopping = true;
  const child = capture;
  capture = null;
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    await child.status;
  }
  const feed = encoder;
  encoder = null;
  await feed?.stop();
  state.running = false;
  state.feed = null;
  state.capturePid = null;
  request = null;
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    START: async (payload: SourceRequest): Promise<FeedInfo> => {
      if (Deno.build.os !== "linux") {
        throw new Error("desktopSource captures through the Linux media socket only");
      }
      if (state.running && state.feed) return state.feed;
      if (typeof payload?.host !== "string" || !Number.isInteger(payload.port)) {
        throw new Error("START needs {host, port}");
      }
      stopping = false;
      request = { ...payload };
      const feed = await startEncoder();
      startCapture(feed.socketPath);
      state.running = true;
      return state.feed!;
    },
    FEED: (): FeedInfo | null => state.feed,
    STOP: async () => {
      await stop();
      return true;
    },
    __SHUTDOWN__: () => stop(),
  } as const,
);

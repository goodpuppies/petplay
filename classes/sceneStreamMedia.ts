/**
 * The scene stream's desktop feed (markdown/scene-stream, P5 video): a native `petplay-media`
 * worker that GPU-encodes the desktop capture and serves it to browsers over WebTransport
 * (`submodules/petplay_mediatransport`). The display overlay host publishes its capture to the
 * worker's frame socket (`SETDESKTOPMEDIASOCKET`); browsers learn the port and certificate
 * fingerprint from the scene stream and connect to it directly.
 *
 * The worker serves browsers on `host:port` (UDP, QUIC) and its own stream page on `port + 1`.
 * It records nothing (`-` for the recording path). It runs with `--persist`, so the capture
 * helper restarting (fps change, portal hiccup) only reconnects; if the worker itself exits, the
 * stream starts another on the same socket path (`directory`), which the helper finds again.
 */
import { type ActorId, PostMan } from "../submodules/stageforge/mod.ts";
import { ensurePetplayMedia } from "../rdp/classes/petplayMediaActor.ts";
import { petplayMediaCommand, petplayMediaPath } from "./petplayMediaPath.ts";

export type MediaFeedInfo = {
  port: number;
  fingerprint: string;
  width?: number;
  height?: number;
  /** With `share`: the iroh share code, reachable across the internet (and the Windows receiver's
   * only way in). */
  code?: string;
  /** True when the feed can answer WebRTC H.264 SDP offers (`acceptWebRtcOffer`). */
  webrtc?: boolean;
  /** Loopback-only WebRTC SDP offer endpoint on standalone workers (`http://127.0.0.1:<port>/offer`). */
  webrtcOfferUrl?: string;
};

export type DesktopMediaOptions = {
  /** Where browsers reach the worker: loopback, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
  /** Reuse this private directory (and so the socket path) from a previous worker. */
  directory?: string;
  /** Also announce an iroh share code (`--iroh-share`), for receivers off the LAN or tailnet. */
  share?: boolean;
  /**
   * When set (inside a StageForge actor), host this feed in the shared `petplayMedia@*` native
   * actor (`START_SOCKET_FEED`) under this id instead of spawning a standalone child process.
   */
  actorFeedId?: string;
  /** Optional StageForge subscriber actor id for `FEED_ENDED` notifications in actor mode. */
  subscriber?: string;
};

const READY_TIMEOUT_MS = 10_000;
/** A share code waits for a relay connection and a direct address, up to 15 s by itself. */
const SHARE_READY_TIMEOUT_MS = 25_000;

type ActorBackend = {
  actorId: ActorId;
  feedId: string;
  exited: Promise<Deno.CommandStatus>;
  resolveExited: (status: Deno.CommandStatus) => void;
};

export class DesktopMediaFeed {
  private constructor(
    readonly socketPath: string,
    readonly info: MediaFeedInfo,
    private readonly child: Deno.ChildProcess | null,
    private readonly actor: ActorBackend | null,
    private readonly directory: string,
    readonly log: string[],
  ) {}

  /** For a replacement worker on the same socket path. */
  get directoryPath(): string {
    return this.directory;
  }

  static async start(options: DesktopMediaOptions): Promise<DesktopMediaFeed> {
    const created = options.directory == null;
    const directory = options.directory ?? await Deno.makeTempDir({
      dir: Deno.env.get("XDG_RUNTIME_DIR") ?? `/run/user/${Deno.uid()}`,
      prefix: "pp-scene-media-",
    });
    const socketPath = `${directory}/frames.sock`;
    // A worker that died leaves its socket behind, and a new one refuses an existing path.
    await Deno.remove(socketPath).catch(() => {});

    if (options.actorFeedId) {
      try {
        const actorId = await ensurePetplayMedia();
        const res = await PostMan.PostMessage({
          target: actorId,
          type: "START_SOCKET_FEED",
          payload: {
            id: options.actorFeedId,
            socketPath,
            host: options.host,
            port: options.port,
            layout: "mono",
            fps: options.fps ?? 30,
            maxFps: options.fps ?? 30,
            bitrate: options.bitrate ?? 8_000_000,
            persist: true,
            share: Boolean(options.share),
            ...(options.subscriber ? { subscriber: options.subscriber } : {}),
          },
        }, true) as {
          id: string;
          socketPath: string;
          port: number;
          fingerprint: string;
          code?: string;
          webrtc?: boolean;
        };
        let resolveExited!: (status: Deno.CommandStatus) => void;
        const exited = new Promise<Deno.CommandStatus>((resolve) => {
          resolveExited = resolve;
        });
        return new DesktopMediaFeed(
          res.socketPath,
          {
            port: res.port,
            fingerprint: res.fingerprint,
            ...(res.code ? { code: res.code } : {}),
            ...(res.webrtc ? { webrtc: true } : {}),
          },
          null,
          { actorId, feedId: res.id, exited, resolveExited },
          directory,
          [],
        );
      } catch (error) {
        if (created) await Deno.remove(directory, { recursive: true }).catch(() => {});
        throw error;
      }
    }
    const binary = petplayMediaPath();
    const child = petplayMediaCommand([
      socketPath,
      "-",
      `${options.host}:${options.port}`,
      "--layout",
      "mono",
      "--fps",
      String(options.fps ?? 30),
      "--bitrate",
      String(options.bitrate ?? 8_000_000),
      "--persist",
      // Whatever the producer sends, the GPU encodes at most the feed's rate.
      "--max-fps",
      String(options.fps ?? 30),
      ...(options.share ? ["--iroh-share"] : []),
    ], {
      binary,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const log: string[] = [];
    const keep = (line: string) => {
      log.push(line);
      if (log.length > 200) log.shift();
    };
    const drained = [drainLines(child.stderr, keep)];
    try {
      let code: string | null = null;
      let webrtcOfferUrl: string | null = null;
      const fingerprint = await new Promise<string>((resolve, reject) => {
        let fingerprint: string | null = null;
        const timer = setTimeout(
          () => reject(Error(`petplay-media not ready: ${log.at(-1) ?? "no output"}`)),
          options.share ? SHARE_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
        );
        drained.push(drainLines(child.stdout, (line) => {
          keep(line);
          code ??= line.match(/^IROH_SHARE code=(\S+)/)?.[1] ?? null;
          webrtcOfferUrl ??= line.match(/^WEBRTC_READY (\S+)/)?.[1] ?? null;
          fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
          if (line.startsWith("MEDIA_READY") && fingerprint && (code || !options.share)) {
            clearTimeout(timer);
            resolve(fingerprint);
          }
        }));
        child.status.then(async (status) => {
          clearTimeout(timer);
          // The reason is its last words; read them before reporting.
          await Promise.race([
            Promise.allSettled(drained),
            new Promise((r) => setTimeout(r, 1000)),
          ]);
          reject(Error(`petplay-media exited (${status.code}): ${log.at(-1) ?? ""}`));
        });
      });
      return new DesktopMediaFeed(
        socketPath,
        {
          port: options.port,
          fingerprint,
          ...(code ? { code } : {}),
          ...(webrtcOfferUrl ? { webrtc: true, webrtcOfferUrl } : {}),
        },
        child,
        null,
        directory,
        log,
      );
    } catch (error) {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      if (created) await Deno.remove(directory, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  /** Exchange a browser's WebRTC SDP offer for this worker's ICE-lite SDP answer. */
  async acceptWebRtcOffer(offerSdp: string): Promise<string> {
    if (this.actor) {
      const res = await PostMan.PostMessage({
        target: this.actor.actorId,
        type: "WEBRTC_OFFER",
        payload: { id: this.actor.feedId, sdp: offerSdp },
      }, true) as { sdp: string };
      return res.sdp;
    }
    const url = this.info.webrtcOfferUrl;
    if (!url) throw new Error("petplay-media worker has no WebRTC signaling endpoint");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offerSdp,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`WebRTC offer rejected (${response.status}): ${text}`);
    return text;
  }

  /** Called by the owning actor when `petplayMedia@*` pushes `FEED_ENDED` for this feed. */
  notifyActorEnded(): void {
    this.actor?.resolveExited({ success: false, code: 1, signal: null });
  }

  /** Resolves when the worker exits. */
  get exited(): Promise<Deno.CommandStatus> {
    if (this.actor) return this.actor.exited;
    return this.child!.status;
  }

  async stop(): Promise<void> {
    if (this.actor) {
      await PostMan.PostMessage({
        target: this.actor.actorId,
        type: "STOP_FEED",
        payload: { id: this.actor.feedId },
      }, true).catch(() => {});
      this.actor.resolveExited({ success: true, code: 0, signal: null });
      await Deno.remove(this.directory, { recursive: true }).catch(() => {});
      return;
    }
    try {
      this.child!.kill("SIGTERM");
    } catch { /* already gone */ }
    await Promise.race([this.child!.status, new Promise((r) => setTimeout(r, 2000))]);
    try {
      this.child!.kill("SIGKILL");
    } catch { /* exited */ }
    await Deno.remove(this.directory, { recursive: true }).catch(() => {});
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
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
  } catch { /* closed */ }
}

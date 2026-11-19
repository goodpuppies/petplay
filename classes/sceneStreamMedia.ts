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
import { fromFileUrl } from "@std/path";

export type MediaFeedInfo = { port: number; fingerprint: string; width?: number; height?: number };

export type DesktopMediaOptions = {
  /** Where browsers reach the worker: loopback, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
  /** Reuse this private directory (and so the socket path) from a previous worker. */
  directory?: string;
};

const READY_TIMEOUT_MS = 10_000;

export class DesktopMediaFeed {
  private constructor(
    readonly socketPath: string,
    readonly info: MediaFeedInfo,
    private readonly child: Deno.ChildProcess,
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
    const binary = Deno.env.get("PETPLAY_MEDIA_BINARY") ??
      fromFileUrl(new URL("../submodules/petplay_mediatransport/target/release/petplay-media", import.meta.url));
    const child = new Deno.Command(binary, {
      args: [
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
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const log: string[] = [];
    const keep = (line: string) => {
      log.push(line);
      if (log.length > 200) log.shift();
    };
    void drainLines(child.stderr, keep);
    try {
      const fingerprint = await new Promise<string>((resolve, reject) => {
        let fingerprint: string | null = null;
        const timer = setTimeout(() => reject(Error(`petplay-media not ready: ${log.at(-1) ?? "no output"}`)), READY_TIMEOUT_MS);
        void drainLines(child.stdout, (line) => {
          keep(line);
          fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
          if (line.startsWith("MEDIA_READY") && fingerprint) {
            clearTimeout(timer);
            resolve(fingerprint);
          }
        });
        child.status.then((status) => {
          clearTimeout(timer);
          reject(Error(`petplay-media exited (${status.code}): ${log.at(-1) ?? ""}`));
        });
      });
      return new DesktopMediaFeed(socketPath, { port: options.port, fingerprint }, child, directory, log);
    } catch (error) {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      if (created) await Deno.remove(directory, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  /** Resolves when the worker exits. */
  get exited(): Promise<Deno.CommandStatus> {
    return this.child.status;
  }

  async stop(): Promise<void> {
    try {
      this.child.kill("SIGTERM");
    } catch { /* already gone */ }
    await Promise.race([this.child.status, new Promise((r) => setTimeout(r, 2000))]);
    try {
      this.child.kill("SIGKILL");
    } catch { /* exited */ }
    await Deno.remove(this.directory, { recursive: true }).catch(() => {});
  }
}

async function drainLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  let buffered = "";
  try {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)) {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
  } catch { /* closed */ }
}

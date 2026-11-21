/**
 * Windows' desktop feed: `petplay-media capture-wgc` captures one monitor, converts and encodes it
 * on the GPU, and publishes it. Unlike Linux, no capture helper is involved: the encoder captures
 * itself, so frames never leave the GPU.
 *
 * The feed is served twice: as a pinned WebTransport listener on `host:port` (LAN or tailnet, if
 * the firewall lets it in) and as an iroh share code, which starts with an outgoing connection
 * and so passes Windows' firewall.
 *
 * `WgcMediaFeed.audio` is the machine's sound the same way: `petplay-media capture-audio`, every
 * app's audio but VRChat's and PetPlay's, Opus over its own broadcast.
 */
import { fromFileUrl } from "@std/path";

export type WgcMonitor = {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
};

const READY_TIMEOUT_MS = 20_000;

export function mediaBinary(): string {
  return Deno.env.get("PETPLAY_MEDIA_BINARY") ??
    fromFileUrl(
      new URL(
        "../../submodules/petplay_mediatransport/target/release/petplay-media.exe",
        import.meta.url,
      ),
    );
}

/** The monitors, physical pixels on the virtual desktop. */
export async function wgcMonitors(binary = mediaBinary()): Promise<WgcMonitor[]> {
  const { stdout, success } = await new Deno.Command(binary, {
    args: ["capture-wgc", "--list"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!success) throw new Error("capture-wgc --list failed");
  return new TextDecoder().decode(stdout).split("\n").flatMap((line) => {
    const m = line.match(
      /^WGC_MONITOR index=(\d+) name="(.*)" x=(-?\d+) y=(-?\d+) width=(\d+) height=(\d+) primary=(\d)/,
    );
    return m
      ? [{
        index: Number(m[1]),
        name: m[2].replaceAll("\\\\", "\\"),
        x: Number(m[3]),
        y: Number(m[4]),
        width: Number(m[5]),
        height: Number(m[6]),
        primary: m[7] === "1",
      }]
      : [];
  });
}

/** `monitor`'s rectangle as fractions of the virtual desktop all monitors make up. */
export function regionOf(monitor: WgcMonitor, monitors: WgcMonitor[]) {
  const left = Math.min(...monitors.map((m) => m.x));
  const top = Math.min(...monitors.map((m) => m.y));
  const width = Math.max(...monitors.map((m) => m.x + m.width)) - left;
  const height = Math.max(...monitors.map((m) => m.y + m.height)) - top;
  return {
    x: (monitor.x - left) / width,
    y: (monitor.y - top) / height,
    width: monitor.width / width,
    height: monitor.height / height,
  };
}

export type WgcFeedOptions = {
  host: string;
  port: number;
  monitor: number;
  fps?: number;
  bitrate?: number;
};

export class WgcMediaFeed {
  /** No helper publishes into it: the encoder captures itself. */
  readonly socketPath = null;
  readonly directoryPath = undefined;
  readonly exited: Promise<Deno.CommandStatus>;

  private constructor(
    readonly info: { port: number; fingerprint: string; code: string },
    private readonly child: Deno.ChildProcess,
    readonly log: string[],
  ) {
    this.exited = child.status;
  }

  static start(options: WgcFeedOptions): Promise<WgcMediaFeed> {
    return WgcMediaFeed.spawn([
      "capture-wgc",
      String(options.monitor),
      `${options.host}:${options.port}`,
      "--iroh-share",
      "--fps",
      String(options.fps ?? 30),
      "--bitrate",
      String(options.bitrate ?? 8_000_000),
    ], "MEDIA_SOURCE", options.port);
  }

  /** This machine's audio, but VRChat's and PetPlay's. */
  static audio(options: { host: string; port: number }): Promise<WgcMediaFeed> {
    return WgcMediaFeed.spawn(
      ["capture-audio", `${options.host}:${options.port}`, "--iroh-share"],
      "AUDIO_SOURCE",
      options.port,
    );
  }

  private static async spawn(args: string[], ready: string, port: number): Promise<WgcMediaFeed> {
    const child = new Deno.Command(mediaBinary(), {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const log: string[] = [];
    const keep = (line: string) => {
      log.push(line);
      if (log.length > 200) log.shift();
    };
    const drained = [drain(child.stderr, keep)];
    try {
      const info = await new Promise<{ port: number; fingerprint: string; code: string }>(
        (resolve, reject) => {
          let fingerprint: string | null = null, code: string | null = null;
          const timer = setTimeout(
            () => reject(new Error(`${args[0]} not ready: ${log.at(-1) ?? "no output"}`)),
            READY_TIMEOUT_MS,
          );
          drained.push(drain(child.stdout, (line) => {
            keep(line);
            code ??= line.match(/^IROH_SHARE code=(\S+)/)?.[1] ?? null;
            fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
            if (line.startsWith(ready) && code && fingerprint) {
              clearTimeout(timer);
              resolve({ port, fingerprint, code });
            }
          }));
          child.status.then(async (status) => {
            clearTimeout(timer);
            await Promise.race([Promise.allSettled(drained), new Promise((r) => setTimeout(r, 1000))]);
            reject(new Error(`${args[0]} exited (${status.code}): ${log.at(-1) ?? ""}`));
          });
        },
      );
      return new WgcMediaFeed(info, child, log);
    } catch (error) {
      try {
        child.kill();
      } catch { /* already gone */ }
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.child.kill();
    } catch { /* already gone */ }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

async function drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  let buffered = "";
  try {
    const text = stream.pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    );
    for await (const chunk of text) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line) onLine(line);
    }
  } catch { /* the process ended */ }
  if (buffered) onLine(buffered);
}

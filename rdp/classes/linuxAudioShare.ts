/**
 * Linux's share of this machine's sound, through PipeWire: every app's audio but VRChat's and
 * PetPlay's, the same set Windows' `capture-audio` takes.
 *
 * A private null sink collects it: every audio output stream that is not excluded is also linked
 * into the sink (its own playback is untouched), re-checked every two seconds as apps come and
 * go. `pw-record` takes the sink's monitor as raw PCM into `petplay-media capture-audio --stdin`,
 * which publishes it as Opus with an iroh share code. Nothing links the sink to a speaker, so
 * what is shared is never played twice.
 *
 * Excluded by application or node name, or binary: VRChat (under Proton, `VRChat.exe` run by
 * `wine64-preloader`), PetPlay (`deno`, `petplay`) and its players (`petplay-media`).
 */
import { mediaBinary } from "./wgcMediaFeed.ts";

const EXCLUDED = /vrchat|petplay|^deno$/i;
const LINK_MS = 2000;
const READY_TIMEOUT_MS = 25_000;

type PwObject = {
  id: number;
  type: string;
  info?: {
    props?: Record<string, unknown>;
    direction?: string;
    "output-port-id"?: number;
    "input-port-id"?: number;
  };
};

async function command(cmd: string, args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(`${cmd} ${args[0]}: ${new TextDecoder().decode(stderr).trim()}`);
  return new TextDecoder().decode(stdout);
}

/** Whether this machine can share its sound this way. */
export async function linuxAudioAvailable(): Promise<boolean> {
  if (Deno.build.os !== "linux") return false;
  try {
    await command("pw-record", ["--version"]);
    await command("pactl", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export class LinuxAudioShare {
  readonly exited: Promise<Deno.CommandStatus>;
  private linker: ReturnType<typeof setInterval> | null = null;
  private linked = new Set<string>();

  private constructor(
    readonly info: { port: number; fingerprint: string; code: string },
    private readonly module: string,
    private readonly sink: string,
    private readonly recorder: Deno.ChildProcess,
    private readonly publisher: Deno.ChildProcess,
    readonly log: string[],
  ) {
    this.exited = publisher.status;
  }

  static async start(options: { host: string; port: number }): Promise<LinuxAudioShare> {
    const sink = `petplay_share_${Deno.pid}`;
    const module = (await command("pactl", [
      "load-module",
      "module-null-sink",
      `sink_name=${sink}`,
      "sink_properties=device.description=PetPlay-share",
    ])).trim();
    const log: string[] = [];
    const keep = (line: string) => {
      log.push(line);
      if (log.length > 100) log.shift();
    };
    let recorder: Deno.ChildProcess | null = null;
    let publisher: Deno.ChildProcess | null = null;
    try {
      publisher = new Deno.Command(mediaBinary(), {
        args: ["capture-audio", "--stdin", `${options.host}:${options.port}`, "--iroh-share"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      recorder = new Deno.Command("pw-record", {
        args: [
          "--raw",
          "--target",
          sink,
          "-P",
          "{ stream.capture.sink=true node.name=petplay-share-record }",
          "--rate",
          "48000",
          "--channels",
          "2",
          "--format",
          "f32",
          "-",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      void recorder.stdout.pipeTo(publisher.stdin).catch(() => {});
      void lines(recorder.stderr, (line) => keep(`pw-record: ${line}`));
      void lines(publisher.stderr, keep);
      const child = publisher;
      const info = await new Promise<{ port: number; fingerprint: string; code: string }>(
        (resolve, reject) => {
          let fingerprint: string | null = null, code: string | null = null;
          const timer = setTimeout(
            () => reject(new Error(`capture-audio not ready: ${log.at(-1) ?? "no output"}`)),
            READY_TIMEOUT_MS,
          );
          void lines(child.stdout, (line) => {
            keep(line);
            code ??= line.match(/^IROH_SHARE code=(\S+)/)?.[1] ?? null;
            fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
            if (line.startsWith("AUDIO_SOURCE") && code && fingerprint) {
              clearTimeout(timer);
              resolve({ port: options.port, fingerprint, code });
            }
          });
          child.status.then((status) => {
            clearTimeout(timer);
            reject(new Error(`capture-audio exited (${status.code}): ${log.at(-1) ?? ""}`));
          });
        },
      );
      const share = new LinuxAudioShare(info, module, sink, recorder, publisher, log);
      await share.link();
      share.linker = setInterval(() => void share.link(), LINK_MS);
      return share;
    } catch (error) {
      for (const child of [recorder, publisher]) {
        try {
          child?.kill();
        } catch { /* gone */ }
      }
      await command("pactl", ["unload-module", module]).catch(() => {});
      throw error;
    }
  }

  /** Link every shareable output stream into the sink. */
  private async link(): Promise<void> {
    let objects: PwObject[];
    try {
      objects = JSON.parse(await command("pw-dump", []));
    } catch {
      return;
    }
    const nodes = new Map<number, Record<string, unknown>>();
    for (const o of objects) {
      if (o.type === "PipeWire:Interface:Node") nodes.set(o.id, o.info?.props ?? {});
    }
    const sinkNode = [...nodes].find(([, p]) => p["node.name"] === this.sink)?.[0];
    if (sinkNode === undefined) return;
    const ports = objects.filter((o) => o.type === "PipeWire:Interface:Port");
    const inputs = new Map<string, number>();
    for (const port of ports) {
      const p = port.info?.props ?? {};
      if (p["node.id"] === sinkNode && port.info?.direction === "input") {
        inputs.set(String(p["audio.channel"]), port.id);
      }
    }
    const existing = new Set(
      objects.filter((o) => o.type === "PipeWire:Interface:Link")
        .map((o) => `${o.info?.["output-port-id"]}>${o.info?.["input-port-id"]}`),
    );
    for (const port of ports) {
      const p = port.info?.props ?? {};
      if (port.info?.direction !== "output") continue;
      const node = nodes.get(Number(p["node.id"]));
      if (!node || node["media.class"] !== "Stream/Output/Audio") continue;
      const names = [node["application.name"], node["node.name"], node["application.process.binary"]];
      if (names.some((n) => typeof n === "string" && EXCLUDED.test(n))) continue;
      const channel = String(p["audio.channel"]);
      // A mono stream goes to both sides.
      const targets = channel === "FL" || channel === "FR"
        ? [inputs.get(channel)]
        : [inputs.get("FL"), inputs.get("FR")];
      for (const target of targets) {
        if (target === undefined) continue;
        const key = `${port.id}>${target}`;
        if (existing.has(key)) continue;
        try {
          await command("pw-link", [String(port.id), String(target)]);
          if (!this.linked.has(key)) {
            this.linked.add(key);
            this.log.push(`linked ${node["application.name"] ?? node["node.name"]} ${channel}`);
          }
        } catch { /* the stream went away */ }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.linker) clearInterval(this.linker);
    this.linker = null;
    for (const child of [this.recorder, this.publisher]) {
      try {
        child.kill();
      } catch { /* gone */ }
    }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
    await command("pactl", ["unload-module", this.module]).catch(() => {});
  }
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  let buffered = "";
  try {
    const text = stream.pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    );
    for await (const chunk of text) {
      buffered += chunk;
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const line of parts) if (line) onLine(line);
    }
  } catch { /* the process ended */ }
}

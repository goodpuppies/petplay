/**
 * One `screen-streamer` capture process: the portal (or Windows Graphics Capture) session and
 * where its frames go. Outputs are process arguments, so changing them means a new helper; the
 * portal restore token makes that quiet.
 *
 * `started` turns true when the helper reports "Started capture": the session was granted and
 * its outputs connected. A helper that exits before that was refused (portal denied, cancelled,
 * no source) or could not reach an output; one that exits after it lost a working capture.
 */
import { captureSessionEnvironment } from "./captureSessionEnvironment.ts";

export type CaptureOutputs = {
  /** A `FrameReceiver` port to stream RGBA frames to. */
  framePort?: number | null;
  /** A `petplay-media` frame socket to publish DMA-BUF frames to (Linux). */
  mediaSocket?: string | null;
};

export type CaptureHelperOptions = CaptureOutputs & {
  executablePath: string;
  fps: number;
  /** Portal restore token file. */
  tokenPath: string;
  /** Linux: also create the uinput devices. Default false: desktopInput injects. */
  input?: boolean;
  /** Log the helper's output. */
  log?: (line: string) => void;
  onStarted?: () => void;
};

export class CaptureHelper {
  readonly fps: number;
  readonly framePort: number | null;
  readonly mediaSocket: string | null;
  readonly exited: Promise<Deno.CommandStatus>;
  #process: Deno.ChildProcess;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #started = false;
  #lastError: string | null = null;
  #exit: Deno.CommandStatus | null = null;
  #stopping = false;

  constructor(options: CaptureHelperOptions) {
    this.fps = options.fps;
    this.framePort = options.framePort ?? null;
    this.mediaSocket = options.mediaSocket ?? null;
    if (this.framePort == null && !this.mediaSocket) {
      throw new Error("a capture helper needs a frame port or a media socket");
    }
    const linux = Deno.build.os === "linux";
    this.#process = new Deno.Command(options.executablePath, {
      env: captureSessionEnvironment(),
      args: [
        `--fps=${this.fps}`,
        ...(this.framePort != null ? [`--port=${this.framePort}`] : ["--no-frame-socket"]),
        `--capture-token-path=${options.tokenPath}`,
        ...(this.mediaSocket ? [`--media-socket=${this.mediaSocket}`] : []),
        ...(linux && !options.input ? ["--no-input"] : []),
      ],
      // The helper stops on Enter; an open stdin keeps it running.
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#stdin = this.#process.stdin.getWriter();
    this.exited = this.#process.status.then((status) => {
      this.#exit = status;
      return status;
    });
    void this.#lines(this.#process.stdout, (line) => {
      options.log?.(line);
      if (!this.#started && line.includes("Started capture")) {
        this.#started = true;
        options.onStarted?.();
      }
    });
    void this.#lines(this.#process.stderr, (line) => {
      options.log?.(line);
      this.#lastError = line;
    });
  }

  get pid(): number {
    return this.#process.pid;
  }

  get started(): boolean {
    return this.#started;
  }

  get running(): boolean {
    return this.#exit === null;
  }

  /** The helper's last stderr line, e.g. the portal's reason for ending the request. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** A line on the helper's stdin (its legacy input verbs, when started with `input`). */
  async sendControl(command: string): Promise<void> {
    try {
      await this.#stdin.write(new TextEncoder().encode(`${command}\n`));
    } catch {
      // Exiting.
    }
  }

  async stop(): Promise<Deno.CommandStatus> {
    if (!this.#stopping && this.#exit === null) {
      this.#stopping = true;
      try {
        this.#process.kill();
      } catch {
        // Already exiting.
      }
    }
    const status = await this.exited;
    await this.#stdin.close().catch(() => {});
    return status;
  }

  async #lines(
    stream: ReadableStream<Uint8Array<ArrayBuffer>>,
    each: (line: string) => void,
  ): Promise<void> {
    let rest = "";
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const parts = (rest + chunk).split(/\r?\n|\r/);
        rest = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (line) each(line);
        }
      }
    } catch {
      // Stream closed.
    }
    if (rest.trim()) each(rest.trim());
  }
}

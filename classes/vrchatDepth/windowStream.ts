/**
 * Streams VRChat's desktop window as RGBA frames, for decoding the depth block
 * (`markdown/vrchat-depth/README.md`). Linux/X11 only: ffmpeg's x11grab on the window's id
 * (VRChat under Proton is an XWayland window).
 *
 * Frames arrive through `onFrame` in one reused buffer: copy what must outlive the callback.
 * Slow reads can back up ffmpeg's pipe; receivedAt measures arrival, not source capture time.
 * The window is looked up again every few seconds, and the stream restarts when it moves to a
 * new id or size (VRChat restarted, the window resized).
 */
import { findX11Window, type X11Window } from "../x11Windows.ts";
import { CaptureTiming } from "./captureTiming.ts";
import { readFrameBytes } from "./frameReader.ts";

export type WindowFrame = {
  data: Uint8Array;
  width: number;
  height: number;
  /** `Date.now()` when the frame's last byte arrived. */
  receivedAt: number;
  /** x11grab's wall-clock PTS, when optional capture timing is enabled. */
  sourceCapturedAt?: number;
};

export type WindowStreamStatus = {
  running: boolean;
  window: { id: number; width: number; height: number; x: number; y: number } | null;
  frames: number;
  restarts: number;
  lastError: string | null;
};

const WINDOW_RECHECK_MS = 2000;

export class VrchatWindowStream {
  private process: Deno.ChildProcess | null = null;
  private window: X11Window | null = null;
  private stopped = true;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private frames = 0;
  private restarts = 0;
  private lastError: string | null = null;

  constructor(
    private readonly onFrame: (frame: WindowFrame) => void,
    private readonly options: { windowName?: string; fps?: number; captureTiming?: boolean } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recheck = setInterval(() => this.checkWindow(), WINDOW_RECHECK_MS);
    this.checkWindow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.recheck != null) clearInterval(this.recheck);
    this.recheck = null;
    await this.killProcess();
    this.window = null;
  }

  status(): WindowStreamStatus {
    return {
      running: this.process != null,
      window: this.window
        ? {
          id: this.window.id,
          width: this.window.width,
          height: this.window.height,
          x: this.window.x,
          y: this.window.y,
        }
        : null,
      frames: this.frames,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  private checkWindow(): void {
    if (this.stopped) return;
    let found: X11Window | null = null;
    try {
      found = findX11Window(this.options.windowName ?? "VRChat");
    } catch (error) {
      this.lastError = String(error);
    }
    const same = found != null && this.window != null && found.id === this.window.id &&
      found.width === this.window.width && found.height === this.window.height;
    if (same && this.process != null) return;
    this.window = found;
    void this.killProcess().then(() => {
      if (found == null) {
        this.lastError ??= "no VRChat window";
        return;
      }
      if (!this.stopped && this.window === found) this.spawn(found);
    });
  }

  private spawn(window: X11Window): void {
    const display = Deno.env.get("DISPLAY");
    if (!display) {
      this.lastError = "DISPLAY is not set";
      return;
    }
    const process = new Deno.Command("ffmpeg", {
      args: [
        "-loglevel",
        this.options.captureTiming ? "level+info" : "error",
        "-nostats",
        "-nostdin",
        // Keep live capture from accumulating old frames while the consumer is busy.
        "-thread_queue_size",
        "1",
        "-f",
        "x11grab",
        "-window_id",
        String(window.id),
        "-framerate",
        String(this.options.fps ?? 60),
        "-draw_mouse",
        "0",
        ...(this.options.captureTiming ? ["-copyts"] : []),
        "-i",
        display,
        "-filter_threads",
        "1",
        ...(this.options.captureTiming ? ["-vf", "showinfo=checksum=0"] : []),
        // Passthrough: emit grabbed frames only. The default constant-rate output duplicates
        // frames to hold the rate whenever grabbing falls behind, which filled the stream with
        // repeats (52 frames/s, ~1 new VRChat frame/s after a minute).
        "-fps_mode",
        "passthrough",
        // rawvideo supports frame threading. Auto threads retain several whole frames before
        // emitting packets, which is expensive latency even though there is no compression.
        "-threads:v",
        "1",
        // Preserve x11grab's microsecond PTS instead of rounding wall-clock values to 1/60 s.
        "-enc_time_base:v",
        "1:1000000",
        // This is a separate output/mux queue; the pre-input option only bounds demux packets.
        "-thread_queue_size",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.process = process;
    this.restarts++;
    this.lastError = null;
    const timing = new CaptureTiming();
    void this.readFrames(process, window.width, window.height, timing);
    void (async () => {
      for await (const text of process.stderr.pipeThrough(new TextDecoderStream())) {
        for (const line of timing.feed(text)) {
          if (line.trim() && (!this.options.captureTiming || /\[(error|fatal)\]/.test(line))) {
            this.lastError = line;
          }
        }
      }
    })().catch(() => {});
  }

  private async readFrames(
    process: Deno.ChildProcess,
    width: number,
    height: number,
    timing: CaptureTiming,
  ) {
    const size = width * height * 4;
    let frameNumber = 0;
    try {
      await readFrameBytes(process.stdout, size, (frame) => {
        this.frames++;
        this.onFrame({
          data: frame,
          width,
          height,
          receivedAt: Date.now(),
          sourceCapturedAt: timing.take(frameNumber++),
        });
      });
    } catch (error) {
      if (!this.stopped) this.lastError = String(error);
    } finally {
      if (this.process === process) this.process = null;
    }
  }

  private async killProcess(): Promise<void> {
    const process = this.process;
    if (process == null) return;
    this.process = null;
    try {
      process.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    await process.status.catch(() => {});
  }
}

import { CaptureHelper } from "./captureHelper.ts";
import { FrameReceiver } from "./frameReceiver.ts";
//#region typings

/**
 * Interface representing a captured frame with its dimensions and timing information
 */
export interface CapturedFrame {
  /** Raw RGBA pixel data */
  data: Uint8Array;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Time taken to receive the frame in milliseconds */
  receiveTime: number;
}

/**
 * Options for configuring the ScreenCapturer
 */
export interface ScreenCapturerOptions {
  /** TCP port to use for communication with the capture process. Defaults to 12345. */
  port?: number;
  /** Capture rate requested from the platform capture backend. Defaults to {@link DEFAULT_CAPTURE_FPS}. */
  fps?: number;
  /** Path to the screen-streamer executable. Defaults to "./screen-streamer". */
  executablePath?: string;
  /** Persistent Linux ScreenCast portal restore-token file. */
  captureTokenPath?: string;
  /**
   * Linux only. Also publish every captured frame to a native media worker already
   * listening on this AF_UNIX path, which encodes it on the GPU for streaming. The
   * local overlay keeps using the frame socket either way; this is an extra consumer,
   * not a replacement. See `submodules/petplay_mediatransport/docs/protocol.md`.
   */
  mediaSocketPath?: string;
  /**
   * Linux: whether the helper also creates the uinput devices and injects what `sendControl`
   * writes. Default true; PetPlay passes false, since `desktopInput` injects.
   */
  input?: boolean;
  /** Whether to log debug information. Defaults to false. */
  debug?: boolean;
  /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
  /** Called when the capture helper exits unexpectedly. */
  onExit?: (status: Deno.CommandStatus) => void;
}

//#endregion

/**
 * Default desktop capture rate. The helper is frame-rate driven, not damage
 * driven, and 60 fps consumed roughly twice the capture/host CPU of 30 fps in
 * a live VRChat + SteamVR trace. Keep the explicit `--screen-capture-fps` flag
 * for users who prefer capture smoothness over compositor headroom.
 */
export const DEFAULT_CAPTURE_FPS = 30;

/**
 * The helper clamps `--fps` to 1..240 itself; mirror that here so a configured
 * rate is never silently lowered on the way in.
 */
export function clampCaptureFps(fps: number | undefined): number {
  const value = Number(fps);
  if (!Number.isFinite(value)) return DEFAULT_CAPTURE_FPS;
  return Math.max(1, Math.min(240, Math.round(value)));
}

/**
 * A capture helper and the frame receiver it streams to, as one object: the helper starts with
 * the first frame request and the pair goes away together. `desktopSource` uses the two parts
 * separately (`CaptureHelper`, `FrameReceiver`), since there the receiver lives with whoever
 * shows frames.
 *
 * A dropped frame socket stops the helper (this receiver takes one connection), so `onExit`, the
 * owner's restart path, brings up a fresh pair.
 */
export class ScreenCapturer {
  private options: Required<ScreenCapturerOptions>;
  private receiver: FrameReceiver | null = null;
  private helper: CaptureHelper | null = null;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private stopping = false;

  constructor(options: ScreenCapturerOptions = {}) {
    this.options = {
      port: options.port ?? 12345,
      fps: clampCaptureFps(options.fps),
      executablePath: options.executablePath ?? "./screen-streamer",
      captureTokenPath: options.captureTokenPath ?? "screen-streamer-capture.token",
      debug: options.debug ?? false,
      onStats: options.onStats ?? (() => {}),
      onExit: options.onExit ?? (() => {}),
      // Empty means no media worker, so the helper is started without the option.
      mediaSocketPath: options.mediaSocketPath ?? "",
      input: options.input ?? true,
    };
  }

  private log(...args: unknown[]) {
    if (this.options.debug) console.log("[ScreenCapturer]", ...args);
  }

  /** Starts the receiver, then the helper aimed at it. Called by the first frame request. */
  async start(): Promise<void> {
    // A frame poll after dispose() must not silently spawn a new helper (and a new portal dialog).
    if (this.disposed) throw new Error("ScreenCapturer was disposed");
    if (this.helper) return;
    this.startPromise ??= this.initializeCapture().finally(() => this.startPromise = null);
    return await this.startPromise;
  }

  private async initializeCapture(): Promise<void> {
    const receiver = await FrameReceiver.start({
      port: this.options.port,
      reaccept: false,
      onDisconnect: () => this.handleDisconnect(),
      onStats: this.options.onStats,
    });
    if (this.disposed) {
      receiver.dispose();
      throw new Error("ScreenCapturer was disposed");
    }
    this.receiver = receiver;
    const helper = new CaptureHelper({
      executablePath: this.options.executablePath,
      fps: this.options.fps,
      tokenPath: this.options.captureTokenPath,
      framePort: receiver.port,
      mediaSocket: this.options.mediaSocketPath || null,
      input: this.options.input,
      log: (line) => this.log("Process:", line),
    });
    this.helper = helper;
    void helper.exited.then((status) => {
      if (this.helper === helper && !this.stopping) this.options.onExit(status);
    });
  }

  /** The receiver takes one connection: a live helper behind a dropped socket is useless. */
  private handleDisconnect(): void {
    if (this.stopping) return;
    this.log("Frame socket disconnected; stopping the helper so it is restarted");
    void this.helper?.stop();
  }

  /** Capture rate the helper process was launched with. */
  getFps(): number {
    return this.options.fps;
  }

  async sendControl(command: string): Promise<void> {
    await this.helper?.sendControl(command);
  }

  async getLatestFrame(): Promise<CapturedFrame | null> {
    await this.start();
    return this.receiver?.latestFrame() ?? null;
  }

  /** Wait for a frame object newer than `previous`, avoiding duplicate timer polling. */
  async getNextFrame(
    previous: CapturedFrame | null,
    timeoutMs = 1_000,
  ): Promise<CapturedFrame | null> {
    await this.start();
    return await (this.receiver?.nextFrame(previous, timeoutMs) ?? null);
  }

  /** True once the helper has delivered a frame; a portal refusal exits before that. */
  hasReceivedFrame(): boolean {
    return this.receiver?.hasReceivedFrame() ?? false;
  }

  /** The helper's last stderr line, e.g. the portal's reason for ending the request. */
  getLastError(): string | null {
    return this.helper?.lastError ?? null;
  }

  getStatus() {
    const frame = this.receiver?.latestFrame() ?? null;
    return {
      started: this.helper != null,
      starting: this.startPromise !== null,
      workerActive: this.receiver !== null,
      processId: this.helper?.pid ?? null,
      processRunning: this.helper?.running ?? false,
      latestFrameWidth: frame?.width ?? null,
      latestFrameHeight: frame?.height ?? null,
    };
  }

  /** Stops the helper and the receiver. The instance cannot be reused. */
  async dispose() {
    this.disposed = true;
    this.stopping = true;
    await this.startPromise?.catch(() => {});
    this.receiver?.dispose();
    this.receiver = null;
    const helper = this.helper;
    this.helper = null;
    if (helper) {
      const status = await helper.stop();
      this.log("Process exited with status:", status.code);
    }
  }
}

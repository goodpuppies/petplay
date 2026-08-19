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
  /** Whether to log debug information. Defaults to false. */
  debug?: boolean;
  /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
  /** Called when the capture helper exits unexpectedly. */
  onExit?: (status: Deno.CommandStatus) => void;
}

//#endregion

/** Default desktop capture rate. The helper is frame-rate driven, not damage driven. */
export const DEFAULT_CAPTURE_FPS = 60;

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
 * ScreenCapturer provides a high-level interface for capturing screen content.
 * It manages the screen capture process and provides easy access to the latest frame.
 *
 * Example usage:
 * ```typescript
 * const capturer = new ScreenCapturer();
 *
 * // Get the latest frame
 * const frame = await capturer.getLatestFrame();
 * if (frame) {
 *   console.log(`Got frame: ${frame.width}x${frame.height}`);
 *   // Use frame.data (RGBA pixels)...
 * }
 *
 * // Clean up when done
 * await capturer.dispose();
 * ```
 */
export class ScreenCapturer {
  private static readonly LISTENER_START_TIMEOUT_MS = 5_000;
  //#region privates
  private process: Deno.ChildProcess | null = null;
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private worker: Worker | null = null;
  private frameData: CapturedFrame | null = null;
  private frameCount = 0;
  private totalReceiveTime = 0;
  private isStarted = false;
  private options: Required<ScreenCapturerOptions>;
  private startPromise: Promise<void> | null = null;
  private processExit: Deno.CommandStatus | null = null;
  private stopping = false;
  private statsStartedAt = performance.now();
  private frameWaiters: Array<(frame: CapturedFrame | null) => void> = [];
  //#endregion
  /**
   * Creates a new ScreenCapturer instance and automatically starts the capture process.
   * @param options Configuration options for the capturer
   */
  constructor(options: ScreenCapturerOptions = {}) {
    this.options = {
      port: options.port ?? 12345,
      fps: clampCaptureFps(options.fps),
      executablePath: options.executablePath ?? "./screen-streamer",
      captureTokenPath: options.captureTokenPath ?? "screen-streamer-capture.token",
      debug: options.debug ?? false,
      onStats: options.onStats ?? (() => {}),
      onExit: options.onExit ?? (() => {}),
    };
  }

  /**
   * Internal method to log debug messages
   */
  private log(...args: unknown[]) {
    if (this.options.debug) {
      console.log("[ScreenCapturer]", ...args);
    }
  }

  /**
   * Starts the screen capture process if not already started.
   * This is called automatically when needed, but can be called manually to pre-initialize.
   * @returns Promise that resolves when the capture process is ready
   * @throws Error if the capture process fails to start
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.initializeCapture();
    try {
      await this.startPromise;
      this.isStarted = true;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Internal method to initialize the capture process and worker
   */
  private async initializeCapture(): Promise<void> {
    this.log("Starting frame receiver worker...");
    this.worker = new Worker(new URL("./frame_receiver_worker.ts", import.meta.url).href, {
      type: "module",
    });

    // Wait for worker to be ready
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          if (!this.worker) return reject(new Error("Worker not initialized"));

          this.worker.onerror = (event) => {
            event.preventDefault();
            reject(new Error(`Capture receiver worker failed to load: ${event.message}`));
          };
          this.worker.onmessageerror = () => {
            reject(new Error("Capture receiver worker could not deserialize a message"));
          };

          this.worker.onmessage = (e: MessageEvent) => {
            const { type, data, width, height, receiveTime, error } = e.data;
            if (type === "listening") {
              this.log("TCP server started on worker");
              resolve();
            } else if (type === "connected") {
              this.log("Client connected to worker");
            } else if (type === "frame") {
              this.frameData = { data, width, height, receiveTime };
              const waiters = this.frameWaiters.splice(0);
              for (const finish of waiters) finish(this.frameData);
              this.frameCount++;
              this.totalReceiveTime += receiveTime;

              if (this.frameCount % 30 === 0) {
                const avgLatency = this.totalReceiveTime / this.frameCount;
                const now = performance.now();
                const fps = (this.frameCount * 1000) / Math.max(1, now - this.statsStartedAt);
                this.options.onStats({ fps, avgLatency });
                this.totalReceiveTime = 0;
                this.frameCount = 0;
                this.statsStartedAt = now;
              }
            } else if (type === "error") {
              this.log("Worker error:", error);
              reject(new Error(error));
            }
          };

          // Tell worker to start TCP server
          this.worker.postMessage({ type: "connect", port: this.options.port });
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `Capture receiver did not start listening within ${ScreenCapturer.LISTENER_START_TIMEOUT_MS}ms`,
                ),
              ),
            ScreenCapturer.LISTENER_START_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.worker?.terminate();
      this.worker = null;
      throw error;
    }

    // Start the Rust process after worker is ready
    const command = new Deno.Command(this.options.executablePath, {
      args: [
        `--fps=${this.options.fps}`,
        `--port=${this.options.port}`,
        `--capture-token-path=${this.options.captureTokenPath}`,
      ],
      // The helper reads Enter to stop. Keep stdin open for its lifetime rather
      // than giving it Deno.Command's closed default, which makes it exit at
      // once as if the user had pressed Enter.
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    this.process = command.spawn();
    this.controlWriter = this.process.stdin.getWriter();
    this.processExit = null;
    const process = this.process;
    void process.status.then((status) => {
      if (this.process !== process) return;
      this.processExit = status;
      if (!this.stopping) {
        this.options.onExit(status);
      }
    });

    // Handle process output
    this.process.stderr.pipeTo(
      new WritableStream({
        write: (chunk) => {
          const text = new TextDecoder().decode(chunk);
          this.log("Process stderr:", text);
        },
      }),
    );

    this.process.stdout.pipeTo(
      new WritableStream({
        write: (chunk) => {
          const text = new TextDecoder().decode(chunk);
          this.log("Process stdout:", text);
        },
      }),
    );
  }

  /** Capture rate the helper process was launched with. */
  getFps(): number {
    return this.options.fps;
  }

  async sendControl(command: string): Promise<void> {
    if (!this.controlWriter) return;
    try {
      await this.controlWriter.write(new TextEncoder().encode(`${command}\n`));
    } catch (error) {
      this.log("Control write failed:", error);
    }
  }

  /**
   * Gets the latest captured frame. Automatically starts the capture process if needed.
   * @returns Promise that resolves to the latest frame, or null if no frame is available
   * @throws Error if the capture process fails to start
   */
  async getLatestFrame(): Promise<CapturedFrame | null> {
    if (!this.isStarted) {
      await this.start();
    }
    return this.frameData;
  }

  /** Wait for a frame object newer than `previous`, avoiding duplicate timer polling. */
  async getNextFrame(
    previous: CapturedFrame | null,
    timeoutMs = 1_000,
  ): Promise<CapturedFrame | null> {
    if (!this.isStarted) await this.start();
    if (this.frameData && this.frameData !== previous) return this.frameData;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (frame: CapturedFrame | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.frameWaiters.indexOf(finish);
        if (index >= 0) this.frameWaiters.splice(index, 1);
        resolve(frame);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.frameWaiters.push(finish);
    });
  }

  getStatus() {
    return {
      started: this.isStarted,
      starting: this.startPromise !== null,
      workerActive: this.worker !== null,
      processId: this.process?.pid ?? null,
      processRunning: this.process !== null && this.processExit === null,
      processExitCode: this.processExit?.code ?? null,
      processSuccess: this.processExit?.success ?? null,
      latestFrameWidth: this.frameData?.width ?? null,
      latestFrameHeight: this.frameData?.height ?? null,
    };
  }

  /**
   * Stops the capture process and cleans up resources.
   * The instance cannot be reused after calling this method.
   */
  async dispose() {
    this.stopping = true;
    this.isStarted = false;

    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }

    if (this.process) {
      try {
        // Deno throws when kill() races the process status callback. A helper
        // that has already exited only needs to have its status collected.
        if (this.processExit === null) {
          this.process.kill();
        }
        const status = await this.process.status;
        this.log("Process exited with status:", status.code);
      } catch (err) {
        // The process can terminate between the status check and kill().
        // Awaiting status confirms that this is normal teardown.
        try {
          const status = await this.process.status;
          this.log("Process exited with status:", status.code);
        } catch {
          this.log("Error killing process:", err);
        }
      }
      this.process = null;
    }
    try {
      await this.controlWriter?.close();
    } catch {
      // Process teardown can close stdin first.
    }
    this.controlWriter = null;

    this.frameData = null;
    const waiters = this.frameWaiters.splice(0);
    for (const finish of waiters) finish(null);
  }
}

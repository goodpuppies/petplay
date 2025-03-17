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
  /** Path to the screen-streamer executable. Defaults to "./screen-streamer". */
  executablePath?: string;
  /** Whether to log debug information. Defaults to false. */
  debug?: boolean;
  /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
}

//#endregion

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
//#region privates
  private process: Deno.ChildProcess | null = null;
  private worker: Worker | null = null;
  private frameData: CapturedFrame | null = null;
  private frameCount = 0;
  private totalReceiveTime = 0;
  private isStarted = false;
  private options: Required<ScreenCapturerOptions>;
  private startPromise: Promise<void> | null = null;
//#endregion
  /**
   * Creates a new ScreenCapturer instance and automatically starts the capture process.
   * @param options Configuration options for the capturer
   */
  constructor(options: ScreenCapturerOptions = {}) {
    this.options = {
      port: options.port ?? 12345,
      executablePath: options.executablePath ?? "./screen-streamer",
      debug: options.debug ?? false,
      onStats: options.onStats ?? (() => {}),
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
      deno: {
        permissions: {
          net: true,
        },
      },
    });

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error("Worker not initialized"));

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, data, width, height, receiveTime, error } = e.data;
        if (type === 'listening') {
          this.log("TCP server started on worker");
          resolve();
        } else if (type === 'connected') {
          this.log("Client connected to worker");
        } else if (type === 'frame') {
          this.frameData = { data, width, height, receiveTime };
          this.frameCount++;
          this.totalReceiveTime += receiveTime;

          if (this.frameCount % 30 === 0) {
            const avgLatency = this.totalReceiveTime / this.frameCount;
            const fps = 1000 / (avgLatency + 16.67); // Approximate FPS including vsync
            this.options.onStats({ fps, avgLatency });
            this.totalReceiveTime = 0;
            this.frameCount = 0;
          }
        } else if (type === 'error') {
          this.log('Worker error:', error);
          reject(new Error(error));
        }
      };

      // Tell worker to start TCP server
      this.worker.postMessage({ type: 'connect', port: this.options.port });
    });

    // Start the Rust process after worker is ready
    const command = new Deno.Command(this.options.executablePath, {
      stdout: "piped",
      stderr: "piped",
    });

    this.process = command.spawn();
    
    // Handle process output
    this.process.stderr.pipeTo(new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        this.log("Process stderr:", text);
      }
    }));

    this.process.stdout.pipeTo(new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        this.log("Process stdout:", text);
      }
    }));
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

  /**
   * Stops the capture process and cleans up resources.
   * The instance cannot be reused after calling this method.
   */
  async dispose() {
    this.isStarted = false;
    
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    
    if (this.process) {
      try {
        this.process.kill();
        const status = await this.process.status;
        this.log("Process exited with status:", status.code);
      } catch (err) {
        this.log("Error killing process:", err);
      }
      this.process = null;
    }

    this.frameData = null;
  }
}

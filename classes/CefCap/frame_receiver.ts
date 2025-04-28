export interface CapturedFrame {
  data: Uint8Array;/** Raw RGBA pixel data */
  width: number;/** Frame width in pixels */
  height: number;/** Frame height in pixels */
  receiveTime: number;/** Time taken to receive the frame in milliseconds */
  timestamp: number;/** Timestamp when frame was received */
}
export interface ScreenCapturerOptions {
  port?: number; /** TCP port to use for communication with the capture process. Defaults to 12345. */
  executablePath?: string; /** Path to the screen-streamer executable. Defaults to "./screen-streamer". */
  debug?: boolean; /** Whether to log debug information. Defaults to false. */
  onStats?: (stats: { fps: number; avgLatency: number; avgCopyTime: number }) => void; /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  sabs?: SharedArrayBuffer[];/** Optional external SharedArrayBuffers for ping-pong buffers */
}

/**
 * ScreenCapturer provides a high-level interface for capturing screen content.
 * It manages the screen capture process and provides easy access to the latest frame.
 */
export class ScreenCapturer {
//#region privates
  private process: Deno.ChildProcess | null = null;
  private worker: Worker | null = null;
  private sabs: SharedArrayBuffer[] = [];
  private sabViews: Uint8Array[] = [];
  private frameData: CapturedFrame | null = null;
  private onFrameCallback: ((frame: CapturedFrame) => void) | null = null; // Push model callback
  private frameCount = 0;
  private totalReceiveTime = 0;
  private lastStatsTime = 0;
  private isStarted = false;
  private options: Required<ScreenCapturerOptions>;
  private startPromise: Promise<void> | null = null;

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
      sabs: options.sabs ?? [],
    };
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
    console.debug("Starting frame receiver worker...");
    this.worker = new Worker(new URL("./frame_receiver_worker.ts", import.meta.url).href, {
      type: "module"
    });

    // Create or use provided ping-pong buffers for frames
    if (this.options.sabs) {
      this.sabs = this.options.sabs;
    } else {
      const maxPixels = 800 * 600;
      const bufferSize = maxPixels * 4;
      const sab1 = new SharedArrayBuffer(bufferSize);
      const sab2 = new SharedArrayBuffer(bufferSize);
      this.sabs = [sab1, sab2];
    }
    this.sabViews = this.sabs.map(b => new Uint8Array(b));

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error("Worker not initialized"));

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, width, height, receiveTime, error, buffers, index } = e.data;
        if (type === 'listening') {
          console.debug("Named pipe server started on worker");
          this.lastStatsTime = performance.now();
          resolve();
        } else if (type === 'connected') {
          //console.debug("Client connected to worker");
        } else if (type === 'frame-ready') {
          // Use ping-pong buffer by index
          const view = this.sabViews[index] || this.sabViews[0];
          const size = width * height * 4;
          const data = view.subarray(0, size);
          this.frameData = { data, width, height, receiveTime, timestamp: performance.now() };
          this.frameCount++;
          this.totalReceiveTime += receiveTime;

          if (this.frameCount % 30 === 0) {
            const now = performance.now();
            const elapsed = now - this.lastStatsTime;
            const fps = (30 * 1000) / elapsed;
            const avgLatency = this.totalReceiveTime / this.frameCount;
            this.options.onStats({ fps, avgLatency, avgCopyTime: 0 });
            this.totalReceiveTime = 0;
            this.frameCount = 0;
            this.lastStatsTime = now;
          }

          if (this.onFrameCallback) {
            this.onFrameCallback(this.frameData!);
          }
        } else if (type === 'resize') {
          // Resize ping-pong buffers
          this.sabs = buffers as SharedArrayBuffer[];
          this.sabViews = this.sabs.map(b => new Uint8Array(b));
          console.debug('Ping-pong SABs resized to', this.sabs[0].byteLength);
        } else if (type === 'error') {
          console.debug('Worker error:', error);
          reject(new Error(error));
        }
      };

      // Send ping-pong buffers to worker
      this.worker.postMessage({ type: 'connect', port: this.options.port, buffers: this.sabs });
    });
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
        console.debug("Process exited with status:", status.code);
      } catch (err) {
        console.debug("Error killing process:", err);
      }
      this.process = null;
    }

    this.frameData = null;
  }

  /**
   * Register a callback to be invoked on each new frame.
   */
  public onNewFrame(callback: (frame: CapturedFrame) => void): void {
    this.onFrameCallback = callback;
  }
}

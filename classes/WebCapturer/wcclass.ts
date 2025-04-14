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
  /** Time the frame was captured at the source */
  timestamp: number;
  /** Time when the frame became available in shared memory */
  frameAvailableTime?: number;
}

/**
 * Options for configuring the ScreenCapturer
 */
export interface WebCapturerOptions {
  /** Port to use for communication with the capture process. Defaults to 8000. */
  port?: number;
  /** Path to the screen-streamer executable. Defaults to "./denotauri". */
  executablePath?: string;
  /** Whether to log debug information. Defaults to false. */
  debug?: boolean;
  /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
}

//#endregion

import { setImmediate } from "node:timers";
import { wait } from "../utils.ts";

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
export class WebCapturer {
  //#region privates
  private process: Deno.ChildProcess | null = null;
  private worker: Worker | null = null;
  private frameData: CapturedFrame | null = null;
  private frameCount = 0;
  private lastStatTime = performance.now();
  private isStarted = false;
  private options: Required<WebCapturerOptions>;
  private startPromise: Promise<void> | null = null;

  // Constants for SharedArrayBuffer
  private static readonly MAX_FRAME_SIZE = 9 * 1024 * 1024; // ~9MB for 1080p RGBA with some extra space
  private static readonly METADATA_SIZE = 24; // 4 bytes width + 4 bytes height + 8 bytes timestamp + 8 bytes frameAvailableTime
  private static readonly SYNC_SIZE = 4; // 4 bytes for frame ready flag
  private static readonly HEADER_SIZE = WebCapturer.METADATA_SIZE + WebCapturer.SYNC_SIZE;
  private static readonly BUFFER_SIZE = WebCapturer.HEADER_SIZE + WebCapturer.MAX_FRAME_SIZE;

  // SharedArrayBuffer fields
  private sharedBuffer: SharedArrayBuffer | null = null;
  private sharedView: DataView | null = null;
  private frameReadyFlag: Int32Array | null = null;
  private sharedPixelData: Uint8Array | null = null;

  // Polling mechanism fields
  private pollingStarted = false;
  private pollingActive = false;
  private newFrameAvailable = false;
  private lastPolledFrameTime = 0;
  private onNewFrameCallbacks: (() => void)[] = [];

  //#endregion
  /**
   * Creates a new ScreenCapturer instance and automatically starts the capture process.
   * @param options Configuration options for the capturer
   */
  constructor(options: WebCapturerOptions = {}) {
    this.options = {
      port: options.port ?? 8000,
      executablePath: options.executablePath ?? "./denotauri",
      debug: options.debug ?? false,
      onStats: options.onStats ?? (() => {}),
    };
    
    // Initialize SharedArrayBuffer
    try {
      this.sharedBuffer = new SharedArrayBuffer(WebCapturer.BUFFER_SIZE);
      this.sharedView = new DataView(this.sharedBuffer);
      this.frameReadyFlag = new Int32Array(this.sharedBuffer, WebCapturer.METADATA_SIZE, 1);
      this.sharedPixelData = new Uint8Array(this.sharedBuffer, WebCapturer.HEADER_SIZE);
      
      // Initialize frame ready flag to 0 (no frame available)
      Atomics.store(this.frameReadyFlag, 0, 0);
      
      this.log("SharedArrayBuffer initialized with size:", WebCapturer.BUFFER_SIZE);
    } catch (error) {
      console.error("Failed to initialize SharedArrayBuffer:", error);
      throw new Error(`Failed to initialize SharedArrayBuffer: ${error}`);
    }
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
   * Internal method to initialize the WebSocket server worker
   */
  private async initializeCapture(): Promise<void> {
    console.log("Starting WebSocket frame receiver worker...")
    this.log("Starting WebSocket frame receiver worker...");
    this.worker = new Worker(new URL("./frame_receiver_worker.ts", import.meta.url).href, {
      type: "module",
    });

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error("Worker not initialized"));

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, error } = e.data;
        
        if (type === 'listening') {
          this.log(`WebSocket server started on port ${this.options.port}`);
          resolve();
        } else if (type === 'connected') {
          this.log("WebSocket client connected to worker");
        } else if (type === 'frameReady') {
          // PUSH MODEL: Direct notification from worker that a new frame is ready
          // The actual frame data is already in the shared buffer
          const frameDetectTime = Date.now();
          
          try {
            // Extract metadata from the message for convenience
            const { width, height, timestamp, frameAvailableTime } = e.data;
            
            // Calculate the notification latency
            const notificationLatency = frameDetectTime - frameAvailableTime;
            console.log(`Direct push notification latency: ${notificationLatency.toFixed(2)} ms`);
            
            // Get the frame data directly from the shared buffer
            // This is a view, not a copy
            const frameSize = width * height * 4; // RGBA
            
            // Only create a new frame if we don't already have one with the same timestamp
            // This prevents duplicate processing if multiple notifications arrive
            if (!this.frameData || this.frameData.timestamp !== timestamp) {
              this.frameData = {
                data: new Uint8Array(this.sharedBuffer!, WebCapturer.HEADER_SIZE, frameSize),
                width,
                height,
                timestamp,
                frameAvailableTime
              };
              
              // Update stats
              this.frameCount++;
              if (this.options.onStats && this.frameCount % 30 === 0) {
                const now = performance.now();
                const elapsed = now - this.lastStatTime;
                const fps = (30 / elapsed) * 1000;
                this.options.onStats({ fps, avgLatency: notificationLatency });
                this.lastStatTime = now;
              }
              
              // Notify callbacks
              for (const callback of this.onNewFrameCallbacks) {
                try {
                  callback();
                } catch (e) {
                  console.error("Error in frame callback:", e);
                }
              }
            }
          } catch (err) {
            console.error("Error processing frame notification:", err);
            // Use throw error for any undefined behavior as per user rules
            throw new Error(`Error processing frame notification: ${err}`);
          }
        } else if (type === 'error') {
          this.log(`Worker error: ${error}`)
          reject(new Error(error));
        }
      };

      // Send shared buffer to worker first
      if (!this.sharedBuffer) {
        reject(new Error("SharedArrayBuffer not initialized"));
        return;
      }
      
      this.worker.postMessage({ 
        type: 'init',
        buffer: this.sharedBuffer,
        metadataSize: WebCapturer.METADATA_SIZE,
        headerSize: WebCapturer.HEADER_SIZE
      });

      // Then tell worker to start WebSocket server
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
   * Register a callback to be called when a new frame is available.
   * @param callback Function to call when a new frame is detected
   * @returns Function to unregister the callback
   */
  onNewFrame(callback: () => void): () => void {
    this.onNewFrameCallbacks.push(callback);
    
    // Return function to remove the callback
    return () => {
      const index = this.onNewFrameCallbacks.indexOf(callback);
      if (index !== -1) {
        this.onNewFrameCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Gets the latest captured frame. Automatically starts the capture process if needed.
   * @returns Promise that resolves to the latest frame, or null if no frame is available
   * @throws Error if the capture process fails to start or SharedArrayBuffer is not available
   */
  async getLatestFrame(): Promise<CapturedFrame | null> {
    if (!this.isStarted) {
      await this.start();
    }
    
    if (!this.sharedBuffer || !this.sharedView || !this.frameReadyFlag || !this.sharedPixelData) {
      throw new Error("SharedArrayBuffer not initialized");
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

  sendWsMsg(msg: string) {
    if (this.worker) {
      this.worker.postMessage({ type: 'WSMSG', payload: msg });
    }
    else console.log("no worker")
  }
}

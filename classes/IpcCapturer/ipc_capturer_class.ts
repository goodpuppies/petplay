// classes/IpcCapturer/ipc_capturer_class.ts

//#region typings

/**
 * Interface representing a captured frame received via IPC
 */
export interface CapturedIpcFrame {
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Raw RGBA pixel data (View into SharedArrayBuffer) */
  pixelData: Uint8Array;
}

/**
 * Options for configuring the IpcCapturer
 */
export interface IpcCapturerOptions {
  /** The name of the named pipe to listen on. Defaults to '\\.\\pipe\\petplay-ipc-frames'. */
  pipeName?: string;
  /** Whether to log debug information. Defaults to false. */
  debug?: boolean;
  /** Callback for frame statistics (FPS, latency). Called every 30 frames if provided. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
  /** Expected frame width. Defaults to 1920. */
  frameWidth?: number;
  /** Expected frame height. Defaults to 1080. */
  frameHeight?: number;
}

//#endregion

/**
 * IpcCapturer provides a high-level interface for receiving frames via a named pipe.
 * It manages a worker thread that listens on the pipe and uses SharedArrayBuffer
 * for efficient frame transfer.
 * 
 * Example usage:
 * ```typescript
 * const capturer = new IpcCapturer({ pipeName: '\\.\\pipe\\my-app-pipe' });
 * 
 * capturer.onNewFrame(() => {
 *   const frame = await capturer.getLatestFrame();
 *   if (frame) {
 *     console.log(`Got frame: ${frame.width}x${frame.height}`);
 *     // Use frame.pixelData (RGBA pixels from SharedArrayBuffer)... 
 *     // IMPORTANT: Frame data is valid until the next frame arrives.
 *   }
 * });
 * 
 * // Start listening (optional, happens automatically on first getLatestFrame or onNewFrame)
 * await capturer.start(); 
 *
 * // Clean up when done
 * await capturer.dispose();
 * ```
 */
export class IpcCapturer {
  //#region privates
  private worker: Worker | null = null;
  private latestFrame: CapturedIpcFrame | null = null;
  private frameCount = 0;
  private lastStatTime = performance.now();
  private isStarted = false;
  private options: Required<IpcCapturerOptions>;
  private startPromise: Promise<void> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerListeningPromise: Promise<void> | null = null;
  private workerListeningResolve: (() => void) | null = null;

  // --- Constants for SharedArrayBuffer ---
  // These are defaults, can be influenced by options
  private readonly framePixelSize: number;
  private readonly widthOffset = 0; // u32
  private readonly heightOffset = 4; // u32
  private readonly metadataSize = 4 + 4; // width + height only
  private readonly syncOffset = this.metadataSize; // Sync flag starts after metadata
  private readonly syncSize = 4; // Int32Array uses 4 bytes
  private readonly headerSize: number; // Combined size of metadata and sync flag
  private readonly bufferSize: number;
  // ----------------------------------------

  // SharedArrayBuffer fields
  private sharedBuffer: SharedArrayBuffer | null = null;
  private sharedView: DataView | null = null;
  private frameReadyFlag: Int32Array | null = null;
  private sharedPixelData: Uint8Array | null = null;

  // Callbacks
  private onNewFrameCallbacks: (() => void)[] = [];

  //#endregion

  /**
   * Creates a new IpcCapturer instance.
   * @param options Configuration options for the capturer
   */
  constructor(options: IpcCapturerOptions = {}) {
    const defaultWidth = 1920;
    const defaultHeight = 1080;

    this.options = {
      pipeName: options.pipeName ?? '\\\\.\\pipe\\petplay-ipc-frames',
      debug: options.debug ?? false,
      onStats: options.onStats ?? (() => {}),
      frameWidth: options.frameWidth ?? defaultWidth,
      frameHeight: options.frameHeight ?? defaultHeight,
    };

    // Calculate sizes based on options
    this.framePixelSize = this.options.frameWidth * this.options.frameHeight * 4; // RGBA
    this.headerSize = this.metadataSize + this.syncSize;
    this.bufferSize = this.headerSize + this.framePixelSize;

    // Initialize SharedArrayBuffer
    try {
      this.sharedBuffer = new SharedArrayBuffer(this.bufferSize);
      this.sharedView = new DataView(this.sharedBuffer);
      this.frameReadyFlag = new Int32Array(this.sharedBuffer, this.metadataSize, 1); // Flag after metadata
      this.sharedPixelData = new Uint8Array(this.sharedBuffer, this.headerSize); // Pixels after header

      // Initialize frame ready flag to 0 (no frame available)
      Atomics.store(this.frameReadyFlag, 0, 0);

      this.log(`SharedArrayBuffer initialized. Size: ${this.bufferSize}, Meta: ${this.metadataSize}, Header: ${this.headerSize}, Pixels: ${this.framePixelSize}`);
    } catch (error) {
      console.error("[IpcCapturer] Failed to initialize SharedArrayBuffer:", error);
      // Use throw error for any undefined behaviour as per user rules
      throw new Error(`Failed to initialize SharedArrayBuffer: ${error}`);
    }

    // Setup promises for worker state transitions
    this.workerReadyPromise = new Promise(resolve => { this.workerReadyResolve = resolve; });
    this.workerListeningPromise = new Promise(resolve => { this.workerListeningResolve = resolve; });
  }

  /**
   * Internal method to log debug messages
   */
  private log(...args: unknown[]) {
    if (this.options.debug) {
      console.log("[IpcCapturer]", ...args);
    }
  }

  /**
   * Starts the IPC listener worker if not already started.
   * This is called automatically when needed, but can be called manually.
   * @returns Promise that resolves when the worker is initialized and listening.
   * @throws Error if the worker fails to start or initialize.
   */
  async start(): Promise<void> {
    if (this.isStarted) {
       this.log("Already started. Waiting for worker to be ready and listening...");
       await this.workerReadyPromise;
       await this.workerListeningPromise;
       return;
    }
    if (this.startPromise) {
       this.log("Start already in progress...");
       return this.startPromise;
    }

    this.log("Starting...");
    this.startPromise = this.initializeWorker();
    try {
      await this.startPromise;
      this.isStarted = true;
      this.log("Started successfully. Waiting for worker to be listening...");
      await this.workerListeningPromise; // Ensure worker is actually listening
      this.log("Worker is listening.");
    } catch(err) {
      this.log("Start failed:", err);
      this.isStarted = false; // Ensure state reflects failure
      this.worker = null; // Clean up worker on failed start
      // Re-create promises for potential retry
      this.workerReadyPromise = new Promise(resolve => { this.workerReadyResolve = resolve; });
      this.workerListeningPromise = new Promise(resolve => { this.workerListeningResolve = resolve; });
      // Use throw error for any undefined behaviour as per user rules
      throw new Error(`IpcCapturer failed to start: ${err}`);
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Internal method to initialize the IPC receiver worker.
   */
  private async initializeWorker(): Promise<void> {
    this.log("Initializing IPC receiver worker...");
    
    if (this.worker) {
      this.log("Warning: Terminating existing worker before creating new one.");
      this.worker.terminate();
      this.worker = null;
       // Reset promises as we are creating a new worker instance
       this.workerReadyPromise = new Promise(resolve => { this.workerReadyResolve = resolve; });
       this.workerListeningPromise = new Promise(resolve => { this.workerListeningResolve = resolve; });
    }

    this.worker = new Worker(new URL("./ipc_receiver_worker.ts", import.meta.url).href, {
      type: "module",
      name: "ipc-receiver-worker"
    });

    this.log("Worker created. Setting up message handler...");

    // Setup promise for worker 'workerReady' confirmation
    const workerInitConfirmation = new Promise<void>((resolve, reject) => {
        if (!this.worker) return reject(new Error("Worker disappeared during initialization"));

        this.worker.onmessage = (e: MessageEvent) => {
            const { type, error } = e.data;
            this.log(`Received message from worker: ${type}`, e.data);

            switch (type) {
                case 'workerReady':
                    this.log("Worker confirmed SharedArrayBuffer initialization.");
                    if (this.workerReadyResolve) this.workerReadyResolve();
                    resolve(); // Resolve this specific confirmation promise
                    break;
                case 'listening':
                    this.log(`Worker is now listening on pipe: ${e.data.pipeName}`);
                    if (this.workerListeningResolve) this.workerListeningResolve();
                    break;
                case 'connected':
                    this.log("Worker reported client connected to pipe.");
                    break;
                case 'disconnected':
                    this.log("Worker reported client disconnected.");
                    // Consider potential automatic restart logic here?
                    break;
                case 'frameReady':
                    this.handleFrameReady(e.data); // Defined in Part 2
                    break;
                case 'error':
                    console.error(`[IpcCapturer] Worker Error: ${error}`);
                    // Reject the init promise only if error happens during startup phase
                    if (!this.isStarted && this.startPromise) {
                       reject(new Error(`Worker initialization failed: ${error}`));
                    } else {
                       // Handle runtime worker errors (e.g., set error state, attempt restart)
                       this.log("Runtime worker error occurred.");
                    }
                    break;
                case 'stopped':
                    this.log("Worker confirmed it has stopped.");
                    break;
                default:
                    this.log(`Received unknown message type from worker: ${type}`);
            }
        };

        this.worker.onerror = (err) => {
            console.error('[IpcCapturer] Uncaught Worker Error:', err);
            if (!this.isStarted && this.startPromise) {
              reject(new Error(`Uncaught worker error during initialization: ${err.message}`));
            }
            // Consider triggering a restart or entering an error state
        };
    });

    // Send initialization data to worker
    this.log("Sending 'init' message to worker...");
    if (!this.sharedBuffer) {
      throw new Error("SharedArrayBuffer is null during worker initialization");
    }
    this.worker.postMessage({
      type: 'init',
      buffer: this.sharedBuffer,
      metadataSize: this.metadataSize,
      headerSize: this.headerSize,
      framePixelSize: this.framePixelSize
    });

    // Wait for the worker to confirm it has initialized the buffer
    await workerInitConfirmation;
    this.log("Worker initialization confirmed. Sending 'connect' message...");

    // Tell worker to start listening on the pipe
    this.worker.postMessage({ type: 'connect', pipeName: this.options.pipeName });
    this.log(`Connect message sent for pipe: ${this.options.pipeName}`);
  }

  /**
   * Handles the 'frameReady' message from the worker.
   * Updates the latest frame data using SharedArrayBuffer and notifies callbacks.
   */
  private handleFrameReady(frameInfo: any): void {
    const frameDetectTime = performance.now(); // Use performance.now() for higher precision

    try {
        // Verify the SharedArrayBuffer components are available
        if (!this.sharedBuffer || !this.sharedView || !this.frameReadyFlag || !this.sharedPixelData) {
          console.error("[IpcCapturer] SharedArrayBuffer components not available in handleFrameReady.");
          return;
        }

        // Check the atomic flag to ensure the worker has finished writing
        if (Atomics.load(this.frameReadyFlag, 0) !== 1) {
            this.log("Received 'frameReady' but flag not set=1 in SAB. Skipping potentially incomplete frame.");
            return; // Flag not set, frame data might not be fully written yet
        }

        // Extract metadata directly from SharedArrayBuffer (source of truth)
        const width = this.sharedView.getUint32(this.widthOffset, true);
        const height = this.sharedView.getUint32(this.heightOffset, true);

        // Basic validation
        if (width !== this.options.frameWidth || height !== this.options.frameHeight) {
            this.log(`Warning: Received frame dimensions (${width}x${height}) differ from configured (${this.options.frameWidth}x${this.options.frameHeight}).`);
            // Adjust expectations or handle error? For now, log and proceed.
        }

        // Create the frame view (NO COPY)
        const expectedPixelSize = width * height * 4;
        if (this.sharedPixelData.byteLength < expectedPixelSize) {
            console.error(`[IpcCapturer] Shared pixel buffer size (${this.sharedPixelData.byteLength}) is smaller than required for received dimensions (${expectedPixelSize}). Cannot create frame view.`);
            Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag even on error
            return;
        }

        // --- Create/Update latestFrameData --- 
        // REMOVED Check timestamp/dimensions to avoid processing the same frame multiple times
        // The atomic flag now handles ensuring we only process *new* frames written by the worker.
        this.latestFrame = {
            // Create a Uint8Array view for the *current* frame's pixels
            // This view is only valid until the next frame overwrites the SAB
            pixelData: new Uint8Array(this.sharedBuffer, this.headerSize, expectedPixelSize),
            width,
            height,
            timestamp: frameDetectTime // Store the time we detected it main-side
        };
        
        // --- Update stats --- // TODO: Fix latency calculation
        this.frameCount++;
        if (this.options.onStats && this.frameCount % 30 === 0) {
            const now = performance.now();
            const elapsed = now - this.lastStatTime;
            const fps = (30 / elapsed) * 1000;
            // Calculate latency: time from capture start to detection in main thread
            const totalLatency = frameDetectTime - this.latestFrame.timestamp; // Use internal timestamp
            this.options.onStats({ fps, avgLatency: totalLatency }); 
            this.lastStatTime = now;
        }

        // --- Notify Callbacks --- 
        // This now happens *every* time a frame is ready according to the flag
        // Use setImmediate or queueMicrotask if callbacks might be long-running
        for (const callback of this.onNewFrameCallbacks) {
          try {
              // console.log("[IpcCapturer] Notifying callback") // DEBUG
                callback();
            } catch (e) {
                console.error("[IpcCapturer] Error in onNewFrame callback:", e);
            }
        }

        // IMPORTANT: Reset the flag AFTER processing the frame data.
        // If reset before, a fast sender could overwrite data before callbacks run.
        // DECISION: Let the user call a method like `frameProcessed()` to reset the flag?
        // For now, let's NOT reset it automatically. The user must get the frame.
        // If they call getLatestFrame multiple times without the flag changing, they get the same data.
        // Let's add a method to reset it. (Added below)

    } catch (err) {
        console.error("[IpcCapturer] Error processing frameReady message:", err);
        // Optionally reset flag on error?
        if(this.frameReadyFlag) Atomics.store(this.frameReadyFlag, 0, 0);
        // Use throw error for any undefined behaviour as per user rules
        throw new Error(`Error processing frame notification: ${err}`);
    }
  }

  /**
   * Register a callback to be called immediately when a new frame is available.
   * Note: The frame data in SharedArrayBuffer might be overwritten shortly after the callback fires.
   * Call `getLatestFrame()` within the callback to access the data.
   * @param callback Function to call when a new frame is detected
   * @returns Function to unregister the callback
   */
  onNewFrame(callback: () => void): () => void {
    this.onNewFrameCallbacks.push(callback);
    this.log(`Registered new frame callback. Total callbacks: ${this.onNewFrameCallbacks.length}`);
    
    // Ensure worker is started if registering a callback
    this.start().catch(err => {
        console.error("[IpcCapturer] Auto-start failed when registering callback:", err);
    }); 

    // Return function to remove the callback
    return () => {
      const index = this.onNewFrameCallbacks.indexOf(callback);
      if (index !== -1) {
        this.onNewFrameCallbacks.splice(index, 1);
        this.log(`Unregistered frame callback. Remaining callbacks: ${this.onNewFrameCallbacks.length}`);
      } else {
        this.log("Attempted to unregister a callback that was not found.");
      }
    };
  }

  /**
   * Gets the latest captured frame data directly from the SharedArrayBuffer.
   * Automatically starts the capture process if needed.
   * Returns the *current* view into the buffer. This view is only valid until the 
   * *next* frame arrives and overwrites the buffer.
   * @returns Promise that resolves to the latest frame, or null if no frame has arrived yet.
   * @throws Error if the capture process fails to start or SharedArrayBuffer is not available.
   */
  async getLatestFrame(): Promise<CapturedIpcFrame | null> {
    if (!this.isStarted) {
      this.log("getLatestFrame called before start, initiating start...");
      await this.start(); // Ensure worker is initialized and listening
    }
    
    if (!this.sharedBuffer || !this.sharedView || !this.frameReadyFlag || !this.sharedPixelData) {
       console.error("[IpcCapturer] SharedArrayBuffer components not ready in getLatestFrame.")
      // Use throw error for any undefined behaviour as per user rules
      throw new Error("SharedArrayBuffer not initialized or worker failed");
    }

    // Check the flag. If it's not 1, no new frame is ready since the last check (or ever).
    if (Atomics.load(this.frameReadyFlag, 0) === 1) {
        // Flag is 1, means new data is present. Re-create the view object.
        // Note: The underlying data might have *already* changed between the 'frameReady' 
        // message and this call, but this reflects the *current* state of the SAB.
        try {
            const width = this.sharedView.getUint32(this.widthOffset, true);
            const height = this.sharedView.getUint32(this.heightOffset, true);

            // Check if dimensions are valid before proceeding
            if (width === 0 || height === 0) {
                if (this.options.debug) console.warn('[IpcCapturer] getLatestFrame: Frame has zero width/height in buffer.');
                Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag as frame is invalid/consumed
                return null;
            }

            const requiredPixelSize = width * height * 4;
            if (requiredPixelSize > this.sharedPixelData.byteLength) {
                console.error(`[IpcCapturer] getLatestFrame: Shared pixel buffer size (${this.sharedPixelData.byteLength}) is smaller than required for received dimensions (${width}x${height} = ${requiredPixelSize} bytes).`);
                Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag as frame is invalid/consumed
                return null;
            }

            // Create a copy of the pixel data for the caller
            // Important: Accessing sharedPixelData directly requires careful synchronization,
            // but since we just checked the flag and are about to reset it, this read should be safe
            // relative to the writer (worker). The caller gets a snapshot.
            const pixelDataCopy = new Uint8Array(requiredPixelSize); // Create new buffer for the copy
            pixelDataCopy.set(new Uint8Array(this.sharedBuffer!, this.headerSize, requiredPixelSize));

            const frame: CapturedIpcFrame = {
              width,
              height,
              pixelData: pixelDataCopy, // Return the copy
            };

            console.log(`[IPC Capturer] getLatestFrame: Returning frame. Width=${frame.width}, Height=${frame.height}, PixelData type=${typeof frame.pixelData}, length=${frame.pixelData?.byteLength}`);

            // Reset the flag as the frame has been consumed by the main thread
            Atomics.store(this.frameReadyFlag, 0, 0);
            return frame;

        } catch (err) {
            console.error("[IpcCapturer] Error reading frame data from SharedArrayBuffer:", err);
             Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag on error too
             return null;
        }
    }
    // If flag was 0, return the previously stored frame data (or null if none yet)
    return this.latestFrame;
  }

  /**
   * Stops the IPC listener worker and cleans up resources.
   * The instance should not be used after calling this method unless start() is called again.
   */
  async dispose(): Promise<void> {
    this.log("Dispose called.");
    this.isStarted = false; // Mark as not started
    this.onNewFrameCallbacks = []; // Clear callbacks
    this.latestFrame = null;

    if (this.startPromise) {
        this.log("Waiting for pending start promise to resolve/reject before disposing...");
        try {
           await this.startPromise;
        } catch (e) {
            this.log("Pending start promise failed:", e);
        }
        this.startPromise = null;
    }

    if (this.worker) {
      this.log("Sending 'stop' message to worker and terminating...");
      this.worker.postMessage({ type: 'stop' });
      // Give worker a brief moment to handle 'stop' before terminating
      await new Promise(resolve => setTimeout(resolve, 50)); 
      this.worker.terminate();
      this.worker = null;
      this.log("Worker terminated.");
    } else {
      this.log("No active worker to terminate.");
    }

    // Reset promises for potential re-start
    this.workerReadyPromise = new Promise(resolve => { this.workerReadyResolve = resolve; });
    this.workerListeningPromise = new Promise(resolve => { this.workerListeningResolve = resolve; });
    
     // Clear SharedArrayBuffer references (the buffer itself persists until GC)
     this.sharedBuffer = null;
     this.sharedView = null;
     this.frameReadyFlag = null;
     this.sharedPixelData = null;

    this.log("Dispose finished.");
  }
}

// classes/IpcCapturer/ipc_capturer_class.ts

//#region typings

/** Interface representing a captured frame received via IPC */
export interface CapturedIpcFrame {
  width: number;
  height: number;
  pixelData: Uint8Array; // Copy of data from SharedArrayBuffer
}

/** Options for configuring the IpcCapturer */
export interface IpcCapturerOptions {
  pipeName?: string;
  debug?: boolean;
  frameWidth?: number;
  frameHeight?: number;
}

// --- Message Types for Worker Communication ---
type WorkerInitMessage = {
  type: 'init';
  buffer: SharedArrayBuffer;
  metadataSize: number;
  headerSize: number;
  framePixelSize: number;
};
type WorkerConnectMessage = { type: 'connectFramePipe'; pipeName: string };
type WorkerStopMessage = { type: 'stop' };
type MainThreadMessage = WorkerInitMessage | WorkerConnectMessage | WorkerStopMessage;

type WorkerReadyMessage = { type: 'workerReady' };
type WorkerListeningMessage = { type: 'framePipeListening'; pipeName: string };
type WorkerConnectedMessage = { type: 'connected' };
type WorkerDisconnectedMessage = { type: 'disconnected' };
type WorkerFrameReadyMessage = { type: 'frameReady'; width: number; height: number /* Add other relevant info if needed */ };
type WorkerErrorMessage = { type: 'error'; error: string };
type WorkerStoppedMessage = { type: 'stopped' };
type WorkerMessage = 
  | WorkerReadyMessage
  | WorkerListeningMessage
  | WorkerConnectedMessage
  | WorkerDisconnectedMessage
  | WorkerFrameReadyMessage
  | WorkerErrorMessage
  | WorkerStoppedMessage;
// --------------------------------------------

//#endregion

/**
 * IpcCapturer provides a high-level interface for receiving frames via a named pipe
 * using a worker and SharedArrayBuffer for efficient transfer.
 */
export class IpcCapturer {
  private worker: Worker | null = null;
  private latestFrameMetadata: Omit<CapturedIpcFrame, 'pixelData'> | null = null;
  private isStarted = false;
  private startPromise: Promise<void> | null = null;
  private readonly options: Required<IpcCapturerOptions>;

  // SharedArrayBuffer related fields
  private readonly sharedBuffer: SharedArrayBuffer;
  private readonly sharedView: DataView;
  private readonly frameReadyFlag: Int32Array; // Atomic flag (0 = not ready, 1 = ready)
  private readonly sharedPixelDataView: Uint8Array; // View into the pixel data part of SAB
  private readonly metadataSize: number;
  private readonly headerSize: number; // metadataSize + syncFlagSize
  private readonly framePixelSize: number;

  private onNewFrameCallbacks: Set<() => void> = new Set();

  constructor(options: IpcCapturerOptions = {}) {
    const defaultWidth = 1920;
    const defaultHeight = 1080;

    this.options = {
      pipeName: options.pipeName ?? '\\\\.\\pipe\\petplay-ipc-frames',
      debug: options.debug ?? false,
      frameWidth: options.frameWidth ?? defaultWidth,
      frameHeight: options.frameHeight ?? defaultHeight,
    };

    this.metadataSize = 4 + 4; // width (u32) + height (u32)
    const syncFlagSize = 4; // Int32Array element size
    this.headerSize = this.metadataSize + syncFlagSize;
    this.framePixelSize = this.options.frameWidth * this.options.frameHeight * 4; // RGBA
    const bufferSize = this.headerSize + this.framePixelSize;

    try {
      this.sharedBuffer = new SharedArrayBuffer(bufferSize);
      this.sharedView = new DataView(this.sharedBuffer);
      // Place flag after metadata: Access via index 0 of the Int32Array
      this.frameReadyFlag = new Int32Array(this.sharedBuffer, this.metadataSize, 1); 
      // Pixel data starts after the header (metadata + flag)
      this.sharedPixelDataView = new Uint8Array(this.sharedBuffer, this.headerSize);
      Atomics.store(this.frameReadyFlag, 0, 0); // Initialize flag to 0 (not ready)
      this.log(`SharedArrayBuffer initialized. Total Size: ${bufferSize}`);
    } catch (error) {
      console.error("[IpcCapturer] Failed to initialize SharedArrayBuffer:", error);
      throw new Error(`Failed to initialize SharedArrayBuffer: ${error}`);
    }
  }

  private log(...args: unknown[]) {
    if (this.options.debug) {
      console.log("[IpcCapturer]", ...args);
    }
  }

  /** Starts the IPC listener worker. Returns promise resolving when worker is listening. */
  async start(): Promise<void> {
    if (this.isStarted) {
      this.log("Already started.");
      return;
    }
    if (this.startPromise) {
      this.log("Start already in progress...");
      return this.startPromise;
    }

    this.log("Starting...");
    
    // deno-lint-ignore no-async-promise-executor
    this.startPromise = new Promise<void>(async (resolve, reject) => {
      try {
        this.worker = new Worker(new URL("./ipc_receiver_worker.ts", import.meta.url).href, {
          type: "module",
          name: "ipc-receiver-worker"
        });
        this.log("Worker created.");

        this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
          const msg = e.data;
          this.log(`Worker message: ${msg.type}`, msg);

          switch (msg.type) {
            case 'framePipeListening':
              this.isStarted = true;
              this.log(`Worker listening on pipe: ${msg.pipeName}`);
              resolve(); // Start successful
              break;
            case 'frameReady':
              this.handleFrameReady(msg.width, msg.height);
              break;
            case 'error':
              console.error(`[IpcCapturer] Worker Error: ${msg.error}`);
              // Reject startPromise only if error occurs *during* startup phase
              if (!this.isStarted && this.startPromise) {
                reject(new Error(`Worker initialization failed: ${msg.error}`));
              }
              break;
            // Handle other messages if needed (e.g., 'connected', 'disconnected', 'stopped')
            // For simplicity, we primarily care about 'listening' for startup and 'frameReady'.
          }
        };

        this.worker.onerror = (err) => {
          console.error('[IpcCapturer] Uncaught Worker Error:', err);
          if (!this.isStarted && this.startPromise) {
             reject(new Error(`Uncaught worker error during initialization: ${err.message}`));
          }
          // Consider cleanup or entering a failed state here
        };

        // Send init data
        const initMsg: WorkerInitMessage = {
            type: 'init',
            buffer: this.sharedBuffer,
            metadataSize: this.metadataSize,
            headerSize: this.headerSize,
            framePixelSize: this.framePixelSize
        };
        this.worker.postMessage(initMsg);
        this.log("Sent 'init' to worker.");

        // Wait briefly for init processing (optional, but can help stability)
        await new Promise(res => setTimeout(res, 10)); 

        // Tell worker to connect
        const connectMsg: WorkerConnectMessage = { type: 'connectFramePipe', pipeName: this.options.pipeName };
        this.worker.postMessage(connectMsg);
        this.log(`Sent 'connect' for pipe: ${this.options.pipeName}`);

      } catch (err) {
        console.error("[IpcCapturer] Error during worker initialization:", err);
        this.worker?.terminate();
        this.worker = null;
        reject(err); // Reject the startPromise
      }
    });

    try {
      await this.startPromise;
    } catch (err) {
      this.log("Start failed.");
      this.startPromise = null; // Clear promise on failure
      this.isStarted = false;
      throw err; // Re-throw the error
    } // No finally block needed here, startPromise is cleared on success/failure within

  }

  /** Handles the 'frameReady' notification from the worker. */
  private handleFrameReady(width: number, height: number): void {
    // Check the atomic flag written by the worker
    if (Atomics.load(this.frameReadyFlag, 0) !== 1) {
        this.log("Received 'frameReady' notification, but SAB flag is not 1. Skipping.");
        return; // Worker might not have finished writing completely
    }

    // Update internal metadata (actual data is read from SAB in getLatestFrame)
    this.latestFrameMetadata = { width, height };
    
    // Validate dimensions read from SAB against reported dimensions (optional sanity check)
    const sabWidth = this.sharedView.getUint32(0, true);
    const sabHeight = this.sharedView.getUint32(4, true);
    if (sabWidth !== width || sabHeight !== height) {
         this.log(`Warning: Discrepancy between reported dimensions (${width}x${height}) and SAB dimensions (${sabWidth}x${sabHeight}). Using SAB dimensions.`);
         this.latestFrameMetadata = { width: sabWidth, height: sabHeight };
    }
    
     // Validate against configured dimensions (optional)
     if (sabWidth !== this.options.frameWidth || sabHeight !== this.options.frameHeight) {
         this.log(`Warning: Received frame dimensions (${sabWidth}x${sabHeight}) differ from configured (${this.options.frameWidth}x${this.options.frameHeight}).`);
     }

    // Notify callbacks
    this.onNewFrameCallbacks.forEach(callback => {
      try {
            callback();
        } catch (e) {
            console.error("[IpcCapturer] Error in onNewFrame callback:", e);
        }
    });
    // Note: Flag is NOT reset here. It's reset in getLatestFrame when data is consumed.
  }

  /** Registers a callback for new frame notifications. */
  onNewFrame(callback: () => void): () => void {
    this.onNewFrameCallbacks.add(callback);
    this.log(`Registered new frame callback. Total: ${this.onNewFrameCallbacks.size}`);
    // Ensure worker starts automatically if not already started
    this.start().catch(err => {
        console.error("[IpcCapturer] Auto-start failed when registering callback:", err);
    });
    // Return unregister function
    return () => {
      this.onNewFrameCallbacks.delete(callback);
      this.log(`Unregistered frame callback. Remaining: ${this.onNewFrameCallbacks.size}`);
    };
  }

  /**
   * Sends the XR device's 4x4 transform matrix to the IPC worker.
   * The worker will then forward this data via the transform named pipe.
   * @param matrixData A Float32Array representing the 4x4 matrix (column-major or row-major, ensure consistency with receiver).
   */
  public sendTransformMatrix(matrixData: Float32Array): void {
    if (!this.worker) {
      console.warn("[IpcCapturer] Worker not initialized, cannot send transform matrix.");
      return;
    }

    // Check if it's a Float32Array and has the correct byte length (16 floats * 4 bytes/float = 64 bytes)
    if (!(matrixData instanceof Float32Array) || matrixData.byteLength !== 64) {
        console.error(`[IpcCapturer] Invalid matrix provided to sendTransformMatrix. Expected Float32Array with byteLength 64, received:`, matrixData);
        // Per user preference, throw an error for undefined behavior
        throw new Error("Invalid matrix provided to sendTransformMatrix. Expected Float32Array with byteLength 64.");
    }

    // Post message to the worker
    // Note: Transferable objects are not strictly needed for Float32Array to workers unless very large, 
    // but it's good practice if performance becomes critical.
    // For now, standard postMessage is fine.
    this.worker.postMessage({ type: 'sendTransform', matrix: matrixData }); 
    // console.log("[IpcCapturer] Sent transform matrix to worker."); // Optional logging
  }

  /** Gets the latest frame data. Checks the sync flag, reads from SharedArrayBuffer,
   * creates a COPY of the pixel data, and resets the flag.
   * Returns null if no *new* frame is available since the last call.
   */
  getLatestFrame(): CapturedIpcFrame | null {
    if (!this.isStarted) {
      throw new Error("getLatestFrame called before start");
    }
    
    // Check the flag. If 0, no new data is ready.
    if (Atomics.load(this.frameReadyFlag, 0) === 0) {
      console.log("no frame available")
        return null; 
    }


    // Flag is 1: New data available. Read, copy, and reset flag.
    try {
        const width = this.sharedView.getUint32(0, true); // Read width from SAB
        const height = this.sharedView.getUint32(4, true); // Read height from SAB

        if (width === 0 || height === 0) {
            this.log('Warning: Frame in buffer has zero width/height.');
            Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag even for invalid frame
            return null;
        }

        const requiredPixelSize = width * height * 4;
        if (requiredPixelSize > this.sharedPixelDataView.byteLength) {
            console.error(`[IpcCapturer] SAB pixel buffer size (${this.sharedPixelDataView.byteLength}) too small for frame (${width}x${height} = ${requiredPixelSize} bytes).`);
            Atomics.store(this.frameReadyFlag, 0, 0); // Reset flag
            return null;
        }

        // --- Create a COPY of the pixel data --- 
        const pixelDataCopy = new Uint8Array(requiredPixelSize);
        pixelDataCopy.set(this.sharedPixelDataView.subarray(0, requiredPixelSize));
        // --------------------------------------

        // Reset the flag *after* successfully reading and copying data
        Atomics.store(this.frameReadyFlag, 0, 0);

        // Update latest known metadata (mostly for potential future use)
        this.latestFrameMetadata = { width, height };

        return { width, height, pixelData: pixelDataCopy };

    } catch (err) {
        console.error("[IpcCapturer] Error reading frame data from SharedArrayBuffer:", err);
        // Attempt to reset flag even on error
        try { Atomics.store(this.frameReadyFlag, 0, 0); } catch {} 
        return null;
    }
  }

  /** Stops the worker and cleans up resources. */
  async dispose(): Promise<void> {
    this.log("Dispose called.");
    const currentStartPromise = this.startPromise;
    this.isStarted = false;
    this.startPromise = null; // Prevent further starts
    this.onNewFrameCallbacks.clear();
    this.latestFrameMetadata = null;

    // If start was in progress, wait for it to finish (or fail) before terminating
    if (currentStartPromise) {
        this.log("Waiting for pending start to finish before disposing...");
        try { await currentStartPromise; } catch (e) { this.log("Pending start failed:", e); }
    }

    if (this.worker) {
      this.log("Sending 'stop' and terminating worker...");
      try {
        const stopMsg: WorkerStopMessage = { type: 'stop' };
        this.worker.postMessage(stopMsg);
        // Brief delay might help worker process 'stop', but terminate is forceful
        await new Promise(resolve => setTimeout(resolve, 50)); 
      } catch (e) { this.log("Error sending 'stop' message:", e) }
      
      this.worker.terminate();
      this.worker = null;
      this.log("Worker terminated.");
    } else {
      this.log("No active worker to terminate.");
    }
    
    // SharedArrayBuffer memory itself is managed by GC, no explicit cleanup needed here.

    this.log("Dispose finished.");
  }
}

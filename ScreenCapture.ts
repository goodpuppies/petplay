import { decode, memory } from "./decode.wasm";

const FIXED_SIZE = 8294400; // 8.3 MB buffer

export class ScreenCapture {
    private captureWorker: Worker;
    private workerReady: boolean = false;
    private currentFrame: { pixels: Uint8Array; width: number; height: number } | null = null;

    constructor() {
        console.log("Starting capture worker...");
        this.captureWorker = new Worker(new URL("./ScreenCaptureWorker.ts", import.meta.url).href, { type: "module" });
        this.captureWorker.onmessage = this.handleMessage.bind(this);
    }

    private stringToBinary(encoded: Uint8Array): Uint8Array {
        const wasmMemory = new Uint8Array(memory.buffer);
        wasmMemory.set(encoded, 0);
        decode(0, FIXED_SIZE);
        return wasmMemory.subarray(0, FIXED_SIZE);
    }

    private async handleMessage(e: MessageEvent): Promise<void> {
        const { type, frame } = e.data;

        switch (type) {
            case "ready":
                console.log("Capture worker is ready");
                this.workerReady = true;
                this.captureWorker.postMessage({ type: "getFrame" });
                break;

            case "frame":
                if (frame) {
                    //console.log(`Frame received`);
                    if (!frame.encodedData) {
                        console.log("No encoded data in frame");
                        await new Promise((resolve) => setTimeout(resolve, 16));
                        this.captureWorker.postMessage({ type: "getFrame" });
                        return;
                    }
                    const pixels = this.stringToBinary(frame.encodedData);
                    this.currentFrame = {
                        pixels,
                        width: frame.width,
                        height: frame.height,
                    };

                    // Wait a bit before requesting the next frame (~60fps timing)
                    await new Promise((resolve) => setTimeout(resolve, 16));
                    this.captureWorker.postMessage({ type: "getFrame" });
                }
                break;
        }
    }

    public isWorkerReady(): boolean {
        return this.workerReady;
    }

    public getCurrentFrame(): { pixels: Uint8Array; width: number; height: number } | null {
        return this.currentFrame;
    }

    public start(): void {
        if (!this.workerReady) {
            console.error("Worker is not ready yet!");
            return;
        }
        this.captureWorker.postMessage({ type: "start" });
    }

    public stop(): void {
        this.captureWorker.postMessage({ type: "stop" });
    }
}

/* // Example Usage
const screenCapture = new ScreenCapture();

// Polling for readiness and starting capture
const intervalId = setInterval(() => {
    if (screenCapture.isWorkerReady()) {
        console.log("Starting screen capture...");
        screenCapture.start();
        clearInterval(intervalId);
    }
}, 100);

// Access the current frame at any time
setInterval(() => {
    const frame = screenCapture.getCurrentFrame();
    if (frame) {
        console.log(`Frame received: ${frame.width}x${frame.height}`);
    }
}, 1000);
 */
import { python } from "jsr:@denosaurs/python";

// Add worker context type
declare const self: Worker;

// Notify main thread that worker is ready
self.postMessage({ type: 'ready' });
console.log("Worker started");

self.onmessage = async (e: MessageEvent) => {
    const { type, data } = e.data;

    //console.log("Worker received message:");

    switch (type) {
        case 'start': {
            await capture.start();
            self.postMessage({ type: 'started' });
            break;
        }
        case 'stop': {
            capture.stop();
            self.postMessage({ type: 'stopped' });
            break;
        }
        case 'getFrame': {
            const frame = capture.getCurrentFrame();
            self.postMessage({
                type: 'frame',
                frame
            });
            break;
        }
    }
};

class ScreenCapture {
    private capture: any;
    private textEncoder: TextEncoder;
    private currentFrame: Uint8Array | null = null;
    private width: number = 0;
    private height: number = 0;
    private updateInterval: number;
    private isRunning: boolean = false;
    private frameCount = 0;
    private lastFpsUpdate = 0;
    private currentFps = 0;


    constructor(updateIntervalMs: number = 16) { // Default to ~60fps
        this.textEncoder = new TextEncoder();
        this.updateInterval = updateIntervalMs;

        const { CaptureManager } = python.runModule(`
import threading
from windows_capture import WindowsCapture, Frame, InternalCaptureControl
import queue
import time
import numpy as np
import base64
from numba import njit, prange
import gc
gc.disable()

buffer = np.empty(8294400, dtype=np.uint8)  # Pre-allocate buffer

@njit
def binary_to_safe_string_preallocated(data, buffer):
    arr = np.frombuffer(data, dtype=np.uint8)
    # Element-wise operations in a loop
    for i in range(len(arr)):
        buffer[i] = (arr[i] >> 2) + 32
    return buffer[: len(arr)]

def binary_to_string(data):
    # Use preallocated buffer and avoid intermediate copies
    encoded_array = binary_to_safe_string_preallocated(data, buffer)
    return encoded_array.tobytes().decode('ascii')

def string_to_binary(s):
    arr = np.frombuffer(s.encode('ascii'), dtype=np.uint8)
    
    # Convert back and shift left to expand to 8 bits
    # This maintains the high 6 bits and sets low 2 bits to 0
    expanded = ((arr - 32) << 2)
    
    return expanded.tobytes()

class TimingStats:
    def __init__(self, window_size=100):
        self.timings = {}
        self.window_size = window_size
    
    def record(self, name, duration):
        if name not in self.timings:
            self.timings[name] = []
        self.timings[name].append(duration)
        if len(self.timings[name]) > self.window_size:
            self.timings[name].pop(0)
    
    def get_stats(self):
        result = {}
        for name, times in self.timings.items():
            if times:
                avg = sum(times) / len(times)
                max_time = max(times)
                result[name] = f"{avg*1000:.1f}ms (max: {max_time*1000:.1f}ms)"
        return result

class CaptureManager:
    def __init__(self):
        self.frames = [(None, None, None), (None, None, None)]  # Two frame buffers
        self.write_idx = 0  # Index for writing new frames
        self.read_idx = 1   # Index for reading frames
        self.latest_frame_ready = threading.Event()  # Keep for initialization 
        self.running = True
        self.frame_count = 0
        self.start_time = time.perf_counter()
        self.fps = 0
        self.stats = TimingStats()
        
        print("Starting capture...")
        self.capture = WindowsCapture(
            cursor_capture=None,
            draw_border=None,
            monitor_index=None,
            window_name=None,
        )
        
        @self.capture.event
        def on_frame_arrived(frame: Frame, capture_control: InternalCaptureControl):
            if not self.running:
                capture_control.stop()
                return
            
            # Only measure total time
            t_start = time.perf_counter()
            
            raw_data = frame.frame_buffer.tobytes('C')
            if len(raw_data) == 0:
                return
                    
            encoded_str = binary_to_string(raw_data)
            
            # Write to current write buffer and swap
            self.frames[self.write_idx] = (
                str(frame.width), 
                str(frame.height),
                encoded_str
            )
            self.write_idx, self.read_idx = self.read_idx, self.write_idx
            
            # Only track frame count and occasional total time
            self.frame_count += 1
            elapsed = time.perf_counter() - t_start
            
            # Log less frequently
            if self.frame_count % 60 == 0:  # Log every ~60 frames instead of time-based
                self.stats.record('total_capture', elapsed)
                #print(f"Python Capture FPS: {self.frame_count / (time.perf_counter() - self.start_time):5.1f}")
                self.frame_count = 0
                self.start_time = time.perf_counter()
        
        @self.capture.event
        def on_closed():
            print("Capture closed")
            
        self.capture_thread = threading.Thread(target=self.capture.start)
        self.capture_thread.start()
        
        # Wait for first valid frame
        timeout = 5.0
        start_wait = time.perf_counter()
        while time.perf_counter() - start_wait < timeout:
            if self.latest_frame_ready.wait(0.1):
                if self.frames[self.read_idx][0] is not None:
                    break
        
    def stop(self):
        self.running = False
        self.capture_thread.join()
        
    def get_frame(self):

        
        # Simply return current read buffer
        frame = self.frames[self.read_idx]
        

        
        return frame if frame[0] is not None else ("0", "0", "")

`, "screen_capture.py");

        this.capture = new CaptureManager();
    }

    private updateFrame() {
        //console.log("Updating frame...");
        const [width, height, encodedData] = this.capture.get_frame();
        const encoded = this.textEncoder.encode(encodedData);
        this.width = parseInt(width);
        this.height = parseInt(height);
        this.currentFrame = encoded;
    }

    private updateFps() {
        this.frameCount++;
        const now = performance.now();
        const elapsed = now - this.lastFpsUpdate;

        if (elapsed >= 1000) { // Update FPS every second
            this.currentFps = (this.frameCount * 1000) / elapsed;
            //console.log(`Capture FPS TS: ${this.currentFps.toFixed(1)}`);
            this.frameCount = 0;
            this.lastFpsUpdate = now;
        }
    }

    private async updateLoop() {
        console.log("Starting update loop...");
        while (this.isRunning) {
            //console.log("Loop iteration, isRunning:", this.isRunning);
            const startTime = performance.now();
            this.updateFrame();
            this.updateFps();

            await new Promise(resolve => setTimeout(resolve, 0))
        }
        console.log("Update loop ended");
    }

    public async start() {
        console.log("START CALLED");
        if (this.isRunning) return;
        console.log("Starting capture...");
        this.isRunning = true;
        this.updateLoop();
        console.log("Capture started");
    }

    public stop() {
        console.log("Stopping capture...");
        this.isRunning = false;
        this.capture.stop();
    }

    public getCurrentFrame(): { encodedData: Uint8Array|null, width: number, height: number } {
        return {
            encodedData: this.currentFrame,
            width: this.width,
            height: this.height
        };
    }
}

const capture = new ScreenCapture();



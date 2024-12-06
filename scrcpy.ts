import { python } from "jsr:@denosaurs/python";
import { decode, memory } from "./decode.wasm";

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
                print(f"Capture FPS: {self.frame_count / (time.perf_counter() - self.start_time):5.1f}")
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

const capture = new CaptureManager();

const FIXED_SIZE = 8294400; // Fixed buffer size (8.3 MB)

const textEncoder = new TextEncoder();
function stringToBinary(str: string): Uint8Array {
    const start = performance.now();
    const wasmMemory = new Uint8Array(memory.buffer);
    const memoryTime = performance.now();

    const encoded = textEncoder.encode(str);
    const encodeTime = performance.now();

    wasmMemory.set(encoded, 0);
    const copyTime = performance.now();

    decode(0, FIXED_SIZE);
    const decodeTime = performance.now();

    const result = wasmMemory.subarray(0, FIXED_SIZE);
    const endTime = performance.now();

    timings.stringToBinary.push(endTime - start);

    return result;
}


let fetchCount = 0;
let fetchStart = performance.now();
const timings: { [key: string]: number[] } = {
    getFrame: [],
    decode: [],
    stringToBinary: [],
    total: []
};

function updateStats() {
    const stats: { [key: string]: string } = {};
    for (const [key, times] of Object.entries(timings)) {
        if (times.length > 0) {
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const max = Math.max(...times);
            stats[key] = `${avg.toFixed(1)}ms (max: ${max.toFixed(1)}ms)`;
        }
    }
    return stats;
}



function updateFrame() {
    const startTime = performance.now();

    // Time get_frame
    const getFrameStart = performance.now();
    const [width, height, encodedData] = capture.get_frame();
    const getFrameEnd = performance.now();

    // Time decode operation
    const decodeStart = performance.now();
    const decodedData = stringToBinary(encodedData);
    const decodeEnd = performance.now();

    // Record all timings
    timings.getFrame.push(getFrameEnd - getFrameStart);
    timings.decode.push(decodeEnd - decodeStart);
    timings.total.push(decodeEnd - startTime);

    // Maintain window size
    Object.values(timings).forEach(arr => {
        if (arr.length > 100) arr.shift();
    });

    // Update FPS and log stats once per second
    fetchCount++;
    const now = performance.now();
    const elapsed = (now - fetchStart) / 1000;

    /* if (elapsed >= 1.0) { // Log every ~1 second at 60fps
        const firstBytes = Array.from(decodedData.slice(0, 16));
        const lastBytes = Array.from(decodedData.slice(-16));
        console.log("\nFirst 16 bytes:", firstBytes);
        console.log("Last 16 bytes:", lastBytes);
    } */

    if (elapsed >= 1.0) {
        const fps = fetchCount / elapsed;
        console.log(`Fetch FPS: ${fps.toFixed(1)}`);
        console.log("JS Timings:", updateStats());
        console.log(`Frame size: ${decodedData.length} bytes`);
        fetchCount = 0;
        fetchStart = now;
    }
}

// Run continuous update
console.log("=== Starting Capture ===\n");

async function run() {
    while (true) {
        updateFrame();

    }
}

run()

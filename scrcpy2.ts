import { python } from "jsr:@denosaurs/python";
import { decode, memory } from "./decode.wasm";
import { wait } from "./actorsystem/utils.ts";

const { CaptureManager } = python.runModule(`
import threading
from windows_capture import WindowsCapture, Frame, InternalCaptureControl
import time
import numpy as np
from numba import njit

# Pre-allocate all buffers
frame_buffer = np.empty(8294400, dtype=np.uint8)
encode_buffer = np.empty(8294400, dtype=np.uint8)
string_buffer = bytearray(8294400)  # For string encoding

@njit()
def binary_to_safe_string_preallocated(data, buffer):
    arr = np.frombuffer(data, dtype=np.uint8)
    for i in range(len(arr)):
        buffer[i] = (arr[i] >> 2) + 32
    return buffer[: len(arr)]

def binary_to_string(data):
    encoded_array = binary_to_safe_string_preallocated(data, encode_buffer)
    # Reuse string buffer instead of creating new one each time
    string_buffer[:len(encoded_array)] = encoded_array
    return string_buffer[:len(encoded_array)].decode('ascii')

class CaptureManager:
    def __init__(self):
        self.frames = [(None, None, None), (None, None, None)]
        self.write_idx = 0
        self.read_idx = 1
        self.running = True
        self.frame_count = 0
        self.start_time = time.perf_counter()
        self.latest_frame_ready = threading.Event()
        
        # Pre-allocate frame dimension strings
        self.width_cache = {}
        self.height_cache = {}
        
        print("Starting capture...")
        self.capture = WindowsCapture(
            cursor_capture=None,
            draw_border=None,
            monitor_index=None,
            window_name=None,
        )
        
        #region 
        @self.capture.event
        def on_frame_arrived(frame: Frame, capture_control: InternalCaptureControl):
            if not self.running:
                capture_control.stop()
                return
            
            # Use pre-allocated buffer for frame data
            np.copyto(frame_buffer, frame.frame_buffer)
            if len(frame_buffer) == 0:
                return
                    
            encoded_str = binary_to_string(frame_buffer)
            
            # Cache dimension strings
            width = frame.width
            height = frame.height
            if width not in self.width_cache:
                self.width_cache[width] = str(width)
            if height not in self.height_cache:
                self.height_cache[height] = str(height)

            self.frames[self.write_idx] = (
                self.width_cache[width],
                self.height_cache[height],
                encoded_str
            )
            self.write_idx, self.read_idx = self.read_idx, self.write_idx
            
            self.latest_frame_ready.set()
            
            self.frame_count += 1
            if self.frame_count % 60 == 0:
                elapsed = time.perf_counter() - self.start_time
                print(f"Capture FPS: {self.frame_count / elapsed:5.1f}")
                self.frame_count = 0
                self.start_time = time.perf_counter()
        #endregion
        
        @self.capture.event
        def on_closed():
            print("Capture closed")

        self.capture_thread = threading.Thread(target=self.capture.start)
        self.capture_thread.start()
        
        # Wait just a short time for initialization
        self.latest_frame_ready.wait(timeout=1.0)
        
    def stop(self):
        self.running = False
        self.capture_thread.join()
        
    def get_frame(self):
        frame = self.frames[self.read_idx]
        return frame if frame[0] is not None else ("0", "0", "")
`, "screen_capture.py");

const capture = new CaptureManager();
const FIXED_SIZE = 8294400;
const textEncoder = new TextEncoder();

await wait(5000)

function stringToBinary(str: string): Uint8Array {
    const wasmMemory = new Uint8Array(memory.buffer);
    const encoded = textEncoder.encode(str);
    wasmMemory.set(encoded, 0);
    decode(0, FIXED_SIZE);
    return wasmMemory.subarray(0, FIXED_SIZE);
}

let fetchCount = 0;
let fetchStart = performance.now();

function updateFrame() {
    const [width, height, encodedData] = capture.get_frame();
    const decodedData = stringToBinary(encodedData);

    fetchCount++;
    const now = performance.now();
    const elapsed = (now - fetchStart) / 1000;

    if (elapsed >= 1.0) {
        console.log(`Fetch FPS: ${(fetchCount / elapsed).toFixed(1)}`);
        fetchCount = 0;
        fetchStart = now;
    }
}

console.log("=== Starting Capture ===\n");

async function run() {
    while (true) {
        updateFrame();
    }
}

run();
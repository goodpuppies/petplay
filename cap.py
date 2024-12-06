import threading
from windows_capture import WindowsCapture, Frame, InternalCaptureControl
import queue
import time
import numpy as np

import base64


def binary_to_string(data):
    arr = np.frombuffer(data, dtype=np.uint8)
    encoded = (arr >> 2) + 32
    return encoded.tobytes().decode("ascii")


def string_to_binary(s):
    arr = np.frombuffer(s.encode("ascii"), dtype=np.uint8)

    # Convert back and shift left to expand to 8 bits
    # This maintains the high 6 bits and sets low 2 bits to 0
    expanded = (arr - 32) << 2

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
        self.latest_frame = None
        self.backup_frame = None
        self.latest_frame_ready = threading.Event()
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

            t_start = time.perf_counter()

            raw_data = frame.frame_buffer.tobytes("C")
            t_buffer = time.perf_counter()
            self.stats.record("buffer_copy", t_buffer - t_start)

            if len(raw_data) == 0:
                return

            encoded_str = binary_to_string(raw_data)
            t_encode = time.perf_counter()
            self.stats.record("string_encode", t_encode - t_buffer)

            new_frame = (str(frame.width), str(frame.height), encoded_str)

            if self.latest_frame is not None:
                self.backup_frame = self.latest_frame
            self.latest_frame = new_frame
            self.latest_frame_ready.set()

            t_frame = time.perf_counter()
            self.stats.record("frame_update", t_frame - t_encode)
            self.stats.record("total_capture", t_frame - t_start)

            self.frame_count += 1
            elapsed = time.perf_counter() - self.start_time
            if elapsed >= 1.0:
                self.fps = self.frame_count / elapsed
                print(f"Capture FPS: {self.fps:5.1f}")
                print("Capture Timings:", self.stats.get_stats())
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
                if self.latest_frame and len(self.latest_frame[2]) > 0:
                    self.backup_frame = self.latest_frame
                    break

    def stop(self):
        self.running = False
        self.capture_thread.join()

    def get_frame(self):
        t_start = time.perf_counter()
        if not self.latest_frame_ready.wait(timeout=0.1):
            return self.backup_frame if self.backup_frame else ("0", "0", "")
        frame = self.latest_frame
        self.latest_frame_ready.clear()
        t_end = time.perf_counter()
        self.stats.record("frame_fetch", t_end - t_start)
        return frame

cap = CaptureManager()


cap.get_frame()

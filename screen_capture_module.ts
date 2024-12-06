export interface ScreenCaptureOptions {
  port?: number;
  quality?: number;
  scale?: number;
  targetFps?: number;
}

export interface FrameData {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
  fps: number;
  bandwidth: number;
}

export class ScreenCapture extends EventTarget {
  private server: Deno.HttpServer | null = null;
  private socket: WebSocket | null = null;
  private frameBuffer: ArrayBuffer | null = null;
  private frameWidth = 0;
  private frameHeight = 0;
  private fps = 0;
  private bandwidth = 0;
  private lastFrameTime = 0;
  private bytesReceived = 0;
  private frameCount = 0;
  private lastStatsTime = performance.now();
  private isRunning = false;

  constructor(private options: ScreenCaptureOptions = {}) {
    super();
    this.options = {
      port: options.port ?? 8080,
      quality: options.quality ?? 50,
      scale: options.scale ?? 0.5,
      targetFps: options.targetFps ?? 60
    };
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Start WebSocket server
    this.server = Deno.serve({
      port: this.options.port,
      handler: (req) => {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response(null, { status: 501 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);
        this.socket = socket;

        socket.addEventListener("message", (event) => {
          if (event.data.startsWith("frame:")) {
            try {
              const frameData = event.data.slice(6); // Remove "frame:" prefix
              const separatorIndex = frameData.indexOf('|');
              if (separatorIndex === -1) {
                console.error("Invalid frame data format - no separator found");
                return;
              }

              const metadataStr = frameData.slice(0, separatorIndex);
              const base64Data = frameData.slice(separatorIndex + 1);
              
              const metadata = JSON.parse(metadataStr);

              // Convert base64 to ArrayBuffer
              const binaryString = atob(base64Data);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }

              // Update frame data
              this.frameBuffer = bytes.buffer;
              this.frameWidth = metadata.width;
              this.frameHeight = metadata.height;

              // Update stats
              this.frameCount++;
              this.bytesReceived += event.data.length;
              const now = performance.now();
              if (now - this.lastStatsTime >= 1000) {
                this.fps = this.frameCount;
                this.bandwidth = (this.bytesReceived * 8) / (1024 * 1024); // Mbps
                this.frameCount = 0;
                this.bytesReceived = 0;
                this.lastStatsTime = now;
              }

              // Dispatch frame event
              this.dispatchEvent(new CustomEvent("frame", {
                detail: this.getFrameData()
              }));
            } catch (e) {
              console.error("Error parsing frame data:", e);
            }
          }
        });

        socket.addEventListener("close", () => {
          this.socket = null;
        });

        return response;
      }
    }, { onListen: () => {} }); // Make server non-blocking

    // Start Python capture script
    const pythonCode = `
import sys
from ctypes import *
import asyncio
import websockets
import mss
from PIL import Image
import io
import base64
import json
import time

async def capture_and_stream():
    uri = f"ws://localhost:${this.options.port}"
    print(f"Connecting to {uri}")
    sct = mss.mss()
    monitor = sct.monitors[0]
    
    scale_factor = ${this.options.scale}
    target_fps = ${this.options.targetFps}
    
    scaled_size = (int(monitor["width"] * scale_factor), int(monitor["height"] * scale_factor))
    print(f"Capture size: {scaled_size}")
    
    async with websockets.connect(uri, ping_interval=None, max_size=None) as ws:
        print("Connected to WebSocket server")
        frame_count = 0
        while True:
            try:
                frame_start = time.time()
                
                screenshot = sct.grab(monitor)
                img = Image.frombytes("RGBA", (screenshot.width, screenshot.height), screenshot.raw)
                img = img.resize(scaled_size, Image.Resampling.LANCZOS)
                
                # Convert to raw RGBA bytes
                raw_bytes = img.tobytes()
                
                # Create metadata
                metadata = {
                    "width": scaled_size[0],
                    "height": scaled_size[1],
                    "timestamp": int(time.time() * 1000),
                    "frame": frame_count
                }
                
                metadata_str = json.dumps(metadata, separators=(',', ':'))
                img_base64 = base64.b64encode(raw_bytes).decode("utf-8")
                
                frame_data = f"frame:{metadata_str}|{img_base64}"
                
                if frame_count == 0:
                    print("First frame metadata:", metadata_str)
                
                await ws.send(frame_data)
                frame_count += 1
                
                # Calculate sleep time for target FPS
                process_time = time.time() - frame_start
                sleep_time = max(0.001, (1/target_fps) - process_time)
                await asyncio.sleep(sleep_time)
                
            except Exception as e:
                print(f"Error: {e}")
                import traceback
                traceback.print_exc()
                break

if __name__ == "__main__":
    try:
        asyncio.run(capture_and_stream())
    except KeyboardInterrupt:
        print("\\nExiting...")
`;

    // Create a temporary Python file
    const tempFile = await Deno.makeTempFile({ prefix: "screen_capture_", suffix: ".py" });
    await Deno.writeTextFile(tempFile, pythonCode);
    console.log("Created Python script at:", tempFile);

    // Start Python process
    const command = new Deno.Command("python", {
      args: [tempFile],
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();
    
    // Handle process output
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of process.stdout) {
        //console.log(decoder.decode(chunk));
      }
    })();

    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of process.stderr) {
        console.error(decoder.decode(chunk));
      }
    })();

    // Clean up temp file when process exits
    process.status.then(async () => {
      try {
        await Deno.remove(tempFile);
        console.log("Cleaned up temporary Python script");
      } catch (e) {
        console.error("Error cleaning up:", e);
      }
    });
  }

  async stop() {
    this.isRunning = false;
    this.socket?.close();
    await this.server?.shutdown();
    this.server = null;
  }

  getFrameData(): FrameData | null {
    if (!this.frameBuffer) return null;

    return {
      buffer: this.frameBuffer,
      width: this.frameWidth,
      height: this.frameHeight,
      timestamp: performance.now(),
      fps: this.fps,
      bandwidth: this.bandwidth
    };
  }

  addEventListener(type: "frame", callback: (event: CustomEvent<FrameData>) => void): void;
  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions | undefined): void {
    super.addEventListener(type, callback as EventListener, options);
  }
}

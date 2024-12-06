import { python, kw } from "https://deno.land/x/python/mod.ts";

// Import Python functions
const { capture_screen, start_websocket_client } = python.runModule(`
import mss
from PIL import Image
import io
import base64
import asyncio
import websockets

def capture_screen():
    sct = mss.mss()
    monitor = sct.monitors[0]  # Primary monitor
    screenshot = sct.grab(monitor)
    
    # Convert raw BGRA data to an image
    img = Image.frombytes("RGBA", (screenshot.width, screenshot.height), screenshot.raw)
    
    # Convert to JPEG for smaller size
    buff = io.BytesIO()
    img.save(buff, format="JPEG", quality=70)
    base64_img = base64.b64encode(buff.getvalue()).decode("utf-8")
    
    return {
        "width": screenshot.width,
        "height": screenshot.height,
        "base64": base64_img
    }

async def websocket_handler():
    uri = "ws://localhost:8080/ws"  # Added /ws path and proper ws:// protocol
    print(f"Connecting to {uri}")
    async with websockets.connect(uri, ping_interval=None) as websocket:  # Disable ping/pong
        await websocket.send('python_client')
        while True:
            try:
                msg = await websocket.recv()
                print(f"Python client received frame size: {len(msg)}")
            except websockets.exceptions.ConnectionClosed:
                break

def start_websocket_client():
    asyncio.run(websocket_handler())
`);

// Frame buffer and FPS calculation
const frameBuffer: string[] = [];
const MAX_BUFFER_SIZE = 30;
let lastFrameTime = performance.now();
let fps = 0;

// Active WebSocket connections
const activeConnections = new Set<WebSocket>();

// Calculate FPS
const updateFPS = () => {
  const now = performance.now();
  const deltaTime = now - lastFrameTime;
  fps = 1000 / deltaTime;
  lastFrameTime = now;
  return fps.toFixed(1);
};

// Main capture loop
const startCapture = async () => {
  while (true) {
    if (activeConnections.size > 0) {
      try {
        const result = capture_screen();
        const base64_img = result.base64;
        
        // Update frame buffer
        frameBuffer.push(base64_img);
        if (frameBuffer.length > MAX_BUFFER_SIZE) {
          frameBuffer.shift();
        }
        
        // Calculate and log FPS
        const currentFPS = updateFPS();
        console.log(`Current FPS: ${currentFPS}, Buffer size: ${frameBuffer.length}, Frame size: ${base64_img.length}`);
        
        // Send to all connected clients
        for (const socket of activeConnections) {
          try {
            socket.send(base64_img);
          } catch (err) {
            console.error("Error sending to client:", err);
            activeConnections.delete(socket);
          }
        }
      } catch (error) {
        console.error("Capture error:", error);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000 / 30));
  }
};

// Start the WebSocket server
const server = Deno.serve({
  port: 8080,
  handler: (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    
    socket.addEventListener("open", () => {
      console.log("Client connected!");
      activeConnections.add(socket);
    });

    socket.addEventListener("message", (event) => {
      console.log("Received message:", event.data);
    });

    socket.addEventListener("close", () => {
      console.log("Client disconnected!");
      activeConnections.delete(socket);
    });

    return response;
  }
});

console.log("WebSocket server starting on ws://localhost:8080");

// Start the capture loop
startCapture();

// Start Python client after server is ready
setTimeout(() => {
  console.log("Starting Python WebSocket client...");
  start_websocket_client();
}, 2000);

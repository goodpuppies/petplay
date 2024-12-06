import asyncio
import websockets
import mss
from PIL import Image
import io
import base64
import logging
import numpy as np
import time

# Stats tracking
bytes_sent = 0
last_stats_time = time.time()
frame_count = 0

async def capture_and_stream():
    uri = "ws://localhost:8080"
    print(f"Connecting to {uri}")
    
    # Initialize screen capture
    sct = mss.mss()
    monitor = sct.monitors[0]  # Primary monitor
    
    # Pre-create the RGB image for reuse
    rgb_img = Image.new("RGB", (monitor["width"], monitor["height"]), (255, 255, 255))
    buff = io.BytesIO()
    
    # Reduce quality for better performance
    jpeg_quality = 50  # Lower quality for better speed
    scale_factor = 0.5  # Scale down the image
    
    scaled_size = (int(monitor["width"] * scale_factor), int(monitor["height"] * scale_factor))
    
    global bytes_sent, last_stats_time, frame_count
    
    async with websockets.connect(uri, ping_interval=None, max_size=None) as ws:
        print("Connected! Starting screen capture...")
        
        while True:
            try:
                frame_start = time.time()
                
                # Capture screen
                screenshot = sct.grab(monitor)
                
                # Convert to PIL Image and resize in one step
                img = Image.frombytes("RGBA", (screenshot.width, screenshot.height), screenshot.raw).resize(scaled_size, Image.Resampling.LANCZOS)
                
                # Convert RGBA to RGB (reuse buffer)
                rgb_img.paste(img, mask=img.split()[3])
                
                # Clear buffer and save
                buff.seek(0)
                buff.truncate()
                rgb_img.save(buff, format="JPEG", quality=jpeg_quality, optimize=True)
                
                # Get base64 without creating new strings
                frame_data = buff.getvalue()
                base64_img = base64.b64encode(frame_data).decode("utf-8")
                
                # Update stats
                frame_size = len(frame_data)
                bytes_sent += frame_size
                frame_count += 1
                
                now = time.time()
                if now - last_stats_time >= 1.0:
                    mbps = (bytes_sent * 8) / (1024 * 1024) # Convert to Mbps
                    print(f"FPS: {frame_count}, Bandwidth: {mbps:.2f} Mbps, Frame size: {frame_size/1024:.1f}KB")
                    bytes_sent = 0
                    frame_count = 0
                    last_stats_time = now
                
                # Send frame
                await ws.send(f"frame:{base64_img}")
                
                # Calculate processing time and adjust sleep
                process_time = time.time() - frame_start
                sleep_time = max(0.001, (1/60) - process_time)  # Target 60 FPS
                await asyncio.sleep(sleep_time)
                
            except websockets.exceptions.ConnectionClosed:
                print("Connection closed")
                break
            except Exception as e:
                print(f"Error: {e}")
                break

if __name__ == "__main__":
    try:
        asyncio.run(capture_and_stream())
    except KeyboardInterrupt:
        print("\nExiting...")

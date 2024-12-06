import asyncio
import websockets
import logging

# Enable debug logging
logging.basicConfig(level=logging.DEBUG)

async def test_connection():
    uri = "ws://localhost:8080"
    print(f"Connecting to {uri}")
    
    async with websockets.connect(uri, ping_interval=None) as ws:
        print("Connected!")
        
        # Send a test message
        await ws.send("Hello from Python!")
        
        # Wait for response
        response = await ws.recv()
        print(f"Received: {response}")
        
        # Keep connection alive
        while True:
            try:
                msg = await ws.recv()
                print(f"Received: {msg}")
            except websockets.exceptions.ConnectionClosed:
                print("Connection closed")
                break

if __name__ == "__main__":
    try:
        asyncio.run(test_connection())
    except KeyboardInterrupt:
        print("\nExiting...")

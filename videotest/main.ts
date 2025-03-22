import { ToAddress } from "../submodules/stageforge/src/lib/types.ts";
import { PostMan } from "../submodules/stageforge/src/lib/PostMan.ts";
import { wait } from "../classes/utils.ts";
import { CustomLogger } from "../submodules/stageforge/src/logger/customlogger.ts";
import { Buffer } from "node:buffer";

// Main process state
const state = {
  // Whether the process is running
  running: true,
  
  // Benchmark configuration
  benchmark: {
    enabled: true,           // Whether to run the FPS benchmark
    duration: 10000,         // Duration in milliseconds
    targetFps: 30,           // Target frames per second to attempt
    frameCount: 0,           // Number of frames sent
    startTime: 0,            // Benchmark start time
    endTime: 0,              // Benchmark end time
    actualFps: 0,            // Actually achieved FPS
    totalBytes: 0,           // Total bytes transmitted
    resolution: {            // Frame resolution
      width: 1920,
      height: 1080
    }
  }
} as const;

new PostMan(state, {
  MAIN: () => {
    PostMan.setTopic("muffin")
    // Run the main function
    main();
  },
});

/**
 * Convert a Uint8Array to base64 string using Node.js Buffer API
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use Buffer API to convert in one step
  return Buffer.from(bytes).toString('base64');
}

/**
 * Generate a test frame of the specified dimensions
 */
function generateTestFrame(width: number, height: number): Uint8Array {
  const frameSize = width * height * 4; // RGBA format
  const frameData = new Uint8Array(frameSize);
  
  // Fill with a gradient pattern
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      // Red gradient based on x position
      frameData[index] = Math.floor((x / width) * 255);
      // Green gradient based on y position
      frameData[index + 1] = Math.floor((y / height) * 255);
      // Blue constant
      frameData[index + 2] = 128;
      // Alpha (fully opaque)
      frameData[index + 3] = 255;
    }
  }
  
  return frameData;
}

/**
 * Send a single frame and wait for confirmation
 */
async function sendFrame(videoOverlay: ToAddress, frameData: Uint8Array, width: number, height: number): Promise<number> {
  const frameSize = frameData.length;
  const startTime = performance.now();
  
  // Convert to base64
  const frameDataBase64 = uint8ArrayToBase64(frameData);
  const base64Size = frameDataBase64.length;
  
  // Send the frame
  const result = await PostMan.PostMessage({
    target: videoOverlay,
    type: "SETFRAMEDATA",
    payload: {
      pixelsBase64: frameDataBase64,
      width,
      height
    }
  }, true); // Wait for response
  
  const endTime = performance.now();
  const elapsedMs = endTime - startTime;
  
  // Return the processing time
  return elapsedMs;
}

/**
 * Run the FPS benchmark
 */
async function runFpsBenchmark(videoOverlay: ToAddress): Promise<void> {
  const { width, height } = state.benchmark.resolution;
  const frameSize = width * height * 4;
  
  // Generate a single test frame that we'll reuse
  CustomLogger.log("default", `Generating test frame of size: ${frameSize} bytes (${width}x${height})`);
  const frameData = generateTestFrame(width, height);
  
  // Warm-up: send a single frame to initialize everything
  CustomLogger.log("default", "Sending warm-up frame...");
  await sendFrame(videoOverlay, frameData, width, height);
  
  // Start the benchmark
  CustomLogger.log("default", `Starting FPS benchmark (duration: ${state.benchmark.duration}ms, target: ${state.benchmark.targetFps} FPS)...`);
  state.benchmark.startTime = performance.now();
  state.benchmark.frameCount = 0;
  state.benchmark.totalBytes = 0;
  
  // Calculate frame interval based on target FPS
  const frameInterval = 1000 / state.benchmark.targetFps;
  
  // Loop until benchmark duration is reached
  while (performance.now() - state.benchmark.startTime < state.benchmark.duration) {
    const frameStartTime = performance.now();
    
    // Send the frame and measure time
    const elapsedMs = await sendFrame(videoOverlay, frameData, width, height);
    
    // Update stats
    state.benchmark.frameCount++;
    state.benchmark.totalBytes += frameSize;
    
    // Log progress every 10 frames
    if (state.benchmark.frameCount % 10 === 0) {
      const elapsed = performance.now() - state.benchmark.startTime;
      const currentFps = state.benchmark.frameCount / (elapsed / 1000);
      const mbps = (state.benchmark.totalBytes / (1024 * 1024)) / (elapsed / 1000);
      CustomLogger.log("default", `Progress: ${state.benchmark.frameCount} frames sent (current rate: ${currentFps.toFixed(2)} FPS, ${mbps.toFixed(2)} MB/s)`);
    }
    
    // Wait for next frame if needed (to maintain target FPS)
    const frameEndTime = performance.now();
    const frameTime = frameEndTime - frameStartTime;
    
    if (frameTime < frameInterval) {
      await wait(frameInterval - frameTime);
    }
  }
  
  // Calculate final stats
  state.benchmark.endTime = performance.now();
  const totalTime = (state.benchmark.endTime - state.benchmark.startTime) / 1000; // in seconds
  state.benchmark.actualFps = state.benchmark.frameCount / totalTime;
  
  // Log final results
  CustomLogger.log("default", `\nFPS Benchmark Results:`);
  CustomLogger.log("default", `---------------------`);
  CustomLogger.log("default", `Total frames sent: ${state.benchmark.frameCount}`);
  CustomLogger.log("default", `Total time: ${totalTime.toFixed(2)} seconds`);
  CustomLogger.log("default", `Frame resolution: ${width}x${height} (${frameSize} bytes per frame)`);
  CustomLogger.log("default", `Actual FPS: ${state.benchmark.actualFps.toFixed(2)}`);
  CustomLogger.log("default", `Data throughput: ${((state.benchmark.totalBytes / (1024 * 1024)) / totalTime).toFixed(2)} MB/s`);
  CustomLogger.log("default", `Average frame time: ${(totalTime * 1000 / state.benchmark.frameCount).toFixed(2)} ms`);
}

// Main function that runs when the actor starts
async function main() {
  CustomLogger.log("default", "Main actor started");

  // Create the video overlay actor
  const videoOverlay = await PostMan.create("./videoOverlay.ts");
  CustomLogger.log("default", `Created video overlay actor: ${videoOverlay}`);
  
  // Wait for overlay to initialize
  await wait(5000);
  
  if (state.benchmark.enabled) {
    // Run the FPS benchmark
    await runFpsBenchmark(videoOverlay);
  } else {
    // Generate a large test frame (1080p resolution = 1920x1080 pixels, 4 bytes per pixel RGBA)
    const width = 1920;
    const height = 1080;
    const frameSize = width * height * 4;
    
    CustomLogger.log("default", `Generating test frame of size: ${frameSize} bytes (${width}x${height})`);
    
    // Create a test frame with a pattern
    const frameData = generateTestFrame(width, height);
    
    // Convert the frame data to base64 to reduce JSON serialization size
    CustomLogger.log("default", "Converting frame data to base64...");
    const frameDataBase64 = uint8ArrayToBase64(frameData);
    const base64Size = frameDataBase64.length;
    
    // Send the frame to the video overlay
    CustomLogger.log("default", `Sending frame to video overlay (original: ${frameSize} bytes, base64: ${base64Size} bytes, ratio: ${(base64Size / frameSize).toFixed(2)}x)...`);
    
    const startTime = performance.now();
    
    // Send the frame data as base64
    const result = await PostMan.PostMessage({
      target: videoOverlay,
      type: "SETFRAMEDATA",
      payload: {
        pixelsBase64: frameDataBase64,
        width,
        height
      }
    }, true); // Wait for response
    
    const endTime = performance.now();
    CustomLogger.log("default", `Frame sent successfully in ${endTime - startTime}ms`);
    
    // Log the result
    if (result && result.frameStats) {
      CustomLogger.log("default", `Frame statistics: ${JSON.stringify(result.frameStats, null, 2)}`);
    }
  }
  
  CustomLogger.log("default", "Video frame test completed successfully!");
}



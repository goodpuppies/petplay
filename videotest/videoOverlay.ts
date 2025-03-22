import { PostMan } from "../submodules/stageforge/src/lib/PostMan.ts";
import { CustomLogger } from "../submodules/stageforge/src/logger/customlogger.ts";
import { Buffer } from "node:buffer";

// Simplified state for video frame testing
const state = {
    id: "",
    name: "videooverlay",
    isRunning: false,
    stats: {
        receivedFrames: 0,
        totalBytes: 0,
        lastFrameSize: 0,
        lastFrameWidth: 0,
        lastFrameHeight: 0,
        lastFrameTime: 0,
        lastBase64Size: 0,
        compressionRatio: 0,
        
        // Performance metrics
        processingTimes: [] as number[],
        avgProcessingTime: 0,
        minProcessingTime: Infinity,
        maxProcessingTime: 0,
        
        // Benchmark mode
        benchmarkMode: false,
        benchmarkStartTime: 0
    }
};

/**
 * Convert a base64 string to Uint8Array using Node.js Buffer API
 */
function base64ToUint8Array(base64: string): Uint8Array {
    try {
        // Use Buffer API to convert in one step
        return Buffer.from(base64, 'base64');
    } catch (error) {
        CustomLogger.log("actor", `Error decoding base64: ${error.message}`);
        throw new Error(`Failed to decode base64: ${error.message}`);
    }
}

/**
 * Update performance statistics
 */
function updateStats(processingTime: number): void {
    // Add to processing times array (up to 100 entries)
    state.stats.processingTimes.push(processingTime);
    if (state.stats.processingTimes.length > 100) {
        state.stats.processingTimes.shift();
    }
    
    // Update min/max processing times
    state.stats.minProcessingTime = Math.min(state.stats.minProcessingTime, processingTime);
    state.stats.maxProcessingTime = Math.max(state.stats.maxProcessingTime, processingTime);
    
    // Calculate average processing time
    const sum = state.stats.processingTimes.reduce((acc, time) => acc + time, 0);
    state.stats.avgProcessingTime = sum / state.stats.processingTimes.length;
}

// Initialize PostMan with message handlers
new PostMan(state, {
    CUSTOMINIT: () => {
        PostMan.setTopic("muffin")
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void) => {
        return state.id;
    },
    STARTOVERLAY: (payload: { name: string, sync: boolean }) => {
        main(payload.name, payload.sync);
    },
    STOP: (_payload: void) => {
        state.isRunning = false;
        CustomLogger.log("actor", `Video overlay ${state.id} stopped`);
    },
    SETFRAMEDATA: (payload: { pixelsBase64: string, width: number, height: number }) => {

        // Measure processing time
        const startTime = performance.now();
        
        // Get base64 size
        const base64Size = payload.pixelsBase64.length;
        CustomLogger.log("actor", `Received base64 data of size: ${base64Size} bytes`);
        
        try {
            // Decode base64 data using our chunked method
            const pixels = base64ToUint8Array(payload.pixelsBase64);
            
            // Calculate frame statistics
            const frameSize = pixels.length;
            const compressionRatio = base64Size / frameSize;
            
            // Log frame information
            CustomLogger.log("actor", `Decoded frame: ${frameSize} bytes (base64: ${base64Size} bytes, ratio: ${compressionRatio.toFixed(2)}x), ${payload.width}x${payload.height}`);
            
            // Verify frame data integrity
            const isValid = verifyFrameData(pixels, payload.width, payload.height);
            
            // Update stats
            state.stats.receivedFrames++;
            state.stats.lastFrameSize = frameSize;
            state.stats.totalBytes += frameSize;
            state.stats.lastFrameWidth = payload.width;
            state.stats.lastFrameHeight = payload.height;
            state.stats.lastBase64Size = base64Size;
            state.stats.compressionRatio = compressionRatio;
            
            // Calculate processing time
            const endTime = performance.now();
            const processingTime = endTime - startTime;
            state.stats.lastFrameTime = processingTime;
            
            // Update performance stats
            updateStats(processingTime);
            
            // Return stats to confirm receipt
            return {
                status: "success",
                frameStats: {
                    receivedFrames: state.stats.receivedFrames,
                    totalBytes: state.stats.totalBytes,
                    lastFrameSize: state.stats.lastFrameSize,
                    lastFrameWidth: state.stats.lastFrameWidth,
                    lastFrameHeight: state.stats.lastFrameHeight,
                    lastFrameTime: state.stats.lastFrameTime,
                    lastBase64Size: state.stats.lastBase64Size,
                    compressionRatio: state.stats.compressionRatio,
                    avgProcessingTime: state.stats.avgProcessingTime,
                    minProcessingTime: state.stats.minProcessingTime,
                    maxProcessingTime: state.stats.maxProcessingTime
                },
                isValid: isValid
            };
        } catch (error) {
            CustomLogger.log("actor", `Error processing frame: ${error.message}`);
            throw error;
        }
    },
    GET_FRAME_STATS: (_payload: void) => {
        return {
            receivedFrames: state.stats.receivedFrames,
            totalBytes: state.stats.totalBytes,
            lastFrameSize: state.stats.lastFrameSize,
            lastFrameWidth: state.stats.lastFrameWidth,
            lastFrameHeight: state.stats.lastFrameHeight,
            lastFrameTime: state.stats.lastFrameTime,
            lastBase64Size: state.stats.lastBase64Size,
            compressionRatio: state.stats.compressionRatio,
            avgProcessingTime: state.stats.avgProcessingTime,
            minProcessingTime: state.stats.minProcessingTime,
            maxProcessingTime: state.stats.maxProcessingTime
        };
    }
} as const);

/**
 * Verify that the frame data is valid
 * This checks that the data length matches the expected dimensions
 * and that the data contains valid pixel values
 */
function verifyFrameData(pixels: Uint8Array, width: number, height: number): boolean {
    // Check if data length matches expected dimensions (RGBA format)
    const expectedSize = width * height * 4;
    if (pixels.length !== expectedSize) {
        CustomLogger.log("actor", `Frame data size mismatch: got ${pixels.length}, expected ${expectedSize}`);
        throw new Error(`Frame data size mismatch: got ${pixels.length}, expected ${expectedSize}`);
    }
    
    // Check a sample of pixels to ensure data isn't corrupted
    // Just check a few pixels at different positions
    const checkPoints = [
        0, // First pixel
        width * 4, // Start of second row
        (height - 1) * width * 4, // Start of last row
        (width * height * 4) - 4 // Last pixel
    ];
    
    for (const offset of checkPoints) {
        // Check if any component is outside valid range (0-255)
        // This shouldn't happen with Uint8Array but checking for data corruption
        for (let i = 0; i < 4; i++) {
            const value = pixels[offset + i];
            if (value === undefined) {
                CustomLogger.log("actor", `Invalid pixel data at offset ${offset + i}`);
                throw new Error(`Invalid pixel data at offset ${offset + i}`);
            }
        }
    }
    
    // Calculate a simple checksum of the first row
    let checksum = 0;
    for (let i = 0; i < width * 4; i++) {
        checksum += pixels[i];
    }
    
    CustomLogger.log("actor", `Frame verification passed. First row checksum: ${checksum}`);
    return true;
}

/**
 * Main function to initialize the video overlay
 */
async function main(overlayName: string, sync: boolean) {
    CustomLogger.log("actor", `Starting video overlay: ${overlayName}, sync: ${sync}`);
    
    // Reset frame statistics
    state.stats = {
        receivedFrames: 0,
        totalBytes: 0,
        lastFrameSize: 0,
        lastFrameWidth: 0,
        lastFrameHeight: 0,
        lastFrameTime: 0,
        lastBase64Size: 0,
        compressionRatio: 0,
        processingTimes: [] as number[],
        avgProcessingTime: 0,
        minProcessingTime: Infinity,
        maxProcessingTime: 0,
        benchmarkMode: false,
        benchmarkStartTime: 0
    };
    
    // Mark as running
    state.isRunning = true;
    
    CustomLogger.log("actor", `Video overlay ${state.id} started and ready to receive frames`);
}

// Handle cleanup on exit
globalThis.addEventListener("unload", () => {
    CustomLogger.log("actor", `Video overlay ${state.id} unloaded`);
});

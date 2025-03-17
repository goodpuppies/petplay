import { PostMan, wait } from "../stageforge/mod.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { OpenVRTransform } from "../classes/openvrTransform.ts";

const state = {
    id: "",
    name: "vrcoverlay",
    sync: false,
    overlayClass: null as OpenVR.IVROverlay | null,
    overlayHandle: 0n,
    overlayTransform: null as OpenVRTransform | null,
    vrSystem: null as OpenVR.IVRSystem | null,
    isRunning: false,
    screenCapturer: null as ScreenCapturer | null,
    glManager: null as OpenGLManager | null,
    textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null,
    frameBuffer: {
        chunks: new Map<number, Uint8Array>(),
        width: 0,
        height: 0,
        totalChunks: 0,
        timestamp: 0,
        expectedTotalSize: 0
    }
};
type SerializedBigInt = { __bigint__: string };

new PostMan(state, {
    CUSTOMINIT: (_payload: void) => {
        PostMan.setTopic("muffin")
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void) => {
        return state.id;
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean }) => {
        main(payload.name, payload.texture, payload.sync);
    },
    GETOVERLAYLOCATION: (_payload: void) => {
        if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
        return state.overlayTransform.getTransformAbsolute();
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
        if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
        state.overlayTransform.setTransformAbsolute(payload);
    },
    INITOPENVR: (payload: bigint | SerializedBigInt) => {
        let ptrn: bigint;

        // Handle serialized BigInt coming from the network
        if (typeof payload === 'object' && payload !== null && '__bigint__' in payload) {
            ptrn = BigInt(payload.__bigint__);
        } else {
            ptrn = payload as bigint;
        }
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    STOP: async (_payload: void) => {
        state.isRunning = false;
        if (state.screenCapturer) {
            await state.screenCapturer.dispose();
            state.screenCapturer = null;
        }
    },
    SETFRAMEDATA: (payload: { pixels: Uint8Array, width: number, height: number }) => {

        if (!state.isRunning) return
        if (!state.textureStructPtr) throw new Error("no tex struct")
        if (!state.overlayClass) throw new Error("no overlay struct")

        createTextureFromScreenshot(payload.pixels, payload.width, payload.height);

        if (state.textureStructPtr && state.overlayClass) {
            const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, state.textureStructPtr);
            if (error !== OpenVR.OverlayError.VROverlayError_None) {
                console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
            }
        }
        else {

            console.log(state.overlayClass)
        }
    },
    FRAME_CHUNK: (payload: { 
        chunkIndex: number, 
        totalChunks: number, 
        chunkData: unknown, 
        width: number,
        height: number,
        timestamp: number,
        totalSize: number 
    }) => {
        // Convert to Uint8Array if it's not already
        let chunkData: Uint8Array;
        
        if (payload.chunkData instanceof Uint8Array) {
            chunkData = payload.chunkData;
        } else if (typeof payload.chunkData === 'object' && payload.chunkData !== null) {
            // Handle the case where it might be an object with __uint8array__ property
            const obj = payload.chunkData as any;
            if (obj.__uint8array__) {
                // If it has array data, convert it back to Uint8Array
                chunkData = new Uint8Array(obj.__uint8array__);
            } else if (obj.__uint8array_ref__) {
                // If it just has a size reference, create an empty array of that size
                console.error(`Received reference instead of actual data: size ${obj.__uint8array_ref__}`);
                // Return early as we can't process this properly
                return;
            } else {
                console.error(`Unknown chunk data format:`, obj);
                return;
            }
        } else {
            console.error(`Invalid chunk data type: ${typeof payload.chunkData}`);
            return;
        }
        
        console.log(`Received chunk ${payload.chunkIndex + 1}/${payload.totalChunks}, size: ${chunkData.length} bytes`);
        
        // Store the chunk in our buffer
        state.frameBuffer.chunks.set(payload.chunkIndex, chunkData);
        
        // Update metadata if this is the first chunk
        if (payload.chunkIndex === 0) {
            state.frameBuffer.width = payload.width;
            state.frameBuffer.height = payload.height;
            state.frameBuffer.totalChunks = payload.totalChunks;
            state.frameBuffer.timestamp = payload.timestamp;
            state.frameBuffer.expectedTotalSize = payload.totalSize;
            console.log(`Frame info: ${payload.width}x${payload.height}, ${payload.totalChunks} chunks, total size: ${payload.totalSize} bytes`);
        }
        
        // Check if we've received all chunks
        if (state.frameBuffer.chunks.size === state.frameBuffer.totalChunks) {
            try {
                console.log(`All ${state.frameBuffer.totalChunks} chunks received, reassembling...`);
                
                // Combine all chunks
                const totalSize = state.frameBuffer.expectedTotalSize;
                
                // Create a buffer of the exact expected size
                const completeData = new Uint8Array(totalSize);
                let offset = 0;
                
                // Combine chunks in order
                for (let i = 0; i < state.frameBuffer.totalChunks; i++) {
                    const chunk = state.frameBuffer.chunks.get(i);
                    if (!chunk) {
                        console.error(`Missing chunk ${i} of ${state.frameBuffer.totalChunks}`);
                        // Clear the frame buffer and abort
                        state.frameBuffer.chunks.clear();
                        return;
                    }
                    
                    // Ensure we don't exceed the buffer size
                    if (offset + chunk.length > totalSize) {
                        console.error(`Chunk would exceed buffer size: offset=${offset}, chunk.length=${chunk.length}, totalSize=${totalSize}`);
                        // Clear the frame buffer and abort
                        state.frameBuffer.chunks.clear();
                        return;
                    }
                    
                    // Log chunk info for debugging
                    console.log(`Setting chunk ${i}: offset=${offset}, length=${chunk.length}`);
                    
                    completeData.set(chunk, offset);
                    offset += chunk.length;
                }
                
                // Verify we've filled the buffer completely
                if (offset !== totalSize) {
                    console.error(`Buffer not completely filled: ${offset} of ${totalSize} bytes`);
                    // Continue anyway, but log the error
                }
                
                // Process the complete frame
                if (!state.isRunning) return;
                if (!state.textureStructPtr) throw new Error("no tex struct");
                if (!state.overlayClass) throw new Error("no overlay struct");
                
                // Validate dimensions
                const expectedPixelCount = state.frameBuffer.width * state.frameBuffer.height * 4;
                if (completeData.length !== expectedPixelCount) {
                    console.error(`Data size mismatch: got ${completeData.length} bytes, expected ${expectedPixelCount} bytes for ${state.frameBuffer.width}x${state.frameBuffer.height} image`);
                    // Clear the frame buffer and abort
                    state.frameBuffer.chunks.clear();
                    return;
                }
                
                console.log(`Frame reassembled successfully: ${completeData.length} bytes`);
                
                createTextureFromScreenshot(
                    completeData, 
                    state.frameBuffer.width, 
                    state.frameBuffer.height
                );
                
                if (state.textureStructPtr && state.overlayClass) {
                    const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, state.textureStructPtr);
                    if (error !== OpenVR.OverlayError.VROverlayError_None) {
                        console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
                    }
                }
            } catch (error) {
                console.error("Error processing frame chunks:", error);
            } finally {
                // Clear the frame buffer for the next frame
                state.frameBuffer.chunks.clear();
            }
        }
    },
} as const);

//#region init 
function INITSCREENCAP(): ScreenCapturer {
    const capturer = new ScreenCapturer({
        debug: false,
        onStats: ({ fps, avgLatency }) => {
            CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
        }
    });
    return capturer;
}

function INITGL(name?: string) {
    state.glManager = new OpenGLManager();
    state.glManager.initialize(name);
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    if (!state.glManager) { throw new Error("glManager is null"); }
    state.glManager.createTextureFromScreenshot(pixels, width, height);
}
//#endregion

//#region screencapture
async function DeskCapLoop(capturer: ScreenCapturer, overlay: OpenVR.IVROverlay, textureStructPtr: Deno.PointerValue<OpenVR.Texture>) {
    while (state.isRunning) {
        const frame = await capturer.getLatestFrame();
        if (frame) {
            createTextureFromScreenshot(frame.data, frame.width, frame.height);
            // Set overlay texture
            const error = overlay.SetOverlayTexture(state.overlayHandle, textureStructPtr);
            if (error !== OpenVR.OverlayError.VROverlayError_None) {
                console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
            }

            // Send frame data to all sub actors in the address book
            if (PostMan.state.addressBook && PostMan.state.addressBook.size > 0) {
                // Send to all actors in the address book
                for (const actorId of PostMan.state.addressBook) {
                    // Skip sending to self
                    if (actorId === state.id) continue;

                    // Use direct binary transfer for frame data
                    /* 
                    * Notes on chunk size optimization:
                    * - Raw binary data expands when serialized to JSON (each byte becomes a number in an array)
                    * - Testing shows approximately 4-5x size increase after serialization
                    * - IrohWorker has a 65KB message size limit (we saw from the code)
                    * - Therefore: 15KB raw data → ~60-65KB after serialization, which is our maximum safe size
                    */
                    const CHUNK_SIZE = 15000; // Optimized to stay under 65KB after JSON serialization
                    const totalSize = frame.data.length;
                    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
                    const timestamp = Date.now();
                    
                    // Function to measure serialized size of a payload
                    function measureSerializedSize(obj: any): number {
                        // Simple serialization similar to what IrohWorker does
                        const jsonString = JSON.stringify(obj, (_, v) => {
                            if (v instanceof Uint8Array) {
                                return { __uint8array__: Array.from(v) };
                            }
                            return v;
                        });
                        return new TextEncoder().encode(jsonString).length;
                    }
                    
                    // Log frame info for debugging
                    console.log(`Sending frame: ${frame.width}x${frame.height}, ${totalSize} bytes, ${totalChunks} chunks`);
                    
                    // If we need to debug serialization sizes again, uncomment this block
                    /*
                    if (totalChunks < 10) { // Only test on smaller frames to avoid spam
                        console.log("Testing serialization sizes:");
                        for (let testSize = 8000; testSize <= 40000; testSize += 8000) {
                            const testChunk = frame.data.slice(0, testSize);
                            const testPayload = {
                                chunkIndex: 0,
                                totalChunks: 1,
                                chunkData: { __uint8array__: Array.from(testChunk) },
                                width: frame.width,
                                height: frame.height,
                                timestamp: timestamp,
                                totalSize: totalSize
                            };
                            const rawSize = testSize;
                            const serializedSize = measureSerializedSize(testPayload);
                            const ratio = serializedSize / rawSize;
                            console.log(`  Chunk size: ${rawSize} bytes → Serialized: ${serializedSize} bytes (${ratio.toFixed(2)}x)`);
                        }
                    }
                    */
                    
                    // If the frame is small enough, send it directly
                    if (totalSize < 50000) { // Increased threshold for direct sending
                        // Make a copy of the frame data to avoid issues with shared references
                        const pixelsCopy = new Uint8Array(frame.data);
                        PostMan.PostMessage({
                            target: actorId,
                            type: "SETFRAMEDATA",
                            payload: {
                                pixels: pixelsCopy,
                                width: frame.width,
                                height: frame.height
                            }
                        });
                    } else {
                        // Otherwise, send it in chunks
                        for (let i = 0; i < totalChunks; i++) {
                            const start = i * CHUNK_SIZE;
                            const end = Math.min(start + CHUNK_SIZE, totalSize);
                            // Create a copy of the chunk data
                            const chunkData = new Uint8Array(frame.data.slice(start, end));
                            
                            // Log chunk info for debugging
                            console.log(`Sending chunk ${i+1}/${totalChunks}: ${chunkData.length} bytes (${start}-${end})`);
                            
                            // Force array conversion for safer transmission
                            const chunkDataArray = Array.from(chunkData);
                            
                            PostMan.PostMessage({
                                target: actorId,
                                type: "FRAME_CHUNK",
                                payload: {
                                    chunkIndex: i,
                                    totalChunks: totalChunks,
                                    // Send as array instead of Uint8Array
                                    chunkData: { __uint8array__: chunkDataArray },
                                    width: frame.width,
                                    height: frame.height,
                                    timestamp: timestamp,
                                    totalSize: totalSize // Add total size for validation
                                }
                            });
                            
                            // Add a small delay between chunks to avoid overwhelming the network
                            if (totalChunks > 1 && i < totalChunks - 1) {
                                await wait(10); // Reduced delay since we're sending fewer chunks
                            }
                        }
                    }
                }
            }
        }
        // Wait frame sync
        overlay.WaitFrameSync(100);
        await wait(50)
    }
}
//#endregion

function main(overlayname: string, overlaytexture: string, sync: boolean) {
    try {
        state.sync = sync;

        INITGL(overlayname);

        //#region create overlay
        CustomLogger.log("overlay", "Creating overlay...");
        const overlay = state.overlayClass as OpenVR.IVROverlay;
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
        }
        if (overlayHandlePTR === null) throw new Error("Invalid pointer");
        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        state.overlayTransform = new OpenVRTransform(overlay, overlayHandle);
        CustomLogger.log("overlay", `Overlay created with handle: ${overlayHandle}`);

        // Set size to 0.7 meters wide
        overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

        // bounds
        const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
        const boundsBuf = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
        OpenVR.TextureBoundsStruct.write(bounds, new DataView(boundsBuf));
        const boundsPtr = Deno.UnsafePointer.of(boundsBuf) as Deno.PointerValue<OpenVR.TextureBounds>;
        overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);

        // Position it in front of the user (static position)
        // If sync is false, offset it to the side by 1 meter
        const initialTransform: OpenVR.HmdMatrix34 = {
            m: [
                [1.0, 0.0, 0.0, sync ? 0.0 : 1.0], // Offset 1 meter to the right if not sync
                [0.0, 1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0, -2.5]
            ]
        };
        if (state.overlayTransform) {
            state.overlayTransform.setTransformAbsolute(initialTransform);
        }

        overlay.ShowOverlay(overlayHandle);
        CustomLogger.log("overlay", "Overlay initialized and shown");
        //#endregion

        // Setup OpenVR texture struct
        if (!state.glManager) { throw new Error("glManager is null"); }
        const texture = state.glManager.getTexture();
        if (!texture) { throw new Error("texture is null"); }

        const textureData = {
            handle: BigInt(texture[0]),
            eType: OpenVR.TextureType.TextureType_OpenGL,
            eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
        };

        const textureStructBuffer = new ArrayBuffer(OpenVR.TextureStruct.byteSize);
        OpenVR.TextureStruct.write(textureData, new DataView(textureStructBuffer));
        const textureStructPtr = Deno.UnsafePointer.of(textureStructBuffer) as Deno.PointerValue<OpenVR.Texture>;
        state.textureStructPtr = textureStructPtr;

        state.isRunning = true;
        console.log("isRunning", PostMan.state.id, state.isRunning)

        // Only start screen capture if sync is true
        if (sync) {
            // Initialize screen capture
            state.screenCapturer = INITSCREENCAP();
            CustomLogger.log("overlay", "Screen capture initialized");

            // Start the desktop capture loop
            DeskCapLoop(state.screenCapturer, overlay, textureStructPtr);
        } else {
            CustomLogger.log("overlay", "Running in sub mode, waiting for frame data");
        }
    } catch (error) {
        CustomLogger.error("overlay", "Error in main:", error);
        if (error instanceof Error) {
            CustomLogger.error("overlay", "Stack:", error.stack);
        }
    }
}

async function cleanup() {
    state.isRunning = false;
    if (state.screenCapturer) {
        await state.screenCapturer.dispose();
        state.screenCapturer = null;
    }
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

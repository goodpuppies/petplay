import { PostMan, actorState } from "../../submodules/stageforge/mod.ts";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel"
import { ScreenCapturer } from "../../classes/ScreenCapturer/scclass.ts";
import { OpenGLManager } from "../../classes/openglManager.ts";
import { setOverlayTransformAbsolute, getOverlayTransformAbsolute} from "../../classes/openvrTransform.ts";
import { Buffer } from "node:buffer";
import { wait } from "../../classes/utils.ts";

function setTransform(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}

function getTransform() {
    if (!state.overlayClass || !state.overlayHandle) return;
    getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
}


const state = actorState({
    id: "",
    name: "videoOverlay",
    sync: false,
    overlayClass: null as OpenVR.IVROverlay | null,
    overlayHandle: 0n,
    vrSystem: null as OpenVR.IVRSystem | null,
    isRunning: false,
    screenCapturer: null as ScreenCapturer | null,
    glManager: null as OpenGLManager | null,
    textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null,
});
type SerializedBigInt = { __bigint__: string };

new PostMan(state, {
    __INIT__: (_payload: void) => {
        PostMan.setTopic("muffin")
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, frames?: number }) => {
        main(payload.name, payload.sync, payload.frames);
    },
    GETOVERLAYLOCATION: (_payload: void) => {
        return getTransform()
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
        setTransform(payload);
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
        LogChannel.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    STOP: async (_payload: void) => {
        state.isRunning = false;
        if (state.screenCapturer) {
            await state.screenCapturer.dispose();
            state.screenCapturer = null;
        }
    },
    SETFRAMEDATA: (payload: { pixels: string | number[], encoding?: string, width: number, height: number }) => {
        //console.log("got frame");
        if (!state.isRunning) return;
        if (!state.textureStructPtr) throw new Error("no tex struct");
        if (!state.overlayClass) throw new Error("no overlay struct");

        if (!payload.pixels) {
            throw new Error("pixels undefined");
        }

        try {
            let pixelsArray: Uint8Array;

            if (payload.encoding === "base64") {
                // Decode base64 string back to Uint8Array using Node's Buffer
                const buffer = Buffer.from(payload.pixels as string, 'base64');
                // Create a new Uint8Array from the Buffer data to ensure compatibility
                pixelsArray = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
                //console.log(`Decoded base64 data, size: ${pixelsArray.length} bytes`);
            } else {
                // Handle regular array
                pixelsArray = new Uint8Array(payload.pixels as number[]);
            }

            createTextureFromScreenshot(pixelsArray, payload.width, payload.height);
            

            const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, state.textureStructPtr);
            pixelsArray = null as any
            if (error !== OpenVR.OverlayError.VROverlayError_None) {
                console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
            }
        } catch (e) {
            console.error("Error processing pixel data:", e);
            if (e instanceof Error) {
                console.error("Stack:", e.stack);
            }
            throw e;
        }
    },
} as const);

//#region init 
function INITSCREENCAP(): ScreenCapturer {
    const capturer = new ScreenCapturer({
        debug: false,
        onStats: ({ fps, avgLatency }) => {
            LogChannel.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
        },
        executablePath: "../../resources/screen-streamer"
    });
    return capturer;
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    if (!state.glManager) { throw new Error("glManager is null"); }
    state.glManager.createTextureFromData(pixels, width, height);
}

//#endregion


const DOWNSCALE_RATIO = 1.0;


async function DeskCapLoop(capturer: ScreenCapturer, overlay: OpenVR.IVROverlay,
    textureStructPtr: Deno.PointerValue<OpenVR.Texture>, framesToSend: number = 1) {

    let frameCount = 0;
    const continuousMode = framesToSend === 0;

    if (continuousMode) {
        LogChannel.log("overlay", "Starting DeskCapLoop in continuous streaming mode");
    } else {
        LogChannel.log("overlay", `Starting DeskCapLoop, will capture ${framesToSend} frames`);
    }

    // Process frames until we've sent the requested number or indefinitely if framesToSend is 0
    while (state.isRunning && (continuousMode || frameCount < framesToSend)) {
        if (continuousMode) {
            //LogChannel.log("overlay", `Waiting for frame in continuous mode (frame #${frameCount + 1})...`);
        } else {
            LogChannel.log("overlay", `Waiting for frame ${frameCount + 1}/${framesToSend}...`);
        }

        const frame = await capturer.getLatestFrame();

        if (!frame) {
            LogChannel.log("overlay", "No frame received from capturer");
            await wait(100);
            continue;
        }

        frameCount++;
        //LogChannel.log("overlay", `Received frame ${frameCount}: ${frame.width}x${frame.height}, size: ${frame.data.length} bytes`);

        createTextureFromScreenshot(frame.data, frame.width, frame.height);
        //LogChannel.log("overlay", "Texture created from screenshot");

        // Set overlay texture
        const error = overlay.SetOverlayTexture(state.overlayHandle, textureStructPtr);
        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            LogChannel.error("overlay", `SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
        }

        if (state.addressBook && state.addressBook.size > 0) {
            //LogChannel.log("overlay", `Found ${PostMan.state.addressBook.size} actors in address book`);
            let sentCount = 0;

            for (const actorId of state.addressBook) {
                if (actorId === state.id) continue;
                sentCount++;

                // Scale down the frame to reduce data size based on DOWNSCALE_RATIO
                const scaleFactor = DOWNSCALE_RATIO;  // Use the global constant
                const scaledWidth = Math.floor(frame.width * scaleFactor);
                const scaledHeight = Math.floor(frame.height * scaleFactor);

                //LogChannel.log("overlay", `Scaling frame from ${frame.width}x${frame.height} to ${scaledWidth}x${scaledHeight} (ratio: ${DOWNSCALE_RATIO})`);

                // Skip scaling if ratio is 1.0 (full resolution)
                let pixelsToSend: Uint8Array;
                if (scaleFactor === 1.0) {
                    // Use original frame data directly
                    pixelsToSend = new Uint8Array(frame.data);
                } else {
                    // Create a scaled down version to reduce data size
                    const scaledData = new Uint8Array(scaledWidth * scaledHeight * 4);
                    for (let y = 0; y < scaledHeight; y++) {
                        for (let x = 0; x < scaledWidth; x++) {
                            const srcX = Math.floor(x / scaleFactor);
                            const srcY = Math.floor(y / scaleFactor);

                            const srcPos = (srcY * frame.width + srcX) * 4;
                            const destPos = (y * scaledWidth + x) * 4;

                            scaledData[destPos] = frame.data[srcPos];
                            scaledData[destPos + 1] = frame.data[srcPos + 1];
                            scaledData[destPos + 2] = frame.data[srcPos + 2];
                            scaledData[destPos + 3] = frame.data[srcPos + 3];
                        }
                    }
                    pixelsToSend = scaledData;
                }

                // Convert to base64 using Node's Buffer
                const base64Data = Buffer.from(pixelsToSend).toString('base64');

                const frameMsg = continuousMode ? `streaming frame #${frameCount}` : `frame ${frameCount}/${framesToSend}`;
                const scalingInfo = scaleFactor === 1.0 ? "full resolution" : `${DOWNSCALE_RATIO * 100}% scale`;
                //LogChannel.log("overlay", `Sending ${frameMsg} to actor ${actorId} (${scalingInfo}, base64 size: ${base64Data.length} bytes)`);

                PostMan.PostMessage({
                    target: actorId,
                    type: "SETFRAMEDATA",
                    payload: {
                        pixels: base64Data,
                        encoding: "base64",
                        width: scaledWidth,
                        height: scaledHeight
                    }
                });
                pixelsToSend = null as any;

            }

            //LogChannel.log("overlay", `Sent frame to ${sentCount} actors`);
        } else {
            LogChannel.log("overlay", "No actors in address book to send frames to");
        }

        overlay.WaitFrameSync(100);
        //LogChannel.log("overlay", "Frame sync completed");

        // Add a small delay between frames to avoid overloading the system
        if (continuousMode || frameCount < framesToSend) {
            const delayTime = continuousMode ? 50 : 100; // Shorter delay in continuous mode for smoother streaming
            await wait(delayTime);
        }
    }

    // Only reached if not in continuous mode or if state.isRunning becomes false
    if (!continuousMode) {
        // Keep the overlay active but don't continue capturing frames
        state.isRunning = false;
        LogChannel.log("overlay", "Setting isRunning to false");

        if (state.screenCapturer) {
            LogChannel.log("overlay", "Disposing screen capturer");
            await state.screenCapturer.dispose();
            state.screenCapturer = null;
        }

        LogChannel.log("overlay", `DeskCapLoop complete - sent ${frameCount} frames - screen capture stopped`);
    } else {
        LogChannel.log("overlay", `Continuous streaming mode ended after ${frameCount} frames`);
    }
}

function INITGL(name?: string) {
    state.glManager = new OpenGLManager();
    state.glManager.initialize2D(name);
    if (!state.glManager) { throw new Error("glManager is null"); }
}

function main(overlayname: string, sync: boolean, frames: number = 15) {
    try {
        state.sync = sync;
        state.isRunning = true;

        INITGL(overlayname);


        LogChannel.log("overlay", "Creating overlay...");
        const overlay = state.overlayClass as OpenVR.IVROverlay;
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
        }
        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        LogChannel.log("overlay", `Overlay created with handle: ${overlayHandle}`);


        overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

        const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
        const [boundsPtr, boudsView] = createStruct<OpenVR.TextureBounds>(bounds, OpenVR.TextureBoundsStruct)
        overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);


        const initialTransform: OpenVR.HmdMatrix34 = {
            m: [
                [1.0, 0.0, 0.0, sync ? 0.0 : 1.0], // Offset 1 meter to the right if not sync
                [0.0, 1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0, -2.5]
            ]
        };

        setTransform(initialTransform)

        overlay.ShowOverlay(overlayHandle);
        LogChannel.log("overlay", "Overlay initialized and shown");




        const texture = state.glManager!.getTexture();
        if (!texture) { throw new Error("texture is null"); }

        const textureData = {
            handle: BigInt(texture[0]),
            eType: OpenVR.TextureType.TextureType_OpenGL,
            eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
        };
        const [textureStructPtr, textureStructView ] = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct)
        state.textureStructPtr = textureStructPtr;

        state.isRunning = true;
        console.log("isRunning", state.id, state.isRunning)


        if (sync) {
            state.screenCapturer = INITSCREENCAP();
            if (frames === 0) {
                LogChannel.log("overlay", `Screen capture initialized, continuous streaming mode`);
            } else {
                LogChannel.log("overlay", `Screen capture initialized, will send ${frames} frames`);
            }

            DeskCapLoop(state.screenCapturer, overlay, textureStructPtr, frames);
        } else {
            LogChannel.log("overlay", "Running in sub mode, waiting for frame data");
        }
    } catch (error) {
        LogChannel.error("overlay", "Error in main:", error);
        if (error instanceof Error) {
            LogChannel.error("overlay", "Stack:", error.stack);
        }
    }
}



//#region cleanup
globalThis.addEventListener("unload", cleanup);

async function cleanup() {
    state.isRunning = false;
    if (state.screenCapturer) {
        await state.screenCapturer.dispose();
        state.screenCapturer = null;
    }
}
//#endregion
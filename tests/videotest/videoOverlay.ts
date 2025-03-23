import { PostMan, wait } from "../../submodules/stageforge/mod.ts";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "../../classes/customlogger.ts";
import { ScreenCapturer } from "../../classes/ScreenCapturer/scclass.ts";
import { OpenGLManager } from "../../classes/openglManager.ts";
import { OpenVRTransform } from "../../classes/openvrTransform.ts";

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
};
type SerializedBigInt = { __bigint__: string };

new PostMan(state, {
    CUSTOMINIT: (_payload: void) => {
        PostMan.setTopic("muffin")
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean }) => {
        main(payload.name, payload.sync);
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
} as const);

//#region init 
function INITSCREENCAP(): ScreenCapturer {
    const capturer = new ScreenCapturer({
        debug: false,
        onStats: ({ fps, avgLatency }) => {
            CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
        },
        executablePath: "../../resources/screen-streamer"
    });
    return capturer;
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    if (!state.glManager) { throw new Error("glManager is null"); }
    state.glManager.createTextureFromScreenshot(pixels, width, height);
}

//#endregion


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


            if (PostMan.state.addressBook && PostMan.state.addressBook.size > 0) {
                for (const actorId of PostMan.state.addressBook) {
                    if (actorId === state.id) continue;

                    const totalSize = frame.data.length;


                    // Log frame info for debugging
                    console.log(`Sending frame: ${frame.width}x${frame.height}, ${totalSize} bytes`);
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
                }
            }
        }
        // Wait frame sync
        overlay.WaitFrameSync(100);
        await wait(50)
    }
}

function INITGL(name?: string) {
    state.glManager = new OpenGLManager();
    state.glManager.initialize(name);
    if (!state.glManager) { throw new Error("glManager is null"); }
}

function main(overlayname: string, sync: boolean) {
    try {
        state.sync = sync;

        INITGL(overlayname);



        CustomLogger.log("overlay", "Creating overlay...");
        const overlay = state.overlayClass as OpenVR.IVROverlay;
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
        }
        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        state.overlayTransform = new OpenVRTransform(overlay, overlayHandle);
        CustomLogger.log("overlay", `Overlay created with handle: ${overlayHandle}`);


        overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

        const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
        const boundsPtr = createStruct<OpenVR.TextureBounds>(bounds, OpenVR.TextureBoundsStruct, true)
        overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);


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




        const texture = state.glManager!.getTexture();
        if (!texture) { throw new Error("texture is null"); }

        const textureData = {
            handle: BigInt(texture[0]),
            eType: OpenVR.TextureType.TextureType_OpenGL,
            eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
        };
        const textureStructPtr = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct, true)
        state.textureStructPtr = textureStructPtr;

        state.isRunning = true;
        console.log("isRunning", PostMan.state.id, state.isRunning)


        if (sync) {

            state.screenCapturer = INITSCREENCAP();
            CustomLogger.log("overlay", "Screen capture initialized");


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
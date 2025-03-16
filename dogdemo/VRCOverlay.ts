import {
    BaseState,
    worker,
    ToAddress,
    MessageAddressReal,
} from "../stageforge/src/lib/types.ts";
import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { OpenVRTransform } from "../classes/openvrTransform.ts";
import { isValidMatrix, multiplyMatrix, invertMatrix, matrixEquals } from "../classes/matrixutils.ts";

const state = {
    id: "",
    db: {},
    name: "vrcoverlay",
    sync: false,
    overlayClass: null as OpenVR.IVROverlay | null,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
    overlayHandle: 0n,
    overlayTransform: null as OpenVRTransform | null,
    addressBook: new Set(),
    TrackingUniverseOriginPTR: null,
    vrSystem: null as OpenVR.IVRSystem | null,
    vrcOriginActor: null as string | null,
    vrcOrigin: null as OpenVR.HmdMatrix34 | null,
    smoothedVrcOrigin: null as OpenVR.HmdMatrix34 | null,
    relativePosition: {
        m: [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0]
        ]
    } as OpenVR.HmdMatrix34,
    isRunning: false,
    screenCapturer: null as ScreenCapturer | null,
    glManager: null as OpenGLManager | null,
    grabbedController: null as "left" | "right" | null,
    grabOffset: null as OpenVR.HmdMatrix34 | null,
    inputActor: "",
};


new PostMan(state.name, {
    CUSTOMINIT: (_payload: void) => {
        PostMan.setTopic("muffin")
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void) => {
        return state.id
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, inputActor?: string }) => {
        if (payload.inputActor) {
            state.inputActor = payload.inputActor;
        }
        main(payload.name, payload.texture, payload.sync);
    },
    GETOVERLAYLOCATION: (_payload: void) => {
        const m34 = GetOverlayTransformAbsolute();
        return m34
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
        const transform = payload;
        if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

        if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
            // Update relative position
            state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), transform);
            // When explicitly setting location, apply it immediately without smoothing
            setOverlayTransformAbsolute(transform);
        } else {
            // If no valid VRC origin, set absolute position directly without smoothing
            setOverlayTransformAbsolute(transform);
        }
    },
    INITOPENVR: (payload: bigint) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    ASSIGNVRCORIGIN: (payload: string) => {
        state.vrcOriginActor = payload;
        CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);
    },
    STOP: async (_payload: void) => {
        state.isRunning = false;
        if (state.screenCapturer) {
            await state.screenCapturer.dispose();
            state.screenCapturer = null;
        }
    },
    OVERLAY_GRAB_START: (payload: { controller: "left" | "right", intersection: OpenVR.OverlayIntersectionResults, controllerPose: OpenVR.InputPoseActionData }) => {
        CustomLogger.log("input","grab")

        
        if (state.grabbedController) return; // Already being grabbed
        
        state.grabbedController = payload.controller;
        
        // Calculate and store the offset between controller and overlay
        const overlayTransform = GetOverlayTransformAbsolute();
        const controllerTransform = payload.controllerPose.pose.mDeviceToAbsoluteTracking;
        
        // The offset is the inverse of controller transform multiplied by overlay transform
        state.grabOffset = multiplyMatrix(invertMatrix(controllerTransform), overlayTransform);
    },
    
    OVERLAY_GRAB_END: (payload: { controller: "left" | "right" }) => {
        CustomLogger.log("input","ungrab")
        if (state.grabbedController !== payload.controller) return;
        
        state.grabbedController = null;
        state.grabOffset = null;
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
function INITGL() {
    state.glManager = new OpenGLManager();
    state.glManager.initialize();
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    if (!state.glManager) { throw new Error("glManager is null"); }
    state.glManager.createTextureFromScreenshot(pixels, width, height);
}

//#endregion

//#region smoothing
const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

function addToSmoothingWindow(window: OpenVR.HmdMatrix34[], transform: OpenVR.HmdMatrix34) {
    if (window.length >= smoothingWindowSize) {
        window.shift();
    }
    window.push(transform);
}

function getSmoothedTransform(window: (OpenVR.HmdMatrix34 | null)[]): OpenVR.HmdMatrix34 | null {
    const validTransforms = window.filter(isValidMatrix) as OpenVR.HmdMatrix34[];

    if (validTransforms.length === 0) {
        //CustomLogger.warn("smoothing", "No valid transforms in smoothing window");
        return null;
    }

    const smoothedTransform: OpenVR.HmdMatrix34 = {
        m: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0]
        ]
    };

    for (const transform of validTransforms) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 4; j++) {
                smoothedTransform.m[i][j] += transform.m[i][j];
            }
        }
    }

    const windowSize = validTransforms.length;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            smoothedTransform.m[i][j] /= windowSize;
        }
    }

    return smoothedTransform;
}
//#endregion

//#region screencapture
async function DeskCapLoop(capturer: ScreenCapturer, overlay: OpenVR.IVROverlay, textureStructPtr: Deno.PointerValue<OpenVR.Texture>) {
    while (true) {
        const frame = await capturer.getLatestFrame();
        if (frame) {
            createTextureFromScreenshot(frame.data, frame.width, frame.height)
            // Set overlay texture
            const error = overlay.SetOverlayTexture(state.overlayHandle, textureStructPtr);
            if (error !== OpenVR.OverlayError.VROverlayError_None) {
                console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
            }
        }
        // Wait frame sync
        overlay.WaitFrameSync(100);
        // Add a small delay to match VR frame rate
        await new Promise((resolve) => setTimeout(resolve, 11)); // ~90fps
    }
}

//#endregion

//#region openvr funcs

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
    if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
    state.overlayTransform.setTransformAbsolute(transform);
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
    if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
    return state.overlayTransform.getTransformAbsolute();
}

//#endregion

function main(overlayname: string, overlaytexture: string, sync: boolean) {
    try {
        state.sync = sync;

        INITGL()

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

        // Send overlay handle to input actor if specified
        if (state.inputActor) {
            PostMan.PostMessage({
                address: { fm: state.id, to: state.inputActor },
                type: "SETOVERLAYHANDLE",
                payload: overlayHandle
            });
        }

        // Set size to 1.6 meters wide (16:9 ratio will make it 0.9 meters tall)
        overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

        // bounds
        const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
        const boundsBuf = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
        OpenVR.TextureBoundsStruct.write(bounds, new DataView(boundsBuf));
        const boundsPtr = Deno.UnsafePointer.of(boundsBuf) as Deno.PointerValue<OpenVR.TextureBounds>;
        overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);

        overlay.ShowOverlay(overlayHandle);

        // Position it slightly further back to accommodate the larger size
        const initialTransform: OpenVR.HmdMatrix34 = {
            m: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0, -2.5]
            ]
        };
        setOverlayTransformAbsolute(initialTransform);

        CustomLogger.log("overlay", "Overlay initialized and shown");
        //#endregion

        // Initialize screen capture
        state.screenCapturer = INITSCREENCAP();
        CustomLogger.log("overlay", "Screen capture initialized");

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

        state.isRunning = true;

        // Start the desktop capture loop
        DeskCapLoop(state.screenCapturer, overlay, textureStructPtr);
        updateLoop();
    } catch (error) {
        CustomLogger.error("overlay", "Error in main:", error);
        if (error instanceof Error) {
            CustomLogger.error("overlay", "Stack:", error.stack);
        }
    }
}

async function updateLoop() {
    while (state.isRunning) {
        try {
            // Only update VRC origin if we're not being grabbed
            if (state.vrcOriginActor && !state.grabbedController) {
                const newVrcOrigin = await PostMan.PostMessage({
                    target: state.vrcOriginActor ,
                    type: "GETVRCORIGIN",
                    payload: null,
                }, true) as OpenVR.HmdMatrix34;

                if (isValidMatrix(newVrcOrigin)) {
                    addToSmoothingWindow(vrcOriginSmoothingWindow, newVrcOrigin);
                    const smoothedNewVrcOrigin = getSmoothedTransform(vrcOriginSmoothingWindow);

                    if (smoothedNewVrcOrigin && (!state.smoothedVrcOrigin || !matrixEquals(state.smoothedVrcOrigin, smoothedNewVrcOrigin))) {
                        state.smoothedVrcOrigin = smoothedNewVrcOrigin;
                        const newAbsolutePosition = multiplyMatrix(state.smoothedVrcOrigin, state.relativePosition);
                        addToSmoothingWindow(smoothingWindow, newAbsolutePosition);
                        const smoothedAbsolutePosition = getSmoothedTransform(smoothingWindow);
                        if (smoothedAbsolutePosition) {
                            setOverlayTransformAbsolute(smoothedAbsolutePosition);
                        }
                    }
                }
            }

            // Always get controller data when we have an input actor
            /* if (!state.inputActor) {
                const controllerData = await PostMan.PostMessage({
                    target: state.inputActor ,
                    type: "GETCONTROLLERDATA",
                    payload: null
                }, true) as [OpenVR.InputPoseActionData, OpenVR.InputPoseActionData];

                if (controllerData) {
                    // If we're grabbed, update position
                    if (state.grabbedController && state.grabOffset) {
                        const [leftPose, rightPose] = controllerData;
                        const controllerPose = state.grabbedController === "left" ? leftPose : rightPose;
                        
                        if (controllerPose) {
                            // Calculate new overlay position based on controller position and stored offset
                            const newTransform = multiplyMatrix(controllerPose.pose.mDeviceToAbsoluteTracking, state.grabOffset);
                            setOverlayTransformAbsolute(newTransform);

                            // Update relative position to match current grab position
                            if (state.smoothedVrcOrigin) {
                                state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), newTransform);
                            }
                        }
                    }
                }
            } */

            await wait(1000/90); // 90hz update rate
        } catch (error) {
            CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
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


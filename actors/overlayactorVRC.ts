import {
    TypedActorFunctions,
    BaseState,
    worker,
    ToAddress,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapture, FrameData } from "../screen_capture_module.ts";

type State = {
    id: string;
    db: Record<string, unknown>;
    overlayClass: OpenVR.IVROverlay | null;
    overlayHandle: OpenVR.OverlayHandle;
    overlayerror: OpenVR.OverlayError;
    OverlayTransform: OpenVR.HmdMatrix34 | null;
    vrSystem: OpenVR.IVRSystem | null;
    vrcOriginActor: string | null;
    vrcOrigin: OpenVR.HmdMatrix34 | null;
    smoothedVrcOrigin: OpenVR.HmdMatrix34 | null;
    relativePosition: OpenVR.HmdMatrix34;
    isRunning: boolean;
    screenCapture: ScreenCapture | null;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "overlay1",
    socket: null,
    sync: false,
    overlayClass: null,
    OverlayTransform: null,
    numbah: 0,
    addressBook: new Set(),
    overlayHandle: 0n,
    TrackingUniverseOriginPTR: null,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
    vrSystem: null,
    vrcOriginActor: null,
    vrcOrigin: null,
    smoothedVrcOrigin: null,
    relativePosition: {
        m: [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0]
        ]
    },
    isRunning: false,
    screenCapture: null,
};

const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

async function startDesktopCapture(fps: number = 30): Promise<void> {
    if (state.screenCapture) {
        CustomLogger.log("overlay", "Desktop capture already running");
        return;
    }

    CustomLogger.log("overlay", "Initializing screen capture...");
    
    try {
        state.screenCapture = new ScreenCapture({
            port: 8080,
            quality: 50,
            scale: 0.5,
            targetFps: fps
        });

        state.screenCapture.addEventListener("frame", (event) => {
            try {
                const frameData = event.detail;
                if (!frameData) {
                    CustomLogger.error("overlay", "Received null frame data");
                    return;
                }
                
                if (!frameData.buffer || !(frameData.buffer instanceof ArrayBuffer)) {
                    CustomLogger.error("overlay", "Invalid frame buffer:", frameData.buffer);
                    return;
                }

                CustomLogger.log("overlay", `Received frame: ${frameData.width}x${frameData.height}, ${frameData.buffer.byteLength} bytes`);
                updateOverlayTexture(frameData);
            } catch (err) {
                CustomLogger.error("overlay", "Error in frame handler:", err);
            }
        });

        CustomLogger.log("overlay", `Starting desktop capture at ${fps} FPS`);
        await state.screenCapture.start();
        CustomLogger.log("overlay", "Screen capture started successfully");
    } catch (err) {
        CustomLogger.error("overlay", "Failed to start screen capture:", err);
        state.screenCapture = null;
    }
}

async function stopDesktopCapture(): Promise<void> {
    if (!state.screenCapture) {
        CustomLogger.log("overlay", "Desktop capture not running");
        return;
    }

    await state.screenCapture.stop();
    state.screenCapture = null;
    CustomLogger.log("overlay", "Stopped desktop capture");
}

function updateOverlayTexture(frameData: FrameData) {
    if (!state.overlayClass || !state.overlayHandle) {
        CustomLogger.error("overlay", "Overlay not initialized");
        return;
    }

    try {
        const startTime = performance.now();

        // Validate frame data
        const expectedSize = frameData.width * frameData.height * 4; // RGBA = 4 bytes per pixel
        if (frameData.buffer.byteLength !== expectedSize) {
            CustomLogger.error(
                "overlay",
                `Invalid buffer size. Expected ${expectedSize}, got ${frameData.buffer.byteLength}`
            );
            return;
        }

        // Create pointer to frame buffer
        const uint8Array = new Uint8Array(frameData.buffer);
        const imageDataPtr = Deno.UnsafePointer.of(uint8Array);
        
        if (!imageDataPtr) {
            CustomLogger.error("overlay", "Failed to create pointer for image data");
            return;
        }

        // Update OpenVR texture with raw RGBA data
        const error = state.overlayClass.SetOverlayRaw(
            state.overlayHandle,
            imageDataPtr,
            frameData.width >>> 0,
            frameData.height >>> 0,
            4 // RGBA = 4 bytes per pixel
        );

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            CustomLogger.error(
                "overlay",
                `Failed to update overlay texture: ${OpenVR.OverlayError[error]} (${error})`
            );
            return;
        }

        const endTime = performance.now();
        const updateTime = endTime - startTime;
        
        if (updateTime > 50) { // Log if update takes more than 50ms
            CustomLogger.log("perf", `Slow overlay update: ${updateTime.toFixed(1)}ms`);
        }

    } catch (error) {
        CustomLogger.error("overlay", "Error updating overlay texture:", error);
        if (error instanceof Error) {
            CustomLogger.error("overlay", "Stack:", error.stack);
        }
    }
}

const functions = {
    CUSTOMINIT: (_payload) => {
        //Postman.functions?.HYPERSWARM?.(null, state.id);
        startDesktopCapture(30).catch(error => console.log(`Desktop capture error: ${error}`));
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload, address) => {
        const addr = address as MessageAddressReal;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETID",
            payload: state.id,
        }, false);
    },
    STARTOVERLAY: (payload, _address) => {
        mainX(payload.name, payload.texture, payload.sync);
    },
    GETOVERLAYLOCATION: (_payload, address) => {
        const addr = address as MessageAddressReal;
        const m34 = GetOverlayTransformAbsolute();
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETOVERLAYLOCATION",
            payload: m34,
        });
    },
    SETOVERLAYLOCATION: (payload, address) => {
        const transform = payload as OpenVR.HmdMatrix34;
        if (!isValidMatrix(transform)) {
            //CustomLogger.warn("SETOVERLAYLOCATION", "Received invalid transform");
            return;
        }

        if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
            // Update relative position
            state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), transform);
        } else {
            // If no valid VRC origin, set absolute position
            addToSmoothingWindow(smoothingWindow, transform);
            const smoothedTransform = getSmoothedTransform(smoothingWindow);
            if (smoothedTransform) {
                setOverlayTransformAbsolute(smoothedTransform);
            }
        }
    },
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    ASSIGNVRCORIGIN: (payload, _address) => {
        state.vrcOriginActor = payload as string;
        CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);
    },
    STOP: (_payload) => {
        stopDesktopCapture();
    },
};

function isValidMatrix(m: OpenVR.HmdMatrix34 | null): boolean {
    if (!m) return false;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            if (typeof m.m[i][j] !== 'number' || isNaN(m.m[i][j])) {
                return false;
            }
        }
    }
    return true;
}

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
    const overlay = state.overlayClass!;
    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    const transformView = new DataView(transformBuffer);
    OpenVR.HmdMatrix34Struct.write(transform, transformView);
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;
    overlay.SetOverlayTransformAbsolute(state.overlayHandle, OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding, transformPtr);
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
    let error = state.overlayerror;
    const overlay = state.overlayClass!;
    const overlayHandle = state.overlayHandle;
    const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
    const hmd34size = OpenVR.HmdMatrix34Struct.byteSize;
    const hmd34buf = new ArrayBuffer(hmd34size);
    const hmd34view = new DataView(hmd34buf);
    const m34ptr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(hmd34buf)!;

    error = overlay.GetOverlayTransformAbsolute(overlayHandle, TrackingUniverseOriginPTR, m34ptr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        CustomLogger.error("actorerr", `Failed to get overlay transform: ${OpenVR.OverlayError[error]}`);
        throw new Error("Failed to get overlay transform");
    }
    const m34 = OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
    return m34;
}

function multiplyMatrix(a: OpenVR.HmdMatrix34, b: OpenVR.HmdMatrix34): OpenVR.HmdMatrix34 {
    const result: OpenVR.HmdMatrix34 = {
        m: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0]
        ]
    };

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            result.m[i][j] = 0;
            for (let k = 0; k < 3; k++) {
                result.m[i][j] += a.m[i][k] * b.m[k][j];
            }
            if (j === 3) {
                result.m[i][j] += a.m[i][3];
            }
        }
    }

    return result;
}

function invertMatrix(m: OpenVR.HmdMatrix34): OpenVR.HmdMatrix34 {
    const result: OpenVR.HmdMatrix34 = {
        m: [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0]
        ]
    };

    // Invert 3x3 rotation matrix
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result.m[i][j] = m.m[j][i];
        }
    }

    // Invert translation
    for (let i = 0; i < 3; i++) {
        result.m[i][3] = -(
            result.m[i][0] * m.m[0][3] +
            result.m[i][1] * m.m[1][3] +
            result.m[i][2] * m.m[2][3]
        );
    }

    return result;
}

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

async function mainX(overlayname: string, overlaytexture: string, sync: boolean) {
    try {
        state.sync = sync;

        CustomLogger.log("overlay", "Creating overlay...");
        const overlay = state.overlayClass as OpenVR.IVROverlay;
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);
        
        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
        }

        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        CustomLogger.log("overlay", `Overlay created with handle: ${overlayHandle}`);

        const imgpath = Deno.realPathSync(overlaytexture);
        overlay.SetOverlayFromFile(overlayHandle, imgpath);
        
        // Set size to 1.6 meters wide (16:9 ratio will make it 0.9 meters tall)
        overlay.SetOverlayWidthInMeters(overlayHandle, 1.6);
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

        state.isRunning = true;
        await startDesktopCapture(30);
        updateLoop();
    } catch (error) {
        CustomLogger.error("overlay", "Error in mainX:", error);
        if (error instanceof Error) {
            CustomLogger.error("overlay", "Stack:", error.stack);
        }
    }
}

async function updateLoop() {
    while (state.isRunning) {
        try {
            if (state.vrcOriginActor) {
                const newVrcOrigin = await Postman.PostMessage({
                    address: { fm: state.id, to: state.vrcOriginActor },
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
                } else {
                    //CustomLogger.warn("updateLoop", "Received invalid VRC origin");
                }
            }
        } catch (error) {
            //CustomLogger.error("updateLoop", `Error in update loop: ${error.message}`);
        }

        await wait(1); // Update at 20Hz, adjust as needed
    }
}

function matrixEquals(a: OpenVR.HmdMatrix34, b: OpenVR.HmdMatrix34): boolean {
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            if (Math.abs(a.m[i][j] - b.m[i][j]) > 0.0001) {
                return false;
            }
        }
    }
    return true;
}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
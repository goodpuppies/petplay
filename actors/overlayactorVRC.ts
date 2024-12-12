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
import { ScreenCapture } from "../ScreenCapture.ts";
import {
    createWindow,
    getProcAddress,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";

//#region state
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
    currentTexture: number | null;
    glWindow: any | null;
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
    currentTexture: null,
    glWindow: null,
};
//#endregion

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
        state.screenCapture = new ScreenCapture(); // Still capture at 60fps but update overlay slower
        const intervalId = setInterval(() => {
            if (state.screenCapture?.isWorkerReady()) {
                console.log("Starting screen capture...");
                state.screenCapture.start();
                clearInterval(intervalId);
            }
        }, 100);
        console.log("Starting screen capture test...");
        
        // Start a loop to update the overlay texture
        const updateLoop = async () => {
            let lastUpdateTime = 0;
            const UPDATE_INTERVAL = 2000; // Update at ~60fps
            console.log("Starting update loop...");

            while (state.screenCapture && state.isRunning) {
                const currentTime = Date.now();
                if (currentTime - lastUpdateTime >= UPDATE_INTERVAL) {
                    console.log("getframe")
                    const frame = state.screenCapture.getCurrentFrame();
                    let pixels: Uint8Array | null = null;
                    let width = 0;
                    let height = 0;

                    if (frame && frame.pixels) {
                        ({ pixels, width, height } = frame);
                        if (width > 0 && height > 0) {
                            updateOverlayTexture(frame);
                            lastUpdateTime = currentTime;
                        }
                    } else {
                        await wait(100);
                    }
                }
                await wait(16); // Check every frame
            }
        };
        
        updateLoop();
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

    state.screenCapture.stop();
    state.screenCapture = null;
    CustomLogger.log("overlay", "Stopped desktop capture");
}



function updateOverlayTexture(frameData: { pixels: Uint8Array, width: number, height: number }) {
    if (!state.overlayClass || !state.overlayHandle) {
        CustomLogger.error("overlay", "Overlay not initialized");
        return;
    }

    try {
        const startTime = performance.now();

        // Validate frame data
        const expectedSize = frameData.width * frameData.height * 4; // RGBA = 4 bytes per pixel
        if (frameData.pixels.length !== expectedSize) {
            CustomLogger.error(
                "overlay",
                `Invalid buffer size. Expected ${expectedSize}, got ${frameData.pixels.length}`
            );
            return;
        }

        const error = state.overlayClass.SetOverlayTexture(
            state.overlayHandle,
            textureStructPtr
        );

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            CustomLogger.error(
                "overlay",
                `Failed to update overlay texture: ${OpenVR.OverlayError[error]} (${error})`
            );
            return;
        }

        // Create event struct buffer
        const eventBuffer = new ArrayBuffer(OpenVR.EventStruct.byteSize);
        const eventView = new DataView(eventBuffer);
        const eventPtr = Deno.UnsafePointer.of(eventBuffer) as Deno.PointerValue<OpenVR.Event>;

        // Process overlay events
        while (state.overlayClass.PollNextOverlayEvent(
            state.overlayHandle,
            eventPtr,
            OpenVR.EventStruct.byteSize
        )) {
            // Read event data if needed
            const event = OpenVR.EventStruct.read(eventView);
            // Handle event based on event.eventType if needed
        }

        const endTime = performance.now();
        const updateTime = endTime - startTime;
        
        if (updateTime > 50) {
            CustomLogger.log("warn", `Slow overlay update: ${updateTime.toFixed(1)}ms`);
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
        //startDesktopCapture(30).catch(error => console.log(`Desktop capture error: ${error}`));
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

//#region random funcs
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
//#endregion

async function mainX(overlayname: string, overlaytexture: string, sync: boolean) {
    try {
        state.sync = sync;

        // Initialize OpenGL context with a hidden window
        state.glWindow = createWindow({
            title: "Hidden GL Context",
            width: 1024,  // Match texture size
            height: 512,  // Match texture size
            visible: false,
            glVersion: [3, 2],
            gles: true,
        });
        gl.load(getProcAddress);

        // Initialize OpenGL state
        gl.Enable(gl.TEXTURE_2D);
        gl.Enable(gl.BLEND);
        gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

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
        
        // Set size to 1.6 meters wide (16:9 ratio will make it 0.9 meters tall)
        overlay.SetOverlayWidthInMeters(overlayHandle, 1.6);

        // Set texture bounds to control texture mapping
        const bounds = {
            uMin: 0,
            uMax: 1,
            vMin: 0,
            vMax: 1
        };
        const boundsbuf = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
        OpenVR.TextureBoundsStruct.write(bounds, new DataView(boundsbuf));
        const boundsptr = Deno.UnsafePointer.of<OpenVR.TextureBounds>(boundsbuf)!;
        overlay.SetOverlayTextureBounds(overlayHandle, boundsptr);

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



function cleanup() {
    //cleanup GL
    

}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
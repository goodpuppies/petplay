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
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import {
    createWindow,
    getProcAddress,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { flipVertical } from "./screenutils.ts";
import { isValidMatrix, multiplyMatrix, invertMatrix, matrixEquals } from "./matrixutils.ts";

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
    screenCapturer: ScreenCapturer | null;
    currentTexture: number | null;
    texture: Uint32Array | null;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "overlay1",
    socket: null,
    texture: null,
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
    screenCapturer: null,
    currentTexture: null,
};
//#endregion

const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

//#region init screencapture

function INITSCREENCAP(): ScreenCapturer {
    const capturer = new ScreenCapturer({
        debug: false,
        onStats: ({ fps, avgLatency }) => {
            CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
        }
    });
    return capturer;
}

//#endregion

//#region opengl init

function checkGLError(message: string) {
    const error = gl.GetError();
    if (error !== gl.NO_ERROR) {
        const errorMessages: { [key: number]: string } = {
            [gl.INVALID_ENUM]: "GL_INVALID_ENUM",
            [gl.INVALID_VALUE]: "GL_INVALID_VALUE",
            [gl.INVALID_OPERATION]: "GL_INVALID_OPERATION",
            [gl.INVALID_FRAMEBUFFER_OPERATION]: "GL_INVALID_FRAMEBUFFER_OPERATION",
            [gl.OUT_OF_MEMORY]: "GL_OUT_OF_MEMORY",
        };
        console.error(`OpenGL Error (${message}): ${error} - ${errorMessages[error] || 'Unknown error'}`);
        console.trace();
    }
}

function INITGL() {
    // Create window and initialize GL
    const window = createWindow({
        title: "Texture Overlay",
        width: 1,  // Set window width to 0
        height: 1, // Set window height to 0
        resizable: false,
        visible: false, // Make window invisible
        glVersion: [3, 2],
        gles: false,
    });

    gl.load(getProcAddress);
    checkGLError("gl.load");

    state.texture = new Uint32Array(1);
    gl.GenTextures(1, state.texture);
    gl.BindTexture(gl.TEXTURE_2D, state.texture[0]);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    checkGLError("texture creation");
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    const flippedPixels = flipVertical(pixels, width, height);
    if (state.texture === null) { throw new Error("state.texture is null"); }

    gl.BindTexture(gl.TEXTURE_2D, state.texture[0]);
    gl.TexImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.BGRA,
        gl.UNSIGNED_BYTE,
        flippedPixels
    );

    checkGLError("upload texture data");
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

const functions = {
    CUSTOMINIT: (_payload: void) => {
        //Postman.functions?.HYPERSWARM?.(null, state.id);
        //startDesktopCapture(30).catch(error => console.log(`Desktop capture error: ${error}`));
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void, address: MessageAddressReal) => {
        const addr = address;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETID",
            payload: state.id,
        }, false);
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean }, _address: MessageAddressReal) => {
        mainX(payload.name, payload.texture, payload.sync);
    },
    GETOVERLAYLOCATION: (_payload: void, address: MessageAddressReal) => {
        const addr = address as MessageAddressReal;
        const m34 = GetOverlayTransformAbsolute();
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETOVERLAYLOCATION",
            payload: m34,
        });
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34, address: MessageAddressReal) => {
        const transform = payload;
        if (!isValidMatrix(transform)) {throw new Error("Received invalid transform");}

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
    INITOPENVR: (payload: bigint) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    ASSIGNVRCORIGIN: (payload: string, _address: MessageAddressReal) => {
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
};

//#region random funcs

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

function mainX(overlayname: string, overlaytexture: string, sync: boolean) {
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

        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        CustomLogger.log("overlay", `Overlay created with handle: ${overlayHandle}`);

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
        if (state.texture === null) { throw new Error("state.texture is null"); }

        const textureData = {
            handle: BigInt(state.texture[0]),
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

async function cleanup() {
    state.isRunning = false;
    if (state.screenCapturer) {
        await state.screenCapturer.dispose();
        state.screenCapturer = null;
    }
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
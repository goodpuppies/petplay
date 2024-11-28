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
    captureProcess: Deno.ChildProcess | null;
    latestFrame: Uint8Array | null;
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
    captureProcess: null,
    latestFrame: null,
};

const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

async function captureDesktop(): Promise<void> {
    const ffmpegCommand = new Deno.Command("ffmpeg", {
        args: [
            "-f", "gdigrab",
            "-framerate", "30",
            "-i", "desktop",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-f", "rawvideo", // Output raw video
            "-pix_fmt", "bgra", // Correct pixel format
            "-s", "1920x1080", // Resolution
            "-"  // Output to stdout
        ],
        stdout: "piped", // Piping stdout
        stderr: "piped", // Piping stderr for error logging
    });

    console.log("Starting desktop capture to buffer...");

    const child = ffmpegCommand.spawn();
    const { stdout, stderr } = child;

    if (!stdout || !stderr) {
        throw new Error("Failed to get stdout or stderr from FFmpeg process");
    }

    // Define the correct frame size (1920x1080 resolution, 4 bytes per pixel)
    const frameSize = 1920 * 1080 * 4;
    let buffer = new Uint8Array(frameSize); // Buffer to accumulate full frames
    let bufferOffset = 0; // Tracks how much of the frame we've accumulated

    const reader = stdout.getReader();

    // Function to print progress as a bar
    function showProgressBar(offset: number, total: number) {
        const progress = (offset / total) * 100;
        const barLength = 30;
        const filledLength = Math.round((barLength * offset) / total);
        const bar = '█'.repeat(filledLength) + '-'.repeat(barLength - filledLength);
        console.log(`Progress: [${bar}] ${progress.toFixed(2)}%`);
    }

    // Read from stdout in real-time and send the data to the VR overlay
    console.log("Reading data from stdout...");
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break; // No more data to read

            if (value) {
                console.log(`Received chunk of size: ${value.length}`);

                // Handle filling the buffer with chunked data
                let remainingData = value;
                while (remainingData.length > 0) {
                    const bytesToCopy = Math.min(remainingData.length, frameSize - bufferOffset);
                    buffer.set(remainingData.subarray(0, bytesToCopy), bufferOffset);
                    bufferOffset += bytesToCopy;
                    remainingData = remainingData.subarray(bytesToCopy);

                    // Show progress in the console
                    showProgressBar(bufferOffset, frameSize);

                    // If buffer is full (we have a complete frame), send it to the overlay
                    if (bufferOffset === frameSize) {
                        updateOverlayTexture(buffer);  // Send the complete frame to the VR overlay
                        bufferOffset = 0; // Reset for the next frame
                        console.log("Full frame received and sent to overlay.");
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error while reading/writing data:", error);
    } finally {
        reader.releaseLock();
    }

    // Log stderr output to see if FFmpeg throws any errors
    const errorReader = stderr.getReader();
    (async () => {
        while (true) {
            const { done, value } = await errorReader.read();
            if (done) break;
            if (value) {
                console.error(new TextDecoder().decode(value));
            }
        }
    })();

    // Wait for the process to finish
    const status = await child.status;

    if (!status.success) {
        console.error("FFmpeg process failed.");
    } else {
        console.log("Desktop capture stream completed successfully.");
    }
}





function updateOverlayTexture(buffer: ArrayBuffer) {
    console.log("Updating overlay texture with new frame...");
    if (!state.overlayClass || !state.overlayHandle) return;

    const overlay = state.overlayClass;
    const width = 1920; // Assuming 1920x1080 resolution
    const height = 1080;
    const bytesPerPixel = 4; // 4 bytes per pixel for BGRA

    // Create a pointer to the ArrayBuffer
    const imageDataPtr = Deno.UnsafePointer.of(buffer);

    if (!imageDataPtr) {
        throw new Error("Failed to create pointer for image data.");
    }

    // Call the FFI function to update the overlay
    const error = overlay.SetOverlayRaw(
        state.overlayHandle,
        imageDataPtr,
        width,
        height,
        bytesPerPixel
    );

    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        CustomLogger.error("overlay", `Failed to update overlay texture: ${OpenVR.OverlayError[error]}`);
    }
}



const functions = {
    CUSTOMINIT: (_payload) => {
        Postman.functions?.HYPERSWARM?.(null, state.id);
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
    state.sync = sync;

    const overlay = state.overlayClass as OpenVR.IVROverlay;
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    state.overlayHandle = overlayHandle;

    CustomLogger.log("actor", `Overlay created with handle: ${overlayHandle}`);

    const imgpath = Deno.realPathSync(overlaytexture);
    overlay.SetOverlayFromFile(overlayHandle, imgpath);
    overlay.SetOverlayWidthInMeters(overlayHandle, 0.2);
    overlay.ShowOverlay(overlayHandle);

    const initialTransform: OpenVR.HmdMatrix34 = {
        m: [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, -2.0]
        ]
    };
    setOverlayTransformAbsolute(initialTransform);

    CustomLogger.log("default", "Overlay created and shown.");

    state.isRunning = true;
    captureDesktop().catch(error => console.log(`Desktop capture error: ${error}`));
    updateLoop();

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
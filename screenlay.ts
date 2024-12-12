import { ScreenCapture } from "./ScreenCapture.ts";
import {
    createWindow,
    getProcAddress,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import * as OpenVR from "https://raw.githubusercontent.com/mommysgoodpuppy/OpenVR_TS_Bindings_Deno/refs/heads/main/openvr_bindings.ts";
import { P } from "https://raw.githubusercontent.com/mommysgoodpuppy/OpenVR_TS_Bindings_Deno/refs/heads/main/pointers.ts";
import { stringToPointer } from "https://raw.githubusercontent.com/mommysgoodpuppy/OpenVR_TS_Bindings_Deno/refs/heads/main/utils.ts";
import { wait } from "./actorsystem/utils.ts";


// Constants
const OVERLAY_WIDTH_METERS = 2;

//#region OpenVR Initialization
function initOpenVR(): { overlay: OpenVR.IVROverlay; overlayHandle: OpenVR.OverlayHandle } {
    const errorX = Deno.UnsafePointer.of(new Int32Array(1))!;
    OpenVR.VR_InitInternal(errorX, OpenVR.ApplicationType.VRApplication_Overlay);
    const error = new Deno.UnsafePointerView(errorX).getInt32();
    if (error !== 0) {
        throw new Error(`VR_InitInternal failed with error ${error}`);
    }
    const initErrorPtr = P.Int32P<OpenVR.InitError>();
    const overlayPTR = OpenVR.VR_GetGenericInterface(
        stringToPointer(OpenVR.IVROverlay_Version),
        initErrorPtr,
    );
    const overlay = new OpenVR.IVROverlay(overlayPTR);
    if (!overlay) {
        throw new Error("Failed to get overlay interface");
    }
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const overlayError = overlay.CreateOverlay(
        "texture-overlay",
        "Texture Overlay",
        overlayHandlePTR,
    );
    if (overlayError !== OpenVR.OverlayError.VROverlayError_None) {
        throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[overlayError]}`);
    }
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    return { overlay, overlayHandle };
}

function setOverlayTransform(
    overlay: OpenVR.IVROverlay,
    overlayHandle: OpenVR.OverlayHandle,
) {
    const transform: OpenVR.HmdMatrix34 = {
        m: [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, -2.0],
        ],
    };
    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    OpenVR.HmdMatrix34Struct.write(transform, new DataView(transformBuffer));
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;

    overlay.SetOverlayTransformAbsolute(
        overlayHandle,
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        transformPtr,
    );
}
//#endregion

//#region OpenGL Initialization
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

const texture = new Uint32Array(1);
gl.GenTextures(1, texture);
gl.BindTexture(gl.TEXTURE_2D, texture[0]);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
checkGLError("texture creation");


//#endregion

//#region OpenVR Program Code
const { overlay, overlayHandle } = initOpenVR();
setOverlayTransform(overlay, overlayHandle);
overlay.SetOverlayWidthInMeters(overlayHandle, OVERLAY_WIDTH_METERS);
overlay.ShowOverlay(overlayHandle);

const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
const boundsBuf = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
OpenVR.TextureBoundsStruct.write(bounds, new DataView(boundsBuf));
const boundsPtr = Deno.UnsafePointer.of(boundsBuf) as Deno.PointerValue<OpenVR.TextureBounds>;
overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);
//#endregion


//#region Screen Capture
const screen = new ScreenCapture();

const intervalId = setInterval(() => {
    if (screen.isWorkerReady()) {
        console.log("Starting screen capture...");
        screen.start();
        clearInterval(intervalId);
    }
}, 100);
console.log("Starting screen capture test...");

// Function to flip texture data vertically
function flipVertical(pixels: Uint8Array, width: number, height: number): Uint8Array {
    const flippedPixels = new Uint8Array(pixels.length);
    const bytesPerRow = width * 4;
    for (let y = 0; y < height; y++) {
        const srcRowStart = y * bytesPerRow;
        const destRowStart = (height - 1 - y) * bytesPerRow;
        flippedPixels.set(pixels.slice(srcRowStart, srcRowStart + bytesPerRow), destRowStart);
    }
    return flippedPixels;
}


function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
    const flippedPixels = flipVertical(pixels, width, height);

    gl.BindTexture(gl.TEXTURE_2D, texture[0]);
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


//#region Main Program Code
async function main() {

    // Setup OpenVR texture struct
    const textureData = {
        handle: BigInt(texture[0]),
        eType: OpenVR.TextureType.TextureType_OpenGL,
        eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
    };

    const textureStructBuffer = new ArrayBuffer(OpenVR.TextureStruct.byteSize);
    OpenVR.TextureStruct.write(textureData, new DataView(textureStructBuffer));
    const textureStructPtr = Deno.UnsafePointer.of(textureStructBuffer) as Deno.PointerValue<OpenVR.Texture>;

    while (true) {
        const frame = screen.getCurrentFrame();
        if (frame && frame.pixels) {
            createTextureFromScreenshot(frame.pixels, frame.width, frame.height)
            // Set overlay texture
            const error = overlay.SetOverlayTexture(overlayHandle, textureStructPtr);
            if (error !== OpenVR.OverlayError.VROverlayError_None) {
                console.error(`SetOverlayTexture error: ${OpenVR.OverlayError[error]}`);
            }
        } else {
            console.log("No frame available.");
            await wait(100);
        }
        // Wait frame sync
        overlay.WaitFrameSync(100);
        // Add a small delay
        await new Promise((resolve) => setTimeout(resolve, 16));
    }
}
//#endregion

// Cleanup function
function cleanup() {
    screen.stop();
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);


console.log("Starting main loop. Press Ctrl+C to exit.");
main().catch(console.error);
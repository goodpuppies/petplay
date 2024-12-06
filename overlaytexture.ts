import {
    createWindow,
    getProcAddress,
    mainloop,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gles23.2.ts";
import * as OpenVR from "./OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "./OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "./OpenVR_TS_Bindings_Deno/utils.ts";

// Constants
const WIDTH = 800;
const HEIGHT = 600;
const OVERLAY_WIDTH_METERS = 1.6;

// Initialize OpenVR
function initOpenVR(): { overlay: OpenVR.IVROverlay, overlayHandle: OpenVR.OverlayHandle } {
    const errorX = Deno.UnsafePointer.of(new Int32Array(1))!;
    OpenVR.VR_InitInternal(errorX, OpenVR.ApplicationType.VRApplication_Overlay);
    const error = new Deno.UnsafePointerView(errorX).getInt32();
    console.log("Init error:", error);

    const initErrorPtr = P.Int32P<OpenVR.InitError>();
    const overlayPTR = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), initErrorPtr);
    const overlay = new OpenVR.IVROverlay(overlayPTR);

    if (!overlay) {
        throw new Error("Failed to get overlay interface");
    }

    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const overlayError = overlay.CreateOverlay("texture-overlay", "Texture Overlay", overlayHandlePTR);
    if (overlayError !== OpenVR.OverlayError.VROverlayError_None) {
        throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[overlayError]}`);
    }

    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    console.log(`Overlay created with handle: ${overlayHandle}`);

    return { overlay, overlayHandle };
}

function setOverlayTransform(overlay: OpenVR.IVROverlay, overlayHandle: OpenVR.OverlayHandle) {
    const transform: OpenVR.HmdMatrix34 = {
        m: [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, -2.0]
        ]
    };

    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    const transformView = new DataView(transformBuffer);
    OpenVR.HmdMatrix34Struct.write(transform, transformView);
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;

    overlay.SetOverlayTransformAbsolute(
        overlayHandle,
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        transformPtr
    );
}

function loadShader(type: number, src: string) {
    const shader = gl.CreateShader(type);
    gl.ShaderSource(
        shader,
        1,
        new Uint8Array(
            new BigUint64Array([
                BigInt(
                    Deno.UnsafePointer.value(
                        Deno.UnsafePointer.of(new TextEncoder().encode(src)),
                    ),
                ),
            ]).buffer,
        ),
        new Int32Array([src.length]),
    );
    gl.CompileShader(shader);
    const status = new Int32Array(1);
    gl.GetShaderiv(shader, gl.COMPILE_STATUS, status);
    if (status[0] === gl.FALSE) {
        const logLength = new Int32Array(1);
        gl.GetShaderiv(shader, gl.INFO_LOG_LENGTH, logLength);
        const log = new Uint8Array(logLength[0]);
        gl.GetShaderInfoLog(shader, logLength[0], logLength, log);
        console.log(new TextDecoder().decode(log));
        gl.DeleteShader(shader);
        return 0;
    }
    return shader;
}

const vShaderSrc = `
precision mediump float;
attribute vec4 vPosition;
attribute vec2 vTexCoord;
varying vec2 fTexCoord;
void main() {
    gl_Position = vPosition;
    fTexCoord = vTexCoord;
}`;

const fShaderSrc = `
precision mediump float;
varying vec2 fTexCoord;
uniform sampler2D uTexture;
void main() {
    gl_FragColor = texture2D(uTexture, fTexCoord);
}`;

// Create window and initialize GL
const window = createWindow({
    title: "Textured Square Test",
    width: WIDTH,
    height: HEIGHT,
    resizable: true,
    glVersion: [3, 2],
    gles: true,
});

gl.load(getProcAddress);

// Initialize OpenVR
const { overlay, overlayHandle } = initOpenVR();
setOverlayTransform(overlay, overlayHandle);
overlay.SetOverlayWidthInMeters(overlayHandle, 2);
overlay.ShowOverlay(overlayHandle);
console.log("Overlay created and shown.");

// Set texture bounds for overlay
const bounds = {
    uMin: 0,
    uMax: 1,
    vMin: 0,
    vMax: 1
};
const boundsBuf = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
OpenVR.TextureBoundsStruct.write(bounds, new DataView(boundsBuf));
const boundsPtr = Deno.UnsafePointer.of(boundsBuf) as Deno.PointerValue<OpenVR.TextureBounds>;
overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);

// Create and link shader program
const vShader = loadShader(gl.VERTEX_SHADER, vShaderSrc);
const fShader = loadShader(gl.FRAGMENT_SHADER, fShaderSrc);
const program = gl.CreateProgram();
gl.AttachShader(program, vShader);
gl.AttachShader(program, fShader);

// Bind attribute locations
gl.BindAttribLocation(program, 0, new TextEncoder().encode("vPosition\0"));
gl.BindAttribLocation(program, 1, new TextEncoder().encode("vTexCoord\0"));
gl.LinkProgram(program);

// Create texture
const texture = new Uint32Array(1);
gl.GenTextures(1, texture);
gl.BindTexture(gl.TEXTURE_2D, texture[0]);

gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

// Create checkerboard pattern
const pixels = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const isWhite = (x & 8) ^ (y & 8);
        pixels[i] = isWhite ? 255 : 0;     // R
        pixels[i + 1] = isWhite ? 0 : 255; // G
        pixels[i + 2] = 0;                 // B
        pixels[i + 3] = 255;               // A
    }
}

gl.TexImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    64,
    64,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
);

// Show overlay
overlay.ShowOverlay(overlayHandle);

gl.ClearColor(0.0, 0.0, 0.0, 1.0);
gl.EnableVertexAttribArray(0);
gl.EnableVertexAttribArray(1);

async function main() {
    while (true) {
        gl.Clear(gl.COLOR_BUFFER_BIT);
        gl.UseProgram(program);

        // Position data
        gl.VertexAttribPointer(0, 3, gl.FLOAT, gl.FALSE, 0, new Float32Array([
            -0.5, 0.5, 0.0,  // Top left
            -0.5, -0.5, 0.0,  // Bottom left
            0.5, 0.5, 0.0,  // Top right
            0.5, -0.5, 0.0,  // Bottom right
        ]));

        // Texture coordinate data
        gl.VertexAttribPointer(1, 2, gl.FLOAT, gl.FALSE, 0, new Float32Array([
            0.0, 0.0,  // Top left
            0.0, 1.0,  // Bottom left
            1.0, 0.0,  // Top right
            1.0, 1.0,  // Bottom right
        ]));

        // Bind texture and set uniform
        gl.ActiveTexture(gl.TEXTURE0);
        //gl.BindTexture(gl.TEXTURE_2D, texture[0]);

        const texLoc = gl.GetUniformLocation(program, new TextEncoder().encode("uTexture\0"));
        gl.Uniform1i(texLoc, 0);

        gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.BindTexture(gl.TEXTURE_2D, texture[0]);
        gl.CopyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, WIDTH, HEIGHT, 0);

        // Update VR overlay texture
        const textureData = {
            handle: BigInt(texture[0]),
            eType: OpenVR.TextureType.TextureType_OpenGL,
            eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto
        };

        const textureStructBuffer = new ArrayBuffer(OpenVR.TextureStruct.byteSize);
        OpenVR.TextureStruct.write(textureData, new DataView(textureStructBuffer));
        const textureStructPtr = Deno.UnsafePointer.of(textureStructBuffer) as Deno.PointerValue<OpenVR.Texture>;

        const imgpath = Deno.realPathSync("c:/GIT/petplay/resources/PetPlay.png");
        overlay.SetOverlayFromFile(overlayHandle, imgpath);


        /* const error = overlay.SetOverlayTexture(overlayHandle, textureStructPtr);
        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            console.error(`Failed to set overlay texture: ${OpenVR.OverlayError[error]}`);
        } */

        window.swapBuffers();

        // Process VR events
        const eventBuffer = new ArrayBuffer(OpenVR.EventStruct.byteSize);
        const eventPtr = Deno.UnsafePointer.of(eventBuffer) as Deno.PointerValue<OpenVR.Event>;
        while (overlay.PollNextOverlayEvent(overlayHandle, eventPtr, OpenVR.EventStruct.byteSize)) {
            const event = OpenVR.EventStruct.read(new DataView(eventBuffer));
            //console.log("Overlay event:", event);
        }

        await new Promise(resolve => setTimeout(resolve, 16));
    }
}

// Start render loop
console.log("Starting main loop. Press Ctrl+C to exit.");
main().catch(console.error);
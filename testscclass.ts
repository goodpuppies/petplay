import { ScreenCapture } from "./ScreenCapture.ts";
import {
    createWindow,
    getProcAddress,
    mainloop,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gles23.2.ts";
import { wait } from "./actorsystem/utils.ts";

// Initialize window and GL
const window = createWindow({
    title: "Screen Capture Texture Test",
    width: 800,
    height: 600,
    resizable: true,
    glVersion: [3, 2],
    gles: true,
});

gl.load(getProcAddress);

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

// Vertex shader that passes texture coordinates
const vShaderSrc = `
attribute vec4 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    gl_Position = aPosition;
    vTexCoord = aTexCoord;
}
`;

// Fragment shader that samples from the texture
const fShaderSrc = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uTexture;
void main() {
    gl_FragColor = texture2D(uTexture, vTexCoord);
}
`;

const vShader = loadShader(gl.VERTEX_SHADER, vShaderSrc);
const fShader = loadShader(gl.FRAGMENT_SHADER, fShaderSrc);
const program = gl.CreateProgram();
gl.AttachShader(program, vShader);
gl.AttachShader(program, fShader);
gl.LinkProgram(program);

// Get attribute locations
const positionLoc = gl.GetAttribLocation(program, new TextEncoder().encode("aPosition\0"));
const texCoordLoc = gl.GetAttribLocation(program, new TextEncoder().encode("aTexCoord\0"));

// Create vertex buffer for a fullscreen quad
const positions = new Float32Array([
    -1, -1,  // Bottom left
     1, -1,  // Bottom right
    -1,  1,  // Top left
     1,  1   // Top right
]);

const texCoords = new Float32Array([
    0, 1,    // Bottom left
    1, 1,    // Bottom right
    0, 0,    // Top left
    1, 0     // Top right
]);

// Initialize screen capture

const screen = new ScreenCapture();

const intervalId = setInterval(() => {
    if (screen.isWorkerReady()) {
        console.log("Starting screen capture...");
        screen.start();
        clearInterval(intervalId);
    }
}, 100);
console.log("Starting screen capture test...");

let currentTexture: number | null = null;
let frameCount = 0;

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): number {
    // Delete old texture if it exists
    if (currentTexture !== null) {
        const textures = new Uint32Array([currentTexture]);
        gl.DeleteTextures(1, textures);
    }

    // Create new texture
    const texture = new Uint32Array(1);
    gl.GenTextures(1, texture);
    gl.BindTexture(gl.TEXTURE_2D, texture[0]);
    
    // Set texture parameters
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Upload texture data
    gl.TexImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels
    );
    
    return texture[0];
}



async function frame() {
    const frame = screen.getCurrentFrame();
    let pixels: Uint8Array | null = null;
    let width = 0;
    let height = 0;

    if (frame && frame.pixels) {
        ({ pixels, width, height } = frame);
    } else {
        console.log("No frame available.");
        await wait(1000)
        return;
    }
    console.log(`Received frame: ${width}x${height}, ${pixels.length} bytes`);
    
    if (width > 0 && height > 0) {
        frameCount++;
        currentTexture = createTextureFromScreenshot(pixels, width, height);
        
        if (frameCount % 60 === 0) { // Log every ~60 frames
            console.log(`Created texture ${currentTexture}: ${width}x${height}, ${pixels.length} bytes`);
        }
    }
    
    gl.Clear(gl.COLOR_BUFFER_BIT);
    
    if (currentTexture !== null) {
        gl.UseProgram(program);
        
        // Set up position attribute
        gl.VertexAttribPointer(positionLoc, 2, gl.FLOAT, gl.FALSE, 0, positions);
        gl.EnableVertexAttribArray(positionLoc);
        
        // Set up texture coordinate attribute
        gl.VertexAttribPointer(texCoordLoc, 2, gl.FLOAT, gl.FALSE, 0, texCoords);
        gl.EnableVertexAttribArray(texCoordLoc);
        
        // Bind texture
        gl.ActiveTexture(gl.TEXTURE0);
        gl.BindTexture(gl.TEXTURE_2D, currentTexture);
        
        // Draw fullscreen quad
        gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    
    window.swapBuffers();
    await wait(16);
}

// Cleanup function
function cleanup() {
    if (currentTexture !== null) {
        const textures = new Uint32Array([currentTexture]);
        gl.DeleteTextures(1, textures);
    }
    gl.DeleteProgram(program);
    gl.DeleteShader(vShader);
    gl.DeleteShader(fShader);
    screen.stop();
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

try {
    await mainloop(frame);
} catch (error) {
    console.error("Error in main loop:", error);
    cleanup();
}

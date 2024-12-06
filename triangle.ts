import {
    createWindow,
    getProcAddress,
    mainloop,
} from "https://deno.land/x/dwm@0.3.4/mod.ts";
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gles23.2.ts";

const window = createWindow({
    title: "DenoGL Texture",
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

const vShader = loadShader(gl.VERTEX_SHADER, vShaderSrc);
const fShader = loadShader(gl.FRAGMENT_SHADER, fShaderSrc);

const program = gl.CreateProgram();
gl.AttachShader(program, vShader);
gl.AttachShader(program, fShader);

gl.BindAttribLocation(program, 0, new TextEncoder().encode("vPosition\0"));
gl.BindAttribLocation(program, 1, new TextEncoder().encode("vTexCoord\0"));

gl.LinkProgram(program);

const status = new Int32Array(1);
gl.GetProgramiv(program, gl.LINK_STATUS, status);
if (status[0] === gl.FALSE) {
    const logLength = new Int32Array(1);
    gl.GetProgramiv(program, gl.INFO_LOG_LENGTH, logLength);
    const log = new Uint8Array(logLength[0]);
    gl.GetProgramInfoLog(program, logLength[0], logLength, log);
    console.log(new TextDecoder().decode(log));
    gl.DeleteProgram(program);
    Deno.exit(1);
}

// Create texture
const texture = new Uint32Array(1);
gl.GenTextures(1, texture);
gl.BindTexture(gl.TEXTURE_2D, texture[0]);

// Set texture parameters
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

gl.ClearColor(0.0, 0.0, 0.0, 1.0);

addEventListener("resize", (event) => {
    gl.Viewport(0, 0, event.width, event.height);
});

function frame() {
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

    gl.EnableVertexAttribArray(0);
    gl.EnableVertexAttribArray(1);

    // Bind texture
    gl.ActiveTexture(gl.TEXTURE0);
    gl.BindTexture(gl.TEXTURE_2D, texture[0]);

    // Set texture uniform
    const texLoc = gl.GetUniformLocation(program, new TextEncoder().encode("uTexture\0"));
    gl.Uniform1i(texLoc, 0);

    gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);
    window.swapBuffers();
}

await mainloop(frame);
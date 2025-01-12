import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, getProcAddress } from "https://deno.land/x/dwm@0.3.4/mod.ts";
import { flipVertical } from "./screenutils.ts";

export class OpenGLManager {
    private texture: Uint32Array | null = null;

    checkGLError(message: string) {
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

    initialize() {
        // Create window and initialize GL
        const window = createWindow({
            title: "Texture Overlay",
            width: 1,
            height: 1,
            resizable: false,
            visible: false,
            glVersion: [3, 2],
            gles: false,
        });

        gl.load(getProcAddress);
        this.checkGLError("gl.load");

        this.texture = new Uint32Array(1);
        gl.GenTextures(1, this.texture);
        gl.BindTexture(gl.TEXTURE_2D, this.texture[0]);
        gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.checkGLError("texture creation");
    }

    createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
        const flippedPixels = flipVertical(pixels, width, height);
        if (this.texture === null) { throw new Error("texture is null"); }

        gl.BindTexture(gl.TEXTURE_2D, this.texture[0]);
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

        this.checkGLError("upload texture data");
    }

    getTexture(): Uint32Array | null {
        return this.texture;
    }
}

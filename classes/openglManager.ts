import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress } from "@gfx/dwm";
import { flipVertical } from "./screenutils.ts";

export class OpenGLManager {
    private texture: Uint32Array | null = null;
    private window: DwmWindow | null = null;
    private uniqueId: string;

    constructor() {
        // Generate a crypto UUID for unique window identification
        this.uniqueId = crypto.randomUUID();
    }

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

    initialize(name?: string) {
        // Create window and initialize GL with unique title
        try {
            const windowTitle = `${name || "Texture Overlay"}_${this.uniqueId.slice(0, 8)}`;

            this.window = createWindow({
                title: windowTitle,
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
        } catch (error) {
            console.error(`Failed to create window: ${(error as Error).message}`);
            throw error;
        }
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
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            flippedPixels
        );

        this.checkGLError("upload texture data");
    }

    getTexture(): Uint32Array | null {
        return this.texture;
    }

    cleanup() {
        if (this.texture) {
            const textureToDelete = new Uint32Array(1);
            textureToDelete[0] = this.texture[0];
            gl.DeleteTextures(1, textureToDelete);
            this.texture = null;
        }

        if (this.window) {
            this.window.close();
            this.window = null;
        }
    }
}
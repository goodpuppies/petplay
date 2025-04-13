import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress } from "@gfx/dwm";
import { flipVertical } from "./screenutils.ts";

import { cstr } from "https://deno.land/x/dwm@0.3.4/src/platform/glfw/ffi.ts";

export class OpenGLManager {
    private texture: Uint32Array | null = null; // Output Panorama Texture
    private sourceTexture: Uint32Array | null = null; // Input Combined Eye Texture
    private window: DwmWindow | null = null;
    private uniqueId: string;
    private shaderProgram: gl.GLuint | null = null; // Adjust type based on gluten bindings if needed
    private vao: gl.GLuint | null = null; // Use appropriate type for VAO ID (e.g., number or specific type)
    private fbo: gl.GLuint | null = null; // Use appropriate type for FBO ID
    private uniformLocations: {
        sourceTexture?: gl.GLint | null;
        lookRotation?: gl.GLint | null;
        halfFOVInRadians?: gl.GLint | null;
        // Add VargglesBlock location if using UBOs
    } = {};
    private outputWidth: number = 0; // Store dimensions for viewport
    private outputHeight: number = 0;

    

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
            console.trace(); // Add stack trace for better debugging
            return false; // Indicate an error occurred
        }
        return true; // Indicate success
    }

    // Placeholder for shader loading function
    private loadShaderSourceSync(path: string): string { // Renamed and made synchronous
        // Implement file reading logic here (e.g., using Deno.readTextFileSync)
        try {
            return Deno.readTextFileSync(path); // Use synchronous version
        } catch (e) {
            console.error(`Failed to load shader ${path}:`, e);
            throw e;
        }
    }


    private compileShader(source: string, type: gl.GLenum): gl.GLuint | null { // Use appropriate return type if not WebGLShader
        const typeString = type === gl.VERTEX_SHADER ? 'VERTEX' : (type === gl.FRAGMENT_SHADER ? 'FRAGMENT' : 'UNKNOWN');
        console.log(`--- Compiling ${typeString} Shader ---`);
        const shader = gl.CreateShader(type);
        if (!shader || shader === 0) { // Check for 0 as well, common for GLuint handles
            console.error(`Failed to create ${typeString} shader object.`);
            this.checkGLError(`CreateShader (${typeString})`);
            return null;
        }
        console.log(`Created ${typeString} shader object: ID ${shader}`);

        // Prepare arguments exactly as in the example
        const encodedSource = new TextEncoder().encode(source);
        const sourcePtr = Deno.UnsafePointer.of(encodedSource);
        const sourcePtrValue = BigInt(Deno.UnsafePointer.value(sourcePtr));
        const sourcePtrArray = new BigUint64Array([sourcePtrValue]);
        const sourcePtrBufferView = new Uint8Array(sourcePtrArray.buffer);
        const sourceLengthArray = new Int32Array([source.length]);

        console.log(`Sourcing shader ID ${shader}...`);
        gl.ShaderSource(
            shader,
            1, // count
            sourcePtrBufferView,
            sourceLengthArray
        );
        if (!this.checkGLError(`ShaderSource (${typeString})`)) {
            gl.DeleteShader(shader);
            return null;
        }
        console.log(`Sourced shader ID ${shader}.`);

        console.log(`Compiling shader ID ${shader}...`);
        gl.CompileShader(shader);
        if (!this.checkGLError(`CompileShader (${typeString})`)) {
            gl.DeleteShader(shader);
            return null;
        }
        console.log(`Compile command issued for shader ID ${shader}.`);

        const status = new Int32Array(1);
        gl.GetShaderiv(shader, gl.COMPILE_STATUS, status);
        this.checkGLError(`GetShaderiv COMPILE_STATUS (${typeString})`);

        if (status[0] === gl.FALSE) { // Check against gl.FALSE explicitly
            console.error(`!!! ${typeString} Shader ID ${shader} compilation FAILED !!!`);
            const logLength = new Int32Array(1);
            gl.GetShaderiv(shader, gl.INFO_LOG_LENGTH, logLength);
            this.checkGLError(`GetShaderiv INFO_LOG_LENGTH (${typeString})`);

            const log = new Uint8Array(logLength[0]);
            if (logLength[0] > 0) {
                const actualLength = new Int32Array(1); // To get the actual length written
                gl.GetShaderInfoLog(shader, log.length, actualLength, log);
                this.checkGLError(`GetShaderInfoLog (${typeString})`);
                console.error(`--- ${typeString} Shader Compile Log (ID ${shader}) ---`);
                console.error(new TextDecoder().decode(log.slice(0, actualLength[0])));
                console.error(`--- End ${typeString} Shader Compile Log ---`);
            } else {
                console.error(`Shader Compile Error (type ${typeString}, ID ${shader}): No info log available, but compile status is FALSE.`);
            }

            gl.DeleteShader(shader);
            return null;
        }
        console.log(`+++ ${typeString} Shader ID ${shader} compiled SUCCESSFULLY. +++`);
        return shader; // Return the shader ID/handle
    }

    initializeOLD(name?: string) {
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

    initialize(name?: string, panoramaWidth: number = 1024, panoramaHeight: number = 1024) {
        console.log("--- Initializing OpenGLManager ---");
        try {
            const windowTitle = `${name || "Texture Overlay"}_${this.uniqueId.slice(0, 8)}`;
            console.log(`Creating window: ${windowTitle}`);
            this.window = createWindow({
                title: windowTitle,
                width: 1, // Minimal size as it's offscreen
                height: 1,
                resizable: false,
                visible: false, // Keep it hidden
                glVersion: [4, 6], // Requesting GL 4.6 Core Profile
                gles: false,
                // Ensure core profile if needed by shaders/extensions
                // glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
            });
            console.log("Window created.");

            console.log("Loading GL functions via gluten/getProcAddress...");
            gl.load(getProcAddress);
            if (!this.checkGLError("gl.load")) {
                throw new Error("Failed to load OpenGL functions.");
            }
            const version = gl.GetString(gl.VERSION) as Deno.PointerObject<unknown>;
            const vendor = gl.GetString(gl.VENDOR) as Deno.PointerObject<unknown>;
            const renderer = gl.GetString(gl.RENDERER) as Deno.PointerObject<unknown>;
            console.log(`OpenGL Initialized:
  Version:  ${version ? new TextDecoder().decode(Deno.UnsafePointerView.getArrayBuffer(version, 20)) : 'N/A'}...
  Vendor:   ${vendor ? new TextDecoder().decode(Deno.UnsafePointerView.getArrayBuffer(vendor, 20)) : 'N/A'}...
  Renderer: ${renderer ? new TextDecoder().decode(Deno.UnsafePointerView.getArrayBuffer(renderer, 20)) : 'N/A'}...`);


            // --- Shader Setup ---
            console.log("--- Starting Shader Setup ---");
            const vertSource = this.loadShaderSourceSync("c:\\GIT\\petplay\\resources\\varggles.vert");
            const fragSource = this.loadShaderSourceSync("c:\\GIT\\petplay\\resources\\varggles.frag");

            const vertexShader = this.compileShader(vertSource, gl.VERTEX_SHADER);
            const fragmentShader = this.compileShader(fragSource, gl.FRAGMENT_SHADER);

            if (!vertexShader || !fragmentShader) {
                console.error("Shader compilation failed. Aborting initialization.");
                throw new Error("Shader compilation failed");
            }
            console.log(`Vertex Shader ID: ${vertexShader}, Fragment Shader ID: ${fragmentShader}`);

            console.log("Creating shader program...");
            this.shaderProgram = gl.CreateProgram();
            if (!this.shaderProgram || this.shaderProgram === 0) {
                console.error("Failed to create shader program.");
                this.checkGLError("CreateProgram");
                // Clean up compiled shaders if program creation fails
                if (vertexShader) gl.DeleteShader(vertexShader);
                if (fragmentShader) gl.DeleteShader(fragmentShader);
                throw new Error("Failed to create shader program");
            }
            console.log(`Created shader program: ID ${this.shaderProgram}`);

            console.log(`Attaching shaders (VS: ${vertexShader}, FS: ${fragmentShader}) to program ${this.shaderProgram}...`);
            gl.AttachShader(this.shaderProgram, vertexShader);
            this.checkGLError("AttachShader VERTEX");
            gl.AttachShader(this.shaderProgram, fragmentShader);
            this.checkGLError("AttachShader FRAGMENT");
            console.log("Shaders attached.");

            console.log(`Linking program ${this.shaderProgram}...`);
            gl.LinkProgram(this.shaderProgram);
            if (!this.checkGLError(`LinkProgram`)) {
                // Clean up shaders and program if linking fails
                gl.DeleteShader(vertexShader);
                gl.DeleteShader(fragmentShader);
                gl.DeleteProgram(this.shaderProgram);
                this.shaderProgram = null;
                throw new Error("Shader program linking failed");
            }
            console.log(`Link command issued for program ${this.shaderProgram}.`);

            const linkStatus = new Int32Array(1);
            gl.GetProgramiv(this.shaderProgram, gl.LINK_STATUS, linkStatus);
            this.checkGLError("GetProgramiv LINK_STATUS");

            if (!linkStatus[0]) {
                console.error(`!!! Shader program ID ${this.shaderProgram} linking FAILED !!!`);
                const log = new Uint8Array(1024); // Increased buffer size
                const logLength = new Int32Array(1);
                gl.GetProgramInfoLog(this.shaderProgram, log.length, logLength, log);
                this.checkGLError("GetProgramInfoLog LINK_STATUS");
                console.error(`--- Program Link Log (ID ${this.shaderProgram}) ---`);
                console.error(new TextDecoder().decode(log.slice(0, logLength[0])));
                console.error(`--- End Program Link Log ---`);
                // Clean up shaders and program if linking fails
                gl.DeleteShader(vertexShader);
                gl.DeleteShader(fragmentShader);
                gl.DeleteProgram(this.shaderProgram);
                this.shaderProgram = null;
                throw new Error("Shader linking failed");
            }
            console.log(`+++ Shader program ID ${this.shaderProgram} linked SUCCESSFULLY. +++`);

            // Shaders can be deleted after successful linking
            console.log(`Detaching and deleting shaders (VS: ${vertexShader}, FS: ${fragmentShader})...`);
            gl.DetachShader(this.shaderProgram, vertexShader); // Optional but good practice
            gl.DeleteShader(vertexShader);
            gl.DetachShader(this.shaderProgram, fragmentShader); // Optional but good practice
            gl.DeleteShader(fragmentShader);
            console.log("Shaders detached and deleted.");

            console.log(`Using program ${this.shaderProgram} to get uniform locations...`);
            gl.UseProgram(this.shaderProgram);
            this.checkGLError("UseProgram (for uniforms)");

            const sourceTexLocName = "sourceTexture";
            const lookRotLocName = "lookRotation";
            const fovLocName = "halfFOVInRadians";

            this.uniformLocations.sourceTexture = gl.GetUniformLocation(this.shaderProgram, cstr(sourceTexLocName));
            this.checkGLError(`GetUniformLocation ${sourceTexLocName}`);
            console.log(`Uniform location '${sourceTexLocName}': ${this.uniformLocations.sourceTexture}`);

            this.uniformLocations.lookRotation = gl.GetUniformLocation(this.shaderProgram, cstr(lookRotLocName));
            this.checkGLError(`GetUniformLocation ${lookRotLocName}`);
            console.log(`Uniform location '${lookRotLocName}': ${this.uniformLocations.lookRotation}`);

            this.uniformLocations.halfFOVInRadians = gl.GetUniformLocation(this.shaderProgram, cstr(fovLocName));
            this.checkGLError(`GetUniformLocation ${fovLocName}`);
            console.log(`Uniform location '${fovLocName}': ${this.uniformLocations.halfFOVInRadians}`);

            // Set the sampler uniform only once (it points to texture unit 0)
            if (this.uniformLocations.sourceTexture !== null && this.uniformLocations.sourceTexture !== -1) { // Check for valid location (-1 often indicates not found)
                console.log(`Setting uniform '${sourceTexLocName}' (loc=${this.uniformLocations.sourceTexture}) to texture unit 0.`);
                gl.Uniform1i(this.uniformLocations.sourceTexture, 0); // Texture Unit 0
                this.checkGLError(`Uniform1i ${sourceTexLocName}`);
            } else {
                console.warn(`Uniform '${sourceTexLocName}' not found or inactive.`);
            }

            console.log("Unbinding shader program.");
            gl.UseProgram(0); // Unbind program for now
            this.checkGLError("UseProgram(0)");
            console.log("--- Shader Setup Complete ---");

            // --- Texture Setup ---
            console.log("--- Starting Texture Setup ---");
            this.outputWidth = panoramaWidth;
            this.outputHeight = panoramaHeight;
            console.log(`Output dimensions: ${this.outputWidth}x${this.outputHeight}`);

            // Output Texture (this.texture)
            this.texture = new Uint32Array(1);
            gl.GenTextures(1, this.texture);
            console.log(`Generated output texture ID: ${this.texture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.texture[0]);
            this.checkGLError("GenTextures/BindTexture output");
            console.log(`Allocating output texture storage (${this.outputWidth}x${this.outputHeight}, RGBA)...`);
            gl.TexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.outputWidth, this.outputHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); // Allocate storage
            this.checkGLError("TexImage2D output");
            console.log("Setting output texture parameters (LINEAR, CLAMP_TO_EDGE)...");
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri output");

            // Input Texture (this.sourceTexture)
            this.sourceTexture = new Uint32Array(1);
            gl.GenTextures(1, this.sourceTexture);
            console.log(`Generated source texture ID: ${this.sourceTexture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.sourceTexture[0]);
            this.checkGLError("GenTextures/BindTexture source");
            console.log("Setting source texture parameters (LINEAR, CLAMP_TO_EDGE)...");
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri source");
            console.log("Unbinding source texture.");
            gl.BindTexture(gl.TEXTURE_2D, 0); // Unbind
            this.checkGLError("Unbind source texture");
            console.log("--- Texture Setup Complete ---");


            // --- Framebuffer Object (FBO) Setup ---
            console.log("--- Starting FBO Setup ---");
            const fboId = new Uint32Array(1);
            gl.GenFramebuffers(1, fboId);
            this.fbo = fboId[0];
            console.log(`Generated FBO ID: ${this.fbo}`);
            gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            this.checkGLError("GenFramebuffers/BindFramebuffer");
            console.log(`Attaching output texture (ID: ${this.texture[0]}) to FBO ${this.fbo} COLOR_ATTACHMENT0...`);
            gl.FramebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture[0], 0);
            this.checkGLError("FramebufferTexture2D");

            console.log(`Checking FBO status (ID: ${this.fbo})...`);
            const fboStatus = gl.CheckFramebufferStatus(gl.FRAMEBUFFER);
            if (fboStatus !== gl.FRAMEBUFFER_COMPLETE) {
                console.error(`!!! Framebuffer (ID: ${this.fbo}) is not complete: Status ${fboStatus} !!!`);
                // Provide more specific error messages if possible
                const statusMessages: { [key: number]: string } = {
                    [gl.FRAMEBUFFER_UNDEFINED]: "GL_FRAMEBUFFER_UNDEFINED",
                    [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: "GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT",
                    [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: "GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT",
                    [gl.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER]: "GL_FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER",
                    [gl.FRAMEBUFFER_INCOMPLETE_READ_BUFFER]: "GL_FRAMEBUFFER_INCOMPLETE_READ_BUFFER",
                    [gl.FRAMEBUFFER_UNSUPPORTED]: "GL_FRAMEBUFFER_UNSUPPORTED",
                    [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: "GL_FRAMEBUFFER_INCOMPLETE_MULTISAMPLE",
                    [gl.FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS]: "GL_FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS",
                };
                console.error(`Framebuffer Status Code: ${statusMessages[fboStatus] || 'Unknown Status'}`);
                gl.BindFramebuffer(gl.FRAMEBUFFER, 0); // Unbind before throwing
                gl.DeleteFramebuffers(1, fboId); // Clean up FBO
                this.fbo = null;
                throw new Error("Framebuffer setup failed");
            }
            console.log(`+++ FBO (ID: ${this.fbo}) is complete. +++`);
            console.log(`Unbinding FBO ${this.fbo}.`);
            gl.BindFramebuffer(gl.FRAMEBUFFER, 0); // Unbind FBO
            this.checkGLError("Unbind FBO");
            console.log("--- FBO Setup Complete ---");

            // --- Vertex Array Object (VAO) Setup ---
            console.log("--- Starting VAO Setup ---");
            const vaoId = new Uint32Array(1);
            gl.GenVertexArrays(1, vaoId);
            this.vao = vaoId[0];
            console.log(`Generated VAO ID: ${this.vao}`);
            // No buffer binding needed if using gl_VertexID for quad generation
            // Bind and unbind just to be sure it's created correctly
            gl.BindVertexArray(this.vao);
            gl.BindVertexArray(0);
            this.checkGLError("VAO setup");
            console.log("--- VAO Setup Complete ---");

            console.log("--- OpenGLManager Initialization Successful ---");

        } catch (error) {
            console.error(`!!! OpenGLManager Initialization FAILED: ${(error as Error).message} !!!`);
            console.error("Attempting cleanup...");
            this.cleanup(); // Attempt to clean up any partially created resources
            throw error; // Re-throw the error after logging and cleanup attempt
        }
    }

    // This function now performs rendering using the shaders
    // It assumes initialize() has been called successfully.
    // Needs lookRotation (e.g., Float32Array[16]) and halfFOVInRadians (number)
    renderPanoramaFromData(
        pixels: Uint8Array,
        width: number,
        height: number,
        lookRotation: Float32Array, // Assuming Mat4 is represented as Float32Array[16]
        halfFOVInRadians: number,
        noFlip?: boolean
    ): void {
        // console.log("--- Rendering Panorama ---"); // Optional: Log render calls
        if (!this.fbo || !this.shaderProgram || !this.vao || !this.sourceTexture || !this.texture) {
            console.error("Render call failed: OpenGL resources not initialized.");
            throw new Error("OpenGL resources not initialized. Call initialize() first.");
        }
        if (this.uniformLocations.lookRotation === null || this.uniformLocations.lookRotation === -1 ||
            this.uniformLocations.halfFOVInRadians === null || this.uniformLocations.halfFOVInRadians === -1) {
            console.error("Render call failed: Required uniform locations not found.");
            throw new Error("Uniform locations not found.");
        }

        // 1. Upload Pixel Data to Source Texture
        // console.log(`Uploading ${width}x${height} source texture data...`); // Optional
        let pixelsToUpload = noFlip ? pixels : flipVertical(pixels, width, height);
        gl.ActiveTexture(gl.TEXTURE0); // Activate texture unit 0
        gl.BindTexture(gl.TEXTURE_2D, this.sourceTexture[0]);
        gl.TexImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixelsToUpload
        );
        if (!this.checkGLError("upload source texture data")) return; // Stop if error

        // 2. Bind FBO
        // console.log(`Binding FBO ${this.fbo}...`); // Optional
        gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        if (!this.checkGLError("bind FBO")) return;

        // 3. Set Viewport
        // console.log(`Setting viewport to ${this.outputWidth}x${this.outputHeight}...`); // Optional
        gl.Viewport(0, 0, this.outputWidth, this.outputHeight);
        if (!this.checkGLError("set viewport")) return;

        // 4. Clear (Optional)
        // gl.ClearColor(0.0, 0.0, 0.0, 1.0);
        // gl.Clear(gl.COLOR_BUFFER_BIT);

        // 5. Use Shader Program
        // console.log(`Using shader program ${this.shaderProgram}...`); // Optional
        gl.UseProgram(this.shaderProgram);
        if (!this.checkGLError("use program")) return;

        // 6. Set Uniforms
        // console.log("Setting uniforms..."); // Optional
        // Texture unit 0 is already bound and the sampler uniform is set to 0 in initialize
        gl.UniformMatrix4fv(this.uniformLocations.lookRotation!, 1, 0, lookRotation); // Assuming transpose is false (0)
        gl.Uniform1f(this.uniformLocations.halfFOVInRadians!, halfFOVInRadians);
        if (!this.checkGLError("set uniforms")) return;

        // 7. Bind VAO
        // console.log(`Binding VAO ${this.vao}...`); // Optional
        gl.BindVertexArray(this.vao);
        if (!this.checkGLError("bind VAO")) return;

        // 8. Draw Fullscreen Quad
        // console.log("Drawing arrays (TRIANGLE_STRIP, 0, 4)..."); // Optional
        gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (!this.checkGLError("draw arrays")) return;

        // 9. Unbind resources
        // console.log("Unbinding resources..."); // Optional
        gl.BindVertexArray(0);
        gl.UseProgram(0);
        gl.BindFramebuffer(gl.FRAMEBUFFER, 0);
        gl.BindTexture(gl.TEXTURE_2D, 0); // Unbind source texture
        // console.log("--- Panorama Rendering Complete ---"); // Optional
    }

    createTextureFromData(pixels: Uint8Array, width: number, height: number, noFlip?: boolean): void {
        let pixelsX
        if (!noFlip) pixelsX = flipVertical(pixels, width, height);
        else pixelsX = pixels

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
            pixelsX
        );

        this.checkGLError("upload texture data");
    }

    createPanoramaTextureFromData(pixels: Uint8Array, width: number, height: number, noFlip?: boolean): void {
        let pixelsX
        if (!noFlip) pixelsX = flipVertical(pixels, width, height);
        else pixelsX = pixels

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
            pixelsX
        );

        this.checkGLError("upload texture data");
    }

    getTexture(): Uint32Array | null {
        return this.texture;
    }

    cleanup() {
        console.log("--- Cleaning up OpenGLManager resources ---");
        // Use a temporary array for deletion functions that expect one
        const idArray = new Uint32Array(1);

        if (this.fbo) {
            console.log(`Deleting FBO ID: ${this.fbo}`);
            idArray[0] = this.fbo;
            gl.DeleteFramebuffers(1, idArray);
            this.fbo = null;
        }
        if (this.vao) {
            console.log(`Deleting VAO ID: ${this.vao}`);
            idArray[0] = this.vao;
            gl.DeleteVertexArrays(1, idArray);
            this.vao = null;
        }
        if (this.shaderProgram) {
            console.log(`Deleting Shader Program ID: ${this.shaderProgram}`);
            // No need for array for DeleteProgram
            gl.DeleteProgram(this.shaderProgram);
            this.shaderProgram = null;
        }
        if (this.sourceTexture) {
            console.log(`Deleting Source Texture ID: ${this.sourceTexture[0]}`);
            // gl.DeleteTextures expects an array
            gl.DeleteTextures(1, this.sourceTexture);
            this.sourceTexture = null;
        }
        if (this.texture) {
            console.log(`Deleting Output Texture ID: ${this.texture[0]}`);
            // gl.DeleteTextures expects an array
            gl.DeleteTextures(1, this.texture);
            this.texture = null;
        }

        if (this.window) {
            console.log("Closing window...");
            this.window.close();
            this.window = null;
            console.log("Window closed.");
        }
        console.log("--- OpenGLManager Cleanup Complete ---");
    }
}
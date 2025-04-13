import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress } from "@gfx/dwm";
import { flipVertical } from "./screenutils.ts";

import { cstr } from "https://deno.land/x/dwm@0.3.4/src/platform/glfw/ffi.ts";

export class OpenGLManager {
    private outputTexture: Uint32Array | null = null; // Renamed for clarity
    private leftEyeTexture: Uint32Array | null = null; // Texture for Left Eye
    private rightEyeTexture: Uint32Array | null = null; // Texture for Right Eye
    private window: DwmWindow | null = null;
    private uniqueId: string;
    private shaderProgram: gl.GLuint | null = null; // Adjust type based on gluten bindings if needed
    private vao: gl.GLuint | null = null; // Use appropriate type for VAO ID (e.g., number or specific type)
    private fbo: gl.GLuint | null = null; // Use appropriate type for FBO ID
    private uniformLocations: {
        eyeLeft?: gl.GLint | null;         // Sampler uniform for left eye
        eyeRight?: gl.GLint | null;        // Sampler uniform for right eye
        lookRotation?: gl.GLint | null;
        halfFOVInRadians?: gl.GLint | null;
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

    initialize(name?: string, panoramaWidth: number = 4096, panoramaHeight: number = 4096) { // Default to 4096x4096
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

            const eyeLeftLocName = "eyeLeft";
            const eyeRightLocName = "eyeRight";
            const lookRotLocName = "lookRotation";
            const fovLocName = "halfFOVInRadians";

            // Get locations for the two samplers and other uniforms
            this.uniformLocations.eyeLeft = gl.GetUniformLocation(this.shaderProgram!, cstr(eyeLeftLocName));
            this.checkGLError(`GetUniformLocation ${eyeLeftLocName}`);
            console.log(`Uniform location '${eyeLeftLocName}': ${this.uniformLocations.eyeLeft}`);

            this.uniformLocations.eyeRight = gl.GetUniformLocation(this.shaderProgram!, cstr(eyeRightLocName));
            this.checkGLError(`GetUniformLocation ${eyeRightLocName}`);
            console.log(`Uniform location '${eyeRightLocName}': ${this.uniformLocations.eyeRight}`);

            this.uniformLocations.lookRotation = gl.GetUniformLocation(this.shaderProgram!, cstr(lookRotLocName));
            this.checkGLError(`GetUniformLocation ${lookRotLocName}`);
            console.log(`Uniform location '${lookRotLocName}': ${this.uniformLocations.lookRotation}`);

            this.uniformLocations.halfFOVInRadians = gl.GetUniformLocation(this.shaderProgram!, cstr(fovLocName));
            this.checkGLError(`GetUniformLocation ${fovLocName}`);
            console.log(`Uniform location '${fovLocName}': ${this.uniformLocations.halfFOVInRadians}`);

            // --- Set Sampler Uniforms (Point to Texture Units) ---
            if (this.uniformLocations.eyeLeft !== null && this.uniformLocations.eyeLeft !== -1) {
                console.log(`Setting uniform '${eyeLeftLocName}' (loc=${this.uniformLocations.eyeLeft}) to texture unit 0.`);
                gl.Uniform1i(this.uniformLocations.eyeLeft, 0); // eyeLeft uses Texture Unit 0
                this.checkGLError(`Uniform1i ${eyeLeftLocName}`);
            } else { console.warn(`Uniform '${eyeLeftLocName}' not found or inactive.`); }

            if (this.uniformLocations.eyeRight !== null && this.uniformLocations.eyeRight !== -1) {
                console.log(`Setting uniform '${eyeRightLocName}' (loc=${this.uniformLocations.eyeRight}) to texture unit 1.`);
                gl.Uniform1i(this.uniformLocations.eyeRight, 1); // eyeRight uses Texture Unit 1
                this.checkGLError(`Uniform1i ${eyeRightLocName}`);
            } else { console.warn(`Uniform '${eyeRightLocName}' not found or inactive.`); }

            console.log("Unbinding shader program.");
            gl.UseProgram(0);
            this.checkGLError("UseProgram(0)");
            console.log("--- Shader Setup Complete ---");

            // --- Texture Setup ---
            console.log("--- Starting Texture Setup ---");
            this.outputWidth = panoramaWidth;
            this.outputHeight = panoramaHeight;
            console.log(`Output dimensions: ${this.outputWidth}x${this.outputHeight}`);
            console.warn(`--- WARNING: Using ${this.outputWidth}x${this.outputHeight} output. VROverlayFlags_StereoPanorama strongly prefers a 2:1 aspect ratio for correct mapping. Visual distortions may occur. ---`);

            // Output Texture (this.outputTexture)
            this.outputTexture = new Uint32Array(1);
            gl.GenTextures(1, this.outputTexture);
            console.log(`Generated output texture ID: ${this.outputTexture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.outputTexture[0]);
            this.checkGLError("GenTextures/BindTexture output");
            gl.TexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.outputWidth, this.outputHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this.checkGLError("TexImage2D output");
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri output");

            // Input Texture (Left Eye)
            this.leftEyeTexture = new Uint32Array(1);
            gl.GenTextures(1, this.leftEyeTexture);
            console.log(`Generated left eye texture ID: ${this.leftEyeTexture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.leftEyeTexture[0]);
            this.checkGLError("GenTextures/BindTexture left eye");
            // Set parameters (allocate storage later during render)
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri left eye");

            // Input Texture (Right Eye)
            this.rightEyeTexture = new Uint32Array(1);
            gl.GenTextures(1, this.rightEyeTexture);
            console.log(`Generated right eye texture ID: ${this.rightEyeTexture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);
            this.checkGLError("GenTextures/BindTexture right eye");
            // Set parameters (allocate storage later during render)
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri right eye");

            console.log("Unbinding textures.");
            gl.BindTexture(gl.TEXTURE_2D, 0);
            this.checkGLError("Unbind textures");
            console.log("--- Texture Setup Complete ---");

            // --- Framebuffer Object (FBO) Setup ---
            console.log("--- Starting FBO Setup ---");
            const fboId = new Uint32Array(1);
            gl.GenFramebuffers(1, fboId);
            this.fbo = fboId[0];
            console.log(`Generated FBO ID: ${this.fbo}`);
            gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            this.checkGLError("GenFramebuffers/BindFramebuffer");
            // Attach the single *output* texture
            console.log(`Attaching output texture (ID: ${this.outputTexture[0]}) to FBO ${this.fbo} COLOR_ATTACHMENT0...`);
            gl.FramebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outputTexture[0], 0);
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


    renderPanoramaFromData(
        leftPixels: Uint8Array,
        rightPixels: Uint8Array,
        eyeWidth: number, // Width of ONE eye texture
        eyeHeight: number, // Height of ONE eye texture
        lookRotation: Float32Array,
        halfFOVInRadians: number
        // noFlip removed - shader handles texture coordinate interpretation
    ): void {
        if (!this.fbo || !this.shaderProgram || !this.vao || !this.leftEyeTexture || !this.rightEyeTexture || !this.outputTexture) {
            console.error("Render call failed: OpenGL resources not initialized.");
            throw new Error("OpenGL resources not initialized.");
        }
        // Check uniforms needed for this shader
        if (this.uniformLocations.lookRotation === null || this.uniformLocations.lookRotation === -1 ||
            this.uniformLocations.halfFOVInRadians === null || this.uniformLocations.halfFOVInRadians === -1 ||
            this.uniformLocations.eyeLeft === null || this.uniformLocations.eyeLeft === -1 || // Check sampler uniforms
            this.uniformLocations.eyeRight === null || this.uniformLocations.eyeRight === -1) {
            console.error("Render call failed: Required uniform locations not found.");
            throw new Error("Uniform locations not found.");
        }

        // --- 1. Upload Pixel Data to Separate Eye Textures ---
        // Left Eye Texture
        gl.ActiveTexture(gl.TEXTURE0); // Activate texture unit 0 for left eye
        gl.BindTexture(gl.TEXTURE_2D, this.leftEyeTexture[0]);
        gl.TexImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, eyeWidth, eyeHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, leftPixels
        );
        if (!this.checkGLError("upload left eye texture data")) return;

        // Right Eye Texture
        gl.ActiveTexture(gl.TEXTURE1); // Activate texture unit 1 for right eye
        gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);
        gl.TexImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, eyeWidth, eyeHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, rightPixels
        );
        if (!this.checkGLError("upload right eye texture data")) return;

        // --- 2. Bind FBO, Set Viewport ---
        gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        if (!this.checkGLError("bind FBO")) return;
        gl.Viewport(0, 0, this.outputWidth, this.outputHeight); // Render to the full output texture
        if (!this.checkGLError("set viewport")) return;
        // Optional: gl.Clear(...) if needed

        // --- 3. Use Shader Program ---
        gl.UseProgram(this.shaderProgram);
        if (!this.checkGLError("use program")) return;

        // --- 4. Set Non-Sampler Uniforms ---
        gl.UniformMatrix4fv(this.uniformLocations.lookRotation!, 1, 0, lookRotation); // transpose = 0 (false) for column-major
        gl.Uniform1f(this.uniformLocations.halfFOVInRadians!, halfFOVInRadians);
        if (!this.checkGLError("set uniforms")) return;

        // --- 5. Ensure Correct Textures are Bound to Correct Units ---
        // (Already done during upload, but good practice to re-affirm if unsure)
        gl.ActiveTexture(gl.TEXTURE0);
        gl.BindTexture(gl.TEXTURE_2D, this.leftEyeTexture[0]);
        gl.ActiveTexture(gl.TEXTURE1);
        gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);

        // --- 6. Bind VAO ---
        gl.BindVertexArray(this.vao);
        if (!this.checkGLError("bind VAO")) return;

        // --- 7. Draw Fullscreen Quad ---
        gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4); // Use TRIANGLE_STRIP for the standard quad
        if (!this.checkGLError("draw arrays")) return;

        // --- 8. Unbind resources ---
        gl.BindVertexArray(0);
        gl.UseProgram(0);
        gl.BindFramebuffer(gl.FRAMEBUFFER, 0);
        gl.ActiveTexture(gl.TEXTURE0); // Reset active texture unit
        gl.BindTexture(gl.TEXTURE_2D, 0); // Unbind textures
        gl.ActiveTexture(gl.TEXTURE1);
        gl.BindTexture(gl.TEXTURE_2D, 0);
        gl.ActiveTexture(gl.TEXTURE0); // Explicitly reset to unit 0

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

    // getTexture now returns the output texture ID
    getTexture(): Uint32Array | null {
        return this.outputTexture;
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
        if (this.leftEyeTexture) {
            console.log(`Deleting Left Eye Texture ID: ${this.leftEyeTexture[0]}`);
            gl.DeleteTextures(1, this.leftEyeTexture);
            this.leftEyeTexture = null;
        }
        if (this.rightEyeTexture) {
            console.log(`Deleting Right Eye Texture ID: ${this.rightEyeTexture[0]}`);
            gl.DeleteTextures(1, this.rightEyeTexture);
            this.rightEyeTexture = null;
        }

        // Delete the output texture
        if (this.outputTexture) {
            console.log(`Deleting Output Texture ID: ${this.outputTexture[0]}`);
            gl.DeleteTextures(1, this.outputTexture);
            this.outputTexture = null;
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
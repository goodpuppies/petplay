import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress } from "@gfx/dwm";
import { flipVertical } from "./screenutils.ts";

import { cstr } from "https://deno.land/x/dwm@0.3.4/src/platform/glfw/ffi.ts";
import { join } from "jsr:@std/path";

export class OpenGLManager {
    private outputTexture: Uint32Array | null = null; // Renamed for clarity
    private leftEyeTexture: Uint32Array | null = null; // Texture for Left Eye
    private rightEyeTexture: Uint32Array | null = null; // Texture for Right Eye
    private window: DwmWindow | null = null;
    private uniqueId: string;
    private shaderProgram: gl.GLuint | null = null; // Adjust type based on gluten bindings if needed
    private reprojectionShaderProgram: gl.GLuint | null = null; // Added for reprojection
    private vao: gl.GLuint | null = null; // Use appropriate type for VAO ID (e.g., number or specific type)
    private fbo: gl.GLuint | null = null; // Use appropriate type for FBO ID
    private uniformLocations: {
        eyeLeft?: gl.GLint | null;         // Sampler uniform for left eye
        eyeRight?: gl.GLint | null;        // Sampler uniform for right eye
        lookRotation?: gl.GLint | null;
        halfFOVInRadians?: gl.GLint | null;
    } = {};
    private reprojectionUniformLocations: {
        renderPoseMatrix?: gl.GLint | null;
        currentPoseMatrix?: gl.GLint | null;
        halfFOVInRadians?: gl.GLint | null; // Keep this as reprojection still needs FOV
        eyeLeft?: gl.GLint | null;
        eyeRight?: gl.GLint | null;
    } = {};
    private reprojectionEnabled: boolean = false; // Flag to indicate if reprojection shader is ready
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
            const basepath = join(import.meta.dirname!, "../resources")
            return Deno.readTextFileSync(join(basepath, path))
        } catch (e) {
            console.error(`Failed to load shader ${path}:`, e);
            throw e;
        }
    }

    private compileShader(source: string, type: gl.GLenum): gl.GLuint | null { // Use appropriate return type if not WebGLShader
        const typeString = type === gl.VERTEX_SHADER ? 'VERTEX' : (type === gl.FRAGMENT_SHADER ? 'FRAGMENT' : 'UNKNOWN');
        //console.log(`--- Compiling ${typeString} Shader ---`);
        const shader = gl.CreateShader(type);
        if (!shader || shader === 0) { // Check for 0 as well, common for GLuint handles
            console.error(`Failed to create ${typeString} shader object.`);
            this.checkGLError(`CreateShader (${typeString})`);
            return null;
        }
        //console.log(`Created ${typeString} shader object: ID ${shader}`);

        // Prepare arguments exactly as in the example
        const encodedSource = new TextEncoder().encode(source);
        const sourcePtr = Deno.UnsafePointer.of(encodedSource);
        const sourcePtrValue = BigInt(Deno.UnsafePointer.value(sourcePtr));
        const sourcePtrArray = new BigUint64Array([sourcePtrValue]);
        const sourcePtrBufferView = new Uint8Array(sourcePtrArray.buffer);
        const sourceLengthArray = new Int32Array([source.length]);

        //console.log(`Sourcing shader ID ${shader}...`);
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
        //console.log(`Sourced shader ID ${shader}.`);

        //console.log(`Compiling shader ID ${shader}...`);
        gl.CompileShader(shader);
        if (!this.checkGLError(`CompileShader (${typeString})`)) {
            gl.DeleteShader(shader);
            return null;
        }
        //.log(`Compile command issued for shader ID ${shader}.`);

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
        //console.log(`+++ ${typeString} Shader ID ${shader} compiled SUCCESSFULLY. +++`);
        return shader; // Return the shader ID/handle
    }

    initialize(name?: string, panoramaWidth: number = 4096, panoramaHeight: number = 4096) { // Default to 4096x4096
        //console.log("--- Initializing OpenGLManager ---");
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
            //console.log("Window created.");

            //console.log("Loading GL functions via gluten/getProcAddress...");
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
            //console.log("--- Starting Shader Setup ---");
            const vertSource = this.loadShaderSourceSync("varggles.vert");
            const fragSource = this.loadShaderSourceSync("varggles.frag");

            const vertexShader = this.compileShader(vertSource, gl.VERTEX_SHADER);
            const fragmentShader = this.compileShader(fragSource, gl.FRAGMENT_SHADER);

            if (!vertexShader || !fragmentShader) {
                console.error("Shader compilation failed. Aborting initialization.");
                throw new Error("Shader compilation failed");
            }
            //console.log(`Vertex Shader ID: ${vertexShader}, Fragment Shader ID: ${fragmentShader}`);

            //console.log("Creating shader program...");
            this.shaderProgram = gl.CreateProgram();
            if (!this.shaderProgram || this.shaderProgram === 0) {
                console.error("Failed to create shader program.");
                this.checkGLError("CreateProgram");
                // Clean up compiled shaders if program creation fails
                if (vertexShader) gl.DeleteShader(vertexShader);
                if (fragmentShader) gl.DeleteShader(fragmentShader);
                throw new Error("Failed to create shader program");
            }
            //console.log(`Created shader program: ID ${this.shaderProgram}`);

            //console.log(`Attaching shaders (VS: ${vertexShader}, FS: ${fragmentShader}) to program ${this.shaderProgram}...`);
            gl.AttachShader(this.shaderProgram, vertexShader);
            this.checkGLError("AttachShader VERTEX");
            gl.AttachShader(this.shaderProgram, fragmentShader);
            this.checkGLError("AttachShader FRAGMENT");
            //console.log("Shaders attached.");

            //console.log(`Linking program ${this.shaderProgram}...`);
            gl.LinkProgram(this.shaderProgram);
            if (!this.checkGLError(`LinkProgram`)) {
                // Clean up shaders and program if linking fails
                gl.DeleteShader(vertexShader);
                gl.DeleteShader(fragmentShader);
                gl.DeleteProgram(this.shaderProgram);
                this.shaderProgram = null;
                throw new Error("Shader program linking failed");
            }
            //console.log(`Link command issued for program ${this.shaderProgram}.`);

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
            //console.log(`+++ Shader program ID ${this.shaderProgram} linked SUCCESSFULLY. +++`);

            // Shaders can be deleted after successful linking
            //console.log(`Detaching and deleting shaders (VS: ${vertexShader}, FS: ${fragmentShader})...`);
            gl.DetachShader(this.shaderProgram, vertexShader); // Optional but good practice
            gl.DeleteShader(vertexShader);
            gl.DetachShader(this.shaderProgram, fragmentShader); // Optional but good practice
            gl.DeleteShader(fragmentShader);
            //console.log("Shaders detached and deleted.");

            //console.log(`Using program ${this.shaderProgram} to get uniform locations...`);
            gl.UseProgram(this.shaderProgram);
            this.checkGLError("UseProgram (for uniforms)");

            const eyeLeftLocName = "eyeLeft";
            const eyeRightLocName = "eyeRight";
            const lookRotLocName = "lookRotation";
            const fovLocName = "halfFOVInRadians";

            // Get locations for the two samplers and other uniforms
            this.uniformLocations.eyeLeft = gl.GetUniformLocation(this.shaderProgram!, cstr(eyeLeftLocName));
            this.checkGLError(`GetUniformLocation ${eyeLeftLocName}`);
            //console.log(`Uniform location '${eyeLeftLocName}': ${this.uniformLocations.eyeLeft}`);

            this.uniformLocations.eyeRight = gl.GetUniformLocation(this.shaderProgram!, cstr(eyeRightLocName));
            this.checkGLError(`GetUniformLocation ${eyeRightLocName}`);
            //console.log(`Uniform location '${eyeRightLocName}': ${this.uniformLocations.eyeRight}`);

            this.uniformLocations.lookRotation = gl.GetUniformLocation(this.shaderProgram!, cstr(lookRotLocName));
            this.checkGLError(`GetUniformLocation ${lookRotLocName}`);
            //console.log(`Uniform location '${lookRotLocName}': ${this.uniformLocations.lookRotation}`);

            this.uniformLocations.halfFOVInRadians = gl.GetUniformLocation(this.shaderProgram!, cstr(fovLocName));
            this.checkGLError(`GetUniformLocation ${fovLocName}`);
            //console.log(`Uniform location '${fovLocName}': ${this.uniformLocations.halfFOVInRadians}`);

            // --- Set Sampler Uniforms (Point to Texture Units) ---
            if (this.uniformLocations.eyeLeft !== null && this.uniformLocations.eyeLeft !== -1) {
                //console.log(`Setting uniform '${eyeLeftLocName}' (loc=${this.uniformLocations.eyeLeft}) to texture unit 0.`);
                gl.Uniform1i(this.uniformLocations.eyeLeft, 0); // eyeLeft uses Texture Unit 0
                this.checkGLError(`Uniform1i ${eyeLeftLocName}`);
            } else { console.warn(`Uniform '${eyeLeftLocName}' not found or inactive.`); }

            if (this.uniformLocations.eyeRight !== null && this.uniformLocations.eyeRight !== -1) {
                //console.log(`Setting uniform '${eyeRightLocName}' (loc=${this.uniformLocations.eyeRight}) to texture unit 1.`);
                gl.Uniform1i(this.uniformLocations.eyeRight, 1); // eyeRight uses Texture Unit 1
                this.checkGLError(`Uniform1i ${eyeRightLocName}`);
            } else { console.warn(`Uniform '${eyeRightLocName}' not found or inactive.`); }

            //console.log("Unbinding shader program.");
            gl.UseProgram(0);
            this.checkGLError("UseProgram(0)");
            //console.log("--- Shader Setup Complete ---");

            // --- Reprojection Shader Setup (Conditional) ---
            const reprojectionFragPath = "varggles_reprojection.frag";
            let reprojectionVertexShader: number | null = null; // Declare here for broader scope
            let reprojectionFragmentShader: number | null = null;
            try {
                //console.log("TRYINITI REPROJ")
                const reprojectionFragSource = this.loadShaderSourceSync(reprojectionFragPath);
                //console.log("--- Starting Reprojection Shader Setup ---");

                // Re-compile the *same* vertex shader source
                // Doing this ensures we have a valid vertex shader object even if the
                // original 'vertexShader' was deleted after linking the standard program.
                reprojectionVertexShader = this.compileShader(vertSource, gl.VERTEX_SHADER);
                reprojectionFragmentShader = this.compileShader(reprojectionFragSource, gl.FRAGMENT_SHADER);

                if (!reprojectionVertexShader || !reprojectionFragmentShader) {
                    console.error("Reprojection shader compilation failed. Reprojection disabled.");
                    // Clean up any successfully compiled shader
                    if (reprojectionVertexShader) gl.DeleteShader(reprojectionVertexShader);
                    if (reprojectionFragmentShader) gl.DeleteShader(reprojectionFragmentShader);
                    throw new Error("Reprojection shader compilation failed"); // Throw to skip rest of setup
                }
                //console.log(`Reprojection Shaders Compiled: VS ID ${reprojectionVertexShader}, FS ID ${reprojectionFragmentShader}`);

                //console.log("Creating reprojection shader program...");
                this.reprojectionShaderProgram = gl.CreateProgram();
                if (!this.reprojectionShaderProgram || this.reprojectionShaderProgram === 0) {
                    console.error("Failed to create reprojection shader program.");
                    this.checkGLError("CreateProgram reprojection");
                    if (reprojectionVertexShader) gl.DeleteShader(reprojectionVertexShader);
                    if (reprojectionFragmentShader) gl.DeleteShader(reprojectionFragmentShader);
                    throw new Error("Failed to create reprojection shader program");
                }
               // console.log(`Created reprojection shader program: ID ${this.reprojectionShaderProgram}`);

                //console.log(`Attaching shaders (VS: ${reprojectionVertexShader}, FS: ${reprojectionFragmentShader}) to reprojection program ${this.reprojectionShaderProgram}...`);
                gl.AttachShader(this.reprojectionShaderProgram, reprojectionVertexShader);
                this.checkGLError("AttachShader REPROJECTION VERTEX");
                gl.AttachShader(this.reprojectionShaderProgram, reprojectionFragmentShader);
                this.checkGLError("AttachShader REPROJECTION FRAGMENT");
                //console.log("Reprojection shaders attached.");

                //console.log(`Linking reprojection program ${this.reprojectionShaderProgram}...`);
                gl.LinkProgram(this.reprojectionShaderProgram);
                if (!this.checkGLError(`LinkProgram reprojection`)) {
                    // Clean up shaders and program if linking fails
                    gl.DeleteShader(reprojectionVertexShader);
                    gl.DeleteShader(reprojectionFragmentShader);
                    gl.DeleteProgram(this.reprojectionShaderProgram);
                    this.reprojectionShaderProgram = null;
                    throw new Error("Reprojection shader program linking failed");
                }
                //console.log(`Link command issued for reprojection program ${this.reprojectionShaderProgram}.`);

                const reprojectionLinkStatus = new Int32Array(1);
                gl.GetProgramiv(this.reprojectionShaderProgram, gl.LINK_STATUS, reprojectionLinkStatus);
                this.checkGLError("GetProgramiv LINK_STATUS reprojection");

                if (!reprojectionLinkStatus[0]) {
                    console.error(`!!! Reprojection shader program ID ${this.reprojectionShaderProgram} linking FAILED !!!`);
                    const log = new Uint8Array(1024);
                    const logLength = new Int32Array(1);
                    gl.GetProgramInfoLog(this.reprojectionShaderProgram, log.length, logLength, log);
                    this.checkGLError("GetProgramInfoLog LINK_STATUS reprojection");
                    console.error(`--- Reprojection Program Link Log (ID ${this.reprojectionShaderProgram}) ---`);
                    console.error(new TextDecoder().decode(log.slice(0, logLength[0])));
                    console.error(`--- End Reprojection Program Link Log ---`);
                    // Clean up shaders and program if linking fails
                    gl.DeleteShader(reprojectionVertexShader);
                    gl.DeleteShader(reprojectionFragmentShader);
                    gl.DeleteProgram(this.reprojectionShaderProgram);
                    this.reprojectionShaderProgram = null;
                    throw new Error("Reprojection shader program linking failed");
                } 
                // Detach and delete reprojection shaders after successful linking
                //console.log(`Detaching and deleting shaders for reprojection program ${this.reprojectionShaderProgram}...`);
                gl.DetachShader(this.reprojectionShaderProgram, reprojectionVertexShader);
                this.checkGLError("DetachShader REPROJECTION VERTEX");
                gl.DetachShader(this.reprojectionShaderProgram, reprojectionFragmentShader);
                this.checkGLError("DetachShader REPROJECTION FRAGMENT");
                gl.DeleteShader(reprojectionVertexShader); // Now safe to delete the vertex shader
                this.checkGLError("DeleteShader REPROJECTION VERTEX");
                gl.DeleteShader(reprojectionFragmentShader);
                this.checkGLError("DeleteShader REPROJECTION FRAGMENT");
                //console.log("Reprojection shaders detached and deleted.");

                // --- Get Uniform Locations for Reprojection Shader Program ---
                //console.log(`Getting uniform locations for reprojection program ${this.reprojectionShaderProgram}...`);
                this.reprojectionUniformLocations.renderPoseMatrix = gl.GetUniformLocation(this.reprojectionShaderProgram, cstr("renderPose"));
                this.reprojectionUniformLocations.currentPoseMatrix = gl.GetUniformLocation(this.reprojectionShaderProgram, cstr("currentPose"));
                this.reprojectionUniformLocations.halfFOVInRadians = gl.GetUniformLocation(this.reprojectionShaderProgram, cstr("halfFOVInRadians")); // Still needed
                this.reprojectionUniformLocations.eyeLeft = gl.GetUniformLocation(this.reprojectionShaderProgram, cstr("eyeLeft"));
                this.reprojectionUniformLocations.eyeRight = gl.GetUniformLocation(this.reprojectionShaderProgram, cstr("eyeRight"));
                this.checkGLError("GetUniformLocation reprojection");

                // Validate required reprojection uniforms
                if (this.reprojectionUniformLocations.renderPoseMatrix === null || this.reprojectionUniformLocations.renderPoseMatrix === -1 ||
                    this.reprojectionUniformLocations.currentPoseMatrix === null || this.reprojectionUniformLocations.currentPoseMatrix === -1 ||
                    this.reprojectionUniformLocations.halfFOVInRadians === null || this.reprojectionUniformLocations.halfFOVInRadians === -1 ||
                    this.reprojectionUniformLocations.eyeLeft === null || this.reprojectionUniformLocations.eyeLeft === -1 ||
                    this.reprojectionUniformLocations.eyeRight === null || this.reprojectionUniformLocations.eyeRight === -1) {
                    console.error("!!! Failed to get all required uniform locations for reprojection shader.");
                    this.checkGLError("GetUniformLocation reprojection validation"); // Check if GetError reveals issues
                    gl.DeleteProgram(this.reprojectionShaderProgram); // Clean up program
                    this.reprojectionShaderProgram = null;
                    throw new Error("Failed to get required reprojection uniform locations.");
                }

                //console.log("Reprojection uniform locations:", this.reprojectionUniformLocations);
                this.reprojectionEnabled = true; // Mark reprojection as available
               // console.log("--- Reprojection Shader Setup SUCCESSFUL ---");

            } catch (error) {
                
                console.warn(`Reprojection shader setup failed or skipped: ${(error as Error).message}. Reprojection will be disabled.`);
                this.reprojectionShaderProgram = null; // Ensure it's null if setup fails
                this.reprojectionEnabled = false;
                throw new Error((error as Error).message);
                // Cleanup of shaders/program happens within the try block or above catch blocks
            }

            // Now delete the original standard vertex shader if it hasn't been deleted yet
            // (It might have been detached but not deleted if we reused it)
            // Safest just to delete it here to ensure cleanup. Check if it still exists.
            // NOTE: The variable 'vertexShader' from the standard setup might be out of scope here.
            // Relying on the cleanup inside the reprojection setup (recompiling vertex shader) is safer.

            // --- Texture Setup ---
            //console.log("--- Starting Texture Setup ---");
            this.outputWidth = panoramaWidth;
            this.outputHeight = panoramaHeight;
            //console.log(`Output dimensions: ${this.outputWidth}x${this.outputHeight}`);

            // Output Texture (this.outputTexture)
            this.outputTexture = new Uint32Array(1);
            gl.GenTextures(1, this.outputTexture);
            //console.log(`Generated output texture ID: ${this.outputTexture[0]}`);
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
           // console.log(`Generated left eye texture ID: ${this.leftEyeTexture[0]}`);
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
            //console.log(`Generated right eye texture ID: ${this.rightEyeTexture[0]}`);
            gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);
            this.checkGLError("GenTextures/BindTexture right eye");
            // Set parameters (allocate storage later during render)
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.checkGLError("TexParameteri right eye");

            //console.log("Unbinding textures.");
            gl.BindTexture(gl.TEXTURE_2D, 0);
            this.checkGLError("Unbind textures");
            //console.log("--- Texture Setup Complete ---");

            // --- Framebuffer Object (FBO) Setup ---
            //console.log("--- Starting FBO Setup ---");
            const fboId = new Uint32Array(1);
            gl.GenFramebuffers(1, fboId);
            this.fbo = fboId[0];
            //console.log(`Generated FBO ID: ${this.fbo}`);
            gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            this.checkGLError("GenFramebuffers/BindFramebuffer");
            // Attach the single *output* texture
            //console.log(`Attaching output texture (ID: ${this.outputTexture[0]}) to FBO ${this.fbo} COLOR_ATTACHMENT0...`);
            gl.FramebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outputTexture[0], 0);
            this.checkGLError("FramebufferTexture2D");

            //console.log(`Checking FBO status (ID: ${this.fbo})...`);
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
            //console.log(`+++ FBO (ID: ${this.fbo}) is complete. +++`);
            //console.log(`Unbinding FBO ${this.fbo}.`);
            gl.BindFramebuffer(gl.FRAMEBUFFER, 0); // Unbind FBO
            this.checkGLError("Unbind FBO");
            //console.log("--- FBO Setup Complete ---");

            // --- Vertex Array Object (VAO) Setup ---
           // console.log("--- Starting VAO Setup ---");
            const vaoId = new Uint32Array(1);
            gl.GenVertexArrays(1, vaoId);
            this.vao = vaoId[0];
           // console.log(`Generated VAO ID: ${this.vao}`);
            // No buffer binding needed if using gl_VertexID for quad generation
            // Bind and unbind just to be sure it's created correctly
            gl.BindVertexArray(this.vao);
            gl.BindVertexArray(0);
            this.checkGLError("VAO setup");
           // console.log("--- VAO Setup Complete ---");

           // console.log("--- OpenGLManager Initialization Successful ---");

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
        renderPoseMatrix: Float32Array, // Renamed from lookRotation
        halfFOVInRadians: number,
        currentPoseMatrix?: Float32Array | null // Added optional current pose
    ): void {

        // Determine if we should use reprojection
        const useReprojection = this.reprojectionEnabled && !!this.reprojectionShaderProgram && !!currentPoseMatrix;

        // Select the shader program and uniform locations based on the decision
        const activeShaderProgram = useReprojection ? this.reprojectionShaderProgram : this.shaderProgram;
        const activeUniforms = useReprojection ? this.reprojectionUniformLocations : this.uniformLocations;

        // --- 1. Check Resources ---
        if (!this.fbo || !activeShaderProgram || !this.vao || !this.leftEyeTexture || !this.rightEyeTexture || !this.outputTexture) {
            console.error(`Render call failed (${useReprojection ? 'Reprojection' : 'Standard'}): Essential OpenGL resources not initialized.`);
            throw new Error("OpenGL resources not initialized.");
        }

        // --- 2. Check Required Uniform Locations for the *Chosen* Shader ---
        let uniformsValid = false;
        if (useReprojection) {
            const reprojUniforms = activeUniforms as any; // Type assertion
            //console.log("Checking reprojection uniforms:", reprojUniforms);
            uniformsValid =
                reprojUniforms.renderPoseMatrix !== null && reprojUniforms.renderPoseMatrix !== -1 &&
                reprojUniforms.currentPoseMatrix !== null && reprojUniforms.currentPoseMatrix !== -1 &&
                reprojUniforms.halfFOVInRadians !== null && reprojUniforms.halfFOVInRadians !== -1 &&
                reprojUniforms.eyeLeft !== null && reprojUniforms.eyeLeft !== -1 &&
                reprojUniforms.eyeRight !== null && reprojUniforms.eyeRight !== -1;
            if (!uniformsValid) console.error("Reprojection uniforms invalid:", reprojUniforms);
        } else {
            const stdUniforms = activeUniforms as any; // Type assertion
            //console.log("Checking standard uniforms:", stdUniforms);
            uniformsValid =
                stdUniforms.lookRotation !== null && stdUniforms.lookRotation !== -1 && // Use lookRotation here
                stdUniforms.halfFOVInRadians !== null && stdUniforms.halfFOVInRadians !== -1 &&
                stdUniforms.eyeLeft !== null && stdUniforms.eyeLeft !== -1 &&
                stdUniforms.eyeRight !== null && stdUniforms.eyeRight !== -1;
            if (!uniformsValid) console.error("Standard uniforms invalid:", stdUniforms);
        }

        if (!uniformsValid) {
            const shaderMode = useReprojection ? 'reprojection' : 'standard';
            console.error(`Render call failed: Required uniform locations not found for ${shaderMode} shader.`);
            this.checkGLError(`GetUniformLocation validation (${shaderMode})`); // Check GL error state
            throw new Error(`Required uniform locations not found for ${shaderMode} shader.`);
        }
        //console.log(`Using ${useReprojection ? 'Reprojection' : 'Standard'} shader program: ID ${activeShaderProgram}`);

        // --- 3. Upload Pixel Data to Separate Eye Textures ---
        // (No changes needed here, just ensure texture units match shader expectations)
        // Left Eye Texture
        gl.ActiveTexture(gl.TEXTURE0); // Activate texture unit 0 for left eye (eyeLeft uniform)
        this.checkGLError("active texture 0");
        gl.BindTexture(gl.TEXTURE_2D, this.leftEyeTexture[0]);
        this.checkGLError("bind left texture");
        gl.TexImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            eyeWidth,
            eyeHeight,
            0,
            gl.BGRA,
            gl.UNSIGNED_BYTE,
            leftPixels
        );
        if (!this.checkGLError("upload left eye texture data")) return;

        // Right Eye Texture
        gl.ActiveTexture(gl.TEXTURE1); // Activate texture unit 1 for right eye (eyeRight uniform)
        this.checkGLError("active texture 1");
        gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);
        this.checkGLError("bind right texture");
        gl.TexImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            eyeWidth,
            eyeHeight,
            0,
            gl.BGRA,
            gl.UNSIGNED_BYTE,
            rightPixels
        );
        if (!this.checkGLError("upload right eye texture data")) return;

        // --- 4. Bind FBO, Set Viewport ---
        gl.BindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        if (!this.checkGLError("bind FBO")) return;
        gl.Viewport(0, 0, this.outputWidth, this.outputHeight); // Render to the full output texture
        if (!this.checkGLError("set viewport")) return;
        // Optional: gl.Clear(...) if needed

        // --- 5. Use *Selected* Shader Program ---
        gl.UseProgram(activeShaderProgram);
        if (!this.checkGLError(`use program (${useReprojection ? 'Reprojection' : 'Standard'})`)) return;

        // --- 6. Set Uniforms based on Mode ---
        if (useReprojection) {
            const reprojUniforms = activeUniforms as any;
            gl.UniformMatrix4fv(reprojUniforms.renderPoseMatrix!, 1, 0, renderPoseMatrix); // transpose = 0 (false)
            gl.UniformMatrix4fv(reprojUniforms.currentPoseMatrix!, 1, 0, currentPoseMatrix!); // transpose = 0 (false)
            gl.Uniform1f(reprojUniforms.halfFOVInRadians!, halfFOVInRadians);
            gl.Uniform1i(reprojUniforms.eyeLeft!, 0); // Texture unit 0
            gl.Uniform1i(reprojUniforms.eyeRight!, 1); // Texture unit 1
            if (!this.checkGLError("set reprojection uniforms")) return;
            //console.log("Reprojection uniforms set.");
        } else {
            const stdUniforms = activeUniforms as any;
            gl.UniformMatrix4fv(stdUniforms.lookRotation!, 1, 0, renderPoseMatrix); // Use renderPoseMatrix for lookRotation
            gl.Uniform1f(stdUniforms.halfFOVInRadians!, halfFOVInRadians);
            gl.Uniform1i(stdUniforms.eyeLeft!, 0); // Texture unit 0
            gl.Uniform1i(stdUniforms.eyeRight!, 1); // Texture unit 1
            if (!this.checkGLError("set standard uniforms")) return;
            //console.log("Standard uniforms set.");
        }

        // --- 7. Ensure Correct Textures are Bound to Correct Units ---
        // (Already done during upload, but doesn't hurt to be explicit if needed)
        // gl.ActiveTexture(gl.TEXTURE0);
        // gl.BindTexture(gl.TEXTURE_2D, this.leftEyeTexture[0]);
        // gl.ActiveTexture(gl.TEXTURE1);
        // gl.BindTexture(gl.TEXTURE_2D, this.rightEyeTexture[0]);

        // --- 8. Bind VAO ---
        gl.BindVertexArray(this.vao);
        if (!this.checkGLError("bind VAO")) return;

        // --- 9. Draw Fullscreen Quad ---
        gl.DrawArrays(gl.TRIANGLE_STRIP, 0, 4); // Use TRIANGLE_STRIP for the standard quad
        if (!this.checkGLError("draw arrays")) return;

        // --- 10. Unbind resources ---
        gl.BindVertexArray(0);
        gl.UseProgram(0);
        gl.BindFramebuffer(gl.FRAMEBUFFER, 0);
        gl.ActiveTexture(gl.TEXTURE0); // Reset active texture unit
        gl.BindTexture(gl.TEXTURE_2D, 0); // Unbind textures
        gl.ActiveTexture(gl.TEXTURE1);
        gl.BindTexture(gl.TEXTURE_2D, 0);
        gl.ActiveTexture(gl.TEXTURE0); // Explicitly reset to unit 0
        this.checkGLError("unbind resources");
        //console.log(`--- Panorama Render (${useReprojection ? 'Reprojection' : 'Standard'}) Complete ---`);
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
        if (this.reprojectionShaderProgram) {
            console.log(`Deleting Reprojection Shader Program ID: ${this.reprojectionShaderProgram}`);
            // No need for array for DeleteProgram
            gl.DeleteProgram(this.reprojectionShaderProgram);
            this.reprojectionShaderProgram = null;
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
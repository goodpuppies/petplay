import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, DwmWindow, getProcAddress, mainloop } from "@gfx/dwm";
import { CefCapturer, WebxrFrame } from "./classes/CefCap/frame_receiver.ts";

// Store the latest frame data
let latestFrame: WebxrFrame | null = null;
let frameReceived = false;
let windowInitialized = false;
let window: DwmWindow;
let framesReceived = 0;

// Initialize screen capturer with stats callback
const capturer = new CefCapturer({
  debug: true, // Enable debug mode to see more information
  onStats: ({ fps, avgLatency }) => {
    console.log(`Capture FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
  }
});

// Register callback for new frames before starting capturer
capturer.onNewFrame((frame: WebxrFrame) => {
  latestFrame = frame;
  frameReceived = true;
  
  // Debug info for first few frames
  if (frameReceived && (framesReceived < 5)) {
    console.log(`Frame received: ${frame.width}x${frame.height}, first bytes:`, 
      Array.from(frame.data.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    framesReceived++;
    
    // Initialize window to match first frame if not already done
    if (!windowInitialized && frame.width > 0 && frame.height > 0) {
      initializeWindow(frame.width, frame.height);
      windowInitialized = true;
    }
  }
});

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
    return false;
  }
  return true;
}

function initializeWindow(width: number, height: number) {
  console.log(`Initializing window with size: ${width}x${height}`);
  
  // Use a reasonable window size based on the frame dimensions - scale down if too large
  const maxWidth = 1920;
  const maxHeight = 1080;
  let windowWidth = width;
  let windowHeight = height;
  
  if (width > maxWidth || height > maxHeight) {
    const scale = Math.min(maxWidth / width, maxHeight / height);
    windowWidth = Math.floor(width * scale);
    windowHeight = Math.floor(height * scale);
    console.log(`Scaling window to: ${windowWidth}x${windowHeight} (scale: ${scale.toFixed(2)})`);
  }
  
  window = createWindow({
    title: "Screen Capture Test",
    width: windowWidth,
    height: windowHeight,
    resizable: true,
    glVersion: [4, 6], // Match OpenGLManager
    gles: false,
  });

  gl.load(getProcAddress);
  checkGLError("gl.load");

  // Set initial GL state
  gl.Viewport(0, 0, windowWidth, windowHeight);
  gl.ClearColor(0.2, 0.3, 0.3, 1.0);
  gl.Enable(gl.BLEND);
  gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  checkGLError("Initial GL state");
  
  // Initialize shaders and resources
  initializeResources();
}

let program: number;
let vao: number;
let vbo: number;
let ebo: number;
let currentTexture: number | null = null;
let currentWidth = 0;
let currentHeight = 0;
let useBGRA = true; // Try BGRA format first, like OpenGLManager

function initializeResources() {
  // Simple vertex shader - using pass-through positions
  const vShaderSrc = `#version 330 core
layout (location = 0) in vec3 aPos;
layout (location = 1) in vec2 aTexCoord;
out vec2 texCoord;

void main() {
    gl_Position = vec4(aPos, 1.0);
    texCoord = aTexCoord;
}`;

  // Simple fragment shader
  const fShaderSrc = `#version 330 core
out vec4 FragColor;
in vec2 texCoord;
uniform sampler2D uTexture;

void main() {
    FragColor = texture(uTexture, texCoord);
    //FragColor = vec4(texCoord.x, texCoord.y, 0.0, 1.0); // Debug UV coordinates
}`;

  console.log("Compiling shaders...");
  const vShader = loadShader(gl.VERTEX_SHADER, vShaderSrc);
  const fShader = loadShader(gl.FRAGMENT_SHADER, fShaderSrc);
  if (!vShader || !fShader) {
    throw new Error("Failed to compile shaders");
  }

  program = gl.CreateProgram();
  gl.AttachShader(program, vShader);
  gl.AttachShader(program, fShader);
  gl.LinkProgram(program);
  checkGLError("Link program");

  // Check program link status
  const linkStatus = new Int32Array(1);
  gl.GetProgramiv(program, gl.LINK_STATUS, linkStatus);
  if (linkStatus[0] === gl.FALSE) {
    const logLength = new Int32Array(1);
    gl.GetProgramiv(program, gl.INFO_LOG_LENGTH, logLength);
    const log = new Uint8Array(logLength[0]);
    gl.GetProgramInfoLog(program, logLength[0], logLength, log);
    console.error("Program link error:", new TextDecoder().decode(log));
    throw new Error("Failed to link shader program");
  }

  console.log("Shader program linked successfully");

  // Create VAO and buffers
  const vaoArray = new Uint32Array(1);
  gl.GenVertexArrays(1, vaoArray);
  vao = vaoArray[0];
  checkGLError("Create VAO");
  
  const buffers = new Uint32Array(2);
  gl.GenBuffers(2, buffers);
  vbo = buffers[0];
  ebo = buffers[1];
  checkGLError("Create buffers");

  gl.BindVertexArray(vao);
  checkGLError("Bind VAO");

  // Create a full-screen quad
  const vertices = new Float32Array([
    // positions (xyz)      // texture coords (uv)
    -1.0, -1.0, 0.0,        0.0, 0.0, // bottom left
     1.0, -1.0, 0.0,        1.0, 0.0, // bottom right
     1.0,  1.0, 0.0,        1.0, 1.0, // top right
    -1.0,  1.0, 0.0,        0.0, 1.0  // top left
  ]);

  const indices = new Uint32Array([
    0, 1, 2, // first triangle
    0, 2, 3  // second triangle
  ]);

  // Upload vertex data
  gl.BindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.BufferData(gl.ARRAY_BUFFER, Deno.UnsafePointer.create(BigInt(vertices.byteLength)), vertices, gl.STATIC_DRAW);
  checkGLError("Upload vertices");

  // Upload index data
  gl.BindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.BufferData(gl.ELEMENT_ARRAY_BUFFER, Deno.UnsafePointer.create(BigInt(indices.byteLength)), indices, gl.STATIC_DRAW);
  checkGLError("Upload indices");

  // Configure vertex attributes
  // Position attribute
  gl.VertexAttribPointer(0, 3, gl.FLOAT, gl.FALSE, 5 * Float32Array.BYTES_PER_ELEMENT, null);
  gl.EnableVertexAttribArray(0);
  checkGLError("Setup position attribute");

  // Texture coord attribute
  gl.VertexAttribPointer(1, 2, gl.FLOAT, gl.FALSE, 5 * Float32Array.BYTES_PER_ELEMENT, 
    Deno.UnsafePointer.create(BigInt(3 * Float32Array.BYTES_PER_ELEMENT)));
  gl.EnableVertexAttribArray(1);
  checkGLError("Setup texcoord attribute");

  // Set texture uniform
  gl.UseProgram(program);
  const texLocation = gl.GetUniformLocation(program, new TextEncoder().encode("uTexture\0"));
  if (texLocation !== -1) {
    gl.Uniform1i(texLocation, 0);
    checkGLError("Set texture uniform");
  }

  gl.BindVertexArray(0);
  gl.UseProgram(0);
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): number {
  // Delete old texture if it exists
  if (currentTexture !== null) {
    const textures = new Uint32Array([currentTexture]);
    gl.DeleteTextures(1, textures);
    currentTexture = null;
  }

  // Create new texture
  const texture = new Uint32Array(1);
  gl.GenTextures(1, texture);
  gl.BindTexture(gl.TEXTURE_2D, texture[0]);
  checkGLError("Create texture");

  // Set texture parameters
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  checkGLError("Texture parameters");

  // Try with BGRA format first (matching OpenGLManager)
  if (useBGRA) {
    gl.TexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.BGRA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    
    const error = gl.GetError();
    if (error !== gl.NO_ERROR) {
      console.warn(`BGRA format failed: ${error}, trying RGBA instead`);
      useBGRA = false;
      
      // Fall back to RGBA
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
      checkGLError("Upload texture data (RGBA)");
    } else {
      console.log("Using BGRA format for textures");
    }
  } else {
    // Use RGBA if BGRA failed previously
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
    checkGLError("Upload texture data (RGBA)");
  }

  // Store current dimensions
  currentWidth = width;
  currentHeight = height;

  return texture[0];
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
    console.log("Shader compilation error:", new TextDecoder().decode(log));
    gl.DeleteShader(shader);
    return 0;
  }
  return shader;
}

// Frame timing state
let lastFpsUpdate = performance.now();
let framesThisSecond = 0;
let currentFps = 0;

// Debug flags
let renderFrame = 0;
let debugMode = false; // Set to true to enable debug coloring

async function frame() {
  if (!windowInitialized) {
    // Wait for first frame to initialize window
    await new Promise(resolve => setTimeout(resolve, 100));
    return;
  }
  
  // Main render loop
  gl.Clear(gl.COLOR_BUFFER_BIT);
  
  // Use the latest frame from the event callback
  if (latestFrame) {
    const frameData = latestFrame;
    
    renderFrame++;
    if (renderFrame <= 2) {
      console.log(`Rendering frame ${renderFrame}, size: ${frameData.width}x${frameData.height}`);
    }
    
    currentTexture = createTextureFromScreenshot(frameData.data, frameData.width, frameData.height);
    
    // Use shader program
    gl.UseProgram(program);
    checkGLError("Use program");
    
    // Bind texture
    gl.ActiveTexture(gl.TEXTURE0);
    gl.BindTexture(gl.TEXTURE_2D, currentTexture);
    checkGLError("Bind texture");
    
    // Bind VAO and draw
    gl.BindVertexArray(vao);
    checkGLError("Bind VAO");
    
    // Draw using element buffer
    gl.DrawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, null);
    checkGLError("Draw elements");
    
    window.swapBuffers();
    checkGLError("Swap buffers");
    
    // Update FPS counter
    framesThisSecond++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
      console.log(`Frame dimensions: ${frameData.width}x${frameData.height}, Render FPS: ${framesThisSecond}`);
      currentFps = framesThisSecond;
      framesThisSecond = 0;
      lastFpsUpdate = now;
      window.title = `Screen Capture Test - FPS: ${currentFps}`;
    }
  } else {
    // If no frames received yet, keep the UI responsive
    window.swapBuffers();
    
    // Log if we haven't received any frames after a while
    const now = performance.now();
    if (!frameReceived && now - lastFpsUpdate >= 2000) {
      console.log("No frames received yet...");
      lastFpsUpdate = now;
    }
  }

  // Small delay to prevent tight loop
  await new Promise(resolve => setTimeout(resolve, 1));
}

// Cleanup function
async function cleanup() {
  if (currentTexture !== null) {
    const textures = new Uint32Array([currentTexture]);
    gl.DeleteTextures(1, textures);
    currentTexture = null;
  }

  if (program) {
    gl.DeleteProgram(program);
  }

  if (vao) {
    const vaos = new Uint32Array([vao]);
    gl.DeleteVertexArrays(1, vaos);
  }

  if (vbo) {
    const buffers = new Uint32Array([vbo, ebo]);
    gl.DeleteBuffers(2, buffers);
  }

  await capturer.dispose();
}

// Handle cleanup on exit
globalThis.addEventListener("unload", cleanup);

console.log("Starting screen capture test...");
// Make sure capture is started before beginning render loop
capturer.start().then(() => {
  console.log("Capturer started successfully, beginning render loop");
  mainloop(frame);
}).catch(err => {
  console.error("Failed to start capturer:", err);
});

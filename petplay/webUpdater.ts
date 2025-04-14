import { PostMan, wait } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { WebCapturer } from "../classes/WebCapturer/wcclass.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { setImmediate } from "node:timers";
import { Buffer } from "node:buffer";
import { getOverlayTransformAbsolute, setOverlayTransformAbsolute } from "../classes/openvrTransform.ts";
import { multiplyMatrix } from "../classes/matrixutils.ts";

//takes an overlay handle and a frame source, updates overlay texture continuously
interface frame {
  pixels: Uint8Array,
  width: number,
  height: number
}

interface frametype {
  pixels: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number
}

const state = {
  name: "updater",
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  glManager: null as OpenGLManager | null,
  isRunning: false as boolean,
  framesource: null as string | null,
  webCapturer: null as WebCapturer | null,
  currentFrame: null as frametype | null,
  hmdpose: null as OpenVR.TrackedDevicePose | null,
  vrSystem: null as OpenVR.IVRSystem | null,
  
  // Sequential pose ID counter
  nextPoseId: 1,
  
  // Store a history of poses with timestamps and IDs for proper frame-pose synchronization
  poseHistory: [] as Array<{
    id: number,
    timestamp: number, 
    pose: OpenVR.TrackedDevicePose
  }>,
  
  // Map of pose IDs to poses for fast lookup
  poseMap: new Map<number, OpenVR.TrackedDevicePose>(),
  
  MAX_POSE_HISTORY: 3000, // Store a large history for debugging
  
  // Get pose by its exact ID
  getPoseById: function(poseId: number): OpenVR.TrackedDevicePose | null {
    // Fast lookup from map
    const pose = this.poseMap.get(poseId);
    if (pose) {
      //console.log(`Found exact pose match for ID: ${poseId}`);
      return pose;
    }
    
    console.log(`No pose found for ID: ${poseId}`);
    return this.hmdpose; // Fallback to current pose
  },
  
  // For compatibility - get the closest historical pose to a timestamp
  getClosestPose: function(frameTimestamp: number): OpenVR.TrackedDevicePose | null {
    if (this.poseHistory.length === 0) {
      return this.hmdpose; // Fallback to current pose if no history
    }
    
    // Find pose with closest timestamp
    let closestPose = this.poseHistory[0];
    let minTimeDiff = Math.abs(closestPose.timestamp - frameTimestamp);
    
    for (let i = 1; i < this.poseHistory.length; i++) {
      const timeDiff = Math.abs(this.poseHistory[i].timestamp - frameTimestamp);
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        closestPose = this.poseHistory[i];
      }
    }
    
    console.log(`Using closest pose with time diff: ${minTimeDiff}ms`);
    return closestPose.pose;
  },
  
  // Get the exact historical pose matching a timestamp
  getExactPose: function(poseTimestamp: number): OpenVR.TrackedDevicePose | null {
    if (this.poseHistory.length === 0) {
      console.log("no history")
      return this.hmdpose; // Fallback to current pose if no history
    }
    
    // Try to find exact match first
    const exactMatch = this.poseHistory.find(p => p.timestamp === poseTimestamp);
    if (exactMatch) {
      console.log("exact")
      return exactMatch.pose;
    }
    console.log("miss")
    
    // If no exact match, fall back to closest pose
    return this.getClosestPose(poseTimestamp);
  }
};

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => {
    PostMan.setTopic("muffin")
  },
  STARTUPDATER: (payload: { overlayclass: bigint, overlayhandle: bigint, framesource?: string }) => {
    state.overlayClass = new OpenVR.IVROverlay(Deno.UnsafePointer.create(payload.overlayclass));
    state.overlayHandle = payload.overlayhandle
    console.log("we have overlayhandle", state.overlayHandle)
    if (payload.framesource) state.framesource = payload.framesource
    main()
  },
  GETFRAME: (_payload: void): { pixels: string, width: number, height: number } | null => {
    if (state.currentFrame == null) { return null }
    // Convert Uint8Array pixels to base64 string for transport
    const base64Pixels = Buffer.from(state.currentFrame.pixels).toString('base64');
    return {
      pixels: base64Pixels,
      width: state.currentFrame.width,
      height: state.currentFrame.height
    }
  },
  INITOPENVR: (payload) => {
    const ptrn = payload;
    const systemPtr = Deno.UnsafePointer.create(ptrn); 
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);  

    CustomLogger.log("actor", `OpenVR system initialized in actor ${PostMan.state.id} with pointer ${ptrn}`);
  },
  /* HMDPOSE: (payload: OpenVR.TrackedDevicePose) => {
    state.hmdpose = payload
    state.screenCapturer?.sendWsMsg(JSON.stringify(payload))
  } */
} as const);

function INITSCREENCAP(): WebCapturer {
  const capturer = new WebCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
    },
    executablePath: "../resources/denotauri"
  });
  
  return capturer;
}

async function WebCapLoop(
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) { 
  console.log("webcaploop starting - using push notifications")
  
  // Track if we're currently processing a frame
  let processingFrame = false; 
  
  // Track frame dropping statistics for recovery mechanism
  let consecutiveDrops = 0;
  let lastProcessedTime = Date.now();
  
  // Function to process the latest frame from webcapturer
  async function processLatestFrame() {
    // If already processing a frame, don't start another one
    if (processingFrame) return;
    
    try {
      // Set flag to prevent parallel processing
      processingFrame = true;
      
      if (!state.framesource && !state.webCapturer) throw new Error("no framesource")
      if (!state.overlayClass) throw new Error("no overlay")
      if (!state.overlayHandle) throw new Error("no overlay")
      
      // ==========================================
      // INTEGRATED HMD POSE TRACKING - Get the latest HMD pose first
      // ==========================================
      if (state.vrSystem) {
        const vrSystem = state.vrSystem;
        const posesSize = OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount;
        const poseArrayBuffer = new ArrayBuffer(posesSize);
        const posePtr = Deno.UnsafePointer.of(poseArrayBuffer) as Deno.PointerValue<OpenVR.TrackedDevicePose>;

        vrSystem.GetDeviceToAbsoluteTrackingPose(
          OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
          0,
          posePtr,
          OpenVR.k_unMaxTrackedDeviceCount
        );
      
        const hmdIndex = OpenVR.k_unTrackedDeviceIndex_Hmd;
        const poseView = new DataView(
          poseArrayBuffer,
          hmdIndex * OpenVR.TrackedDevicePoseStruct.byteSize,
          OpenVR.TrackedDevicePoseStruct.byteSize
        );
        const hmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as OpenVR.TrackedDevicePose;

        // Assign a sequential ID to this pose
        const poseId = state.nextPoseId++;
        const currentPoseTimestamp = Date.now();
        
        // Add timestamp and ID to the pose data for accurate tracking on the frontend
        const timestampedPose = {
          ...hmdPose,
          timestamp: currentPoseTimestamp,
          id: poseId
        };

        // Store current pose
        state.hmdpose = hmdPose;
        
        // Store in pose history for frame-pose synchronization
        const poseEntry = {
          id: poseId,
          timestamp: currentPoseTimestamp,
          pose: hmdPose
        };
        
        state.poseHistory.push(poseEntry);
        
        // Also store in the map for fast lookup
        state.poseMap.set(poseId, hmdPose);
        
        // Limit history size
        if (state.poseHistory.length > state.MAX_POSE_HISTORY) {
          const removed = state.poseHistory.shift();
          if (removed) {
            state.poseMap.delete(removed.id);
          }
        }
        
        if (state.webCapturer) {
          state.webCapturer?.sendWsMsg(JSON.stringify(timestampedPose));
        }
      }
      // ==========================================
      // END OF INTEGRATED HMD POSE TRACKING
      // ==========================================
      
      // Get latest frame with minimal overhead
      const preGetFrameTime = Date.now();
      const capturedFrame = await state.webCapturer!.getLatestFrame();
      const postGetFrameTime = Date.now();
      const getFrameTime = postGetFrameTime - preGetFrameTime;
      
      if (capturedFrame === null) { 
        console.log("no frame available");
        processingFrame = false;
        return;
      }
      
      // Age-based frame dropping - drop frames that are too old to be relevant
      const now = Date.now();
      const frameAge = now - capturedFrame.timestamp;
      const MAX_FRAME_AGE_MS = 40; // Frames older than this will be dropped
      
      // Determine if we should process this frame
      const shouldDrop = frameAge > MAX_FRAME_AGE_MS;
      
      // Recovery logic - if we've dropped too many consecutive frames,
      // force processing of this frame to break out of the death spiral
      const MAX_CONSECUTIVE_DROPS = 5;
      const TIME_SINCE_LAST_PROCESSED = now - lastProcessedTime;
      const FORCED_PROCESS_INTERVAL_MS = 100; // Force a frame every 200ms minimum
      
      const forceProcess = (consecutiveDrops >= MAX_CONSECUTIVE_DROPS) || 
                          (TIME_SINCE_LAST_PROCESSED > FORCED_PROCESS_INTERVAL_MS);
      
      if (shouldDrop && !forceProcess) {
        //console.log(`Dropping stale frame: age ${frameAge}ms exceeds threshold ${MAX_FRAME_AGE_MS}ms (consecutive: ${consecutiveDrops})`);
        
        // Reset the frame ready flag even though we're not processing this frame
        if (state.webCapturer) {
          state.webCapturer.resetFrameReadyFlag();
        }
        
        consecutiveDrops++;
        processingFrame = false;
        return;
      } else if (shouldDrop && forceProcess) {
        // We're processing a stale frame to recover
        console.log(`RECOVERY: Processing stale frame despite age ${frameAge}ms to prevent death spiral`);
        consecutiveDrops = 0;
        lastProcessedTime = now;
      } else {
        // Normal processing of a fresh frame
        consecutiveDrops = 0;
        lastProcessedTime = now;
      }
      
      const frame = {
        pixels: capturedFrame.data,
        width: capturedFrame.width,
        height: capturedFrame.height
      };
      state.currentFrame = frame;
      
      if (!capturedFrame.timestamp) { throw new Error("no timestamp") }
      const frameTimestamp = capturedFrame.timestamp;
      const frameAvailableTime = capturedFrame.frameAvailableTime;
      const poseId = capturedFrame.poseId;
      
      //console.log(`getFrameTime: ${getFrameTime} ms`);
      
      // Timestamp before texture creation
      const textureCreationStartTime = Date.now();
      
      // IMPORTANT: Get historically accurate pose for this frame's timestamp
      // Use the exact pose ID if available
      const historicalPose = poseId ? 
                             state.getPoseById(poseId) : 
                             state.getClosestPose(frameTimestamp);
      
      // Pass the historical pose directly to the texture creation function
      // instead of modifying the global state
      createTextureFromData(frame.pixels, frame.width, frame.height, historicalPose);
      
      // Calculate end-to-end latency with push model
      const endTime = Date.now();
      const e2eLatency = endTime - frameTimestamp; // End-to-end latency
      const textureTime = endTime - textureCreationStartTime; // Time spent in texture creation
      
      // Calculate additional timings if available
      let webCapLoopLatency = "";
      if (frameAvailableTime) {
        // Time from frame available in shared memory to texture creation
        const frameAvailToTextureTime = textureCreationStartTime - frameAvailableTime;
        
        // Time from getLatestFrame to texture creation
        const getFrameToTextureTime = textureCreationStartTime - preGetFrameTime;
        
        webCapLoopLatency = ` | FrameAvail→Texture: ${frameAvailToTextureTime.toFixed(0)} ms` +
                             ` | GetFrame→Texture: ${getFrameToTextureTime.toFixed(0)} ms`;
      }
      
      //console.log(`Push Notification E2E: ${e2eLatency.toFixed(0)} ms (Texture: ${textureTime.toFixed(0)} ms)${webCapLoopLatency}`);
      
      // Update the texture in the overlay
      const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
      if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("Error setting overlay texture");

      state.overlayClass.WaitFrameSync(100)
      
      // CRITICAL FIX: Reset the frame ready flag after processing to prevent timestamp accumulation
      // Without this, old frames stack up causing the FrameAvail→Texture time to grow continuously
      if (state.webCapturer) {
        state.webCapturer.resetFrameReadyFlag();
      }
    } catch (error) {
      console.error("Error processing frame:", error);
    } finally {
      // Clear flag to allow processing next frame
      processingFrame = false;
    }
  }
  
  // Setup for new frame notification with callback
  if (state.webCapturer) {
    // Register callback for immediate processing when new frames arrive
    state.webCapturer.onNewFrame(processLatestFrame);
    
    console.log("Push notification system ready for frames");
  } else if (state.framesource) {
    console.log("Remote frame source - not using push model");
    
    // For remote frames only, maintain a traditional polling loop
  
  } else {
    throw new Error("No frame source available");
  }
  
  // Keep the function alive while the system is running
  while (state.isRunning) {
    await wait(1000); // Just wait to keep the function active
  }
}

function splitSBSTexture(pixels: Uint8Array, width: number, height: number): { left: Uint8Array, right: Uint8Array } {
  const eyeWidth = width / 2;
  const eyeByteWidth = eyeWidth * 4; // Assuming RGBA format (4 bytes per pixel)
  const totalByteWidth = width * 4;
  const left = new Uint8Array(eyeWidth * height * 4);
  const right = new Uint8Array(eyeWidth * height * 4);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * totalByteWidth;
    const destRowOffset = y * eyeByteWidth;

    // Copy left half
    left.set(pixels.subarray(rowOffset, rowOffset + eyeByteWidth), destRowOffset);
    // Copy right half
    right.set(pixels.subarray(rowOffset + eyeByteWidth, rowOffset + totalByteWidth), destRowOffset);
  }
  return { left, right };
}

function invertMatrix4(mat: Float32Array): Float32Array | null {
  const out = new Float32Array(16);
  const m = mat; // Alias for shorter lines

  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  // Calculate the determinant
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

  if (!det) {
    console.error("Matrix is not invertible!");
    return null;
  }
  det = 1.0 / det;

  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det;
  out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det;
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det;
  out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det;
  out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det;
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det;
  out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det;
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det;
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det;
  out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det;
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det;
  out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det;
  out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det;
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det;
  out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det;
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det;

  return out;
}

function scaleMatrix4(mat: Float32Array, scaleVec: [number, number, number]): Float32Array {
  // Scales a 4x4 matrix by a vector (modifies columns)
  // Note: Assumes column-major input matrix 'mat'
  const out = new Float32Array(mat); // Copy existing matrix
  out[0] *= scaleVec[0]; out[1] *= scaleVec[0]; out[2] *= scaleVec[0]; out[3] *= scaleVec[0]; // Scale X column
  out[4] *= scaleVec[1]; out[5] *= scaleVec[1]; out[6] *= scaleVec[1]; out[7] *= scaleVec[1]; // Scale Y column
  out[8] *= scaleVec[2]; out[9] *= scaleVec[2]; out[10] *= scaleVec[2]; out[11] *= scaleVec[2]; // Scale Z column
  // W column (translation) remains unchanged by this type of scale
  return out;
}

function createTextureFromData(pixels: Uint8Array, width: number, height: number, renderPose?: OpenVR.TrackedDevicePose | null): void {
  if (!state.glManager) { throw new Error("glManager is null"); }
  if (!state.vrSystem) { throw new Error("vrSystem is null"); }
  
  // Use the provided render pose if available, otherwise fall back to the current state.hmdpose
  const renderHmdPose = renderPose || state.hmdpose;
  
  if (!renderHmdPose) { 
    throw new Error("No render pose available - reprojection requires both render and current poses");
  }

  // Get the absolute freshest HMD pose directly from OpenVR for reprojection
  const posesSize = OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount;
  const poseArrayBuffer = new ArrayBuffer(posesSize);
  const posePtr = Deno.UnsafePointer.of(poseArrayBuffer) as Deno.PointerValue<OpenVR.TrackedDevicePose>;

  // Define prediction amount in seconds (e.g., 11ms)
  const PREDICTION_SECONDS = 0.00; 

  // Get predicted pose 
  state.vrSystem.GetDeviceToAbsoluteTrackingPose(
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    PREDICTION_SECONDS, // Predict slightly into the future
    posePtr,
    OpenVR.k_unMaxTrackedDeviceCount
  );

  const hmdIndex = OpenVR.k_unTrackedDeviceIndex_Hmd;
  const poseView = new DataView(
    poseArrayBuffer,
    hmdIndex * OpenVR.TrackedDevicePoseStruct.byteSize,
    OpenVR.TrackedDevicePoseStruct.byteSize
  );
  const currentHmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as OpenVR.TrackedDevicePose;
  

  // Verify we have valid tracking for both poses
  if (!renderHmdPose.bPoseIsValid || !currentHmdPose.bPoseIsValid) {
    throw new Error("Invalid tracking data - reprojection requires valid tracking for both render and current poses");
  }

  // Process the render pose matrix (from when the frame was captured)
  const renderHmdMatVR = renderHmdPose.mDeviceToAbsoluteTracking.m;

  // 1. Convert OpenVR matrix (row-major) to Column-Major Float32Array (HMD -> World)
  const renderUniverseFromHmd_ColMajor = new Float32Array([
    renderHmdMatVR[0][0], renderHmdMatVR[1][0], renderHmdMatVR[2][0], 0,
    renderHmdMatVR[0][1], renderHmdMatVR[1][1], renderHmdMatVR[2][1], 0,
    renderHmdMatVR[0][2], renderHmdMatVR[1][2], renderHmdMatVR[2][2], 0,
    0, 0, 0, 1
  ]);

  // Also process the freshly obtained current pose matrix
  const currentHmdMatVR = currentHmdPose.mDeviceToAbsoluteTracking.m;
  const currentUniverseFromHmd_ColMajor = new Float32Array([
    currentHmdMatVR[0][0], currentHmdMatVR[1][0], currentHmdMatVR[2][0], 0,
    currentHmdMatVR[0][1], currentHmdMatVR[1][1], currentHmdMatVR[2][1], 0,
    currentHmdMatVR[0][2], currentHmdMatVR[1][2], currentHmdMatVR[2][2], 0,
    0, 0, 0, 1
  ]);

  // 2. Calculate the inverse of render pose (World -> HMD)
  const hmdFromUniverse_ColMajor = invertMatrix4(renderUniverseFromHmd_ColMajor);
  if (!hmdFromUniverse_ColMajor) {
    throw new Error("Failed to invert render pose matrix - reprojection cannot proceed");
  }

  // 3. Apply the Z-axis scale (1, 1, -1)
  const finalLookRotation = scaleMatrix4(hmdFromUniverse_ColMajor, [1, 1, -1]);

  // Use the original FOV value
  const sourceVerticalHalfFOVRadians = (112.0 / 2.0) * (Math.PI / 180.0);

  // Split the SBS texture
  if (width % 2 !== 0) {
    throw new Error("Input texture width is not even, cannot split SBS correctly for reprojection");
  }
  const eyeWidth = width / 2;
  const { left: leftPixels, right: rightPixels } = splitSBSTexture(pixels, width, height);

  // Calculate current pose inverse and scaling for reprojection
  const currentHmdFromUniverse_ColMajor = invertMatrix4(currentUniverseFromHmd_ColMajor);
  if (!currentHmdFromUniverse_ColMajor) {
    throw new Error("Failed to invert current HMD pose matrix - reprojection cannot proceed");
  }

  const finalCurrentPose = scaleMatrix4(currentHmdFromUniverse_ColMajor, [1, 1, -1]);
  
  //console.log("Applying reprojection with freshly obtained pose");
  
  // Call the render function with both poses for reprojection
  state.glManager.renderPanoramaFromData(
    leftPixels,
    rightPixels,
    eyeWidth,
    height,
    finalLookRotation, // Render pose
    sourceVerticalHalfFOVRadians,
    finalCurrentPose // Current pose for reprojection
  );
}

function INITGL(name?: string) {
  state.glManager = new OpenGLManager();
  state.glManager.initialize(name, 4096, 4096);
  if (!state.glManager) { throw new Error("glManager is null"); }
}

function main() {
  if (!state.overlayClass) throw new Error("no overlayclass")
  if (!state.overlayHandle) throw new Error("no overlayhandle")
  
  if (!state.framesource) { 
    //native capture mode
    state.webCapturer = INITSCREENCAP();
    state.webCapturer.start()
  }

  state.isRunning = true;
  
  INITGL();

  const texture = state.glManager!.getTexture();
  if (!texture) { throw new Error("texture is null"); }

  const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  const [boundsPtr, _boudsView] = createStruct<OpenVR.TextureBounds>(bounds, OpenVR.TextureBoundsStruct)
  state.overlayClass.SetOverlayTextureBounds(state.overlayHandle, boundsPtr);
  state.overlayClass.SetOverlayFlag(state.overlayHandle, OpenVR.OverlayFlags.VROverlayFlags_Panorama, false)
  state.overlayClass.SetOverlayFlag(state.overlayHandle, OpenVR.OverlayFlags.VROverlayFlags_StereoPanorama, true)


  state.overlayClass.SetOverlayWidthInMeters(state.overlayHandle, 3)

  const idtransform: OpenVR.HmdMatrix34 = {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, -1]
    ]
  }
  const [transformptr, _transview] = createStruct<OpenVR.HmdMatrix34>(idtransform, OpenVR.HmdMatrix34Struct)

  state.overlayClass.SetOverlayTransformTrackedDeviceRelative(state.overlayHandle, OpenVR.k_unTrackedDeviceIndex_Hmd, transformptr)

  const textureData = {
    handle: BigInt(texture[0]),
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  };
  const [textureStructPtr, _textureStructView ] = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct)
  WebCapLoop(textureStructPtr);
}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  state.isRunning = false;
  if (state.webCapturer) {
    await state.webCapturer.dispose();
    state.webCapturer = null;
  }
}

import { PostMan, wait } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { ScreenCapturer, type CapturedFrame } from "../classes/CefCap/frame_receiver.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { setImmediate } from "node:timers";
import { getOverlayTransformAbsolute, setOverlayTransformAbsolute } from "../classes/openvrTransform.ts";
import {  invertMatrix4, scaleMatrix4} from "../classes/matrixutils.ts";

import { splitSBSTexture } from "../classes/extrautils.ts";

//takes an overlay handle and a frame source, updates overlay texture continuously
interface frame {
  pixels: Uint8Array,
  width: number,
  height: number
}

interface frametype {
  pixels: Uint8Array,
  width: number,
  height: number
}

const state = {
  name: "updater",
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  glManager: null as OpenGLManager | null,
  isRunning: false as boolean,
  Capturer: null as ScreenCapturer | null,
  currentFrame: null as CapturedFrame | null,
  hmdpose: null as OpenVR.TrackedDevicePose | null,
  vrSystem: null as OpenVR.IVRSystem | null,
  socket: null as WebSocket | null, 
  
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
    main()
  },
  INITOPENVR: (payload) => {
    const ptrn = payload;
    const systemPtr = Deno.UnsafePointer.create(ptrn); 
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);  

    CustomLogger.log("actor", `OpenVR system initialized in actor ${PostMan.state.id} with pointer ${ptrn}`);
  },
  HMDPOSE: (payload: OpenVR.TrackedDevicePose) => {
    state.hmdpose = payload
    // Pose sending via IPC will be handled separately later
  } 
} as const);

function INITIPCCAP(): ScreenCapturer {
  const capturer = new ScreenCapturer ({
    debug: false, 
    onStats: ({ fps, avgLatency }) => {
      CustomLogger.log("screencap", `IPC Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
    },
  });
  
  return capturer;
}

async function IpcCapLoop(
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) { 
  console.log("IpcCapLoop starting - using push notifications")
  
  // Track if we're currently processing a frame
  let processingFrame = false; 
  

  // Function to process the latest frame from webcapturer
  async function processLatestFrame() {
    // If already processing a frame, don't start another one
    if (processingFrame) {
      //console.log("still processing frame")
      return;
    }
    
    try {
      // Set flag to prevent parallel processing
      processingFrame = true;
      
      if (!state.Capturer) throw new Error("no framesource or ipc capturer")
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
        
        sendpose(hmdPose)
      }

      // ==========================================
      // END OF INTEGRATED HMD POSE TRACKING
      // ==========================================
      
      // Get latest frame with minimal overhead
      if (!state.Capturer) throw new Error("no ipc capturer")





      if (state.currentFrame === null) { 
        console.log("no frame available");
        processingFrame = false;
        return;
      }



      state.currentFrame 

      const historicalPose = state.hmdpose;
      
      // Pass the historical pose directly to the texture creation function
      // instead of modifying the global state
      createTextureFromData(state.currentFrame.data, state.currentFrame.width, state.currentFrame.height, historicalPose);

      

      // Update the texture in the overlay
      //console.log("frame up")
      const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
      if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("Error setting overlay texture");

      state.overlayClass.WaitFrameSync(100) 
      
    } catch (error) {
      console.error("Error processing frame:", error);
    } finally {
      // Clear flag to allow processing next frame
      await wait(1)
      processingFrame = false;
    }
  }
  
  // Setup for new frame notification with callback
  if (state.Capturer) { 
    // Register callback for immediate processing when new frames arriveprocessLatestFrame
    state.Capturer.onNewFrame((frame) => { 
      state.currentFrame = frame
      processLatestFrame()
    }); 
    
    console.log("IPC Push notification system ready for frames");
  } else {
    throw new Error("No frame source available");
  }
  
  // Keep the function alive while the system is running
  while (state.isRunning) {
    await wait(1000); // Just wait to keep the function active
  }
}


function createTextureFromData(pixels: Uint8Array, width: number, height: number, renderPose?: OpenVR.TrackedDevicePose | null): void {
  //console.log(`[WebUpdater] createTextureFromData: Received pixels type=${typeof pixels}, length=${pixels?.byteLength}, width=${width}, height=${height}`); // DEBUG
  
  if (!state.overlayClass || !state.overlayHandle) {
    throw new Error("Missing required state properties for texture creation");
  }
  
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
  if (!state.vrSystem) throw new Error("no vr system")

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
  if (!state.glManager) throw new Error("no gl manager")
  
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

function sendpose(pose: OpenVR.TrackedDevicePose) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    try {
      // Serialize the pose data. You might want a more specific format later.
      const poseData = JSON.stringify(pose);
      state.socket.send(poseData);
    } catch (error) {
      console.error("Error sending pose data via WebSocket:", error);
      // Handle potential serialization errors or closed socket during send
    }
  } else {
    //console.log("WebSocket not ready to send pose data.");
    
  }
}

function main() {
  if (!state.overlayClass) throw new Error("no overlayclass")
  if (!state.overlayHandle) throw new Error("no overlayhandle")
  


  state.Capturer = INITIPCCAP();
  state.Capturer.start() 

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
  IpcCapLoop(textureStructPtr);

  Deno.serve({ port: 8887 }, (req) => {
    if (req.headers.get("upgrade") != "websocket") {
      return new Response(null, { status: 501 }); // Not a WebSocket request
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", () => {
      console.log("WebSocket client connected!");
      // Assign the connected socket to the state
      // Note: This only handles one client. For multiple clients, you'd need a different approach.
      if (state.socket && state.socket.readyState !== WebSocket.CLOSED) {
        console.warn("Replacing existing WebSocket connection.");
        state.socket.close(); // Close the old one if it exists
      }
      state.socket = socket;
    });

    socket.addEventListener("message", (event) => {
      console.log("Received message:", event.data);
      if (event.data === "ping") {
        socket.send("pong");
      }
      // Add more message handling logic here if needed
    });

    socket.addEventListener("close", () => {
      console.log("WebSocket client disconnected.");
      if (state.socket === socket) {
        state.socket = null; // Clear the state if this socket closes
      }
    });

    socket.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
      if (state.socket === socket) {
        state.socket = null; // Clear the state on error too
      }
    });

    return response; // Return the response to complete the upgrade
  })
}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  state.isRunning = false;
  if (state.Capturer) { 
    await state.Capturer.dispose(); 
    state.Capturer = null; 
  }
}

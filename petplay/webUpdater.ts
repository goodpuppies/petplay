import { PostMan, wait } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { ScreenCapturer, type CapturedFrame } from "../classes/CefCap/frame_receiver.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { invertMatrix4, scaleMatrix4 } from "../classes/matrixutils.ts";
import { splitSBSTexture } from "../classes/extrautils.ts";
import { setImmediate } from "node:timers";

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
  
  MAX_POSE_HISTORY: 100, // Store a large history for debugging
  
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

function IpcCapLoop(
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) {
  console.log("IpcCapLoop starting - using push notifications")
  if (!state.glManager) throw new Error("no gl manager")

  let lastFrameEnd = performance.now();
  
  let processingFrame = false;
  const sourceVerticalHalfFOVRadians = (112.0 / 2.0) * (Math.PI / 180.0);

  // Pre-allocate buffers outside the frame processing function
  let leftPixels: Uint8Array | null = null;
  let rightPixels: Uint8Array | null = null;

  // Function to process the latest frame from webcapturer
  function processLatestFrame() {
    // If already processing a frame, don't start another one
    if (processingFrame) {
      //console.log("still processing frame")
      return;
    }
    const frameStart = performance.now()

    try {
      // Set flag to prevent parallel processing
      processingFrame = true;

      if (!state.Capturer) throw new Error("no framesource or ipc capturer")
      if (!state.overlayClass) throw new Error("no overlay")
      if (!state.overlayHandle) throw new Error("no overlay")

      // Get latest frame with minimal overhead
      if (!state.Capturer) throw new Error("no ipc capturer")

      if (state.currentFrame === null) {
        //console.log("no frame available"); // Less noisy log
        processingFrame = false;
        return;
      }

      let t0 = performance.now();
      const textureData = createTextureFromData(state.currentFrame.data, state.currentFrame.width, state.currentFrame.height) as [Uint8Array, number, number, Float32Array];
      // Destructure the typed result
      const [pixelsX, width, height, finalCurrentPose] = textureData;
      let t1 = performance.now();
      //console.log(`createTextureFromData took ${t1 - t0} ms`);

      t0 = performance.now();
      // Ensure output buffers are allocated and correctly sized
      const eyeWidth = width / 2;
      const requiredEyeSize = eyeWidth * height * 4;
      if (!leftPixels || leftPixels.byteLength !== requiredEyeSize) {
        console.log(`Allocating/Reallocating eye buffers: ${eyeWidth}x${height} (${requiredEyeSize} bytes)`);
        leftPixels = new Uint8Array(requiredEyeSize);
        rightPixels = new Uint8Array(requiredEyeSize);
      }

      // Call the modified splitSBSTexture
      splitSBSTexture(pixelsX, width , height, leftPixels, rightPixels as Uint8Array);
      t1 = performance.now();
      //console.log(`splitSBSTexture took ${t1 - t0} ms`);

      t0 = performance.now();
      // Use the pre-allocated (and now filled) buffers
      state.glManager!.renderPanoramaFromData(
        leftPixels, // Pass the filled buffer
        rightPixels as Uint8Array, // Pass the filled buffer
        width as number / 2,
        height as number,
        finalCurrentPose as Float32Array, // Render pose
        sourceVerticalHalfFOVRadians,
        finalCurrentPose as Float32Array // Current pose for reprojection
      );
      t1 = performance.now();
      //console.log(`renderPanoramaFromData took ${t1 - t0} ms`);


      // Update the texture in the overlay
      //console.log("frame up")
      t0 = performance.now();
      const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
      if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("Error setting overlay texture");
      t1 = performance.now();
      //console.log(`SetOverlayTexture took ${t1 - t0} ms`);
      const frameEnd = performance.now()
      //console.log(`full frame took ${frameEnd - frameStart} ms`);
      //state.overlayClass.WaitFrameSync(100)

    } catch (error) {
      console.error("Error processing frame:", error);
    } finally {
      // Clear flag to allow processing next frame
      //await wait(0)

      processingFrame = false;
    }
  }

  if (state.Capturer) {
    state.Capturer.onNewFrame((frame) => {
      const now = performance.now();

      // 1) Idle-time: how long we sat waiting since the end of last frame’s processing
      const idleTime = now - lastFrameEnd;

      // 2) Start processing
      const procStart = now;
      state.currentFrame = frame;
      processLatestFrame();
      const procEnd = performance.now();

      // 3) Processing time
      const processingTime = procEnd - procStart;

      // 4) Update lastFrameEnd for the next round
      lastFrameEnd = procEnd;

      /* console.log(
        `⏱ idle: ${idleTime.toFixed(2)} ms,  processing: ${processingTime.toFixed(2)} ms`
      ); */
    });

    console.log("IPC Push notification system ready for frames");
  } else {
    throw new Error("No frame source available");
  }
}



function createTextureFromData(pixels: Uint8Array, width: number, height: number, renderPose?: OpenVR.TrackedDevicePose | null) {
  if (!state.overlayClass || !state.overlayHandle) throw new Error("Missing required state properties for texture creation");
  if (!state.vrSystem) throw new Error("no vr system")


  
  //const renderHmdPose = renderPose || state.hmdpose!; //fallback to current pose in state
  const currentHmdPose = gethmdpose()
   
  //if (!renderHmdPose.bPoseIsValid) throw new Error("Invalid tracking data");
  if ( !currentHmdPose.bPoseIsValid) throw new Error("Invalid tracking data");


  //const renderHmdMatVR = renderHmdPose.mDeviceToAbsoluteTracking.m;
  // 1. Convert OpenVR matrix (row-major) to Column-Major Float32Array (HMD -> World)
  /* const renderUniverseFromHmd_ColMajor = new Float32Array([
    renderHmdMatVR[0][0], renderHmdMatVR[1][0], renderHmdMatVR[2][0], 0,
    renderHmdMatVR[0][1], renderHmdMatVR[1][1], renderHmdMatVR[2][1], 0,
    renderHmdMatVR[0][2], renderHmdMatVR[1][2], renderHmdMatVR[2][2], 0,
    0, 0, 0, 1
  ]); */

  const currentHmdMatVR = currentHmdPose.mDeviceToAbsoluteTracking.m;
  const currentUniverseFromHmd_ColMajor = new Float32Array([
    currentHmdMatVR[0][0], currentHmdMatVR[1][0], currentHmdMatVR[2][0], 0,
    currentHmdMatVR[0][1], currentHmdMatVR[1][1], currentHmdMatVR[2][1], 0,
    currentHmdMatVR[0][2], currentHmdMatVR[1][2], currentHmdMatVR[2][2], 0,
    0, 0, 0, 1
  ]);


  //const hmdFromUniverse_ColMajor = invertMatrix4(renderUniverseFromHmd_ColMajor)!;
 // const finalRenderPose = scaleMatrix4(hmdFromUniverse_ColMajor, [1, 1, -1]);

  const currentHmdFromUniverse_ColMajor = invertMatrix4(currentUniverseFromHmd_ColMajor)!;
  const finalCurrentPose = scaleMatrix4(currentHmdFromUniverse_ColMajor, [1, 1, -1]);

  if (width % 2 !== 0) throw new Error("Input texture width is not even");
  return [pixels, width, height, finalCurrentPose ]

}





function main() {
  if (!state.overlayClass) throw new Error("no overlayclass")
  if (!state.overlayHandle) throw new Error("no overlayhandle")
  


  state.Capturer = INITIPCCAP();
  state.Capturer.start() 

  state.isRunning = true;
  
  INITGL();

  const texture = state.glManager!.getPanoramaTexture();
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


}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  state.isRunning = false;
  if (state.Capturer) { 
    await state.Capturer.dispose(); 
    state.Capturer = null; 
  }
}

//#region helpers
function gethmdpose() {
  if (!state.vrSystem) throw new Error("no vr system")
  const poseArrayBuffer = new ArrayBuffer(OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount);
  const posePtr = Deno.UnsafePointer.of(poseArrayBuffer) as Deno.PointerValue<OpenVR.TrackedDevicePose>;
  state.vrSystem.GetDeviceToAbsoluteTrackingPose(
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    0.0,
    posePtr,
    OpenVR.k_unMaxTrackedDeviceCount
  );
  const poseView = new DataView(
    poseArrayBuffer,
    OpenVR.k_unTrackedDeviceIndex_Hmd * OpenVR.TrackedDevicePoseStruct.byteSize,
    OpenVR.TrackedDevicePoseStruct.byteSize
  );
  return OpenVR.TrackedDevicePoseStruct.read(poseView) as OpenVR.TrackedDevicePose;
}

function INITGL(name?: string) {
  state.glManager = new OpenGLManager();
  state.glManager.initializePanoramic(name, 4096, 4096);
  if (!state.glManager) { throw new Error("glManager is null"); }
}
//#endregion
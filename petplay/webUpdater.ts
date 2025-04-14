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
  isRunning: false,
  screenCapturer: null as WebCapturer | null,
  currentFrame: null as frame | null,
  framesource: null as string | null,
  hmdpose: null as OpenVR.TrackedDevicePose | null,
  vrSystem: null as OpenVR.IVRSystem | null,
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
    hmdloop()
  },
  /* HMDPOSE: (payload: OpenVR.TrackedDevicePose) => {
    state.hmdpose = payload
    state.screenCapturer?.sendWsMsg(JSON.stringify(payload))
  } */
} as const);

async function hmdloop() {
  while (true) {
    const vrSystem = state.vrSystem!;
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

    // Add timestamp to the pose data for accurate tracking on the frontend
    const timestampedPose = {
      ...hmdPose,
      timestamp: Date.now() // Add high-precision timestamp
    };

    state.hmdpose = timestampedPose;
    if (state.screenCapturer) {
      state.screenCapturer?.sendWsMsg(JSON.stringify(timestampedPose))
    }
    await wait(1)
  }
}

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
  console.log("webcaploop")
  while (state.isRunning) {
    if (!state.framesource && !state.screenCapturer) throw new Error("no framesource")
    if (!state.overlayClass) throw new Error("no overlay")
    if (!state.overlayHandle) throw new Error("no overlay")
    
    let frame: frametype | null
    if (state.screenCapturer) {
      const capturedFrame = await state.screenCapturer!.getLatestFrame();
      if (capturedFrame === null) { console.log("no frane"); await wait(1000); continue }
      frame = {
        pixels: capturedFrame.data,
        width: capturedFrame.width,
        height: capturedFrame.height
      }
      state.currentFrame = frame
      await new Promise(resolve => setImmediate(resolve)); 
    } else {
      // Get the frame from remote source
      const remoteFrame = await PostMan.PostMessage({
        target: state.framesource!,
        type: "GETFRAME",
        payload: null
      }, true) as { pixels: string, width: number, height: number } | null;
      if (!remoteFrame) { console.log("no frame"); await wait(1000); continue }
      frame = {
        pixels: Buffer.from(remoteFrame.pixels, 'base64'),
        width: remoteFrame.width,
        height: remoteFrame.height
      };
    }

    if (!frame) { console.log("no frane"); await wait(1000); continue }
    createTextureFromData(frame.pixels, frame.width, frame.height);
    const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("wtf")
    //state.overlayClass.WaitFrameSync(100)
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

function createTextureFromData(pixels: Uint8Array, width: number, height: number): void {
  if (!state.glManager) { throw new Error("glManager is null"); }
  if (!state.hmdpose) { console.warn("no hmdpose yet, skipping render"); return; }

  const hmdMatVR = state.hmdpose.mDeviceToAbsoluteTracking.m;

  // 1. Convert OpenVR matrix (row-major) to Column-Major Float32Array (HMD -> World)
  const universeFromHmd_ColMajor = new Float32Array([
    hmdMatVR[0][0], hmdMatVR[1][0], hmdMatVR[2][0], 0,
    hmdMatVR[0][1], hmdMatVR[1][1], hmdMatVR[2][1], 0,
    hmdMatVR[0][2], hmdMatVR[1][2], hmdMatVR[2][2], 0,
    0, 0, 0, 1
  ]);

  // 2. Calculate the inverse (World -> HMD)
  const hmdFromUniverse_ColMajor = invertMatrix4(universeFromHmd_ColMajor);
  if (!hmdFromUniverse_ColMajor) {
    console.error("Failed to invert HMD pose matrix!");
    return; // Cannot proceed without inverse
  }

  // 3. Apply the Z-axis scale (1, 1, -1)
  const finalLookRotation = scaleMatrix4(hmdFromUniverse_ColMajor, [1, 1, -1]);

  // Use the original FOV value
  const sourceVerticalHalfFOVRadians = (112.0 / 2.0) * (Math.PI / 180.0);

  // Split the SBS texture (keep your existing splitSBSTexture function)
  if (width % 2 !== 0) {
    console.error("Input texture width is not even, cannot split SBS correctly.");
    return;
  }
  const eyeWidth = width / 2;
  const { left: leftPixels, right: rightPixels } = splitSBSTexture(pixels, width, height);

  // Call the render function with the CORRECT lookRotation
  state.glManager.renderPanoramaFromData(
    leftPixels,
    rightPixels,
    eyeWidth,
    height,
    finalLookRotation, // Pass the calculated inverse & scaled matrix
    sourceVerticalHalfFOVRadians
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
    state.screenCapturer = INITSCREENCAP();
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
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
}

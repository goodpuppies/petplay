import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { OpenVRTransform } from "../classes/openvrTransform.ts";
import { isValidMatrix, multiplyMatrix, invertMatrix, matrixEquals } from "../classes/matrixutils.ts";

const state = {
  id: "",
  db: {},
  name: "dogoverlay",
  sync: false,
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayerror: OpenVR.OverlayError.VROverlayError_None,
  overlayHandle: 0n,
  overlayTransform: null as OpenVRTransform | null,
  addressBook: new Set(),
  TrackingUniverseOriginPTR: null,
  vrSystem: null as OpenVR.IVRSystem | null,
  vrcOriginActor: null as string | null,
  vrcOrigin: null as OpenVR.HmdMatrix34 | null,
  smoothedVrcOrigin: null as OpenVR.HmdMatrix34 | null,
  relativePosition: {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0]
    ]
  } as OpenVR.HmdMatrix34,
  isRunning: false,
  screenCapturer: null as ScreenCapturer | null,
  grabbedController: null as "left" | "right" | null,
  grabOffset: null as OpenVR.HmdMatrix34 | null,
  inputActor: "",
};

const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

// Define a type for the serialized BigInt format
type SerializedBigInt = { __bigint__: string };

new PostMan(state.name, {
  CUSTOMINIT: (_payload: void) => {
    PostMan.setTopic("muffin")
  },
  LOG: (_payload: void) => {
    CustomLogger.log("actor", state.id);
  },
  GETID: (_payload: void) => {
    return state.id
  },
  STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, inputActor?: string }) => {
    if (payload.inputActor) {
      state.inputActor = payload.inputActor;
    }
    main(payload.name, payload.texture, payload.sync);
  },
  GETOVERLAYLOCATION: (_payload: void) => {
    const m34 = GetOverlayTransformAbsolute();
    return m34
  },
  SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    //console.log("SETOVERLAYLOCATION", PostMan.state.id);
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
      // Update relative position
      state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), transform);
      // When explicitly setting location, apply it immediately without smoothing
      setOverlayTransformAbsolute(transform);
    } else {
      // If no valid VRC origin, set absolute position directly without smoothing
      setOverlayTransformAbsolute(transform);
    }
  },
  SYNCOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    //console.log("SYNCOVERLAYLOCATION", PostMan.state.id);
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    // Store the received transform as our relative position
    state.relativePosition = transform;
    
    // When syncing positions between overlays in the same space,
    // we need to consider the current VRC origin
    if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
      // Calculate new absolute position by combining VRC origin with received relative position
      const newAbsolutePosition = multiplyMatrix(state.smoothedVrcOrigin, state.relativePosition);
      
      // Apply the new absolute position directly without additional smoothing
      // This ensures synced overlays appear in exactly the same position
      setOverlayTransformAbsolute(newAbsolutePosition);
      
      //CustomLogger.log("overlay", `Applied synced position from remote overlay with VRC origin`);
    } else {
      // If no valid VRC origin, set absolute position directly without smoothing
      setOverlayTransformAbsolute(transform);
      //CustomLogger.log("overlay", `Applied synced position from remote overlay without VRC origin`);
    }
  },
  INITOPENVR: (payload: bigint | SerializedBigInt) => {
    let ptrn: bigint;
    
    // Handle serialized BigInt coming from the network
    if (typeof payload === 'object' && payload !== null && '__bigint__' in payload) {
      ptrn = BigInt(payload.__bigint__);
    } else {
      ptrn = payload as bigint;
    }
    
    //console.log("INITOPENVR using pointer value:", ptrn);
    const systemPtr = Deno.UnsafePointer.create(ptrn);
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
    CustomLogger.log("overlay", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
  },
  ASSIGNVRCORIGIN: (payload: string) => {
    state.vrcOriginActor = payload;
    CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);

    // Start the update loop if it's not already running and we have an overlay
    if (state.overlayTransform && !state.isRunning) {
      state.isRunning = true;
      updateLoop();
    }
  }
} as const);

//#region screencapture


//#endregion

//#region openvr funcs

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
  if (state.overlayTransform) {
    state.overlayTransform.setTransformAbsolute(transform);
  }
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
  if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
  return state.overlayTransform.getTransformAbsolute();
}

//#endregion

async function main(overlayname: string, overlaytexture: string, sync: boolean) {
  state.sync = sync;

  //#region create overlay
  CustomLogger.log("overlay", "Creating overlay...");
  const overlay = state.overlayClass as OpenVR.IVROverlay;
  const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
  if (!overlay) throw new Error("openvr not ready")
  const error = overlay.CreateOverlay(overlayname, overlayname, overlayHandlePTR);

  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
  }
  if (overlayHandlePTR === null) throw new Error("Invalid pointer");
  const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
  state.overlayHandle = overlayHandle;
  state.overlayTransform = new OpenVRTransform(overlay, overlayHandle);
  CustomLogger.log("overlay", `Overlay created with handle: ${overlayHandle}`);

  // Send overlay handle to input actor if specified
  if (state.inputActor) {
    PostMan.PostMessage({
      address: { fm: state.id, to: state.inputActor },
      type: "SETOVERLAYHANDLE",
      payload: overlayHandle
    });
  }


  const imgpath = Deno.realPathSync(overlaytexture);
  overlay.SetOverlayFromFile(overlayHandle, imgpath);
  overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

  overlay.ShowOverlay(overlayHandle);


  CustomLogger.log("overlay", "Overlay initialized and shown");
  //#endregion

  // Initialize screen capture





  state.isRunning = true;

  // Start the desktop capture loop



  updateLoop();
  
}

function addToSmoothingWindow(window: OpenVR.HmdMatrix34[], transform: OpenVR.HmdMatrix34) {
  if (window.length >= smoothingWindowSize) {
    window.shift();
  }
  window.push(transform);
}

function getSmoothedTransform(window: (OpenVR.HmdMatrix34 | null)[]): OpenVR.HmdMatrix34 | null {
  const validTransforms = window.filter(isValidMatrix) as OpenVR.HmdMatrix34[];

  if (validTransforms.length === 0) {
    //CustomLogger.warn("smoothing", "No valid transforms in smoothing window");
    return null;
  }

  const smoothedTransform: OpenVR.HmdMatrix34 = {
    m: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]
  };

  for (const transform of validTransforms) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        smoothedTransform.m[i][j] += transform.m[i][j];
      }
    }
  }

  const windowSize = validTransforms.length;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      smoothedTransform.m[i][j] /= windowSize;
    }
  }

  return smoothedTransform;
}

async function updateLoop() {
  // Track the last synced position to avoid unnecessary updates
  let lastSyncedRelativePosition: OpenVR.HmdMatrix34 | null = null;
  let lastSyncTime = 0;
  const syncInterval = 1000; // Sync at most every 200ms to limit network traffic

  while (state.isRunning) {


    try {
      // Only proceed if we have a VRC origin actor assigned
      if (state.vrcOriginActor) {
        // Get the current VRC origin position
        const newVrcOrigin = await PostMan.PostMessage({
          target: state.vrcOriginActor,
          type: "GETVRCORIGIN",
          payload: null,
        }, true) as OpenVR.HmdMatrix34;

        // If we got a valid matrix
        if (isValidMatrix(newVrcOrigin)) {
          // Store the raw origin
          state.vrcOrigin = newVrcOrigin;

          // Add to smoothing window for a smoother experience
          addToSmoothingWindow(vrcOriginSmoothingWindow, newVrcOrigin);
          const smoothedNewVrcOrigin = getSmoothedTransform(vrcOriginSmoothingWindow);

          // Update our position if we have a valid smoothed origin and it's different from what we had before
          if (smoothedNewVrcOrigin && (!state.smoothedVrcOrigin || !matrixEquals(state.smoothedVrcOrigin, smoothedNewVrcOrigin))) {
            // Update our smoothed VRC origin
            state.smoothedVrcOrigin = smoothedNewVrcOrigin;

            // Calculate new absolute position by combining VRC origin with our relative position
            const newAbsolutePosition = multiplyMatrix(state.smoothedVrcOrigin, state.relativePosition);

            // Add to smoothing window for the overlay position
            addToSmoothingWindow(smoothingWindow, newAbsolutePosition);
            const smoothedAbsolutePosition = getSmoothedTransform(smoothingWindow);

            // Apply the smoothed position to the overlay
            if (smoothedAbsolutePosition) {
              setOverlayTransformAbsolute(smoothedAbsolutePosition);
            }
          }

          // Check if we should sync our position to other dogoverlay actors
          const now = Date.now();
          if (
            // Only sync if enough time has passed since last sync
            (now - lastSyncTime > syncInterval) &&
            // Only sync if our position has changed significantly
            (!lastSyncedRelativePosition || !matrixEquals(lastSyncedRelativePosition, state.relativePosition))
          ) {
            //await wait(500)
            //console.log(PostMan.state.id,  PostMan.state.addressBook)
            //CustomLogger.log("overlay", "sync");

            // Find all dogoverlay actors in addressbook (excluding self)
            const dogOverlayActors = Array.from(PostMan.state.addressBook)
              .filter((addr): addr is string => typeof addr === 'string' && addr.startsWith('dogoverlay@') && addr !== state.id);

            if (dogOverlayActors.length > 0) {
              CustomLogger.log("overlay", `Syncing position to ${dogOverlayActors.length} remote actors`);

              // Send our position to all other dogoverlay actors
              if (state.sync) {
                PostMan.PostMessage({
                  target: dogOverlayActors,
                  type: "SYNCOVERLAYLOCATION",
                  payload: state.relativePosition,
                });
              }
              
              // Update sync tracking
              lastSyncedRelativePosition = { ...state.relativePosition };
              lastSyncTime = now;
            }
          }
        } else {
          CustomLogger.log("updateLoop", "Received invalid VRC origin matrix");
        }
      } else {
        CustomLogger.log("updateLoop", "No VRC origin actor assigned");
      }

      // Run at 90Hz for smooth VR experience
      await wait(1000 / 90);
    } catch (error) {
      CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
      await wait(1000); // Wait a bit longer on error to avoid spam
    }
  }
}

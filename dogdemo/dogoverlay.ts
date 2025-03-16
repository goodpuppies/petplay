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
  INITOPENVR: (payload: bigint) => {
    const ptrn = payload;
    const systemPtr = Deno.UnsafePointer.create(ptrn);
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
    CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
  },
  ASSIGNVRCORIGIN: (payload: string) => {
    state.vrcOriginActor = payload;
    CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);
  }
} as const);




//#region screencapture


//#endregion

//#region openvr funcs

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
  state.overlayTransform.setTransformAbsolute(transform);
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
  if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
  return state.overlayTransform.getTransformAbsolute();
}

//#endregion

function main(overlayname: string, overlaytexture: string, sync: boolean) {
  try {



    //#region create overlay
    CustomLogger.log("overlay", "Creating overlay...");
    const overlay = state.overlayClass as OpenVR.IVROverlay;
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
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
  } catch (error) {
    console.error("err", error)
    CustomLogger.error("overlay", "Error in main:", error);
    if (error instanceof Error) {
      CustomLogger.error("overlay", "Stack:", error.stack);
    }
  }
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
  while (state.isRunning) {
    try {
      // Only update VRC origin if we're not being grabbed
      if (state.vrcOriginActor && !state.grabbedController) {
        const newVrcOrigin = await PostMan.PostMessage({
          target: state.vrcOriginActor,
          type: "GETVRCORIGIN",
          payload: null,
        }, true) as OpenVR.HmdMatrix34;

        if (isValidMatrix(newVrcOrigin)) {
          addToSmoothingWindow(vrcOriginSmoothingWindow, newVrcOrigin);
          const smoothedNewVrcOrigin = getSmoothedTransform(vrcOriginSmoothingWindow);

          if (smoothedNewVrcOrigin && (!state.smoothedVrcOrigin || !matrixEquals(state.smoothedVrcOrigin, smoothedNewVrcOrigin))) {
            state.smoothedVrcOrigin = smoothedNewVrcOrigin;
            const newAbsolutePosition = multiplyMatrix(state.smoothedVrcOrigin, state.relativePosition);
            addToSmoothingWindow(smoothingWindow, newAbsolutePosition);
            const smoothedAbsolutePosition = getSmoothedTransform(smoothingWindow);
            if (smoothedAbsolutePosition) {
              setOverlayTransformAbsolute(smoothedAbsolutePosition);
            }
          }
        } else {
          //CustomLogger.warn("updateLoop", "Received invalid VRC origin");
        }


      }

      // Always get controller data when we have an input actor
      /* if (!state.inputActor) {
        const controllerData = await PostMan.PostMessage({
          target: state.inputActor,
          type: "GETCONTROLLERDATA",
          payload: null
        }, true) as [OpenVR.InputPoseActionData, OpenVR.InputPoseActionData];

        if (controllerData) {
          // If we're grabbed, update position
          if (state.grabbedController && state.grabOffset) {
            const [leftPose, rightPose] = controllerData;
            const controllerPose = state.grabbedController === "left" ? leftPose : rightPose;

            if (controllerPose) {
              // Calculate new overlay position based on controller position and stored offset
              const newTransform = multiplyMatrix(controllerPose.pose.mDeviceToAbsoluteTracking, state.grabOffset);
              setOverlayTransformAbsolute(newTransform);

              // Update relative position to match current grab position
              if (state.smoothedVrcOrigin) {
                state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), newTransform);
              }
            }
          }
        }
      } */

      await wait(1000 / 90); // 90hz update rate
    } catch (error) {
      CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
    }
  }
}

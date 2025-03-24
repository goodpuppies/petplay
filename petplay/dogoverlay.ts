import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { OpenVRTransform } from "../classes/openvrTransform.ts";
import { isValidMatrix, multiplyMatrix, invertMatrix, matrixEquals } from "../classes/matrixutils.ts";

const state = {
  id: "",
  name: "dogoverlay",
  sync: false,
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayerror: OpenVR.OverlayError.VROverlayError_None,
  overlayHandle: 0n,
  overlayTransform: null as OpenVRTransform | null,
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
  inputActor: "",
};

const smoothingWindowSize = 10;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const vrcOriginSmoothingWindow: OpenVR.HmdMatrix34[] = [];

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => {},
  STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, inputActor?: string }) => {
    if (payload.inputActor) {
      state.inputActor = payload.inputActor;
    }
    main(payload.name, payload.texture, payload.sync);
  },
  GETOVERLAYLOCATION: (_payload: void) => {return GetOverlayTransformAbsolute();},
  SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
      state.relativePosition = multiplyMatrix(invertMatrix(state.smoothedVrcOrigin), transform);
      setOverlayTransformAbsolute(transform);
    } else {
      setOverlayTransformAbsolute(transform);
    }
  },
  SYNCOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    state.relativePosition = transform;
    
    if (state.smoothedVrcOrigin && isValidMatrix(state.smoothedVrcOrigin)) {
      const newAbsolutePosition = multiplyMatrix(state.smoothedVrcOrigin, state.relativePosition);

      setOverlayTransformAbsolute(newAbsolutePosition);
    } else {
      setOverlayTransformAbsolute(transform);
    }
  },
  INITOVROVERLAY: (payload: bigint) => {
    const systemPtr = Deno.UnsafePointer.create(payload);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
  },
  ASSIGNVRCORIGIN: (payload: string) => {
    state.vrcOriginActor = payload;
    CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);

    if (state.overlayTransform && !state.isRunning) {
      state.isRunning = true;
      updateLoop();
    }
  }
} as const);

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
  if (state.overlayTransform) {
    state.overlayTransform.setTransformAbsolute(transform);
  }
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
  if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
  return state.overlayTransform.getTransformAbsolute();
}

function main(overlayname: string, overlaytexture: string, sync: boolean) {
  state.sync = sync;

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

  if (state.inputActor) {
    PostMan.PostMessage({
      address: { fm: state.id, to: state.inputActor },
      type: "SETOVERLAYHANDLE",
      payload: overlayHandle
    });
  }

  overlay.SetOverlayFromFile(overlayHandle, Deno.realPathSync(overlaytexture));
  overlay.SetOverlayWidthInMeters(overlayHandle, 0.7);

  overlay.ShowOverlay(overlayHandle);

  CustomLogger.log("overlay", "Overlay initialized and shown");
  state.isRunning = true;

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
  let lastSyncedRelativePosition: OpenVR.HmdMatrix34 | null = null;
  let lastSyncTime = 0;
  const syncInterval = 1000;

  while (state.isRunning) {

    try {
      if (state.vrcOriginActor) {
        const newVrcOrigin = await PostMan.PostMessage({
          target: state.vrcOriginActor,
          type: "GETVRCORIGIN",
          payload: null,
        }, true) as OpenVR.HmdMatrix34;

        if (isValidMatrix(newVrcOrigin)) {
          state.vrcOrigin = newVrcOrigin;

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

          const now = Date.now();
          if (
            (now - lastSyncTime > syncInterval) &&
            (!lastSyncedRelativePosition || !matrixEquals(lastSyncedRelativePosition, state.relativePosition))
          ) {

            const dogOverlayActors = Array.from(PostMan.state.addressBook)
              .filter((addr): addr is string => typeof addr === 'string' && addr.startsWith('dogoverlay@') && addr !== state.id);

            if (dogOverlayActors.length > 0) {
              CustomLogger.log("overlay", `Syncing position to ${dogOverlayActors.length} remote actors`);

              if (state.sync) {
                PostMan.PostMessage({
                  target: dogOverlayActors,
                  type: "SYNCOVERLAYLOCATION",
                  payload: state.relativePosition,
                });
              }
              
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

      await wait(1000 / 90);
    } catch (error) {
      CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
      await wait(1000);
    }
  }
}

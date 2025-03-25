import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { getOverlayTransformAbsolute, setOverlayTransformAbsolute } from "../classes/openvrTransform.ts";
import { isValidMatrix, multiplyMatrix, invertMatrix } from "../classes/matrixutils.ts";

const state = {
  id: "",
  name: "genericoverlay",
  sync: false,
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayerror: OpenVR.OverlayError.VROverlayError_None,
  overlayHandle: 0n,
  vrcOriginActor: null as string | null,
  vrcOrigin: null as OpenVR.HmdMatrix34 | null,
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

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => { },
  STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, inputActor?: string }) => {
    if (payload.inputActor) {
      state.inputActor = payload.inputActor;
    }
    main(payload.name, payload.texture, payload.sync);
  },
  GETOVERLAYLOCATION: (_payload: void) => {
    if (!state.overlayClass || !state.overlayHandle) {
      throw new Error("Overlay not initialized");
    }
    return getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
  },
  SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    if (state.vrcOrigin && isValidMatrix(state.vrcOrigin)) {
      state.relativePosition = multiplyMatrix(invertMatrix(state.vrcOrigin), transform);
      setTransform(transform);
    } else {
      setTransform(transform);
    }
  },
  SYNCOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    const transform = payload;
    if (!isValidMatrix(transform)) { throw new Error("Received invalid transform"); }

    state.relativePosition = transform;

    if (state.vrcOrigin && isValidMatrix(state.vrcOrigin)) {
      const newAbsolutePosition = multiplyMatrix(state.vrcOrigin, state.relativePosition);
      setTransform(newAbsolutePosition);
    } else {
      setTransform(transform);
    }
  },
  INITOVROVERLAY: (payload: bigint) => {
    const systemPtr = Deno.UnsafePointer.create(payload);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
  },
  ASSIGNVRCORIGIN: (payload: string) => {
    state.vrcOriginActor = payload;
    CustomLogger.log("actor", `VRC Origin Actor assigned: ${state.vrcOriginActor}`);

    if (state.overlayHandle && !state.isRunning) {
      state.isRunning = true;
      updateLoop();
    }
  },
  GETOVERLAYHANDLE: (_payload: void) => {
    return state.overlayHandle
  }
} as const);

function setTransform(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
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
          const newAbsolutePosition = multiplyMatrix(state.vrcOrigin, state.relativePosition);
          setTransform(newAbsolutePosition);

          const now = Date.now();
          if (
            (now - lastSyncTime > syncInterval) &&
            (!lastSyncedRelativePosition || JSON.stringify(lastSyncedRelativePosition) !== JSON.stringify(state.relativePosition))
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
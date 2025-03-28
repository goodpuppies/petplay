import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { getOverlayTransformAbsolute, setOverlayTransformAbsolute } from "../classes/openvrTransform.ts";
import { multiplyMatrix, invertMatrix } from "../classes/matrixutils.ts";

const state = {
  name: "genericoverlay",
  sync: false,
  isRunning: false,
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayHandle: 0n,
  vrcOrigin: null as OpenVR.HmdMatrix34 | null,
  screenCapturer: null as ScreenCapturer | null,
  relativePosition: {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0]
    ]
  } as OpenVR.HmdMatrix34,
};

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => {
    PostMan.setTopic("muffin")
  },
  GETOVERLAYHANDLE: (_payload: void) => { return state.overlayHandle },
  STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean, }) => {
    main(payload.name, payload.texture, payload.sync);
  },
  INITOVROVERLAY: (payload: bigint) => {
    const systemPtr = Deno.UnsafePointer.create(payload);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
    console.log(PostMan.state.id, "ovr ready")
  },
  GETOVERLAYLOCATION: (_payload: void) => {
    if (!state.overlayClass || !state.overlayHandle) { throw new Error("Overlay not initialized"); }
    return getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
  },
  SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    if (state.vrcOrigin) {
      state.relativePosition = multiplyMatrix(invertMatrix(state.vrcOrigin), payload);
      setTransform(payload);
    } else {
      setTransform(payload);
    }
  },
  ORIGINUPDATE: (payload: OpenVR.HmdMatrix34) => {
    if (!state.overlayHandle) return;
    state.vrcOrigin = payload;
    const newAbsolutePosition = multiplyMatrix(state.vrcOrigin, state.relativePosition);
    setTransform(newAbsolutePosition);
  },
  SYNCOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
    state.relativePosition = payload;
    if (state.vrcOrigin) {
      const newAbsolutePosition = multiplyMatrix(state.vrcOrigin, state.relativePosition);
      setTransform(newAbsolutePosition);
    } else {
      setTransform(payload);
    }
  },
} as const);

function main(overlayname: string, overlaytexture: string, sync: boolean) {
  state.sync = sync;

  //get overlayhandle
  const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
  if (!state.overlayClass) throw new Error(`${PostMan.state.id} openvr not ready`)
  const error = state.overlayClass.CreateOverlay(overlayname, overlayname, overlayHandlePTR);
  if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
  state.overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();

  state.overlayClass.SetOverlayFromFile(state.overlayHandle, Deno.realPathSync(overlaytexture));
  state.overlayClass.SetOverlayWidthInMeters(state.overlayHandle, 0.7);
  state.overlayClass.ShowOverlay(state.overlayHandle);

  CustomLogger.log("overlay", "Overlay initialized and shown");
  state.isRunning = true;

  updateLoop();
}


async function updateLoop() {
  let lastSyncedRelativePosition: OpenVR.HmdMatrix34 | null = null;
  let lastSyncTime = 0;
  const syncInterval = 1000;

  while (state.isRunning) {

    const now = Date.now();
    if (
      (now - lastSyncTime > syncInterval) &&
      (!lastSyncedRelativePosition || JSON.stringify(lastSyncedRelativePosition) !== JSON.stringify(state.relativePosition))
    ) {
      const dogOverlayActors = Array.from(PostMan.state.addressBook)
        .filter((addr): addr is string => typeof addr === 'string' && addr.startsWith('dogoverlay@') && addr !== PostMan.state.id);

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
    await wait(1000 / 90);
  }
}

function setTransform(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}
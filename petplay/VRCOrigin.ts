import { ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { tempFile, wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import {
  getOverlayTransformAbsolute,
  setOverlayTransformAbsolute,
} from "../classes/openvrTransform.ts";
import {
  decodeVrcOriginPose,
  type VrcOriginSource,
  type VrcOriginWorldPose,
} from "../classes/vrcOriginCodec.ts";
import {
  type Matrix34Tuple,
  VrcOriginSolver,
  type VrcWorldToStandingTransform,
} from "../classes/vrcOriginTransform.ts";

const ACTIVE_POLL_MS = 16;
const IDLE_POLL_MS = 250;

const state = actorState({
  origin: null as OpenVR.HmdMatrix34 | null,
  transform: null as VrcWorldToStandingTransform | null,
  worldPose: null as VrcOriginWorldPose | null,
  originSource: null as VrcOriginSource | null,
  name: "origin",
  vrc: "",
  hmd: "",
  running: false,
  showMarker: false,
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayHandle: 0n as OpenVR.OverlayHandle,
  overlayerror: OpenVR.OverlayError.VROverlayError_None,
  originChangeCount: 0,
  overlays: [] as string[],
});

let solver = new VrcOriginSolver();
let loopGeneration = 0;

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    __SHUTDOWN__: (_payload: unknown) => {
      return stopOrigin();
    },
    __HEALTH__: (_payload: unknown) => {
      return {
        running: state.running,
        showMarker: state.showMarker,
        overlayReady: state.overlayClass != null,
        overlayHandleActive: state.overlayHandle !== 0n,
        assignedVrc: state.vrc !== "",
        assignedHmd: state.hmd !== "",
        hasOrigin: state.origin != null,
        originSource: state.originSource,
        worldPose: state.worldPose,
        transform: state.transform,
        overlayCount: state.overlays.length,
        originChangeCount: state.originChangeCount,
      };
    },
    ASSIGNVRC: (payload: string) => {
      state.vrc = payload;
    },
    ASSIGNHMD: (payload: string) => {
      state.hmd = payload;
    },
    ADDADDRESS: (payload: ActorId) => {
      state.addressBook.add(payload);
    },
    GETVRCORIGIN: (_payload: void) => {
      return state.origin;
    },
    GETVRCORIGINSTATE: (_payload: void) => {
      return {
        hasOrigin: state.origin != null,
        source: state.originSource,
        worldPose: state.worldPose,
        transform: state.transform,
        matrix: state.origin,
      };
    },
    STARTORIGIN: (payload: { name?: string; texture?: string; showMarker?: boolean } | null) => {
      const showMarker = payload?.showMarker ?? Boolean(payload?.texture);
      const name = payload?.name ?? "originoverlay";
      const texture = payload?.texture ?? "./resources/PetPlay.png";
      main(name, texture, showMarker);
    },
    STOPORIGIN: (_payload: void) => {
      return stopOrigin();
    },
    GETOVERLAYLOCATION: (_payload: void) => {
      if (!state.overlayClass || !state.overlayHandle) {
        throw new Error("Overlay not initialized");
      }
      return getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
    },
    INITOVROVERLAY: (payload: bigint) => {
      const systemPtr = Deno.UnsafePointer.create(payload);
      state.overlayClass = new OpenVR.IVROverlay(systemPtr);
    },
    ADDOVERLAY: (payload: string) => {
      if (!state.overlays.includes(payload)) {
        state.overlays.push(payload);
      }
      // Push the current origin immediately if we already have one.
      if (state.origin) {
        PostMan.PostMessage({
          target: payload as ActorId,
          type: "ORIGINUPDATE",
          payload: state.origin,
        });
      }
    },
  } as const,
);

function stopOrigin(): true {
  loopGeneration++;
  state.running = false;
  if (state.overlayClass && state.overlayHandle) {
    try {
      state.overlayClass.DestroyOverlay(state.overlayHandle);
    } catch {
      // Ignore OpenVR shutdown races.
    }
  }
  state.overlayHandle = 0n as OpenVR.OverlayHandle;
  state.origin = null;
  state.transform = null;
  state.worldPose = null;
  state.originSource = null;
  solver.reset();
  return true;
}

function originReaction(): void {
  if (state.overlays.length > 0 && state.origin) {
    PostMan.PostMessage({
      target: state.overlays,
      type: "ORIGINUPDATE",
      payload: state.origin,
    });
  }
}

function createDebugMarkerOverlay(overlayName: string, overlayTexture: string): void {
  const overlay = state.overlayClass;
  if (!overlay) return;
  const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
  const error = overlay.CreateOverlay(overlayName, overlayName, overlayHandlePTR);
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
  }
  const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
  state.overlayHandle = overlayHandle;
  const path = tempFile(overlayTexture, import.meta.dirname!);
  const e = overlay.SetOverlayFromFile(overlayHandle, path);
  if (e !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.error("vrcorigin", `SetOverlayFromFile failed: ${OpenVR.OverlayError[e]}`);
  }
  overlay.SetOverlayWidthInMeters(overlayHandle, 0.5);
  overlay.ShowOverlay(overlayHandle);
}

function markerMatrixFromOrigin(origin: Matrix34Tuple): OpenVR.HmdMatrix34 {
  // Lay the marker flat on the VRChat world-origin floor, facing up (-90 deg around X).
  const c = origin[0][0];
  const s = origin[0][2];
  return {
    m: [
      [c, -s, 0, origin[0][3]],
      [0, 0, 1, origin[1][3] + 0.02],
      [-s, -c, 0, origin[2][3]],
    ],
  };
}

async function main(overlayName: string, overlayTexture: string, showMarker: boolean) {
  const generation = ++loopGeneration;
  solver = new VrcOriginSolver();
  state.running = true;
  state.showMarker = showMarker;

  try {
    if (showMarker) {
      LogChannel.log("vrcorigin", "Creating origin marker overlay...");
      createDebugMarkerOverlay(overlayName, overlayTexture);
    }

    while (generation === loopGeneration) {
      if (state.vrc === "" || state.hmd === "") {
        await wait(IDLE_POLL_MS);
        continue;
      }

      let updated = false;
      try {
        updated = await pollOriginOnce();
      } catch (error) {
        LogChannel.error(
          "vrcorigin",
          `pollOriginOnce failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await wait(IDLE_POLL_MS);
        continue;
      }

      await wait(updated || state.origin != null ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
  } catch (e) {
    LogChannel.error("vrcorigin", `Error in origin: ${(e as Error).message}`);
  } finally {
    if (generation === loopGeneration) {
      state.running = false;
    }
  }
}

async function pollOriginOnce(): Promise<boolean> {
  const coordinate = await PostMan.PostMessage({
    target: state.vrc,
    type: "GETCOORDINATE",
    payload: null,
  }, true) as Record<string, number> | null;

  if (!coordinate) return false;
  const worldPose = decodeVrcOriginPose(coordinate);
  if (!worldPose) return false;

  const hmdPose = await PostMan.PostMessage({
    target: state.hmd,
    type: "GETHMDPOSITION",
    payload: null,
  }, true) as OpenVR.TrackedDevicePose;

  if (!hmdPose?.bPoseIsValid) return false;
  const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m as Matrix34Tuple;

  const solved = solver.update(worldPose, hmdMatrix);
  state.worldPose = worldPose;
  state.originSource = worldPose.source;
  state.transform = solved.transform;

  const nextOrigin: OpenVR.HmdMatrix34 = { m: solved.matrix };
  if (state.showMarker && state.overlayHandle) {
    setTransform(markerMatrixFromOrigin(solved.matrix));
  }

  if (solved.changed) {
    state.origin = nextOrigin;
    state.originChangeCount++;
    originReaction();
  }
  return true;
}

function setTransform(transform: OpenVR.HmdMatrix34): void {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}

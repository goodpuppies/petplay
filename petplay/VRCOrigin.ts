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
  type VrcOriginMotion,
  VrcOriginRoomLock,
  type VrcOriginRoomLockMode,
  type VrcOriginSample,
  VrcOriginSolver,
  VrcRootPredictor,
  type VrcWorldToStandingTransform,
} from "../classes/vrcOriginTransform.ts";

const ACTIVE_POLL_MS = 11;
const IDLE_POLL_MS = 250;

const state = actorState({
  origin: null as OpenVR.HmdMatrix34 | null,
  transform: null as VrcWorldToStandingTransform | null,
  /** The solver's unlocked estimate; `transform` is what the room lock publishes. */
  rawTransform: null as VrcWorldToStandingTransform | null,
  lockMode: null as VrcOriginRoomLockMode | null,
  lockErrorMeters: 0,
  lockBreakCount: 0,
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

/** Polled HMD poses: `[epochMs, x, y, z, yawRad, speed]`, for locomotion analysis (`GETHMDTRACE`). */
const hmdTrace: [number, number, number, number, number, number][] = [];
const HMD_TRACE_MAX = 60_000;

let solver = new VrcOriginSolver();
let roomLock = new VrcOriginRoomLock();
let predictor = new VrcRootPredictor();
/** Arrival time of the newest sample taken from the camera actor's `GETORIGINSAMPLES`. */
let newestSampleAt = 0;
let loopGeneration = 0;
/** The `IVROverlay` pointer `INITOVROVERLAY` gave, kept so a reload can rebuild `overlayClass`. */
let overlayPointer: string | null = null;
let lastStart: { name: string; texture: string; showMarker: boolean } | null = null;

type OriginSnapshot = {
  vrc: string;
  hmd: string;
  overlays: string[];
  overlayPointer: string | null;
  start: { name: string; texture: string; showMarker: boolean } | null;
};

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    /** Wiring only: a reload re-solves the origin from the next OSC sample. */
    __SNAPSHOT__: (_payload: unknown): OriginSnapshot => ({
      vrc: state.vrc,
      hmd: state.hmd,
      overlays: [...state.overlays],
      overlayPointer,
      start: state.running ? lastStart : null,
    }),
    __RESTORE__: (payload: OriginSnapshot | null) => {
      if (!payload) return;
      state.vrc = payload.vrc;
      state.hmd = payload.hmd;
      state.overlays = [...payload.overlays];
      if (payload.overlayPointer) {
        overlayPointer = payload.overlayPointer;
        state.overlayClass = new OpenVR.IVROverlay(
          Deno.UnsafePointer.create(BigInt(payload.overlayPointer)),
        );
      }
      if (payload.start) main(payload.start.name, payload.start.texture, payload.start.showMarker);
    },
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
        rawTransform: state.rawTransform,
        lockMode: state.lockMode,
        lockErrorMeters: state.lockErrorMeters,
        lockBreakCount: state.lockBreakCount,
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
    GETHMDTRACE: (payload: { sinceMs?: number } | null) => {
      const since = payload?.sinceMs ?? 0;
      return hmdTrace.filter((entry) => entry[0] > since);
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
      overlayPointer = String(payload);
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
  state.rawTransform = null;
  state.lockMode = null;
  solver.reset();
  roomLock.reset();
  predictor.reset();
  newestSampleAt = 0;
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
  lastStart = { name: overlayName, texture: overlayTexture, showMarker };
  solver = new VrcOriginSolver();
  roomLock = new VrcOriginRoomLock();
  predictor = new VrcRootPredictor();
  newestSampleAt = 0;
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
  const samples = await withTimeout(PostMan.PostMessage({
    target: state.vrc,
    type: "GETORIGINSAMPLES",
    payload: { sinceMs: newestSampleAt },
  }, true)) as VrcOriginSample[] | null;
  for (const sample of samples ?? []) {
    predictor.add(sample);
    newestSampleAt = Math.max(newestSampleAt, sample.t);
  }
  if (!predictor.hasSamples()) {
    // VRChat only sends what changes: after a reload, standing still, seed from the latest values.
    const coordinate = await withTimeout(PostMan.PostMessage({
      target: state.vrc,
      type: "GETCOORDINATE",
      payload: null,
    }, true)) as Record<string, number> | null;
    const seed = coordinate ? decodeVrcOriginPose(coordinate) : null;
    if (!seed) return false;
    predictor.add({ t: performance.timeOrigin + performance.now() - 1000, pose: seed });
  }
  const now = performance.timeOrigin + performance.now();
  const prediction = predictor.predict(now);
  const worldPose = prediction.pose;

  const hmdPose = await withTimeout(PostMan.PostMessage({
    target: state.hmd,
    type: "GETHMDPOSITION",
    payload: null,
  }, true)) as OpenVR.TrackedDevicePose;

  if (!hmdPose?.bPoseIsValid) return false;
  const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m as Matrix34Tuple;

  const raw = solver.update(worldPose, hmdMatrix);
  const v = hmdPose.vVelocity?.v ?? [0, 0, 0];
  hmdTrace.push([
    performance.timeOrigin + performance.now(),
    hmdMatrix[0][3],
    hmdMatrix[1][3],
    hmdMatrix[2][3],
    Math.atan2(hmdMatrix[0][2], hmdMatrix[2][2]),
    Math.hypot(v[0], v[1], v[2]),
  ]);
  if (hmdTrace.length > HMD_TRACE_MAX) hmdTrace.splice(0, 10_000);
  const solved = roomLock.update(
    raw.transform,
    worldPose,
    [hmdMatrix[0][3], hmdMatrix[1][3], hmdMatrix[2][3]],
    Math.hypot(v[0], v[1], v[2]),
    performance.now(),
  );
  if (state.lockMode === "locked" && solved.mode === "moving") state.lockBreakCount++;
  const modeChanged = state.lockMode !== solved.mode;
  state.worldPose = worldPose;
  state.originSource = worldPose.source;
  state.rawTransform = raw.transform;
  state.transform = solved.transform;
  state.lockMode = solved.mode;
  state.lockErrorMeters = solved.errorMeters;

  let motion: VrcOriginMotion | null = null;
  if (solved.mode === "moving") {
    const [x, y, z] = worldPose.position;
    const [vx, vy, vz] = prediction.velocity;
    motion = {
      t: now,
      yawRad: solved.transform.yawRad,
      // Playspace yaw is HMD yaw + avatar yaw (`VrcOriginSolver`): it turns with the avatar.
      yawRate: prediction.yawRate,
      scale: solved.transform.scale,
      pivot: [hmdMatrix[0][3], 0, hmdMatrix[2][3]],
      rootRH: [x, y, -z],
      rootVelocityRH: [vx, vy, -vz],
    };
  }
  const nextOrigin: OpenVR.HmdMatrix34 & { motion: VrcOriginMotion | null } = {
    m: solved.matrix,
    motion,
  };
  if (state.showMarker && state.overlayHandle) {
    setTransform(markerMatrixFromOrigin(solved.matrix));
  }

  // A mode change always goes out: webxr must drop (or pick up) the motion model.
  if (solved.changed || modeChanged) {
    state.origin = nextOrigin;
    state.originChangeCount++;
    originReaction();
  }
  return true;
}

/**
 * A reply that never comes (its actor reloaded mid-request) would stall the poll loop for good;
 * this turns it into an error the loop logs and retries.
 */
function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function setTransform(transform: OpenVR.HmdMatrix34): void {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}

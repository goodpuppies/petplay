import { ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { tempFile, wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { VrcLogWatcher } from "../classes/vrc/logParser.ts";
import { DEFAULT_VRC_JUMP } from "../classes/vrcJumpModel.ts";
import { DEFAULT_VRC_WALK, VrcWorldLocomotionStore } from "../classes/vrcWorldLocomotion.ts";
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
  normalizeAngleRad,
  rotateYawRH,
  unityWorldPointToStanding,
  unityWorldPositionToRightHanded,
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
type SticksPayload = {
  t: number;
  left: [number, number];
  right: [number, number];
  blocked: { left: boolean; right: boolean };
  /** Right A clicked (VRChat's jump). */
  jump?: boolean;
};
let latestSticks: SticksPayload | null = null;
/**
 * The sticks as VRChat sees them. While PetPlay holds a hand's input VRChat keeps the last value
 * it saw before the hold (measured: a turn held when PetPlay takes focus keeps spinning until it
 * lets go, and a stick pushed during the hold does nothing).
 */
const vrcSticks: { left: [number, number]; right: [number, number] } = { left: [0, 0], right: [0, 0] };
/** Right A (jump) as VRChat sees it: frozen like the sticks while PetPlay holds the right hand. */
let vrcJump = false;
/**
 * Airborne: VRChat moves the player (and its playspace, so the world shifts against the room)
 * through a jump, with sticks idle or not. A jump press counts at once, before samples show it;
 * then the root's vertical speed keeps it airborne until the landing, plus `AIRBORNE_HOLD_MS`
 * (the apex has no vertical speed for a moment).
 */
const AIRBORNE_VERTICAL_SPEED = 0.15;
const AIRBORNE_HOLD_MS = 200;
let airborneUntil = 0;

/** The VRChat world (from its log) and what PetPlay learned about moving in it. */
const worldLocomotion = new VrcWorldLocomotionStore();
const vrcLog = new VrcLogWatcher();
const WORLD_POLL_MS = 2000;
let worldPolledAt = 0;
let worldId: string | null = null;
/** The predictor the current world's parameters were given to (it is recreated on start). */
let worldAppliedTo: VrcRootPredictor | null = null;

function syncWorldLocomotion(nowMs: number): void {
  if (nowMs - worldPolledAt >= WORLD_POLL_MS) {
    worldPolledAt = nowMs;
    try {
      vrcLog.poll();
    } catch {
      // The log is optional: without it everything runs on defaults.
    }
    const id = vrcLog.state.instanceId?.split(":")[0] ?? null;
    if (id !== worldId) {
      worldId = id;
      worldAppliedTo = null;
    }
  }
  if (worldAppliedTo === predictor) return;
  worldAppliedTo = predictor;
  const learned = worldId ? worldLocomotion.get(worldId) : undefined;
  predictor.jump.cancel();
  predictor.jump.params = { ...(learned?.jump ?? DEFAULT_VRC_JUMP) };
  predictor.walk = { ...(learned?.walk ?? DEFAULT_VRC_WALK) };
  const forWorld = worldId;
  predictor.jump.onLearned = (params) => {
    if (forWorld) worldLocomotion.setJump(forWorld, params);
  };
  predictor.onWalkLearned = (params) => {
    if (forWorld) worldLocomotion.setWalk(forWorld, params);
  };
}
/** Received stick states, for locomotion analysis (`GETSTICKTRACE`). */
const stickTrace: SticksPayload[] = [];
const STICK_TRACE_MAX = 30_000;
/** Older stick state than this (ms) counts as unknown. */
const STICKS_STALE_MS = 300;
let lastHeadYawRate = 0;

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
        turnGain: predictor.turnGain(),
        sticks: latestSticks
          ? { ...latestSticks, ageMs: performance.timeOrigin + performance.now() - latestSticks.t }
          : null,
        vrcSticks,
        vrcJump,
        airborne: performance.timeOrigin + performance.now() < airborneUntil,
        worldId,
        jumpModel: { ...predictor.jump.params, active: predictor.jump.active },
        walkModel: { ...predictor.walk },
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
    /**
     * Controller sticks from webxr (`pushSticksToVrcOrigin`), ~every 15 ms while they change and
     * every 100 ms otherwise. A hand PetPlay UI holds keeps its last value in VRChat (`vrcSticks`).
     */
    STICKS: (payload: SticksPayload) => {
      latestSticks = payload;
      if (!payload.blocked.left) vrcSticks.left = payload.left;
      if (!payload.blocked.right) {
        vrcSticks.right = payload.right;
        vrcJump = payload.jump ?? false;
      }
      stickTrace.push(payload);
      if (stickTrace.length > STICK_TRACE_MAX) stickTrace.splice(0, 5_000);
    },
    GETSTICKTRACE: (payload: { sinceMs?: number } | null) => {
      const since = payload?.sinceMs ?? 0;
      return stickTrace.filter((entry) => entry.t > since);
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
  const hmdPose = await withTimeout(PostMan.PostMessage({
    target: state.hmd,
    type: "GETHMDPOSITION",
    payload: null,
  }, true)) as OpenVR.TrackedDevicePose;

  if (!hmdPose?.bPoseIsValid) return false;
  const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m as Matrix34Tuple;
  // OpenVR's angular velocity is in tracking space: +Y is counter-clockwise, as yaw RH.
  const hmdYawRate = hmdPose.vAngularVelocity?.v?.[1] ?? 0;
  const v = hmdPose.vVelocity?.v ?? [0, 0, 0];
  lastHeadYawRate = hmdYawRate;

  const now = performance.timeOrigin + performance.now();
  syncWorldLocomotion(now);
  // VRChat defaults: left stick moves, right stick turns.
  const sticks = latestSticks && now - latestSticks.t < STICKS_STALE_MS ? latestSticks : null;
  const hmdYaw = Math.atan2(hmdMatrix[0][2], hmdMatrix[2][2]);
  const headWorldYaw = state.transform != null
    ? normalizeAngleRad(state.transform.yawRad - hmdYaw)
    : undefined;
  predictor.setInput(
    sticks
      ? {
        t: now,
        move: vrcSticks.left,
        turn: vrcSticks.right[0],
        headYawRate: hmdYawRate,
        jump: vrcJump,
        headWorldYaw,
      }
      : null,
  );
  const prediction = predictor.display(now);
  const worldPose = prediction.pose;
  if (
    (sticks != null && vrcJump) || Math.abs(prediction.velocity[1]) > AIRBORNE_VERTICAL_SPEED
  ) {
    airborneUntil = now + AIRBORNE_HOLD_MS;
  }
  const airborne = now < airborneUntil;
  // VRChat is moving the player: a stick, or a jump in progress.
  const stickMoving = sticks != null && (
    Math.hypot(vrcSticks.left[0], vrcSticks.left[1]) > 0.15 || Math.abs(vrcSticks.right[0]) > 0.15 ||
    airborne
  );

  const stickTurning = predictor.isStickTurning();
  const solverPose: VrcOriginWorldPose = {
    ...worldPose,
    // During stick turns, use the simulator's predicted yaw so smooth turns track immediately
    // across OSC gaps; otherwise use raw OSC yaw for exact head-lead cancellation.
    yawRad: stickTurning ? worldPose.yawRad : (predictor.latestRawYawRad() ?? worldPose.yawRad),
  };
  const raw = solver.update(
    solverPose,
    hmdMatrix,
    stickTurning,
    performance.now(),
    hmdYawRate,
    sticks != null,
  );
  hmdTrace.push([
    now,
    hmdMatrix[0][3],
    hmdMatrix[1][3],
    hmdMatrix[2][3],
    Math.atan2(hmdMatrix[0][2], hmdMatrix[2][2]),
    Math.hypot(v[0], v[1], v[2]),
  ]);
  if (hmdTrace.length > HMD_TRACE_MAX) hmdTrace.splice(0, 10_000);
  // Locomotion: the root's velocity in the room (via the raw yaw) against the HMD's, horizontally.
  // Physical motion moves both; VRChat locomotion only moves the root.
  const rootRoomVelocity = rotateYawRH(
    unityWorldPositionToRightHanded(prediction.velocity),
    raw.transform.yawRad,
  );
  const locomotionSpeed = Math.hypot(rootRoomVelocity[0] - v[0], rootRoomVelocity[2] - v[2]);
  const solved = roomLock.update(
    raw.transform,
    worldPose,
    [hmdMatrix[0][3], hmdMatrix[1][3], hmdMatrix[2][3]],
    Math.hypot(v[0], v[1], v[2]),
    performance.now(),
    locomotionSpeed,
    stickMoving,
    sticks != null,
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
      // Playspace yaw = hmdYaw + avatarYaw, so its rate is hmdYawRate + avatarYawRate (zero
      // whenever the turn stick is idle, avoiding a head-turn sawtooth between polls).
      yawRate: predictor.isStickTurning() ? prediction.yawRate + hmdYawRate : 0,
      scale: solved.transform.scale,
      // Where this transform puts the root (the floor under the HMD, or partway there while the
      // lock blends out).
      pivot: unityWorldPointToStanding(solved.transform, worldPose.position),
      rootRH: [x, y, -z],
      rootVelocityRH: [vx, vy, -vz],
    };
  }
  const nextOrigin: OpenVR.HmdMatrix34 & { motion: VrcOriginMotion | null; from: string } = {
    m: solved.matrix,
    motion,
    from: state.id,
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

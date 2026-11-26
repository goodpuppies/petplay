#!/usr/bin/env -S deno run -A
import { ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type { Vec3Tuple, VrcCameraDebugPose } from "../classes/vrcCameraDebugState.ts";
import { decodeVrcOriginPose, isVrcOriginOscAddress } from "../classes/vrcOriginCodec.ts";
import type { VrcOriginSample } from "../classes/vrcOriginTransform.ts";
import {
  type OscMessage,
  type OscQueryNode,
  VrchatOscQueryLink,
} from "../classes/oscQuery/vrchatLink.ts";

type CoordinateMap = Record<string, number>;
type CameraRaySample = {
  position: Vec3Tuple;
  direction: Vec3Tuple;
  rotationDeg: Vec3Tuple;
  receivedAt: number;
};
type CameraPositionEstimate = {
  targetWorld: Vec3Tuple;
  originRelativeToTarget: Vec3Tuple;
  targetRelativeToFirstCamera: Vec3Tuple;
  customObjectSyncTargetWorld: Vec3Tuple | null;
  customObjectSyncOriginRelativeToTarget: Vec3Tuple | null;
  targetErrorToCustomObjectSyncMeters: number | null;
  rmsError: number;
  maxError: number;
  sampleCount: number;
  baselineMeters: number;
  updatedAt: number;
};
type CameraPoseCommand = {
  position: Vec3Tuple;
  rotationDeg: Vec3Tuple;
};
type CameraOrbitConfig = {
  radiusMeters?: number;
  heightMeters?: number;
  stepDeg?: number;
  intervalMs?: number;
  centerWorld?: Vec3Tuple;
};
type CameraOrbitRuntime = {
  timerId: ReturnType<typeof setInterval> | undefined;
  centerWorld: Vec3Tuple;
  angleRad: number;
  radiusMeters: number;
  heightMeters: number;
  stepRad: number;
  intervalMs: number;
};

const USER_CAMERA_POSE = "/usercamera/Pose";
const USER_CAMERA_MODE = "/usercamera/Mode";
const USER_CAMERA_LOOK_AT_ME = "/usercamera/LookAtMe";
const USER_CAMERA_ZOOM = "/usercamera/Zoom";
const CUSTOM_OBJECT_SYNC_PREFIX = "/avatar/parameters/CustomObjectSync/";
const CUSTOM_OBJECT_SYNC_POSITION_X = `${CUSTOM_OBJECT_SYNC_PREFIX}PositionX`;
const CUSTOM_OBJECT_SYNC_POSITION_Y = `${CUSTOM_OBJECT_SYNC_PREFIX}PositionY`;
const CUSTOM_OBJECT_SYNC_POSITION_Z = `${CUSTOM_OBJECT_SYNC_PREFIX}PositionZ`;
const MAX_POSITION_SAMPLES = 96;
const MIN_POSITION_SAMPLES = 4;
const MIN_SAMPLE_DISTANCE_METERS = 0.03;
const MIN_SAMPLE_ANGLE_DEG = 0.35;
const MAX_OSC_CAMERA_POSE_STALENESS_MS = 350;
const DEFAULT_CAMERA_ORBIT_RADIUS_METERS = 1.1;
const DEFAULT_CAMERA_ORBIT_HEIGHT_METERS = 0.05;
const DEFAULT_CAMERA_ORBIT_STEP_DEG = 10;
const DEFAULT_CAMERA_ORBIT_INTERVAL_MS = 120;

const state = actorState({
  name: "vrc-origin-camera",
  webxr: null as ActorId | null,
  driver: null as VrchatOscQueryLink | null,
  latestCameraPose: null as VrcCameraDebugPose | null,
  latestZoom: null as number | null,
  positionSamples: [] as CameraRaySample[],
  positionEstimate: null as CameraPositionEstimate | null,
  visualBaselinePosition: null as Vec3Tuple | null,
  customObjectSyncCoordinates: {} as CoordinateMap,
  cameraOrbit: null as CameraOrbitRuntime | null,
  lastDebugPostAt: 0,
});

/**
 * Origin OSC parameters as they arrive: `[epochMs, packet, address, value]`. `packet` numbers the
 * UDP datagrams, so values VRChat sent together share one. For locomotion analysis
 * (`GETORIGINOSCTRACE`).
 */
const originOscTrace: [number, number, string, number][] = [];
const ORIGIN_OSC_TRACE_MAX = 60_000;

/**
 * Decoded avatar-root poses, one per OSC burst (VRChat sends every changed parameter within ~1 ms,
 * ~20 times a second while moving), stamped with the burst's first arrival (epoch ms). The origin
 * actor fits motion through these (`GETORIGINSAMPLES`).
 */
const originSamples: VrcOriginSample[] = [];
const ORIGIN_SAMPLES_MAX = 2_000;
/** Quiet time (ms) after an origin parameter before its burst counts as complete. */
const ORIGIN_BURST_SETTLE_MS = 3;
let originBurstStart: number | null = null;
let originBurstTimer: ReturnType<typeof setTimeout> | null = null;

function noteOriginParameter(arrivedAt: number): void {
  originBurstStart ??= arrivedAt;
  if (originBurstTimer != null) clearTimeout(originBurstTimer);
  originBurstTimer = setTimeout(flushOriginBurst, ORIGIN_BURST_SETTLE_MS);
}

function flushOriginBurst(): void {
  originBurstTimer = null;
  const t = originBurstStart;
  originBurstStart = null;
  if (t == null) return;
  const pose = decodeVrcOriginPose(state.customObjectSyncCoordinates);
  if (!pose) return;
  const last = originSamples.at(-1)?.pose;
  if (
    last && last.yawRad === pose.yawRad && last.position[0] === pose.position[0] &&
    last.position[1] === pose.position[1] && last.position[2] === pose.position[2]
  ) return;
  originSamples.push({ t, pose });
  if (originSamples.length > ORIGIN_SAMPLES_MAX) originSamples.splice(0, 500);
}

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    /** Wiring only; the camera estimate starts over. */
    __SNAPSHOT__: (_payload: unknown) => ({
      webxr: state.webxr,
      started: state.driver != null,
    }),
    __RESTORE__: (payload: { webxr: ActorId | null; started: boolean } | null) => {
      if (!payload) return;
      state.webxr = payload.webxr;
      if (payload.started) {
        PostMan.PostMessage({ target: state.id, type: "STARTCAMERAORIGIN", payload: null });
      }
    },
    GETORIGINSAMPLES: (payload: { sinceMs?: number } | null) => {
      const since = payload?.sinceMs ?? 0;
      let i = originSamples.length;
      while (i > 0 && originSamples[i - 1].t > since) i--;
      return originSamples.slice(i);
    },
    GETORIGINOSCTRACE: (payload: { sinceMs?: number } | null) => {
      const since = payload?.sinceMs ?? 0;
      return originOscTrace.filter((entry) => entry[0] > since);
    },
    __SHUTDOWN__: async (_payload: unknown) => {
      await stopCameraOrigin();
    },
    __HEALTH__: (_payload: unknown) => {
      const osc = state.driver?.status() ?? null;
      return {
        driverRunning: osc?.running ?? false,
        oscPort: osc?.oscPort ?? null,
        oscQueryRequests: osc?.httpRequests ?? 0,
        /** The VRChat link (classes/oscQuery/vrchatLink.ts): discovery, connection, packet flow. */
        osc,
        hasLatestCameraPose: state.latestCameraPose != null,
        hasPositionEstimate: state.positionEstimate != null,
        positionSampleCount: state.positionSamples.length,
        cameraOrbitRunning: state.cameraOrbit != null,
        assignedWebxr: state.webxr != null,
        lastDebugPostAt: state.lastDebugPostAt,
      };
    },
    ASSIGNWEBXR: (payload: ActorId) => {
      state.webxr = payload;
    },
    STARTCAMERAORIGIN: (_payload: void) => {
      if (state.driver) return;
      const driver = new VrchatOscQueryLink({
        serviceBase: "PetPlay",
        description: "PetPlay camera and origin OSCQuery receiver",
        contents: oscQueryContents(),
        onMessage: handleOscMessage,
        log: (message) => LogChannel.log("vrc-camera-origin", message),
      });
      state.driver = driver;
      driver.start().catch(async (error) => {
        await driver.stop();
        if (state.driver === driver) state.driver = null;
        LogChannel.error(
          "vrc-camera-origin",
          `VRChat OSC link failed: ${error instanceof Error ? error.message : error}`,
        );
      });
    },
    STOPCAMERAORIGIN: async (_payload: void) => {
      return await stopCameraOrigin();
    },
    /** Re-publish the OSCQuery advertisement under a fresh name so VRChat reads it again. */
    REANNOUNCECAMERAORIGIN: async (_payload: void) => {
      if (!state.driver) {
        PostMan.PostMessage({ target: state.id, type: "STARTCAMERAORIGIN", payload: null });
        return false;
      }
      return await state.driver.reannounce();
    },
    GETCAMERAPOSE: (_payload: void) => state.latestCameraPose,
    GETUSERCAMERACONTROLENDPOINT: (_payload: void) => state.driver?.controlEndpoint ?? null,
    GETCAMERAPOSITIONESTIMATE: (_payload: void) => state.positionEstimate,
    GETCAMERAPOSITIONSAMPLES: (_payload: void) => state.positionSamples,
    RESETCAMERAPOSITIONESTIMATE: (_payload: void) => {
      state.positionSamples = [];
      state.positionEstimate = null;
      postCameraDebugUpdate(null, state.latestCameraPose);
      return true;
    },
    SETUSERCAMERAMODE: (payload: number) => {
      sendCameraMode(payload);
      return true;
    },
    SETUSERCAMERALOOKATME: (payload: boolean) => {
      sendCameraLookAtMe(payload);
      return true;
    },
    SETUSERCAMERAFLYING: (payload: boolean) => {
      return state.driver?.send("/usercamera/Flying", [payload]) ?? false;
    },
    SETUSERCAMERAPOSE: (payload: CameraPoseCommand) => {
      sendCameraPose(payload.position, payload.rotationDeg);
      return true;
    },
    STARTCAMERAORBIT: (payload: CameraOrbitConfig | null) => {
      const runtime = startCameraOrbit(payload ?? {});
      return {
        running: runtime != null,
        centerWorld: runtime?.centerWorld ?? null,
        radiusMeters: runtime?.radiusMeters ?? null,
        intervalMs: runtime?.intervalMs ?? null,
      };
    },
    STOPCAMERAORBIT: (_payload: void) => {
      stopCameraOrbit();
      return true;
    },
    GETCAMERAORBITSTATE: (_payload: void) => {
      const orbit = state.cameraOrbit;
      return orbit
        ? {
          running: true,
          centerWorld: orbit.centerWorld,
          radiusMeters: orbit.radiusMeters,
          heightMeters: orbit.heightMeters,
          intervalMs: orbit.intervalMs,
          stepDeg: degreesFromRadians(orbit.stepRad),
        }
        : {
          running: false,
          centerWorld: null,
          radiusMeters: null,
          heightMeters: null,
          intervalMs: null,
          stepDeg: null,
        };
    },
    GETCUSTOMOBJECTSYNCCOORDINATE: (_payload: void) => state.customObjectSyncCoordinates,
    GETCOORDINATE: (_payload: void) => state.customObjectSyncCoordinates,
  } as const,
);

async function stopCameraOrigin(): Promise<true> {
  stopCameraOrbit();
  await state.driver?.stop();
  state.driver = null;
  return true;
}

function handleOscMessage(message: OscMessage, packet: number): void {
  if (isVrcOriginOscAddress(message.address)) {
    const value = message.args[0];
    if (typeof value === "number") {
      state.customObjectSyncCoordinates[message.address] = value;
      const arrivedAt = performance.timeOrigin + performance.now();
      originOscTrace.push([arrivedAt, packet, message.address, value]);
      if (originOscTrace.length > ORIGIN_OSC_TRACE_MAX) originOscTrace.splice(0, 10_000);
      noteOriginParameter(arrivedAt);
    }
  }

  if (message.address === USER_CAMERA_ZOOM && typeof message.args[0] === "number") {
    state.latestZoom = message.args[0];
    if (state.webxr) {
      PostMan.PostMessage({ target: state.webxr, type: "VRCCAMERADEBUGUPDATE", payload: { zoom: state.latestZoom } });
    }
    return;
  }

  if (message.address !== USER_CAMERA_POSE) return;
  if (message.args.length < 6 || !message.args.every((value) => typeof value === "number")) {
    return;
  }

  const pose: VrcCameraDebugPose = {
    position: [message.args[0], message.args[1], message.args[2]] as Vec3Tuple,
    rotationDeg: [message.args[3], message.args[4], message.args[5]] as Vec3Tuple,
    receivedAt: Date.now(),
  };
  state.latestCameraPose = pose;
  state.visualBaselinePosition ??= [...pose.position];
  updatePositionEstimate(pose);

  const now = Date.now();
  // The VRC camera view renders from these poses, so forward them at display-like rates.
  if (now - state.lastDebugPostAt < 8) {
    return;
  }
  state.lastDebugPostAt = now;

  postCameraDebugUpdate(state.positionEstimate, pose);
}

function postCameraDebugUpdate(
  estimate: CameraPositionEstimate | null,
  pose: VrcCameraDebugPose | null = null,
): void {
  if (!state.webxr) return;
  PostMan.PostMessage({
    target: state.webxr,
    type: "VRCCAMERADEBUGUPDATE",
    payload: {
      cameraPose: pose,
      originEstimate: estimate?.originRelativeToTarget ?? null,
      lookAtTargetEstimate: estimate?.targetRelativeToFirstCamera ?? null,
    },
  });
}

function updatePositionEstimate(pose: VrcCameraDebugPose): void {
  const sample: CameraRaySample = {
    position: [...pose.position],
    direction: normalize(unityForwardFromEulerDeg(pose.rotationDeg)),
    rotationDeg: [...pose.rotationDeg],
    receivedAt: pose.receivedAt,
  };

  const last = state.positionSamples.at(-1);
  if (last) {
    const moved = distance(last.position, sample.position);
    const turnedDeg = angleBetweenDeg(last.direction, sample.direction);
    if (moved < MIN_SAMPLE_DISTANCE_METERS && turnedDeg < MIN_SAMPLE_ANGLE_DEG) {
      return;
    }
  }

  state.positionSamples.push(sample);
  if (state.positionSamples.length > MAX_POSITION_SAMPLES) {
    state.positionSamples.splice(0, state.positionSamples.length - MAX_POSITION_SAMPLES);
  }

  const estimate = fitCameraLookAtTarget(state.positionSamples);
  if (estimate) {
    const customObjectSyncTargetWorld = decodeCustomObjectSyncTargetWorld();
    const targetErrorToCustomObjectSyncMeters = customObjectSyncTargetWorld
      ? distance(estimate.targetWorld, customObjectSyncTargetWorld)
      : null;
    state.positionEstimate = {
      ...estimate,
      customObjectSyncTargetWorld,
      customObjectSyncOriginRelativeToTarget: customObjectSyncTargetWorld
        ? [
          -customObjectSyncTargetWorld[0],
          -customObjectSyncTargetWorld[1],
          -customObjectSyncTargetWorld[2],
        ]
        : null,
      targetErrorToCustomObjectSyncMeters,
    };
  }
}

function decodeCustomObjectSyncTargetWorld(): Vec3Tuple | null {
  const pose = decodeVrcOriginPose(state.customObjectSyncCoordinates);
  return pose ? [...pose.position] : null;
}

function fitCameraLookAtTarget(samples: CameraRaySample[]): CameraPositionEstimate | null {
  if (samples.length < MIN_POSITION_SAMPLES) return null;

  const firstPosition = samples[0].position;
  const visualBaselinePosition = state.visualBaselinePosition ?? firstPosition;
  let baselineMeters = 0;
  for (const sample of samples) {
    baselineMeters = Math.max(baselineMeters, distance(firstPosition, sample.position));
  }
  if (baselineMeters < MIN_SAMPLE_DISTANCE_METERS * 2) return null;

  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];

  for (const sample of samples) {
    const d = sample.direction;
    const projector = [
      [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2]],
      [-d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2]],
      [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]],
    ];

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        a[row][col] += projector[row][col];
      }
      b[row] += dot(projector[row] as Vec3Tuple, sample.position);
    }
  }

  const targetWorld = solve3x3(a, b);
  if (!targetWorld) return null;

  let errorSquared = 0;
  let maxError = 0;
  for (const sample of samples) {
    const error = pointLineDistance(targetWorld, sample.position, sample.direction);
    errorSquared += error * error;
    maxError = Math.max(maxError, error);
  }

  return {
    targetWorld,
    originRelativeToTarget: [-targetWorld[0], -targetWorld[1], -targetWorld[2]],
    targetRelativeToFirstCamera: [
      targetWorld[0] - visualBaselinePosition[0],
      targetWorld[1] - visualBaselinePosition[1],
      targetWorld[2] - visualBaselinePosition[2],
    ],
    customObjectSyncTargetWorld: null,
    customObjectSyncOriginRelativeToTarget: null,
    targetErrorToCustomObjectSyncMeters: null,
    rmsError: Math.sqrt(errorSquared / samples.length),
    maxError,
    sampleCount: samples.length,
    baselineMeters,
    updatedAt: Date.now(),
  };
}

function unityForwardFromEulerDeg(rotationDeg: Vec3Tuple): Vec3Tuple {
  const pitch = degreesToRadians(rotationDeg[0]);
  const yaw = degreesToRadians(rotationDeg[1]);
  return [
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
}

function solve3x3(matrix: number[][], vector: number[]): Vec3Tuple | null {
  const m = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < 3; pivot++) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row++) {
      if (Math.abs(m[row][pivot]) > Math.abs(m[bestRow][pivot])) {
        bestRow = row;
      }
    }
    if (Math.abs(m[bestRow][pivot]) < 1e-6) return null;
    [m[pivot], m[bestRow]] = [m[bestRow], m[pivot]];

    const pivotValue = m[pivot][pivot];
    for (let col = pivot; col < 4; col++) {
      m[pivot][col] /= pivotValue;
    }
    for (let row = 0; row < 3; row++) {
      if (row === pivot) continue;
      const scale = m[row][pivot];
      for (let col = pivot; col < 4; col++) {
        m[row][col] -= scale * m[pivot][col];
      }
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

function pointLineDistance(
  point: Vec3Tuple,
  linePoint: Vec3Tuple,
  lineDirection: Vec3Tuple,
): number {
  const delta = subtract(point, linePoint);
  const projectionLength = dot(delta, lineDirection);
  const closest = add(linePoint, scale(lineDirection, projectionLength));
  return distance(point, closest);
}

function normalize(vector: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function angleBetweenDeg(a: Vec3Tuple, b: Vec3Tuple): number {
  const value = Math.max(-1, Math.min(1, dot(a, b)));
  return degreesFromRadians(Math.acos(value));
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3Tuple, value: number): Vec3Tuple {
  return [a[0] * value, a[1] * value, a[2] * value];
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function degreesFromRadians(value: number): number {
  return value * 180 / Math.PI;
}

/** What PetPlay asks VRChat for; the link adds `/avatar/change` and the root node. */
function oscQueryContents(): Record<string, OscQueryNode> {
  return {
    "avatar": {
      FULL_PATH: "/avatar",
      CONTENTS: {
        "parameters": {
          FULL_PATH: "/avatar/parameters",
          ACCESS: 2,
          DESCRIPTION: "Avatar parameters (PetPlay/Origin and CustomObjectSync)",
        },
      },
    },
    "usercamera": {
      FULL_PATH: "/usercamera",
      ACCESS: 0,
      CONTENTS: {
        "Mode": {
          FULL_PATH: USER_CAMERA_MODE,
          ACCESS: 3,
          TYPE: "i",
        },
        "Pose": {
          FULL_PATH: USER_CAMERA_POSE,
          ACCESS: 3,
          TYPE: "ffffff",
        },
        "Zoom": {
          FULL_PATH: USER_CAMERA_ZOOM,
          ACCESS: 3,
          TYPE: "f",
        },
      },
    },
  };
}

function sendCameraMode(mode: number): void {
  state.driver?.send(USER_CAMERA_MODE, [{ type: "i", value: mode }]);
}

function sendCameraLookAtMe(enabled: boolean): void {
  state.driver?.send(USER_CAMERA_LOOK_AT_ME, [enabled]);
}

function sendCameraPose(position: Vec3Tuple, rotationDeg: Vec3Tuple): void {
  state.driver?.send(USER_CAMERA_POSE, [
    { type: "f", value: position[0] },
    { type: "f", value: position[1] },
    { type: "f", value: position[2] },
    { type: "f", value: rotationDeg[0] },
    { type: "f", value: rotationDeg[1] },
    { type: "f", value: rotationDeg[2] },
  ]);
}

function startCameraOrbit(config: CameraOrbitConfig): CameraOrbitRuntime | null {
  if (!state.driver || !state.latestCameraPose) {
    return null;
  }
  stopCameraOrbit();

  const pose = state.latestCameraPose;
  const fallbackCenter = add(
    pose.position,
    scale(unityForwardFromEulerDeg(pose.rotationDeg), DEFAULT_CAMERA_ORBIT_RADIUS_METERS),
  );
  const centerWorld = config.centerWorld ?? state.positionEstimate?.targetWorld ?? fallbackCenter;
  const radiusMeters = Math.max(0.25, config.radiusMeters ?? DEFAULT_CAMERA_ORBIT_RADIUS_METERS);
  const heightMeters = config.heightMeters ?? DEFAULT_CAMERA_ORBIT_HEIGHT_METERS;
  const intervalMs = Math.max(40, Math.round(config.intervalMs ?? DEFAULT_CAMERA_ORBIT_INTERVAL_MS));
  const stepRad = degreesToRadians(config.stepDeg ?? DEFAULT_CAMERA_ORBIT_STEP_DEG);
  const initialAngle = Math.atan2(pose.position[2] - centerWorld[2], pose.position[0] - centerWorld[0]);

  sendCameraMode(6);
  sendCameraLookAtMe(true);

  const runtime: CameraOrbitRuntime = {
    timerId: undefined,
    centerWorld: [...centerWorld],
    angleRad: initialAngle,
    radiusMeters,
    heightMeters,
    stepRad,
    intervalMs,
  };

  runtime.timerId = setInterval(() => {
    const latestPose = state.latestCameraPose;
    if (!latestPose || !state.driver) return;
    runtime.angleRad += runtime.stepRad;
    const nextPosition: Vec3Tuple = [
      runtime.centerWorld[0] + Math.cos(runtime.angleRad) * runtime.radiusMeters,
      runtime.centerWorld[1] + runtime.heightMeters,
      runtime.centerWorld[2] + Math.sin(runtime.angleRad) * runtime.radiusMeters,
    ];
    const nextRotationDeg = lookAtRotationDeg(nextPosition, runtime.centerWorld);
    sendCameraPose(nextPosition, nextRotationDeg);

    const now = Date.now();
    const lastReceivedAt = state.latestCameraPose?.receivedAt ?? 0;
    if (now - lastReceivedAt > MAX_OSC_CAMERA_POSE_STALENESS_MS) {
      const syntheticPose: VrcCameraDebugPose = {
        position: [...nextPosition],
        rotationDeg: [...nextRotationDeg],
        receivedAt: now,
      };
      state.latestCameraPose = syntheticPose;
      state.visualBaselinePosition ??= [...syntheticPose.position];
      updatePositionEstimate(syntheticPose);
      postCameraDebugUpdate(state.positionEstimate, syntheticPose);
    }
  }, intervalMs);

  state.cameraOrbit = runtime;
  return runtime;
}

function stopCameraOrbit(): void {
  if (!state.cameraOrbit) {
    return;
  }
  clearInterval(state.cameraOrbit.timerId);
  state.cameraOrbit = null;
}

function lookAtRotationDeg(from: Vec3Tuple, to: Vec3Tuple): Vec3Tuple {
  const delta = subtract(to, from);
  const horizontal = Math.hypot(delta[0], delta[2]);
  const pitchDeg = degreesFromRadians(Math.atan2(delta[1], Math.max(horizontal, 1e-6)));
  const yawDeg = degreesFromRadians(Math.atan2(delta[0], delta[2]));
  return [pitchDeg, yawDeg, 0];
}

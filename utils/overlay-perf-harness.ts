/**
 * In-isolate half of the overlay performance workflow (`utils/overlay-perf.ts`).
 *
 * The agent REPL serves `POST /eval` inside the `webxr` actor, where the r3f scene, the IWER/WebXR
 * host and the raylib overlay pump live. `EVALJS` runs with `state` (the actor state) and `host`
 * (the `WebXRHost`) in scope and can `await import()` repo modules by absolute URL, so this module
 * is loaded at runtime *inside that worker* and receives both objects.
 *
 * Kept here (everything that must run in the isolate):
 *   - synthetic controller input for runs without a headset;
 *   - scripted interaction scenarios (hover, trigger, squeeze-grab drag, edge sweep, joystick);
 *   - frame-metric sampling;
 *   - in-worker CPU profile capture.
 *
 * Process launch, REPL transport, report formatting and profile analysis live in
 * `utils/overlay-perf.ts`. The input helpers (`installSyntheticInput`, `aimAt`,
 * `quaternionLookingAt`) are exported so ad-hoc sessions can drive the overlay straight from
 * `POST /eval` without going through the scenario runner.
 */

import { captureDenoCpuProfile } from "../classes/denoCpuProfile.ts";
import {
  getWindowLayerVisible,
  setWindowLayerVisible,
} from "../classes/environment/windowLayerMode.ts";
import { getSpatialLayoutPath } from "../classes/environment/spatialLayoutPersistence.ts";

/** Node in the r3f scene graph, as far as this harness needs to see it. */
export type SceneNode = {
  userData?: Record<string, unknown>;
  matrixWorld: { elements: ArrayLike<number> };
  updateWorldMatrix: (updateParents: boolean, updateChildren: boolean) => void;
};

type Scene = {
  traverse: (callback: (node: SceneNode) => void) => void;
};

/** Subset of `IntervalMetric` (see `classes/intervalMetric.ts`). */
type IntervalMetricSample = { avgMs: number; maxMs: number; count: number };

type IntervalMetricLike = {
  /** `null` when no frame was recorded since the previous flush (`classes/intervalMetric.ts`). */
  flush: () => IntervalMetricSample | null;
};

/** Subset of the `webxr` actor state this harness reports on. */
export type WebxrActorState = {
  /** Gates the `[PERF]` / `[FPS]` log lines; the harness silences them so its own flushes are exact. */
  frameLogsEnabled: boolean;
  /** Raylib overlay frame time; only accumulates once an overlay is actually presented. */
  frameMetric: IntervalMetricLike;
  overlayFpsCounter: { getFps: () => number };
  uploadedFrames: number;
};

/** Per-hand OpenVR-shaped pose, as the app's own input source expects it. */
type EmulationPose = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

/**
 * `DirectOpenVrInputSource` surface used for injection.
 *
 * `updateActionState()` formats trigger/grab into *copied scalars* on the per-hand views and only
 * runs when an IVRInput session exists, so without a headset (`--novr`) the views must be written
 * directly — writing the shared `Float32Array`s is not enough.
 */
type OpenVrInputSource = {
  inputReady?: boolean;
  vrInput?: unknown;
  update: (
    hmd: EmulationPose | null,
    left: EmulationPose | null,
    right: EmulationPose | null,
  ) => void;
  leftBuffers: { joystick: Float32Array };
  rightBuffers: { joystick: Float32Array };
  leftView: { trigger: number; grab: number };
  rightView: { trigger: number; grab: number };
};

export type WebXrHostLike = {
  frameCount: number;
  running: boolean;
  rootStore: { getState: () => { scene: Scene } };
  xrR3fAdvanceMetric: IntervalMetricLike;
  xrSessionRafWallIntervalMetric: IntervalMetricLike;
  directOpenVrInputSource: OpenVrInputSource;
  updateEmulatedControllersFromOpenVr: () => void;
};

export type HandState = {
  active: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  trigger: boolean;
  squeeze: boolean;
  /** Joystick Y, -1..1 (drives the overlay scroll / push-pull chords). */
  joystickY: number;
};

export type SynthInput = {
  left: HandState;
  right: HandState;
  /** Restores the app's own emulated-controller bridge. */
  restore: () => void;
};

export type ScenarioName = "idle" | "hover" | "trigger" | "drag" | "sweep" | "scroll";

/** A measured phase: a synthetic scenario, or `observe` for a session driven by a person. */
export type PhaseName = ScenarioName | "observe";

export type PhaseSample = {
  second: number;
  frames: number;
  fps: number;
  /** `null` when the metric had no frames in this window (e.g. right after a host restart). */
  r3fAvgMs: number | null;
  r3fMaxMs: number | null;
  rafAvgMs: number | null;
  overlayFrames: number | null;
  overlayFps: number | null;
};

export type PhaseResult = {
  phase: PhaseName;
  seconds: number;
  frames: number;
  fps: number;
  r3fAvgMs: number | null;
  /** Worst single-frame r3f cost seen in any sampled second. */
  r3fMaxMs: number | null;
  overlayFrames: number | null;
  overlayFps: number | null;
  samples: PhaseSample[];
};

export type HarnessReport = {
  installMode: "synthetic" | "none";
  spatialLayerWasVisible: boolean;
  target: { id: string; position: [number, number, number] } | null;
  phases: PhaseResult[];
  profile: { path: string; durationMs: number } | null;
  warnings: string[];
};

export type RunOptions = {
  /** Scenarios to run, in order. `[]` measures the live session without touching input. */
  scenarios: ScenarioName[];
  secondsPerScenario: number;
  /** Spatial node to aim at, matched by `userData.spatialElementId`; falls back to any display. */
  targetId: string;
  /** In-worker CPU profile capture, overlapping the scenarios. */
  profile?: { path: string; durationMs: number };
  hand?: "left" | "right";
};

/** Scenario cadence: the hand moves every tick while metrics are sampled once per second. */
const DRIVE_INTERVAL_MS = 16;
const DRIVE_STEP_SECONDS = DRIVE_INTERVAL_MS / 1000;

const handDefaults = (): HandState => ({
  active: true,
  position: [0, 1.1, 0],
  quaternion: [0, 0, 0, 1],
  trigger: false,
  squeeze: false,
  joystickY: 0,
});

function poseOf(hand: HandState): EmulationPose | null {
  return hand.active ? { position: hand.position, quaternion: hand.quaternion } : null;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function readLayoutFile(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Drives the app's own controller bridge instead of replacing it: poses/buttons are written into
 * `DirectOpenVrInputSource` immediately before `updateEmulatedControllersFromOpenVr` reads them, so
 * the production path (`updateControllerState` -> IWER buttons/poses -> XRSpace -> pmndrs pointers)
 * runs unmodified.
 *
 * Refuses to install while a real IVRInput session is live, so an attached headset session can
 * never be hijacked by a perf run.
 */
export function installSyntheticInput(host: WebXrHostLike): SynthInput {
  const source = host.directOpenVrInputSource;
  if (source.inputReady === true || source.vrInput != null) {
    throw new Error(
      "overlay-perf: an IVRInput session is active (headset run); refusing to synthesize controller " +
        "input — measure it with scenarios disabled, or run the scenarios against a launched headless build",
    );
  }

  const input: SynthInput = { left: handDefaults(), right: handDefaults(), restore: () => {} };
  const original = host.updateEmulatedControllersFromOpenVr.bind(host);
  input.restore = () => {
    host.updateEmulatedControllersFromOpenVr = original;
  };

  host.updateEmulatedControllersFromOpenVr = function () {
    source.update(null, poseOf(input.left), poseOf(input.right));
    source.leftView.grab = input.left.squeeze ? 1 : 0;
    source.leftView.trigger = input.left.trigger ? 1 : 0;
    source.rightView.grab = input.right.squeeze ? 1 : 0;
    source.rightView.trigger = input.right.trigger ? 1 : 0;
    source.leftBuffers.joystick[1] = input.left.joystickY;
    source.rightBuffers.joystick[1] = input.right.joystickY;
    original();
  };

  return input;
}

/** Quaternion aiming the OpenVR `-Z` forward axis from `origin` at `target`. */
export function quaternionLookingAt(
  origin: readonly [number, number, number],
  target: readonly [number, number, number],
): [number, number, number, number] {
  const forward = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const length = Math.hypot(forward[0]!, forward[1]!, forward[2]!) || 1;
  const fx = forward[0]! / length;
  const fy = forward[1]! / length;
  const fz = forward[2]! / length;
  const horizontal = Math.hypot(fz, fx) || 1;
  // Basis columns are (right, up, -forward); up follows from right x forward.
  const rx = fz / horizontal;
  const rz = -fx / horizontal;
  const ux = -fy * rz;
  const uy = fx * rz - fz * rx;
  const uz = fy * rx;
  const m = [
    [rx, ux, -fx],
    [0, uy, -fy],
    [rz, uz, -fz],
  ];
  const trace = m[0]![0]! + m[1]![1]! + m[2]![2]!;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [
      (m[2]![1]! - m[1]![2]!) / s,
      (m[0]![2]! - m[2]![0]!) / s,
      (m[1]![0]! - m[0]![1]!) / s,
      0.25 * s,
    ];
  }
  if (m[0]![0]! > m[1]![1]! && m[0]![0]! > m[2]![2]!) {
    const s = Math.sqrt(1 + m[0]![0]! - m[1]![1]! - m[2]![2]!) * 2;
    return [
      0.25 * s,
      (m[0]![1]! + m[1]![0]!) / s,
      (m[0]![2]! + m[2]![0]!) / s,
      (m[2]![1]! - m[1]![2]!) / s,
    ];
  }
  if (m[1]![1]! > m[2]![2]!) {
    const s = Math.sqrt(1 + m[1]![1]! - m[0]![0]! - m[2]![2]!) * 2;
    return [
      (m[0]![1]! + m[1]![0]!) / s,
      0.25 * s,
      (m[1]![2]! + m[2]![1]!) / s,
      (m[0]![2]! - m[2]![0]!) / s,
    ];
  }
  const s = Math.sqrt(1 + m[2]![2]! - m[0]![0]! - m[1]![1]!) * 2;
  return [
    (m[0]![2]! + m[2]![0]!) / s,
    (m[1]![2]! + m[2]![1]!) / s,
    0.25 * s,
    (m[1]![0]! - m[0]![1]!) / s,
  ];
}

/** Places `hand` at `origin`, aimed at `target`. */
export function aimAt(
  input: SynthInput,
  hand: "left" | "right",
  origin: readonly [number, number, number],
  target: readonly [number, number, number],
): HandState {
  const state = input[hand];
  state.position = [origin[0], origin[1], origin[2]];
  state.quaternion = quaternionLookingAt(origin, target);
  return state;
}

/**
 * World-space centre of the spatial display node with `userData.spatialElementId === id`.
 * A loaded layout renames displays (`display-14`), so any display node is the fallback.
 */
export function findSpatialNode(
  scene: Scene,
  id: string,
): [number, number, number] | null {
  const found: { match: SceneNode | null; anyDisplay: SceneNode | null } = {
    match: null,
    anyDisplay: null,
  };
  scene.traverse((node) => {
    const userData = node.userData;
    if (found.match == null && userData?.spatialElementId === id) found.match = node;
    if (found.anyDisplay == null && userData?.spatialKind === "display") found.anyDisplay = node;
  });
  const node = found.match ?? found.anyDisplay;
  if (node == null) return null;
  node.updateWorldMatrix(true, false);
  const elements = node.matrixWorld.elements;
  return [elements[12]!, elements[13]!, elements[14]!];
}

/** Hand pose for one scenario, as a function of the elapsed phase in seconds. */
function poseFor(
  scenario: PhaseName,
  phase: number,
  centre: readonly [number, number, number],
): { origin: [number, number, number]; target: [number, number, number] } {
  const origin: [number, number, number] = [centre[0], centre[1], centre[2] - 0.7];
  switch (scenario) {
    case "idle": {
      // Out of reach of every surface: the floor for the scenario set.
      const away: [number, number, number] = [centre[0] + 1.5, centre[1] + 1.5, centre[2] - 0.7];
      return { origin: away, target: [away[0], away[1], away[2] + 1] };
    }
    case "sweep": {
      // Cross the display edge repeatedly: hover enter/leave plus selection churn.
      const offset = -0.7 + 0.9 * Math.sin(phase) * Math.sin(phase);
      return {
        origin: [centre[0] + offset, centre[1], origin[2]],
        target: [centre[0] + offset, centre[1], centre[2]],
      };
    }
    case "drag":
      return {
        origin: [
          origin[0] + 0.25 * Math.sin(phase),
          origin[1] + 0.1 * Math.cos(phase),
          origin[2],
        ],
        target: [centre[0], centre[1], centre[2]],
      };
    default:
      return { origin, target: [centre[0], centre[1], centre[2]] };
  }
}

function buttonsFor(
  scenario: PhaseName,
  phase: number,
): { trigger: boolean; squeeze: boolean; joystickY: number } {
  switch (scenario) {
    case "trigger":
      return { trigger: Math.floor(phase / 0.25) % 2 === 0, squeeze: false, joystickY: 0 };
    case "drag":
      return { trigger: false, squeeze: true, joystickY: 0 };
    case "scroll":
      return {
        trigger: false,
        squeeze: false,
        joystickY: Math.floor(phase / 0.5) % 2 === 0 ? 0.9 : -0.9,
      };
    default:
      return { trigger: false, squeeze: false, joystickY: 0 };
  }
}

function summarize(phase: PhaseName, samples: PhaseSample[]): PhaseResult {
  const frames = samples.reduce((total, sample) => total + sample.frames, 0);
  const overlayFrames = samples.reduce((total, sample) => total + (sample.overlayFrames ?? 0), 0);
  // Metric windows without samples (a host restart mid-phase) carry no frame cost to average.
  const measured = samples.filter((sample) => sample.r3fAvgMs != null);
  return {
    phase,
    seconds: samples.length,
    frames,
    fps: samples.length > 0 ? frames / samples.length : 0,
    r3fAvgMs: measured.length > 0
      ? measured.reduce((total, sample) => total + sample.r3fAvgMs!, 0) / measured.length
      : null,
    r3fMaxMs: measured.length > 0
      ? measured.reduce((worst, sample) => Math.max(worst, sample.r3fMaxMs!), 0)
      : null,
    overlayFrames: overlayFrames > 0 ? overlayFrames : null,
    overlayFps: samples.find((sample) => sample.overlayFps != null)?.overlayFps ?? null,
    samples,
  };
}

/**
 * Runs one scenario for `seconds`, sampling the frame metrics once per second.
 *
 * `flush()` resets the metrics, so this takes exclusive ownership of them for the phase and the
 * `[PERF]` log lines stay silent meanwhile (`runOverlayPerfSession` restores `frameLogsEnabled`).
 */
async function runScenario(
  host: WebXrHostLike,
  state: WebxrActorState,
  scenario: PhaseName,
  seconds: number,
  centre: readonly [number, number, number],
  input: SynthInput | null,
  hand: "left" | "right",
): Promise<PhaseResult> {
  const samples: PhaseSample[] = [];
  const handState = input?.[hand] ?? null;
  let phase = 0;
  let frameBase = host.frameCount;
  let overlayBase = state.uploadedFrames;

  host.xrR3fAdvanceMetric.flush();
  host.xrSessionRafWallIntervalMetric.flush();

  const drive = () => {
    if (input == null || handState == null) return;
    phase += DRIVE_STEP_SECONDS;
    const { origin, target } = poseFor(scenario, phase, centre);
    aimAt(input, hand, origin, target);
    const buttons = buttonsFor(scenario, phase);
    handState.trigger = buttons.trigger;
    handState.squeeze = buttons.squeeze;
    handState.joystickY = buttons.joystickY;
  };
  const timer = setInterval(drive, DRIVE_INTERVAL_MS);
  try {
    for (let second = 1; second <= seconds; second++) {
      const startedAt = performance.now();
      await sleep(1000);
      const wallSeconds = (performance.now() - startedAt) / 1000;
      const r3f = host.xrR3fAdvanceMetric.flush();
      const raf = host.xrSessionRafWallIntervalMetric.flush();
      const frames = host.frameCount - frameBase;
      const overlayFrames = state.uploadedFrames - overlayBase;
      samples.push({
        second,
        frames,
        fps: frames / wallSeconds,
        r3fAvgMs: r3f?.avgMs ?? null,
        r3fMaxMs: r3f?.maxMs ?? null,
        rafAvgMs: raf != null && raf.count > 0 ? raf.avgMs : null,
        overlayFrames,
        overlayFps: overlayFrames > 0 ? state.overlayFpsCounter.getFps() : null,
      });
      frameBase = host.frameCount;
      overlayBase = state.uploadedFrames;
    }
  } finally {
    clearInterval(timer);
    if (handState != null) {
      handState.trigger = false;
      handState.squeeze = false;
      handState.joystickY = 0;
    }
  }
  return summarize(scenario, samples);
}

/**
 * Runs the requested scenarios against a live `webxr` actor and returns the raw measurements.
 *
 * `scenarios: []` measures whatever the session is doing (a headset run driven by a person) without
 * installing synthetic input.
 */
export async function runOverlayPerfSession(
  host: WebXrHostLike,
  state: WebxrActorState,
  options: RunOptions,
): Promise<HarnessReport> {
  const warnings: string[] = [];
  const hand = options.hand ?? "right";
  const spatialLayerWasVisible = getWindowLayerVisible();
  const frameLogsWereEnabled = state.frameLogsEnabled;
  state.frameLogsEnabled = false;

  // Interaction scenarios move spatial nodes and the overlay persists every graph commit, so a perf
  // run would otherwise re-arrange the workspace the user has saved. Hold the on-disk layout and put
  // it back afterwards.
  const layoutPath = getSpatialLayoutPath();
  const layoutBefore = readLayoutFile(layoutPath);

  let input: SynthInput | null = null;
  let target: HarnessReport["target"] = null;
  const phases: PhaseResult[] = [];
  let profile: HarnessReport["profile"] = null;

  try {
    if (options.scenarios.length > 0) {
      // The wrist panel force-hides the spatial layer on mount, so a fresh desktop run needs this
      // to have anything to interact with.
      setWindowLayerVisible(true);
      input = installSyntheticInput(host);
    }

    const deadline = performance.now() + 10_000;
    let found = findSpatialNode(host.rootStore.getState().scene, options.targetId);
    while (found == null && performance.now() < deadline) {
      await sleep(250);
      found = findSpatialNode(host.rootStore.getState().scene, options.targetId);
    }
    if (found == null) {
      // Only relevant for scenarios that aim at something.
      if (options.scenarios.length > 0) {
        warnings.push(
          `no spatial node "${options.targetId}" (or any display) in the scene; interaction scenarios hit nothing`,
        );
      }
    } else {
      target = { id: options.targetId, position: found };
    }

    const profilePromise = options.profile == null ? null : captureDenoCpuProfile({
      path: options.profile.path,
      delayMs: 0,
      durationMs: options.profile.durationMs,
    });

    const centre: [number, number, number] = target?.position ?? [0, -0.08, 3.65];
    // An empty scenario list measures the session as it is (a headset session driven by a person).
    const phasesToRun: PhaseName[] = options.scenarios.length > 0 ? options.scenarios : ["observe"];
    for (const scenario of phasesToRun) {
      phases.push(
        await runScenario(host, state, scenario, options.secondsPerScenario, centre, input, hand),
      );
    }

    if (profilePromise != null && options.profile != null) {
      await profilePromise;
      profile = { path: options.profile.path, durationMs: options.profile.durationMs };
    }
  } finally {
    input?.restore();
    setWindowLayerVisible(spatialLayerWasVisible);
    state.frameLogsEnabled = frameLogsWereEnabled;
    if (layoutBefore != null && readLayoutFile(layoutPath) !== layoutBefore) {
      Deno.writeTextFileSync(layoutPath, layoutBefore);
      warnings.push(`restored the saved spatial layout at ${layoutPath} after the run`);
    }
  }

  return {
    installMode: input == null ? "none" : "synthetic",
    spatialLayerWasVisible,
    target,
    phases,
    profile,
    warnings,
  };
}

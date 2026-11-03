/**
 * Places VRChat's user camera in PetPlay's tracking space.
 *
 * `/usercamera/Pose` reports the camera in VRChat **world** space (Unity, left-handed,
 * Euler degrees). PetPlay's scene lives in OpenVR **tracking** space. The two differ by a
 * yaw, a translation and — when the avatar is scaled — a uniform scale, and that mapping
 * changes whenever the player locomotes (joystick, snap turn, teleport).
 *
 * Grab-to-calibrate recovers it: while the camera is held, its world position is the
 * holding controller's tracking pose plus a fixed grip offset. For a fixed yaw the
 * relation `s·R·w + t − C·o = c` is linear in scale `s`, translation `t` and grip offset
 * `o`, so the solve is a yaw search over small least-squares fits. Only positions are
 * used: VRChat's camera smoothing and auto-level alter its reported rotation, not where
 * it is. Its rotation is mapped afterwards through the fitted yaw.
 */
export type Vec3 = [number, number, number];
/** XYZW. */
export type Quat = [number, number, number, number];

export type VrcWorldCameraPose = {
  /** Unity world position (left-handed). */
  position: Vec3;
  /** Unity Euler degrees (applied Z, then X, then Y). */
  rotationDeg: Vec3;
};

export type TrackedPose = { position: Vec3; quaternion: Quat };

export type VrcCameraCalibrationSample = {
  /** Camera position in right-handed world space (see {@link unityPoseToRightHanded}). */
  world: Vec3;
  left: TrackedPose | null;
  right: TrackedPose | null;
};

export type VrcCameraCalibration = {
  /** Right-handed world → tracking: `p_track = scale·R(yawRad)·p_world + translation`. */
  yawRad: number;
  scale: number;
  translation: Vec3;
  /** The hand that held the camera, and the camera's offset in that controller's frame. */
  hand: "left" | "right";
  gripOffset: Vec3;
  rmsErrorMeters: number;
  maxErrorMeters: number;
  samples: number;
  solvedAt: number;
  /**
   * The other hand's fit error, when it has a fit at all. Close to `rmsErrorMeters` means the
   * hands moved together and the choice of `hand` is weak.
   */
  otherHandRmsErrorMeters: number | null;
};

/** Fewer samples than this cannot separate grip offset, translation and scale reliably. */
export const MIN_CALIBRATION_SAMPLES = 12;

/** Unity left-handed (z forward) → right-handed (z back), the convention three.js and OpenVR use. */
export function unityPoseToRightHanded(pose: VrcWorldCameraPose): TrackedPose {
  const [px, py, pz] = pose.position;
  const deg = Math.PI / 180;
  // Unity applies Z, then X, then Y (extrinsic): q = qY·qX·qZ.
  const qx = axisAngle([1, 0, 0], pose.rotationDeg[0] * deg);
  const qy = axisAngle([0, 1, 0], pose.rotationDeg[1] * deg);
  const qz = axisAngle([0, 0, 1], pose.rotationDeg[2] * deg);
  const q = quatMultiply(quatMultiply(qy, qx), qz);
  // Mirroring z negates the x and y quaternion components.
  return { position: [px, py, -pz], quaternion: [-q[0], -q[1], q[2], q[3]] };
}

/** World camera pose → tracking-space camera pose under `calibration`. */
export function applyVrcCameraCalibration(
  calibration: VrcCameraCalibration,
  worldPose: TrackedPose,
): TrackedPose {
  const rotated = rotateYaw(worldPose.position, calibration.yawRad);
  const yawQuat = axisAngle([0, 1, 0], calibration.yawRad);
  return {
    position: [
      calibration.scale * rotated[0] + calibration.translation[0],
      calibration.scale * rotated[1] + calibration.translation[1],
      calibration.scale * rotated[2] + calibration.translation[2],
    ],
    quaternion: quatMultiply(yawQuat, worldPose.quaternion),
  };
}

/**
 * Collects held-camera samples. A sample is taken only while the controllers are nearly
 * still — OSC delivery lags the controller pose by tens of milliseconds, so a moving
 * hand would pair a stale camera with a fresh controller — and only once the camera has
 * moved or turned enough since the last sample, so a resting hand does not dominate.
 */
export class VrcCameraCalibrator {
  readonly samples: VrcCameraCalibrationSample[] = [];
  private previous: { at: number; left: TrackedPose | null; right: TrackedPose | null } | null =
    null;

  constructor(
    private readonly options = {
      maxSamples: 400,
      maxSpeedMetersPerSecond: 0.2,
      maxAngularDegPerSecond: 45,
      minSampleDistanceMeters: 0.02,
      minSampleAngleDeg: 4,
    },
  ) {}

  /** Returns true when the sample was kept. */
  add(
    at: number,
    world: TrackedPose,
    left: TrackedPose | null,
    right: TrackedPose | null,
    capture: { accept?: boolean; hand?: "left" | "right" } = {},
  ): boolean {
    const previous = this.previous;
    this.previous = { at, left: clonePose(left), right: clonePose(right) };
    if (previous == null || capture.accept === false) return false;
    const dt = (at - previous.at) / 1000;
    if (dt <= 0 || dt > 0.25) return false;
    if (capture.hand !== "right" && !isStill(previous.left, left, dt, this.options)) return false;
    if (capture.hand !== "left" && !isStill(previous.right, right, dt, this.options)) return false;
    const last = this.samples.at(-1);
    if (last) {
      const moved = distance(last.world, world.position);
      const turned = capture.hand
        ? turnedDeg(last[capture.hand], capture.hand === "left" ? left : right)
        : Math.max(turnedDeg(last.left, left), turnedDeg(last.right, right));
      if (moved < this.options.minSampleDistanceMeters && turned < this.options.minSampleAngleDeg) {
        return false;
      }
    }
    // Full: make room by dropping the most redundant sample, so coverage keeps growing.
    if (this.samples.length >= this.options.maxSamples) {
      this.samples.splice(mostRedundantSample(this.samples), 1);
    }
    this.samples.push({
      world: [...world.position],
      left: clonePose(left),
      right: clonePose(right),
    });
    return true;
  }

  solve(now = Date.now()): VrcCameraCalibration | null {
    return solveVrcCameraCalibration(this.samples, now);
  }
}

/** Index of the sample closest to any other (camera position plus 1 cm per 4° of controller turn). */
function mostRedundantSample(samples: readonly VrcCameraCalibrationSample[]): number {
  let worst = 0;
  let worstDistance = Infinity;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const turned = Math.max(
        turnedDeg(samples[i].left, samples[j].left),
        turnedDeg(samples[i].right, samples[j].right),
      );
      const d = distance(samples[i].world, samples[j].world) + turned * 0.0025;
      if (d < worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
  }
  return worst;
}

/** Best fit over both hands; null when neither hand has a well-conditioned fit. */
export function solveVrcCameraCalibration(
  samples: readonly VrcCameraCalibrationSample[],
  now = Date.now(),
): VrcCameraCalibration | null {
  const fits: VrcCameraCalibration[] = [];
  for (const hand of ["left", "right"] as const) {
    const handSamples = samples.flatMap((sample) => {
      const pose = sample[hand];
      return pose ? [{ world: sample.world, controller: pose }] : [];
    });
    if (handSamples.length < MIN_CALIBRATION_SAMPLES) continue;
    const solved = solveForHand(handSamples);
    if (solved == null) continue;
    const { errors, ...fit } = solved;
    fits.push({
      ...fit,
      hand,
      samples: errors.length,
      solvedAt: now,
      otherHandRmsErrorMeters: null,
    });
  }
  // The hand that holds the camera is the one whose movement explains it best.
  fits.sort((a, b) => a.rmsErrorMeters - b.rmsErrorMeters);
  if (fits.length === 0) return null;
  return { ...fits[0], otherHandRmsErrorMeters: fits[1]?.rmsErrorMeters ?? null };
}

type HandSample = { world: Vec3; controller: TrackedPose };
type HandFit = Omit<
  VrcCameraCalibration,
  "hand" | "samples" | "solvedAt" | "otherHandRmsErrorMeters"
>;

/**
 * A camera let go or grabbed mid-capture leaves samples no rigid grip explains, and a
 * plain least-squares fit absorbs them by shrinking the scale. So: fit random subsets,
 * keep the fit most samples agree with (RANSAC), refit on its inliers, then drop any
 * remaining sample far past the median error.
 */
const RANSAC_SUBSET = 8;
const RANSAC_ITERATIONS = 48;
const INLIER_METERS = 0.03;
const OUTLIER_MEDIAN_FACTOR = 3;
const OUTLIER_MAX_FRACTION = 0.25;

function solveForHand(samples: HandSample[]): (HandFit & { errors: number[] }) | null {
  let kept = ransacInliers(samples) ?? samples;
  let fit = solveForHandOnce(kept);
  const maxDropped = Math.floor(samples.length * OUTLIER_MAX_FRACTION);
  while (fit != null && samples.length - kept.length < maxDropped) {
    const errors = fit.errors;
    const sorted = [...errors].sort((a, b) => a - b);
    const limit = Math.max(INLIER_METERS, OUTLIER_MEDIAN_FACTOR * sorted[sorted.length >> 1]);
    let worst = 0;
    for (let i = 1; i < errors.length; i++) if (errors[i] > errors[worst]) worst = i;
    if (errors[worst] <= limit || kept.length - 1 < MIN_CALIBRATION_SAMPLES) break;
    const trimmed = kept.filter((_, index) => index !== worst);
    const refit = solveForHandOnce(trimmed);
    if (refit == null) break;
    kept = trimmed;
    fit = refit;
  }
  return fit;
}

/** The samples agreeing with the best subset fit; null when no subset fit is usable. */
function ransacInliers(samples: HandSample[]): HandSample[] | null {
  if (samples.length < RANSAC_SUBSET * 2) return null;
  // Deterministic, so a capture always solves the same way.
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  let best: HandSample[] | null = null;
  for (let iteration = 0; iteration < RANSAC_ITERATIONS; iteration++) {
    const picked = new Set<number>();
    while (picked.size < RANSAC_SUBSET) picked.add(Math.floor(next() * samples.length));
    const fit = solveForHandOnce([...picked].map((index) => samples[index]), true);
    if (fit == null || fit.scale <= 0) continue;
    const inliers = samples.filter((sample) => sampleError(fit, sample) <= INLIER_METERS);
    if (best == null || inliers.length > best.length) best = inliers;
  }
  return best != null && best.length >= MIN_CALIBRATION_SAMPLES ? best : null;
}

function sampleError(fit: HandFit, sample: HandSample): number {
  const rw = rotateYaw(sample.world, fit.yawRad);
  const C = quatToMatrix(sample.controller.quaternion);
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const predicted = fit.scale * rw[axis] + fit.translation[axis] -
      (C[axis][0] * fit.gripOffset[0] + C[axis][1] * fit.gripOffset[1] +
        C[axis][2] * fit.gripOffset[2]);
    squared += (predicted - sample.controller.position[axis]) ** 2;
  }
  return Math.sqrt(squared);
}

/**
 * Coarse-to-fine yaw search: the error is smooth in yaw, so a 5° grid finds the basin.
 * `quick` stops at 0.5°, enough to score a RANSAC subset.
 */
function solveForHandOnce(
  samples: HandSample[],
  quick = false,
): (HandFit & { errors: number[] }) | null {
  const controllerRotations = samples.map((sample) => quatToMatrix(sample.controller.quaternion));
  let bestYaw = 0;
  let bestFit: LinearFit | null = null;
  const consider = (yaw: number) => {
    const fit = fitAtYaw(samples, controllerRotations, yaw);
    if (fit && (bestFit == null || fit.sumSquaredError < bestFit.sumSquaredError)) {
      bestFit = fit;
      bestYaw = yaw;
    }
  };
  const deg = Math.PI / 180;
  for (let yaw = 0; yaw < 360; yaw += 5) consider(yaw * deg);
  for (const [span, step] of quick ? [[5, 0.5]] : [[5, 0.5], [0.5, 0.02]]) {
    const center = bestYaw;
    for (let offset = -span; offset <= span; offset += step) consider(center + offset * deg);
  }
  const fit = bestFit as LinearFit | null;
  if (fit == null || fit.scale <= 0) return null;
  let maxError = 0;
  for (const error of fit.errors) maxError = Math.max(maxError, error);
  return {
    yawRad: normalizeAngle(bestYaw),
    scale: fit.scale,
    translation: fit.translation,
    gripOffset: fit.gripOffset,
    rmsErrorMeters: Math.sqrt(fit.sumSquaredError / samples.length),
    maxErrorMeters: maxError,
    errors: fit.errors,
  };
}

type LinearFit = {
  scale: number;
  translation: Vec3;
  gripOffset: Vec3;
  sumSquaredError: number;
  errors: number[];
};

/**
 * For a fixed yaw, solves `s·R·w_i + t − C_i·o = c_i` for x = [s, tx, ty, tz, ox, oy, oz]
 * through the normal equations. Null when the samples do not constrain all seven, e.g. a
 * camera only translated, never turned, leaves the grip offset and translation degenerate.
 */
function fitAtYaw(samples: HandSample[], rotations: number[][][], yaw: number): LinearFit | null {
  const ata = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
  const atb = new Array<number>(7).fill(0);
  const rows: { a: number[]; b: number }[][] = [];
  for (let i = 0; i < samples.length; i++) {
    const rw = rotateYaw(samples[i].world, yaw);
    const c = samples[i].controller.position;
    const C = rotations[i];
    const sampleRows = [];
    for (let axis = 0; axis < 3; axis++) {
      const a = [rw[axis], 0, 0, 0, -C[axis][0], -C[axis][1], -C[axis][2]];
      a[1 + axis] = 1;
      sampleRows.push({ a, b: c[axis] });
      for (let j = 0; j < 7; j++) {
        atb[j] += a[j] * c[axis];
        for (let k = 0; k < 7; k++) ata[j][k] += a[j] * a[k];
      }
    }
    rows.push(sampleRows);
  }
  const x = solveLinear(ata, atb);
  if (x == null) return null;
  let sumSquaredError = 0;
  const errors: number[] = [];
  for (const sampleRows of rows) {
    let squared = 0;
    for (const { a, b } of sampleRows) {
      let predicted = 0;
      for (let j = 0; j < 7; j++) predicted += a[j] * x[j];
      squared += (predicted - b) ** 2;
    }
    sumSquaredError += squared;
    errors.push(Math.sqrt(squared));
  }
  return {
    scale: x[0],
    translation: [x[1], x[2], x[3]],
    gripOffset: [x[4], x[5], x[6]],
    sumSquaredError,
    errors,
  };
}

/** Gaussian elimination with partial pivoting; null for an ill-conditioned system. */
function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const m = matrix.map((row, index) => [...row, vector[index]]);
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(m[i][i]));
  const epsilon = Math.max(scale, 1) * 1e-9;
  for (let pivot = 0; pivot < n; pivot++) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < n; row++) {
      if (Math.abs(m[row][pivot]) > Math.abs(m[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(m[bestRow][pivot]) < epsilon) return null;
    [m[pivot], m[bestRow]] = [m[bestRow], m[pivot]];
    for (let row = 0; row < n; row++) {
      if (row === pivot) continue;
      const factor = m[row][pivot] / m[pivot][pivot];
      for (let col = pivot; col <= n; col++) m[row][col] -= factor * m[pivot][col];
    }
  }
  return m.map((row, index) => row[n] / row[index]);
}

function isStill(
  previous: TrackedPose | null,
  current: TrackedPose | null,
  dt: number,
  options: { maxSpeedMetersPerSecond: number; maxAngularDegPerSecond: number },
): boolean {
  if (previous == null || current == null) return true;
  return distance(previous.position, current.position) / dt <= options.maxSpeedMetersPerSecond &&
    quatAngleDeg(previous.quaternion, current.quaternion) / dt <= options.maxAngularDegPerSecond;
}

function turnedDeg(previous: TrackedPose | null, current: TrackedPose | null): number {
  return previous && current ? quatAngleDeg(previous.quaternion, current.quaternion) : 0;
}

function clonePose(pose: TrackedPose | null): TrackedPose | null {
  return pose ? { position: [...pose.position], quaternion: [...pose.quaternion] } : null;
}

function rotateYaw(v: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatToMatrix(q: Quat): number[][] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** What a `camera: "vrc"` view receives with each frame. */
export type VrcCameraViewPose = {
  position: Vec3;
  quaternion: Quat;
  /** VRChat's `/usercamera/Zoom`, taken as the vertical FOV; null until VRChat reports it. */
  fovYDeg: number | null;
  /** Milliseconds since VRChat last reported the camera pose. */
  ageMs: number;
};

export type VrcCameraTrackerStatus = {
  calibrating: boolean;
  calibrationRemainingMs: number;
  samples: number;
  calibration: VrcCameraCalibration | null;
  lastError: string | null;
  hasWorldPose: boolean;
  fovYDeg: number | null;
  /** Open-ended calibration (the wrist switch) is on; `liveFit` is its latest solve. */
  live: boolean;
  liveFit: VrcCameraCalibration | null;
  /** Milliseconds since VRChat last reported the camera, and since that pose last changed. */
  poseAgeMs: number | null;
  poseMovedAgeMs: number | null;
  /** A trustworthy fit is retained while the hand is away from the camera. */
  samplingPaused: boolean;
  rejectedSamples: number;
  acceptedSamples: number;
};

/** Solves a sample set; the webxr actor passes one that runs in a worker (solves take ~100 ms). */
export type VrcCameraSolver = (
  samples: VrcCameraCalibrationSample[],
) => Promise<VrcCameraCalibration | null>;

const LIVE_MAX_SAMPLES = 300;
const LIVE_SOLVE_INTERVAL_MS = 500;
/** First live fit. Below this the solve is too easily degenerate. */
const LIVE_FIRST_FIT_SAMPLES = 12;
/** The held hand must have moved this far (bounding-box diagonal) before a fit is shown. */
const LIVE_MIN_HAND_SPREAD_METERS = 0.15;
const LIVE_TRUSTED_SAMPLES = 24;
const LIVE_TRUSTED_RMS_METERS = 0.02;
/**
 * Paused this long while the camera keeps moving means the reference fit no longer describes the
 * world (VRChat changed worlds, or the playspace moved), not a hand away from the camera: start over.
 */
const LIVE_STALE_REFERENCE_MS = 3000;
/** ...and over at least this many camera poses that moved (a parked camera sends none). */
const LIVE_STALE_REFERENCE_MOVES = 30;
/**
 * Live sampling gate. A replay of a real calibration (2026-10-31: hand at a median 0.54 m/s,
 * 100 deg/s) passed 0.9 samples/s at 0.2 m/s and 45 deg/s. At 0.4 and 90, paired with the
 * controller at VRChat's receive time, it passed about 2x as many with the same scale and yaw
 * and 0.7-0.9 cm rms. Faster gates drifted in scale: VRChat smooths the camera, so its lag grows
 * with speed.
 */
const LIVE_MAX_SPEED_METERS_PER_SECOND = 0.4;
const LIVE_MAX_ANGULAR_DEG_PER_SECOND = 90;
const CONTROLLER_HISTORY_MS = 1500;

/**
 * Recent controller poses, so an OSC camera pose can be paired with the controllers at the moment
 * VRChat's packet arrived rather than when the webxr worker got to it (frames and stalls later).
 */
export class ControllerPoseHistory {
  private readonly entries: { at: number; left: TrackedPose | null; right: TrackedPose | null }[] =
    [];

  push(at: number, left: TrackedPose | null, right: TrackedPose | null): void {
    const last = this.entries.at(-1);
    if (last && at <= last.at) return;
    this.entries.push({ at, left: clonePose(left), right: clonePose(right) });
    while (this.entries.length > 2 && at - this.entries[0].at > CONTROLLER_HISTORY_MS) {
      this.entries.shift();
    }
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Both controllers interpolated at `at`, or null when the history does not cover it. */
  at(at: number): { left: TrackedPose | null; right: TrackedPose | null } | null {
    const entries = this.entries;
    if (entries.length < 2 || at < entries[0].at || at > entries.at(-1)!.at) return null;
    let hi = entries.findIndex((entry) => entry.at >= at);
    if (hi <= 0) hi = 1;
    const a = entries[hi - 1], b = entries[hi];
    // A gap this long is a stall, not motion worth interpolating across.
    if (b.at - a.at > 100) return null;
    const f = b.at === a.at ? 0 : (at - a.at) / (b.at - a.at);
    return { left: lerpPose(a.left, b.left, f), right: lerpPose(a.right, b.right, f) };
  }
}

function lerpPose(a: TrackedPose | null, b: TrackedPose | null, f: number): TrackedPose | null {
  if (a == null || b == null) return clonePose(b ?? a);
  const sign = a.quaternion.reduce((sum, v, i) => sum + v * b.quaternion[i], 0) < 0 ? -1 : 1;
  const q = a.quaternion.map((v, i) => v + (sign * b.quaternion[i] - v) * f);
  const n = Math.hypot(...q) || 1;
  return {
    position: a.position.map((v, i) => v + (b.position[i] - v) * f) as Vec3,
    quaternion: q.map((v) => v / n) as Quat,
  };
}

/**
 * Scene-side state for the VRC camera view: the latest world pose from OSC, the active
 * calibration and a running calibration capture. Owned by the `webxr` actor because it
 * holds the controller poses the capture pairs with.
 */
export class VrcCameraTracker {
  private calibrator: VrcCameraCalibrator | null = null;
  private calibrationEndsAt = 0;
  private calibration: VrcCameraCalibration | null = null;
  private worldPose: TrackedPose | null = null;
  private worldPoseAt = 0;
  private worldPoseMovedAt = 0;
  private fovYDeg: number | null = null;
  private lastError: string | null = null;
  private live = false;
  private liveFit: VrcCameraCalibration | null = null;
  private referenceFit: VrcCameraCalibration | null = null;
  private referenceWorlds: Vec3[] = [];
  private samplingPaused = false;
  private rejectedSamples = 0;
  private acceptedSamples = 0;
  private captureHand: "left" | "right" | null = null;
  private gripProbe: {
    at: number;
    world: Vec3;
    left: TrackedPose | null;
    right: TrackedPose | null;
  }[] = [];
  /** Bumped by every begin/end, so a solve finishing after the switch changed is ignored. */
  private liveGeneration = 0;
  private solving = false;
  private pausedSince: number | null = null;
  private pausedMoves = 0;
  private readonly controllerHistory = new ControllerPoseHistory();
  private sampleRevision = 0;
  private solvedRevision = -1;
  private lastSolveAt = 0;

  constructor(
    private readonly solver: VrcCameraSolver = (samples) =>
      Promise.resolve(solveVrcCameraCalibration(samples)),
    /** Called with each new live fit (for the wrist page and the ball). */
    private readonly onLiveFit: (fit: VrcCameraCalibration | null) => void = () => {},
  ) {}

  startCalibration(durationMs: number, now = Date.now()): void {
    this.endLive();
    this.calibrator = new VrcCameraCalibrator();
    this.calibrationEndsAt = now + durationMs;
    this.lastError = null;
  }

  /**
   * Open-ended calibration: collect samples and re-solve as they grow, until
   * `endLiveCalibration`. Meant to run while the user watches the accuracy and the predicted
   * camera position, so nothing has to guess when the camera was let go.
   */
  beginLiveCalibration(): void {
    this.calibrator = new VrcCameraCalibrator({
      maxSamples: LIVE_MAX_SAMPLES,
      maxSpeedMetersPerSecond: LIVE_MAX_SPEED_METERS_PER_SECOND,
      maxAngularDegPerSecond: LIVE_MAX_ANGULAR_DEG_PER_SECOND,
      minSampleDistanceMeters: 0.02,
      minSampleAngleDeg: 4,
    });
    this.calibrationEndsAt = Infinity;
    this.live = true;
    this.pausedSince = null;
    this.pausedMoves = 0;
    this.liveFit = null;
    this.referenceFit = null;
    this.referenceWorlds = [];
    this.samplingPaused = false;
    this.rejectedSamples = 0;
    this.acceptedSamples = 0;
    this.captureHand = null;
    this.gripProbe = [];
    this.liveGeneration++;
    this.sampleRevision = 0;
    this.solvedRevision = -1;
    this.lastSolveAt = -Infinity;
    this.lastError = null;
  }

  /** Keeps the latest live fit (if any) as the calibration and stops sampling. */
  endLiveCalibration(): VrcCameraCalibration | null {
    if (!this.live) return this.calibration;
    const fit = this.liveFit;
    this.endLive();
    if (fit != null) this.calibration = fit;
    else this.lastError = "no calibration yet: move and turn the held camera while calibrating";
    return this.calibration;
  }

  /** While live, the webxr actor records the controllers every frame (see `ControllerPoseHistory`). */
  recordControllers(
    controllers: { left: TrackedPose | null; right: TrackedPose | null },
    now = Date.now(),
  ): void {
    if (this.live) this.controllerHistory.push(now, controllers.left, controllers.right);
  }

  private endLive(): void {
    if (!this.live) return;
    this.controllerHistory.clear();
    this.pausedSince = null;
    this.live = false;
    this.liveFit = null;
    this.referenceFit = null;
    this.referenceWorlds = [];
    this.samplingPaused = false;
    this.captureHand = null;
    this.gripProbe = [];
    this.calibrator = null;
    this.liveGeneration++;
  }

  clearCalibration(): void {
    this.endLive();
    this.calibrator = null;
    this.calibration = null;
    this.lastError = null;
  }

  setFovYDeg(value: number): void {
    if (Number.isFinite(value) && value > 1 && value < 179) this.fovYDeg = value;
  }

  /**
   * One OSC camera pose with the controllers as they are now. Returns the finished
   * calibration result when this sample ended a capture (null calibration = it failed).
   */
  onWorldPose(
    pose: VrcWorldCameraPose,
    controllers: { left: TrackedPose | null; right: TrackedPose | null },
    now = Date.now(),
    /** When the OSC actor received the pose; pairs it with the controllers at that moment. */
    receivedAt?: number,
  ): { finished: true; calibration: VrcCameraCalibration | null } | null {
    if (this.live && receivedAt != null) {
      const then = this.controllerHistory.at(receivedAt);
      if (then) {
        controllers = then;
        now = receivedAt;
      }
    }
    const next = unityPoseToRightHanded(pose);
    if (this.worldPose == null || distance(this.worldPose.position, next.position) > 0.001) {
      this.worldPoseMovedAt = now;
    }
    this.worldPose = next;
    this.worldPoseAt = now;
    let calibrator = this.calibrator;
    if (calibrator == null) return null;
    // Once a fit is trustworthy, an unrelated hand movement must not poison its samples.
    if (this.live && this.liveFit) {
      this.detectNewGrip(controllers, now);
      calibrator = this.calibrator!;
    }
    const reference = this.live
      ? this.referenceFit ?? (this.captureHand ? this.liveFit : null)
      : null;
    const held = reference ? controllers[reference.hand] : null;
    const tolerance = reference ? Math.max(0.04, reference.rmsErrorMeters * 4) : Infinity;
    this.samplingPaused = reference != null && (held == null || sampleError(reference, {
          world: this.worldPose.position,
          controller: held,
        }) > tolerance);
    if (this.samplingPaused) {
      this.rejectedSamples++;
      this.pausedSince ??= now;
      if (this.worldPoseMovedAt === now) this.pausedMoves++;
      if (
        this.live && now - this.pausedSince > LIVE_STALE_REFERENCE_MS &&
        this.pausedMoves >= LIVE_STALE_REFERENCE_MOVES
      ) {
        this.restartLive();
        return null;
      }
    } else {
      this.pausedSince = null;
      this.pausedMoves = 0;
    }
    if (
      calibrator.add(now, this.worldPose, controllers.left, controllers.right, {
        accept: !this.samplingPaused,
        hand: reference?.hand,
      })
    ) {
      this.sampleRevision++;
      this.acceptedSamples++;
    }
    if (this.live) {
      this.maybeSolveLive(now);
      return null;
    }
    if (now < this.calibrationEndsAt) return null;
    return { finished: true, calibration: this.finishCalibration(now) };
  }

  /** One solve in flight at a time, at most every LIVE_SOLVE_INTERVAL_MS, only on new samples. */
  private maybeSolveLive(now: number): void {
    const calibrator = this.calibrator;
    if (this.solving || calibrator == null) return;
    if (calibrator.samples.length < LIVE_FIRST_FIT_SAMPLES) return;
    if (this.sampleRevision === this.solvedRevision) return;
    if (now - this.lastSolveAt < LIVE_SOLVE_INTERVAL_MS) return;
    const generation = this.liveGeneration;
    const samples = calibrator.samples.map((sample) =>
      this.captureHand
        ? { ...sample, [this.captureHand === "left" ? "right" : "left"]: null }
        : sample
    );
    this.solving = true;
    this.lastSolveAt = now;
    this.solvedRevision = this.sampleRevision;
    this.solver(samples).then((fit) => {
      if (generation !== this.liveGeneration) return;
      this.lastError = null;
      if (fit != null && this.acceptLiveFit(fit)) {
        this.liveFit = fit;
        if (
          this.referenceFit == null && fit.samples >= LIVE_TRUSTED_SAMPLES &&
          fit.rmsErrorMeters < LIVE_TRUSTED_RMS_METERS
        ) {
          this.referenceFit = fit;
          this.referenceWorlds = samples.filter((sample) => {
            const controller = sample[fit.hand];
            return controller != null &&
              sampleError(fit, { world: sample.world, controller }) < 0.03;
          }).slice(-32).map((sample) => sample.world);
        }
      }
      this.onLiveFit(this.liveFit);
    }, (error) => {
      if (generation !== this.liveGeneration) return;
      this.lastError = `live solve failed: ${error instanceof Error ? error.message : error}`;
    }).finally(() => {
      this.solving = false;
    });
  }

  /**
   * A re-grab can change the grip offset or the holding hand. Look for a near-constant
   * camera offset in either controller's frame while the CAMERA moves, rather than mistaking
   * a hand waved next to a stationary camera for a new grab. Each grab has its own samples.
   * The world mapping and best achieved error survive every segment change.
   */
  private detectNewGrip(
    controllers: { left: TrackedPose | null; right: TrackedPose | null },
    now: number,
  ): void {
    const fit = this.liveFit!;
    const world = this.worldPose!.position;
    if (this.gripProbe.length && now - this.gripProbe.at(-1)!.at < 75) return;
    this.gripProbe.push({
      at: now,
      world: [...world],
      left: clonePose(controllers.left),
      right: clonePose(controllers.right),
    });
    this.gripProbe = this.gripProbe.filter((sample) => now - sample.at <= 6000).slice(-32);
    const current = controllers[fit.hand];
    if (
      current && sampleError(fit, { world, controller: current }) <=
        Math.max(0.04, fit.rmsErrorMeters * 4)
    ) return;
    if (this.gripProbe.length < 6 || now - this.gripProbe[0].at < 200) return;
    const mapped = this.gripProbe.map((sample) =>
      applyVrcCameraCalibration(fit, {
        position: sample.world,
        quaternion: [0, 0, 0, 1],
      }).position
    );
    if (Math.max(...mapped.map((p) => distance(p, mapped[0]))) < 0.02) return;
    let best: { hand: "left" | "right"; offset: Vec3; spread: number } | null = null;
    for (const hand of ["left", "right"] as const) {
      if (this.gripProbe.some((sample) => sample[hand] == null)) continue;
      const offsets = this.gripProbe.map((sample, i): Vec3 => {
        const controller = sample[hand]!;
        const m = quatToMatrix(controller.quaternion);
        const delta = mapped[i].map((v, axis) => v - controller.position[axis]);
        // Inverse rotation = transpose for a unit quaternion.
        return [0, 1, 2].map((axis) =>
          m[0][axis] * delta[0] + m[1][axis] * delta[1] + m[2][axis] * delta[2]
        ) as Vec3;
      });
      const offset = [0, 1, 2].map((axis) =>
        offsets.reduce((sum, p) => sum + p[axis], 0) / offsets.length
      ) as Vec3;
      if (Math.hypot(...offset) > 0.5) continue;
      const spread = Math.sqrt(
        offsets.reduce((sum, p) => sum + distance(p, offset) ** 2, 0) / offsets.length,
      );
      const tolerance = Math.max(0.015, Math.min(0.035, fit.rmsErrorMeters * 3));
      if (spread > tolerance) continue;
      if (!best || spread < best.spread) best = { hand, offset, spread };
    }
    if (!best) return;
    // Keep the fit and its error; only the new grab's hand/offset and sample pool change.
    this.liveFit = {
      ...fit,
      hand: best.hand,
      gripOffset: best.offset,
      otherHandRmsErrorMeters: null,
    };
    if (this.referenceFit) {
      this.referenceFit = {
        ...this.referenceFit,
        hand: best.hand,
        gripOffset: best.offset,
      };
    }
    this.captureHand = best.hand;
    this.calibrator = new VrcCameraCalibrator({
      maxSamples: LIVE_MAX_SAMPLES,
      maxSpeedMetersPerSecond: LIVE_MAX_SPEED_METERS_PER_SECOND,
      maxAngularDegPerSecond: LIVE_MAX_ANGULAR_DEG_PER_SECOND,
      minSampleDistanceMeters: 0.02,
      minSampleAngleDeg: 4,
    });
    this.gripProbe = [];
    this.sampleRevision = 0;
    this.solvedRevision = -1;
    this.lastSolveAt = -Infinity;
    this.liveGeneration++;
  }

  /**
   * Drops a reference fit that stopped describing the world (see `LIVE_STALE_REFERENCE_MS`) and
   * collects from scratch, staying live. Counters keep running so the page shows the history.
   */
  private restartLive(): void {
    const { rejectedSamples, acceptedSamples } = this;
    this.beginLiveCalibration();
    this.rejectedSamples = rejectedSamples;
    this.acceptedSamples = acceptedSamples;
    this.lastError = "camera no longer matched the fit (world changed?); calibrating again";
  }

  /** Do not trade an aligned camera for a low-error fit of unrelated/released-hand motion. */
  private acceptLiveFit(fit: VrcCameraCalibration): boolean {
    if (fit.samples < LIVE_FIRST_FIT_SAMPLES) return false;
    // Too little hand movement fits anything, often with the wrong (still) hand.
    const held = (this.calibrator?.samples ?? []).map((sample) => sample[fit.hand]?.position)
      .filter((position): position is Vec3 => position != null);
    if (held.length === 0) return false;
    const extent = [0, 1, 2].map((axis) =>
      Math.max(...held.map((p) => p[axis])) - Math.min(...held.map((p) => p[axis]))
    );
    if (Math.hypot(...extent) < LIVE_MIN_HAND_SPREAD_METERS) return false;
    const previous = this.liveFit;
    // A fit from fewer than LIVE_TRUSTED_SAMPLES is provisional: it shows progress early, but its
    // error is deceptively low, so the first trusted-size fit replaces it whatever its error. It
    // never replaces a trusted fit (a new grip collects from few samples again), so between
    // trusted fits the best error never regresses.
    if (
      previous != null && previous.samples >= LIVE_TRUSTED_SAMPLES &&
      fit.samples < LIVE_TRUSTED_SAMPLES
    ) return false;
    const replacesProvisional = previous != null && previous.samples < LIVE_TRUSTED_SAMPLES &&
      fit.samples >= LIVE_TRUSTED_SAMPLES;
    if (previous && !replacesProvisional && fit.rmsErrorMeters > previous.rmsErrorMeters) {
      return false;
    }
    const reference = this.referenceFit;
    if (!reference) return true;
    if (fit.hand !== (this.captureHand ?? reference.hand)) return false;
    const tolerance = Math.max(0.02, reference.rmsErrorMeters * 3);
    return this.referenceWorlds.every((world) => {
      const pose: TrackedPose = { position: world, quaternion: [0, 0, 0, 1] };
      return distance(
        applyVrcCameraCalibration(fit, pose).position,
        applyVrcCameraCalibration(reference, pose).position,
      ) <= tolerance;
    });
  }

  /** Solves with the samples so far; also called by an early stop. */
  finishCalibration(now = Date.now()): VrcCameraCalibration | null {
    if (this.live) return this.endLiveCalibration();
    const calibrator = this.calibrator;
    if (calibrator == null) return this.calibration;
    this.calibrator = null;
    const result = calibrator.solve(now);
    if (result == null) {
      this.lastError = `calibration failed with ${calibrator.samples.length} samples: ` +
        "hold the VRChat camera and slowly turn it through several angles";
      return null;
    }
    this.calibration = result;
    return result;
  }

  /**
   * The camera's tracking-space pose under the calibration in use: the live fit while
   * calibrating (so the recording layer shows the alignment as it improves), else the kept one.
   */
  currentViewPose(now = Date.now()): VrcCameraViewPose | null {
    const calibration = (this.live ? this.liveFit : null) ?? this.calibration;
    if (calibration == null || this.worldPose == null) return null;
    const pose = applyVrcCameraCalibration(calibration, this.worldPose);
    return { ...pose, fovYDeg: this.fovYDeg, ageMs: now - this.worldPoseAt };
  }

  status(now = Date.now()): VrcCameraTrackerStatus {
    return {
      calibrating: this.calibrator != null,
      calibrationRemainingMs: this.calibrator && !this.live
        ? Math.max(0, this.calibrationEndsAt - now)
        : 0,
      samples: this.calibrator?.samples.length ?? 0,
      calibration: this.calibration,
      lastError: this.lastError,
      hasWorldPose: this.worldPose != null,
      fovYDeg: this.fovYDeg,
      live: this.live,
      liveFit: this.liveFit,
      poseAgeMs: this.worldPose ? now - this.worldPoseAt : null,
      poseMovedAgeMs: this.worldPose ? now - this.worldPoseMovedAt : null,
      samplingPaused: this.samplingPaused,
      rejectedSamples: this.rejectedSamples,
      acceptedSamples: this.acceptedSamples,
    };
  }
}

/**
 * Pure VRChat world <-> OpenVR Standing coordinate transform math and solver.
 *
 * Conventions (matching `classes/vrcCameraCalibration.ts`):
 * - VRChat world coordinates arrive in Unity's left-handed frame (+X right, +Y up, +Z forward,
 *   +yaw clockwise when viewed from above).
 * - Right-handed world coordinates (`worldRH`) mirror Z: `[x, y, -z]`.
 * - OpenVR Standing space is right-handed (+X right, +Y up, -Z forward, +yaw counter-clockwise).
 * - The rigid/similarity transform from `worldRH` to `Standing` is:
 *     `p_standing = scale * R_y(yawRad) * p_worldRH + translation`
 *   where `R_y(θ)` is standard right-handed rotation about +Y:
 *     `[ cos θ,  0, sin θ ]`
 *     `[   0,    1,   0   ]`
 *     `[-sin θ,  0, cos θ ]`
 */

import type { Vec3, VrcOriginWorldPose } from "./vrcOriginCodec.ts";

export type Matrix34Tuple = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

export interface VrcWorldToStandingTransform {
  /** Right-handed yaw from `worldRH` into OpenVR `Standing`, in radians. */
  yawRad: number;
  /** Uniform scale from `worldRH` into `Standing` (1.0 at default avatar scale). */
  scale: number;
  /** Position of the VRChat world origin `(0, 0, 0)` in OpenVR `Standing` metres. */
  translation: Vec3;
}

/** Pose of a shared display in right-handed VRChat world space (`worldRH`). */
export type SharedDisplayWorldPose = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  updatedAt: number;
};

/** Converts a Unity left-handed world position to right-handed world space (`[x, y, -z]`). */
export function unityWorldPositionToRightHanded(p: Vec3): Vec3 {
  return [p[0], p[1], -p[2]];
}

/** Converts a right-handed world position back to Unity left-handed world space (`[x, y, -z]`). */
export function rightHandedPositionToUnityWorld(p: Vec3): Vec3 {
  return [p[0], p[1], -p[2]];
}

/** Wraps an angle in radians to `(-pi, pi]`. */
export function normalizeAngleRad(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a <= 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Shortest signed angular difference `normalizeAngleRad(to - from)` in `(-pi, pi]`. */
export function angleDiffRad(to: number, from: number): number {
  return normalizeAngleRad(to - from);
}

/**
 * Extracts right-handed yaw (radians, CCW around +Y from -Z forward) from an OpenVR HMD matrix.
 * At identity (facing -Z), returns `0`. Turning 90° left (facing -X) returns `+pi/2`.
 */
export function hmdYawRightHandedRad(hmdMatrix: Matrix34Tuple): number {
  return Math.atan2(hmdMatrix[0][2], hmdMatrix[2][2]);
}

/** Rotates a 3D point around +Y by `yawRad` (right-handed). */
export function rotateYawRH(p: Vec3, yawRad: number): Vec3 {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [
    c * p[0] + s * p[2],
    p[1],
    -s * p[0] + c * p[2],
  ];
}

/** Maps a right-handed VRChat world point into OpenVR Standing space. */
export function worldRHPointToStanding(
  transform: VrcWorldToStandingTransform,
  worldRH: Vec3,
): Vec3 {
  const r = rotateYawRH(worldRH, transform.yawRad);
  const s = transform.scale;
  return [
    s * r[0] + transform.translation[0],
    s * r[1] + transform.translation[1],
    s * r[2] + transform.translation[2],
  ];
}

/** Maps a Unity left-handed VRChat world point into OpenVR Standing space. */
export function unityWorldPointToStanding(
  transform: VrcWorldToStandingTransform,
  unityWorld: Vec3,
): Vec3 {
  return worldRHPointToStanding(transform, unityWorldPositionToRightHanded(unityWorld));
}

/** Maps an OpenVR Standing point into right-handed VRChat world space. */
export function standingPointToWorldRH(
  transform: VrcWorldToStandingTransform,
  standing: Vec3,
): Vec3 {
  const invScale = 1 / transform.scale;
  const shifted: Vec3 = [
    (standing[0] - transform.translation[0]) * invScale,
    (standing[1] - transform.translation[1]) * invScale,
    (standing[2] - transform.translation[2]) * invScale,
  ];
  return rotateYawRH(shifted, -transform.yawRad);
}

/** Maps an OpenVR Standing point into Unity left-handed VRChat world space. */
export function standingPointToUnityWorld(
  transform: VrcWorldToStandingTransform,
  standing: Vec3,
): Vec3 {
  return rightHandedPositionToUnityWorld(standingPointToWorldRH(transform, standing));
}

/** Converts a `VrcWorldToStandingTransform` into an OpenVR row-major 3x4 matrix. */
export function transformToHmdMatrix34(transform: VrcWorldToStandingTransform): Matrix34Tuple {
  const c = Math.cos(transform.yawRad) * transform.scale;
  const s = Math.sin(transform.yawRad) * transform.scale;
  return [
    [c, 0, s, transform.translation[0]],
    [0, transform.scale, 0, transform.translation[1]],
    [-s, 0, c, transform.translation[2]],
  ];
}

/**
 * Computes the world-origin translation in Standing space given an avatar root world pose,
 * OpenVR Standing HMD position, playspace yaw, and scale.
 *
 * The avatar root sits on the floor directly beneath the HMD: `(hmdX, 0, hmdZ)` in Standing.
 */
export function computeWorldOriginTranslation(
  unityWorldPos: Vec3,
  hmdStandingPos: Vec3,
  yawRad: number,
  scale = 1,
): Vec3 {
  const worldRH = unityWorldPositionToRightHanded(unityWorldPos);
  const rotated = rotateYawRH(worldRH, yawRad);
  return [
    hmdStandingPos[0] - scale * rotated[0],
    -scale * rotated[1],
    hmdStandingPos[2] - scale * rotated[2],
  ];
}

export interface VrcOriginSolverOptions {
  /** Minimum avatar-root yaw change (rad) before considering a yaw update (default ~0.11°). */
  avatarYawEpsilonRad?: number;
  /** Maximum head-vs-body yaw offset (rad) before snapping directly to raw yaw (default 60°). */
  maxHeadBodyOffsetRad?: number;
  /** Minimum translation change (m) to flag `changed = true` (default 0.5 mm). */
  publishPositionEpsilonMeters?: number;
  /** Minimum yaw change (rad) to flag `changed = true` (default 0.05°). */
  publishYawEpsilonRad?: number;
}

export interface VrcOriginSolverResult {
  transform: VrcWorldToStandingTransform;
  matrix: Matrix34Tuple;
  /** True when the transform moved beyond the publish epsilon since the last published value. */
  changed: boolean;
}

/**
 * Tracks the VRChat world -> OpenVR Standing transform from live avatar-root OSC poses and
 * OpenVR Standing HMD poses.
 *
 * Because the avatar root does not rotate when the user only turns their head ±30–40°,
 * naive `hmdYaw + avatarYaw` swings during head look-around. This solver holds `yawRad` steady
 * whenever the avatar root yaw is unchanged or is merely catching up to a prior physical head
 * turn, while immediately tracking joystick turns, smooth turns, and teleports.
 */
export class VrcOriginSolver {
  private readonly avatarYawEps: number;
  private readonly maxHeadBodyOffset: number;
  private readonly publishPosEps: number;
  private readonly publishYawEps: number;

  private yawRad: number | null = null;
  private scale = 1;
  private prevWorldYawRad: number | null = null;
  private prevRawYawRad: number | null = null;
  private lastPublished: VrcWorldToStandingTransform | null = null;

  constructor(options: VrcOriginSolverOptions = {}) {
    this.avatarYawEps = options.avatarYawEpsilonRad ?? 0.002;
    this.maxHeadBodyOffset = options.maxHeadBodyOffsetRad ?? (60 * Math.PI) / 180;
    this.publishPosEps = options.publishPositionEpsilonMeters ?? 0.0005;
    this.publishYawEps = options.publishYawEpsilonRad ?? (0.05 * Math.PI) / 180;
  }

  reset(): void {
    this.yawRad = null;
    this.prevWorldYawRad = null;
    this.prevRawYawRad = null;
    this.lastPublished = null;
  }

  setScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0.01 && scale < 100) {
      this.scale = scale;
    }
  }

  update(worldPose: VrcOriginWorldPose, hmdMatrix: Matrix34Tuple): VrcOriginSolverResult {
    const hmdPos: Vec3 = [hmdMatrix[0][3], hmdMatrix[1][3], hmdMatrix[2][3]];
    const hmdYaw = hmdYawRightHandedRad(hmdMatrix);
    const rawYaw = normalizeAngleRad(hmdYaw + worldPose.yawRad);

    if (this.yawRad === null || this.prevWorldYawRad === null || this.prevRawYawRad === null) {
      this.yawRad = rawYaw;
    } else {
      const dAvatarYaw = angleDiffRad(worldPose.yawRad, this.prevWorldYawRad);
      const prevErr = Math.abs(angleDiffRad(this.prevRawYawRad, this.yawRad));
      const nextErr = Math.abs(angleDiffRad(rawYaw, this.yawRad));

      if (Math.abs(dAvatarYaw) >= this.avatarYawEps) {
        if (nextErr > prevErr + 1e-4) {
          // Avatar yaw moved rawYaw further from our current playspace yaw (e.g. joystick turn):
          // apply the avatar yaw delta so any existing head-vs-body offset is not folded in.
          this.yawRad = normalizeAngleRad(this.yawRad + dAvatarYaw);
        } else if (nextErr > this.maxHeadBodyOffset) {
          // Large discontinuity (e.g. teleport to a differently oriented spawn).
          this.yawRad = rawYaw;
        }
        // Otherwise rawYaw moved closer to yawRad (avatar body catching up to a physical head turn):
        // keep yawRad steady.
      } else if (nextErr > this.maxHeadBodyOffset) {
        // Guard against unbounded drift if a teleport or spawn changed orientation.
        this.yawRad = rawYaw;
      }
    }

    this.prevWorldYawRad = worldPose.yawRad;
    this.prevRawYawRad = rawYaw;

    const translation = computeWorldOriginTranslation(
      worldPose.position,
      hmdPos,
      this.yawRad,
      this.scale,
    );

    const transform: VrcWorldToStandingTransform = {
      yawRad: this.yawRad,
      scale: this.scale,
      translation,
    };

    const changed = this.hasMovedPastPublishThreshold(transform);
    if (changed) {
      this.lastPublished = {
        yawRad: transform.yawRad,
        scale: transform.scale,
        translation: [...transform.translation],
      };
    }

    return {
      transform,
      matrix: transformToHmdMatrix34(transform),
      changed,
    };
  }

  private hasMovedPastPublishThreshold(next: VrcWorldToStandingTransform): boolean {
    if (!this.lastPublished) return true;
    const dx = next.translation[0] - this.lastPublished.translation[0];
    const dy = next.translation[1] - this.lastPublished.translation[1];
    const dz = next.translation[2] - this.lastPublished.translation[2];
    if (Math.hypot(dx, dy, dz) > this.publishPosEps) return true;
    if (Math.abs(angleDiffRad(next.yawRad, this.lastPublished.yawRad)) > this.publishYawEps) {
      return true;
    }
    if (Math.abs(next.scale - this.lastPublished.scale) > 1e-4) return true;
    return false;
  }
}

export type VrcOriginRoomLockMode = "locked" | "moving";

export interface VrcOriginRoomLockOptions {
  /** User-position error (m) that breaks the lock at once: joystick walking, teleports. */
  breakDistanceMeters?: number;
  /** Smaller user-position error (m) that breaks the lock when held with a still head. */
  sustainedBreakDistanceMeters?: number;
  /** How long (ms) the smaller error must persist before it breaks the lock. */
  sustainedBreakMs?: number;
  /** HMD speed (m/s) below which the head counts as still for the sustained break. */
  stillHeadSpeed?: number;
  /** Playspace yaw change (rad) that breaks the lock: snap and smooth turns. */
  breakYawRad?: number;
  /** While moving: raw changes smaller than this (m) count as settled. */
  settleDistanceMeters?: number;
  /** While moving: raw yaw changes smaller than this (rad) count as settled. */
  settleYawRad?: number;
  /** While moving: how long (ms) raw must stay settled before the lock is taken again. */
  settleMs?: number;
  /** Locomotion speed (m/s: root against HMD) that breaks the lock before any error builds up. */
  locomotionBreakSpeed?: number;
  /** While moving: locomotion faster than this (m/s) is never "settled". */
  settleMaxLocomotionSpeed?: number;
  /** How long (ms) the output takes to blend from the held transform when the lock breaks. */
  blendMs?: number;
  /** A yaw change (rad) this large at the break is a snap turn: no blend. */
  jumpYawRad?: number;
  /** A root error (m) this large at the break is a teleport: no blend. */
  jumpDistanceMeters?: number;
}

export interface VrcOriginRoomLockResult {
  transform: VrcWorldToStandingTransform;
  matrix: Matrix34Tuple;
  mode: VrcOriginRoomLockMode;
  /** True when the output moved since the last result that reported a change. */
  changed: boolean;
  /** Where the held transform puts the avatar root, relative to the floor under the HMD (m). */
  errorMeters: number;
}

/**
 * Holds the VRChat world -> Standing transform fixed in room space while the user is not moving
 * in VRChat.
 *
 * The raw estimate (`VrcOriginSolver`) pairs a live HMD pose with an avatar-root pose that VRChat
 * sends over OSC at ~8 Hz, and the avatar root sits under the neck rather than under the HMD. So
 * every head turn, lean or step makes the raw estimate swim and step by centimetres, though the
 * VRChat world has not moved in the room at all: it only moves on artificial locomotion (joystick
 * walking and turning, teleports, world changes).
 *
 * `locked`: the output stays exactly constant. Locomotion is detected as an error between where the
 * held transform puts the avatar root and the floor under the HMD (large, or moderate and lasting
 * with a still head), or a playspace yaw change. That switches to `moving`.
 * `moving`: the output follows the raw estimate. Once the raw estimate has stopped changing for a
 * moment, the lock is taken again at its current value.
 */
export class VrcOriginRoomLock {
  private readonly breakDistance: number;
  private readonly sustainedBreakDistance: number;
  private readonly sustainedBreakMs: number;
  private readonly stillHeadSpeed: number;
  private readonly breakYaw: number;
  private readonly settleDistance: number;
  private readonly settleYaw: number;
  private readonly settleMs: number;
  private readonly locomotionBreakSpeed: number;
  private readonly settleMaxLocomotionSpeed: number;
  private readonly blendMs: number;
  private readonly jumpYaw: number;
  private readonly jumpDistance: number;

  /** The held transform the output is blending away from, since `blendStart`. */
  private blendFrom: VrcWorldToStandingTransform | null = null;
  private blendStart = 0;
  private mode: VrcOriginRoomLockMode = "moving";
  private held: VrcWorldToStandingTransform | null = null;
  private lastOutput: VrcWorldToStandingTransform | null = null;
  private sustainedSince: number | null = null;
  private settleAnchor: VrcWorldToStandingTransform | null = null;
  private settleAnchorAt = 0;

  constructor(options: VrcOriginRoomLockOptions = {}) {
    this.breakDistance = options.breakDistanceMeters ?? 0.35;
    this.sustainedBreakDistance = options.sustainedBreakDistanceMeters ?? 0.12;
    this.sustainedBreakMs = options.sustainedBreakMs ?? 400;
    this.stillHeadSpeed = options.stillHeadSpeed ?? 0.25;
    this.breakYaw = options.breakYawRad ?? (2 * Math.PI) / 180;
    this.settleDistance = options.settleDistanceMeters ?? 0.04;
    this.settleYaw = options.settleYawRad ?? (0.5 * Math.PI) / 180;
    this.settleMs = options.settleMs ?? 300;
    this.locomotionBreakSpeed = options.locomotionBreakSpeed ?? 0.3;
    this.settleMaxLocomotionSpeed = options.settleMaxLocomotionSpeed ?? 0.08;
    this.blendMs = options.blendMs ?? 400;
    this.jumpYaw = options.jumpYawRad ?? (10 * Math.PI) / 180;
    this.jumpDistance = options.jumpDistanceMeters ?? 1.0;
  }

  reset(): void {
    this.mode = "moving";
    this.held = null;
    this.lastOutput = null;
    this.sustainedSince = null;
    this.settleAnchor = null;
    this.blendFrom = null;
  }

  getMode(): VrcOriginRoomLockMode {
    return this.mode;
  }

  /**
   * @param raw the solver's transform for this sample
   * @param worldPose the avatar-root pose the raw transform was solved from
   * @param hmdPos the HMD position in Standing
   * @param hmdSpeed the HMD's linear speed (m/s)
   * @param nowMs a monotonic clock
   * @param locomotionSpeed how fast the avatar root moves in the room relative to the HMD (m/s):
   *   VRChat locomotion, which physical motion does not produce
   */
  update(
    raw: VrcWorldToStandingTransform,
    worldPose: VrcOriginWorldPose,
    hmdPos: Vec3,
    hmdSpeed: number,
    nowMs: number,
    locomotionSpeed = 0,
  ): VrcOriginRoomLockResult {
    let errorMeters = 0;
    if (this.mode === "locked" && this.held) {
      errorMeters = rootErrorMeters(this.held, worldPose, hmdPos);
      const yawErr = Math.abs(angleDiffRad(raw.yawRad, this.held.yawRad));
      let breakLock = errorMeters > this.breakDistance || yawErr > this.breakYaw ||
        locomotionSpeed > this.locomotionBreakSpeed;
      if (
        !breakLock && errorMeters > this.sustainedBreakDistance && hmdSpeed < this.stillHeadSpeed
      ) {
        this.sustainedSince ??= nowMs;
        breakLock = nowMs - this.sustainedSince >= this.sustainedBreakMs;
      } else {
        this.sustainedSince = null;
      }
      if (breakLock) {
        this.mode = "moving";
        // Starting to walk eases in; a snap turn or teleport moves the VRChat world at once, and
        // content goes with it.
        const jump = yawErr > this.jumpYaw || errorMeters > this.jumpDistance;
        this.blendFrom = jump ? null : cloneTransform(this.held);
        this.blendStart = nowMs;
        this.sustainedSince = null;
        this.settleAnchor = cloneTransform(raw);
        this.settleAnchorAt = nowMs;
      }
    } else {
      if (
        !this.settleAnchor || locomotionSpeed > this.settleMaxLocomotionSpeed ||
        translationDistance(raw, this.settleAnchor) > this.settleDistance ||
        Math.abs(angleDiffRad(raw.yawRad, this.settleAnchor.yawRad)) > this.settleYaw
      ) {
        this.settleAnchor = cloneTransform(raw);
        this.settleAnchorAt = nowMs;
      } else if (nowMs - this.settleAnchorAt >= this.settleMs) {
        this.mode = "locked";
        this.held = cloneTransform(raw);
        this.blendFrom = null;
        this.sustainedSince = null;
      }
    }

    let output = this.mode === "locked" && this.held ? this.held : raw;
    if (this.mode === "moving" && this.blendFrom) {
      const u = (nowMs - this.blendStart) / this.blendMs;
      if (u >= 1) this.blendFrom = null;
      else output = blendAroundRoot(this.blendFrom, raw, worldPose, u * u * (3 - 2 * u));
    }
    const changed = !this.lastOutput || translationDistance(output, this.lastOutput) > 1e-6 ||
      Math.abs(angleDiffRad(output.yawRad, this.lastOutput.yawRad)) > 1e-7 ||
      Math.abs(output.scale - this.lastOutput.scale) > 1e-7;
    if (changed) this.lastOutput = cloneTransform(output);
    return {
      transform: output,
      matrix: transformToHmdMatrix34(output),
      mode: this.mode,
      changed,
      errorMeters,
    };
  }
}

function cloneTransform(t: VrcWorldToStandingTransform): VrcWorldToStandingTransform {
  return { yawRad: t.yawRad, scale: t.scale, translation: [...t.translation] };
}

function translationDistance(
  a: VrcWorldToStandingTransform,
  b: VrcWorldToStandingTransform,
): number {
  return Math.hypot(
    a.translation[0] - b.translation[0],
    a.translation[1] - b.translation[1],
    a.translation[2] - b.translation[2],
  );
}

/**
 * `from` → `to` at `u` (0..1), turning about the avatar root rather than the world origin: yaw
 * and the root's Standing position are interpolated, so distant content doesn't swing.
 */
function blendAroundRoot(
  from: VrcWorldToStandingTransform,
  to: VrcWorldToStandingTransform,
  worldPose: VrcOriginWorldPose,
  u: number,
): VrcWorldToStandingTransform {
  const a = unityWorldPointToStanding(from, worldPose.position);
  const b = unityWorldPointToStanding(to, worldPose.position);
  const yawRad = normalizeAngleRad(from.yawRad + angleDiffRad(to.yawRad, from.yawRad) * u);
  const scale = from.scale + (to.scale - from.scale) * u;
  const r = rotateYawRH(unityWorldPositionToRightHanded(worldPose.position), yawRad);
  return {
    yawRad,
    scale,
    translation: [
      a[0] + (b[0] - a[0]) * u - scale * r[0],
      a[1] + (b[1] - a[1]) * u - scale * r[1],
      a[2] + (b[2] - a[2]) * u - scale * r[2],
    ],
  };
}

/** Distance between where `transform` puts the avatar root and the floor under the HMD. */
function rootErrorMeters(
  transform: VrcWorldToStandingTransform,
  worldPose: VrcOriginWorldPose,
  hmdPos: Vec3,
): number {
  const root = unityWorldPointToStanding(transform, worldPose.position);
  return Math.hypot(root[0] - hmdPos[0], root[1], root[2] - hmdPos[2]);
}

/** One avatar-root pose from VRChat, stamped when its OSC burst arrived (epoch ms). */
export interface VrcOriginSample {
  t: number;
  pose: VrcOriginWorldPose;
}

export interface VrcRootPredictorOptions {
  /** Kalman process noise for position: white acceleration, (m/s²)²·s. */
  positionProcessNoise?: number;
  /** Kalman measurement variance for position (m²): mostly arrival-time jitter × speed. */
  positionMeasurementVariance?: number;
  /** Kalman process noise for yaw, (rad/s²)²·s. */
  yawProcessNoise?: number;
  /** Kalman measurement variance for yaw (rad²). */
  yawMeasurementVariance?: number;
  /** Output smoothing time constant (ms): how fast the shown pose takes up a correction. */
  smoothingMs?: number;
  /** Full-velocity extrapolation past a channel's newest sample (ms). */
  extrapolateMs?: number;
  /**
   * After `extrapolateMs`, velocity decays with this time constant (ms) rather than stopping dead:
   * VRChat skips updates for up to ~200 ms mid-walk.
   */
  decayMs?: number;
  /** Silence (ms past the newest sample) after which the estimate fades back to it: a stop. */
  stopAfterMs?: number;
  /** How long (ms) that fade takes. */
  fadeMs?: number;
  /** A position this far (m) from the prediction is a teleport: that channel starts over. */
  resetDistanceMeters?: number;
  /** A yaw this far (rad) from the prediction is a snap turn: that channel starts over. */
  resetYawRad?: number;
}

export interface VrcRootPrediction {
  pose: VrcOriginWorldPose;
  /** Root velocity in Unity world space (m/s). */
  velocity: Vec3;
  /** Avatar yaw rate (Unity yaw, rad/s). */
  yawRate: number;
}

interface ChannelTiming {
  extrapolateMs: number;
  decayMs: number;
  stopAfterMs: number;
  fadeMs: number;
}

/**
 * One channel (`dims` independent values) of a constant-velocity Kalman filter over timestamped
 * measurements, plus what a stop needs: the newest raw measurement and when it came.
 */
class KalmanChannel {
  /** Per dim `[x, v]` (v per second), as of `updatedAt`. */
  private state: [number, number][] = [];
  /** Per dim covariance `[pxx, pxv, pvv]`. */
  private cov: [number, number, number][] = [];
  updatedAt = 0;
  newestRaw: number[] | null = null;

  constructor(
    readonly dims: number,
    private readonly q: number,
    private readonly r: number,
  ) {}

  reset(): void {
    this.state = [];
    this.cov = [];
    this.newestRaw = null;
  }

  get started(): boolean {
    return this.newestRaw != null;
  }

  velocity(): number[] {
    return this.state.map(([, v]) => v);
  }

  measure(t: number, values: number[]): void {
    this.newestRaw = [...values];
    if (!this.state.length) {
      this.state = values.map((x) => [x, 0]);
      // Unknown velocity at first: let the second measurement set it.
      this.cov = values.map(() => [this.r, 0, 25]);
      this.updatedAt = t;
      return;
    }
    const dt = Math.max(0, (t - this.updatedAt) / 1000);
    this.updatedAt = t;
    const q = this.q;
    for (let k = 0; k < this.dims; k++) {
      let [x, v] = this.state[k];
      let [a, b, d] = this.cov[k];
      x += v * dt;
      a += 2 * dt * b + dt * dt * d + (q * dt ** 3) / 3;
      b += dt * d + (q * dt * dt) / 2;
      d += q * dt;
      const sInv = 1 / (a + this.r);
      const ka = a * sInv, kb = b * sInv;
      const y = values[k] - x;
      x += ka * y;
      v += kb * y;
      this.state[k] = [x, v];
      this.cov[k] = [(1 - ka) * a, (1 - ka) * b, d - kb * b];
    }
  }

  /**
   * The estimate at `t`: extrapolated at full velocity up to `extrapolateMs` past the newest
   * measurement, then with the velocity decaying over `decayMs`; after `stopAfterMs` of silence it
   * fades over `fadeMs` to the newest raw measurement (a stop: VRChat goes silent).
   */
  at(t: number, timing: ChannelTiming): { values: number[]; velocity: number[] } {
    const dt = Math.max(0, t - this.updatedAt);
    const { extrapolateMs, decayMs, stopAfterMs, fadeMs } = timing;
    let travelMs = Math.min(dt, extrapolateMs);
    let speedScale = 1;
    if (dt > extrapolateMs) {
      speedScale = Math.exp(-(dt - extrapolateMs) / decayMs);
      travelMs += decayMs * (1 - speedScale);
    }
    const values = this.state.map(([x, v]) => x + (v * travelMs) / 1000);
    const velocity = this.state.map(([, v]) => v * speedScale);
    if (dt > stopAfterMs && this.newestRaw) {
      const u = Math.min(1, (dt - stopAfterMs) / fadeMs);
      for (let k = 0; k < this.dims; k++) {
        values[k] += (this.newestRaw[k] - values[k]) * u;
        velocity[k] *= 1 - u;
      }
    }
    return { values, velocity };
  }
}

/**
 * Predicts the avatar root pose from the timestamped samples VRChat sends, and smooths what is
 * shown.
 *
 * Measured (2026-11-24): while moving, the root advances in regular ticks, but the OSC bursts
 * carrying it arrive with ~±20 ms jitter: sometimes two ticks in one burst and sometimes none
 * (about a third of bursts change only yaw), with gaps up to ~200 ms, and nothing at all once the
 * root stops changing. So:
 * - Position and yaw are separate channels, each a constant-velocity Kalman filter fed only when
 *   its value changes (a yaw-only burst says nothing about position).
 * - Each extrapolates `extrapolateMs` past its newest measurement, then lets the velocity decay
 *   over `decayMs` (a skipped update: slowing beats stopping dead), and after `stopAfterMs` of
 *   silence fades to the newest measurement (a stop), so it settles where VRChat put the root.
 * - A measurement far off the prediction (teleport, snap turn) restarts its channel, and the shown
 *   pose jumps with it rather than smearing.
 * - Every measurement still corrects the estimate a little, which on its own shows as a step at
 *   ~20 Hz. `display` moves the shown pose at the estimate's velocity and eases corrections in
 *   over `smoothingMs`, which costs no lag at constant speed. Replaying a recorded joystick walk,
 *   this cut frame-to-frame jitter ~3× against the line fit it replaced.
 */
export class VrcRootPredictor {
  private readonly timing: ChannelTiming;
  private readonly resetDistance: number;
  private readonly resetYaw: number;
  private readonly smoothingMs: number;
  private readonly position: KalmanChannel;
  /** Unwrapped yaw. */
  private readonly yaw: KalmanChannel;
  private source: VrcOriginWorldPose["source"] = "petplay-origin";
  private lastPose: VrcOriginWorldPose | null = null;
  /** Shown state for `display`: `[x, y, z, unwrappedYaw]` at `shownAt`. */
  private shown: number[] | null = null;
  private shownAt = 0;

  constructor(options: VrcRootPredictorOptions = {}) {
    this.position = new KalmanChannel(
      3,
      options.positionProcessNoise ?? 2,
      options.positionMeasurementVariance ?? 0.0004,
    );
    this.yaw = new KalmanChannel(
      1,
      options.yawProcessNoise ?? 20,
      options.yawMeasurementVariance ?? 3e-5,
    );
    this.smoothingMs = options.smoothingMs ?? 80;
    this.timing = {
      extrapolateMs: options.extrapolateMs ?? 60,
      decayMs: options.decayMs ?? 120,
      stopAfterMs: options.stopAfterMs ?? 250,
      fadeMs: options.fadeMs ?? 200,
    };
    this.resetDistance = options.resetDistanceMeters ?? 1.0;
    this.resetYaw = options.resetYawRad ?? (20 * Math.PI) / 180;
  }

  reset(): void {
    this.position.reset();
    this.yaw.reset();
    this.lastPose = null;
    this.shown = null;
  }

  hasSamples(): boolean {
    return this.lastPose != null;
  }

  add(sample: VrcOriginSample): void {
    const { pose, t } = sample;
    this.source = pose.source;
    const prev = this.lastPose;
    const positionChanged = !prev || pose.position.some((v, k) => v !== prev.position[k]);
    const yawChanged = !prev || pose.yawRad !== prev.yawRad;
    this.lastPose = pose;

    if (positionChanged && (!this.position.started || t > this.position.updatedAt)) {
      if (this.position.started) {
        const predicted = this.position.at(t, this.timing).values;
        if (Math.hypot(...pose.position.map((v, k) => v - predicted[k])) > this.resetDistance) {
          this.position.reset();
          this.shown = null;
        }
      }
      this.position.measure(t, [...pose.position]);
    }
    if (yawChanged && (!this.yaw.started || t > this.yaw.updatedAt)) {
      let yaw = pose.yawRad;
      if (this.yaw.started) {
        const predicted = this.yaw.at(t, this.timing).values[0];
        yaw = predicted + angleDiffRad(yaw, predicted);
        if (Math.abs(yaw - predicted) > this.resetYaw) {
          this.yaw.reset();
          this.shown = null;
        }
      }
      this.yaw.measure(t, [yaw]);
    }
  }

  /** The filters' estimate at `tMs` (no output smoothing). */
  predict(tMs: number): VrcRootPrediction {
    if (!this.lastPose) {
      return {
        pose: { source: this.source, position: [0, 0, 0], yawRad: 0 },
        velocity: [0, 0, 0],
        yawRate: 0,
      };
    }
    const p = this.position.at(tMs, this.timing);
    const y = this.yaw.at(tMs, this.timing);
    return {
      pose: {
        source: this.source,
        position: p.values as Vec3,
        yawRad: normalizeAngleRad(y.values[0]),
      },
      velocity: p.velocity as Vec3,
      yawRate: y.velocity[0],
    };
  }

  /**
   * The pose to show at `tMs`: moves at the estimate's velocity and takes up corrections over
   * `smoothingMs`. Stateful: call with increasing times (each poll).
   */
  display(tMs: number): VrcRootPrediction {
    const target = this.predict(tMs);
    const unwrappedYaw = this.yaw.started
      ? this.yaw.at(tMs, this.timing).values[0]
      : target.pose.yawRad;
    const goal = [...target.pose.position, unwrappedYaw];
    const rates = [...target.velocity, target.yawRate];
    if (!this.shown || tMs <= this.shownAt) {
      if (!this.shown) this.shown = goal;
      this.shownAt = Math.max(this.shownAt, tMs);
    } else {
      const dt = tMs - this.shownAt;
      this.shownAt = tMs;
      const a = 1 - Math.exp(-dt / this.smoothingMs);
      this.shown = this.shown.map((x, k) => {
        const moved = x + (rates[k] * dt) / 1000;
        return moved + (goal[k] - moved) * a;
      });
    }
    return {
      pose: {
        source: this.source,
        position: [this.shown[0], this.shown[1], this.shown[2]],
        yawRad: normalizeAngleRad(this.shown[3]),
      },
      velocity: target.velocity,
      yawRate: target.yawRate,
    };
  }
}

/**
 * What webxr needs to evaluate the VRChat world -> Standing transform at its own frame times:
 * the root moves at `rootVelocityRH` in world space and the playspace turns at `yawRate`, while
 * the root stays over the Standing floor point `pivot`.
 * `c(t) = pivot - scale * R_y(yaw + yawRate*dt) * (rootRH + rootVelocityRH*dt)`.
 */
export interface VrcOriginMotion {
  /** Epoch ms the model is evaluated from. */
  t: number;
  yawRad: number;
  /** Playspace yaw rate (rad/s, right-handed, same sign as `yawRad`). */
  yawRate: number;
  scale: number;
  /** Standing point the avatar root maps to at `t` (floor under the HMD). */
  pivot: Vec3;
  rootRH: Vec3;
  rootVelocityRH: Vec3;
}

/** The transform `motion` gives at `tMs`, extrapolating at most `maxAheadMs` past `motion.t`. */
export function evaluateVrcOriginMotion(
  motion: VrcOriginMotion,
  tMs: number,
  maxAheadMs = 50,
): VrcWorldToStandingTransform {
  const dt = Math.min(Math.max(0, tMs - motion.t), maxAheadMs) / 1000;
  const yawRad = motion.yawRad + motion.yawRate * dt;
  const root: Vec3 = [
    motion.rootRH[0] + motion.rootVelocityRH[0] * dt,
    motion.rootRH[1] + motion.rootVelocityRH[1] * dt,
    motion.rootRH[2] + motion.rootVelocityRH[2] * dt,
  ];
  const r = rotateYawRH(root, yawRad);
  return {
    yawRad,
    scale: motion.scale,
    translation: [
      motion.pivot[0] - motion.scale * r[0],
      motion.pivot[1] - motion.scale * r[1],
      motion.pivot[2] - motion.scale * r[2],
    ],
  };
}

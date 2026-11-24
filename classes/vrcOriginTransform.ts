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
  }

  reset(): void {
    this.mode = "moving";
    this.held = null;
    this.lastOutput = null;
    this.sustainedSince = null;
    this.settleAnchor = null;
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
   */
  update(
    raw: VrcWorldToStandingTransform,
    worldPose: VrcOriginWorldPose,
    hmdPos: Vec3,
    hmdSpeed: number,
    nowMs: number,
  ): VrcOriginRoomLockResult {
    let errorMeters = 0;
    if (this.mode === "locked" && this.held) {
      errorMeters = rootErrorMeters(this.held, worldPose, hmdPos);
      const yawErr = Math.abs(angleDiffRad(raw.yawRad, this.held.yawRad));
      let breakLock = errorMeters > this.breakDistance || yawErr > this.breakYaw;
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
        this.sustainedSince = null;
        this.settleAnchor = cloneTransform(raw);
        this.settleAnchorAt = nowMs;
      }
    } else {
      if (
        !this.settleAnchor ||
        translationDistance(raw, this.settleAnchor) > this.settleDistance ||
        Math.abs(angleDiffRad(raw.yawRad, this.settleAnchor.yawRad)) > this.settleYaw
      ) {
        this.settleAnchor = cloneTransform(raw);
        this.settleAnchorAt = nowMs;
      } else if (nowMs - this.settleAnchorAt >= this.settleMs) {
        this.mode = "locked";
        this.held = cloneTransform(raw);
        this.sustainedSince = null;
      }
    }

    const output = this.mode === "locked" && this.held ? this.held : raw;
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

/** Distance between where `transform` puts the avatar root and the floor under the HMD. */
function rootErrorMeters(
  transform: VrcWorldToStandingTransform,
  worldPose: VrcOriginWorldPose,
  hmdPos: Vec3,
): number {
  const root = unityWorldPointToStanding(transform, worldPose.position);
  return Math.hypot(root[0] - hmdPos[0], root[1], root[2] - hmdPos[2]);
}

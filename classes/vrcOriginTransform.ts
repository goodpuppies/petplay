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
  /**
   * `follow` (default): the avatar root turns with the head (VRChat in VR, both rigs, measured
   * 2026-11-27), so HMD yaw + root yaw is the playspace yaw, steady while standing. It is
   * low-passed over `followTauMs` to remove the swing from the root arriving later than the HMD
   * pose. `hold`: the older model where the root ignores head look-around.
   */
  yawModel?: "follow" | "hold";
  /** Low-pass time constant (ms) for the `follow` yaw model (default 500). */
  followTauMs?: number;
  /**
   * In `follow`, raw yaw further than this (rad) from the held yaw is an outlier (VRChat swings
   * the body after hard head turns): ignored unless it lasts `followSnapMs` with a slow head, then
   * taken at once (a teleport that turned the player). Default 6°.
   */
  followSnapRad?: number;
  /** How long (ms) an outlier must last before it is taken (default 400). */
  followSnapMs?: number;
  /**
   * In `follow`, how far ahead (s) of the OpenVR pose VRChat's avatar root follows the head:
   * VRChat poses the avatar with the HMD pose predicted for display (measured ~50 ms).
   */
  headLeadSeconds?: number;
  /** In `follow`, head yaw rates (rad/s) from which the raw yaw is trusted less, down to not at
   * all: fast head turns leave a few degrees of timing error in HMD yaw + root yaw. */
  followHeadRateRad?: [number, number];
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
/** Decay (ms) of the solver's recent peak head yaw rate. */
const PEAK_HEAD_RATE_DECAY_MS = 250;

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
  private readonly yawModel: "follow" | "hold";
  private readonly followTauMs: number;
  private readonly followSnap: number;
  private lastUpdateMs: number | null = null;
  private readonly headLead: number;
  private readonly followHeadRate: [number, number];
  /** Recent peak |head yaw rate|, decaying: a shake reverses through rate 0 at every swing end. */
  private peakHeadRate = 0;
  private readonly followSnapMs: number;
  private outlierSince: number | null = null;

  constructor(options: VrcOriginSolverOptions = {}) {
    this.avatarYawEps = options.avatarYawEpsilonRad ?? 0.002;
    this.maxHeadBodyOffset = options.maxHeadBodyOffsetRad ?? (60 * Math.PI) / 180;
    this.publishPosEps = options.publishPositionEpsilonMeters ?? 0.0005;
    this.publishYawEps = options.publishYawEpsilonRad ?? (0.05 * Math.PI) / 180;
    this.yawModel = options.yawModel ?? "follow";
    this.followTauMs = options.followTauMs ?? 500;
    this.followSnap = options.followSnapRad ?? (6 * Math.PI) / 180;
    this.followSnapMs = options.followSnapMs ?? 400;
    this.headLead = options.headLeadSeconds ?? 0.05;
    this.followHeadRate = options.followHeadRateRad ??
      [(45 * Math.PI) / 180, (120 * Math.PI) / 180];
  }

  reset(): void {
    this.yawRad = null;
    this.prevWorldYawRad = null;
    this.prevRawYawRad = null;
    this.lastPublished = null;
    this.lastUpdateMs = null;
    this.peakHeadRate = 0;
    this.outlierSince = null;
  }

  setScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0.01 && scale < 100) {
      this.scale = scale;
    }
  }

  /**
   * @param stickTurning the turn stick is held: every avatar yaw change is the playspace turning
   *   (not the body catching up to the head), so it applies 1:1
   */
  update(
    worldPose: VrcOriginWorldPose,
    hmdMatrix: Matrix34Tuple,
    stickTurning = false,
    nowMs = performance.now(),
    hmdYawRateRad = 0,
  ): VrcOriginSolverResult {
    const hmdPos: Vec3 = [hmdMatrix[0][3], hmdMatrix[1][3], hmdMatrix[2][3]];
    const hmdYaw = hmdYawRightHandedRad(hmdMatrix);
    const rawYaw = normalizeAngleRad(hmdYaw + worldPose.yawRad);

    const dtMs = this.lastUpdateMs === null ? 0 : Math.max(0, nowMs - this.lastUpdateMs);
    this.lastUpdateMs = nowMs;
    if (this.yawRad === null || this.prevWorldYawRad === null || this.prevRawYawRad === null) {
      this.yawRad = rawYaw;
    } else if (this.yawModel === "follow") {
      // Pair the root with the head pose VRChat used for it (predicted ahead for display).
      const followYaw = normalizeAngleRad(rawYaw + hmdYawRateRad * this.headLead);
      const err = angleDiffRad(followYaw, this.yawRad);
      this.peakHeadRate = Math.max(
        Math.abs(hmdYawRateRad),
        this.peakHeadRate * Math.exp(-dtMs / PEAK_HEAD_RATE_DECAY_MS),
      );
      const rate = this.peakHeadRate;
      const [slow, fast] = this.followHeadRate;
      const trust = rate <= slow ? 1 : rate >= fast ? 0 : (fast - rate) / (fast - slow);
      if (stickTurning) {
        // The turn stick turns the playspace: take it at once, no smoothing lag. Not the root's
        // yaw change 1:1: the root also turns with the head, and a head turn during a stick turn
        // would stay in the playspace yaw (measured: 14.5° from a 16° head turn).
        this.yawRad = followYaw;
        this.outlierSince = null;
      } else if (Math.abs(err) > this.followSnap) {
        this.outlierSince = trust === 1 ? (this.outlierSince ?? nowMs) : null;
        if (this.outlierSince !== null && nowMs - this.outlierSince >= this.followSnapMs) {
          this.yawRad = followYaw;
          this.outlierSince = null;
        }
      } else {
        this.outlierSince = null;
        const k = (1 - Math.exp(-dtMs / this.followTauMs)) * trust;
        this.yawRad = normalizeAngleRad(this.yawRad + err * k);
      }
    } else {
      const dAvatarYaw = angleDiffRad(worldPose.yawRad, this.prevWorldYawRad);
      const prevErr = Math.abs(angleDiffRad(this.prevRawYawRad, this.yawRad));
      const nextErr = Math.abs(angleDiffRad(rawYaw, this.yawRad));

      if (stickTurning) {
        this.yawRad = normalizeAngleRad(this.yawRad + dAvatarYaw);
      } else if (Math.abs(dAvatarYaw) >= this.avatarYawEps) {
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
  /**
   * With known sticks (`sticksKnown`): idle sticks never break the lock. A held error this large
   * (m, or `desyncYawRad`) for `desyncMs`, taken with a still head, is a desync: the lock is
   * re-anchored by animating over `correctionMs`.
   */
  desyncDistanceMeters?: number;
  desyncYawRad?: number;
  desyncMs?: number;
  correctionMs?: number;
  /** A desync this large (m, or `teleportYawRad`) for `teleportMs` is a teleport: re-anchor at once. */
  teleportDistanceMeters?: number;
  teleportYawRad?: number;
  teleportMs?: number;
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
  private readonly desyncDistance: number;
  private readonly desyncYaw: number;
  private readonly desyncMs: number;
  private readonly correctionMs: number;
  private readonly teleportDistance: number;
  private readonly teleportYaw: number;
  private readonly teleportMs: number;
  private desyncSince: number | null = null;
  /** A slow re-anchor in progress (locked): from `from` to `held` since `start`. */
  private correction: { from: VrcWorldToStandingTransform; start: number } | null = null;
  private lastStickAt = -Infinity;

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
    this.desyncDistance = options.desyncDistanceMeters ?? 0.25;
    this.desyncYaw = options.desyncYawRad ?? (4 * Math.PI) / 180;
    this.desyncMs = options.desyncMs ?? 1000;
    this.correctionMs = options.correctionMs ?? 1500;
    this.teleportDistance = options.teleportDistanceMeters ?? 2.0;
    this.teleportYaw = options.teleportYawRad ?? (30 * Math.PI) / 180;
    this.teleportMs = options.teleportMs ?? 300;
  }

  reset(): void {
    this.mode = "moving";
    this.held = null;
    this.lastOutput = null;
    this.sustainedSince = null;
    this.settleAnchor = null;
    this.blendFrom = null;
    this.desyncSince = null;
    this.correction = null;
    this.lastStickAt = -Infinity;
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
   * @param stickMoving a move or turn stick is held: VRChat is moving now, before samples show it
   * @param sticksKnown the sticks are being read: idle sticks then mean VRChat is not moving the
   *   player, so the lock holds and only a clear, lasting desync re-anchors it (slowly)
   * @param overlayHeld a hand holds a PetPlay overlay: lock where the output is and stay there
   *   (no breaks, desync corrections or re-anchors) until it is let go
   */
  update(
    raw: VrcWorldToStandingTransform,
    worldPose: VrcOriginWorldPose,
    hmdPos: Vec3,
    hmdSpeed: number,
    nowMs: number,
    locomotionSpeed = 0,
    stickMoving = false,
    sticksKnown = false,
    overlayHeld = false,
  ): VrcOriginRoomLockResult {
    let errorMeters = 0;
    if (stickMoving) this.lastStickAt = nowMs;
    if (overlayHeld) {
      if (this.mode !== "locked" || !this.held) {
        // Freeze what is shown, so grabbing never moves the room under the hand.
        this.held = cloneTransform(this.blendOutput(raw, worldPose, nowMs));
        this.mode = "locked";
        this.blendFrom = null;
        this.correction = null;
      }
      this.sustainedSince = null;
      this.desyncSince = null;
      if (this.held) errorMeters = rootErrorMeters(this.held, worldPose, hmdPos);
      return this.finish(this.lockedOutput(worldPose, nowMs), errorMeters);
    }
    if (sticksKnown && this.mode === "locked" && this.held && !stickMoving) {
      errorMeters = rootErrorMeters(this.held, worldPose, hmdPos);
      const yawErr = Math.abs(angleDiffRad(raw.yawRad, this.held.yawRad));
      const teleport = errorMeters > this.teleportDistance || yawErr > this.teleportYaw;
      const desync = teleport || errorMeters > this.desyncDistance || yawErr > this.desyncYaw;
      this.desyncSince = desync ? (this.desyncSince ?? nowMs) : null;
      const lasted = this.desyncSince === null ? 0 : nowMs - this.desyncSince;
      if (teleport && lasted >= this.teleportMs) {
        this.held = cloneTransform(raw);
        this.correction = null;
        this.desyncSince = null;
      } else if (
        desync && lasted >= this.desyncMs && hmdSpeed < this.stillHeadSpeed && !this.correction
      ) {
        this.correction = {
          from: cloneTransform(this.lockedOutput(worldPose, nowMs)),
          start: nowMs,
        };
        this.held = cloneTransform(raw);
        this.desyncSince = null;
      }
      return this.finish(this.lockedOutput(worldPose, nowMs), errorMeters);
    }
    if (
      sticksKnown && this.mode === "moving" && !stickMoving &&
      nowMs - this.lastStickAt >= this.settleMs
    ) {
      // The sticks have been idle for a moment: VRChat has stopped moving the player. Lock now
      // rather than wait for the raw estimate to go still, which head motion can prevent.
      this.mode = "locked";
      this.held = cloneTransform(raw);
      this.correction = this.blendFrom
        ? { from: cloneTransform(this.blendOutput(raw, worldPose, nowMs)), start: nowMs }
        : null;
      this.blendFrom = null;
      this.sustainedSince = null;
      this.desyncSince = null;
      return this.finish(this.lockedOutput(worldPose, nowMs), errorMeters);
    }
    if (this.mode === "locked" && this.held) {
      errorMeters = rootErrorMeters(this.held, worldPose, hmdPos);
      const yawErr = Math.abs(angleDiffRad(raw.yawRad, this.held.yawRad));
      let breakLock = errorMeters > this.breakDistance || yawErr > this.breakYaw ||
        locomotionSpeed > this.locomotionBreakSpeed || stickMoving;
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
        !this.settleAnchor || stickMoving || locomotionSpeed > this.settleMaxLocomotionSpeed ||
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

    if (this.mode === "moving") this.correction = null;
    const output = this.mode === "locked" && this.held
      ? this.lockedOutput(worldPose, nowMs)
      : this.blendOutput(raw, worldPose, nowMs);
    return this.finish(output, errorMeters);
  }

  /** The locked output: the held transform, or the slow re-anchor towards it. */
  private lockedOutput(worldPose: VrcOriginWorldPose, nowMs: number): VrcWorldToStandingTransform {
    const held = this.held!;
    if (!this.correction) return held;
    const u = (nowMs - this.correction.start) / this.correctionMs;
    if (u >= 1) {
      this.correction = null;
      return held;
    }
    return blendAroundRoot(this.correction.from, held, worldPose, u * u * (3 - 2 * u));
  }

  /** The moving output: raw, blended in from the held transform just after a break. */
  private blendOutput(
    raw: VrcWorldToStandingTransform,
    worldPose: VrcOriginWorldPose,
    nowMs: number,
  ): VrcWorldToStandingTransform {
    if (!this.blendFrom) return raw;
    const u = (nowMs - this.blendStart) / this.blendMs;
    if (u >= 1) {
      this.blendFrom = null;
      return raw;
    }
    return blendAroundRoot(this.blendFrom, raw, worldPose, u * u * (3 - 2 * u));
  }

  private finish(
    output: VrcWorldToStandingTransform,
    errorMeters: number,
  ): VrcOriginRoomLockResult {
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
  /** The same while the stick says VRChat is still moving (ms). */
  heldExtrapolateMs?: number;
  /** Position process noise while the stick is held steady (speed can't change). */
  steadyPositionProcessNoise?: number;
  /** Yaw process noise while the turn stick is held steady. */
  steadyYawProcessNoise?: number;
  /** Position process noise for a while after the stick (or the head's yaw) changes. */
  changingPositionProcessNoise?: number;
  /** Yaw process noise for a while after the turn stick changes. */
  changingYawProcessNoise?: number;
  /** How long (ms) after a stick change the filter stays responsive. */
  stickChangeMs?: number;
  /** Initial smooth-turn rate per unit of turn stick (rad/s); learned from each turn after. */
  turnGainRadPerSec?: number;
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
  /** Full-velocity extrapolation while the stick is held. */
  heldMs: number;
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

  /** Process noise; the predictor lowers it while the stick says speed is steady. */
  q: number;

  constructor(
    readonly dims: number,
    q: number,
    private readonly r: number,
  ) {
    this.q = q;
  }

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

  /**
   * A measurement at `t`. `fresh[k] === false` means dim `k` didn't update in it (VRChat can
   * freeze one axis's contacts for ~200 ms while another keeps moving): that dim only advances.
   */
  measure(t: number, values: number[], fresh?: boolean[], timingSigmaMs = 0): void {
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
      if (fresh && !fresh[k]) {
        this.state[k] = [x, v];
        this.cov[k] = [a, b, d];
        continue;
      }
      // Arrival-time noise shows as position noise in proportion to speed.
      const timingNoise = (v * timingSigmaMs) / 1000;
      const sInv = 1 / (a + this.r + timingNoise * timingNoise);
      const ka = a * sInv, kb = b * sInv;
      const y = values[k] - x;
      x += ka * y;
      v += kb * y;
      this.state[k] = [x, v];
      this.cov[k] = [(1 - ka) * a, (1 - ka) * b, d - kb * b];
    }
  }

  /**
   * The stick was released at `t`: VRChat stopped there. Advance to `t` at the current velocity,
   * then hold still (later measurements still correct the position).
   */
  stop(t: number): void {
    if (!this.state.length || t <= this.updatedAt) {
      for (const s of this.state) s[1] = 0;
      return;
    }
    const dt = (t - this.updatedAt) / 1000;
    this.state = this.state.map(([x, v]) => [x + v * dt, 0]);
    this.cov = this.cov.map(([a]) => [a, 0, 0.01]);
    this.updatedAt = t;
  }

  /** Overwrite the estimate at `t` (dead reckoning from the stick). */
  set(t: number, values: number[], velocity: number[]): void {
    this.state = values.map((x, k) => [x, velocity[k]]);
    this.cov = values.map(() => [this.r, 0, 0.01]);
    this.updatedAt = t;
    // The stop fade settles on this, not on a reading from before the dead reckoning.
    this.newestRaw = [...values];
  }

  /** Pull the velocity toward `values` (per second) with variance `r`, without moving in time. */
  measureVelocity(values: number[], r: number): void {
    for (let k = 0; k < this.state.length; k++) {
      const [x, v] = this.state[k];
      const [a, b, d] = this.cov[k];
      const sInv = 1 / (d + r);
      const kx = b * sInv, kv = d * sInv;
      const y = values[k] - v;
      this.state[k] = [x + kx * y, v + kv * y];
      this.cov[k] = [a - kx * b, (1 - kv) * b, (1 - kv) * d];
    }
  }

  /**
   * The estimate at `t`: extrapolated at full velocity up to `extrapolateMs` past the newest
   * measurement (or `heldMs` while the stick says VRChat is still moving), then with the velocity
   * decaying over `decayMs`; after `stopAfterMs` of silence it fades over `fadeMs` to the newest
   * raw measurement (a stop: VRChat goes silent).
   */
  at(
    t: number,
    timing: ChannelTiming,
    held = false,
  ): { values: number[]; velocity: number[] } {
    const dt = Math.max(0, t - this.updatedAt);
    const { decayMs, fadeMs } = timing;
    const extrapolateMs = held ? timing.heldMs : timing.extrapolateMs;
    const stopAfterMs = held ? timing.heldMs + timing.stopAfterMs : timing.stopAfterMs;
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

/** Controller state relevant to VRChat locomotion (`VrcRootPredictor.setInput`). */
export interface VrcLocomotionInput {
  /** Epoch ms. */
  t: number;
  /** Move stick `[x, y]` (VRChat default: left stick); zero while PetPlay UI holds it. */
  move: [number, number];
  /** Turn stick x (VRChat default: right stick); zero while PetPlay UI holds it. */
  turn: number;
  /** HMD yaw rate (rad/s, magnitude): VRChat walks where the head looks. */
  headYawRate: number;
}

/** Spread of OSC arrival times around when VRChat sampled (ms), measured 2026-11-24. */
const ARRIVAL_SIGMA_MS = 12;
const STICK_DEADZONE = 0.15;
const STICK_CHANGE = 0.1;

/** Active/steady/released tracking for one stick. */
class StickTracker {
  active = false;
  changedAt = -Infinity;
  private releasedAt = -Infinity;
  private reference: [number, number] = [0, 0];

  clear(): void {
    this.active = false;
    this.changedAt = -Infinity;
    this.releasedAt = -Infinity;
  }

  releasedWithin(t: number, ms: number): boolean {
    return !this.active && t - this.releasedAt <= ms;
  }

  /** `extraChange`: something else (head turning) changes the motion too. */
  update(
    t: number,
    value: [number, number],
    extraChange: boolean,
  ): "pressed" | "released" | null {
    const active = Math.hypot(value[0], value[1]) > STICK_DEADZONE;
    let event: "pressed" | "released" | null = null;
    if (active !== this.active) {
      event = active ? "pressed" : "released";
      if (!active) this.releasedAt = t;
      this.active = active;
      this.changedAt = t;
      this.reference = [...value];
    } else if (
      Math.hypot(value[0] - this.reference[0], value[1] - this.reference[1]) > STICK_CHANGE ||
      (active && extraChange)
    ) {
      this.changedAt = t;
      this.reference = [...value];
    }
    return event;
  }
}

/** Dead reckoning of a smooth turn from the turn stick, and learning its rate. */
class StickTurn {
  turning = false;
  settling = false;
  disabled = false;
  releasedAt = 0;
  private yaw = 0;
  private startYaw = 0;
  private startRaw = 0;
  private lastT = 0;
  private lastStick = 0;
  private mismatches = 0;

  constructor(public gain: number) {}

  /** Easing the estimate to the settled reading: `[endsAt, target]`. */
  correction: [number, number] | null = null;
  private startT = 0;

  /** Whether the stick (not the PhysBone reading) owns yaw right now. */
  get steering(): boolean {
    return this.turning || this.settling || this.correction != null;
  }

  cancel(): void {
    this.turning = false;
    this.settling = false;
    this.correction = null;
  }

  begin(t: number, estimate: number, rawYaw: number): void {
    this.turning = true;
    this.settling = false;
    this.correction = null;
    this.startT = t;
    this.yaw = this.startYaw = estimate;
    this.startRaw = rawYaw;
    this.lastT = t;
    this.lastStick = 0;
  }

  advance(t: number, stick: number): number {
    this.yaw += (this.gain * stick * Math.max(0, t - this.lastT)) / 1000;
    this.lastT = t;
    this.lastStick = stick;
    return this.yaw;
  }

  end(t: number): number {
    this.advance(t, this.lastStick);
    this.turning = false;
    this.settling = true;
    this.releasedAt = t;
    return this.yaw;
  }

  /**
   * The PhysBone reading settled at `rawYaw` (unwrapped): learn from predicted vs measured. The
   * reading is the avatar body's yaw, which also swings tens of degrees against the head, so only
   * long turns (where that is small next to the turn) teach the gain.
   */
  settle(rawYaw: number): void {
    this.settling = false;
    const predicted = this.yaw - this.startYaw;
    const measured = rawYaw - this.startRaw;
    if (Math.abs(predicted) < Math.PI / 3 || this.releasedAt - this.startT < 400) return;
    const ratio = measured / predicted;
    if (ratio > 0.6 && ratio < 1.6) {
      this.gain = Math.min(8, Math.max(1, this.gain * (1 + 0.5 * (ratio - 1))));
      this.mismatches = 0;
    } else if (++this.mismatches >= 3) {
      // Not smooth turning as modelled (snap turning, other bindings): measurements only.
      this.disabled = true;
    }
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
/** How long after a turn-stick release `isStickTurning` stays true for v2 (ms). */
const V2_TURN_RELEASE_TAIL_MS = 150;

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
  private readonly q: {
    position: number;
    yaw: number;
    steadyPosition: number;
    steadyYaw: number;
    changingPosition: number;
    changingYaw: number;
  };
  private readonly stickChangeMs: number;
  private readonly move = new StickTracker();
  private readonly turn = new StickTracker();
  private readonly stickTurn: StickTurn;
  /** Time of the newest `setInput`. */
  private inputAt = 0;
  /** The measured (PhysBone) yaw, unwrapped, and when it last changed. */
  private rawYaw: number | null = null;
  private rawYawChangedAt = 0;

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
    this.q = {
      position: options.positionProcessNoise ?? 2,
      yaw: options.yawProcessNoise ?? 20,
      steadyPosition: options.steadyPositionProcessNoise ?? 0.05,
      steadyYaw: options.steadyYawProcessNoise ?? 0.5,
      changingPosition: options.changingPositionProcessNoise ?? 8,
      changingYaw: options.changingYawProcessNoise ?? 40,
    };
    this.stickChangeMs = options.stickChangeMs ?? 300;
    this.stickTurn = new StickTurn(options.turnGainRadPerSec ?? (200 * Math.PI) / 180);
    this.timing = {
      extrapolateMs: options.extrapolateMs ?? 60,
      heldMs: options.heldExtrapolateMs ?? 400,
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
    this.rawYaw = null;
    this.stickTurn.cancel();
  }

  /** Whether the turn stick is driving yaw right now (`VrcOriginSolver.update`'s hint). */
  isStickTurning(): boolean {
    // v2 measures yaw without lag, so the stick only says the playspace is turning. VRChat's
    // samples trail the stick by ~50-100 ms, so a release still counts for a moment.
    if (this.source === "petplay-origin-v2") {
      return this.turn.active || this.turn.releasedWithin(this.inputAt, V2_TURN_RELEASE_TAIL_MS);
    }
    return this.stickTurn.turning;
  }

  /** The learned smooth-turn rate per unit of stick (rad/s), and whether stick turning is used. */
  turnGain(): { radPerSec: number; enabled: boolean } {
    return { radPerSec: this.stickTurn.gain, enabled: !this.stickTurn.disabled };
  }

  hasSamples(): boolean {
    return this.lastPose != null;
  }

  /**
   * What the controllers say about VRChat locomotion, each poll; `null` when unknown (then the
   * filters run on OSC samples alone).
   *
   * VRChat moves the instant the stick moves and stops the instant it is released, and the OSC
   * samples only show it ~50 ms later with ±20 ms arrival noise. So: a release stops the estimate
   * right there (no overshoot); while the stick is held, skipped samples never slow it; and while
   * the stick (and, for walking, the head's yaw: VRChat walks where the head looks) holds steady,
   * speed cannot change, so the filter trusts its velocity and ignores arrival noise. For
   * `stickChangeMs` after a change it is responsive again.
   */
  setInput(input: VrcLocomotionInput | null): void {
    if (!input) {
      this.move.clear();
      this.turn.clear();
      this.stickTurn.cancel();
      this.position.q = this.q.position;
      this.yaw.q = this.q.yaw;
      return;
    }
    this.inputAt = input.t;
    const moveEvent = this.move.update(input.t, input.move, input.headYawRate > 0.5);
    const turnEvent = this.turn.update(input.t, [input.turn, 0], false);
    if (moveEvent === "released") this.position.stop(input.t);
    this.steerYaw(input.t, input.turn, turnEvent);
    const steady = (stick: StickTracker) => input.t - stick.changedAt >= this.stickChangeMs;
    this.position.q = this.move.active
      ? (steady(this.move) ? this.q.steadyPosition : this.q.changingPosition)
      : this.q.position;
    this.yaw.q = this.turn.active
      ? (steady(this.turn) ? this.q.steadyYaw : this.q.changingYaw)
      : this.q.yaw;
  }

  add(sample: VrcOriginSample): void {
    const { pose, t } = sample;
    this.source = pose.source;
    const prev = this.lastPose;
    // Per axis: with the v1 proximity rig VRChat sometimes freezes one axis's contacts while
    // another keeps moving, so an unchanged axis in a moving sample is stale, not a measurement.
    // v2 reports each axis exactly: an unchanged axis is level (walking flat after a step), and
    // skipping it would let the velocity learned on the step run on unchecked.
    const changedAxes = pose.position.map((v, k) => !prev || v !== prev.position[k]);
    const positionChanged = changedAxes.some((changed) => changed);
    const freshAxes = pose.source === "petplay-origin-v2"
      ? changedAxes.map(() => true)
      : changedAxes;
    const yawChanged = !prev || pose.yawRad !== prev.yawRad;
    this.lastPose = pose;

    if (positionChanged && (!this.position.started || t > this.position.updatedAt)) {
      if (this.position.started) {
        const predicted = this.position.at(t, this.timing, this.move.active).values;
        const miss = Math.hypot(
          ...pose.position.map((v, k) => freshAxes[k] ? v - predicted[k] : 0),
        );
        if (miss > this.resetDistance) {
          this.position.reset();
          this.shown = null;
        } else if (
          this.move.active &&
          miss > 0.06 + (3 * ARRIVAL_SIGMA_MS / 1000) * Math.hypot(...this.position.velocity())
        ) {
          // The motion changed in a way the stick didn't show (direction follows a hand, a
          // slope, a wall): be responsive again.
          this.move.changedAt = t;
          this.position.q = this.q.changingPosition;
        }
      }
      this.position.measure(t, [...pose.position], freshAxes, ARRIVAL_SIGMA_MS);
      // Just after a release VRChat is standing still; late samples must not restart motion.
      if (this.move.releasedWithin(t, 500)) this.position.measureVelocity([0, 0, 0], 1e-4);
    }
    if (yawChanged) {
      this.rawYaw = this.rawYaw == null
        ? pose.yawRad
        : this.rawYaw + angleDiffRad(pose.yawRad, this.rawYaw);
      this.rawYawChangedAt = t;
    }
    // While the stick turns (and until the PhysBone yaw catches up), the stick drives yaw.
    if (this.stickTurn.steering) return;
    if (yawChanged && (!this.yaw.started || t > this.yaw.updatedAt)) {
      let yaw = pose.yawRad;
      if (this.yaw.started) {
        const predicted = this.yaw.at(t, this.timing, this.turn.active).values[0];
        yaw = predicted + angleDiffRad(yaw, predicted);
        if (Math.abs(yaw - predicted) > this.resetYaw) {
          this.yaw.reset();
          this.shown = null;
        }
      }
      this.yaw.measure(t, [yaw]);
      if (this.turn.releasedWithin(t, 500)) this.yaw.measureVelocity([0], 1e-4);
    }
  }

  /**
   * Smooth turning from the stick. The rig's yaw comes from PhysBones, which follow the avatar
   * with ~0.4 s of spring lag (measured: the reading kept turning ~60° after a release), while
   * VRChat turns at `gain × stick` and stops on release. So while the turn stick is held the
   * yaw is dead-reckoned from it; once the PhysBone reading settles after release, the estimate
   * takes the measured yaw and the gain learns from the whole turn.
   */
  private steerYaw(t: number, stick: number, event: "pressed" | "released" | null): void {
    const turn = this.stickTurn;
    // Dead reckoning is for v1's PhysBone yaw, which trails the avatar by ~0.4 s. v2's forward
    // sender has no lag: dead reckoning there only drifts from the measurement (measured: ~30°
    // after chained turns, held for a second at rest before the settle eased it back).
    if (
      !this.yaw.started || this.rawYaw == null || turn.disabled ||
      this.source === "petplay-origin-v2"
    ) {
      turn.cancel();
      return;
    }
    if (this.turn.active) {
      if (!turn.turning) {
        const estimate = this.yaw.at(t, this.timing).values[0];
        turn.begin(t, estimate, this.rawYaw);
      }
      const yaw = turn.advance(t, stick);
      this.yaw.set(t, [yaw], [turn.gain * stick]);
      return;
    }
    if (turn.turning || event === "released") {
      const yaw = turn.end(t);
      this.yaw.set(t, [yaw], [0]);
      return;
    }
    if (turn.correction) {
      if (t >= turn.correction[0]) {
        this.yaw.set(t, [turn.correction[1]], [0]);
        turn.correction = null;
      }
      return;
    }
    if (!turn.settling) return;
    const since = t - turn.releasedAt;
    const quiet = t - this.rawYawChangedAt;
    if (since < 300 || (quiet < 150 && since < 1000)) return;
    // Settled: ease to the reading over 400 ms (it carries the body's swing against the head,
    // so a jump would show that as a lurch).
    const estimate = this.yaw.at(t, this.timing).values[0];
    const measured = estimate + angleDiffRad(this.rawYaw, estimate);
    turn.settle(this.rawYaw);
    turn.correction = [t + 400, measured];
    this.yaw.set(t, [estimate], [((measured - estimate) * 1000) / 400]);
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
    const p = this.position.at(tMs, this.timing, this.move.active);
    const y = this.yaw.at(tMs, this.timing, this.turn.active);
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
      ? this.yaw.at(tMs, this.timing, this.turn.active).values[0]
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

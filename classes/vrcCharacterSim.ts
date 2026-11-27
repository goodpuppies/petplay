/**
 * VRChat `ClientSimPlayerController` physics simulator + critically-damped 1st-order OSC observer.
 *
 * Mirrors VRChat SDK's `ClientSimPlayerController.FixedUpdate` (ground kinematic velocity from
 * stick × learned `(forwardSpeed, strafeSpeed)` in head yaw frame, ballistic takeoff + air
 * acceleration at `RATE_OF_AIR_ACCELERATION = 5.0` clamped to `[-speed, +speed]`, gravity, and
 * VRChat's smooth-turn stick curve minus signed HMD yaw rate).
 *
 * Because ground locomotion is purely kinematic (zero inertia, zero velocity estimation from
 * noisy-timestamped OSC bursts), OSC residuals are bled in as a 1st-order exponential offset
 * (`corrTauMs`) compared against the simulator's own delayed state at `t - latencyMs`. That makes
 * overshoot and spring oscillation mathematically impossible while eliminating velocity wobble
 * across OSC burst gaps.
 */

import type { Vec3, VrcOriginWorldPose } from "./vrcOriginCodec.ts";
import type { VrcJumpParams } from "./vrcJumpModel.ts";
import { DEFAULT_VRC_WALK, type VrcWalkParams } from "./vrcWorldLocomotion.ts";

/** From VRChat SDK `ClientSimPlayerController.RATE_OF_AIR_ACCELERATION`. */
const RATE_OF_AIR_ACCELERATION = 5.0;
const STICK_DEADZONE = 0.15;

function normalizeAngleRad(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a <= 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function angleDiffRad(to: number, from: number): number {
  return normalizeAngleRad(to - from);
}

/**
 * VRChat's smooth-turn stick response curve (measured 2026-11-27): ~0.35 deadzone and quadratic
 * ramp up to full stick.
 */
export function vrcSmoothTurnCurve(stickX: number): number {
  const mag = Math.max(0, (Math.abs(stickX) - 0.35) / 0.65);
  return Math.sign(stickX) * mag * mag;
}

export interface VrcCharacterSimOptions {
  /** Expected delay (ms) between VRChat simulation time and OSC arrival (default 15). */
  latencyMs?: number;
  /** 1st-order position correction time constant (ms, default 60). */
  posCorrectionTauMs?: number;
  /** 1st-order yaw correction time constant (ms, default 45). */
  yawCorrectionTauMs?: number;
  /** Initial smooth-turn speed at full stick (rad/s, default 180°/s). */
  turnGainRadPerSec?: number;
}

export interface VrcCharacterSimState {
  pose: VrcOriginWorldPose;
  velocity: Vec3;
  yawRate: number;
}

export class VrcCharacterSim {
  private readonly latencyMs: number;
  private readonly posTauMs: number;
  private readonly yawTauMs: number;

  private pos: Vec3 = [0, 0, 0];
  /** Unwrapped Unity yaw (rad). */
  private yaw = 0;
  /** Remaining 1st-order OSC offset to bleed smoothly into `pos` / `yaw`. */
  private pendingPos: Vec3 = [0, 0, 0];
  private pendingYaw = 0;

  private started = false;
  private lastT = 0;
  private grounded = true;
  private groundY = 0;
  private velAir: Vec3 = [0, 0, 0];
  private velCur: Vec3 = [0, 0, 0];
  private yawRateCur = 0;

  /** Learned per-world walk speeds (m/s). */
  walk: VrcWalkParams = { ...DEFAULT_VRC_WALK };
  onWalkLearned: ((params: VrcWalkParams) => void) | null = null;
  private walkNotifyCounter = 0;

  /** Learned smooth-turn rate at full stick (rad/s). */
  turnGain: number;
  private turnSamples = 0;

  /** Latest controller/head inputs. */
  private move: [number, number] = [0, 0];
  private turn = 0;
  private hmdYawRate = 0;
  private jumpHeld = false;
  private jumpQueued = false;
  private movePressedAt = -Infinity;

  /** Wall-collision gate: stops forward sim only after sustained zero progress while holding stick. */
  private wallBlocked = false;
  private wallStallCount = 0;
  private lastOscPos: Vec3 | null = null;
  private lastOscYaw = 0;
  private lastOscT = 0;
  private lastPosOscT = 0;

  /** Ring buffer of simulated states so incoming OSC at `t` compares against `sim(t - latency)`. */
  private history: { t: number; pos: Vec3; yaw: number }[] = [];

  constructor(options: VrcCharacterSimOptions = {}) {
    this.latencyMs = options.latencyMs ?? 15;
    this.posTauMs = options.posCorrectionTauMs ?? 160;
    this.yawTauMs = options.yawCorrectionTauMs ?? 70;
    this.turnGain = options.turnGainRadPerSec ?? Math.PI;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  reset(): void {
    this.started = false;
    this.grounded = true;
    this.pendingPos = [0, 0, 0];
    this.pendingYaw = 0;
    this.velAir = [0, 0, 0];
    this.velCur = [0, 0, 0];
    this.yawRateCur = 0;
    this.wallBlocked = false;
    this.wallStallCount = 0;
    this.lastOscPos = null;
    this.history = [];
    this.jumpQueued = false;
  }

  private simAt(t: number): { pos: Vec3; yaw: number } | null {
    if (!this.history.length) return null;
    let lo = 0, hi = this.history.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.history[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = this.history[lo];
    const b = this.history[Math.min(lo + 1, this.history.length - 1)];
    if (a === b || b.t <= a.t) return a;
    const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    return {
      pos: [
        a.pos[0] + (b.pos[0] - a.pos[0]) * u,
        a.pos[1] + (b.pos[1] - a.pos[1]) * u,
        a.pos[2] + (b.pos[2] - a.pos[2]) * u,
      ],
      yaw: a.yaw + (b.yaw - a.yaw) * u,
    };
  }

  private desiredMoveXZ(move: [number, number], yaw: number): [number, number] {
    let sx = move[0], sy = move[1];
    const mag = Math.hypot(sx, sy);
    if (mag < STICK_DEADZONE) return [0, 0];
    if (mag > 1) {
      sx /= mag;
      sy /= mag;
    }
    const vFwd = sy * this.walk.forwardSpeed;
    const vRgt = sx * this.walk.strafeSpeed;
    // Unity left-handed yaw: forward = [sin(yaw), cos(yaw)], right = [cos(yaw), -sin(yaw)].
    return [
      vFwd * Math.sin(yaw) + vRgt * Math.cos(yaw),
      vFwd * Math.cos(yaw) - vRgt * Math.sin(yaw),
    ];
  }

  setInput(
    t: number,
    move: [number, number],
    turn: number,
    hmdYawRate: number,
    jump: boolean,
    jumpParams: VrcJumpParams,
    jumpEnabled: boolean,
  ): void {
    const prevActive = Math.hypot(this.move[0], this.move[1]) > STICK_DEADZONE;
    const nextActive = Math.hypot(move[0], move[1]) > STICK_DEADZONE;
    if (nextActive && !prevActive) this.movePressedAt = t;
    if (Math.hypot(move[0] - this.move[0], move[1] - this.move[1]) > 0.12 || (!prevActive && nextActive)) {
      this.wallBlocked = false;
      this.wallStallCount = 0;
    }
    this.move = [move[0], move[1]];
    this.turn = turn;
    this.hmdYawRate = hmdYawRate;
    if (jump && !this.jumpHeld && this.grounded && jumpEnabled && jumpParams.launchSpeed > 0.5) {
      this.jumpQueued = true;
    }
    this.jumpHeld = jump;
    this.stepTo(t, jumpParams);
  }

  stepTo(t: number, jumpParams?: VrcJumpParams): void {
    if (!this.started || t <= this.lastT) return;
    const dtMs = t - this.lastT;
    const dt = Math.min(0.05, dtMs / 1000);
    this.lastT = t;

    const launchSpeed = jumpParams?.launchSpeed ?? 2.9;
    const gravity = jumpParams?.gravity ?? 9.6;

    // 1. Yaw simulation (smooth-turn stick curve minus signed head yaw rate).
    const turnEff = Math.abs(this.turn) > STICK_DEADZONE ? vrcSmoothTurnCurve(this.turn) : 0;
    this.yawRateCur = this.turnGain * turnEff - this.hmdYawRate;
    this.yaw += this.yawRateCur * dt;

    // 2. Wall-silence check: holding stick for >180 ms with zero OSC position updates -> blocked.
    const moveActive = Math.hypot(this.move[0], this.move[1]) > STICK_DEADZONE;
    if (
      this.grounded && moveActive &&
      t - this.movePressedAt >= 180 && t - this.lastPosOscT >= 180
    ) {
      this.wallBlocked = true;
    }

    // 3. Exact ClientSimPlayerController FixedUpdate physics.
    const [desX, desZ] = this.wallBlocked ? [0, 0] : this.desiredMoveXZ(this.move, this.yaw);
    if (this.grounded) {
      if (this.jumpQueued) {
        this.grounded = false;
        this.groundY = this.pos[1];
        const takeoffX = desX !== 0 || desZ !== 0 ? desX : this.velCur[0];
        const takeoffZ = desX !== 0 || desZ !== 0 ? desZ : this.velCur[2];
        this.velAir = [takeoffX, launchSpeed, takeoffZ];
        this.jumpQueued = false;
        this.velCur = [...this.velAir];
      } else {
        this.velCur = [desX, 0, desZ];
      }
    } else {
      // Air control: RATE_OF_AIR_ACCELERATION = 5.0 clamped to [-strafe, +strafe] / [-run, +run].
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
      let locX = this.velAir[0] * cosY - this.velAir[2] * sinY;
      let locZ = this.velAir[0] * sinY + this.velAir[2] * cosY;
      locX = Math.max(-this.walk.strafeSpeed, Math.min(this.walk.strafeSpeed, locX));
      locZ = Math.max(-this.walk.forwardSpeed, Math.min(this.walk.forwardSpeed, locZ));
      const mag = Math.hypot(this.move[0], this.move[1]);
      const sx = mag > STICK_DEADZONE ? (mag > 1 ? this.move[0] / mag : this.move[0]) : 0;
      const sy = mag > STICK_DEADZONE ? (mag > 1 ? this.move[1] / mag : this.move[1]) : 0;
      const acX = Math.max(
        -this.walk.strafeSpeed - locX,
        Math.min(this.walk.strafeSpeed - locX, dt * RATE_OF_AIR_ACCELERATION * sx * this.walk.strafeSpeed),
      );
      const acZ = Math.max(
        -this.walk.forwardSpeed - locZ,
        Math.min(this.walk.forwardSpeed - locZ, dt * RATE_OF_AIR_ACCELERATION * sy * this.walk.forwardSpeed),
      );
      this.velAir[0] += acZ * sinY + acX * cosY;
      this.velAir[2] += acZ * cosY - acX * sinY;
      this.velAir[1] -= gravity * dt;
      this.velCur = [...this.velAir];
    }

    // 4. Bleed 1st-order OSC offset smoothly into pos & yaw (critically damped, zero steps/bounce).
    // Gentle while moving (avoids OSC arrival-jitter shake), crisper when stopped.
    const posTau = moveActive && !this.wallBlocked ? this.posTauMs : Math.min(this.posTauMs, 65);
    const aPos = 1 - Math.exp(-dtMs / posTau);
    const aYaw = 1 - Math.exp(-dtMs / this.yawTauMs);
    const dxC = this.pendingPos[0] * aPos;
    const dyC = this.pendingPos[1] * aPos;
    const dzC = this.pendingPos[2] * aPos;
    const dyawC = this.pendingYaw * aYaw;
    this.pendingPos[0] -= dxC;
    this.pendingPos[1] -= dyC;
    this.pendingPos[2] -= dzC;
    this.pendingYaw -= dyawC;

    this.pos[0] += this.velCur[0] * dt + dxC;
    this.pos[1] += this.velCur[1] * dt + dyC;
    this.pos[2] += this.velCur[2] * dt + dzC;
    this.yaw += dyawC;

    if (!this.grounded && this.velAir[1] < 0 && this.pos[1] <= this.groundY) {
      this.pos[1] = this.groundY;
      this.velAir = [0, 0, 0];
      this.grounded = true;
    }

    // Shift history by applied offset so delayed-state comparisons never double-count corrections.
    for (const h of this.history) {
      h.pos[0] += dxC;
      h.pos[1] += dyC;
      h.pos[2] += dzC;
      h.yaw += dyawC;
    }
    this.history.push({ t, pos: [...this.pos], yaw: this.yaw });
    if (this.history.length > 60) this.history.shift();
  }

  /** Force grounded at `y` (called when `VrcJumpModel` reports `"landed"`). */
  landAt(y: number): void {
    this.grounded = true;
    this.groundY = y;
    this.velAir = [0, 0, 0];
    this.pos[1] = y;
    this.pendingPos[1] = 0;
  }

  measure(t: number, pose: VrcOriginWorldPose, jumpParams?: VrcJumpParams): void {
    if (!this.started) {
      this.pos = [...pose.position];
      this.yaw = pose.yawRad;
      this.groundY = pose.position[1];
      this.lastT = t;
      this.started = true;
      this.lastOscPos = [...pose.position];
      this.lastOscYaw = pose.yawRad;
      this.lastOscT = t;
      this.lastPosOscT = t;
      this.history = [{ t, pos: [...this.pos], yaw: this.yaw }];
      return;
    }
    this.stepTo(t, jumpParams);

    const posChanged = !this.lastOscPos ||
      pose.position[0] !== this.lastOscPos[0] ||
      pose.position[1] !== this.lastOscPos[1] ||
      pose.position[2] !== this.lastOscPos[2];
    const yawChanged = pose.yawRad !== this.lastOscYaw;

    if (this.lastOscPos && t > this.lastOscT && t - this.lastOscT < 150) {
      const dt = (t - this.lastOscT) / 1000;
      if (posChanged) {
        const mvx = (pose.position[0] - this.lastOscPos[0]) / dt;
        const mvy = (pose.position[1] - this.lastOscPos[1]) / dt;
        const mvz = (pose.position[2] - this.lastOscPos[2]) / dt;
        const mSpdXZ = Math.hypot(mvx, mvz);
        const [desX, desZ] = this.desiredMoveXZ(this.move, pose.yawRad);
        const desSpd = Math.hypot(desX, desZ);

        // Wall-collision detection (require 3 consecutive stalled bursts so a single slow OSC
        // burst never slams the brakes) & online walk-speed learning.
        if (this.grounded && desSpd > 0.6) {
          if (t - this.movePressedAt >= 100 && (mSpdXZ < 0.25 * desSpd || mvx * desX + mvz * desZ < 0)) {
            if (++this.wallStallCount >= 3) this.wallBlocked = true;
          } else if (mSpdXZ > 0.35 * desSpd) {
            this.wallStallCount = 0;
            this.wallBlocked = false;
            const vFwd = mvx * Math.sin(pose.yawRad) + mvz * Math.cos(pose.yawRad);
            const vRgt = mvx * Math.cos(pose.yawRad) - mvz * Math.sin(pose.yawRad);
            const [sx, sy] = this.move;
            const alpha = 1 / Math.min(60, this.walk.samples + 8);
            let updated = false;
            if (Math.abs(sy) > 0.65 && Math.abs(sx) < 0.3 && vFwd * sy > 0.5) {
              const est = Math.min(15, Math.max(0.5, vFwd / sy));
              this.walk = {
                ...this.walk,
                forwardSpeed: this.walk.forwardSpeed + (est - this.walk.forwardSpeed) * alpha,
                samples: this.walk.samples + 1,
              };
              updated = true;
            } else if (Math.abs(sx) > 0.65 && Math.abs(sy) < 0.3 && vRgt * sx > 0.3) {
              const est = Math.min(15, Math.max(0.5, vRgt / sx));
              this.walk = {
                ...this.walk,
                strafeSpeed: this.walk.strafeSpeed + (est - this.walk.strafeSpeed) * alpha,
                samples: this.walk.samples + 1,
              };
              updated = true;
            }
            if (updated && ++this.walkNotifyCounter >= 10) {
              this.walkNotifyCounter = 0;
              this.onWalkLearned?.(this.walk);
            }
          }
        }
        // Detect landing on a higher/lower surface.
        if (!this.grounded && Math.abs(mvy) < 0.1 && pose.position[1] <= this.groundY + 0.04) {
          this.grounded = true;
          this.velAir = [0, 0, 0];
        }
      }
      if (yawChanged && Math.abs(this.turn) > STICK_DEADZONE) {
        const turnEff = vrcSmoothTurnCurve(this.turn);
        if (Math.abs(turnEff) > 0.35) {
          const avRate = angleDiffRad(pose.yawRad, this.lastOscYaw) / dt;
          const playRate = avRate + this.hmdYawRate;
          const est = playRate / turnEff;
          if (est > 0.5 && est < 8) {
            const alpha = 1 / Math.min(30, ++this.turnSamples + 4);
            this.turnGain += (est - this.turnGain) * alpha;
          }
        }
      }
    }

    if (posChanged) {
      this.lastOscPos = [...pose.position];
      this.lastPosOscT = t;
    }
    if (yawChanged) this.lastOscYaw = pose.yawRad;
    this.lastOscT = t;

    // 1st-order delayed-state observer update.
    const ref = this.simAt(t - this.latencyMs) ?? { pos: this.pos, yaw: this.yaw };
    if (posChanged) {
      const rx = pose.position[0] - ref.pos[0];
      const ry = pose.position[1] - ref.pos[1];
      const rz = pose.position[2] - ref.pos[2];
      if (Math.hypot(rx, ry, rz) > 1.0) {
        // Teleport: snap cleanly.
        this.pos = [...pose.position];
        this.pendingPos = [0, 0, 0];
        this.velAir = [0, 0, 0];
        this.grounded = true;
        this.groundY = pose.position[1];
        this.history = [{ t, pos: [...this.pos], yaw: this.yaw }];
      } else {
        this.pendingPos = [rx, ry, rz];
      }
    }
    if (yawChanged) {
      // OSC avatar yaw has ~0 ms lag relative to unpredicted HMD yaw, so compare at `t` (not `t - latencyMs`).
      const ryaw = angleDiffRad(pose.yawRad, this.yaw);
      if (Math.abs(ryaw) > (25 * Math.PI) / 180) {
        this.yaw = this.yaw + ryaw;
        this.pendingYaw = 0;
        for (const h of this.history) h.yaw = this.yaw;
      } else {
        this.pendingYaw = ryaw;
      }
    }
  }

  evaluate(t: number, source: VrcOriginWorldPose["source"], jumpParams?: VrcJumpParams): VrcCharacterSimState {
    this.stepTo(t, jumpParams);
    return {
      pose: {
        source,
        position: [this.pos[0], this.pos[1], this.pos[2]],
        yawRad: normalizeAngleRad(this.yaw),
      },
      velocity: [this.velCur[0], this.velCur[1], this.velCur[2]],
      yawRate: this.yawRateCur,
    };
  }
}

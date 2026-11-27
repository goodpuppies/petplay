/**
 * VRChat jumps, predicted from the jump press and learned per world.
 *
 * A VRChat jump is ballistic: the root leaves the ground at the world's jump impulse and falls at
 * its gravity, so once the press is seen the whole arc is known. Measured on a default world
 * (2026-11-27, 13 jumps): launch 2.9 m/s, gravity 9.6 m/s², apex 0.437 ± 0.005 m, flight
 * 0.60 ± 0.01 s, takeoff within ±15 ms of the press in OSC arrival time. A constant-velocity filter
 * lags the takeoff and overshoots the apex and the landing; the arc does not.
 *
 * Times are OSC arrival times (epoch ms), the convention `VrcRootPredictor` measures in: the
 * press reaches PetPlay about as late as the samples showing the takeoff, so `delayMs` is ~0.
 */

export interface VrcJumpParams {
  /** Take-off speed (m/s). */
  launchSpeed: number;
  /** Gravity (m/s², positive). */
  gravity: number;
  /** Takeoff after the press, in arrival time (ms). */
  delayMs: number;
  /** Jumps learned from. */
  jumps: number;
  /** Presses in a row that never left the ground (a world without jumping). */
  misses: number;
}

/** VRChat's defaults (jump impulse 3, Unity gravity), as measured. */
export const DEFAULT_VRC_JUMP: VrcJumpParams = {
  launchSpeed: 2.9,
  gravity: 9.6,
  delayMs: 0,
  jumps: 0,
  misses: 0,
};

/** Presses in a row without a takeoff before presses stop predicting arcs. */
const MISSES_TO_DISABLE = 3;
/** Most jumps the running average weighs (later jumps keep adapting). */
const LEARN_WINDOW = 20;
/** Measured height off the arc by more than this, twice in a row, abandons it (a ledge, a wall). */
const ABANDON_METERS = 0.1;
/** How fast measurements pull the arc's offset (per sample). */
const OFFSET_GAIN = 0.3;
/**
 * No rise this long after the takeoff time abandons the arc. VRChat sends nothing while the root
 * stays put, so a press that jumps nowhere shows only as silence.
 */
const LIFTOFF_TIMEOUT_MS = 120;

export type JumpArcEvent = "landed" | "abandoned" | null;

interface Arc {
  /** Takeoff (arrival ms). */
  t0: number;
  ground: number;
  launchSpeed: number;
  gravity: number;
  /** Measured minus model, smoothed. */
  offset: number;
  pressAt: number;
  /** Measured `[t, y]` during the arc, for learning. */
  samples: [number, number][];
  offArc: number;
  liftedOff: boolean;
  /**
   * Only watched, not predicted: jumping looked disabled here (to notice it working again), or
   * the jump left the arc (to learn from it once it lands).
   */
  silent: boolean;
  lastSampleAt: number;
  lastYChangedAt: number;
  lastY: number;
}

/** A watched jump has ended once its samples stop this long (VRChat goes quiet at rest). */
const WATCH_QUIET_MS = 300;
/** No jump lasts longer. */
const ARC_TIMEOUT_MS = 5000;

export class VrcJumpModel {
  params: VrcJumpParams;
  private arc: Arc | null = null;
  /** Called when a finished jump changed `params` (to persist them). */
  onLearned: ((params: VrcJumpParams) => void) | null = null;

  constructor(params: VrcJumpParams = DEFAULT_VRC_JUMP) {
    this.params = { ...params };
  }

  get active(): boolean {
    return this.arc != null;
  }

  get enabled(): boolean {
    return this.params.misses < MISSES_TO_DISABLE;
  }

  /** Flight time of the current arc (ms). */
  private flightMs(arc: Arc): number {
    return (2 * arc.launchSpeed / arc.gravity) * 1000;
  }

  /** The press at `t` with the root at `groundY`. Ignored mid-arc (VRChat has no double jump). */
  press(t: number, groundY: number): void {
    if (this.arc) return;
    this.arc = {
      t0: t + this.params.delayMs,
      ground: groundY,
      launchSpeed: this.params.launchSpeed,
      gravity: this.params.gravity,
      offset: 0,
      pressAt: t,
      samples: [],
      offArc: 0,
      liftedOff: false,
      silent: !this.enabled,
      lastSampleAt: 0,
      lastYChangedAt: t,
      lastY: groundY,
    };
  }

  /** The arc's height and vertical speed at `t`, offset included. */
  private evaluate(arc: Arc, t: number): { y: number; vy: number } {
    const flight = this.flightMs(arc) / 1000;
    const tau = Math.min(Math.max(0, (t - arc.t0) / 1000), flight);
    const airborne = t > arc.t0 && tau < flight;
    return {
      y: arc.ground + arc.offset + arc.launchSpeed * tau - 0.5 * arc.gravity * tau * tau,
      vy: airborne ? arc.launchSpeed - arc.gravity * tau : 0,
    };
  }

  /** Height and vertical speed of the arc at `t`, or null when no arc is running. */
  at(t: number): { y: number; vy: number } | null {
    const arc = this.arc;
    return arc && !arc.silent ? this.evaluate(arc, t) : null;
  }

  /** A measured root height at `t`. `"abandoned"`: stop showing the arc. */
  measure(t: number, y: number): JumpArcEvent {
    const arc = this.arc;
    if (!arc) return null;
    if (y > arc.ground + 0.02) arc.liftedOff = true;
    if (Math.abs(y - arc.lastY) > 0.005) arc.lastYChangedAt = t;
    arc.samples.push([t, y]);
    arc.lastSampleAt = t;
    arc.lastY = y;
    if (arc.silent) {
      if (arc.liftedOff && y <= arc.ground + 0.01) this.finish(arc, true);
      return null;
    }
    const model = this.evaluate(arc, t).y - arc.offset;
    const residual = y - model;
    if (Math.abs(residual - arc.offset) > ABANDON_METERS) {
      if (++arc.offArc >= 2) {
        if (!arc.liftedOff) return this.miss(arc);
        // A different jump than learned (another world) or a ledge: watch it to the landing.
        arc.silent = true;
        return "abandoned";
      }
    } else {
      arc.offArc = 0;
      arc.offset += (residual - arc.offset) * OFFSET_GAIN;
    }
    return null;
  }

  /** Advance to `t`: the arc ends at its landing. */
  update(t: number): JumpArcEvent {
    const arc = this.arc;
    if (!arc) return null;
    if (!arc.liftedOff && t > arc.t0 + LIFTOFF_TIMEOUT_MS) return this.miss(arc);
    if (arc.silent) {
      const quiet = arc.lastSampleAt > 0 && t - arc.lastYChangedAt > WATCH_QUIET_MS;
      if (quiet || t > arc.t0 + ARC_TIMEOUT_MS) {
        // Landed back where it left: a jump to learn from; anywhere else (a ledge) teaches nothing.
        this.finish(arc, Math.abs(arc.lastY - arc.ground) < 0.03);
      }
      return null;
    }
    if (arc.liftedOff) {
      const pred = this.evaluate(arc, t);
      // Landing on a higher ledge stops OSC Y updates (VRChat only sends changes): if the arc is
      // descending below the last measured Y with no Y change for >45 ms, land on the ledge.
      if (pred.vy < -0.2 && arc.lastY - pred.y > 0.03 && t - arc.lastYChangedAt > 45) {
        this.landedAt = arc.lastY;
        this.finish(arc, false);
        return "landed";
      }
    }
    if (t < arc.t0 + this.flightMs(arc)) return null;
    if (arc.lastY > arc.ground + 0.05) {
      if (t - arc.lastYChangedAt > 45) {
        this.landedAt = arc.lastY;
        this.finish(arc, false);
        return "landed";
      }
      // Still in the air: longer than learned. Watch it down.
      arc.silent = true;
      return "abandoned";
    }
    this.landedAt = arc.ground + arc.offset;
    this.finish(arc, true);
    return "landed";
  }

  /** Where the last `"landed"` put the root (ground plus the measured offset). */
  landedAt: number | null = null;

  private finish(arc: Arc, learn: boolean): void {
    this.arc = null;
    if (learn) this.learn(arc);
  }

  /** The press jumped nowhere (no jumping here, or VRChat didn't take it). */
  private miss(arc: Arc): JumpArcEvent {
    this.arc = null;
    this.params = { ...this.params, misses: this.params.misses + 1 };
    this.onLearned?.(this.params);
    return arc.silent ? null : "abandoned";
  }

  cancel(): void {
    this.arc = null;
  }

  /** Fit the arc's samples and blend the result into `params`. */
  private learn(arc: Arc): void {
    const air = arc.samples.filter(([, y]) => y > arc.ground + 0.01);
    if (air.length < 5) return;
    const fit = fitJump(air, arc.ground);
    if (!fit) return;
    const { launchSpeed, gravity, takeoff } = fit;
    // Implausible fits (a ledge, a bounce pad) teach nothing.
    if (!(gravity > 1 && gravity < 40 && launchSpeed > 0.5 && launchSpeed < 20)) return;
    const p = this.params;
    const n = Math.min(p.jumps, LEARN_WINDOW - 1);
    const blend = (old: number, value: number) => (old * n + value) / (n + 1);
    this.params = {
      launchSpeed: blend(p.launchSpeed, launchSpeed),
      gravity: blend(p.gravity, gravity),
      delayMs: blend(p.delayMs, Math.max(-100, Math.min(200, takeoff - arc.pressAt))),
      jumps: p.jumps + 1,
      misses: 0,
    };
    this.onLearned?.(this.params);
  }
}

/**
 * Least-squares parabola through airborne samples `[t ms, y]` above `ground`: the takeoff time
 * (where it leaves `ground`), launch speed and gravity.
 */
export function fitJump(
  samples: [number, number][],
  ground: number,
): { launchSpeed: number; gravity: number; takeoff: number } | null {
  if (samples.length < 3) return null;
  const t0 = samples[0][0];
  const s = [0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (const [t, y] of samples) {
    const u = (t - t0) / 1000;
    for (let i = 0; i < 5; i++) s[i] += u ** i;
    r[0] += y;
    r[1] += u * y;
    r[2] += u * u * y;
  }
  const m = [[s[0], s[1], s[2]], [s[1], s[2], s[3]], [s[2], s[3], s[4]]];
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const [a, b, c] = [0, 1, 2].map((k) =>
    det(m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / d
  );
  if (!(c < 0)) return null;
  const disc = b * b - 4 * c * (a - ground);
  if (disc < 0) return null;
  // The earlier root (c < 0 flips the order).
  const uTake = (-b + Math.sqrt(disc)) / (2 * c);
  return { launchSpeed: b + 2 * c * uTake, gravity: -2 * c, takeoff: t0 + uTake * 1000 };
}

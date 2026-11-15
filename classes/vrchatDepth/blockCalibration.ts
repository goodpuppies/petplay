/**
 * Chooses the depth block's colour calibration (`format.ts`) from how well it decodes, so worlds
 * whose post-processing mixes colour channels still work (`markdown/vrchat-depth/README.md`).
 *
 * - 1D (per-channel ramps) is the default: cheapest to decode, most depth bits per cell.
 * - When most decodes in a window are corrupt (checksum, calibration, preamble, torn) while the
 *   block is found, switch to 3D calibration, which absorbs any colour transform (`MODE_LAYOUT`).
 * - A new world starts again in 1D: its post-processing may be clean.
 * - After every switch, wait for the avatar to apply it (VRChat took 10–15 s in the lab).
 *
 * Pure: the intake feeds it cumulative counters and sends the parameters it asks for.
 */

export type CalibrationMode = "1d" | "3d";
export type CalibrationPolicy = "auto" | CalibrationMode;

/**
 * Block tunables per mode (`blockLayout.ts`). Depth takes one cell per sample whatever the bits
 * (format v4), so bits buy depth precision, not block size: 1D at 6 bits (18-bit log depth) keeps
 * four byte values between levels; 3D at 4 bits (12-bit log depth, 0.24 % steps) with levels inset
 * to 16..223, out of the highlight roll-off and the saturated corners where the Avatar Testing
 * Chamber's grade collapses colours (margin 2 at full range, 8.8 inset; README).
 */
export const MODE_LAYOUT: Record<CalibrationMode, { bits: number; calibration3D: number; levelInset: number }> = {
  "1d": { bits: 6, calibration3D: 0, levelInset: 0 },
  "3d": { bits: 4, calibration3D: 1, levelInset: 16 },
};

const CORRUPT = ["bad-checksum", "bad-calibration", "bad-preamble", "bad-magic", "torn"];

export type CalibrationStatus = {
  policy: CalibrationPolicy;
  mode: CalibrationMode;
  reason: string;
  switchedAt: number;
  settling: boolean;
  /** Over the judging window: decoded frames and corrupt decodes. */
  recent: { decoded: number; corrupt: number };
};

export class BlockCalibration {
  policy: CalibrationPolicy = "auto";
  mode: CalibrationMode = "1d";
  reason = "start";
  switchedAt = -Infinity;
  private samples: { at: number; decoded: number; corrupt: number }[] = [];

  constructor(
    public settleMs = 15_000,
    public windowMs = 5_000,
    /** Corrupt decodes in the window needed before switching. */
    public minCorrupt = 5,
  ) {}

  /** The mode to apply now (the policy's fixed mode, or the current automatic choice). */
  setPolicy(policy: CalibrationPolicy, now: number): CalibrationMode {
    this.policy = policy;
    if (policy !== "auto") return this.switchTo(policy, `policy ${policy}`, now);
    return this.mode;
  }

  /** A new world: try the full-rate mode again. Returns the mode to apply, or null. */
  worldChanged(now: number): CalibrationMode | null {
    if (this.policy !== "auto" || this.mode === "1d") return null;
    return this.switchTo("1d", "new world", now);
  }

  /**
   * Cumulative counters from the decoder. Returns a mode to apply when it should change.
   */
  observe(now: number, decoded: number, failures: Record<string, number>): CalibrationMode | null {
    const corrupt = CORRUPT.reduce((sum, key) => sum + (failures[key] ?? 0), 0);
    const last = this.samples.at(-1);
    // Counters restart when the decoder changes (the debug view taking over the capture): start
    // the window again rather than read a negative difference.
    if (last && (decoded < last.decoded || corrupt < last.corrupt)) this.samples = [];
    this.samples.push({ at: now, decoded, corrupt });
    while (this.samples.length > 1 && now - this.samples[1].at >= this.windowMs) {
      this.samples.shift();
    }
    if (this.policy !== "auto" || this.settling(now)) return null;
    const { decoded: good, corrupt: bad } = this.recent();
    if (this.mode === "1d" && bad >= this.minCorrupt && good <= bad) {
      return this.switchTo("3d", `${bad} corrupt vs ${good} clean decodes in 1D`, now);
    }
    return null;
  }

  status(now: number): CalibrationStatus {
    return {
      policy: this.policy,
      mode: this.mode,
      reason: this.reason,
      switchedAt: this.switchedAt,
      settling: this.settling(now),
      recent: this.recent(),
    };
  }

  private settling(now: number): boolean {
    return now - this.switchedAt < this.settleMs;
  }

  private recent() {
    const first = this.samples[0], last = this.samples.at(-1);
    // Only counts after the switch settled describe the current mode.
    if (!first || !last || first.at < this.switchedAt + this.settleMs) {
      return { decoded: 0, corrupt: 0 };
    }
    return { decoded: last.decoded - first.decoded, corrupt: last.corrupt - first.corrupt };
  }

  private switchTo(mode: CalibrationMode, reason: string, now: number): CalibrationMode {
    this.mode = mode;
    this.reason = reason;
    this.switchedAt = now;
    this.samples = [];
    return mode;
  }
}

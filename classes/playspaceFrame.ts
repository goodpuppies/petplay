/**
 * PetPlay's tracking frame, so a playspace drag moves the game world but not PetPlay.
 *
 * Every app normally reads and places things in SteamVR's Standing universe, which is defined by the
 * live standing zero pose (`IVRChaperoneSetup`). Space move rewrites that pose, so the game world
 * follows the hand. PetPlay instead works in raw tracking space anchored to the standing zero pose
 * captured once at attach: `P_petplay = Z0⁻¹ · P_raw`. Until someone moves the playspace this equals
 * Standing exactly; afterwards PetPlay's content stays physically with the user.
 *
 * The frame is per worker. While it is inactive (no chaperone interface, `--novr`, other
 * processes) everything reads and writes Standing as before. Matrices are column-major 4×4
 * (Three.js `Matrix4.elements`) unless named rows.
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

/** Row-major 3×4 rows as OpenVR's `HmdMatrix34_t.m`. */
export type Rows34 = number[][];

class PlayspaceFrame {
  /** `Z0`: PetPlay frame → raw tracking. */
  readonly petplayToRaw = identity();
  /** `Z0⁻¹`: raw tracking → PetPlay frame. */
  readonly rawToPetplay = identity();
  /**
   * `Z0⁻¹ · Z`: today's Standing → PetPlay frame, for inputs that stay in Standing on purpose
   * (VRChat's origin follows the game world). Identity until the playspace moves.
   */
  readonly standingToPetplay = identity();
  private isActive = false;
  private readonly standingListeners = new Set<() => void>();
  private readonly anchorListeners = new Set<(anchor: Float32Array | null) => void>();

  get active(): boolean {
    return this.isActive;
  }

  /** The universe PetPlay reads poses from and writes overlay transforms in. */
  get universe(): OpenVR.TrackingUniverseOrigin {
    return this.isActive
      ? OpenVR.TrackingUniverseOrigin.TrackingUniverseRawAndUncalibrated
      : OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding;
  }

  /** Anchor the frame at a standing zero pose (column-major); `null` falls back to Standing. */
  setAnchor(standingZeroToRaw: ArrayLike<number> | null): void {
    this.standingToPetplay.set(identity());
    if (standingZeroToRaw == null) {
      this.petplayToRaw.set(identity());
      this.rawToPetplay.set(identity());
      this.isActive = false;
    } else {
      this.petplayToRaw.set(standingZeroToRaw);
      invertRigid(this.petplayToRaw, this.rawToPetplay);
      this.isActive = true;
    }
    this.notifyStanding();
    const anchor = this.isActive ? this.petplayToRaw : null;
    for (const listener of this.anchorListeners) listener(anchor);
  }

  /** Called whenever {@link setAnchor} updates the PetPlay frame anchor. Returns an unsubscribe. */
  onAnchorChange(listener: (anchor: Float32Array | null) => void): () => void {
    this.anchorListeners.add(listener);
    return () => this.anchorListeners.delete(listener);
  }

  /** The live standing zero pose `Z` changed (a drag or reset). */
  setStandingZeroPose(standingZeroToRaw: ArrayLike<number>): void {
    if (!this.isActive) return;
    multiply(this.rawToPetplay, standingZeroToRaw, this.standingToPetplay);
    this.notifyStanding();
  }

  /** Called whenever {@link standingToPetplay} changes. Returns an unsubscribe. */
  onStandingChange(listener: () => void): () => void {
    this.standingListeners.add(listener);
    return () => this.standingListeners.delete(listener);
  }

  private notifyStanding(): void {
    for (const listener of this.standingListeners) listener();
  }

  /** Standing-universe pose rows → PetPlay frame, in place. */
  poseRowsFromStanding(rows: Rows34): void {
    if (this.isActive) leftMultiplyRows(this.standingToPetplay, rows);
  }

  /** Raw-universe pose rows → PetPlay frame, in place. No-op while inactive. */
  poseRowsFromRaw(rows: Rows34): void {
    if (this.isActive) leftMultiplyRows(this.rawToPetplay, rows);
  }

  /** PetPlay-frame pose rows → the universe {@link universe} names, in place. */
  poseRowsToUniverse(rows: Rows34): void {
    if (this.isActive) leftMultiplyRows(this.petplayToRaw, rows);
  }

  /**
   * A row-major 3×4 view matrix (PetPlay frame → eye), as `SetOverlayTransformProjection` takes,
   * rewritten to take the {@link universe} instead, in place.
   */
  viewRows34ToUniverse(view: Float32Array): void {
    if (!this.isActive) return;
    const a = this.rawToPetplay;
    for (let row = 0; row < 3; row++) {
      const o = row * 4;
      const v0 = view[o], v1 = view[o + 1], v2 = view[o + 2], v3 = view[o + 3];
      view[o] = v0 * a[0] + v1 * a[1] + v2 * a[2];
      view[o + 1] = v0 * a[4] + v1 * a[5] + v2 * a[6];
      view[o + 2] = v0 * a[8] + v1 * a[9] + v2 * a[10];
      view[o + 3] = v0 * a[12] + v1 * a[13] + v2 * a[14] + v3;
    }
  }
}

export const playspaceFrame = new PlayspaceFrame();

export function identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** OpenVR 3×4 rows → column-major 4×4. */
export function columnMajorFromRows(
  rows: Rows34,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) out[col * 4 + row] = rows[row][col];
  }
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
  return out;
}

/** Column-major 4×4 → OpenVR 3×4 rows. */
export function rowsFromColumnMajor(m: ArrayLike<number>): Rows34 {
  return [0, 1, 2].map((row) => [0, 1, 2, 3].map((col) => m[col * 4 + row]));
}

/** `a · b`, both column-major. */
export function multiply(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  const r = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

/** Inverse of a rotation + translation, column-major. */
export function invertRigid(
  m: ArrayLike<number>,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r01 = m[4], r11 = m[5], r21 = m[6];
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = r00;
  out[1] = r01;
  out[2] = r02;
  out[3] = 0;
  out[4] = r10;
  out[5] = r11;
  out[6] = r12;
  out[7] = 0;
  out[8] = r20;
  out[9] = r21;
  out[10] = r22;
  out[11] = 0;
  out[12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[14] = -(r02 * tx + r12 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/** `rows ← a · rows` for a column-major `a`, in place. */
function leftMultiplyRows(a: ArrayLike<number>, rows: Rows34): void {
  for (let col = 0; col < 4; col++) {
    const x = rows[0][col], y = rows[1][col], z = rows[2][col];
    const w = col === 3 ? 1 : 0;
    rows[0][col] = a[0] * x + a[4] * y + a[8] * z + a[12] * w;
    rows[1][col] = a[1] * x + a[5] * y + a[9] * z + a[13] * w;
    rows[2][col] = a[2] * x + a[6] * y + a[10] * z + a[14] * w;
  }
}

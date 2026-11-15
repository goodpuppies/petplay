/**
 * From a decoded depth block (`format.ts`) to PetPlay's tracking space. Plan:
 * `markdown/vrchat-depth/README.md`.
 *
 * Unity's world is left-handed (z forward); PetPlay, three.js and OpenVR are right-handed with
 * the view looking down −z. Mirroring z (`S = diag(1, 1, −1)`) converts between them:
 *
 * - `viewToWorld` (`UNITY_MATRIX_I_V`) maps Unity's right-handed view space to the left-handed
 *   world, so the camera's right-handed world pose is `S · I_V`.
 * - `anchorToWorld` maps a left-handed object frame (+z forward) to the world, so its
 *   right-handed pose is `S · A · S`, which looks down −z like a headset.
 *
 * The anchor is the wearer's viewpoint (the avatar builder places it there), the point VRChat
 * keeps at the headset's centre eye. With the headset's tracking pose at the same moment, that
 * gives VRChat world → tracking: a rotation about +y plus a translation, the same form
 * `VrcCameraCalibration` holds.
 */
import type { DepthFrameHeader } from "./format.ts";
import type { Quat, TrackedPose, Vec3 } from "../vrcCameraCalibration.ts";

/** Row-major 3x3 rotation to an XYZW quaternion (Shepperd's method). */
export function matrixToQuat(m: readonly number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** The rotation part of a row-major 3x4, each column normalized (drops any scale). */
function rotationOf(m: readonly number[]): number[] {
  const out = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  for (let c = 0; c < 3; c++) {
    const n = Math.hypot(out[c], out[3 + c], out[6 + c]) || 1;
    for (let r = 0; r < 3; r++) out[r * 3 + c] /= n;
  }
  return out;
}

/** VRChat's camera (the block's view) as a right-handed world pose looking down −z. */
export function cameraWorldPose(header: DepthFrameHeader): TrackedPose {
  const m = header.viewToWorld;
  const r = rotationOf(m);
  // S · R: negate row 2.
  r[6] = -r[6], r[7] = -r[7], r[8] = -r[8];
  return { position: [m[3], m[7], -m[11]], quaternion: matrixToQuat(r) };
}

/** The wearer's viewpoint as a right-handed world pose looking down −z. */
export function headWorldPose(header: DepthFrameHeader): TrackedPose {
  const m = header.anchorToWorld;
  const r = rotationOf(m);
  // S · R · S: negate row 2 and column 2; (2, 2) is negated twice.
  r[2] = -r[2], r[5] = -r[5], r[6] = -r[6], r[7] = -r[7];
  return { position: [m[3], m[7], -m[11]], quaternion: matrixToQuat(r) };
}

/** Vertical field of view of the block's view, degrees. */
export function fovYDeg(header: DepthFrameHeader): number {
  return 2 * Math.atan(1 / Math.abs(header.projection.m11)) * 180 / Math.PI;
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const p = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), quatConjugate(q));
  return [p[0], p[1], p[2]];
}

function yawRotate(v: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/**
 * World → tracking: `p_track = scale · R(yawRad) · p_world + translation`, R about +y. `scale` is
 * tracking metres per VRChat world metre: the inverse of VRChat's playspace scale
 * (`vrchatScale.ts`), 1 when the avatar's eye height matches the wearer's.
 */
export type WorldToTracking = { yawRad: number; scale: number; translation: Vec3 };

export type HeadAlignment = WorldToTracking & {
  /**
   * The rotation between the two heads that a yaw can't explain, degrees: 0 when VRChat's head
   * matches the headset's pitch and roll. A large value means a wrong pairing or a wrong anchor.
   */
  tiltDeg: number;
};

/**
 * World → tracking that puts VRChat's head (`head`, world) onto the headset (`hmd`, tracking).
 * Yaw only: VRChat's world and the playspace share +y.
 */
export function alignHead(head: TrackedPose, hmd: TrackedPose, scale = 1): HeadAlignment {
  // hmd = Q · head, so Q = hmd · head⁻¹; its twist about +y is the yaw.
  const q = quatMul(hmd.quaternion, quatConjugate(head.quaternion));
  const yawRad = 2 * Math.atan2(q[1], q[3]);
  const twist: Quat = [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)];
  const swing = quatMul(q, quatConjugate(twist));
  const tiltDeg = 2 * Math.acos(Math.min(1, Math.abs(swing[3]))) * 180 / Math.PI;
  const rotated = yawRotate(head.position, yawRad);
  return {
    yawRad: normalizeAngle(yawRad),
    scale,
    translation: [
      hmd.position[0] - scale * rotated[0],
      hmd.position[1] - scale * rotated[1],
      hmd.position[2] - scale * rotated[2],
    ],
    tiltDeg,
  };
}

export function applyWorldToTracking(t: WorldToTracking, pose: TrackedPose): TrackedPose {
  const p = yawRotate(pose.position, t.yawRad);
  return {
    position: [
      t.scale * p[0] + t.translation[0],
      t.scale * p[1] + t.translation[1],
      t.scale * p[2] + t.translation[2],
    ],
    quaternion: quatMul([0, Math.sin(t.yawRad / 2), 0, Math.cos(t.yawRad / 2)], pose.quaternion),
  };
}

export function normalizeAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Smooths successive alignments: small changes are averaged (frame pairing jitter), large ones
 * (locomotion, a teleport, a new world) are taken at once.
 */
export class AlignmentFilter {
  private current: WorldToTracking | null = null;
  constructor(
    private readonly alpha = 0.25,
    private readonly snapMeters = 0.05,
    private readonly snapRad = 2 * Math.PI / 180,
  ) {}

  push(next: WorldToTracking): WorldToTracking {
    const c = this.current;
    if (
      c == null ||
      Math.hypot(
          next.translation[0] - c.translation[0],
          next.translation[1] - c.translation[1],
          next.translation[2] - c.translation[2],
        ) > this.snapMeters ||
      Math.abs(normalizeAngle(next.yawRad - c.yawRad)) > this.snapRad ||
      next.scale !== c.scale
    ) {
      this.current = { yawRad: next.yawRad, scale: next.scale, translation: [...next.translation] };
      return this.current;
    }
    const a = this.alpha;
    this.current = {
      yawRad: normalizeAngle(c.yawRad + a * normalizeAngle(next.yawRad - c.yawRad)),
      scale: c.scale,
      translation: [
        c.translation[0] + a * (next.translation[0] - c.translation[0]),
        c.translation[1] + a * (next.translation[1] - c.translation[1]),
        c.translation[2] + a * (next.translation[2] - c.translation[2]),
      ],
    };
    return this.current;
  }

  get(): WorldToTracking | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }
}

/**
 * The depth samples as points in the view's own right-handed space (−z forward), row-major from
 * the top-left of the image like `DepthFrame.depth`. Samples without depth give NaN.
 *
 * A projection flipped for render-to-texture (`m11 < 0`) has its whole second row negated, so the
 * true `m12` is `m12 · sign(m11)`.
 */
export function unprojectDepth(
  depth: Float32Array,
  width: number,
  height: number,
  projection: DepthFrameHeader["projection"],
  out = new Float32Array(width * height * 3),
): Float32Array {
  const m00 = projection.m00, m02 = projection.m02;
  const m11 = Math.abs(projection.m11);
  const m12 = projection.m12 * Math.sign(projection.m11 || 1);
  for (let j = 0; j < height; j++) {
    const ndcY = 1 - 2 * (j + 0.5) / height;
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      const d = depth[k];
      if (!(d > 0)) {
        out[k * 3] = out[k * 3 + 1] = out[k * 3 + 2] = NaN;
        continue;
      }
      const ndcX = 2 * (i + 0.5) / width - 1;
      out[k * 3] = (ndcX - m02) * d / m00;
      out[k * 3 + 1] = (ndcY - m12) * d / m11;
      out[k * 3 + 2] = -d;
    }
  }
  return out;
}

/** Nearest-sample downscale of a depth image (keeps real depths; no blending across edges). */
export function downsampleDepth(
  depth: Float32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const out = new Float32Array(outWidth * outHeight);
  for (let j = 0; j < outHeight; j++) {
    const sy = Math.min(height - 1, Math.floor((j + 0.5) * height / outHeight));
    for (let i = 0; i < outWidth; i++) {
      const sx = Math.min(width - 1, Math.floor((i + 0.5) * width / outWidth));
      out[j * outWidth + i] = depth[sy * width + sx];
    }
  }
  return out;
}

/** Recent headset poses, so a depth block can pair with the pose from when VRChat rendered it. */
export class PoseHistory {
  private readonly times: number[] = [];
  private readonly poses: TrackedPose[] = [];
  constructor(private readonly keepMs = 1000) {}

  push(at: number, pose: TrackedPose): void {
    this.times.push(at);
    this.poses.push(pose);
    while (this.times.length && at - this.times[0] > this.keepMs) {
      this.times.shift();
      this.poses.shift();
    }
  }

  /** The recorded pose nearest `at`, or null if none is within `toleranceMs`. */
  at(at: number, toleranceMs = 50): TrackedPose | null {
    let best = -1;
    let bestGap = Infinity;
    for (let i = this.times.length - 1; i >= 0; i--) {
      const gap = Math.abs(this.times[i] - at);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      } else if (this.times[i] < at) break;
    }
    return best >= 0 && bestGap <= toleranceMs ? this.poses[best] : null;
  }

  /** Head speed around `at`: metres and degrees per second over `spanMs`. */
  speed(at: number, spanMs = 100): { metersPerSecond: number; degreesPerSecond: number } | null {
    const a = this.at(at - spanMs / 2), b = this.at(at + spanMs / 2);
    if (!a || !b) return null;
    const dot = Math.abs(
      a.quaternion[0] * b.quaternion[0] + a.quaternion[1] * b.quaternion[1] +
        a.quaternion[2] * b.quaternion[2] + a.quaternion[3] * b.quaternion[3],
    );
    const seconds = spanMs / 1000;
    return {
      metersPerSecond: Math.hypot(
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
        a.position[2] - b.position[2],
      ) / seconds,
      degreesPerSecond: 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI / seconds,
    };
  }
}

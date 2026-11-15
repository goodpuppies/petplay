/**
 * VRChat's lighting at the wearer, for lighting PetPlay's own objects to match the world
 * (`markdown/vrchat-depth/README.md`, "Lighting"). The depth block's lighting record (`format.ts`
 * `LIGHTING`) carries Unity's probe SH and main light as the avatar's renderer saw them; this turns
 * them, with the block's world → tracking alignment, into the raylib lighting shader's environment
 * uniforms (`webxrRaythreeRaylibRenderer.ts`).
 *
 * The SH stay in Unity's own form (`unity_SHAr..SHC`, world space, left-handed): the shader turns
 * a tracking-space normal into Unity's world frame with `trackingToUnity` and evaluates `ShadeSH9`
 * exactly, so the L2 band needs no rotation. Colours are linear, as Unity gives them.
 *
 * One store per process: the webxr worker sets it from `VRCDEPTHFRAME`, the desktop debug view
 * from its own frames; each renderer in that process reads it every frame.
 */
import { LIGHTING } from "./format.ts";
import type { WorldToTracking } from "./sync.ts";
import { lightVolumeCache } from "./lightVolumes.ts";

export type EnvironmentLighting = {
  /** unity_SHAr, SHAg, SHAb: (L1 x, y, z, L0) per colour. */
  shA: [number[], number[], number[]];
  /** unity_SHBr, SHBg, SHBb: the L2 terms in xy, yz, zz, zx. */
  shB: [number[], number[], number[]];
  /** unity_SHC.rgb: the x² − y² term. */
  shC: number[];
  /** Towards the main directional light, Unity world; null without one. */
  mainDirection: number[] | null;
  /** _LightColor0: linear colour times intensity. */
  mainColor: number[];
  /** Column-major 3x3: tracking-space direction → Unity world direction. */
  trackingToUnity: number[];
  /**
   * Tracking position → Unity world: `trackingToUnity · (p − trackingOrigin) / trackingScale`
   * (the alignment's translation and scale).
   */
  trackingOrigin: number[];
  trackingScale: number;
  /**
   * Unity's four per-vertex point lights as `Shade4PointLights` takes them, Unity world:
   * unity_4LightPosX0, Y0, Z0, unity_4LightAtten0, and unity_LightColor[0..3].rgb (black = unused).
   */
  vertexLights: { x: number[]; y: number[]; z: number[]; atten: number[]; colors: number[][] };
  /** `Date.now()` when set: stale lighting is dropped (`current`). */
  at: number;
};

/** Older than this, the world's lighting no longer describes where the wearer is. */
export const STALE_MS = 5000;

let current: EnvironmentLighting | null = null;

/**
 * From one block's lighting record and the alignment of its world to tracking. `alignment` maps
 * the right-handed VRChat world (Unity z negated) into tracking: `scale · R_y(yaw) · p + t`.
 */
export function environmentFromRecord(
  record: readonly number[] | undefined,
  alignment: WorldToTracking,
  now = Date.now(),
): EnvironmentLighting | null {
  if (!record || record.length < LIGHTING.length) return null;
  lightVolumeCache.ingest(record, now);
  if (record.slice(LIGHTING.sh, LIGHTING.sh + 27).some((v) => !Number.isFinite(v))) return null;
  const r = record;
  const at4 = (o: number) => [r[o], r[o + 1], r[o + 2], r[o + 3]];
  const sh = LIGHTING.sh;
  const main = at4(LIGHTING.mainLightPosition);
  const color = [0, 1, 2].map((i) => r[LIGHTING.mainLightColor + i]);
  const directional = main[3] === 0 && Math.hypot(main[0], main[1], main[2]) > 1e-6 &&
    color.some((c) => c > 0);
  // n_worldRH = R_y(−yaw) · n_tracking, then Unity flips z.
  const c = Math.cos(alignment.yawRad), s = Math.sin(alignment.yawRad);
  // R_y(−yaw) columns: (c, 0, s), (0, 1, 0), (−s, 0, c); then negate each column's z.
  const trackingToUnity = [c, 0, -s, 0, 1, 0, -s, 0, -c];
  return {
    shA: [at4(sh), at4(sh + 4), at4(sh + 8)],
    shB: [at4(sh + 12), at4(sh + 16), at4(sh + 20)],
    shC: [r[sh + 24], r[sh + 25], r[sh + 26]],
    mainDirection: directional ? normalize([main[0], main[1], main[2]]) : null,
    mainColor: directional ? color : [0, 0, 0],
    trackingToUnity,
    trackingOrigin: [...alignment.translation],
    trackingScale: alignment.scale,
    vertexLights: {
      x: at4(LIGHTING.vertexLightPositionX),
      y: at4(LIGHTING.vertexLightPositionY),
      z: at4(LIGHTING.vertexLightPositionZ),
      atten: at4(LIGHTING.vertexLightAttenuation),
      colors: [0, 1, 2, 3].map((i) => at4(LIGHTING.vertexLightColor + i * 4).slice(0, 3)),
    },
    at: now,
  };
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function setEnvironmentLighting(lighting: EnvironmentLighting | null): void {
  current = lighting;
}

/** The world's lighting, or null when none arrived in the last `STALE_MS`. */
export function environmentLighting(now = Date.now()): EnvironmentLighting | null {
  return current && now - current.at <= STALE_MS ? current : null;
}

/** Unity's `ShadeSH9` for a Unity-world normal: linear irradiance-like colour, clamped at 0. */
export function shadeSH9(env: EnvironmentLighting, n: readonly number[]): number[] {
  const vB = [n[0] * n[1], n[1] * n[2], n[2] * n[2], n[2] * n[0]];
  const vC = n[0] * n[0] - n[1] * n[1];
  return [0, 1, 2].map((ch) => {
    const a = env.shA[ch], b = env.shB[ch];
    const x1 = a[0] * n[0] + a[1] * n[1] + a[2] * n[2] + a[3];
    const x2 = b[0] * vB[0] + b[1] * vB[1] + b[2] * vB[2] + b[3] * vB[3];
    return Math.max(0, x1 + x2 + env.shC[ch] * vC);
  });
}

/** Tracking position → Unity world position. */
export function trackingToUnityPoint(env: EnvironmentLighting, p: readonly number[]): number[] {
  const o = env.trackingOrigin, k = env.trackingScale;
  return applyMat3(env.trackingToUnity, [(p[0] - o[0]) / k, (p[1] - o[1]) / k, (p[2] - o[2]) / k]);
}

/** Unity's `Shade4PointLights`: Unity-world position and normal, linear colour. */
export function shade4PointLights(
  env: EnvironmentLighting,
  pos: readonly number[],
  n: readonly number[],
): number[] {
  const out = [0, 0, 0];
  const v = env.vertexLights;
  for (let i = 0; i < 4; i++) {
    const to = [v.x[i] - pos[0], v.y[i] - pos[1], v.z[i] - pos[2]];
    const lengthSq = Math.max(to[0] ** 2 + to[1] ** 2 + to[2] ** 2, 1e-6);
    const ndotl = Math.max(0, (to[0] * n[0] + to[1] * n[1] + to[2] * n[2]) / Math.sqrt(lengthSq));
    const diff = ndotl / (1 + lengthSq * v.atten[i]);
    for (let c = 0; c < 3; c++) out[c] += v.colors[i][c] * diff;
  }
  return out;
}

/** Column-major 3x3 times a vector. */
export function applyMat3(m: readonly number[], v: readonly number[]): number[] {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** Unity world direction → tracking (the transpose: `trackingToUnity` is a rotation). */
export function unityToTrackingDirection(env: EnvironmentLighting, v: readonly number[]): number[] {
  const m = env.trackingToUnity;
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c: readonly number[]) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

/**
 * Where PetPlay's objects cast shadows from, in tracking space (towards the light), and how much
 * light the shadow takes away (0..1): the main light's share when the world has one, otherwise the
 * probe SH's dominant direction (luminance-weighted L1) and its share against L0. Null when the
 * lighting has no direction worth a shadow.
 */
export function shadowLight(env: EnvironmentLighting): { direction: number[]; strength: number } | null {
  const ambient = luma([env.shA[0][3], env.shA[1][3], env.shA[2][3]]);
  if (env.mainDirection) {
    const main = luma(env.mainColor);
    if (main > 0) {
      return {
        direction: unityToTrackingDirection(env, env.mainDirection),
        strength: main / (main + Math.max(ambient, 0)),
      };
    }
  }
  const l1 = [0, 1, 2].map((axis) => luma([env.shA[0][axis], env.shA[1][axis], env.shA[2][axis]]));
  const length = Math.hypot(l1[0], l1[1], l1[2]);
  if (!(length > 1e-4) || !(ambient > 0)) return null;
  return {
    direction: unityToTrackingDirection(env, l1.map((v) => v / length)),
    strength: length / (ambient + length),
  };
}

/**
 * The depth block's lighting record (`format.ts` `LIGHTING`), structured and moved into the
 * right-handed VRChat world frame `sync.ts` uses (Unity's z negated). Colours stay linear, as Unity
 * gave them.
 */
import { LIGHTING } from "./format.ts";

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];

export type VrcLighting = {
  /**
   * Probe SH at the exporter, L0 and L1 per colour channel, Unity's `ShadeSH9` convention:
   * irradiance(n) = l0 + dot(l1, n) + L2 terms. `l1` is already in the right-handed frame.
   */
  sh: {
    l0: Rgb;
    l1: [Vec3, Vec3, Vec3];
    /** unity_SHBr/g/b and unity_SHC, unchanged (the L2 basis is even in z except xz/yz terms). */
    l2Raw: number[];
  };
  /** Main directional light: direction the light travels *from* (towards the light), or null. */
  mainLight: { direction: Vec3 | null; position: Vec3 | null; color: Rgb; intensity: number };
  /** Up to four per-vertex point lights; empty slots dropped. */
  vertexLights: { position: Vec3; color: Rgb; attenuation: number }[];
  ambient: { sky: Rgb; equator: Rgb; ground: Rgb };
  fog: { color: Rgb; params: [number, number, number, number] };
  /** Box bounds are ±Infinity for a probe without box projection (e.g. the skybox). */
  reflectionProbes: {
    hdr: [number, number, number, number];
    boxMax: [number, number, number, number];
    boxMin: [number, number, number, number];
    position: [number, number, number, number];
  }[];
  lightVolumes: {
    enabled: boolean;
    version: number;
    count: number;
    additiveCount: number;
    probesBlend: boolean;
    sharpBounds: boolean;
    pointLightCount: number;
    brightnessCutoff: number;
  };
  /** Where the SH were evaluated: the exporter's world position. */
  samplePosition: Vec3;
};

const flipZ = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];

export function parseLighting(record: readonly number[] | undefined): VrcLighting | null {
  if (!record || record.length < LIGHTING.length) return null;
  const r = record;
  const v4 = (o: number) => [r[o], r[o + 1], r[o + 2], r[o + 3]] as [number, number, number, number];
  const rgb = (o: number): Rgb => [r[o], r[o + 1], r[o + 2]];
  const sh = LIGHTING.sh;
  // unity_SHAr = (L1 x, y, z, L0) for red; same for green and blue.
  const l1 = [0, 1, 2].map((c) => flipZ([r[sh + c * 4], r[sh + c * 4 + 1], r[sh + c * 4 + 2]])) as [
    Vec3,
    Vec3,
    Vec3,
  ];
  const mainPos = v4(LIGHTING.mainLightPosition);
  const mainColor = rgb(LIGHTING.mainLightColor);
  const directional = mainPos[3] === 0;
  const lights: VrcLighting["vertexLights"] = [];
  for (let i = 0; i < 4; i++) {
    const color = rgb(LIGHTING.vertexLightColor + i * 4);
    if (color.every((c) => c === 0)) continue;
    lights.push({
      position: flipZ([
        r[LIGHTING.vertexLightPositionX + i],
        r[LIGHTING.vertexLightPositionY + i],
        r[LIGHTING.vertexLightPositionZ + i],
      ]),
      color,
      attenuation: r[LIGHTING.vertexLightAttenuation + i],
    });
  }
  const lv = LIGHTING.lightVolumes;
  const probe = (o: number) => ({
    hdr: v4(o),
    boxMax: v4(o + 4),
    boxMin: v4(o + 8),
    position: v4(o + 12),
  });
  return {
    sh: {
      l0: [r[sh + 3], r[sh + 7], r[sh + 11]],
      l1,
      l2Raw: r.slice(sh + 12, sh + 27),
    },
    mainLight: {
      direction: directional ? flipZ([mainPos[0], mainPos[1], mainPos[2]]) : null,
      position: directional ? null : flipZ([mainPos[0], mainPos[1], mainPos[2]]),
      color: mainColor,
      intensity: Math.max(...mainColor),
    },
    vertexLights: lights,
    ambient: {
      sky: rgb(LIGHTING.ambient),
      equator: rgb(LIGHTING.ambient + 4),
      ground: rgb(LIGHTING.ambient + 8),
    },
    fog: { color: rgb(LIGHTING.fogColor), params: v4(LIGHTING.fogParams) },
    reflectionProbes: [probe(LIGHTING.reflectionProbe0), probe(LIGHTING.reflectionProbe1)],
    lightVolumes: {
      enabled: r[lv] > 0.5,
      version: r[lv + 1],
      count: r[lv + 2],
      additiveCount: r[lv + 3],
      probesBlend: r[lv + 4] > 0.5,
      sharpBounds: r[lv + 5] > 0.5,
      pointLightCount: r[lv + 6],
      brightnessCutoff: r[lv + 7],
    },
    samplePosition: flipZ([
      r[LIGHTING.samplePosition],
      r[LIGHTING.samplePosition + 1],
      r[LIGHTING.samplePosition + 2],
    ]),
  };
}

/** Irradiance-like ambient for a right-handed world normal from L0 + L1 (L2 omitted). */
export function evaluateShL1(lighting: VrcLighting, normal: Vec3): Rgb {
  const { l0, l1 } = lighting.sh;
  return [0, 1, 2].map((c) =>
    Math.max(0, l0[c] + l1[c][0] * normal[0] + l1[c][1] * normal[1] + l1[c][2] * normal[2])
  ) as Rgb;
}

/** One short status line for debug overlays. */
export function lightingDebugLine(lighting: VrcLighting | null): string {
  if (!lighting) return "lighting: none (exporter before format v3)";
  const f = (v: number[]) => v.map((n) => n.toFixed(2)).join(" ");
  const lv = lighting.lightVolumes;
  const main = lighting.mainLight;
  return `light: SH L0 ${f(lighting.sh.l0)} | main ${
    main.direction ? `dir ${f(main.direction)}` : "none"
  } col ${f(main.color)} | vtx ${lighting.vertexLights.length} | LV ${
    lv.enabled ? `v${lv.version} ${lv.count} vol ${lv.pointLightCount} lights` : "off"
  }`;
}

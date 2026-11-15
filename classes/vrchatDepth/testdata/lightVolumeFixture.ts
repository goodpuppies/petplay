import { LIGHTING } from "../format.ts";
import { LV, volumeChecksum } from "../lightVolumes.ts";

export function volumePage(page: number, id = 0, count = 1, grid = 16): number[] {
  const record = new Array(LIGHTING.length + LV.words).fill(0);
  const p = new Array(LV.words).fill(0);
  p.splice(0, 12, LV.magic, grid === 16 ? 1 : 2, count, 0, id, page, grid, 1, 0, 2, 0, 0);
  // Row-major world-to-local identity: spatial cube -0.5..+0.5.
  p[12] =
    p[17] =
    p[22] =
    p[27] =
      1;
  p[28] = p[29] = p[30] = 4; // edge falloff
  for (let s = 0; s < LV.samplesPerPage; s++) {
    const k = page * LV.samplesPerPage + s;
    const x = (k % grid) / (grid - 1);
    const o = 60 + s * 12;
    p[o] = p[o + 1] = p[o + 2] = x;
    p[o + 3] = 0.1; // red L1 +x
  }
  const h = volumeChecksum(p.slice(0, -2));
  p[LV.words - 2] = h & 65535;
  p[LV.words - 1] = h >>> 16;
  record.splice(LIGHTING.length, LV.words, ...p);
  return record;
}

/** Native atlas with unequal axes and half-texel boundary taps. */
export function nativeVolumePage(page: number, dimensions: [number, number, number]): number[] {
  const r = volumePage(0), o = LIGHTING.length;
  r[o + 1] = 3;
  r[o + 5] = page;
  r[o + 6] = dimensions[0];
  r[o + 11] = dimensions[1] + dimensions[2] * 4096;
  for (const k of [19, 27, 31]) r[o + 12 + k] = 0.5;
  dimensions.forEach((d, i) => r[o + 12 + 44 + i] = d - 2);
  r[o + 12 + 47] = 1;
  for (let s = 0; s < 128; s++) {
    const sample = page * 128 + s, at = o + 60 + s * 12;
    r.fill(0, at, at + 12);
    r[at] = sample < dimensions.reduce((a, b) => a * b, 1)
      ? (sample % dimensions[0]) / (dimensions[0] - 1)
      : 0;
  }
  const h = volumeChecksum(r.slice(o, -2));
  r[r.length - 2] = h & 65535;
  r[r.length - 1] = h >>> 16;
  return r;
}

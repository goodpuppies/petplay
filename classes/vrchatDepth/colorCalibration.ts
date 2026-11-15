/**
 * 3D colour calibration for the depth block (`format.ts`, calibration mode "3d"): the block shows
 * one calibration cell per level combination, and a data cell decodes to the combination whose
 * observed colour is nearest. Unlike per-channel ramps this absorbs any transform the world applies
 * (tonemapping, grading LUTs, saturation, channel mixing) as long as distinct colours stay apart.
 * Found necessary in a world whose grade made red depend on green (2026-11-07).
 */

/** Bucket width in byte values: the search visits the 27 buckets around a colour. */
const BUCKET = 16;
const BUCKETS = 256 / BUCKET;

export class ColorClassifier {
  /** Smallest distance between two calibrated colours (Euclidean, byte units). */
  readonly margin: number;
  private readonly buckets: Int32Array[];
  private readonly cache = new Map<number, number>();

  /**
   * `samples`: observed RGB of calibration cell k (3 bytes each), where k encodes the levels
   * `r = k % n, g = floor(k / n) % n, b = floor(k / n²)`.
   */
  constructor(readonly samples: Uint8Array, readonly levels: number) {
    const lists: number[][] = Array.from({ length: BUCKETS ** 3 }, () => []);
    const count = samples.length / 3;
    for (let k = 0; k < count; k++) lists[this.bucketOf(k)].push(k);
    this.buckets = lists.map((list) => Int32Array.from(list));
    let margin = Infinity;
    for (let k = 0; k < count; k++) {
      const nearest = this.search(samples[k * 3], samples[k * 3 + 1], samples[k * 3 + 2], k);
      margin = Math.min(margin, nearest.distance);
    }
    this.margin = Math.sqrt(margin);
  }

  /** Calibration index (level combination) nearest to an observed colour. */
  classify(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    let k = this.cache.get(key);
    if (k === undefined) {
      k = this.search(r, g, b, -1).index;
      if (this.cache.size > 1 << 20) this.cache.clear();
      this.cache.set(key, k);
    }
    return k;
  }

  /** Packed cell bits for an observed colour: r | g << bits | b << 2 bits. */
  classifyPacked(r: number, g: number, b: number, bits: number): number {
    const k = this.classify(r, g, b);
    const n = this.levels;
    return (k % n) | ((Math.floor(k / n) % n) << bits) | (Math.floor(k / (n * n)) << (2 * bits));
  }

  /** True when every calibration colour is within `tolerance` of this classifier's. */
  matches(samples: Uint8Array, tolerance: number): boolean {
    if (samples.length !== this.samples.length) return false;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i] - this.samples[i]) > tolerance) return false;
    }
    return true;
  }

  /**
   * Lookup table for shaders: observed colour quantized to `size` steps a channel (bin centres)
   * → levels as RGB bytes (alpha 255). Laid out as `size` slices of size × size (blue selects the
   * slice), slices tiled `tiles` across: a 2D texture of (size·tiles) × (size·size/tiles).
   */
  shaderTable(size = 64, tiles = 8): { data: Uint8Array; width: number; height: number } {
    const width = size * tiles, height = size * (size / tiles);
    const data = new Uint8Array(width * height * 4);
    const step = 256 / size;
    const n = this.levels;
    for (let bz = 0; bz < size; bz++) {
      const tx = (bz % tiles) * size, ty = Math.floor(bz / tiles) * size;
      for (let gy = 0; gy < size; gy++) {
        for (let rx = 0; rx < size; rx++) {
          const k = this.search(
            Math.floor((rx + 0.5) * step),
            Math.floor((gy + 0.5) * step),
            Math.floor((bz + 0.5) * step),
            -1,
          ).index;
          const o = ((ty + gy) * width + tx + rx) * 4;
          data[o] = k % n;
          data[o + 1] = Math.floor(k / n) % n;
          data[o + 2] = Math.floor(k / (n * n));
          data[o + 3] = 255;
        }
      }
    }
    return { data, width, height };
  }

  private bucketOf(k: number): number {
    const s = this.samples;
    return (Math.floor(s[k * 3] / BUCKET) * BUCKETS + Math.floor(s[k * 3 + 1] / BUCKET)) * BUCKETS +
      Math.floor(s[k * 3 + 2] / BUCKET);
  }

  /** Nearest sample other than `skip`; widens the bucket ring until a hit is certain. */
  private search(r: number, g: number, b: number, skip: number) {
    const s = this.samples;
    const br = Math.floor(r / BUCKET), bg = Math.floor(g / BUCKET), bb = Math.floor(b / BUCKET);
    let best = -1, bestDistance = Infinity;
    for (let ring = 1; ring < BUCKETS; ring++) {
      for (let x = Math.max(0, br - ring); x <= Math.min(BUCKETS - 1, br + ring); x++) {
        for (let y = Math.max(0, bg - ring); y <= Math.min(BUCKETS - 1, bg + ring); y++) {
          for (let z = Math.max(0, bb - ring); z <= Math.min(BUCKETS - 1, bb + ring); z++) {
            // Only the shell is new after the first ring.
            if (
              ring > 1 && Math.abs(x - br) < ring && Math.abs(y - bg) < ring &&
              Math.abs(z - bb) < ring
            ) continue;
            const list = this.buckets[(x * BUCKETS + y) * BUCKETS + z];
            for (let i = 0; i < list.length; i++) {
              const k = list[i];
              if (k === skip) continue;
              const dr = s[k * 3] - r, dg = s[k * 3 + 1] - g, db = s[k * 3 + 2] - b;
              const d = dr * dr + dg * dg + db * db;
              if (d < bestDistance) {
                bestDistance = d;
                best = k;
              }
            }
          }
        }
      }
      // Anything outside the searched cube is at least as far as the cube's nearest face (a side
      // at the colour range's edge has nothing beyond it); once the best is closer, it is final.
      let reach = Infinity;
      for (const [v, bucket] of [[r, br], [g, bg], [b, bb]]) {
        const lo = (bucket - ring) * BUCKET, hi = (bucket + ring + 1) * BUCKET;
        if (lo > 0) reach = Math.min(reach, v - lo);
        if (hi < 256) reach = Math.min(reach, hi - v);
      }
      if (best >= 0 && bestDistance <= reach * reach) break;
    }
    return { index: best, distance: bestDistance };
  }
}

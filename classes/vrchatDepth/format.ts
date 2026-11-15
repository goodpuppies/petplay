/**
 * The pixel format a VRChat avatar shader uses to hand its eye depth and camera pose to PetPlay
 * through the VRChat window. Plan: `markdown/vrchat-depth/README.md`.
 *
 * This file is the reference: `unity/PetPlayDepth/PetPlayDepthFormat.cginc` writes the same cells
 * (`unity/PetPlayDepth/PetPlayDepthExporter.shader` supplies the depth and the per-frame values).
 * Change both together and bump `VERSION`.
 *
 * The block is a grid of square cells, `gridWidth` cells wide. One cell is one colour; its size in
 * pixels is a render choice the decoder measures. Rows, top to bottom:
 *
 * - row 0, finder: cells alternate white and black, starting white. Gives origin and cell pitch.
 * - row 1, preamble: `PREAMBLE_BITS` cells, one bit each (white = 1), LSB first: word 0 is
 *   `version | bitsR << 8 | bitsG << 16 | bitsB << 24`, word 1 is `gridWidth | gridHeight << 16`.
 *   Bit 7 of the bitsR byte (`CALIBRATION_3D`) selects 3D calibration (below).
 * - calibration, from row 2: every level of R, then G, then B, each on a black cell. The decoder
 *   maps samples to the nearest calibrated level, so a monotonic colour transform applied to the
 *   whole block (sRGB, tonemapping, grading) cancels out. Idea from TSMP's RGB20 codec.
 *   3D calibration (all channels `b` bits): one cell per level combination instead, cell k showing
 *   levels `(k % n, k / n % n, k / n²)` with `n = 2^b`; data cells decode to the nearest observed
 *   combination (`colorCalibration.ts`), which also cancels transforms that mix channels.
 * - data, from the row after calibration. Each cell carries `bitsR + bitsG + bitsB` bits, a value
 *   whose lowest bits are red's level, then green's, then blue's. Three parts, each starting on a
 *   cell:
 *   - head: the header (`HEADER_WORDS`) and the lighting record (`lightingWords` float words, see
 *     `LIGHTING`) as a bitstream of 32-bit words, LSB first;
 *   - depth: one sample per cell, row-major from the top-left of the eye image, log-coded over the
 *     cell's bits (`quantizeDepth`), so a misread cell spoils one sample and nothing else (v4);
 *   - trailer: the header's time tag as a bitstream, so a capture that mixes two frames is rejected.
 *
 * A level `l` of a `b`-bit channel is written as the byte `lo + round(l * (hi - lo) / (2^b - 1))`
 * with `lo = levelInset`, `hi = 255 - 2 * levelInset` (`levelByte`): an inset keeps the colours off
 * the extremes that world post-processing crushes (highlight roll-off, saturated corners; v4).
 *
 * A black border `QUIET_CELLS` wide surrounds the grid, so the finder never touches the image
 * behind the block (the idea of a QR code's quiet zone).
 */
import { ColorClassifier } from "./colorCalibration.ts";

export const MAGIC = 0x50445050; // bytes "PPDP"
export const VERSION = 4;
export const PREAMBLE_BITS = 64;
export const HEADER_WORDS = 48;
export const QUIET_CELLS = 2;
/** Preamble flag in the bitsR byte: 3D colour calibration. */
export const CALIBRATION_3D = 0x80;
/** 3D calibration needs n³ cells: at most this many bits a channel. */
export const MAX_3D_BITS = 6;
/** Largest `levelInset`: keeps `hi - lo` at 63 or more. */
export const MAX_LEVEL_INSET = 64;
/** Far end of the log depth range when a header doesn't say (metres). */
export const DEFAULT_DEPTH_FAR = 1000;

/** Header word indices. Floats are stored as their IEEE-754 bits. */
export const H = {
  magic: 0,
  layout: 1, // version | bitsR << 8 | bitsG << 16 | bitsB << 24
  grid: 2, // gridWidth | gridHeight << 16
  depthSize: 3, // depthWidth | depthHeight << 16
  timeTag: 4, // the shader's _Time.y bits: distinct per frame, repeated in the trailer
  eye: 5, // eye index | flags << 8
  viewToWorld: 6, // 12 floats, row-major 3x4: UNITY_MATRIX_I_V, Unity world, camera looks down -z
  projection: 18, // m00, m11, m02, m12 of the eye's projection matrix as the shader saw it
  near: 22,
  far: 23,
  screenWidth: 24,
  screenHeight: 25,
  depthRef: 26, // near end of the log depth range, metres
  // 12 floats, row-major 3x4: the exporter object's frame with scale removed and its origin moved
  // to the anchor, Unity world. The avatar builder puts the anchor at the avatar's viewpoint (the
  // point VRChat keeps at the headset's centre eye), and the exporter rides a head constraint, so
  // this is the wearer's head in every pass, the camera pass included.
  anchorToWorld: 27,
  lightingWords: 39, // length of the lighting record that follows the header (v3)
  depthFar: 40, // far end of the log depth range, metres (v4)
  levelInset: 41, // the layout's level inset (v4)
  // 42..46 reserved, zero
  checksum: 47, // FNV-1a over words 0..46
} as const;

/**
 * The lighting record (v3): float words the exporter samples at its renderer every frame, the
 * Unity built-in pipeline's lighting inputs plus VRC Light Volumes' scalars. Offsets into the record.
 * Unity values are as the shader saw them (world space, Unity's left-handed axes, linear colour).
 */
export const LIGHTING = {
  /** unity_SHAr, SHAg, SHAb, SHBr, SHBg, SHBb (4 each), SHC (xyz): the probe SH at the renderer. */
  sh: 0,
  /** _WorldSpaceLightPos0: main light direction (w 0) or position (w 1). */
  mainLightPosition: 27,
  /** _LightColor0. */
  mainLightColor: 31,
  /** unity_4LightPosX0, Y0, Z0: the four per-vertex point lights' positions, by axis. */
  vertexLightPositionX: 35,
  vertexLightPositionY: 39,
  vertexLightPositionZ: 43,
  /** unity_4LightAtten0. */
  vertexLightAttenuation: 47,
  /** unity_LightColor[0..3]. */
  vertexLightColor: 51,
  /** unity_AmbientSky, unity_AmbientEquator, unity_AmbientGround. */
  ambient: 67,
  /** unity_FogColor, unity_FogParams. */
  fogColor: 79,
  fogParams: 83,
  /** unity_SpecCube0_HDR, BoxMax, BoxMin, ProbePosition; then the same for unity_SpecCube1. */
  reflectionProbe0: 87,
  reflectionProbe1: 103,
  /**
   * VRC Light Volumes: Enabled, Version, Count, AdditiveCount, ProbesBlend, SharpBounds,
   * PointLightVolumeCount, LightBrightnessCutoff. Zero in worlds without them.
   */
  lightVolumes: 119,
  /** The renderer's world position, where the SH above were evaluated. */
  samplePosition: 127,
  length: 130,
} as const;
export const LIGHTING_WORDS = LIGHTING.length;

export const FLAG_PROJECTION_FLIPPED = 1; // _ProjectionParams.x < 0
export const FLAG_REVERSED_Z = 2;
export const FLAG_STEREO_INSTANCED = 4;
export const FLAG_SINGLE_PASS_DOUBLE_WIDE = 8; // both eyes in one double-width target
export const FLAG_VRCHAT_CAMERA = 16; // drawn in VRChat's handheld camera pass, not the eye
/** Depth from the avatar's own head depth camera: the pass that drew the block saw another view. */
export const FLAG_DEPTH_CAMERA = 32;

export type ChannelBits = readonly [number, number, number];

export interface DepthLayout {
  bits: ChannelBits;
  gridWidth: number;
  depthWidth: number;
  depthHeight: number;
  /** Lighting record length in words; defaults to `LIGHTING_WORDS`. */
  lightingWords?: number;
  /** One calibration cell per level combination (equal bits, at most `MAX_3D_BITS`). */
  calibration3D?: boolean;
  /** Level bytes span `inset .. 255 - 2 inset` (`levelByte`); default 0. */
  levelInset?: number;
}

export interface DerivedLayout extends DepthLayout {
  lightingWords: number;
  levelInset: number;
  bitsPerCell: number;
  calibrationCells: number;
  dataStartRow: number;
  /** Header plus lighting record, in words, and the cells they take. */
  headWords: number;
  headCells: number;
  /** Data cell of depth sample 0; samples take one cell each. */
  depthStartCell: number;
  trailerStartCell: number;
  dataCells: number;
  gridHeight: number;
}

export interface DepthFrameHeader {
  timeTag: number;
  eye: number;
  flags: number;
  /** Row-major 3x4. */
  viewToWorld: readonly number[];
  projection: { m00: number; m11: number; m02: number; m12: number };
  near: number;
  far: number;
  screenWidth: number;
  screenHeight: number;
  /** Near end of the log depth range, metres. */
  depthRef: number;
  /** Far end of the log depth range, metres; `DEFAULT_DEPTH_FAR` when absent. */
  depthFar?: number;
  /** Row-major 3x4, see `H.anchorToWorld`. */
  anchorToWorld: readonly number[];
  /** The lighting record (`LIGHTING`), `lightingWords` floats; zeros when absent. */
  lighting?: readonly number[];
}

export interface DepthFrame {
  layout: DerivedLayout;
  header: DepthFrameHeader;
  /** Linear eye depth in metres, row-major from the top-left of the eye image; 0 = no depth. */
  depth: Float32Array;
  /** Size of `depth`: the layout's depth size, or the sparse grid's (`DecodeOptions.depthGrid`). */
  width: number;
  height: number;
}

export function deriveLayout(layout: DepthLayout): DerivedLayout {
  const { bits, gridWidth, depthWidth, depthHeight } = layout;
  for (const b of bits) {
    if (!Number.isInteger(b) || b < 1 || b > 8) {
      throw new Error(`channel bits must be 1..8, got ${b}`);
    }
  }
  if (!Number.isInteger(gridWidth) || gridWidth < PREAMBLE_BITS || gridWidth > 0xffff) {
    throw new Error(`gridWidth must be ${PREAMBLE_BITS}..65535, got ${gridWidth}`);
  }
  if (depthWidth < 1 || depthHeight < 1 || depthWidth > 0xffff || depthHeight > 0xffff) {
    throw new Error(`bad depth size ${depthWidth}x${depthHeight}`);
  }
  const bitsPerCell = bits[0] + bits[1] + bits[2];
  if (layout.calibration3D) {
    if (bits[0] !== bits[1] || bits[1] !== bits[2] || bits[0] > MAX_3D_BITS) {
      throw new Error(`3D calibration needs equal bits <= ${MAX_3D_BITS}, got ${bits.join("/")}`);
    }
  }
  const calibrationCells = layout.calibration3D
    ? (1 << bits[0]) ** 3
    : (1 << bits[0]) + (1 << bits[1]) + (1 << bits[2]);
  const dataStartRow = 2 + Math.ceil(calibrationCells / gridWidth);
  const lightingWords = layout.lightingWords ?? LIGHTING_WORDS;
  if (!Number.isInteger(lightingWords) || lightingWords < 0 || lightingWords > 0xffff) {
    throw new Error(`bad lighting record length ${lightingWords}`);
  }
  const levelInset = layout.levelInset ?? 0;
  if (!Number.isInteger(levelInset) || levelInset < 0 || levelInset > MAX_LEVEL_INSET) {
    throw new Error(`level inset must be 0..${MAX_LEVEL_INSET}, got ${levelInset}`);
  }
  const headWords = HEADER_WORDS + lightingWords;
  const headCells = Math.ceil((headWords * 32) / bitsPerCell);
  const depthStartCell = headCells;
  const trailerStartCell = depthStartCell + depthWidth * depthHeight;
  const dataCells = trailerStartCell + Math.ceil(32 / bitsPerCell);
  const gridHeight = dataStartRow + Math.ceil(dataCells / gridWidth);
  if (gridHeight > 0xffff) throw new Error(`grid too tall: ${gridHeight}`);
  return {
    ...layout,
    bitsPerCell,
    calibrationCells,
    dataStartRow,
    lightingWords,
    levelInset,
    headWords,
    headCells,
    depthStartCell,
    trailerStartCell,
    dataCells,
    gridHeight,
  };
}

// --- shared helpers ---------------------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** IEEE-754 bits, with -0 written as +0 (the shader does the same: see PPDFloatWord). */
export function floatBits(value: number): number {
  f32[0] = value;
  return u32[0] === 0x80000000 ? 0 : u32[0];
}
export function bitsFloat(bits: number): number {
  u32[0] = bits >>> 0;
  return f32[0];
}

export function fnv1aWords(words: ArrayLike<number>, count: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < count; i++) {
    h = Math.imul((h ^ words[i]) >>> 0, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Log depth over `bits` bits from `near` to `far`: the same relative step everywhere (12 bits over
 * 0.05..1000 m: 0.24 %). 0 means no depth (sky, far plane); nearer than `near` reads as `near`.
 */
export function quantizeDepth(metres: number, near: number, far: number, bits: number): number {
  if (!(metres > 0) || !Number.isFinite(metres)) return 0;
  const top = 2 ** bits - 1;
  const t = Math.log(metres / near) / Math.log(far / near);
  return Math.min(top, Math.max(1, 1 + Math.round(t * (top - 1))));
}
export function dequantizeDepth(q: number, near: number, far: number, bits: number): number {
  if (q === 0) return 0;
  return near * Math.exp(((q - 1) / (2 ** bits - 2)) * Math.log(far / near));
}

/** Lowest and highest level bytes for an inset. */
export function levelRange(inset = 0): readonly [number, number] {
  return [inset, 255 - 2 * inset];
}
export function levelByte(level: number, bits: number, inset = 0): number {
  const [lo, hi] = levelRange(inset);
  return lo + Math.round((level * (hi - lo)) / ((1 << bits) - 1));
}

function layoutWord0(layout: DepthLayout): number {
  const r = layout.bits[0] | (layout.calibration3D ? CALIBRATION_3D : 0);
  return (VERSION | (r << 8) | (layout.bits[1] << 16) | (layout.bits[2] << 24)) >>> 0;
}
function layoutWord1(layout: DerivedLayout): number {
  return (layout.gridWidth | (layout.gridHeight << 16)) >>> 0;
}

// --- encoder (reference for the shader, and the source of synthetic test images) ---------------

/** The head words: header and lighting record. */
export function encodeWords(layout: DerivedLayout, header: DepthFrameHeader): Uint32Array {
  const words = new Uint32Array(layout.headWords);
  words[H.magic] = MAGIC;
  words[H.layout] = layoutWord0(layout);
  words[H.grid] = layoutWord1(layout);
  words[H.depthSize] = (layout.depthWidth | (layout.depthHeight << 16)) >>> 0;
  words[H.timeTag] = header.timeTag >>> 0;
  words[H.eye] = ((header.eye & 0xff) | ((header.flags & 0xffffff) << 8)) >>> 0;
  if (header.viewToWorld.length !== 12) throw new Error("viewToWorld must have 12 values");
  for (let i = 0; i < 12; i++) words[H.viewToWorld + i] = floatBits(header.viewToWorld[i]);
  const p = header.projection;
  words[H.projection] = floatBits(p.m00);
  words[H.projection + 1] = floatBits(p.m11);
  words[H.projection + 2] = floatBits(p.m02);
  words[H.projection + 3] = floatBits(p.m12);
  words[H.near] = floatBits(header.near);
  words[H.far] = floatBits(header.far);
  words[H.screenWidth] = floatBits(header.screenWidth);
  words[H.screenHeight] = floatBits(header.screenHeight);
  words[H.depthRef] = floatBits(header.depthRef);
  if (header.anchorToWorld.length !== 12) throw new Error("anchorToWorld must have 12 values");
  for (let i = 0; i < 12; i++) words[H.anchorToWorld + i] = floatBits(header.anchorToWorld[i]);
  words[H.lightingWords] = layout.lightingWords;
  words[H.depthFar] = floatBits(header.depthFar ?? DEFAULT_DEPTH_FAR);
  words[H.levelInset] = layout.levelInset;
  words[H.checksum] = fnv1aWords(words, H.checksum);
  const lighting = header.lighting ?? [];
  for (let i = 0; i < layout.lightingWords; i++) {
    words[HEADER_WORDS + i] = floatBits(lighting[i] ?? 0);
  }
  return words;
}

/** The value of every data cell (`bitsPerCell` bits each): head words, depth, trailer. */
export function encodeDataCells(
  layout: DerivedLayout,
  header: DepthFrameHeader,
  depth: ArrayLike<number>,
): Uint32Array {
  const head = encodeWords(layout, header);
  const samples = layout.depthWidth * layout.depthHeight;
  if (depth.length !== samples) {
    throw new Error(`depth has ${depth.length} samples, expected ${samples}`);
  }
  const values = new Uint32Array(layout.dataCells);
  const bpc = layout.bitsPerCell;
  for (let s = 0; s < layout.headCells; s++) values[s] = streamBits(head, s * bpc, bpc);
  // The header carries near and far as float32: quantize with what the decoder will read.
  const near = Math.fround(header.depthRef),
    far = Math.fround(header.depthFar ?? DEFAULT_DEPTH_FAR);
  for (let i = 0; i < samples; i++) {
    values[layout.depthStartCell + i] = quantizeDepth(depth[i], near, far, bpc);
  }
  const trailer = Uint32Array.of(header.timeTag >>> 0);
  for (let s = layout.trailerStartCell; s < layout.dataCells; s++) {
    values[s] = streamBits(trailer, (s - layout.trailerStartCell) * bpc, bpc);
  }
  return values;
}

/** `count` bits of a word stream from bit `start`, zero past its end. */
function streamBits(words: Uint32Array, start: number, count: number): number {
  let value = 0;
  for (let k = 0; k < count; k++) {
    const index = start + k, w = index >>> 5;
    if (w < words.length) value |= ((words[w] >>> (index & 31)) & 1) << k;
  }
  return value >>> 0;
}

/** Cells as RGB bytes, `gridWidth * gridHeight * 3`, row-major from the top-left. */
export function encodeCells(
  layout: DerivedLayout,
  header: DepthFrameHeader,
  depth: ArrayLike<number>,
): Uint8Array {
  const values = encodeDataCells(layout, header, depth);
  const { gridWidth, gridHeight, bits, levelInset } = layout;
  const cells = new Uint8Array(gridWidth * gridHeight * 3);
  const set = (cell: number, r: number, g: number, b: number) => {
    cells[cell * 3] = r;
    cells[cell * 3 + 1] = g;
    cells[cell * 3 + 2] = b;
  };
  for (let x = 0; x < gridWidth; x++) {
    const v = (x & 1) === 0 ? 255 : 0;
    set(x, v, v, v);
  }
  const preamble = [layoutWord0(layout), layoutWord1(layout)];
  for (let i = 0; i < PREAMBLE_BITS; i++) {
    const v = ((preamble[i >> 5] >>> (i & 31)) & 1) * 255;
    set(gridWidth + i, v, v, v);
  }
  let cell = 2 * gridWidth;
  if (layout.calibration3D) {
    const n = 1 << bits[0];
    for (let k = 0; k < n ** 3; k++, cell++) {
      set(
        cell,
        levelByte(k % n, bits[0], levelInset),
        levelByte(Math.floor(k / n) % n, bits[0], levelInset),
        levelByte(Math.floor(k / (n * n)), bits[0], levelInset),
      );
    }
  } else {
    for (let c = 0; c < 3; c++) {
      for (let level = 0; level < 1 << bits[c]; level++, cell++) {
        const rgb = [0, 0, 0];
        rgb[c] = levelByte(level, bits[c], levelInset);
        set(cell, rgb[0], rgb[1], rgb[2]);
      }
    }
  }
  const start = layout.dataStartRow * gridWidth;
  for (let s = 0; s < layout.dataCells; s++) {
    let v = values[s];
    const rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      rgb[c] = levelByte(v & ((1 << bits[c]) - 1), bits[c], levelInset);
      v >>>= bits[c];
    }
    set(start + s, rgb[0], rgb[1], rgb[2]);
  }
  return cells;
}

// --- images -------------------------------------------------------------------------------------

/** An 8-bit image with at least three channels per pixel. */
export interface ImageView {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  /** Bytes per pixel. */
  channels: number;
  /** Bytes per row; defaults to `width * channels`. */
  stride?: number;
  /** Byte offsets of R, G and B within a pixel; defaults to RGBA order. */
  order?: readonly [number, number, number];
}

/**
 * Draws cells into an image at `cellPx` pixels per cell (integer), the grid's top-left at (x0, y0),
 * with the black border around it.
 */
export function drawCells(
  image: ImageView,
  layout: DerivedLayout,
  cells: Uint8Array,
  x0: number,
  y0: number,
  cellPx: number,
): void {
  const stride = image.stride ?? image.width * image.channels;
  const [ro, go, bo] = image.order ?? [0, 1, 2];
  const q = QUIET_CELLS;
  for (let cy = -q; cy < layout.gridHeight + q; cy++) {
    for (let cx = -q; cx < layout.gridWidth + q; cx++) {
      const inside = cx >= 0 && cy >= 0 && cx < layout.gridWidth && cy < layout.gridHeight;
      const c = inside ? (cy * layout.gridWidth + cx) * 3 : -1;
      for (let py = 0; py < cellPx; py++) {
        const y = y0 + cy * cellPx + py;
        if (y < 0 || y >= image.height) continue;
        for (let px = 0; px < cellPx; px++) {
          const x = x0 + cx * cellPx + px;
          if (x < 0 || x >= image.width) continue;
          const o = y * stride + x * image.channels;
          image.data[o + ro] = inside ? cells[c] : 0;
          image.data[o + go] = inside ? cells[c + 1] : 0;
          image.data[o + bo] = inside ? cells[c + 2] : 0;
        }
      }
    }
  }
}

// --- decoder ------------------------------------------------------------------------------------

export interface BlockLocation {
  /** Pixel coordinates of the block's top-left corner. */
  x0: number;
  y0: number;
  /** Pixels per cell, possibly fractional when the window is scaled. */
  pitch: number;
}

export type DecodeResult =
  | {
    ok: true;
    frame: DepthFrame;
    location: BlockLocation;
    /** Smallest distance between adjacent calibrated levels, in bytes: the noise margin. */
    calibrationMargin: number;
    /** Sampled byte -> level per channel, 256 entries each (R, then G, then B); 1D mode. */
    luts: Uint8Array;
    /** 3D mode: nearest-colour classifier over the calibration cells. */
    classifier: ColorClassifier | null;
  }
  | {
    ok: false;
    reason:
      | "not-found"
      | "bad-preamble"
      | "out-of-bounds"
      | "bad-calibration"
      | "bad-magic"
      | "bad-checksum"
      | "torn";
    detail?: string;
    location?: BlockLocation;
  };

const MIN_FINDER_CELLS = 32;

/**
 * How far one finder run may be from the pitch. A resampled window turns cells of 2.31 px into
 * runs of 1 to 3 px, and of 3.08 px into 2 to 4 px (VRChat's desktop window, 2026-11-07). At one
 * pixel per cell runs must be exact, so stray pixels can't pass as cells.
 */
function runTolerance(pitch: number): number {
  return Math.max(0.5, pitch * 0.6) + 0.01;
}

function luma(image: ImageView, stride: number, order: readonly number[], x: number, y: number) {
  const o = y * stride + x * image.channels;
  return Math.max(image.data[o + order[0]], image.data[o + order[1]], image.data[o + order[2]]);
}

/**
 * Finds the finder row: at least `MIN_FINDER_CELLS` alternating runs of near-equal length starting
 * white. Searches top to bottom and returns the first row it appears on.
 */
export function locateBlock(image: ImageView, hint?: BlockLocation): BlockLocation | null {
  const stride = image.stride ?? image.width * image.channels;
  const order = image.order ?? [0, 1, 2];
  if (hint) {
    const y = Math.round(hint.y0 + hint.pitch / 2);
    if (y >= 0 && y < image.height) {
      const found = finderInRow(image, stride, order, y);
      if (found && Math.abs(found.x0 - hint.x0) < 1 && Math.abs(found.pitch - hint.pitch) < 0.05) {
        return hint;
      }
    }
  }
  for (let y = 0; y < image.height; y++) {
    const found = finderInRow(image, stride, order, y);
    if (!found) continue;
    // Step down to the finder's centre row, then measure its top edge from there.
    const centre = Math.min(image.height - 1, y + Math.floor(found.pitch / 2));
    const atCentre = finderInRow(image, stride, order, centre) ?? found;
    return { x0: atCentre.x0, y0: y, pitch: atCentre.pitch };
  }
  return null;
}

function finderInRow(
  image: ImageView,
  stride: number,
  order: readonly number[],
  y: number,
): { x0: number; pitch: number } | null {
  const w = image.width;
  let x = 0;
  while (x < w) {
    // Next white run start.
    while (x < w && luma(image, stride, order, x, y) < 192) x++;
    const start = x;
    const runStarts: number[] = [];
    const lengths: number[] = [];
    let white = true;
    let cursor = start;
    while (cursor < w) {
      const runStart = cursor;
      if (white) {
        while (cursor < w && luma(image, stride, order, cursor, y) >= 128) cursor++;
      } else {
        while (cursor < w && luma(image, stride, order, cursor, y) < 128) cursor++;
      }
      const len = cursor - runStart;
      if (len === 0) break;
      // Past the finder's end (its last black cell merging into the quiet zone, then the image
      // behind the block) runs stop matching the pitch. Measure the pitch over the first runs,
      // then stop at the first run that doesn't fit it.
      if (lengths.length >= 8) {
        const pitchSoFar = (runStart - start) / lengths.length;
        if (Math.abs(len - pitchSoFar) > runTolerance(pitchSoFar)) break;
      }
      runStarts.push(runStart);
      lengths.push(len);
      white = !white;
    }
    if (runStarts.length >= MIN_FINDER_CELLS) {
      // Use only runs whose end was seen: the pitch is the span of complete runs over their count.
      const complete = runStarts.length - 1;
      const pitch = (runStarts[complete] - start) / complete;
      // Every complete run near the pitch. Runs can't be compared with each other one by one.
      const tolerance = runTolerance(pitch);
      let regular = true;
      for (let i = 0; i < complete && regular; i++) {
        if (Math.abs(lengths[i] - pitch) > tolerance) regular = false;
      }
      // The quiet zone: two black cells before the first white one. One is not enough, because
      // stray pixels plus a single black cell can pass as a white/black pair.
      let quiet = start >= Math.ceil(1.5 * pitch);
      for (let q = 1; quiet && q <= Math.ceil(1.5 * pitch); q++) {
        if (luma(image, stride, order, start - q, y) >= 128) quiet = false;
      }
      if (pitch >= 1 && regular && quiet) return { x0: start, pitch };
    }
    // Not a finder from here: try again from the next white run, which may be the real start.
    x = runStarts.length > 2 ? runStarts[2] : start + 1;
  }
  return null;
}

/** Cell centre sample: nearest pixel for small cells, the mean of the central 2x2 from 4 px up. */
function sampleCell(
  image: ImageView,
  stride: number,
  order: readonly number[],
  loc: BlockLocation,
  cx: number,
  cy: number,
  out: number[],
): boolean {
  const fx = loc.x0 + (cx + 0.5) * loc.pitch;
  const fy = loc.y0 + (cy + 0.5) * loc.pitch;
  // Below 4 px a 2x2 mean reaches blended cell edges in a resampled window.
  if (loc.pitch >= 4) {
    const x = Math.floor(fx - 0.5);
    const y = Math.floor(fy - 0.5);
    if (x < 0 || y < 0 || x + 1 >= image.width || y + 1 >= image.height) return false;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          sum += image.data[(y + dy) * stride + (x + dx) * image.channels + order[c]];
        }
      }
      out[c] = sum / 4;
    }
  } else {
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const o = y * stride + x * image.channels;
    for (let c = 0; c < 3; c++) out[c] = image.data[o + order[c]];
  }
  return true;
}

/**
 * The previous frame's classifier while its calibration colours still match within capture noise,
 * so its colour cache (and the GPU table built from it) survives from frame to frame.
 */
let lastClassifier: ColorClassifier | null = null;
function classifierFor(samples: Uint8Array, levels: number): ColorClassifier {
  if (lastClassifier?.levels === levels && lastClassifier.matches(samples, 3)) {
    return lastClassifier;
  }
  lastClassifier = new ColorClassifier(samples, levels);
  return lastClassifier;
}

/** A 256-entry table from sampled byte to level, nearest calibrated sample, ties to the lower. */
function buildLut(samples: number[]): { lut: Uint8Array; margin: number } | null {
  let margin = Infinity;
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i] - samples[i - 1];
    if (gap <= 0) return null;
    margin = Math.min(margin, gap);
  }
  const lut = new Uint8Array(256);
  let level = 0;
  for (let v = 0; v < 256; v++) {
    while (
      level + 1 < samples.length && Math.abs(samples[level + 1] - v) < Math.abs(samples[level] - v)
    ) {
      level++;
    }
    lut[v] = level;
  }
  return { lut, margin };
}

export interface DecodeOptions {
  /**
   * Decode only a nearest-sampled grid at most this many samples a side (as `downsampleDepth`),
   * reading those samples by random access instead of the whole stream. The header and the
   * trailer are still checked. The GPU path uses this for the small debug/VR grid and decodes the
   * full plane in a shader.
   */
  depthGrid?: number;
  /** Diagnostics only: accept a header whose checksum (and trailer) does not match. */
  ignoreChecksum?: boolean;
  /** Diagnostics only: the raw header words and the preamble's two words, before checks. */
  onHeaderWords?: (head: Uint32Array, preamble0: number, preamble1: number) => void;
}

export function decodeImage(
  image: ImageView,
  hint?: BlockLocation,
  options: DecodeOptions = {},
): DecodeResult {
  const location = locateBlock(image, hint);
  if (!location) return { ok: false, reason: "not-found" };
  const stride = image.stride ?? image.width * image.channels;
  const order = image.order ?? [0, 1, 2];
  const px = [0, 0, 0];

  // Threshold between the finder's white and black cells.
  if (!sampleCell(image, stride, order, location, 0, 0, px)) {
    return { ok: false, reason: "out-of-bounds", location };
  }
  const white = Math.max(px[0], px[1], px[2]);
  if (!sampleCell(image, stride, order, location, 1, 0, px)) {
    return { ok: false, reason: "out-of-bounds", location };
  }
  const black = Math.max(px[0], px[1], px[2]);
  const mid = (white + black) / 2;

  const preamble = [0, 0];
  for (let i = 0; i < PREAMBLE_BITS; i++) {
    if (!sampleCell(image, stride, order, location, i, 1, px)) {
      return { ok: false, reason: "out-of-bounds", location };
    }
    if (Math.max(px[0], px[1], px[2]) > mid) preamble[i >> 5] |= 1 << (i & 31);
  }
  const p0 = preamble[0] >>> 0;
  const version = p0 & 0xff;
  const calibration3D = ((p0 >>> 8) & CALIBRATION_3D) !== 0;
  const bits = [(p0 >>> 8) & 0x7f, (p0 >>> 16) & 0xff, (p0 >>> 24) & 0xff] as const;
  const gridWidth = preamble[1] & 0xffff;
  const gridHeight = preamble[1] >>> 16;
  if (
    version !== VERSION || bits.some((b) => b < 1 || b > 8) || gridWidth < PREAMBLE_BITS ||
    (calibration3D && (bits[0] !== bits[1] || bits[1] !== bits[2] || bits[0] > MAX_3D_BITS))
  ) {
    return {
      ok: false,
      reason: "bad-preamble",
      detail: `0x${p0.toString(16)} 0x${(preamble[1] >>> 0).toString(16)}`,
      location,
    };
  }
  const right = location.x0 + gridWidth * location.pitch;
  const bottom = location.y0 + gridHeight * location.pitch;
  if (right > image.width + 0.5 || bottom > image.height + 0.5) {
    return { ok: false, reason: "out-of-bounds", location };
  }

  const cellAt = (index: number, out: number[]) =>
    sampleCell(
      image,
      stride,
      order,
      location,
      index % gridWidth,
      Math.floor(index / gridWidth),
      out,
    );

  const luts: Uint8Array[] = [];
  let calibrationMargin = Infinity;
  let cell = 2 * gridWidth;
  let classifier: ColorClassifier | null = null;
  if (calibration3D) {
    const n = 1 << bits[0];
    const samples = new Uint8Array(n ** 3 * 3);
    for (let k = 0; k < n ** 3; k++, cell++) {
      if (!cellAt(cell, px)) return { ok: false, reason: "out-of-bounds", location };
      for (let c = 0; c < 3; c++) samples[k * 3 + c] = Math.round(px[c]);
    }
    classifier = classifierFor(samples, n);
    // Two combinations closer than a few byte values can't be told apart under capture noise.
    if (classifier.margin < 1.5) {
      return {
        ok: false,
        reason: "bad-calibration",
        detail: `3D margin ${classifier.margin.toFixed(1)}`,
        location,
      };
    }
    calibrationMargin = classifier.margin;
  }
  for (let c = 0; c < 3 && !calibration3D; c++) {
    const samples: number[] = [];
    for (let level = 0; level < 1 << bits[c]; level++, cell++) {
      if (!cellAt(cell, px)) return { ok: false, reason: "out-of-bounds", location };
      samples.push(px[c]);
    }
    const built = buildLut(samples);
    if (!built) return { ok: false, reason: "bad-calibration", detail: `channel ${c}`, location };
    luts.push(built.lut);
    calibrationMargin = Math.min(calibrationMargin, built.margin);
  }

  // Header first, so a wrong guess about the rest costs little.
  const bitsPerCell = bits[0] + bits[1] + bits[2];
  const dataStartRow = 2 +
    Math.ceil(
      (calibration3D ? (1 << bits[0]) ** 3 : (1 << bits[0]) + (1 << bits[1]) + (1 << bits[2])) /
        gridWidth,
    );
  const dataStart = dataStartRow * gridWidth;
  // Most live frames use one-pixel cells. Precompute their pixel addresses once instead of
  // repeatedly mapping cell coordinates and sampling three channels for every decoded word.
  const direct = location.pitch < 4;
  const columnOffsets = direct
    ? Int32Array.from(
      { length: gridWidth },
      (_, x) => Math.floor(location.x0 + (x + 0.5) * location.pitch) * image.channels,
    )
    : null;
  const rowOffsets = direct
    ? Int32Array.from(
      { length: gridHeight },
      (_, y) => Math.floor(location.y0 + (y + 0.5) * location.pitch) * stride,
    )
    : null;
  const shiftG = bits[0], shiftB = bits[0] + bits[1];
  const pack = classifier
    ? (r: number, g: number, b: number) => classifier!.classifyPacked(r, g, b, bits[0])
    : (r: number, g: number, b: number) =>
      luts[0][r] | (luts[1][g] << shiftG) | (luts[2][b] << shiftB);
  const readWords = (count: number, words: Uint32Array): boolean => {
    const needCells = Math.ceil((count * 32) / bitsPerCell);
    let bit = 0;
    for (let s = 0; s < needCells; s++) {
      let packed: number;
      if (direct) {
        const cell = dataStart + s, row = Math.floor(cell / gridWidth), column = cell % gridWidth;
        const x = columnOffsets![column], y = rowOffsets![row];
        if (
          x < 0 || y < 0 || x >= image.width * image.channels || row >= gridHeight ||
          y >= image.height * stride
        ) return false;
        const at = y + x;
        packed = pack(
          image.data[at + order[0]],
          image.data[at + order[1]],
          image.data[at + order[2]],
        );
      } else {
        if (!cellAt(dataStart + s, px)) return false;
        packed = pack(Math.round(px[0]), Math.round(px[1]), Math.round(px[2]));
      }
      const w = bit >>> 5, shift = bit & 31;
      if (w < count) words[w] |= packed << shift;
      if (shift + bitsPerCell > 32 && w + 1 < count) words[w + 1] |= packed >>> (32 - shift);
      bit += bitsPerCell;
    }
    return true;
  };

  // Random access: `count` (<= 32) bits starting at stream bit `bit`, or -1 out of bounds.
  const cellBits = (cellIndex: number): number => {
    const cell = dataStart + cellIndex;
    if (direct) {
      const row = Math.floor(cell / gridWidth), column = cell % gridWidth;
      if (row >= gridHeight) return -1;
      const x = columnOffsets![column], y = rowOffsets![row];
      if (x < 0 || y < 0 || x >= image.width * image.channels || y >= image.height * stride) {
        return -1;
      }
      const at = y + x;
      return pack(image.data[at + order[0]], image.data[at + order[1]], image.data[at + order[2]]);
    }
    if (!cellAt(cell, px)) return -1;
    return pack(Math.round(px[0]), Math.round(px[1]), Math.round(px[2]));
  };
  const readBitsAt = (bit: number, count: number): number => {
    let value = 0, got = 0;
    while (got < count) {
      const cellIndex = Math.floor((bit + got) / bitsPerCell);
      const offset = (bit + got) % bitsPerCell;
      const packed = cellBits(cellIndex);
      if (packed < 0) return -1;
      const take = Math.min(bitsPerCell - offset, count - got);
      value += ((packed >>> offset) & ((1 << take) - 1)) * 2 ** got;
      got += take;
    }
    return value;
  };

  const head = new Uint32Array(HEADER_WORDS);
  if (!readWords(HEADER_WORDS, head)) return { ok: false, reason: "out-of-bounds", location };
  if (head[H.magic] !== MAGIC) return { ok: false, reason: "bad-magic", location };
  if (!options.ignoreChecksum && fnv1aWords(head, H.checksum) !== head[H.checksum]) {
    return { ok: false, reason: "bad-checksum", location };
  }
  if (options.onHeaderWords) options.onHeaderWords(head, p0, preamble[1] >>> 0);
  if (head[H.layout] !== p0 || head[H.grid] !== preamble[1] >>> 0) {
    return {
      ok: false,
      reason: "bad-preamble",
      detail: "header disagrees with preamble",
      location,
    };
  }

  if (head[H.levelInset] > MAX_LEVEL_INSET) {
    return { ok: false, reason: "bad-preamble", detail: "level inset", location };
  }
  const layout = deriveLayout({
    bits,
    gridWidth,
    depthWidth: head[H.depthSize] & 0xffff,
    depthHeight: head[H.depthSize] >>> 16,
    lightingWords: head[H.lightingWords],
    calibration3D,
    levelInset: head[H.levelInset],
  });
  if (layout.gridHeight !== gridHeight) {
    return {
      ok: false,
      reason: "bad-preamble",
      detail: "grid height does not match the depth size",
      location,
    };
  }
  const sparse = options.depthGrid != null &&
    (options.depthGrid < layout.depthWidth || options.depthGrid < layout.depthHeight);
  const trailer = readBitsAt(layout.trailerStartCell * bitsPerCell, 32);
  if (trailer < 0) return { ok: false, reason: "out-of-bounds", location };
  if (!options.ignoreChecksum && trailer >>> 0 !== head[H.timeTag]) {
    return {
      ok: false,
      reason: "torn",
      detail: `trailer 0x${(trailer >>> 0).toString(16)}`,
      location,
    };
  }
  let words: Uint32Array;
  if (sparse) {
    words = head;
  } else {
    words = new Uint32Array(layout.headWords);
    if (!readWords(layout.headWords, words)) {
      return { ok: false, reason: "out-of-bounds", location };
    }
  }
  const timeTag = words[H.timeTag];

  const header: DepthFrameHeader = {
    timeTag,
    eye: words[H.eye] & 0xff,
    flags: words[H.eye] >>> 8,
    viewToWorld: Array.from({ length: 12 }, (_, i) => bitsFloat(words[H.viewToWorld + i])),
    projection: {
      m00: bitsFloat(words[H.projection]),
      m11: bitsFloat(words[H.projection + 1]),
      m02: bitsFloat(words[H.projection + 2]),
      m12: bitsFloat(words[H.projection + 3]),
    },
    near: bitsFloat(words[H.near]),
    far: bitsFloat(words[H.far]),
    screenWidth: bitsFloat(words[H.screenWidth]),
    screenHeight: bitsFloat(words[H.screenHeight]),
    depthRef: bitsFloat(words[H.depthRef]),
    depthFar: bitsFloat(words[H.depthFar]),
    anchorToWorld: Array.from({ length: 12 }, (_, i) => bitsFloat(words[H.anchorToWorld + i])),
    lighting: Array.from({ length: layout.lightingWords }, (_, i) => {
      if (!sparse) return bitsFloat(words[HEADER_WORDS + i]);
      const w = readBitsAt((HEADER_WORDS + i) * 32, 32);
      return w < 0 ? NaN : bitsFloat(w >>> 0);
    }),
  };
  const near = header.depthRef, far = header.depthFar!;
  if (!(near > 0) || !(far > near)) {
    return { ok: false, reason: "bad-preamble", detail: `depth range ${near}..${far}`, location };
  }
  let depth: Float32Array;
  let outWidth = layout.depthWidth, outHeight = layout.depthHeight;
  if (sparse) {
    outWidth = Math.min(options.depthGrid!, layout.depthWidth);
    outHeight = Math.min(options.depthGrid!, layout.depthHeight);
    depth = new Float32Array(outWidth * outHeight);
    for (let j = 0; j < outHeight; j++) {
      const sy = Math.min(
        layout.depthHeight - 1,
        Math.floor((j + 0.5) * layout.depthHeight / outHeight),
      );
      for (let i = 0; i < outWidth; i++) {
        const sx = Math.min(
          layout.depthWidth - 1,
          Math.floor((i + 0.5) * layout.depthWidth / outWidth),
        );
        const q = cellBits(layout.depthStartCell + sy * layout.depthWidth + sx);
        if (q < 0) return { ok: false, reason: "out-of-bounds", location };
        depth[j * outWidth + i] = dequantizeDepth(q, near, far, bitsPerCell);
      }
    }
  } else {
    const samples = layout.depthWidth * layout.depthHeight;
    depth = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const q = cellBits(layout.depthStartCell + i);
      if (q < 0) return { ok: false, reason: "out-of-bounds", location };
      depth[i] = dequantizeDepth(q, near, far, bitsPerCell);
    }
  }
  const lutBytes = new Uint8Array(768);
  for (let c = 0; c < luts.length; c++) lutBytes.set(luts[c], c * 256);
  return {
    ok: true,
    frame: { layout, header, depth, width: outWidth, height: outHeight },
    location,
    calibrationMargin,
    luts: lutBytes,
    classifier,
  };
}

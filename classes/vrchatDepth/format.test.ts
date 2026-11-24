import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type ChannelBits,
  decodeImage,
  DEFAULT_DEPTH_FAR,
  type DepthFrameHeader,
  dequantizeDepth,
  deriveLayout,
  drawCells,
  encodeCells,
  floatBits,
  type ImageView,
  LIGHTING_WORDS,
  levelByte,
  quantizeDepth,
} from "./format.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 0x100000000;
  };
}

function header(timeTag = floatBits(123.456)): DepthFrameHeader {
  return {
    timeTag,
    eye: 0,
    flags: 5,
    viewToWorld: [1, 0, 0, 1.5, 0, 1, 0, 1.62, 0, 0, 1, -3.25],
    projection: { m00: 0.8, m11: 0.72, m02: -0.05, m12: 0.01 },
    near: 0.01,
    far: 1000,
    screenWidth: 2016,
    screenHeight: 2240,
    depthRef: 0.05,
    anchorToWorld: [0, 0, -1, 1.25, 0, 1, 0, 1.55, 1, 0, 0, -3.5],
  };
}

function depthField(w: number, h: number): Float32Array {
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sky in one corner, a near "hand", a sloped floor elsewhere.
      const i = y * w + x;
      if (x < w / 6 && y < h / 6) depth[i] = 0;
      else if (Math.hypot(x - w / 2, y - h / 2) < w / 8) depth[i] = 0.35;
      else depth[i] = 1 + (y / h) * 9;
    }
  }
  return depth;
}

function noisyImage(width: number, height: number, seed: number): ImageView {
  const r = rng(seed);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  return { width, height, data, channels: 4 };
}

function setup(bits: ChannelBits, depthW = 48, depthH = 40) {
  const layout = deriveLayout({ bits, gridWidth: 96, depthWidth: depthW, depthHeight: depthH });
  const depth = depthField(depthW, depthH);
  const h = header();
  return { layout, depth, h, cells: encodeCells(layout, h, depth) };
}

function assertDepthMatches(decoded: Float32Array, source: Float32Array, bits: number) {
  assertEquals(decoded.length, source.length);
  // The header carries near and far as float32.
  const near = Math.fround(header().depthRef), far = Math.fround(DEFAULT_DEPTH_FAR);
  for (let i = 0; i < source.length; i++) {
    const expected = dequantizeDepth(quantizeDepth(source[i], near, far, bits), near, far, bits);
    if (decoded[i] !== Math.fround(expected)) {
      throw new Error(`sample ${i}: got ${decoded[i]}, expected ${expected}`);
    }
  }
}

for (const bits of [[8, 8, 8], [7, 7, 6], [6, 6, 6], [4, 4, 4], [1, 1, 1]] as ChannelBits[]) {
  Deno.test(`round trip, ${bits.join("/")} bits, one pixel per cell on a noisy background`, () => {
    const { layout, depth, h, cells } = setup(bits);
    const image = noisyImage(layout.gridWidth + 40, layout.gridHeight + 30, 7);
    drawCells(image, layout, cells, 17, 11, 1);
    const result = decodeImage(image);
    if (!result.ok) throw new Error(`decode failed: ${result.reason} ${result.detail ?? ""}`);
    assertEquals(result.location.x0, 17);
    assertEquals(result.location.y0, 11);
    assertEquals(result.location.pitch, 1);
    assertEquals(result.frame.header.timeTag, h.timeTag);
    assertEquals(result.frame.header.flags, 5);
    assertEquals(
      result.frame.header.viewToWorld.map((v) => Math.fround(v)),
      h.viewToWorld.map(Math.fround),
    );
    assertEquals(
      result.frame.header.anchorToWorld.map((v) => Math.fround(v)),
      h.anchorToWorld.map(Math.fround),
    );
    assertAlmostEquals(result.frame.header.projection.m02, -0.05, 1e-7);
    assertDepthMatches(result.frame.depth, depth, layout.bitsPerCell);
  });
}

Deno.test("a monotonic tone curve on the whole block cancels through calibration", () => {
  const { layout, depth, h, cells } = setup([6, 6, 6]);
  const image = noisyImage(layout.gridWidth * 2 + 20, layout.gridHeight * 2 + 20, 3);
  drawCells(image, layout, cells, 10, 10, 2);
  // Gamma, lifted blacks and compressed whites, applied only inside the block (like post-processing).
  for (let y = 10; y < 10 + layout.gridHeight * 2; y++) {
    for (let x = 10; x < 10 + layout.gridWidth * 2; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * image.width + x) * 4 + c;
        const v = image.data[o] / 255;
        image.data[o] = Math.round(255 * (0.04 + 0.9 * Math.pow(v, 0.8)));
      }
    }
  }
  const result = decodeImage(image);
  if (!result.ok) throw new Error(`decode failed: ${result.reason} ${result.detail ?? ""}`);
  assert(result.calibrationMargin >= 2, `margin ${result.calibrationMargin}`);
  assertDepthMatches(result.frame.depth, depth, layout.bitsPerCell);
});

/** Bilinear resample of an RGBA image, as a scaled window would be. */
function resample(src: ImageView, scale: number): ImageView {
  const width = Math.floor(src.width * scale);
  const height = Math.floor(src.height * scale);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) / scale - 0.5));
      const sy = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 4; c++) {
        const at = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c];
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        data[(y * width + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data, channels: 4 };
}

for (const scale of [0.75, 0.5, 1.333]) {
  Deno.test(`a window scaled by ${scale} decodes with 4-pixel cells`, () => {
    const { layout, depth, h, cells } = setup([6, 6, 6]);
    const image = noisyImage(layout.gridWidth * 4 + 64, layout.gridHeight * 4 + 64, 11);
    drawCells(image, layout, cells, 32, 32, 4);
    const result = decodeImage(resample(image, scale));
    if (!result.ok) throw new Error(`decode failed: ${result.reason} ${result.detail ?? ""}`);
    assertAlmostEquals(result.location.pitch, 4 * scale, 0.05);
    assertDepthMatches(result.frame.depth, depth, layout.bitsPerCell);
  });
}

Deno.test("BGRA images with padded rows decode", () => {
  const { layout, depth, h, cells } = setup([7, 7, 6]);
  const width = layout.gridWidth + 8;
  const height = layout.gridHeight + 8;
  const stride = width * 4 + 16;
  const image: ImageView = {
    width,
    height,
    data: new Uint8Array(stride * height),
    channels: 4,
    stride,
    order: [2, 1, 0],
  };
  drawCells(image, layout, cells, 4, 4, 1);
  const result = decodeImage(image);
  if (!result.ok) throw new Error(`decode failed: ${result.reason}`);
  assertDepthMatches(result.frame.depth, depth, layout.bitsPerCell);
});

Deno.test("a capture mixing two frames is rejected as torn", () => {
  const { layout, depth } = setup([6, 6, 6]);
  const a = encodeCells(layout, header(floatBits(1.0)), depth);
  const b = encodeCells(layout, header(floatBits(1.011)), depth);
  // Top half from frame a, bottom half from frame b.
  const mixed = a.slice();
  const half = Math.floor(layout.gridHeight / 2) * layout.gridWidth * 3;
  mixed.set(b.subarray(half), half);
  const image = noisyImage(layout.gridWidth + 4, layout.gridHeight + 4, 5);
  drawCells(image, layout, mixed, 2, 2, 1);
  const result = decodeImage(image);
  assertEquals(result.ok ? "ok" : result.reason, "torn");
});

Deno.test("a damaged header fails its checksum", () => {
  const { layout, cells } = setup([6, 6, 6]);
  const image = noisyImage(layout.gridWidth + 4, layout.gridHeight + 4, 9);
  // Flip one bit's worth of a cell inside the camera matrix words.
  const damaged = cells.slice();
  const cell = (layout.dataStartRow * layout.gridWidth + 40) * 3;
  damaged[cell] = damaged[cell] > 128 ? 0 : 255;
  drawCells(image, layout, damaged, 2, 2, 1);
  const result = decodeImage(image);
  assertEquals(result.ok ? "ok" : result.reason, "bad-checksum");
});

Deno.test("an image without a block reports not-found", () => {
  const result = decodeImage(noisyImage(400, 300, 1));
  assertEquals(result.ok ? "ok" : result.reason, "not-found");
});

Deno.test("the previous location is reused when the block has not moved", () => {
  const { layout, cells } = setup([6, 6, 6]);
  const image = noisyImage(layout.gridWidth * 2 + 50, layout.gridHeight * 2 + 50, 2);
  drawCells(image, layout, cells, 25, 30, 2);
  const first = decodeImage(image);
  if (!first.ok) throw new Error(first.reason);
  const second = decodeImage(image, first.location);
  if (!second.ok) throw new Error(second.reason);
  assertEquals(second.location, first.location);
});

Deno.test("log depth keeps the same relative step at any distance", () => {
  // 12 bits over 0.05..1000 m: half a step is ln(20000) / 4094 / 2 = 0.121 %.
  for (const d of [0.1, 0.3, 1, 5, 50, 500]) {
    const back = dequantizeDepth(quantizeDepth(d, 0.05, 1000, 12), 0.05, 1000, 12);
    assert(Math.abs(back - d) / d <= 0.00122, `${d} -> ${back}`);
  }
  assertEquals(quantizeDepth(0, 0.05, 1000, 12), 0);
  assertEquals(quantizeDepth(Infinity, 0.05, 1000, 12), 0);
  assertEquals(quantizeDepth(0.001, 0.05, 1000, 12), 1);
  assertEquals(quantizeDepth(5000, 0.05, 1000, 12), 4095);
  assertAlmostEquals(dequantizeDepth(1, 0.05, 1000, 12), 0.05);
});

Deno.test("level inset keeps level bytes inside the range", () => {
  assertEquals([0, 15].map((l) => levelByte(l, 4)), [0, 255]);
  assertEquals([0, 15].map((l) => levelByte(l, 4, 16)), [16, 223]);
});

Deno.test("layout sizes for the planned depth grids", () => {
  const small = deriveLayout({ bits: [6, 6, 6], gridWidth: 128, depthWidth: 64, depthHeight: 64 });
  // 48 header words + 130 lighting words at 18 bits per cell, a cell per sample, 2 trailer cells.
  assertEquals(small.headCells, Math.ceil((178 * 32) / 18));
  assertEquals(small.depthStartCell, small.headCells);
  assertEquals(small.dataCells, small.headCells + 64 * 64 + 2);
  assertEquals(small.dataStartRow, 4);
  assertEquals(small.gridHeight, 4 + Math.ceil(small.dataCells / 128));
});

for (const bits of [[8, 8, 8], [6, 6, 6], [4, 4, 4]] as ChannelBits[]) {
  Deno.test(`sparse grid decode matches a nearest downsample of the full plane, ${bits.join("/")}`, () => {
    const { layout, depth, h, cells } = setup(bits, 64, 50);
    const image = noisyImage(140, 160, 3);
    drawCells(image, layout, cells, 7, 5, 1);
    const full = decodeImage(image);
    const sparse = decodeImage(image, undefined, { depthGrid: 16 });
    assert(full.ok && sparse.ok);
    assertEquals([sparse.frame.width, sparse.frame.height], [16, 16]);
    assertEquals(sparse.frame.header, full.frame.header);
    assertEquals(sparse.luts, full.luts);
    for (let j = 0; j < 16; j++) {
      const sy = Math.floor((j + 0.5) * 50 / 16);
      for (let i = 0; i < 16; i++) {
        const sx = Math.floor((i + 0.5) * 64 / 16);
        assertEquals(sparse.frame.depth[j * 16 + i], full.frame.depth[sy * 64 + sx]);
      }
    }
    assertEquals(depth.length, 64 * 50);
    // A grid at least the depth size decodes everything.
    const whole = decodeImage(image, undefined, { depthGrid: 64 });
    assert(whole.ok);
    assertEquals(whole.frame.depth, full.frame.depth);
  });
}

Deno.test("the lighting record round-trips between the header and the depth", () => {
  const layout = deriveLayout({ bits: [8, 8, 8], gridWidth: 96, depthWidth: 48, depthHeight: 40 });
  const depth = depthField(48, 40);
  const lighting = Array.from({ length: LIGHTING_WORDS }, (_, i) => Math.fround(i * 0.37 - 20));
  const h = { ...header(), lighting };
  const image = noisyImage(layout.gridWidth + 20, layout.gridHeight + 20, 11);
  drawCells(image, layout, encodeCells(layout, h, depth), 5, 6, 1);
  for (const options of [{}, { depthGrid: 8 }]) {
    const result = decodeImage(image, undefined, options);
    if (!result.ok) throw new Error(`decode failed: ${result.reason}`);
    assertEquals(result.frame.header.lighting, lighting);
    assertEquals(result.frame.layout.headWords, 48 + LIGHTING_WORDS);
  }
  const full = decodeImage(image);
  assert(full.ok);
  assertDepthMatches(full.frame.depth, depth, layout.bitsPerCell);
});

/**
 * The Avatar Testing Chamber's grade as measured live (`testdata/chamberGrade.json`, 2026-11-07):
 * the observed colour of every 4-bit level combination, applied by trilinear interpolation, plus
 * ±1 capture noise. Mid-tones pass almost unchanged; highlights roll off to 240, and saturated
 * colours crush their weakest channel (blue levels 0 and 1 meet under bright yellow) and lift
 * red's low levels. Per-channel calibration can't see the mixing.
 */
const chamber = JSON.parse(
  Deno.readTextFileSync(new URL("./testdata/chamberGrade.json", import.meta.url)),
) as { levels: number; samples: number[] };
function chamberGrade(rgb: readonly number[]): number[] {
  const n = chamber.levels, step = 255 / (n - 1);
  const at = rgb.map((v) => Math.min(n - 1.000001, v / step));
  const i0 = at.map(Math.floor), f = at.map((v, c) => v - i0[c]);
  const out = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const k = (i0[0] + d[0]) + (i0[1] + d[1]) * n + (i0[2] + d[2]) * n * n;
    const w = d.reduce((p, bit, c) => p * (bit ? f[c] : 1 - f[c]), 1);
    for (let c = 0; c < 3; c++) out[c] += w * chamber.samples[k * 3 + c];
  }
  return out;
}
function gradeImage(image: ImageView, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < image.data.length; i += 4) {
    const out = chamberGrade([image.data[i], image.data[i + 1], image.data[i + 2]]).map((v) =>
      Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 2)))
    );
    image.data.set(out, i);
  }
}

Deno.test("3D calibration with a level inset decodes through the chamber's grade", () => {
  const depth = depthField(48, 40);
  const h = { ...header(), lighting: Array.from({ length: LIGHTING_WORDS }, (_, i) => i * 1.5) };
  const decode = (calibration3D: boolean, levelInset: number) => {
    const layout = deriveLayout({
      bits: [4, 4, 4],
      gridWidth: 512,
      depthWidth: 48,
      depthHeight: 40,
      calibration3D,
      levelInset,
    });
    const image = noisyImage(layout.gridWidth + 20, layout.gridHeight + 20, 5);
    drawCells(image, layout, encodeCells(layout, h, depth), 6, 7, 1);
    gradeImage(image, 9);
    return decodeImage(image);
  };
  const one = decode(false, 16);
  assert(!one.ok, "per-channel calibration should fail under channel mixing");
  const corners = decode(true, 0);
  assert(!corners.ok || corners.calibrationMargin < 4, "full range should collapse in the corners");
  const three = decode(true, 16);
  if (!three.ok) throw new Error(`3D decode failed: ${three.reason} ${three.detail ?? ""}`);
  assertEquals(three.frame.header.lighting, h.lighting);
  assertDepthMatches(three.frame.depth, depth, three.frame.layout.bitsPerCell);
  assert(three.calibrationMargin >= 7, `margin ${three.calibrationMargin}`);
});

Deno.test("3D calibration needs equal channel bits", () => {
  let threw = false;
  try {
    deriveLayout({ bits: [6, 6, 5], gridWidth: 256, depthWidth: 8, depthHeight: 8, calibration3D: true });
  } catch {
    threw = true;
  }
  assert(threw);
});

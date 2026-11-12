/**
 * A font baked by pmndrs/glyph (`glyph bake --slug`) into a `.font.glb`: its Slug curve data, read
 * for drawing with our GLSL port of Glyph's shader ({@link GlyphTextRenderer}).
 *
 * The format and how the files are made are in markdown/glyph-portable-text.md. In short: a glTF
 * binary whose `PMNDRS_font` extension carries a subset sfnt (for the cmap) and whose
 * `PMNDRS_font_slug` extension carries one 40-byte record per glyph ID and pages of three textures:
 * curves (RGBA16F, in an uncompressed KTX2), band headers (R32UI) and curve references (R16UI).
 */

export type GlyphFontPage = {
  curves: { bytes: Uint8Array; width: number; height: number };
  headers: { bytes: Uint8Array; width: number; height: number };
  references: { bytes: Uint8Array; width: number; height: number };
};

/** One drawable glyph: its page, em-space bounds and the record fields the shader needs. */
export type GlyphFontGlyph = {
  page: number;
  /** min x, min y, max x, max y, in em (Y up). */
  bounds: [number, number, number, number];
  curveBase: number;
  horizontalHeaderBase: number;
  verticalHeaderBase: number;
  referenceBase: number;
  horizontalBands: number;
  verticalBands: number;
};

export type GlyphFont = {
  pages: GlyphFontPage[];
  /** By code point; characters without an outline (space) are absent. */
  glyphs: Map<number, GlyphFontGlyph>;
  /** Packer gaps filled while loading (see {@link fillContinuationGaps}). */
  gapsFilled: number;
};

const RECORD_STRIDE = 40;
const ABSENT_PAGE = 0xFFFF;
const PLANE_UNITS_PER_EM = 2048;
const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
const VK_FORMAT_R16G16B16A16_SFLOAT = 97;

type Json = Record<string, unknown>;

export function parseGlyphFont(file: Uint8Array): GlyphFont {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== 0x46546C67 || view.getUint32(4, true) !== 2) {
    throw new Error("Not a glTF 2 binary");
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4E4F534A) throw new Error("glTF: first chunk is not JSON");
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength))) as Json;
  const binStart = 20 + jsonLength;
  if (view.getUint32(binStart + 4, true) !== 0x004E4942) throw new Error("glTF: no BIN chunk");
  const bin = file.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true));

  const bufferViews = json.bufferViews as { byteOffset?: number; byteLength: number }[];
  const bufferView = (index: number) => {
    const entry = bufferViews[index];
    if (entry == null) throw new Error(`glTF: missing bufferView ${index}`);
    const offset = entry.byteOffset ?? 0;
    return bin.subarray(offset, offset + entry.byteLength);
  };
  const extensions = json.extensions as Json | undefined;
  const font = extensions?.PMNDRS_font as Json | undefined;
  const slug = extensions?.PMNDRS_font_slug as Json | undefined;
  if (font == null || slug == null) throw new Error("Not a Glyph font with Slug data");
  if (slug.version !== 0 || slug.recordStride !== RECORD_STRIDE) {
    throw new Error(`Unsupported Slug data (version ${slug.version})`);
  }
  if (slug.planeUnitsPerEm !== PLANE_UNITS_PER_EM) throw new Error("Unexpected Slug plane units");

  const pages = (slug.pages as Json[]).map((page): GlyphFontPage => {
    const curve = page.curve as Json;
    const variant = (curve.variants as Json[]).find((v) => v.container === "ktx2");
    if (variant == null) throw new Error("Slug curves: no KTX2 variant");
    const width = curve.width as number;
    const height = curve.height as number;
    const resource = (key: string) =>
      bufferView(((page[key] as Json).source as Json).bufferView as number);
    return {
      curves: {
        // A copy: the gap fill below writes into it.
        bytes: ktx2Level(bufferView((variant.source as Json).bufferView as number), width, height)
          .slice(),
        width,
        height,
      },
      headers: {
        bytes: resource("headerResource"),
        width: page.headerWidth as number,
        height: page.headerHeight as number,
      },
      references: {
        bytes: resource("referenceResource"),
        width: page.referenceWidth as number,
        height: page.referenceHeight as number,
      },
    };
  });

  const records = bufferView(slug.recordBufferView as number);
  const recordView = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const cmap = readCmap(bufferView((font.shaping as Json).bufferView as number));
  const glyphs = new Map<number, GlyphFontGlyph>();
  let gapsFilled = 0;
  const filled = new Set<number>();
  for (const [code, glyphId] of cmap) {
    const offset = glyphId * RECORD_STRIDE;
    if (offset + RECORD_STRIDE > records.byteLength) continue;
    const page = recordView.getUint16(offset + 8, true);
    if (page === ABSENT_PAGE) continue;
    const glyph: GlyphFontGlyph = {
      page,
      bounds: [
        recordView.getInt16(offset, true) / PLANE_UNITS_PER_EM,
        recordView.getInt16(offset + 2, true) / PLANE_UNITS_PER_EM,
        recordView.getInt16(offset + 4, true) / PLANE_UNITS_PER_EM,
        recordView.getInt16(offset + 6, true) / PLANE_UNITS_PER_EM,
      ],
      horizontalBands: recordView.getUint16(offset + 10, true),
      verticalBands: recordView.getUint16(offset + 12, true),
      curveBase: recordView.getUint32(offset + 16, true),
      horizontalHeaderBase: recordView.getUint32(offset + 24, true),
      verticalHeaderBase: recordView.getUint32(offset + 28, true),
      referenceBase: recordView.getUint32(offset + 32, true),
    };
    glyphs.set(code, glyph);
    if (!filled.has(glyphId)) {
      filled.add(glyphId);
      gapsFilled += fillContinuationGaps(
        pages[page]!.curves,
        glyph.curveBase,
        recordView.getUint32(offset + 20, true),
      );
    }
  }
  return { pages, glyphs, gapsFilled };
}

/**
 * The pinned packer never starts a curve in a row's last texel: it leaves that texel zero and
 * continues on the next row. But each curve's end point is read from the texel after it, so a
 * curve in the second-to-last texel would end at (0, 0). Fill the gap with the next texel's start
 * point, as the native loader does.
 *
 * The native loader knows the contours; this file does not. A zero last-column texel could also be
 * a contour genuinely closing at (0, 0) em. utils/glyph-bake/check_slug.py rejects baked fonts
 * where that is possible, so for the shipped files this is exact.
 */
export function fillContinuationGaps(
  curves: { bytes: Uint8Array; width: number },
  base: number,
  span: number,
): number {
  let count = 0;
  for (let texel = base; texel + 1 < base + span; texel++) {
    if (texel % curves.width !== curves.width - 1) continue;
    const at = texel * 8;
    if (curves.bytes.subarray(at, at + 8).some((byte) => byte !== 0)) continue;
    curves.bytes.copyWithin(at, at + 8, at + 12);
    count++;
  }
  return count;
}

/** The single level of an uncompressed KTX2 texture. */
function ktx2Level(file: Uint8Array, width: number, height: number): Uint8Array {
  if (!KTX2_IDENTIFIER.every((byte, i) => file[i] === byte)) throw new Error("Not a KTX2 file");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(12, true) !== VK_FORMAT_R16G16B16A16_SFLOAT) {
    throw new Error("Slug curves: expected RGBA16F");
  }
  if (view.getUint32(20, true) !== width || view.getUint32(24, true) !== height) {
    throw new Error("Slug curves: size does not match the page");
  }
  if (view.getUint32(44, true) !== 0) throw new Error("Slug curves: supercompressed KTX2");
  const offset = Number(view.getBigUint64(80, true));
  const length = Number(view.getBigUint64(88, true));
  if (length !== width * height * 8) throw new Error("Slug curves: unexpected level size");
  return file.subarray(offset, offset + length);
}

/** Code point → glyph ID from an sfnt's cmap (format 12 preferred, else format 4). */
export function readCmap(sfnt: Uint8Array): Map<number, number> {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = view.getUint16(4, false);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (view.getUint32(record, false) === 0x636D6170) cmap = view.getUint32(record + 8, false);
  }
  if (cmap < 0) throw new Error("Font has no cmap");
  const subtables = view.getUint16(cmap + 2, false);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < subtables; i++) {
    const offset = cmap + view.getUint32(cmap + 4 + i * 8 + 4, false);
    const format = view.getUint16(offset, false);
    if (format === 12 && format12 < 0) format12 = offset;
    if (format === 4 && format4 < 0) format4 = offset;
  }
  const result = new Map<number, number>();
  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12, false);
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + g * 12;
      const start = view.getUint32(at, false);
      const end = view.getUint32(at + 4, false);
      const first = view.getUint32(at + 8, false);
      for (let code = start; code <= end; code++) result.set(code, first + code - start);
    }
    return result;
  }
  if (format4 < 0) throw new Error("Font cmap has neither format 12 nor format 4");
  const segments = view.getUint16(format4 + 6, false) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = view.getUint16(ends + s * 2, false);
    const start = view.getUint16(starts + s * 2, false);
    const delta = view.getInt16(deltas + s * 2, false);
    const rangeOffset = view.getUint16(rangeOffsets + s * 2, false);
    for (let code = start; code <= end && code !== 0xFFFF; code++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (code + delta) & 0xFFFF;
      else {
        const at = rangeOffsets + s * 2 + rangeOffset + (code - start) * 2;
        glyph = view.getUint16(at, false);
        if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
      }
      if (glyph !== 0) result.set(code, glyph);
    }
  }
  return result;
}

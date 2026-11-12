/** Glyph placements from the existing BMFont layout, without reshaping the string. */
export type VectorTextGeometrySource = {
  visibleGlyphs?: readonly { position: readonly number[]; data: { id: number } }[];
  _options?: { font?: { info?: { size?: number; face?: string }; common?: { base?: number } } };
};

/** Packed [codepoint, penX, baselineY, emSize, outlineFont] per visible glyph. */
export function captureVectorTextGlyphs(
  source: VectorTextGeometrySource,
): Float32Array | undefined {
  const font = source._options?.font;
  const em = font?.info?.size, base = font?.common?.base;
  const face = font?.info?.face;
  if (!source.visibleGlyphs || !em || base == null) return undefined;
  if (face !== "Roboto-Regular" && face !== "MaterialIcons-Regular") return undefined;
  const packed = new Float32Array(source.visibleGlyphs.length * 5);
  source.visibleGlyphs.forEach((glyph, i) => {
    const icon = face === "MaterialIcons-Regular" && glyph.data.id >= 0xe000;
    // PetPlay's icon atlas also holds Roboto Latin-1/€, appended with --base 64.
    const baseline = face === "MaterialIcons-Regular" && !icon ? 64 : base;
    packed.set(
      [glyph.data.id, glyph.position[0], glyph.position[1] + baseline, em, icon ? 1 : 0],
      i * 5,
    );
  });
  return packed;
}

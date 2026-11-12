/** Cache CPU text data across independently decoded scene packets. */
type Geometry = {
  vectorGlyphs?: Float32Array;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  version: number;
};
type Text = { text: string; color: readonly number[]; geometry?: Geometry };

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength || a.constructor !== b.constructor) return false;
  const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

/** Retains at most the latest scene's geometries; transport identity is irrelevant. */
export class UiTextGeometryInterner {
  private previous: (Geometry | undefined)[] = [];
  intern(texts: readonly Text[]): void {
    const next: (Geometry | undefined)[] = [];
    for (let i = 0; i < texts.length; i++) {
      const source = texts[i].geometry, old = this.previous[i];
      if (
        source && old && source.version === old.version &&
        sameBytes(source.positions, old.positions) && sameBytes(source.uvs, old.uvs) &&
        sameBytes(source.indices, old.indices) &&
        (source.vectorGlyphs === old.vectorGlyphs ||
          (source.vectorGlyphs != null && old.vectorGlyphs != null &&
            sameBytes(source.vectorGlyphs, old.vectorGlyphs)))
      ) {
        texts[i].geometry = old;
      }
      next.push(texts[i].geometry);
    }
    this.previous = next;
  }
}

type Content = { text: string; color: number[]; geometry?: Geometry; version?: number };
export function captureTextBatchContent(texts: readonly Text[]): Content[] {
  return texts.map((t) => ({
    text: t.text,
    color: [...t.color],
    geometry: t.geometry,
    version: t.geometry?.version,
  }));
}
/** World transforms are checked separately because fresh tracking mutates them in place. */
export function textBatchContentMatches(
  texts: readonly Text[],
  saved: readonly Content[],
): boolean {
  return texts.length === saved.length && texts.every((t, i) => {
    const old = saved[i];
    return t.text === old.text && t.geometry === old.geometry &&
      t.geometry?.version === old.version &&
      t.color.length === old.color.length && t.color.every((v, j) => v === old.color[j]);
  });
}

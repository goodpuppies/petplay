import {
  captureTextBatchContent,
  textBatchContentMatches,
  UiTextGeometryInterner,
} from "./uiTextSnapshotCache.ts";
import { captureTextBatchTransforms, textBatchTransformsMatch } from "./uiTextBatchTransforms.ts";
function text() {
  return {
    text: "A",
    color: [1, 1, 1, 1],
    worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    geometry: {
      vectorGlyphs: new Float32Array([65, 0, 0, 80, 0]),
      positions: new Float32Array([0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint16Array([0, 1, 2]),
      version: 0,
    },
  };
}
function assert(ok: boolean, message: string) {
  if (!ok) throw new Error(message);
}
Deno.test("decoded equivalent labels retain geometry and reuse batch content", () => {
  const cache = new UiTextGeometryInterner();
  const a = [text()];
  cache.intern(a);
  const saved = captureTextBatchContent(a);
  const matrices = captureTextBatchTransforms(a);
  const b = structuredClone(a);
  cache.intern(b);
  assert(b[0] !== a[0] && b[0].geometry === a[0].geometry, "must survive fresh packet identity");
  assert(
    textBatchContentMatches(b, saved) && textBatchTransformsMatch(b, matrices),
    "equivalent scene must reuse",
  );
  b[0].worldMatrix[12] = .25;
  assert(
    !textBatchTransformsMatch(b, matrices),
    "fresh hand movement must rebuild world-baked vertices",
  );
  b[0].color[3] = .5;
  assert(
    !textBatchContentMatches(b, saved),
    "in-place opacity change must invalidate owned content",
  );
});
Deno.test("same revision and lengths cannot hide changed glyph data", () => {
  for (const part of ["positions", "uvs", "indices", "vectorGlyphs"] as const) {
    const cache = new UiTextGeometryInterner();
    const a = [text()];
    cache.intern(a);
    const saved = captureTextBatchContent(a);
    const b = structuredClone(a);
    b[0].geometry[part][1] = 2;
    cache.intern(b);
    assert(
      b[0].geometry !== a[0].geometry && !textBatchContentMatches(b, saved),
      `${part} change reused stale data`,
    );
  }
});
Deno.test("version, label removal, font geometry and slot reorder invalidate safely", () => {
  const cache = new UiTextGeometryInterner();
  const a = [text(), text()];
  a[1].geometry.uvs[0] = .25;
  cache.intern(a);
  const saved = captureTextBatchContent(a);
  const swapped = structuredClone([a[1], a[0]]);
  cache.intern(swapped);
  assert(!textBatchContentMatches(swapped, saved), "reordered geometry must invalidate");
  const b = structuredClone(a);
  b[0].geometry.version++;
  cache.intern(b);
  assert(!textBatchContentMatches(b, saved), "new revision must invalidate");
  assert(!textBatchContentMatches([], saved), "removal must invalidate");
});

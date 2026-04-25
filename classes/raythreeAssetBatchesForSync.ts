import type { AssetBatch } from "../submodules/raythree/src/ir.ts";

/**
 * If true, the WebXR overlay can skip a second `WebXRRaythreeRaylibRenderer.syncAssets` for the
 * right eye: native geometry/material/texture entries already match the left (same id+revision
 * in the same list order as emitted by a pair of extracts).
 */
export function areNativeAssetBatchesIdenticalForSync(
  a: AssetBatch,
  b: AssetBatch,
): boolean {
  if (a.geometries.length !== b.geometries.length) {
    return false;
  }
  if (a.materials.length !== b.materials.length) {
    return false;
  }
  if (a.textures.length !== b.textures.length) {
    return false;
  }
  for (let i = 0; i < a.geometries.length; i++) {
    const g = a.geometries[i]!;
    const h = b.geometries[i]!;
    if (g.id !== h.id || g.revision !== h.revision) {
      return false;
    }
  }
  for (let i = 0; i < a.materials.length; i++) {
    const g = a.materials[i]!;
    const h = b.materials[i]!;
    if (g.id !== h.id || g.revision !== h.revision) {
      return false;
    }
  }
  for (let i = 0; i < a.textures.length; i++) {
    const g = a.textures[i]!;
    const h = b.textures[i]!;
    if (g.id !== h.id || g.revision !== h.revision) {
      return false;
    }
  }
  return true;
}

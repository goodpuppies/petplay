import type * as THREE from "three";

export type PetplayOverlayRole = "auto" | "panorama" | "panel" | "stereo" | "quad" | "pointer";

/**
 * Typed render metadata attached to a Three.js subtree via `<PetplayElement renderProps={...}>`
 * and forwarded onto Raythree `RenderInstance.renderProps` by `anchoredLowerers()`.
 *
 * Replaces ad-hoc untyped `userData` flags for custom elements whose rendering intent/layering
 * cannot be inferred from plain geometry alone.
 */
export type PetplayRenderProps = {
  /** Stable key when the element is promoted to its own SteamVR overlay. */
  overlayKey?: string;
  /** Explicit overlay classification; omit or `"auto"` to infer from geometry bounds. */
  overlayRole?: PetplayOverlayRole;
  /** Set `false` to opt out of native quad promotion and keep this subtree in the eye image. */
  nativeOverlay?: boolean;
  /** Set `true` for view-dependent or animated surfaces that must redraw every frame on a quad. */
  dynamicOverlay?: boolean;
  /** Explicit SteamVR sort order override when promoted to a quad. */
  sortOrder?: number;
  /** Draw over UI in the eye pass. */
  hudOverUi?: boolean;
};

export const PETPLAY_RENDER_PROPS_KEY = "petplayRenderProps";

/**
 * Walk from `object` up to the scene root, merging any `<PetplayElement>` renderProps (nearest
 * descendant wins on conflicting keys). Returns `undefined` when no ancestor declares renderProps.
 */
export function resolvePetplayRenderProps(
  object: THREE.Object3D,
): PetplayRenderProps | undefined {
  let merged: PetplayRenderProps | undefined;
  for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) {
    const props = node.userData?.[PETPLAY_RENDER_PROPS_KEY] as PetplayRenderProps | undefined;
    if (!props) continue;
    merged = merged ? { ...props, ...merged } : { ...props };
  }
  return merged;
}

export type InferredGeometryShape = {
  shape: "flat" | "beam" | "box";
  /** Local-space half-extents `[hx, hy, hz]` derived from the geometry's AABB. */
  extent: [number, number, number];
  /** Local-space AABB center `[cx, cy, cz]`. */
  center: [number, number, number];
};

/**
 * Automatically classify a mesh from its local AABB (`GeometryAsset.bounds.min/max`) and
 * `worldMatrix` scale:
 * - `"flat"`: Z thickness is effectively zero while X and Y are positive (planes, circles, cards).
 * - `"beam"`: elongated along local Z (`worldLenZ / worldThick > 10`, thin X/Y) — laser rays.
 * - `"box"`: general 3D volume with positive extents on all three axes.
 */
export function classifyGeometryShape(
  bounds: { min?: readonly [number, number, number]; max?: readonly [number, number, number] } | undefined,
  worldMatrix: ArrayLike<number>,
): InferredGeometryShape | null {
  if (!bounds?.min || !bounds?.max) return null;
  const hx = (bounds.max[0] - bounds.min[0]) * 0.5;
  const hy = (bounds.max[1] - bounds.min[1]) * 0.5;
  const hz = (bounds.max[2] - bounds.min[2]) * 0.5;
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const sx = Math.hypot(Number(worldMatrix[0]), Number(worldMatrix[1]), Number(worldMatrix[2]));
  const sy = Math.hypot(Number(worldMatrix[4]), Number(worldMatrix[5]), Number(worldMatrix[6]));
  const sz = Math.hypot(Number(worldMatrix[8]), Number(worldMatrix[9]), Number(worldMatrix[10]));
  const wx = hx * 2 * sx;
  const wy = hy * 2 * sy;
  const wz = hz * 2 * sz;

  if (wx > 1e-6 && wy > 1e-6 && wz <= 1e-4) {
    return { shape: "flat", extent: [hx, hy, hz], center };
  }
  const thickness = Math.max(wx, wy);
  if (wz > 1e-5 && thickness > 1e-6 && thickness < 0.05 && wz / thickness > 10) {
    return { shape: "beam", extent: [hx, hy, hz], center };
  }
  if (wx > 1e-6 && wy > 1e-6 && wz > 1e-6) {
    return { shape: "box", extent: [hx, hy, hz], center };
  }
  return null;
}

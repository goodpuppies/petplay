/**
 * The orthographic light view for PetPlay's shadow map (`webxrRaythreeRaylibRenderer.ts`): it
 * looks along the light at the casters' bounding sphere, wide enough for the shadows they throw
 * nearby and deep enough to reach the surfaces below them.
 */
import * as THREE from "three";

export type Sphere = { center: readonly number[]; radius: number };

/** Margin around the casters, metres: their shadows land within this of them. */
export const SHADOW_MARGIN = 0.75;
/** How far past the casters (away from the light) receivers still get compared. */
export const SHADOW_REACH = 25;

/**
 * Light view and projection (column-major, three.js) for `direction` (towards the light, unit),
 * covering `casters`; null without casters.
 */
export function shadowFrustum(direction: readonly number[], casters: readonly Sphere[]) {
  if (casters.length === 0) return null;
  // Bounding sphere: centroid, then the farthest extent from it.
  const center = new THREE.Vector3();
  for (const s of casters) center.add(new THREE.Vector3(...s.center));
  center.divideScalar(casters.length);
  let radius = 0;
  for (const s of casters) {
    radius = Math.max(radius, center.distanceTo(new THREE.Vector3(...s.center)) + s.radius);
  }
  const half = radius + SHADOW_MARGIN;
  const toLight = new THREE.Vector3(...direction).normalize();
  const eye = center.clone().addScaledVector(toLight, half + 1);
  // Any up that isn't parallel to the light.
  const up = Math.abs(toLight.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const view = new THREE.Matrix4().lookAt(eye, center, up).setPosition(eye).invert();
  const near = 0.01, far = 2 * half + 1 + SHADOW_REACH;
  const projection = new THREE.Matrix4().makeOrthographic(-half, half, half, -half, near, far);
  return {
    view,
    projection,
    matrix: projection.clone().multiply(view),
    /** Metres per unit of window depth. */
    depthRange: far - near,
  };
}

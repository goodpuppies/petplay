import * as THREE from "three";

/** Input rays use the final display projection, which can differ from an overlay's render FOV. */
export function updateCompositorInputCamera(
  target: THREE.PerspectiveCamera,
  renderedEye: THREE.Camera,
  displayProjection: THREE.Matrix4,
): THREE.PerspectiveCamera {
  target.matrixAutoUpdate = false;
  target.matrix.copy(renderedEye.matrixWorld);
  target.matrixWorld.copy(renderedEye.matrixWorld);
  target.matrixWorldInverse.copy(renderedEye.matrixWorld).invert();
  target.matrixWorld.decompose(target.position, target.quaternion, target.scale);
  target.projectionMatrix.copy(displayProjection);
  target.projectionMatrixInverse.copy(displayProjection).invert();
  return target;
}

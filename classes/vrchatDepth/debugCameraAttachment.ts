import * as THREE from "three";
import { vrcCameraStore } from "../environment/vrcCameraStore.ts";

/** Update during scene traversal so the debug ball follows without a separate timer. */
export function attachDebugBallToCamera(object: THREE.Object3D, distance = 2): void {
  if (!Number.isFinite(distance) || distance < 0.3 || distance > 20) {
    throw new Error("Ball distance must be 0.3–20 metres");
  }
  object.userData.debugCameraDistance = distance;
  object.userData.debugCameraFollowing = true;
  if (attached.has(object)) return;
  attached.add(object);
  const update = object.updateMatrixWorld;
  const rotation = new THREE.Quaternion(), parentInverse = new THREE.Matrix4();
  const cameraPosition = new THREE.Vector3();
  object.updateMatrixWorld = function (force?: boolean) {
    const pose = this.userData.debugCameraFollowing ? vrcCameraStore.predicted() : null;
    if (pose) {
      rotation.fromArray(pose.quaternion);
      this.position.set(0, 0, -this.userData.debugCameraDistance)
        .applyQuaternion(rotation).add(cameraPosition.fromArray(pose.position));
      if (this.parent) {
        this.position.applyMatrix4(parentInverse.copy(this.parent.matrixWorld).invert());
      }
    }
    update.call(this, force);
  };
  object.updateMatrixWorld(true);
}

/** Freeze in place, or resume following at the saved camera distance. */
export function toggleDebugBallCameraFollow(object: THREE.Object3D): boolean {
  const following = object.userData.debugCameraFollowing ??
    Number.isFinite(object.userData.debugCameraDistance);
  if (!attached.has(object)) {
    // Upgrade an already-running debug ball's old follow hook without reloading its scene.
    if (
      Object.hasOwn(object, "updateMatrixWorld") &&
      object.userData.debugCameraFollowing === undefined &&
      Number.isFinite(object.userData.debugCameraDistance)
    ) {
      object.updateMatrixWorld = THREE.Object3D.prototype.updateMatrixWorld;
    }
    attachDebugBallToCamera(object, object.userData.debugCameraDistance ?? 2);
  }
  object.userData.debugCameraFollowing = !following;
  object.updateMatrixWorld(true);
  return !following;
}

const attached = new WeakSet<THREE.Object3D>();

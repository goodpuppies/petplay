import * as THREE from "three";

const _goalQuat = new THREE.Quaternion();

/**
 * Exponential smoothing alphas for laser-grabbed windows.
 * `amount` in `0..1`: `0` disables smoothing (rigid 1:1), `0.3` is a subtle tremor filter
 * (~26 ms position / ~22 ms rotation time constant), `1.0` is heavy floaty smoothing (~140 ms).
 */
export function laserGrabSmoothingAlpha(
  amount: number,
  dtSeconds: number,
): { position: number; rotation: number } {
  const s = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  if (s <= 0) return { position: 1, rotation: 1 };
  const dt = Math.max(0, Math.min(0.1, Number.isFinite(dtSeconds) ? dtSeconds : 1 / 72));
  const tauPos = 0.015 + 0.125 * s * s;
  const tauRot = 0.012 + 0.108 * s * s;
  return {
    position: 1 - Math.exp(-dt / tauPos),
    rotation: 1 - Math.exp(-dt / tauRot),
  };
}

/**
 * Blends `target.position` and `target.quaternion` from `(prevPos, prevQuat)` toward their newly
 * applied values using frame-rate-independent exponential smoothing.
 */
export function applyLaserGrabSmoothing(
  target: THREE.Object3D,
  prevPos: THREE.Vector3,
  prevQuat: THREE.Quaternion,
  amount: number,
  dtSeconds: number,
): void {
  const { position: posAlpha, rotation: rotAlpha } = laserGrabSmoothingAlpha(amount, dtSeconds);
  if (posAlpha >= 1 && rotAlpha >= 1) return;
  target.position.set(
    prevPos.x + (target.position.x - prevPos.x) * posAlpha,
    prevPos.y + (target.position.y - prevPos.y) * posAlpha,
    prevPos.z + (target.position.z - prevPos.z) * posAlpha,
  );
  const goalX = target.quaternion.x;
  const goalY = target.quaternion.y;
  const goalZ = target.quaternion.z;
  const goalW = target.quaternion.w;
  target.quaternion.copy(prevQuat);
  _goalQuat.set(goalX, goalY, goalZ, goalW);
  target.quaternion.slerp(_goalQuat, rotAlpha);
}
